import { tryExecGit } from "./checkpoints/util";
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
  activeSessions: EntireSessionSummary[];
}

export interface EntireSessionSummary {
  sessionId: string;
  agentType?: string;
  modelName?: string;
  phase?: "active" | "idle" | "ended" | string;
  lastPrompt?: string;
  worktreePath?: string;
  startedAt?: string;
  lastInteractionAt?: string;
  tokenUsage?: number;
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

export async function probeEntireWorkspace(cwd: string | undefined): Promise<EntireWorkspaceState> {
  try {
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

    const gitStatus = cwd !== undefined && await isGitRepo(cwd);
    if (!gitStatus) {
      workspaceState.state = EntireStatusState.NOT_GIT_REPO;

      return workspaceState;
    }

    let settings = await resolveEntireSettings(cwd);

    if (settings.settingsPaths.length === 0) {
      warnings.push("No Entire settings file found.");
      // fallback to entire status command
      settings.enabled = await isEntireEnabled(cwd);
    }
    workspaceState.settings = settings;

    if (settings.enabled) {
      workspaceState.state = EntireStatusState.ENABLED;
    }

    workspaceState.binary = resolved;
    workspaceState.warnings = warnings;

    return workspaceState;
  } catch (error) {
    throw error;
  }
}
