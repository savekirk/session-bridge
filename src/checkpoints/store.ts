import { NO_DESCRIPTION, promptDescription } from "./util";
import type {
	CheckpointStore,
	CheckpointSummaryRecord,
	SessionCheckpointRecord,
	SessionContentRecord,
	SessionFilePaths,
	SessionRecord,
} from "./types";

type MutableSessionRecord = SessionRecord & {
	sortKey?: number;
};

/**
 * Shared checkpoint store implementation that handles sorting and session grouping
 * regardless of whether checkpoint data comes from git object reads or the filesystem.
 */
export abstract class BaseCheckpointStore implements CheckpointStore {
	/**
	 * Lists all checkpoint IDs visible to the concrete backing store.
	 *
	 * @returns Checkpoint IDs available from the concrete implementation.
	 */
	abstract listCheckpointIds(): Promise<string[]>;

	/**
	 * Loads the top-level committed summary for a checkpoint, if present.
	 *
	 * @param checkpointId The 12-character checkpoint ID to resolve.
	 * @returns The checkpoint summary, or `null` when it is unavailable.
	 */
	abstract getCheckpointSummary(checkpointId: string): Promise<CheckpointSummaryRecord | null>;

	/**
	 * Loads a specific session payload for a checkpoint by numeric session index.
	 *
	 * @param checkpointId The 12-character checkpoint ID to resolve.
	 * @param sessionIndex Zero-based session index within the checkpoint.
	 * @returns The full committed session payload for that checkpoint entry.
	 */
	abstract getSessionContent(
		checkpointId: string,
		sessionIndex: number,
		sessionPaths?: SessionFilePaths,
	): Promise<SessionContentRecord>;

	/**
	 * Resolves a checkpoint session by `sessionId` instead of numeric index.
	 *
	 * @param checkpointId The 12-character checkpoint ID to inspect.
	 * @param sessionId The session ID to locate inside the checkpoint.
	 * @returns The matching committed session payload.
	 */
	async getSessionContentById(checkpointId: string, sessionId: string): Promise<SessionContentRecord> {
		const summary = await this.getCheckpointSummary(checkpointId);
		if (!summary) {
			throw new Error(`Checkpoint not found: ${checkpointId}`);
		}

		for (let index = 0; index < summary.sessions.length; index += 1) {
			const content = await this.getSessionContent(checkpointId, index, summary.sessions[index]);
			if (content.metadata.sessionId === sessionId) {
				return content;
			}
		}

		throw new Error(`Session ${sessionId} not found in checkpoint ${checkpointId}`);
	}

	/**
	 * Lists checkpoint summaries ordered by the latest session timestamp available for each checkpoint.
	 *
	 * @returns Checkpoint summaries sorted from most recent to oldest.
	 */
	async listCheckpoints(): Promise<CheckpointSummaryRecord[]> {
		const checkpointIds = await this.listCheckpointIds();
		const summaries = await Promise.all(checkpointIds.map(async (checkpointId) => this.getCheckpointSummary(checkpointId)));
		const populated = summaries.filter((summary): summary is CheckpointSummaryRecord => summary !== null);
		const latestTimestamps = new Map<string, number>();

		await Promise.all(populated.map(async (summary) => {
			latestTimestamps.set(summary.checkpointId, await latestCheckpointTimestamp(this, summary));
		}));

		return populated.sort((left, right) => {
			const leftTimestamp = latestTimestamps.get(left.checkpointId) ?? 0;
			const rightTimestamp = latestTimestamps.get(right.checkpointId) ?? 0;
			if (leftTimestamp !== rightTimestamp) {
				return rightTimestamp - leftTimestamp;
			}

			return right.checkpointId.localeCompare(left.checkpointId);
		});
	}

