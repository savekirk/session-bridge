import { promises as fs } from "fs";
import path from "path";
import { getGitCommonDir, isJsonObject, isAncestor, parseTokenUsage } from "./util";
import type { LiveSessionStateRecord } from "./types";
import type { SessionStatus } from "./models";

const SESSION_STATE_DIR_NAME = "entire-sessions";

/** Indexed live-session state for the current worktree and active-branch context. */
export interface SessionStateIndex {
	sessions: LiveSessionStateRecord[];
	bySessionId: Map<string, LiveSessionStateRecord>;
}

/**
 * Reads and filters live session state files from the git common dir for the current repo context.
 *
 * @param repoPath Repository root used to resolve the git common dir and current `HEAD`.
 * @returns Indexed live session state scoped to the current worktree and active branch context.
 */
export async function loadSessionStateIndex(repoPath: string): Promise<SessionStateIndex> {
	const commonDir = await getGitCommonDir(repoPath);
	if (!commonDir) {
		return emptySessionStateIndex();
	}

	const sessionDir = path.join(commonDir, SESSION_STATE_DIR_NAME);
	let entries: string[];
	try {
		entries = await fs.readdir(sessionDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return emptySessionStateIndex();
		}
		throw error;
	}

	const currentWorktreePath = path.resolve(repoPath);
	const sessions: LiveSessionStateRecord[] = [];

	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			continue;
		}

		const state = await readSessionState(path.join(sessionDir, entry));
		if (!state) {
			continue;
		}

		if (state.worktreePath && path.resolve(state.worktreePath) !== currentWorktreePath) {
			continue;
		}

		if (state.baseCommit && !(await isAncestor(repoPath, state.baseCommit, "HEAD"))) {
			continue;
		}

		sessions.push(state);
	}

	sessions.sort((left, right) => (Date.parse(right.lastInteractionAt ?? right.startedAt ?? "") || 0) - (Date.parse(left.lastInteractionAt ?? left.startedAt ?? "") || 0));

	return {
		sessions,
		bySessionId: new Map(sessions.map((session) => [session.sessionId, session])),
	};
}

/**
 * Normalizes Entire session phases into the UI-facing status enum.
 *
 * @param phase Raw session phase value from live state.
 * @param endedAt End timestamp from live state, when present.
 * @returns The normalized session status.
 */
export function normalizeSessionStatus(phase?: string, endedAt?: string): SessionStatus {
	if (endedAt || phase === "ended") {
		return "ENDED";
	}

	if (phase === "active") {
		return "ACTIVE";
	}

	return "IDLE";
}

/**
 * Resolves the current status for a single session ID from the indexed live session state.
 *
 * @param sessionId Session ID to resolve.
 * @param stateIndex Indexed live session state for the current repo context.
 * @returns The normalized status for that session.
 */
export function getSessionStatus(sessionId: string | undefined, stateIndex: SessionStateIndex): SessionStatus {
	if (!sessionId) {
		return "ENDED";
	}

	return normalizeSessionStatus(
		stateIndex.bySessionId.get(sessionId)?.phase,
		stateIndex.bySessionId.get(sessionId)?.endedAt,
	);
}

/**
 * Resolves a checkpoint status by folding the live statuses of all sessions associated with it.
 *
 * @param sessionIds Session IDs associated with the checkpoint.
 * @param stateIndex Indexed live session state for the current repo context.
 * @returns `ACTIVE`, `IDLE`, or `ENDED` based on the highest-priority live state present.
 */
export function getCheckpointStatus(sessionIds: string[], stateIndex: SessionStateIndex): SessionStatus {
	let hasIdle = false;
	for (const sessionId of sessionIds) {
		const status = getSessionStatus(sessionId, stateIndex);
		if (status === "ACTIVE") {
			return "ACTIVE";
		}
		if (status === "IDLE") {
			hasIdle = true;
		}
	}

	return hasIdle ? "IDLE" : "ENDED";
}

async function readSessionState(filePath: string): Promise<LiveSessionStateRecord | null> {
	try {
		const content = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (!isJsonObject(parsed)) {
			return null;
		}

		return {
			sessionId: asString(parsed.session_id) ?? "",
			cliVersion: asString(parsed.cli_version),
			baseCommit: asString(parsed.base_commit),
			attributionBaseCommit: asString(parsed.attribution_base_commit),
			worktreePath: asString(parsed.worktree_path),
			worktreeId: asString(parsed.worktree_id),
			startedAt: asString(parsed.started_at),
			endedAt: asString(parsed.ended_at),
			phase: asString(parsed.phase),
			turnId: asString(parsed.turn_id),
			turnCheckpointIds: asStringArray(parsed.turn_checkpoint_ids),
			lastInteractionAt: asString(parsed.last_interaction_time),
			checkpointCount: asNumber(parsed.checkpoint_count),
			lastCheckpointId: asString(parsed.last_checkpoint_id),
			agentType: asString(parsed.agent_type),
			modelName: asString(parsed.model_name),
			tokenUsage: parseTokenUsage(parsed.token_usage),
			sessionDurationMs: asNumber(parsed.session_duration_ms),
			sessionTurnCount: asNumber(parsed.session_turn_count),
			contextTokens: asNumber(parsed.context_tokens),
			contextWindowSize: asNumber(parsed.context_window_size),
			transcriptPath: asString(parsed.transcript_path),
			lastPrompt: asString(parsed.last_prompt) ?? asString(parsed.first_prompt),
			raw: parsed,
		};
	} catch {
		return null;
	}
}

function emptySessionStateIndex(): SessionStateIndex {
	return {
		sessions: [],
		bySessionId: new Map<string, LiveSessionStateRecord>(),
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((entry): entry is string => typeof entry === "string");
}
