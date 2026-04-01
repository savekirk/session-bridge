import { runCommandAsync } from "../runCommand";
import { collapseWhitespace, isCheckpointId, isJsonObject, shortSha } from "./util";

/** Normalized shape for a single point returned by `entire rewind --list`. */
export interface NormalizedRewindPoint {
	pointId: string;
	checkpointId?: string;
	message: string;
	metadataDir?: string;
	date?: string;
	isTaskCheckpoint: boolean;
	toolUseId?: string;
	isLogsOnly: boolean;
	isTemporary: boolean;
	sessionId?: string;
	sessionPrompt?: string;
	displayHash: string;
}

/** Indexed view of current rewindable points keyed by point ID and checkpoint ID. */
export interface RewindIndex {
	points: NormalizedRewindPoint[];
	byPointId: Map<string, NormalizedRewindPoint>;
	byCheckpointId: Map<string, NormalizedRewindPoint[]>;
	error?: string;
}

/**
 * Loads and normalizes the current `entire rewind --list` JSON output for a repository.
 *
 * @param repoPath Repository root used as the command working directory.
 * @returns Indexed rewind data, including grouped committed checkpoint links when available.
 */
export async function loadRewindIndex(repoPath: string): Promise<RewindIndex> {
	const result = await runCommandAsync("entire", ["rewind", "--list"], repoPath);
	if (result.exitCode !== 0) {
		return emptyRewindIndex(result.stderr.trim() || result.stdout.trim() || `entire rewind --list exited with code ${result.exitCode}`);
	}

	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (!Array.isArray(parsed)) {
			return emptyRewindIndex("entire rewind --list did not return a JSON array");
		}

		const points = parsed
			.map((entry) => normalizeRewindPoint(entry))
			.filter((entry): entry is NormalizedRewindPoint => entry !== null)
			.sort((left, right) => (Date.parse(right.date ?? "") || 0) - (Date.parse(left.date ?? "") || 0));

		const byPointId = new Map<string, NormalizedRewindPoint>();
		const byCheckpointId = new Map<string, NormalizedRewindPoint[]>();

		for (const point of points) {
			byPointId.set(point.pointId, point);
			if (!point.checkpointId) {
				continue;
			}

			const existing = byCheckpointId.get(point.checkpointId);
			if (existing) {
				existing.push(point);
			} else {
				byCheckpointId.set(point.checkpointId, [point]);
			}
		}

		return {
			points,
			byPointId,
			byCheckpointId,
		};
	} catch (error) {
		return emptyRewindIndex(error instanceof Error ? error.message : "Failed to parse rewind index");
	}
}

function normalizeRewindPoint(value: unknown): NormalizedRewindPoint | null {
	if (!isJsonObject(value)) {
		return null;
	}

	const pointId = typeof value.id === "string" ? value.id : "";
	if (!pointId) {
		return null;
	}

	const rawCheckpointId = typeof value.condensation_id === "string" ? value.condensation_id.trim().toLowerCase() : "";
	const checkpointId = isCheckpointId(rawCheckpointId) ? rawCheckpointId : undefined;
	const message = typeof value.message === "string" ? collapseWhitespace(value.message) : "";
	const sessionPrompt = typeof value.session_prompt === "string" ? collapseWhitespace(value.session_prompt) : undefined;

	return {
		pointId,
		checkpointId,
		message,
		metadataDir: typeof value.metadata_dir === "string" ? value.metadata_dir : undefined,
		date: typeof value.date === "string" ? value.date : undefined,
		isTaskCheckpoint: value.is_task_checkpoint === true,
		toolUseId: typeof value.tool_use_id === "string" ? value.tool_use_id : undefined,
		isLogsOnly: value.is_logs_only === true,
		isTemporary: value.is_logs_only !== true,
		sessionId: typeof value.session_id === "string" ? value.session_id : undefined,
		sessionPrompt,
		displayHash: checkpointId ?? shortSha(pointId) ?? pointId,
	};
}

function emptyRewindIndex(error: string): RewindIndex {
	return {
		points: [],
		byPointId: new Map<string, NormalizedRewindPoint>(),
		byCheckpointId: new Map<string, NormalizedRewindPoint[]>(),
		error,
	};
}
