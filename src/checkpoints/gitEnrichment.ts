import type { AssociatedCommitModel, CheckpointCommit, DiffSummaryModel, FileDiffStat } from "./models";
import { GitCheckpointStore } from "./gitStore";
import { execGit, getCurrentBranchName, getHeadSha, isCheckpointId, parseTimestamp, shortSha } from "./util";

/** Active-branch checkpoint-to-commit associations derived from git history. */
export interface GitEnrichmentIndex {
	currentBranch: string | null;
	headSha: string | null;
	checkpointCommits: CheckpointCommit[];
}

/**
 * Builds the active-branch checkpoint association index from `Entire-Checkpoint` commit trailers.
 * The same checkpoint ID can appear on multiple commit hashes after amend/rebase, because the checkpoint ID is treated as a stable link and amend preserves it.
 *
 * @param repoPath Repository root used to inspect branch state and git history.
 * @returns Active-branch checkpoint associations plus current branch and `HEAD` metadata.
 */
export async function buildGitEnrichmentIndex(repoPath: string): Promise<GitEnrichmentIndex> {
	const [currentBranch, headSha, logOutput] = await Promise.all([
		getCurrentBranchName(repoPath),
		getHeadSha(repoPath),
		readCheckpointLog(repoPath),
	]);
	const checkpointCommits: CheckpointCommit[] = [];

	for (const entry of parseGitLog(logOutput)) {
		const checkpointIds = extractCheckpointIds(entry.fullMessage);
		if (checkpointIds.length === 0) {
			continue;
		}

		const commit = {
			sha: entry.sha,
			shortSha: shortSha(entry.sha) ?? entry.sha,
			message: entry.subject,
			body: entry.body || undefined,
			authorName: entry.authorName,
			authorEmail: entry.authorEmail || undefined,
			authoredAt: entry.authoredAt || undefined,
			checkpointIds,
		};

		checkpointCommits.push(commit);
	}


	return {
		currentBranch,
		headSha,
		checkpointCommits,
	};
}

async function resolveCheckpointIdsForCommit(
	message: string,
	store: GitCheckpointStore,
	latestCreatedAtByCheckpoint: Map<string, Promise<number>>,
): Promise<string[]> {
	const checkpointIds = extractCheckpointIds(message);
	if (checkpointIds.length <= 1) {
		return checkpointIds;
	}

	const latestCheckpointId = await resolveLatestCheckpointId(checkpointIds, store, latestCreatedAtByCheckpoint);
	return latestCheckpointId ? [latestCheckpointId] : [];
}

async function resolveLatestCheckpointId(
	checkpointIds: string[],
	store: GitCheckpointStore,
	latestCreatedAtByCheckpoint: Map<string, Promise<number>>,
): Promise<string | null> {
	let latestCheckpointId: string | null = null;
	let latestCreatedAt = Number.NEGATIVE_INFINITY;

	for (const checkpointId of checkpointIds) {
		const createdAt = await getLatestCreatedAtForCheckpoint(checkpointId, store, latestCreatedAtByCheckpoint);
		if (latestCheckpointId === null || createdAt > latestCreatedAt) {
			latestCheckpointId = checkpointId;
			latestCreatedAt = createdAt;
		}
	}

	return latestCheckpointId;
}

function getLatestCreatedAtForCheckpoint(
	checkpointId: string,
	store: GitCheckpointStore,
	latestCreatedAtByCheckpoint: Map<string, Promise<number>>,
): Promise<number> {
	const existing = latestCreatedAtByCheckpoint.get(checkpointId);
	if (existing) {
		return existing;
	}

	const pending = (async () => {
		const summary = await store.getCheckpointSummary(checkpointId);
		if (!summary) {
			return 0;
		}

		const createdAtValues = await Promise.all(summary.sessions.map(async (_session, index) => {
			try {
				const session = await store.getSessionContent(checkpointId, index);
				return parseTimestamp(session.metadata.createdAt) ?? 0;
			} catch {
				return 0;
			}
		}));

		return createdAtValues.reduce((latest, createdAt) => Math.max(latest, createdAt), 0);
	})();

	latestCreatedAtByCheckpoint.set(checkpointId, pending);
	return pending;
}

/**
 * Adds file stats and, optionally, patch text to associated commits discovered from git history.
 *
 * @param repoPath Repository root used to inspect commit content.
 * @param commits Associated commits previously discovered from trailer scanning.
 * @param includePatch Whether full patch text should be loaded for each commit.
 * @returns Enriched associated commits with file stats and optional patch text attached.
 */
