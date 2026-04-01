import type {
	CheckpointSummaryRecord,
	InitialAttribution,
	SessionContentRecord,
	SummaryRecord,
} from "./types";
import type {
	AssociatedCommitModel,
	CheckpointDetailModel,
	DiffSummaryModel,
	EntireCheckpointCard,
	EntireSessionCard,
	FileDiffStat,
	RewindAvailability,
	SessionStatus,
} from "./models";
import { GitCheckpointStore } from "./gitStore";
import { selectLatestSessionContent, sortSessionContentsByCreatedAtDesc } from "./store";
import { extractTranscriptPrompt, countTranscriptToolUses } from "./transcript";
import {
	buildGitEnrichmentIndex,
	hydrateAssociatedCommits,
	aggregateFileStats,
	summarizeFileStats,
} from "./gitEnrichment";
import { loadRewindIndex, type NormalizedRewindPoint } from "./rewindIndex";
import { loadSessionStateIndex, getCheckpointStatus, getSessionStatus, type SessionStateIndex } from "./sessionStateJoin";
import {
	NO_DESCRIPTION,
	collapseWhitespace,
	parseTimestamp,
	promptDescription,
	shortSha,
	totalTokenUsage,
} from "./util";
import { sortCheckpointCards, sortSessionCards } from "./search";

interface LoadedCheckpointState {
	checkpointId: string;
	summary: CheckpointSummaryRecord | null;
	sessions: SessionContentRecord[];
	commits: AssociatedCommitModel[];
	fileStats: FileDiffStat[];
	diffSummary?: DiffSummaryModel;
	rewindPoints: NormalizedRewindPoint[];
}

interface LoadedModuleState {
	committedCheckpoints: Map<string, LoadedCheckpointState>;
	temporaryRewindPoints: NormalizedRewindPoint[];
	stateIndex: SessionStateIndex;
}

/**
 * Builds normalized checkpoint cards for the active branch by merging committed
 * metadata, live rewind availability, and active-branch git enrichment.
 *
 * @param repoPath Repository root used to load checkpoint metadata and git history.
 * @returns Active-branch checkpoint cards, including ephemeral temporary rewind-only entries.
 */
export async function listCheckpointCards(repoPath: string): Promise<EntireCheckpointCard[]> {
	const loadedState = await loadModuleState(repoPath, false);
	const cards: EntireCheckpointCard[] = [];

	for (const checkpoint of loadedState.committedCheckpoints.values()) {
		cards.push(buildCheckpointCard(checkpoint, loadedState.stateIndex));
	}

	for (const point of loadedState.temporaryRewindPoints) {
		cards.push(buildTemporaryCheckpointCard(point, loadedState.stateIndex));
	}

	return sortCheckpointCards(cards);
}

/**
 * Builds normalized session cards for the active branch by joining committed
 * session history with live `.git/entire-sessions` state when available.
 *
 * @param repoPath Repository root used to load checkpoint metadata and live session state.
 * @returns Active-branch session cards with live status overlays applied.
 */
