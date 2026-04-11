import { BaseCheckpointStore } from "./store";
import { loadStoredTranscript } from "./transcript";
import {
	METADATA_BRANCH_NAME,
	execGit,
	isCheckpointId,
	listGitTreePaths,
	parseCheckpointSummary,
	parseCommittedMetadata,
	readGitText,
	shardedCheckpointPath,
	validateCheckpointId,
} from "./util";
import type { CheckpointSummaryRecord, JsonObject, SessionContentRecord, SessionFilePaths } from "./types";

/**
 * Checkpoint store that reads committed metadata directly from git object storage on
 * the metadata branch, without checking that branch out into the worktree.
 */
export class GitCheckpointStore extends BaseCheckpointStore {
	constructor(
		private readonly repoPath: string,
		private readonly metadataRevision: string = METADATA_BRANCH_NAME,
	) {
		super();
	}

	/**
	 * Lists checkpoint IDs by scanning sharded checkpoint metadata paths in the metadata revision.
	 *
	 * @returns Checkpoint IDs available in the configured metadata revision.
	 */
	async listCheckpointIds(): Promise<string[]> {
		const paths = await listGitTreePaths(this.repoPath, this.metadataRevision);
		return paths
			.filter((entry) => /^[0-9a-f]{2}\/[0-9a-f]{10}\/metadata\.json$/.test(entry))
			.map((entry) => entry.replaceAll("/", "").replace(/metadata\.json$/, ""))
			.map((entry) => entry.slice(0, 12))
			.filter((entry, index, values) => values.indexOf(entry) === index)
			.sort((left, right) => left.localeCompare(right));
	}

	/**
	 * Reads top-level checkpoint summary metadata from the metadata branch.
	 *
	 * @param checkpointId The 12-character checkpoint ID to resolve.
	 * @returns The committed checkpoint summary, or `null` when it does not exist.
	 */
	async getCheckpointSummary(checkpointId: string): Promise<CheckpointSummaryRecord | null> {
		validateCheckpointId(checkpointId);

		const content = await readGitText(this.repoPath, this.metadataRevision, `${shardedCheckpointPath(checkpointId)}/metadata.json`);
		if (!content) {
			return null;
		}

		return parseCheckpointSummary(JSON.parse(content) as JsonObject);
	}

	/**
	 * Reads a committed session payload, including transcript, optional legacy context, and prompt files,
	 * from git object storage.
	 *
	 * @param checkpointId The 12-character checkpoint ID to resolve.
	 * @param sessionIndex Zero-based session index within the checkpoint.
	 * @returns The full committed session payload for that checkpoint entry.
	 */
	async getSessionContent(
		checkpointId: string,
		sessionIndex: number,
		sessionPaths?: SessionFilePaths,
	): Promise<SessionContentRecord> {
		validateCheckpointId(checkpointId);
		const sessionPath = resolveGitSessionPath(checkpointId, sessionIndex, sessionPaths);

		const metadataText = await readGitText(
			this.repoPath,
			this.metadataRevision,
			resolveGitSessionFilePath(sessionPath, sessionPaths?.metadata, "metadata.json"),
		);
		if (!metadataText) {
			throw new Error(`Session ${sessionIndex} not found in checkpoint ${checkpointId}`);
		}

		return {
			metadata: parseCommittedMetadata(JSON.parse(metadataText) as JsonObject),
			transcript: await loadStoredTranscript({
				listEntryNames: async () => {
					const prefix = `${sessionPath}/`;
					return (await listGitTreePaths(this.repoPath, this.metadataRevision, sessionPath))
						.filter((entry) => entry.startsWith(prefix))
						.map((entry) => entry.slice(prefix.length))
						.filter((entry) => entry.length > 0 && !entry.includes("/"));
				},
				readEntryText: async (entryName) => readGitText(this.repoPath, this.metadataRevision, `${sessionPath}/${entryName}`),
			}),
			context: await readGitText(
				this.repoPath,
				this.metadataRevision,
				resolveGitSessionFilePath(sessionPath, sessionPaths?.context, "context.md"),
			),
			prompts: await readGitText(
				this.repoPath,
				this.metadataRevision,
				resolveGitSessionFilePath(sessionPath, sessionPaths?.prompt, "prompt.txt"),
			),
			contentHash: await readGitText(
				this.repoPath,
				this.metadataRevision,
				resolveGitSessionFilePath(sessionPath, sessionPaths?.contentHash, "content_hash.txt"),
			),
		};
	}

	/**
	 * Finds the checkpoint ID associated with a commit by reading its `Entire-Checkpoint` trailer.
	 *
	 * @param commitish Commit-ish expression to inspect. Defaults to `HEAD`.
	 * @returns The associated checkpoint ID, or `null` when no trailer is present.
	 */
	async findCheckpointIdForCommit(commitish = "HEAD"): Promise<string | null> {
		const commitMessage = await readCommitBody(this.repoPath, commitish);
		if (!commitMessage) {
			return null;
		}

		const match = commitMessage.match(/(?:^|\n)Entire-Checkpoint:\s*([^\s]+)(?=\n|$)/i);
		const checkpointId = match?.[1]?.toLowerCase();
		return isCheckpointId(checkpointId) ? checkpointId : null;
	}

	/**
	 * Loads the checkpoint summary associated with a commit trailer, if one exists.
	 *
	 * @param commitish Commit-ish expression to inspect. Defaults to `HEAD`.
	 * @returns The associated checkpoint summary, or `null` when no linked checkpoint exists.
	 */
	async getCheckpointSummaryForCommit(commitish = "HEAD"): Promise<CheckpointSummaryRecord | null> {
		const checkpointId = await this.findCheckpointIdForCommit(commitish);
		return checkpointId ? this.getCheckpointSummary(checkpointId) : null;
	}
}

function resolveGitSessionPath(
	checkpointId: string,
	sessionIndex: number,
	sessionPaths?: SessionFilePaths,
): string {
	const metadataPath = normalizeGitTreePath(sessionPaths?.metadata);
	if (metadataPath) {
		const slashIndex = metadataPath.lastIndexOf("/");
		if (slashIndex > 0) {
			return metadataPath.slice(0, slashIndex);
		}
	}

	return `${shardedCheckpointPath(checkpointId)}/${sessionIndex}`;
}

function resolveGitSessionFilePath(sessionPath: string, filePath: string | undefined, fallbackFileName: string): string {
	return normalizeGitTreePath(filePath) ?? `${sessionPath}/${fallbackFileName}`;
}

function normalizeGitTreePath(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	return value.replace(/^\//, "");
}

async function readCommitBody(repoPath: string, commitish: string): Promise<string | null> {
	try {
		return await execGit(repoPath, ["show", "-s", "--format=%B", commitish]);
	} catch {
		return null;
	}
}