export async function hydrateAssociatedCommits(
	repoPath: string,
	commits: CheckpointCommit[],
	includePatch: boolean,
): Promise<CheckpointCommit[]> {
	return Promise.all(commits.map(async (commit) => {
		const fileStats = await readNumstat(repoPath, commit.sha);
		const patchText = includePatch ? await readPatch(repoPath, commit.sha) : commit.patchText;

		return {
			...commit,
			fileStats,
			patchText: patchText ?? commit.patchText,
		};
	}));
}

/**
 * Aggregates file-level additions and deletions across multiple associated commits.
 *
 * @param commits Associated commits that may each carry file-level numstat data.
 * @returns Combined per-file diff stats across all supplied commits.
 */
export function aggregateFileStats(commits: AssociatedCommitModel[]): FileDiffStat[] {
	const files = new Map<string, FileDiffStat>();

	for (const commit of commits) {
		for (const file of commit.fileStats ?? []) {
			const existing = files.get(file.path);
			if (!existing) {
				files.set(file.path, { ...file });
				continue;
			}

			existing.additions = sumOptional(existing.additions, file.additions);
			existing.deletions = sumOptional(existing.deletions, file.deletions);
		}
	}

	return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Summarizes aggregate file stats into a compact files/lines rollup.
 *
 * @param files Per-file diff stats to summarize.
 * @returns Aggregate file and line counts, or `undefined` when there are no file stats.
 */
export function summarizeFileStats(files: FileDiffStat[]): DiffSummaryModel | undefined {
	if (files.length === 0) {
		return undefined;
	}

	let linesAdded = 0;
	let linesRemoved = 0;
	let hasNumericChanges = false;

	for (const file of files) {
		if (typeof file.additions === "number") {
			linesAdded += file.additions;
			hasNumericChanges = true;
		}
		if (typeof file.deletions === "number") {
			linesRemoved += file.deletions;
			hasNumericChanges = true;
		}
	}

	return {
		filesChanged: files.length,
		linesAdded: hasNumericChanges ? linesAdded : undefined,
		linesRemoved: hasNumericChanges ? linesRemoved : undefined,
	};
}

async function readCheckpointLog(repoPath: string): Promise<string> {
	try {
		return await execGit(repoPath, ["log", "HEAD", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e"]);
	} catch {
		return "";
	}
}

function parseGitLog(output: string): Array<{
	sha: string;
	authorName: string;
	authorEmail: string;
	authoredAt: string;
	subject: string;
	body: string;
	fullMessage: string;
}> {
	return output
		.split("\x1e")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const [sha = "", authorName = "", authorEmail = "", authoredAt = "", subject = "", ...bodyParts] = entry.split("\x1f");
			const body = bodyParts.join("\x1f").trim();
			return {
				sha,
				authorName,
				authorEmail,
				authoredAt,
				subject,
				body,
				fullMessage: [subject, body].filter(Boolean).join("\n"),
			};
		})
		.filter((entry) => entry.sha.length > 0);
}

function extractCheckpointIds(message: string): string[] {
	const matches = message.matchAll(/(?:^|\n)Entire-Checkpoint:\s*([^\s]+)(?=\n|$)/gi);
	return [...new Set(
		[...matches]
			.map((match) => match[1]?.toLowerCase())
			.filter((checkpointId): checkpointId is string => isCheckpointId(checkpointId)),
	)];
}

async function readNumstat(repoPath: string, sha: string): Promise<FileDiffStat[]> {
	try {
		const output = await execGit(repoPath, ["show", "--numstat", "--format=", sha]);
		return output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map(parseNumstatLine)
			.filter((entry): entry is FileDiffStat => entry !== null);
	} catch {
		return [];
	}
}

async function readPatch(repoPath: string, sha: string): Promise<string | undefined> {
	try {
		return await execGit(repoPath, ["show", "--format=medium", "--patch", sha]);
	} catch {
		return undefined;
	}
}

function parseNumstatLine(line: string): FileDiffStat | null {
	const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
	if (!match) {
		return null;
	}

	return {
		path: match[3],
		additions: match[1] === "-" ? undefined : Number(match[1]),
		deletions: match[2] === "-" ? undefined : Number(match[2]),
	};
}

function sumOptional(left?: number, right?: number): number | undefined {
	if (left === undefined && right === undefined) {
		return undefined;
	}

	return (left ?? 0) + (right ?? 0);
}