export async function listSessionCards(repoPath: string): Promise<EntireSessionCard[]> {
	const loadedState = await loadModuleState(repoPath, false);
	const sessionMap = new Map<string, EntireSessionCard>();

	for (const checkpoint of loadedState.committedCheckpoints.values()) {
		const primaryCommit = checkpoint.commits[0];
		for (const session of checkpoint.sessions) {
			const sessionId = session.metadata.sessionId;
			if (!sessionId) {
				continue;
			}

			const existing = sessionMap.get(sessionId);
			const promptPreview = selectPromptPreview(session.prompts, session.transcript, checkpoint.rewindPoints[0]?.sessionPrompt, checkpoint.summary ? promptDescription(session.prompts) : undefined);
			const tokenCount = totalTokenUsage(session.metadata.tokenUsage) ?? totalTokenUsage(checkpoint.summary?.tokenUsage);
			const toolCount = countTranscriptToolUses(session.transcript);
			const createdAt = session.metadata.createdAt;
			const lastActivityAt = createdAt;

			if (!existing) {
				sessionMap.set(sessionId, {
					id: sessionId,
					sessionId,
					promptPreview,
					displayHash: checkpoint.checkpointId,
					checkpointIds: [checkpoint.checkpointId],
					agent: session.metadata.agent,
					model: session.metadata.model,
					status: getSessionStatus(sessionId, loadedState.stateIndex),
					author: primaryCommit?.authorName,
					branch: session.metadata.branch,
					createdAt,
					lastActivityAt,
					durationMs: session.metadata.sessionMetrics?.durationMs,
					stepCount: session.metadata.checkpointsCount,
					toolCount,
					tokenCount,
					attribution: session.metadata.initialAttribution,
					checkpointCount: 1,
					latestCheckpointId: checkpoint.checkpointId,
					latestAssociatedCommitSha: primaryCommit?.sha,
					isLiveOnly: false,
					searchText: buildSearchText([
						promptPreview,
						checkpoint.checkpointId,
						primaryCommit?.shortSha,
						session.metadata.agent,
						primaryCommit?.authorName,
					]),
				});
				continue;
			}

			if (!existing.checkpointIds.includes(checkpoint.checkpointId)) {
				existing.checkpointIds.push(checkpoint.checkpointId);
				existing.checkpointCount = existing.checkpointIds.length;
			}

			if (isLater(createdAt, existing.lastActivityAt)) {
				existing.promptPreview = promptPreview;
				existing.displayHash = checkpoint.checkpointId;
				existing.agent = session.metadata.agent ?? existing.agent;
				existing.model = session.metadata.model ?? existing.model;
				existing.author = primaryCommit?.authorName ?? existing.author;
				existing.branch = session.metadata.branch ?? existing.branch;
				existing.lastActivityAt = lastActivityAt;
				existing.latestCheckpointId = checkpoint.checkpointId;
				existing.latestAssociatedCommitSha = primaryCommit?.sha ?? existing.latestAssociatedCommitSha;
				existing.searchText = buildSearchText([
					existing.searchText,
					promptPreview,
					checkpoint.checkpointId,
					primaryCommit?.shortSha,
				]);
			}

			existing.createdAt = pickEarlier(createdAt, existing.createdAt);
			existing.durationMs = pickNumber(session.metadata.sessionMetrics?.durationMs, existing.durationMs);
			existing.stepCount = Math.max(existing.stepCount ?? 0, session.metadata.checkpointsCount);
			existing.toolCount = sumOptional(existing.toolCount, toolCount);
			existing.tokenCount = pickNumber(tokenCount, existing.tokenCount);
			existing.attribution = existing.attribution ?? session.metadata.initialAttribution;
			existing.status = getSessionStatus(sessionId, loadedState.stateIndex);
		}
	}

	for (const liveState of loadedState.stateIndex.sessions) {
		const existing = sessionMap.get(liveState.sessionId);
		const promptPreview = collapseWhitespace(liveState.lastPrompt ?? "") || NO_DESCRIPTION;
		const tokenCount = totalTokenUsage(liveState.tokenUsage);
		const liveStatus = getSessionStatus(liveState.sessionId, loadedState.stateIndex);
		const associatedCommit = liveState.lastCheckpointId
			? loadedState.committedCheckpoints.get(liveState.lastCheckpointId)?.commits[0]
			: undefined;

		if (!existing) {
			sessionMap.set(liveState.sessionId, {
				id: liveState.sessionId,
				sessionId: liveState.sessionId,
				promptPreview,
				displayHash: liveState.lastCheckpointId ?? shortSha(liveState.sessionId, 12) ?? liveState.sessionId,
				checkpointIds: liveState.lastCheckpointId ? [liveState.lastCheckpointId] : [],
				agent: liveState.agentType,
				model: liveState.modelName,
				status: liveStatus,
				author: associatedCommit?.authorName,
				createdAt: liveState.startedAt,
				lastActivityAt: liveState.lastInteractionAt ?? liveState.startedAt,
				durationMs: liveState.sessionDurationMs,
				stepCount: liveState.checkpointCount,
				tokenCount,
				checkpointCount: liveState.lastCheckpointId ? 1 : 0,
				latestCheckpointId: liveState.lastCheckpointId,
				latestAssociatedCommitSha: associatedCommit?.sha,
				isLiveOnly: true,
				searchText: buildSearchText([
					promptPreview,
					liveState.lastCheckpointId,
					associatedCommit?.shortSha,
					liveState.agentType,
				]),
			});
			continue;
		}

		existing.agent = liveState.agentType ?? existing.agent;
		existing.model = liveState.modelName ?? existing.model;
		existing.status = liveStatus;
		existing.createdAt = existing.createdAt ?? liveState.startedAt;
		existing.lastActivityAt = liveState.lastInteractionAt ?? existing.lastActivityAt;
		existing.durationMs = liveState.sessionDurationMs ?? existing.durationMs;
		existing.stepCount = pickNumber(liveState.checkpointCount, existing.stepCount);
		existing.tokenCount = pickNumber(tokenCount, existing.tokenCount);
		existing.promptPreview = existing.isLiveOnly || existing.promptPreview === NO_DESCRIPTION ? promptPreview : existing.promptPreview;
		existing.isLiveOnly = existing.isLiveOnly && existing.checkpointIds.length === 0;
		existing.searchText = buildSearchText([existing.searchText, promptPreview, liveState.lastCheckpointId]);
	}

	return sortSessionCards([...sessionMap.values()]);
}

