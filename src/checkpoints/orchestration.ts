import { constants as fsConstants, promises as fs } from "fs";
import { runCommandAsync } from "../runCommand";
import type {
	CheckpointSummaryRecord,
	InitialAttribution,
	SessionContentRecord,
	SummaryRecord,
} from "./types";
import type {
	AssociatedCommitModel,
	EntireActiveSessionCard,
	CheckpointDateGroup,
	CheckpointDetailModel,
	CommitCheckpointGroup,
	CommitDetailModel,
	EntireCheckpointCard,
	EntireSessionDetailModel,
	EntireSessionCard,
	RewindAvailability,
	ResolvedCheckpointRef,
	SessionCheckpointEntry,
	SessionDetailTarget,
	SessionDetailTurn,
	SessionStatus,
	CheckpointCommit,
} from "./models";
import { resolveCheckpointStore } from "./checkpointRemote";
import { BaseCheckpointStore, selectLatestSessionContent, sortSessionContentsByCreatedAtDesc } from "./store";
import {
	extractTranscriptFirstTimestamp,
	extractTranscriptLatestTimestamp,
	extractTranscriptPrompt,
	countTranscriptToolUses,
} from "./transcript";
import { parseNativeSessionTranscript } from "./nativeTranscript";
import {
	buildGitEnrichmentIndex,
	hydrateAssociatedCommits,
	aggregateFileStats,
	summarizeFileStats,
} from "./gitEnrichment";
import { loadRewindIndex, type NormalizedRewindPoint } from "./rewindIndex";
import { loadSessionStateIndex, getCheckpointStatus, getSessionStatus, normalizeSessionStatus, type SessionStateIndex } from "./sessionStateJoin";
import {
	NO_DESCRIPTION,
	collapseWhitespace,
	compareOptionalTimestampsDesc,
	formatCheckpointGroupDate,
	isJsonObject,
	parseTimestamp,
	promptDescription,
	sortUnique,
	shortSha,
	totalTokenUsage,
	tryExecGit,
} from "./util";
import { sortCheckpointCards, sortSessionCards } from "./search";

interface LoadedCheckpointRecord {
	checkpointId: string;
	summary: CheckpointSummaryRecord | null;
	sessions: SessionContentRecord[];
	rewindPoints: NormalizedRewindPoint[];
	commits: CheckpointCommit[];
}

interface ModuleState {
	commitGroups: CommitCheckpointGroup[];
	checkpoints: Map<string, LoadedCheckpointRecord>;
	stateIndex: SessionStateIndex;
	temporaryRewindPoints: NormalizedRewindPoint[];
}

export interface RawExplainTarget {
	checkpointId?: string;
	commitSha?: string;
	fullTranscript?: boolean;
}

/**
 * Builds normalized checkpoint cards for the active branch by merging committed
 * metadata, live rewind availability, and active-branch git enrichment.
 *
 * @param repoPath Repository root used to load checkpoint metadata and git history.
 * @returns Active-branch checkpoint cards, including temporary rewind-only entries.
 */
export async function listCheckpointCards(repoPath: string): Promise<EntireCheckpointCard[]> {
	const loadedState = await loadModuleState(repoPath, false);
	const cards: EntireCheckpointCard[] = [];

	for (const checkpoint of loadedState.checkpoints.values()) {
		cards.push(buildCheckpointCard(checkpoint, loadedState.stateIndex));
	}

	for (const point of loadedState.temporaryRewindPoints) {
		cards.push(buildTemporaryCheckpointCard(point, loadedState.stateIndex));
	}

	return sortCheckpointCards(cards);
}

/**
 * Builds lightweight checkpoint summaries for the tree view without loading
 * patch text or detail-only metadata.
 */
