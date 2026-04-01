import * as fs from "fs";
import * as path from "path";
import { EntireBinary, isEntireBinary, isEntireResolveError, resolveEntireBinary } from "./entireBinaryResolver";
import { runCommandAsync } from "./runCommand";

export interface EntireWorkspaceState {
  binary: EntireBinary;
  isGitRepo: boolean;
  enabled?: boolean;
  settingsPaths: string[];
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
 * @param cwd - Optional working directory to check
 * @returns - Resolves to true if it is a git repository, false otherwise.
 */
async function isGitRepo(cwd?: string): Promise<boolean> {
  try {
    const { exitCode } = await runCommandAsync("git", ["rev-parse", "--is-inside-work-tree"], cwd);
    return exitCode === 0;
  } catch (error) {
    return false;
  }
}

/**
 * Checks and loads entire settings paths in the specified (or current) directory. 
 * Entire settings have the format `.entire/settings*.json`
 * 
 * @param cwd - Optional working directory to check
 * @returns - Resolves to an array of absolute paths to settings files.
 */
async function getEntireSettingsPaths(cwd?: string): Promise<string[]> {
  const root = cwd ?? process.cwd();
  const entireDir = path.resolve(root, ".entire");

  try {
    const files = await fs.promises.readdir(entireDir);
    return files
      .filter((file) => file.startsWith("settings") && file.endsWith(".json"))
      .map((file) => path.join(entireDir, file));
  } catch (error) {
    return [];
  }
}

async function isEntireEnabled(): Promise<boolean> {
  const { stdout, exitCode } = await runCommandAsync("entire", ["status"]);
  if (exitCode !== 0) {
    return false;
  }

  if (stdout.toLocaleLowerCase().includes("enabled")) {
    return true;
  }

  return false;
}

export async function probeEntireWorkspace(): Promise<EntireWorkspaceState> {
  try {
    const warnings: string[] = [];
    const resolved = await resolveEntireBinary();
    if (isEntireResolveError(resolved)) {
      throw Error(resolved.message);
    }

    const gitStatus = await isGitRepo();
    const settings = await getEntireSettingsPaths();
    let enabled: boolean | undefined;

    if (settings.length === 0) {
      warnings.push("No Entire settings file found.");
      // fallback to entire status command
      enabled = await isEntireEnabled();
    }

    return {
      binary: resolved,
      isGitRepo: gitStatus,
      enabled,
      settingsPaths: settings,
      warnings,
      activeSessions: [],
    };
  } catch (error) {
    throw error;
  }
}