	/**
	 * Groups checkpoint sessions by `sessionId` to build a session-centric read model.
	 *
	 * @returns Session history records sorted by most recent session start time.
	 */
	async listSessions(): Promise<SessionRecord[]> {
		const sessionMap = new Map<string, MutableSessionRecord>();

		for (const checkpoint of await this.listCheckpoints()) {
			for (let index = 0; index < checkpoint.sessions.length; index += 1) {
				const content = await this.getSessionContent(checkpoint.checkpointId, index, checkpoint.sessions[index]);
				const sessionId = content.metadata.sessionId;
				if (!sessionId) {
					continue;
				}

				const checkpointTimestamp = toTimestamp(content.metadata.createdAt);
				const description = promptDescription(content.prompts);
				const checkpointRecord: SessionCheckpointRecord = {
					checkpointId: checkpoint.checkpointId,
					message: `Checkpoint: ${checkpoint.checkpointId}`,
					timestamp: content.metadata.createdAt,
					isTaskCheckpoint: content.metadata.isTask,
					toolUseId: content.metadata.toolUseId,
				};

				const existing = sessionMap.get(sessionId);
				if (!existing) {
					sessionMap.set(sessionId, {
						id: sessionId,
						description,
						strategy: content.metadata.strategy || checkpoint.strategy,
						startTime: content.metadata.createdAt,
						checkpoints: [checkpointRecord],
						sortKey: checkpointTimestamp,
					});
					continue;
				}

				existing.checkpoints.push(checkpointRecord);
				if (!existing.strategy && content.metadata.strategy) {
					existing.strategy = content.metadata.strategy;
				}

				if (checkpointTimestamp !== undefined && (existing.sortKey === undefined || checkpointTimestamp < existing.sortKey)) {
					existing.sortKey = checkpointTimestamp;
					existing.startTime = content.metadata.createdAt;
					existing.description = description || NO_DESCRIPTION;
				} else if (existing.description === NO_DESCRIPTION && description !== NO_DESCRIPTION) {
					existing.description = description;
				}
			}
		}

		return [...sessionMap.values()]
			.map((session) => ({
				id: session.id,
				description: session.description,
				strategy: session.strategy,
				startTime: session.startTime,
				checkpoints: [...session.checkpoints].sort(compareSessionCheckpointRecords),
			}))
			.sort((left, right) => (toTimestamp(right.startTime) ?? 0) - (toTimestamp(left.startTime) ?? 0));
	}
}

export function sortSessionContentsByCreatedAtDesc(sessions: SessionContentRecord[]): SessionContentRecord[] {
	return [...sessions].sort((left, right) => (toTimestamp(right.metadata.createdAt) ?? 0) - (toTimestamp(left.metadata.createdAt) ?? 0));
}

export function selectLatestSessionContent(sessions: SessionContentRecord[]): SessionContentRecord | undefined {
	return sortSessionContentsByCreatedAtDesc(sessions)[0];
}

async function latestCheckpointTimestamp(
	store: BaseCheckpointStore,
	checkpoint: CheckpointSummaryRecord,
): Promise<number> {
	if (checkpoint.sessions.length === 0) {
		return 0;
	}

	try {
		const sessions = (await Promise.all(checkpoint.sessions.map(async (_session, index) => {
			try {
				return await store.getSessionContent(checkpoint.checkpointId, index, checkpoint.sessions[index]);
			} catch {
				return null;
			}
		})))
			.filter((session): session is SessionContentRecord => session !== null);
		const latestSession = selectLatestSessionContent(sessions);
		return toTimestamp(latestSession?.metadata.createdAt) ?? 0;
	} catch {
		return 0;
	}
}

function compareSessionCheckpointRecords(left: SessionCheckpointRecord, right: SessionCheckpointRecord): number {
	const leftTimestamp = toTimestamp(left.timestamp) ?? 0;
	const rightTimestamp = toTimestamp(right.timestamp) ?? 0;
	if (leftTimestamp !== rightTimestamp) {
		return rightTimestamp - leftTimestamp;
	}

	return right.checkpointId.localeCompare(left.checkpointId);
}

function toTimestamp(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}