export async function listCheckpointSummaries(repoPath: string): Promise<CheckpointDateGroup[]> {
	const commitGroups = await loadCommitGroupsForTree(repoPath);
	const statesByTimestamp = new Map<string, CheckpointDateGroup>();

	for (const committedCheckpoint of commitGroups) {
		const authoredAt = committedCheckpoint.commit.authoredAt;
		if (!authoredAt) {
			continue;
		}
		const dayKey = authoredAt.slice(0, 10);

		const existing = statesByTimestamp.get(dayKey);
		if (existing) {
			existing.checkpointCommits.push(committedCheckpoint);
		} else {
			statesByTimestamp.set(dayKey, {
				timestamp: dayKey,
				formattedDate: formatCheckpointGroupDate(dayKey),
				checkpointCommits: [committedCheckpoint],
			});
		}
	}

	return [...statesByTimestamp.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Builds normalized live-session cards for the Sessions tree by starting
 * from live session state and enriching only active-branch checkpoint links.
 *
 * @param repoPath Repository root used to load live session state and active-branch git context.
 * @returns Current-worktree live sessions sorted by most recent interaction.
 */
export async function listActiveSessions(repoPath: string): Promise<EntireActiveSessionCard[]> {
	const [stateIndex, gitEnrichment] = await Promise.all([
		loadSessionStateIndex(repoPath),
		buildGitEnrichmentIndex(repoPath),
	]);
	const liveSessions = stateIndex.sessions.filter((session) => normalizeSessionStatus(session.phase, session.endedAt) !== "ENDED");
	if (liveSessions.length === 0) {
		return [];
	}

	const commitsByCheckpointId = new Map<string, CheckpointCommit[]>();
	for (const commit of gitEnrichment.checkpointCommits) {
		for (const checkpointId of commit.checkpointIds) {
			const existing = commitsByCheckpointId.get(checkpointId);
			if (existing) {
				existing.push(commit);
			} else {
				commitsByCheckpointId.set(checkpointId, [commit]);
			}
		}
	}

	const checkpointIds = sortUnique(
		liveSessions
			.map((session) => session.lastCheckpointId)
			.filter((checkpointId): checkpointId is string => typeof checkpointId === "string" && commitsByCheckpointId.has(checkpointId)),
	);
	const store = await resolveCheckpointStore(repoPath, { requiredCheckpointIds: checkpointIds });
	const checkpoints = new Map<string, LoadedCheckpointRecord>();

	await Promise.all(checkpointIds.map(async (checkpointId) => {
		const summary = await store.getCheckpointSummary(checkpointId);
		if (!summary) {
			return;
		}

		checkpoints.set(checkpointId, {
			checkpointId,
			summary,
			sessions: await loadSessionsWithRecovery(store, checkpointId, summary),
			rewindPoints: [],
			commits: commitsByCheckpointId.get(checkpointId) ?? [],
		});
	}));

	const cards = await Promise.all(
		liveSessions.map(async (session) => buildActiveSessionCard(
			session,
			checkpoints.get(session.lastCheckpointId ?? ""),
			commitsByCheckpointId,
			await canReadFile(session.transcriptPath),
		)),
	);

	return cards.sort((left, right) => compareOptionalTimestampsDesc(
		left.lastInteractionAt ?? left.startedAt,
		right.lastInteractionAt ?? right.startedAt,
	));
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
	const sessionMap = buildCommittedSessionCardMap(loadedState.checkpoints.values(), loadedState.stateIndex);

	for (const liveState of loadedState.stateIndex.sessions) {
		const existing = sessionMap.get(liveState.sessionId);
		const promptPreview = collapseWhitespace(liveState.lastPrompt ?? "") || NO_DESCRIPTION;
		const tokenCount = totalTokenUsage(liveState.tokenUsage);
		const liveStatus = getSessionStatus(liveState.sessionId, loadedState.stateIndex);
		const associatedCommit = liveState.lastCheckpointId
			? loadedState.checkpoints.get(liveState.lastCheckpointId)?.commits[0]
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
		if (liveState.lastCheckpointId && !existing.checkpointIds.includes(liveState.lastCheckpointId)) {
			existing.checkpointIds.push(liveState.lastCheckpointId);
			existing.checkpointCount = existing.checkpointIds.length;
		}
		existing.searchText = buildSearchText([existing.searchText, promptPreview, liveState.lastCheckpointId]);
	}

	return sortSessionCards([...sessionMap.values()]);
}

/**
 * Resolves session cards scoped to a selected set of checkpoint IDs.
 *
 * Unlike the broader session browser model, this stays anchored to the selected
 * checkpoint context and does not merge in sessions from unrelated checkpoints
 * on the active branch.
 *
 * @param repoPath Repository root used to load checkpoint metadata and live status overlays.
 * @param checkpointIds Checkpoint IDs currently selected in the checkpoint tree.
 * @returns Session cards that belong to the selected checkpoints.
 */
export async function listSessionsForCheckpointIds(repoPath: string, checkpointIds: string[]): Promise<EntireSessionCard[]> {
	const normalizedIds = sortUnique(
		checkpointIds.filter((checkpointId): checkpointId is string => typeof checkpointId === "string" && checkpointId.length > 0),
	);
	if (normalizedIds.length === 0) {
		return [];
	}

	const selectedCheckpointIds = new Set(normalizedIds);
	const [stateIndex, gitEnrichment] = await Promise.all([
		loadSessionStateIndex(repoPath),
		buildGitEnrichmentIndex(repoPath),
	]);
	const commitsByCheckpointId = new Map<string, CheckpointCommit[]>();

	for (const commit of gitEnrichment.checkpointCommits) {
		for (const checkpointId of commit.checkpointIds) {
			if (!selectedCheckpointIds.has(checkpointId)) {
				continue;
			}

			const existing = commitsByCheckpointId.get(checkpointId);
			if (existing) {
				existing.push(commit);
			} else {
				commitsByCheckpointId.set(checkpointId, [commit]);
			}
		}
	}

	const store = await resolveCheckpointStore(repoPath, { requiredCheckpointIds: normalizedIds });
	const checkpoints = (await Promise.all(normalizedIds.map<Promise<LoadedCheckpointRecord | null>>(async (checkpointId) => {
		const summary = await store.getCheckpointSummary(checkpointId);
		if (!summary) {
			return null;
		}

		const checkpoint: LoadedCheckpointRecord = {
			checkpointId,
			summary,
			sessions: await loadSessionsWithRecovery(store, checkpointId, summary),
			rewindPoints: [],
			commits: commitsByCheckpointId.get(checkpointId) ?? [],
		};

		return checkpoint;
	})))
		.filter((checkpoint): checkpoint is LoadedCheckpointRecord => checkpoint !== null);

	return sortSessionCards([...buildCommittedSessionCardMap(checkpoints, stateIndex).values()]);
}

/**
 * Resolves a structured detail payload for a selected live or checkpoint-backed session.
 *
 * @param repoPath Repository root used to load session state and checkpoint metadata.
 * @param target Selection target built from the Sessions tree item.
 * @returns Structured session details, or `null` when the selection can no longer be resolved.
 */
export async function getSessionDetail(repoPath: string, target: SessionDetailTarget): Promise<EntireSessionDetailModel | null> {
	const userDisplayName = await resolveUserDisplayName(repoPath);
	if (target.source === "checkpoint" && (target.checkpointEntries?.length ?? 0) > 0) {
		const stateIndex = await loadSessionStateIndex(repoPath);
		return buildCheckpointSessionDetailModelFromEntries(target, target.checkpointEntries ?? [], stateIndex, userDisplayName);
	}

	const checkpointIds = sortUnique(
		(target.checkpointIds ?? []).filter((checkpointId): checkpointId is string => typeof checkpointId === "string" && checkpointId.length > 0),
	);
	const detailContext = await loadDetailContext(repoPath, checkpointIds);
	const liveState = detailContext.stateIndex.bySessionId.get(target.sessionId);

	const resolvedCheckpointIds = checkpointIds.length > 0
		? checkpointIds
		: (liveState?.lastCheckpointId ? [liveState.lastCheckpointId] : []);
	const checkpoints = (await Promise.all(resolvedCheckpointIds.map(async (checkpointId) => loadCheckpointRecord(
		repoPath,
		checkpointId,
		detailContext,
		false,
	))))
		.filter((checkpoint): checkpoint is LoadedCheckpointRecord => checkpoint !== null);

	if (target.source === "live") {
		if (!liveState) {
			return null;
		}

		return buildLiveSessionDetailModel(liveState, checkpoints, target, userDisplayName);
	}

	return buildCheckpointSessionDetailModel(target, checkpoints, detailContext.stateIndex, userDisplayName);
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
	const detailContext = await loadDetailContext(
		repoPath,
		checkpointId.startsWith("temporary:") ? [] : [checkpointId],
	);

	if (checkpointId.startsWith("temporary:")) {
		const pointId = checkpointId.slice("temporary:".length);
		const point = detailContext.temporaryRewindPoints.find((entry) => entry.pointId === pointId);
		return point ? buildTemporaryDetailModel(point, detailContext.stateIndex) : null;
	}

	const directTemporaryPoint = detailContext.temporaryRewindPoints.find((entry) => entry.pointId === checkpointId);
	if (directTemporaryPoint) {
		return buildTemporaryDetailModel(directTemporaryPoint, detailContext.stateIndex);
	}

	const checkpoint = await loadCheckpointRecord(
		repoPath,
		checkpointId,
		detailContext,
		true,
	);
	return checkpoint ? buildCheckpointDetailModel(checkpoint, detailContext.stateIndex) : null;
}

/**
 * Resolves a structured commit detail model for a commit that carries one or
 * more active-branch Entire checkpoint trailers.
 *
 * @param repoPath Repository root used to load checkpoint metadata, git history, and session state.
 * @param commitSha Commit SHA to resolve.
 * @returns Structured commit details, or `null` when the commit cannot be resolved.
 */
export async function getCommitDetail(repoPath: string, commitSha: string): Promise<CommitDetailModel | null> {
	const initialDetailContext = await loadDetailContext(repoPath);
	const commit = initialDetailContext.gitEnrichment.checkpointCommits.find((entry) => entry.sha === commitSha || entry.shortSha === commitSha);
	if (!commit) {
		return null;
	}

	const detailContext = await loadDetailContext(repoPath, commit.checkpointIds);

	const [hydratedCommit] = await hydrateAssociatedCommits(repoPath, [commit], true);
	if (!hydratedCommit) {
		return null;
	}

	const linkedCheckpoints = await Promise.all(
		hydratedCommit.checkpointIds.map(async (checkpointId) => loadCheckpointRecord(
			repoPath,
			checkpointId,
			detailContext,
			false,
		)),
	);
	const commitGroup = {
		commit: hydratedCommit,
		diffSummary: hydratedCommit.fileStats ? summarizeFileStats(hydratedCommit.fileStats) : undefined,
		checkpoints: linkedCheckpoints
			.filter((checkpoint): checkpoint is LoadedCheckpointRecord => checkpoint !== null)
			.map((checkpoint) => ({
				checkpointId: checkpoint.checkpointId,
				summary: checkpoint.summary,
				rewindPoints: checkpoint.rewindPoints,
			} satisfies ResolvedCheckpointRef)),
	};

	if (linkedCheckpoints.length === 0) {
		return null;
	}

	const checkpointDetails = linkedCheckpoints
		.filter((checkpoint): checkpoint is LoadedCheckpointRecord => checkpoint !== null)
		.map((checkpoint) => buildCheckpointDetailModel(checkpoint, detailContext.stateIndex));
	if (checkpointDetails.length === 0) {
		return null;
	}

	const representative = selectRepresentativeCheckpointDetail(checkpointDetails);
	const overviewDiff = commitGroup.diffSummary ?? summarizeFileStats(commitGroup.commit.fileStats ?? []);
	const sessionIds = new Set<string>();
	for (const checkpoint of commitGroup.checkpoints) {
		const linkedCheckpoint = linkedCheckpoints.find((entry) => entry?.checkpointId === checkpoint.checkpointId) ?? undefined;
		for (const sessionId of selectSessionIds(linkedCheckpoint ?? undefined)) {
			sessionIds.add(sessionId);
		}
	}

	return {
		id: commitGroup.commit.sha,
		commit: commitGroup.commit,
		title: representative?.title ?? commitGroup.commit.message,
		hash: commitGroup.commit.shortSha,
		time: representative?.time ?? commitGroup.commit.authoredAt,
		user: commitGroup.commit.authorName,
		branch: representative?.branch,
		tokenCount: aggregateTokenCount(checkpointDetails),
		agent: representative?.agent,
		model: representative?.model,
		status: aggregateStatus(checkpointDetails.map((checkpoint) => checkpoint.status)),
		overview: {
			summary: representative?.overview.summary,
			filesChanged: overviewDiff?.filesChanged,
			linesAdded: overviewDiff?.linesAdded,
			linesRemoved: overviewDiff?.linesRemoved,
			sessionCount: sessionIds.size,
			tokenCount: aggregateTokenCount(checkpointDetails),
			stepCount: representative?.overview.stepCount,
			attribution: representative?.overview.attribution,
			commitMessage: commitGroup.commit.message,
		},
		files: commitGroup.commit.fileStats ?? [],
		diff: {
			patchText: commitGroup.commit.patchText,
			primaryCommitSha: commitGroup.commit.sha,
		},
		checkpoints: checkpointDetails,
	};
}

/**
 * Loads raw `entire explain` output for a checkpoint or commit.
 *
 * @param repoPath Repository root used as the command working directory.
 * @param target Explain target to resolve.
 * @returns Raw CLI output, or `null` when the target cannot be explained.
 */
export async function getRawExplainOutput(repoPath: string, target: RawExplainTarget): Promise<string | null> {
	const explainArgs = buildExplainArgs(target);
	if (!explainArgs) {
		return null;
	}

	return runExplainCommand(repoPath, explainArgs);
}

/**
 * Loads committed raw transcript content for a checkpoint, optionally narrowing
 * the lookup to a specific session within that checkpoint.
 *
 * @param repoPath Repository root used to read committed metadata.
 * @param checkpointId Checkpoint ID whose committed transcript should be loaded.
 * @param sessionId Optional session ID to target within that checkpoint.
 * @returns Raw transcript content, or `null` when no committed transcript is available.
 */
export async function getRawTranscript(
	repoPath: string,
	checkpointId: string,
	sessionId?: string,
): Promise<string | null> {
	const store = await resolveCheckpointStore(repoPath, { requiredCheckpointIds: [checkpointId] });
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

async function loadModuleState(repoPath: string, includePatch: boolean): Promise<ModuleState> {
	const [rewindIndex, gitEnrichment, stateIndex] = await Promise.all([
		loadRewindIndex(repoPath),
		buildGitEnrichmentIndex(repoPath),
		loadSessionStateIndex(repoPath),
	]);
	const checkpointIds = new Set<string>([
		...gitEnrichment.checkpointCommits.flatMap((commit) => commit.checkpointIds),
		...rewindIndex.byCheckpointId.keys(),
	]);
	const store = await resolveCheckpointStore(repoPath, { requiredCheckpointIds: [...checkpointIds] });
	const checkpoints = new Map<string, LoadedCheckpointRecord>();

	await Promise.all([...checkpointIds].map(async (checkpointId) => {
		const summary = await store.getCheckpointSummary(checkpointId);
		const sessions = summary ? await loadSessionsWithRecovery(store, checkpointId, summary) : [];
		checkpoints.set(checkpointId, {
			checkpointId,
			summary,
			sessions,
			rewindPoints: rewindIndex.byCheckpointId.get(checkpointId) ?? [],
			commits: [],
		});
	}));

	const commits = await hydrateAssociatedCommits(repoPath, gitEnrichment.checkpointCommits ?? [], includePatch);
	for (const commit of commits) {
		for (const checkpointId of commit.checkpointIds) {
			const checkpoint = checkpoints.get(checkpointId);
			if (checkpoint) {
				checkpoint.commits.push(commit);
			}
		}
	}

	const commitGroups = commits.map((commit) => ({
		commit,
		diffSummary: commit.fileStats ? summarizeFileStats(commit.fileStats) : undefined,
		checkpoints: commit.checkpointIds.map((checkpointId) => ({
			checkpointId,
			summary: checkpoints.get(checkpointId)?.summary ?? null,
			rewindPoints: checkpoints.get(checkpointId)?.rewindPoints ?? [],
		} satisfies ResolvedCheckpointRef)),
	}));

	return {
		commitGroups,
		checkpoints,
		stateIndex,
		temporaryRewindPoints: rewindIndex.points.filter((point) => point.isTemporary && !point.checkpointId),
	};
}

async function loadCommitGroupsForTree(repoPath: string): Promise<CommitCheckpointGroup[]> {
	const [rewindIndex, gitEnrichment] = await Promise.all([
		loadRewindIndex(repoPath),
		buildGitEnrichmentIndex(repoPath),
	]);
	const checkpointIds = new Set<string>([
		...gitEnrichment.checkpointCommits.flatMap((commit) => commit.checkpointIds),
		...rewindIndex.byCheckpointId.keys(),
	]);
	const store = await resolveCheckpointStore(repoPath, { requiredCheckpointIds: [...checkpointIds] });
	const checkpointSummaries = new Map<string, CheckpointSummaryRecord>();

	await Promise.all([...checkpointIds].map(async (checkpointId) => {
		const summary = await store.getCheckpointSummary(checkpointId);
		if (summary !== null) {
			checkpointSummaries.set(checkpointId, summary);
		}
	}));

	const commits = await hydrateAssociatedCommits(repoPath, gitEnrichment.checkpointCommits ?? [], false);
	return commits.map((commit) => ({
		commit,
		diffSummary: commit.fileStats ? summarizeFileStats(commit.fileStats) : undefined,
		checkpoints: commit.checkpointIds.map((checkpointId) => ({
			checkpointId,
			summary: checkpointSummaries.get(checkpointId) ?? null,
			rewindPoints: rewindIndex.byCheckpointId.get(checkpointId) ?? [],
		} satisfies ResolvedCheckpointRef)),
	}));
}

interface DetailContext {
	rewindIndex: Awaited<ReturnType<typeof loadRewindIndex>>;
	gitEnrichment: Awaited<ReturnType<typeof buildGitEnrichmentIndex>>;
	stateIndex: SessionStateIndex;
	temporaryRewindPoints: NormalizedRewindPoint[];
	store: BaseCheckpointStore;
}

async function loadDetailContext(repoPath: string, requiredCheckpointIds: string[] = []): Promise<DetailContext> {
	const [rewindIndex, gitEnrichment, stateIndex] = await Promise.all([
		loadRewindIndex(repoPath),
		buildGitEnrichmentIndex(repoPath),
		loadSessionStateIndex(repoPath),
	]);

	return {
		rewindIndex,
		gitEnrichment,
		stateIndex,
		temporaryRewindPoints: rewindIndex.points.filter((point) => point.isTemporary && !point.checkpointId),
		store: await resolveCheckpointStore(repoPath, { requiredCheckpointIds }),
	};
}

async function loadCheckpointRecord(
	repoPath: string,
	checkpointId: string,
	context: DetailContext,
	includePatch: boolean,
): Promise<LoadedCheckpointRecord | null> {
	const summary = await context.store.getCheckpointSummary(checkpointId);
	const sessions = summary ? await loadSessionsWithRecovery(context.store, checkpointId, summary) : [];
	const associatedCommits = context.gitEnrichment.checkpointCommits.filter((commit) => commit.checkpointIds.includes(checkpointId));
	const commits = associatedCommits.length > 0
		? await hydrateAssociatedCommits(repoPath, associatedCommits, includePatch)
		: [];

	if (!summary && commits.length === 0 && (context.rewindIndex.byCheckpointId.get(checkpointId)?.length ?? 0) === 0) {
		return null;
	}

	return {
		checkpointId,
		summary,
		sessions,
		rewindPoints: context.rewindIndex.byCheckpointId.get(checkpointId) ?? [],
		commits,
	};
}

function buildCheckpointCard(
	checkpoint: LoadedCheckpointRecord,
	stateIndex: SessionStateIndex,
): EntireCheckpointCard {
	const latestSession = selectLatestSession(checkpoint.sessions);
	const fileStats = checkpoint.commits.length > 0 ? aggregateFileStats(checkpoint.commits) : [];
	const diffSummary = summarizeFileStats(fileStats);
	const promptPreview = selectPromptPreview(
		latestSession?.prompts ?? null,
		latestSession?.transcript ?? null,
		checkpoint.rewindPoints[0]?.sessionPrompt,
		checkpoint.summary ? promptDescription(latestSession?.prompts ?? null) : checkpoint.rewindPoints[0]?.message,
		checkpoint.commits[0]?.message,
	);
	const sessionIds = selectSessionIds(checkpoint);
	const tokenCount = totalTokenUsage(latestSession?.metadata.tokenUsage) ?? totalTokenUsage(checkpoint.summary?.tokenUsage);
	const primaryCommit = checkpoint.commits[0];

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
		branch: latestSession?.metadata.branch ?? checkpoint.summary?.branch,
		tokenCount,
		stepCount: latestSession?.metadata.checkpointsCount ?? checkpoint.summary?.checkpointsCount,
		fileCount: diffSummary?.filesChanged ?? checkpoint.summary?.filesTouched.length,
		sessionCount: checkpoint.summary?.sessions.length ?? Math.max(sessionIds.length, checkpoint.rewindPoints[0]?.sessionId ? 1 : 0),
		attribution: selectAttribution(checkpoint.sessions),
		summary: selectSummary(checkpoint.sessions),
		primaryCommit,
		associatedCommitCount: checkpoint.commits.length,
		diffSummary,
		rewindAvailability: selectRewindAvailability(checkpoint.rewindPoints, checkpoint.checkpointId),
		isEphemeral: checkpoint.summary === null,
		searchText: buildSearchText([
			promptPreview,
			checkpoint.checkpointId,
			primaryCommit?.shortSha,
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
	const promptPreview = collapseWhitespace(point.sessionPrompt ?? point.message) || NO_DESCRIPTION;
	const tokenCount = totalTokenUsage(liveState?.tokenUsage);

	return {
		id: `temporary:${point.pointId}`,
		rewindPointId: point.pointId,
		promptPreview,
		displayHash: point.displayHash,
		agent: liveState?.agentType,
		model: liveState?.modelName,
		status: getSessionStatus(point.sessionId, stateIndex),
		timestamp: point.date ?? liveState?.lastInteractionAt ?? liveState?.startedAt,
		tokenCount,
		stepCount: liveState?.checkpointCount,
		sessionCount: point.sessionId ? 1 : 0,
		associatedCommitCount: 0,
		rewindAvailability: rewindAvailabilityForPoint(point),
		isEphemeral: true,
		searchText: buildSearchText([
			promptPreview,
			point.displayHash,
			liveState?.agentType,
			liveState?.modelName,
		]),
	};
}

function buildCheckpointDetailModel(
	checkpoint: LoadedCheckpointRecord,
	stateIndex: SessionStateIndex,
): CheckpointDetailModel {
	const commits = checkpoint.commits;
	const fileStats = commits.length > 0
		? aggregateFileStats(commits)
		: (checkpoint.summary?.filesTouched ?? []).map((filePath) => ({ path: filePath }));
	const diffSummary = summarizeFileStats(fileStats);
	const latestSession = selectLatestSession(checkpoint.sessions);
	const promptPreview = selectPromptPreview(
		latestSession?.prompts ?? null,
		latestSession?.transcript ?? null,
		checkpoint.rewindPoints[0]?.sessionPrompt,
		checkpoint.summary ? promptDescription(latestSession?.prompts ?? null) : checkpoint.rewindPoints[0]?.message,
		commits[0]?.message,
	);
	const summary = selectSummary(checkpoint.sessions);
	const attribution = selectAttribution(checkpoint.sessions);
	const sessionIds = selectSessionIds(checkpoint);
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
		branch: latestSession?.metadata.branch ?? checkpoint.summary?.branch,
		tokenCount: totalTokenUsage(latestSession?.metadata.tokenUsage) ?? totalTokenUsage(checkpoint.summary?.tokenUsage),
		agent: latestSession?.metadata.agent,
		model: latestSession?.metadata.model,
		status: getCheckpointStatus(sessionIds, stateIndex),
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
		files: fileStats,
		diff: {
			patchText: primaryCommit?.patchText,
			primaryCommitSha: primaryCommit?.sha,
		},
		rewindAvailability,
		rawTranscriptAvailable: checkpoint.sessions.some((session) => typeof session.transcript === "string" && session.transcript.length > 0),
	};
}

function buildTemporaryDetailModel(
	point: NormalizedRewindPoint,
	stateIndex: SessionStateIndex,
): CheckpointDetailModel {
	const liveState = point.sessionId ? stateIndex.bySessionId.get(point.sessionId) : undefined;
	const promptPreview = collapseWhitespace(point.sessionPrompt ?? point.message) || NO_DESCRIPTION;

	return {
		id: `temporary:${point.pointId}`,
		checkpointId: point.checkpointId,
		rewindPointId: point.pointId,
		isEphemeral: true,
		title: promptPreview,
		promptPreview,
		hash: point.displayHash,
		associatedCommits: [],
		additionalAssociatedCommitCount: 0,
		time: point.date ?? liveState?.lastInteractionAt ?? liveState?.startedAt,
		branch: undefined,
		tokenCount: totalTokenUsage(liveState?.tokenUsage),
		agent: liveState?.agentType,
		model: liveState?.modelName,
		status: getSessionStatus(point.sessionId, stateIndex),
		overview: {
			sessionCount: point.sessionId ? 1 : 0,
			tokenCount: totalTokenUsage(liveState?.tokenUsage),
			stepCount: liveState?.checkpointCount,
		},
		files: [],
		diff: {},
		rewindAvailability: rewindAvailabilityForPoint(point),
		rawTranscriptAvailable: false,
	};
}

type LoadedLiveSession = Awaited<ReturnType<typeof loadSessionStateIndex>>["sessions"][number];

function buildCommittedSessionCardMap(
	checkpoints: Iterable<LoadedCheckpointRecord>,
	stateIndex: SessionStateIndex,
): Map<string, EntireSessionCard> {
	const sessionMap = new Map<string, EntireSessionCard>();

	for (const checkpoint of checkpoints) {
		const primaryCommit = checkpoint.commits[0];
		for (const [sessionIndex, session] of checkpoint.sessions.entries()) {
			const sessionId = session.metadata.sessionId;
			if (!sessionId) {
				continue;
			}

			const existing = sessionMap.get(sessionId);
			const promptPreview = selectPromptPreview(
				session.prompts,
				session.transcript,
				checkpoint.rewindPoints[0]?.sessionPrompt,
				checkpoint.summary ? promptDescription(session.prompts) : undefined,
			);
			const tokenCount = totalTokenUsage(session.metadata.tokenUsage) ?? totalTokenUsage(checkpoint.summary?.tokenUsage);
			const toolCount = countTranscriptToolUses(session.transcript);
			const createdAt = extractTranscriptFirstTimestamp(session.transcript) ?? session.metadata.createdAt;
			const lastActivityAt = extractTranscriptLatestTimestamp(session.transcript) ?? session.metadata.createdAt ?? createdAt;
			const checkpointEntry: SessionCheckpointEntry = {
				checkpointId: checkpoint.checkpointId,
				sessionIndex,
				session,
				checkpointTokenUsage: checkpoint.summary?.tokenUsage,
			};

			if (!existing) {
				sessionMap.set(sessionId, {
					id: sessionId,
					sessionId,
					promptPreview,
					displayHash: checkpoint.checkpointId,
					checkpointIds: [checkpoint.checkpointId],
					checkpointEntries: [checkpointEntry],
					agent: session.metadata.agent,
					model: session.metadata.model,
					status: getSessionStatus(sessionId, stateIndex),
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
			if (!existing.checkpointEntries?.some((entry) => entry.checkpointId === checkpoint.checkpointId && entry.sessionIndex === sessionIndex)) {
				existing.checkpointEntries = [...(existing.checkpointEntries ?? []), checkpointEntry];
			}

			if (isLater(lastActivityAt, existing.lastActivityAt)) {
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
			existing.status = getSessionStatus(sessionId, stateIndex);
		}
	}

	return sessionMap;
}

function buildActiveSessionCard(
	liveState: LoadedLiveSession,
	checkpoint: LoadedCheckpointRecord | undefined,
	commitsByCheckpointId: Map<string, CheckpointCommit[]>,
	canOpenTranscript: boolean,
): EntireActiveSessionCard {
	const checkpointSession = selectSessionContentForLiveSession(liveState, checkpoint);
	const associatedCommit = liveState.lastCheckpointId
		? commitsByCheckpointId.get(liveState.lastCheckpointId)?.[0]
		: undefined;
	const directPrompt = collapseWhitespace(liveState.lastPrompt ?? "");
	const promptPreview = directPrompt.length > 0
		? directPrompt
		: selectPromptPreview(
			checkpointSession?.prompts ?? null,
			checkpointSession?.transcript ?? null,
			associatedCommit?.message,
		);
	const tokenCount = totalTokenUsage(liveState.tokenUsage)
		?? totalTokenUsage(checkpointSession?.metadata.tokenUsage)
		?? totalTokenUsage(checkpoint?.summary?.tokenUsage);
	const checkpointCount = liveState.checkpointCount
		?? checkpointSession?.metadata.checkpointsCount
		?? (liveState.lastCheckpointId ? 1 : 0);
	const turnCount = liveState.sessionTurnCount ?? checkpointSession?.metadata.sessionMetrics?.turnCount;
	const durationMs = liveState.sessionDurationMs ?? checkpointSession?.metadata.sessionMetrics?.durationMs;

	return {
		id: liveState.sessionId,
		sessionId: liveState.sessionId,
		status: normalizeSessionStatus(liveState.phase, liveState.endedAt),
		phase: liveState.phase,
		promptPreview,
		agent: liveState.agentType,
		model: liveState.modelName,
		startedAt: liveState.startedAt,
		lastInteractionAt: liveState.lastInteractionAt ?? liveState.startedAt,
		durationMs,
		checkpointCount,
		turnCount,
		tokenCount,
		attribution: checkpointSession?.metadata.initialAttribution,
		lastCheckpointId: liveState.lastCheckpointId,
		author: associatedCommit?.authorName,
		worktreePath: liveState.worktreePath,
		worktreeId: liveState.worktreeId,
		baseCommit: liveState.baseCommit,
		transcriptPath: liveState.transcriptPath,
		hasShadowBranch: liveState.hasShadowBranch,
		isStuck: liveState.isStuck,
		canRunDoctor: liveState.canRunDoctor,
		canOpenLastCheckpoint: typeof liveState.lastCheckpointId === "string" && liveState.lastCheckpointId.length > 0,
		canOpenTranscript,
		searchText: buildSearchText([
			promptPreview,
			liveState.sessionId,
			liveState.lastCheckpointId,
			liveState.agentType,
			liveState.modelName,
			associatedCommit?.authorName,
		]),
	};
}

async function buildLiveSessionDetailModel(
	liveState: LoadedLiveSession,
	checkpoints: LoadedCheckpointRecord[],
	target: SessionDetailTarget,
	userDisplayName: string | undefined,
): Promise<EntireSessionDetailModel> {
	const checkpoint = checkpoints.find((entry) => entry.checkpointId === liveState.lastCheckpointId)
		?? checkpoints[0];
	const checkpointSession = selectSessionContentForLiveSession(liveState, checkpoint);
	const liveTranscript = await readTextIfExists(liveState.transcriptPath);
	const transcript = liveTranscript ?? checkpointSession?.transcript ?? null;
	const parsedTranscript = transcript
		? parseNativeSessionTranscript(transcript, {
			agentHint: liveState.agentType ?? checkpointSession?.metadata.agent,
			sessionIdHint: liveState.sessionId,
			userHint: userDisplayName,
		})
		: null;
	const turns = parsedTranscript?.turns ?? [];
	const promptPreview = collapseWhitespace(liveState.lastPrompt ?? "").length > 0
		? collapseWhitespace(liveState.lastPrompt ?? "")
		: collapseWhitespace(parsedTranscript?.promptPreview ?? "").length > 0
			? collapseWhitespace(parsedTranscript?.promptPreview ?? "")
			: selectPromptPreview(
				checkpointSession?.prompts ?? null,
				transcript,
				target.promptPreview,
			);

	return {
		sessionId: liveState.sessionId,
		source: "live",
		promptPreview,
		status: normalizeSessionStatus(liveState.phase, liveState.endedAt),
		startedAt: liveState.startedAt ?? parsedTranscript?.startedAt ?? checkpointSession?.metadata.createdAt,
		lastActivityAt: liveState.lastInteractionAt ?? parsedTranscript?.endedAt ?? checkpointSession?.metadata.createdAt,
		durationMs: liveState.sessionDurationMs ?? checkpointSession?.metadata.sessionMetrics?.durationMs,
		checkpointCount: liveState.checkpointCount ?? checkpointSession?.metadata.checkpointsCount ?? (liveState.lastCheckpointId ? 1 : 0),
		turnCount: liveState.sessionTurnCount ?? checkpointSession?.metadata.sessionMetrics?.turnCount ?? turns.length,
		toolCount: parsedTranscript?.toolCount ?? countTranscriptToolUses(transcript),
		tokenCount: totalTokenUsage(liveState.tokenUsage)
			?? totalTokenUsage(checkpointSession?.metadata.tokenUsage)
			?? totalTokenUsage(checkpoint?.summary?.tokenUsage),
		model: liveState.modelName ?? parsedTranscript?.model ?? checkpointSession?.metadata.model,
		agent: liveState.agentType ?? checkpointSession?.metadata.agent,
		attribution: checkpointSession?.metadata.initialAttribution,
		transcriptAvailable: typeof transcript === "string" && transcript.length > 0,
		turns,
	};
}

function buildCheckpointSessionDetailModel(
	target: SessionDetailTarget,
	checkpoints: LoadedCheckpointRecord[],
	stateIndex: SessionStateIndex,
	userDisplayName: string | undefined,
): EntireSessionDetailModel | null {
	const sessionEntries = checkpoints.flatMap((checkpoint) => checkpoint.sessions
		.filter((session) => session.metadata.sessionId === target.sessionId)
		.map((session) => ({
			checkpointId: checkpoint.checkpointId,
			session,
			checkpointTokenUsage: checkpoint.summary?.tokenUsage,
		})));
	return buildCheckpointSessionDetailModelFromEntries(target, sessionEntries, stateIndex, userDisplayName);
}

function buildCheckpointSessionDetailModelFromEntries(
	target: SessionDetailTarget,
	sessionEntries: ReadonlyArray<Pick<SessionCheckpointEntry, "checkpointId" | "session" | "checkpointTokenUsage">>,
	stateIndex: SessionStateIndex,
	userDisplayName: string | undefined,
): EntireSessionDetailModel | null {
	if (sessionEntries.length === 0) {
		return null;
	}

	const sortedEntries = [...sessionEntries].sort((left, right) => (
		(parseTimestamp(extractTranscriptLatestTimestamp(right.session.transcript) ?? right.session.metadata.createdAt) ?? 0)
		- (parseTimestamp(extractTranscriptLatestTimestamp(left.session.transcript) ?? left.session.metadata.createdAt) ?? 0)
	));
	const [latestEntry] = sortedEntries;
	const transcriptEntry = sortedEntries.find((entry) => typeof entry.session.transcript === "string" && entry.session.transcript.length > 0)
		?? latestEntry;
	const transcript = transcriptEntry.session.transcript;
	const parsedTranscript = transcript
		? parseNativeSessionTranscript(transcript, {
			agentHint: latestEntry.session.metadata.agent,
			sessionIdHint: target.sessionId,
			userHint: userDisplayName,
		})
		: null;
	const turns = parsedTranscript?.turns ?? [];
	const checkpointCount = new Set(sessionEntries.map((entry) => entry.checkpointId)).size;
	const sessions = sessionEntries.map((entry) => entry.session);

	return {
		sessionId: target.sessionId,
		source: "checkpoint",
		promptPreview: collapseWhitespace(parsedTranscript?.promptPreview ?? "").length > 0
			? collapseWhitespace(parsedTranscript?.promptPreview ?? "")
			: selectPromptPreview(
				latestEntry.session.prompts,
				transcript,
				target.promptPreview,
			),
		status: getSessionStatus(target.sessionId, stateIndex),
		startedAt: parsedTranscript?.startedAt ?? pickEarliestSessionTimestamp(sessionEntries),
		lastActivityAt: parsedTranscript?.endedAt ?? pickLatestSessionTimestamp(sessionEntries),
		durationMs: latestEntry.session.metadata.sessionMetrics?.durationMs,
		checkpointCount,
		turnCount: latestEntry.session.metadata.sessionMetrics?.turnCount ?? turns.length,
		toolCount: parsedTranscript?.toolCount ?? countTranscriptToolUses(transcript),
		tokenCount: totalTokenUsage(latestEntry.session.metadata.tokenUsage)
			?? totalTokenUsage(latestEntry.checkpointTokenUsage),
		model: parsedTranscript?.model ?? latestEntry.session.metadata.model,
		attribution: selectLatestMetadataWithValue(sessions, (session) => session.metadata.initialAttribution),
		transcriptAvailable: typeof transcript === "string" && transcript.length > 0,
		turns,
	};
}

function selectSessionIds(checkpoint: LoadedCheckpointRecord | undefined): string[] {
	if (!checkpoint) {
		return [];
	}

	return checkpoint.sessions
		.map((session) => session.metadata.sessionId)
		.filter((sessionId): sessionId is string => sessionId.length > 0);
}

function selectSessionContentForLiveSession(
	liveState: LoadedLiveSession,
	checkpoint: LoadedCheckpointRecord | undefined,
): SessionContentRecord | undefined {
	if (!checkpoint) {
		return undefined;
	}

	return checkpoint.sessions.find((session) => session.metadata.sessionId === liveState.sessionId)
		?? selectLatestSession(checkpoint.sessions);
}

async function readTextIfExists(filePath: string | undefined): Promise<string | null> {
	if (!filePath) {
		return null;
	}

	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function resolveUserDisplayName(repoPath: string): Promise<string | undefined> {
	const configuredName = (await tryExecGit(repoPath, ["config", "user.name"]))?.trim();
	if (configuredName) {
		return configuredName;
	}

	return undefined;
}

function humanizeUserIdentifier(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value
		.replace(/[._-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length === 0) {
		return undefined;
	}

	return normalized
		.split(" ")
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

async function canReadFile(filePath: string | undefined): Promise<boolean> {
	if (!filePath) {
		return false;
	}

	try {
		await fs.access(filePath, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
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

function aggregateTokenCount(checkpoints: CheckpointDetailModel[]): number | undefined {
	let total = 0;
	let hasTokens = false;

	for (const checkpoint of checkpoints) {
		if (typeof checkpoint.tokenCount === "number") {
			total += checkpoint.tokenCount;
			hasTokens = true;
		}
	}

	return hasTokens ? total : undefined;
}

function aggregateStatus(statuses: SessionStatus[]): SessionStatus {
	if (statuses.includes("ACTIVE")) {
		return "ACTIVE";
	}
	if (statuses.includes("IDLE")) {
		return "IDLE";
	}
	return "ENDED";
}

function selectRepresentativeCheckpointDetail(
	checkpoints: CheckpointDetailModel[],
): CheckpointDetailModel | undefined {
	return [...checkpoints].sort((left, right) => (parseTimestamp(right.time) ?? 0) - (parseTimestamp(left.time) ?? 0))[0];
}

function pickEarliestSessionTimestamp(
	sessionEntries: ReadonlyArray<{ session: SessionContentRecord }>,
): string | undefined {
	let earliest: string | undefined;

	for (const entry of sessionEntries) {
		const candidate = extractTranscriptFirstTimestamp(entry.session.transcript) ?? entry.session.metadata.createdAt;
		if (!candidate) {
			continue;
		}

		if (!earliest || (parseTimestamp(candidate) ?? 0) < (parseTimestamp(earliest) ?? 0)) {
			earliest = candidate;
		}
	}

	return earliest;
}

function pickLatestSessionTimestamp(
	sessionEntries: ReadonlyArray<{ session: SessionContentRecord }>,
): string | undefined {
	let latest: string | undefined;

	for (const entry of sessionEntries) {
		const candidate = extractTranscriptLatestTimestamp(entry.session.transcript) ?? entry.session.metadata.createdAt;
		if (!candidate) {
			continue;
		}

		if (!latest || (parseTimestamp(candidate) ?? 0) > (parseTimestamp(latest) ?? 0)) {
			latest = candidate;
		}
	}

	return latest;
}

function countToolsFromTurns(turns: SessionDetailTurn[]): number | undefined {
	const total = turns.reduce((sum, turn) => sum + turn.toolActivities.length, 0);
	return total > 0 ? total : undefined;
}

async function loadSessionsWithRecovery(
	store: BaseCheckpointStore,
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

function buildExplainArgs(target: RawExplainTarget): string[] | null {
	if (target.checkpointId) {
		return [
			"explain",
			"--checkpoint",
			target.checkpointId,
			...(target.fullTranscript ? ["--full"] : []),
		];
	}

	if (target.commitSha) {
		return ["explain", "--commit", target.commitSha];
	}

	return null;
}

async function runExplainCommand(repoPath: string, explainArgs: string[]): Promise<string | null> {
	const withNoPager = await runCommandAsync("entire", [...explainArgs, "--no-pager"], repoPath);
	if (withNoPager.exitCode === 0) {
		return withNoPager.stdout || withNoPager.stderr || null;
	}

	const withoutNoPager = await runCommandAsync("entire", explainArgs, repoPath);
	if (withoutNoPager.exitCode === 0) {
		return withoutNoPager.stdout || withoutNoPager.stderr || null;
	}

	return withoutNoPager.stderr.trim() || withoutNoPager.stdout.trim() || withNoPager.stderr.trim() || withNoPager.stdout.trim() || null;
}
