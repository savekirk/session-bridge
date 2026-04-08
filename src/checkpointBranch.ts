import { getCurrentBranchName, METADATA_BRANCH_NAME, tryExecGit } from "./checkpoints/util";
import { runCommandAsync } from "./runCommand";

/**
 * Result shape for attempts to populate the default local checkpoint metadata branch.
 *
 * This is shared by both the automatic workspace probe path and the explicit
 * "Fetch Checkpoint Branch" command so UI code can report a consistent outcome.
 */
export interface FetchCheckpointBranchResult {
	/** Whether the fetch created or updated the local metadata branch. */
	fetched: boolean;
	/** Remote selected for the fetch, when one could be resolved. */
	remoteName?: string;
	/** Human-readable failure details for non-zero git fetch exits. */
	details?: string;
	/** Normalized outcome category used by callers to decide what to do next. */
	reason: "fetched" | "no-remote" | "fetch-failed";
}

/**
 * Resolves the remote name the extension should use for default metadata fetches.
 *
 * The current branch's configured remote wins when available. Otherwise the
 * repository falls back to `origin` when present, or the first configured remote.
 *
 * @param repoPath Repository root used to inspect branch and remote configuration.
 * @returns The chosen remote name, or `null` when no remotes are configured.
 */
export async function resolveDefaultRemoteName(repoPath: string): Promise<string | null> {
	const currentBranch = await getCurrentBranchName(repoPath);
	if (currentBranch) {
		const branchRemote = (await tryExecGit(repoPath, ["config", "--get", `branch.${currentBranch}.remote`]))?.trim();
		if (branchRemote) {
			return branchRemote;
		}
	}

	const remoteOutput = await tryExecGit(repoPath, ["remote"]);
	if (!remoteOutput) {
		return null;
	}

	const remotes = remoteOutput
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (remotes.length === 0) {
		return null;
	}

	return remotes.includes("origin") ? "origin" : remotes[0];
}

/**
 * Fetches the default Entire checkpoint metadata branch into the local repository.
 *
 * The branch is fetched as `refs/heads/entire/checkpoints/v1` to match the
 * extension's existing local metadata readers. Callers decide whether this is
 * triggered automatically during workspace probes or manually via a command.
 *
 * @param repoPath Repository root where the metadata branch should be created or updated.
 * @returns A normalized fetch outcome that includes the chosen remote and any failure details.
 */
export async function fetchDefaultCheckpointBranch(repoPath: string): Promise<FetchCheckpointBranchResult> {
	const remoteName = await resolveDefaultRemoteName(repoPath);
	if (!remoteName) {
		return {
			fetched: false,
			reason: "no-remote",
		};
	}

	const result = await runCommandAsync(
		"git",
		["fetch", remoteName, `refs/heads/${METADATA_BRANCH_NAME}:refs/heads/${METADATA_BRANCH_NAME}`],
		repoPath,
	);
	if (result.exitCode === 0) {
		return {
			fetched: true,
			remoteName,
			reason: "fetched",
		};
	}

	return {
		fetched: false,
		remoteName,
		details: result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`,
		reason: "fetch-failed",
	};
}
