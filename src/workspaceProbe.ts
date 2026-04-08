import type { EntireActiveSessionCard } from "./checkpoints";
import { listActiveSessions } from "./checkpoints";
import { getGitRepoRoot, METADATA_BRANCH_NAME, tryExecGit } from "./checkpoints/util";
import { fetchDefaultCheckpointBranch, type FetchCheckpointBranchResult } from "./checkpointBranch";
import { EntireBinary, isEntireResolveError, resolveEntireBinary } from "./entireBinaryResolver";
import { EntireSettings, getEntireSettingsPaths, resolveEntireSettings } from "./entireSettings";
import { runCommandAsync } from "./runCommand";

/** Normalized workspace availability states exposed to the tree views and status bar. */
export const enum EntireStatusState {
  ENABLED,
  CLI_MISSING,
  NOT_GIT_REPO,
  DISABLED,
}

/**
 * Snapshot of the repository state used to render the extension UI.
 *
 * The probe intentionally returns one normalized model so the status bar,
 * checkpoint tree, and sessions tree can stay in sync after a single refresh.
 */
export interface EntireWorkspaceState {
  /** High-level repository state used for welcome views and command enablement. */
  state: EntireStatusState,
  /** Resolved Entire binary information when the CLI is available. */
  binary?: EntireBinary;
  /** Effective Entire settings for the repository after layered resolution. */
  settings?: EntireSettings;
  /** Non-fatal probe warnings to surface in diagnostics and logs. */
  warnings: string[];
  /** Live sessions associated with the current repository and active branch. */
  activeSessions: EntireActiveSessionCard[];
}

/**
 * Per-repository cache of automatic metadata fetch attempts made during the
 * current extension host session.
 *
 * This prevents every probe refresh from retrying the same network operation
 * while still allowing manual refresh to clear the attempt and retry once.
 */
const automaticCheckpointFetchAttempts = new Map<string, FetchCheckpointBranchResult>();

/**
 * Checks if the specified directory (or current directory) is inside a git-managed worktree.
 * 
 * @param repoPath - working directory to check
 * @returns - Resolves to true if it is a git repository, false otherwise.
 */
async function isGitRepo(repoPath: string): Promise<boolean> {
  const result = await tryExecGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (result !== null) {
    return true;
  }

  return false;
}

/**
 * Checks the CLI's repository status output to see whether Entire is enabled.
 *
 * This remains a fallback for repositories that do not have checked-in
 * `.entire` settings, matching the extension's existing behavior.
 *
 * @param cwd Repository root used as the working directory for `entire status`.
 * @returns `true` when the CLI reports an enabled repository state.
 */
async function isEntireEnabled(cwd?: string): Promise<boolean> {
  const { stdout, exitCode } = await runCommandAsync("entire", ["status"], cwd);
  if (exitCode !== 0) {
    return false;
  }

  if (stdout.toLocaleLowerCase().includes("enabled")) {
    return true;
  }

  return false;
}

/**
 * Checks whether the local metadata branch already exists in the repository.
 *
 * @param repoPath Repository root used to inspect git refs.
 * @returns `true` when `refs/heads/entire/checkpoints/v1` exists locally.
 */
async function hasCheckpointMetadataBranch(repoPath: string): Promise<boolean> {
  const branchRef = await tryExecGit(repoPath, ["show-ref", "--verify", `refs/heads/${METADATA_BRANCH_NAME}`]);
  return branchRef !== null;
}

/**
 * Clears cached automatic metadata fetch attempts.
 *
 * This is used by tests to isolate probe behavior and by manual refresh so a
 * user can retry automatic discovery without restarting the extension host.
 *
 * @param repoPath Optional repository root to clear. When omitted, every cached attempt is removed.
 */
export function resetAutomaticCheckpointFetchAttempt(repoPath?: string): void {
	if (repoPath) {
		automaticCheckpointFetchAttempts.delete(repoPath);
		return;
	}

	automaticCheckpointFetchAttempts.clear();
}

/**
 * Ensures the probe performs at most one automatic metadata fetch attempt per
 * repository for the lifetime of the current extension host session.
 *
 * The fetch is skipped entirely when the local metadata branch is already
 * present. Otherwise the first result, including failures, is cached.
 *
 * @param repoPath Repository root that may need automatic metadata discovery.
 * @returns The fetch outcome for a new or cached attempt, or `null` when no fetch was needed.
 */
async function ensureAutomaticCheckpointFetch(repoPath: string): Promise<FetchCheckpointBranchResult | null> {
	if (await hasCheckpointMetadataBranch(repoPath)) {
		return null;
	}

	const cached = automaticCheckpointFetchAttempts.get(repoPath);
	if (cached) {
		return cached;
	}

	const result = await fetchDefaultCheckpointBranch(repoPath);
	automaticCheckpointFetchAttempts.set(repoPath, result);
	return result;
}

/**
 * Probes the current workspace target and produces the extension's normalized
 * repository state snapshot.
 *
 * The probe accepts either a repository path or a file path within a repository.
 * It first resolves the owning git root, then reads the Entire binary/settings
 * state for that repository, and finally loads the current live sessions from
 * the checkpoint module. This keeps the status bar, tree views, and command
 * handlers aligned on the same repository even when VS Code is focused on a
 * file inside a nested repo.
 *
 * @param cwd File or directory path used as the starting point for repository resolution.
 * @returns Normalized workspace state for the resolved repository target.
 */
export async function probeEntireWorkspace(cwd: string | undefined): Promise<EntireWorkspaceState> {
	try {
    const repoPath = cwd ? await getGitRepoRoot(cwd) ?? cwd : undefined;
    var workspaceState: EntireWorkspaceState = {
      state: EntireStatusState.DISABLED,
      warnings: [],
      activeSessions: [],
    };

    const warnings: string[] = [];
    const resolved = await resolveEntireBinary();
    if (isEntireResolveError(resolved)) {
      workspaceState.state = EntireStatusState.CLI_MISSING;
      warnings.push(resolved.message);
      workspaceState.warnings = warnings;

      return workspaceState;
    }

    const gitStatus = repoPath !== undefined && await isGitRepo(repoPath);
    if (!gitStatus) {
      workspaceState.state = EntireStatusState.NOT_GIT_REPO;

      return workspaceState;
    }

    const settingsPath = repoPath;
    const repoSettingsPaths = await getEntireSettingsPaths(settingsPath);
    let settings = await resolveEntireSettings(settingsPath);

    if (repoSettingsPaths.length === 0) {
      warnings.push("No Entire settings file found.");
      const fetchResult = await ensureAutomaticCheckpointFetch(repoPath);
      if (fetchResult?.fetched && fetchResult.remoteName) {
        warnings.push(`Fetched ${METADATA_BRANCH_NAME} from ${fetchResult.remoteName} automatically.`);
      }
    }

    if (settings.settingsPaths.length === 0) {
      settings.enabled = await isEntireEnabled(repoPath);
      if (!settings.enabled && await hasCheckpointMetadataBranch(repoPath)) {
        settings.enabled = true;
        warnings.push(`Detected local ${METADATA_BRANCH_NAME} branch without checked-in Entire settings.`);
      }
    }
    workspaceState.settings = settings;

    if (settings.enabled) {
      workspaceState.state = EntireStatusState.ENABLED;
      try {
        workspaceState.activeSessions = await listActiveSessions(repoPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        warnings.push(`Failed to load sessions: ${message}`);
      }
    }

    workspaceState.binary = resolved;
    workspaceState.warnings = warnings;

    return workspaceState;
  } catch (error) {
    throw error;
  }
}
