import { readdirSync } from "fs";
import path from "path";
import { BaseCheckpointStore } from "./store";
import { loadStoredTranscript } from "./transcript";
import {
	parseCheckpointSummary,
	parseCommittedMetadata,
	readJsonFile,
	readUtf8IfExists,
	shardedCheckpointPath,
	validateCheckpointId,
} from "./util";
import type { CheckpointSummaryRecord, SessionContentRecord, SessionFilePaths } from "./types";

/**
 * Filesystem-backed checkpoint store used for fixtures and deterministic tests.
 * It reads the same on-disk layout that the metadata branch stores when materialized.
 */
export class FileSystemCheckpointStore extends BaseCheckpointStore {
	constructor(private readonly rootDir: string) {
		super();
	}

	/**
	 * Lists checkpoint IDs by walking the sharded filesystem layout under `rootDir`.
	 *
	 * @returns Checkpoint IDs discovered in the fixture or snapshot directory.
	 */
	async listCheckpointIds(): Promise<string[]> {
		const summaries = new Set<string>();
		const root = this.rootDir;

		for (const bucket of readdirSafe(root)) {
			if (!/^[0-9a-f]{2}$/.test(bucket)) {
				continue;
			}

			for (const suffix of readdirSafe(path.join(root, bucket))) {
				if (!/^[0-9a-f]{10}$/.test(suffix)) {
					continue;
				}

				const metadataPath = path.join(root, bucket, suffix, "metadata.json");
				if ((await readUtf8IfExists(metadataPath)) !== null) {
					summaries.add(`${bucket}${suffix}`);
				}
			}
		}

		return [...summaries].sort((left, right) => left.localeCompare(right));
	}

	/**
	 * Reads top-level checkpoint summary metadata from the filesystem fixture layout.
	 *
	 * @param checkpointId The 12-character checkpoint ID to resolve.
	 * @returns The committed checkpoint summary, or `null` when it is missing.
	 */
	async getCheckpointSummary(checkpointId: string): Promise<CheckpointSummaryRecord | null> {
		validateCheckpointId(checkpointId);

		const summaryPath = path.join(this.rootDir, shardedCheckpointPath(checkpointId), "metadata.json");
		const raw = await readJsonFile(summaryPath);
		if (!raw) {
			return null;
		}

		return parseCheckpointSummary(raw);
	}

	/**
	 * Reads a fixture-backed session payload, including optional transcript, legacy context, and prompt files.
	 *
	 * @param checkpointId The 12-character checkpoint ID to resolve.
	 * @param sessionIndex Zero-based session index within the checkpoint.
	 * @returns The fixture-backed session payload for that checkpoint entry.
	 */
	async getSessionContent(checkpointId: string, sessionIndex: number): Promise<SessionContentRecord> {
		const summary = await this.getCheckpointSummary(checkpointId);
		if (!summary) {
			throw new Error(`Checkpoint not found: ${checkpointId}`);
		}
		if (sessionIndex < 0 || sessionIndex >= summary.sessions.length) {
			throw new Error(`Session index ${sessionIndex} not found in checkpoint ${checkpointId}`);
		}

		const sessionPaths = summary.sessions[sessionIndex];
		const checkpointDir = path.join(this.rootDir, shardedCheckpointPath(checkpointId));
		const metadataPath = resolveSessionFilePath(this.rootDir, checkpointDir, sessionPaths, "metadata");
		const transcriptPath = resolveSessionFilePath(this.rootDir, checkpointDir, sessionPaths, "transcript");
		const transcriptDir = path.dirname(transcriptPath);
		const contextPath = resolveSessionFilePath(this.rootDir, checkpointDir, sessionPaths, "context");
		const promptPath = resolveSessionFilePath(this.rootDir, checkpointDir, sessionPaths, "prompt");
		const contentHashPath = resolveSessionFilePath(this.rootDir, checkpointDir, sessionPaths, "contentHash");

		const rawMetadata = await readJsonFile(metadataPath);
		if (!rawMetadata) {
			throw new Error(`Session metadata not found for checkpoint ${checkpointId} session ${sessionIndex}`);
		}

		return {
			metadata: parseCommittedMetadata(rawMetadata),
			transcript: await loadStoredTranscript({
				listEntryNames: async () => readdirSafe(transcriptDir),
				readEntryText: async (entryName) => readUtf8IfExists(path.join(transcriptDir, entryName)),
			}),
			context: await readUtf8IfExists(contextPath),
			prompts: await readUtf8IfExists(promptPath),
			contentHash: await readUtf8IfExists(contentHashPath),
		};
	}
}

function resolveSessionFilePath(
	rootDir: string,
	checkpointDir: string,
	sessionPaths: SessionFilePaths | undefined,
	kind: "metadata" | "transcript" | "context" | "prompt" | "contentHash",
): string {
	const fromSummary = sessionPaths?.[kind];
	if (fromSummary) {
		return path.join(rootDir, fromSummary.replace(/^\//, ""));
	}

	const fileNames: Record<typeof kind, string> = {
		metadata: "metadata.json",
		transcript: "full.jsonl",
		context: "context.md",
		prompt: "prompt.txt",
		contentHash: "content_hash.txt",
	};

	return path.join(checkpointDir, "0", fileNames[kind]);
}

function readdirSafe(dirPath: string): string[] {
	try {
		return readdirSync(dirPath);
	} catch {
		return [];
	}
}