/**
 * Resolves a structured checkpoint detail model for a committed checkpoint or
 * a temporary rewind-only point on the active branch.
 *
 * @param repoPath Repository root used to load checkpoint metadata, git history, and session state.
 * @param checkpointId Checkpoint ID or temporary point ID to resolve.
 * @returns Structured checkpoint details, or `null` when the checkpoint cannot be resolved.
 */
export async function getCheckpointDetail(repoPath: string, checkpointId: string): Promise<CheckpointDetailModel | null> {
	const loadedState = await loadModuleState(repoPath, false);

	if (checkpointId.startsWith("temporary:")) {
		const point = loadedState.temporaryRewindPoints.find((entry) => `temporary:${entry.pointId}` === checkpointId);
		return point ? buildTemporaryDetailModel(point, loadedState.stateIndex) : null;
	}

	const checkpoint = loadedState.committedCheckpoints.get(checkpointId);
	if (!checkpoint) {
		return null;
	}

	const commits = await hydrateAssociatedCommits(repoPath, checkpoint.commits, true);
	const fileStats = aggregateFileStats(commits);
	const diffSummary = summarizeFileStats(fileStats);
	const latestSession = selectLatestSession(checkpoint.sessions);
	const promptPreview = selectPromptPreview(
		latestSession?.prompts ?? null,
		latestSession?.transcript ?? null,
		checkpoint.rewindPoints[0]?.sessionPrompt,
		checkpoint.summary ? promptDescription(latestSession?.prompts ?? null) : checkpoint.rewindPoints[0]?.message,
	);
	const summary = selectSummary(checkpoint.sessions);
	const attribution = selectAttribution(checkpoint.sessions);
	const sessionIds = checkpoint.sessions.map((session) => session.metadata.sessionId).filter((sessionId) => sessionId.length > 0);
	const rewindAvailability = selectRewindAvailability(checkpoint.rewindPoints, checkpoint.checkpointId);
	const primaryCommit = commits[0];

	return {
		id: checkpoint.checkpointId,
		checkpointId: checkpoint.checkpointId,
		isEphemeral: checkpoint.summary === null,
		title: promptPreview || `Checkpoint ${checkpoint.checkpointId}`,
		promptPreview,
		hash: checkpoint.checkpointId,
		primaryCommit,
		associatedCommits: commits,
		additionalAssociatedCommitCount: Math.max(commits.length - 1, 0),
		time: latestSession?.metadata.createdAt ?? checkpoint.rewindPoints[0]?.date ?? primaryCommit?.authoredAt,
		user: primaryCommit?.authorName,
		branch: latestSession?.metadata.branch,
		tokenCount: totalTokenUsage(latestSession?.metadata.tokenUsage) ?? totalTokenUsage(checkpoint.summary?.tokenUsage),
		agent: latestSession?.metadata.agent,
		model: latestSession?.metadata.model,
		status: getCheckpointStatus(sessionIds, loadedState.stateIndex),
		overview: {
			summary,
			filesChanged: diffSummary?.filesChanged,
			linesAdded: diffSummary?.linesAdded,
			linesRemoved: diffSummary?.linesRemoved,
			sessionCount: checkpoint.summary?.sessions.length ?? Math.max(sessionIds.length, checkpoint.rewindPoints[0]?.sessionId ? 1 : 0),
			tokenCount: totalTokenUsage(latestSession?.metadata.tokenUsage) ?? totalTokenUsage(checkpoint.summary?.tokenUsage),
			stepCount: latestSession?.metadata.checkpointsCount ?? checkpoint.summary?.checkpointsCount,
			attribution,
			commitMessage: primaryCommit?.message,
		},
		files: fileStats.length > 0 ? fileStats : (checkpoint.summary?.filesTouched ?? []).map((filePath) => ({ path: filePath })),
		diff: {
			patchText: primaryCommit?.patchText,
			primaryCommitSha: primaryCommit?.sha,
		},
		rewindAvailability,
		rawTranscriptAvailable: checkpoint.sessions.some((session) => typeof session.transcript === "string" && session.transcript.length > 0),
	};
}

