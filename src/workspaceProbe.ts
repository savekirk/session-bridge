import type { EntireActiveSessionCard } from "./checkpoints";
import { listActiveSessions } from "./checkpoints";
import { getGitRepoRoot, METADATA_BRANCH_NAME, tryExecGit } from "./checkpoints/util";
import { EntireBinary, isEntireResolveError, resolveEntireBinary } from "./entireBinaryResolver";
import { EntireSettings, getEntireSettingsPaths, resolveEntireSettings } from "./entireSettings";
import { runCommandAsync } from "./runCommand";

export const enum EntireStatusState {
  ENABLED,
  CLI_MISSING,
  NOT_GIT_REPO,
  DISABLED,
}
export interface EntireWorkspaceState {
  state: EntireStatusState,
  binary?: EntireBinary;
  settings?: EntireSettings;
  warnings: string[];
  activeSessions: EntireActiveSessionCard[];
}

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

async function hasCheckpointMetadataBranch(repoPath: string): Promise<boolean> {
  const branchRef = await tryExecGit(repoPath, ["show-ref", "--verify", `refs/heads/${METADATA_BRANCH_NAME}`]);
  return branchRef !== null;
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
    let settings = await resolveEntireSettings(settingsPath);

    if (settings.settingsPaths.length === 0) {
      warnings.push("No Entire settings file found.");
      // fallback to entire status command
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
        warnings.push(`Failed to load active sessions: ${message}`);
      }
    }

    workspaceState.binary = resolved;
    workspaceState.warnings = warnings;

    return workspaceState;
  } catch (error) {
    throw error;
  }
}
