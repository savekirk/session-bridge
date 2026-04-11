/** JSON scalar, object, or array value read from checkpoint metadata files. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Plain JSON object used by parsing helpers throughout the checkpoint module. */
export type JsonObject = { [key: string]: JsonValue };

/** Token accounting captured in committed checkpoint metadata or live session state. */
export interface TokenUsage {
	inputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
	apiCallCount: number;
	subagentTokens?: TokenUsage;
}

/** Session-level runtime metrics recorded alongside committed metadata. */
export interface SessionMetrics {
	durationMs?: number;
	turnCount?: number;
	contextTokens?: number;
	contextWindowSize?: number;
}

/** A single code-focused learning extracted into checkpoint summary metadata. */
export interface CodeLearning {
	path: string;
	line?: number;
	endLine?: number;
	finding: string;
}

/** Structured learning summary attached to a committed checkpoint summary. */
export interface LearningsSummary {
	repo: string[];
	code: CodeLearning[];
	workflow: string[];
}

/** High-level summary generated for a committed checkpoint session. */
export interface SummaryRecord {
	intent: string;
	outcome: string;
	learnings: LearningsSummary;
	friction: string[];
	openItems: string[];
}

/** Initial attribution breakdown for lines committed by the session. */
export interface InitialAttribution {
	calculatedAt?: string;
	agentLines: number;
	humanAdded: number;
	humanModified: number;
	humanRemoved: number;
	totalCommitted: number;
	agentPercentage: number;
}

/** Relative paths to session files stored under the committed metadata branch. */
export interface SessionFilePaths {
	metadata: string;
	transcript: string;
	context?: string;
	contentHash: string;
	prompt: string;
}

/** Top-level committed checkpoint metadata read from `metadata.json`. */
export interface CheckpointSummaryRecord {
	checkpointId: string;
	strategy: string;
	branch?: string;
	checkpointsCount: number;
	filesTouched: string[];
	sessions: SessionFilePaths[];
	tokenUsage?: TokenUsage;
	cliVersion?: string;
	raw: JsonObject;
}

/** Per-session committed metadata stored beneath a checkpoint directory. */
export interface CommittedMetadataRecord {
	checkpointId: string;
	sessionId: string;
	strategy: string;
	createdAt?: string;
	branch?: string;
	checkpointsCount: number;
	filesTouched: string[];
	agent?: string;
	model?: string;
	turnId?: string;
	isTask: boolean;
	toolUseId?: string;
	transcriptIdentifierAtStart?: string;
	checkpointTranscriptStart?: number;
	tokenUsage?: TokenUsage;
	sessionMetrics?: SessionMetrics;
	summary?: SummaryRecord;
	initialAttribution?: InitialAttribution;
	raw: JsonObject;
}

/** Full session payload loaded from committed metadata storage, including optional legacy context text. */
export interface SessionContentRecord {
	metadata: CommittedMetadataRecord;
	transcript: string | null;
	context: string | null;
	prompts: string | null;
	contentHash: string | null;
}

/** Lightweight session-to-checkpoint link used by grouped session history views. */
export interface SessionCheckpointRecord {
	checkpointId: string;
	message: string;
	timestamp?: string;
	isTaskCheckpoint: boolean;
	toolUseId?: string;
}

/** Session history assembled by grouping committed checkpoint sessions by `sessionId`. */
export interface SessionRecord {
	id: string;
	description: string;
	strategy: string;
	startTime?: string;
	checkpoints: SessionCheckpointRecord[];
}

/** Parsed transcript event derived from JSONL or single-line JSON content. */
export interface TranscriptEvent {
	index: number;
	eventType?: string;
	timestamp?: string;
	raw: unknown;
	rawText: string;
}

/** Abstract checkpoint storage contract implemented by git-backed and fs-backed readers. */
export interface CheckpointStore {
	listCheckpointIds(): Promise<string[]>;
	listCheckpoints(): Promise<CheckpointSummaryRecord[]>;
	getCheckpointSummary(checkpointId: string): Promise<CheckpointSummaryRecord | null>;
	getSessionContent(checkpointId: string, sessionIndex: number, sessionPaths?: SessionFilePaths): Promise<SessionContentRecord>;
	getSessionContentById(checkpointId: string, sessionId: string): Promise<SessionContentRecord>;
	listSessions(): Promise<SessionRecord[]>;
}

/** Best-effort normalized shape for live session state files in `.git/entire-sessions`. */
export interface LiveSessionStateRecord {
	sessionId: string;
	cliVersion?: string;
	baseCommit?: string;
	attributionBaseCommit?: string;
	worktreePath?: string;
	worktreeId?: string;
	startedAt?: string;
	endedAt?: string;
	phase?: string;
	turnId?: string;
	turnCheckpointIds: string[];
	lastInteractionAt?: string;
	checkpointCount?: number;
	lastCheckpointId?: string;
	filesTouched: string[];
	fullyCondensed: boolean;
	attachedManually: boolean;
	agentType?: string;
	modelName?: string;
	tokenUsage?: TokenUsage;
	sessionDurationMs?: number;
	sessionTurnCount?: number;
	contextTokens?: number;
	contextWindowSize?: number;
	transcriptPath?: string;
	lastPrompt?: string;
	hasShadowBranch: boolean;
	isStuck: boolean;
	canRunDoctor: boolean;
	raw: JsonObject;
}