/**
 * Loads committed raw transcript content for a checkpoint, optionally narrowing
 * the lookup to a specific session within that checkpoint.
 *
 * @param repoPath Repository root used to read committed metadata.
 * @param checkpointId Checkpoint ID whose committed transcript should be loaded.
 * @param sessionId Optional session ID to target within the checkpoint.
 * @returns Raw transcript content, or `null` when no committed transcript is available.
 */
export async function getRawTranscript(
	repoPath: string,
	checkpointId: string,
	sessionId?: string,
): Promise<string | null> {
	const store = new GitCheckpointStore(repoPath);
	const summary = await store.getCheckpointSummary(checkpointId);
	if (!summary) {
		return null;
	}

	if (sessionId) {
		const session = await store.getSessionContentById(checkpointId, sessionId);
		return session.transcript;
	}

	const sessions = (await Promise.all(summary.sessions.map(async (_session, index) => {
		try {
			return await store.getSessionContent(checkpointId, index);
		} catch {
			return null;
		}
	})))
		.filter((session): session is SessionContentRecord => session !== null);

	for (const session of sortSessionContentsByCreatedAtDesc(sessions)) {
		if (session.transcript) {
			return session.transcript;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadModuleState(repoPath: string, includePatch: boolean): Promise<LoadedModuleState> {
	const [rewindIndex, gitEnrichment, stateIndex] = await Promise.all([
		loadRewindIndex(repoPath),
		buildGitEnrichmentIndex(repoPath),
		loadSessionStateIndex(repoPath),
	]);
	const store = new GitCheckpointStore(repoPath);
	const includedCheckpointIds = new Set<string>([
		...gitEnrichment.checkpointCommits.keys(),
		...rewindIndex.byCheckpointId.keys(),
	]);
	const committedCheckpoints = new Map<string, LoadedCheckpointState>();

	for (const checkpointId of includedCheckpointIds) {
		try {
			const summary = await store.getCheckpointSummary(checkpointId);
			const sessions = summary ? await loadSessionsWithRecovery(store, checkpointId, summary) : [];
			const commits = await hydrateAssociatedCommits(repoPath, gitEnrichment.checkpointCommits.get(checkpointId) ?? [], includePatch);
			const fileStats = aggregateFileStats(commits);

			committedCheckpoints.set(checkpointId, {
				checkpointId,
				summary,
				sessions,
				commits,
				fileStats,
				diffSummary: summarizeFileStats(fileStats),
				rewindPoints: rewindIndex.byCheckpointId.get(checkpointId) ?? [],
			});
		} catch (error) {
			// Graceful degradation: skip this checkpoint but continue loading others.
			// Build a minimal entry so rewind and enrichment data is still surfaced.
			committedCheckpoints.set(checkpointId, {
				checkpointId,
				summary: null,
				sessions: [],
				commits: [],
				fileStats: [],
				rewindPoints: rewindIndex.byCheckpointId.get(checkpointId) ?? [],
			});
		}
	}

	return {
		committedCheckpoints,
		temporaryRewindPoints: rewindIndex.points.filter((point) => !point.checkpointId),
		stateIndex,
	};
}

/**
 * Loads all sessions for a checkpoint, recovering gracefully from individual session
 * read failures so that one corrupt session does not prevent loading the rest.
 */
async function loadSessionsWithRecovery(
	store: GitCheckpointStore,
	checkpointId: string,
	summary: CheckpointSummaryRecord,
): Promise<SessionContentRecord[]> {
	const results = await Promise.all(
		summary.sessions.map(async (_session, index) => {
			try {
				return await store.getSessionContent(checkpointId, index);
			} catch {
				return null;
			}
		}),
	);
	return results.filter((session): session is SessionContentRecord => session !== null);
}

function buildCheckpointCard(
	checkpoint: LoadedCheckpointState,
	stateIndex: SessionStateIndex,
): EntireCheckpointCard {
	const latestSession = selectLatestSession(checkpoint.sessions);
	const summary = selectSummary(checkpoint.sessions);
	const attribution = selectAttribution(checkpoint.sessions);
	const sessionIds = checkpoint.sessions.map((session) => session.metadata.sessionId).filter((sessionId) => sessionId.length > 0);
	const promptPreview = selectPromptPreview(
		latestSession?.prompts ?? null,
		latestSession?.transcript ?? null,
		checkpoint.rewindPoints[0]?.sessionPrompt,
		checkpoint.summary ? promptDescription(latestSession?.prompts ?? null) : checkpoint.rewindPoints[0]?.message,
	);
	const primaryCommit = checkpoint.commits[0];
	const rewindAvailability = selectRewindAvailability(checkpoint.rewindPoints, checkpoint.checkpointId);

	return {
		id: checkpoint.checkpointId,
		checkpointId: checkpoint.checkpointId,
		promptPreview,
		displayHash: checkpoint.checkpointId,
		agent: latestSession?.metadata.agent,
		model: latestSession?.metadata.model,
		status: getCheckpointStatus(sessionIds, stateIndex),
		author: primaryCommit?.authorName,
		timestamp: latestSession?.metadata.createdAt ?? checkpoint.rewindPoints[0]?.date ?? primaryCommit?.authoredAt,
		branch: latestSession?.metadata.branch,
		tokenCount: totalTokenUsage(latestSession?.metadata.tokenUsage) ?? totalTokenUsage(checkpoint.summary?.tokenUsage),
		stepCount: latestSession?.metadata.checkpointsCount ?? checkpoint.summary?.checkpointsCount,
		fileCount: checkpoint.summary?.filesTouched.length ?? checkpoint.diffSummary?.filesChanged,
		sessionCount: checkpoint.summary?.sessions.length ?? Math.max(sessionIds.length, checkpoint.rewindPoints[0]?.sessionId ? 1 : 0),
		attribution,
		summary,
		primaryCommit,
		associatedCommitCount: checkpoint.commits.length,
		diffSummary: checkpoint.diffSummary,
		rewindAvailability,
		isEphemeral: checkpoint.summary === null,
		searchText: buildSearchText([
			promptPreview,
			checkpoint.checkpointId,
			...checkpoint.commits.map((commit) => `${commit.shortSha} ${commit.message}`),
			latestSession?.metadata.agent,
			primaryCommit?.authorName,
		]),
	};
}

function buildTemporaryCheckpointCard(
	point: NormalizedRewindPoint,
	stateIndex: SessionStateIndex,
): EntireCheckpointCard {
	const liveState = point.sessionId ? stateIndex.bySessionId.get(point.sessionId) : undefined;
	const promptPreview = selectPromptPreview(null, null, point.sessionPrompt, point.message);

	return {
		id: `temporary:${point.pointId}`,
		rewindPointId: point.pointId,
		promptPreview,
		displayHash: point.displayHash,
		agent: liveState?.agentType,
		model: liveState?.modelName,
		status: getSessionStatus(point.sessionId, stateIndex),
		timestamp: point.date,
		tokenCount: totalTokenUsage(liveState?.tokenUsage),
		stepCount: liveState?.checkpointCount,
		sessionCount: point.sessionId ? 1 : 0,
		associatedCommitCount: 0,
		rewindAvailability: rewindAvailabilityForPoint(point),
		isEphemeral: true,
		searchText: buildSearchText([
			promptPreview,
			point.displayHash,
			point.pointId,
			liveState?.agentType,
		]),
	};
}

function buildTemporaryDetailModel(
	point: NormalizedRewindPoint,
	stateIndex: SessionStateIndex,
): CheckpointDetailModel {
	const liveState = point.sessionId ? stateIndex.bySessionId.get(point.sessionId) : undefined;
	const promptPreview = selectPromptPreview(null, null, point.sessionPrompt, point.message);

	return {
		id: `temporary:${point.pointId}`,
		rewindPointId: point.pointId,
		isEphemeral: true,
		title: promptPreview || "Temporary checkpoint",
		promptPreview,
		hash: point.displayHash,
		associatedCommits: [],
		additionalAssociatedCommitCount: 0,
		time: point.date,
		tokenCount: totalTokenUsage(liveState?.tokenUsage),
		agent: liveState?.agentType,
		model: liveState?.modelName,
		status: getSessionStatus(point.sessionId, stateIndex),
		overview: {
			sessionCount: point.sessionId ? 1 : 0,
			tokenCount: totalTokenUsage(liveState?.tokenUsage),
			stepCount: liveState?.checkpointCount,
			commitMessage: point.message,
		},
		files: [],
		diff: {},
		rewindAvailability: rewindAvailabilityForPoint(point),
		rawTranscriptAvailable: false,
	};
}

function rewindAvailabilityForPoint(point: NormalizedRewindPoint): RewindAvailability {
	return {
		isAvailable: true,
		pointId: point.pointId,
		checkpointId: point.checkpointId,
		isLogsOnly: point.isLogsOnly,
		isTaskCheckpoint: point.isTaskCheckpoint,
		isTemporary: point.isTemporary,
		message: point.message,
		sessionId: point.sessionId,
	};
}

function selectRewindAvailability(
	points: NormalizedRewindPoint[],
	checkpointId: string,
): RewindAvailability | undefined {
	const point = points[0];
	if (!point) {
		return undefined;
	}

	return {
		isAvailable: true,
		pointId: point.pointId,
		checkpointId,
		isLogsOnly: point.isLogsOnly,
		isTaskCheckpoint: point.isTaskCheckpoint,
		isTemporary: point.isTemporary,
		message: point.message,
		sessionId: point.sessionId,
	};
}

function selectLatestSession(sessions: SessionContentRecord[]): SessionContentRecord | undefined {
	return selectLatestSessionContent(sessions);
}

function selectSummary(sessions: SessionContentRecord[]): SummaryRecord | undefined {
	return selectLatestMetadataWithValue(sessions, (session) => session.metadata.summary);
}

function selectAttribution(sessions: SessionContentRecord[]): InitialAttribution | undefined {
	return selectLatestMetadataWithValue(sessions, (session) => session.metadata.initialAttribution);
}

function selectLatestMetadataWithValue<T>(
	sessions: SessionContentRecord[],
	getValue: (session: SessionContentRecord) => T | undefined,
): T | undefined {
	return sortSessionContentsByCreatedAtDesc(sessions)
		.map((session) => getValue(session))
		.find((value): value is T => value !== undefined);
}

function selectPromptPreview(
	promptText: string | null,
	transcript: string | null,
	...fallbacks: Array<string | undefined>
): string {
	const directPrompt = collapseWhitespace(promptDescription(promptText));
	if (directPrompt && directPrompt !== NO_DESCRIPTION) {
		return directPrompt;
	}

	const transcriptPrompt = extractTranscriptPrompt(transcript);
	if (transcriptPrompt) {
		return transcriptPrompt;
	}

	for (const fallback of fallbacks) {
		const normalized = collapseWhitespace(fallback ?? "");
		if (normalized.length > 0) {
			return normalized;
		}
	}

	return NO_DESCRIPTION;
}

function buildSearchText(values: Array<string | undefined>): string {
	return values
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join(" ")
		.toLowerCase();
}

function isLater(left: string | undefined, right: string | undefined): boolean {
	return (parseTimestamp(left) ?? 0) > (parseTimestamp(right) ?? 0);
}

function pickEarlier(left: string | undefined, right: string | undefined): string | undefined {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}

	return (parseTimestamp(left) ?? 0) <= (parseTimestamp(right) ?? 0) ? left : right;
}

function pickNumber(left: number | undefined, right: number | undefined): number | undefined {
	if (typeof left === "number") {
		return left;
	}
	return right;
}

function sumOptional(left?: number, right?: number): number | undefined {
	if (left === undefined && right === undefined) {
		return undefined;
	}
	return (left ?? 0) + (right ?? 0);
}
