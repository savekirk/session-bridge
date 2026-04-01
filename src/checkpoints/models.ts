import type { InitialAttribution, SummaryRecord } from "./types";

/** Normalized live-or-historical session status used by card and detail models. */
export type SessionStatus = "ACTIVE" | "IDLE" | "ENDED";

/** Per-file diff statistics aggregated from active-branch associated commits. */
export interface FileDiffStat {
	path: string;
	additions?: number;
	deletions?: number;
}

/** Rollup of changed-file counts and numeric line deltas for a checkpoint. */
export interface DiffSummaryModel {
	filesChanged: number;
	linesAdded?: number;
	linesRemoved?: number;
}

/** Commit metadata associated with a checkpoint on the active branch. */
export interface AssociatedCommitModel {
	sha: string;
	shortSha: string;
	message: string;
	body?: string;
	authorName: string;
	authorEmail?: string;
	authoredAt?: string;
	fileStats?: FileDiffStat[];
	patchText?: string;
}

/** Current rewindability and rewind-mode metadata for a checkpoint or temporary point. */
export interface RewindAvailability {
	isAvailable: boolean;
	pointId?: string;
	checkpointId?: string;
	isLogsOnly: boolean;
	isTaskCheckpoint: boolean;
	isTemporary: boolean;
	message?: string;
	sessionId?: string;
}

/** Normalized model for a session browser card. */
export interface EntireSessionCard {
	id: string;
	sessionId: string;
	promptPreview: string;
	displayHash?: string;
	checkpointIds: string[];
	agent?: string;
	model?: string;
	status: SessionStatus;
	author?: string;
	branch?: string;
	createdAt?: string;
	lastActivityAt?: string;
	durationMs?: number;
	stepCount?: number;
	toolCount?: number;
	tokenCount?: number;
	attribution?: InitialAttribution;
	checkpointCount: number;
	latestCheckpointId?: string;
	latestAssociatedCommitSha?: string;
	isLiveOnly: boolean;
	searchText: string;
}

/** Normalized model for a checkpoint browser card. */
export interface EntireCheckpointCard {
	id: string;
	checkpointId?: string;
	rewindPointId?: string;
	promptPreview: string;
	displayHash: string;
	agent?: string;
	model?: string;
	status: SessionStatus;
	author?: string;
	timestamp?: string;
	branch?: string;
	tokenCount?: number;
	stepCount?: number;
	fileCount?: number;
	sessionCount: number;
	attribution?: InitialAttribution;
	summary?: SummaryRecord;
	primaryCommit?: AssociatedCommitModel;
	associatedCommitCount: number;
	diffSummary?: DiffSummaryModel;
	rewindAvailability?: RewindAvailability;
	isEphemeral: boolean;
	searchText: string;
}

/** Structured detail payload for a committed or temporary checkpoint item. */
export interface CheckpointDetailModel {
	id: string;
	checkpointId?: string;
	rewindPointId?: string;
	isEphemeral: boolean;
	title: string;
	promptPreview: string;
	hash: string;
	primaryCommit?: AssociatedCommitModel;
	associatedCommits: AssociatedCommitModel[];
	additionalAssociatedCommitCount: number;
	time?: string;
	user?: string;
	branch?: string;
	tokenCount?: number;
	agent?: string;
	model?: string;
	status: SessionStatus;
	overview: {
		summary?: SummaryRecord;
		filesChanged?: number;
		linesAdded?: number;
		linesRemoved?: number;
		sessionCount: number;
		tokenCount?: number;
		stepCount?: number;
		attribution?: InitialAttribution;
		commitMessage?: string;
	};
	files: FileDiffStat[];
	diff: {
		patchText?: string;
		primaryCommitSha?: string;
	};
	rewindAvailability?: RewindAvailability;
	rawTranscriptAvailable: boolean;
}
