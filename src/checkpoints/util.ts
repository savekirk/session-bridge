import { promises as fs } from "fs";
import path from "path";
import { runCommandAsync } from "../runCommand";
import type {
	CheckpointSummaryRecord,
	CodeLearning,
	CommittedMetadataRecord,
	InitialAttribution,
	JsonObject,
	JsonValue,
	LearningsSummary,
	SessionFilePaths,
	SessionMetrics,
	SummaryRecord,
	TokenUsage,
} from "./types";

/** Name of the branch that stores committed, redacted Entire checkpoint metadata. */
export const METADATA_BRANCH_NAME = "entire/checkpoints/v1";
/** Fallback description used when no usable prompt text is available. */
export const NO_DESCRIPTION = "No description";
const CHECKPOINT_ID_PATTERN = /^[0-9a-f]{12}$/;
const PROMPT_SEPARATOR = "\n\n---\n\n";

/**
 * Checks whether a value matches the 12-character lowercase hex checkpoint ID format used by Entire.
 *
 * @param checkpointId Candidate checkpoint ID to test.
 * @returns `true` when the value is a valid checkpoint ID.
 */
export function isCheckpointId(checkpointId: string | undefined): checkpointId is string {
	return typeof checkpointId === "string" && CHECKPOINT_ID_PATTERN.test(checkpointId);
}

/**
 * Validates that a checkpoint ID matches the 12-character hex format used by Entire.
 *
 * @param checkpointId Candidate checkpoint ID to validate.
 * @returns Nothing. Throws when the ID is invalid.
 */
export function validateCheckpointId(checkpointId: string): void {
	if (!isCheckpointId(checkpointId)) {
		throw new Error(`Invalid checkpoint ID: ${checkpointId}`);
	}
}

/**
 * Converts a checkpoint ID into its sharded metadata path on disk or in git object storage.
 * The sharding is done by taking the first 2 components of the checkpoint id and the rest to create the directories.
 * E.g a checkpoint id of `00162eec7c33` will result in `/00/162eec7c33`. 
 *
 * @param checkpointId The 12-character checkpoint ID to shard.
 * @returns The sharded path used by Entire metadata storage.
 */
export function shardedCheckpointPath(checkpointId: string): string {
	validateCheckpointId(checkpointId);
	return path.posix.join(checkpointId.slice(0, 2), checkpointId.slice(2));
}

/**
 * Collapses repeated whitespace so prompts and messages render cleanly in cards.
 *
 * @param value Raw string value to normalize.
 * @returns The whitespace-collapsed string.
 */
export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Splits a committed prompt file into logical prompt entries.
 *
 * @param promptText Raw prompt file contents, or `null` when unavailable.
 * @returns Individual prompt entries with normalized whitespace.
 */
export function splitPromptText(promptText: string | null): string[] {
	if (!promptText) {
		return [];
	}

	return promptText
		.split(PROMPT_SEPARATOR)
		.map((entry) => collapseWhitespace(entry))
		.filter((entry) => entry.length > 0);
}

/**
 * Returns the first prompt entry or the shared no-description fallback.
 *
 * @param promptText Raw prompt file contents, or `null` when unavailable.
 * @returns A human-readable prompt description for cards and summaries.
 */
export function promptDescription(promptText: string | null): string {
	const prompts = splitPromptText(promptText);
	return prompts[0] ?? NO_DESCRIPTION;
}

/**
 * Type guard for plain JSON objects used by metadata and transcript parsing helpers.
 *
 * @param value Value to test.
 * @returns `true` when the value is a non-array object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads and parses a JSON object from disk, returning `undefined` when the file is absent.
 *
 * @param filePath Absolute or repo-relative file path to read.
 * @returns The parsed JSON object, or `undefined` when the file does not exist.
 */
export async function readJsonFile(filePath: string): Promise<JsonObject | undefined> {
	try {
		const content = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (!isJsonObject(parsed)) {
			throw new Error(`Expected JSON object in ${filePath}`);
		}
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/**
 * Reads a UTF-8 file from disk, returning `null` when the file is absent.
 *
 * @param filePath Absolute or repo-relative file path to read.
 * @returns The file contents, or `null` when the file does not exist.
 */
export async function readUtf8IfExists(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

/**
 * Executes a git command via the shared extension process runner and returns stdout on success.
 *
 * @param repoPath Repository root used as the command working directory.
 * @param args Git command arguments.
 * @returns Command stdout when the git command succeeds.
 */
export async function execGit(repoPath: string, args: string[]): Promise<string> {
	const result = await runCommandAsync("git", args, repoPath);
	if (result.exitCode === 0) {
		return result.stdout;
	}

	throw new Error(`git ${args.join(" ")} failed in ${repoPath}: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`}`);
}

/**
 * Executes a git command and returns `null` instead of throwing on failure.
 *
 * @param repoPath Repository root used as the command working directory.
 * @param args Git command arguments.
 * @returns Command stdout on success, or `null` when the git command fails.
 */
export async function tryExecGit(repoPath: string, args: string[]): Promise<string | null> {
	try {
		return await execGit(repoPath, args);
	} catch {
		return null;
	}
}

/**
 * Reads a text blob from git object storage at the given revision and path.
 *
 * @param repoPath Repository root used as the git working directory.
 * @param revision Git revision containing the target file.
 * @param filePath Path within the revision to read.
 * @returns File contents, or `null` when the file cannot be read.
 */
export async function readGitText(repoPath: string, revision: string, filePath: string): Promise<string | null> {
	return tryExecGit(repoPath, ["show", `${revision}:${filePath}`]);
}

/**
 * Lists all file paths in a git tree revision.
 *
 * @param repoPath Repository root used as the git working directory.
 * @param revision Git revision to inspect.
 * @returns File paths contained in the revision.
 */
export async function listGitTreePaths(repoPath: string, revision: string, treePath?: string): Promise<string[]> {
	const args = treePath
		? ["ls-tree", "-r", "--name-only", revision, "--", treePath]
		: ["ls-tree", "-r", "--name-only", revision];
	const output = await tryExecGit(repoPath, args);
	if (!output) {
		return [];
	}

	return output
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Resolves the repository's git common directory, accounting for worktrees.
 *
 * @param repoPath Repository root used as the git working directory.
 * @returns Absolute path to the git common dir, or `null` when unavailable.
 */
export async function getGitCommonDir(repoPath: string): Promise<string | null> {
	const output = await tryExecGit(repoPath, ["rev-parse", "--git-common-dir"]);
	if (!output) {
		return null;
	}

	const commonDir = output.trim();
	if (!commonDir) {
		return null;
	}

	return path.resolve(repoPath, commonDir);
}

/**
 * Returns the currently checked out branch name, or `null` when detached or unavailable.
 *
 * @param repoPath Repository root used as the git working directory.
 * @returns The current branch name, or `null`.
 */
export async function getCurrentBranchName(repoPath: string): Promise<string | null> {
	const output = await tryExecGit(repoPath, ["branch", "--show-current"]);
	const branchName = output?.trim() ?? "";
	return branchName.length > 0 ? branchName : null;
}

/**
 * Returns the current `HEAD` commit SHA, or `null` when unavailable.
 *
 * @param repoPath Repository root used as the git working directory.
 * @returns The current `HEAD` SHA, or `null`.
 */
export async function getHeadSha(repoPath: string): Promise<string | null> {
	const output = await tryExecGit(repoPath, ["rev-parse", "HEAD"]);
	const sha = output?.trim() ?? "";
	return sha.length > 0 ? sha : null;
}

/**
 * Checks whether one commit is an ancestor of another within the repository.
 *
 * @param repoPath Repository root used as the git working directory.
 * @param possibleAncestor Commit expected to be an ancestor.
 * @param descendant Commit or ref that may descend from `possibleAncestor`.
 * @returns `true` when `possibleAncestor` is reachable from `descendant`.
 */
export async function isAncestor(repoPath: string, possibleAncestor: string, descendant = "HEAD"): Promise<boolean> {
	const result = await runCommandAsync("git", ["merge-base", "--is-ancestor", possibleAncestor, descendant], repoPath);
	return result.exitCode === 0;
}

/**
 * Deduplicates and sorts a string array.
 *
 * @param values Input strings to normalize.
 * @returns Deduplicated strings in ascending lexical order.
 */
export function sortUnique(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Returns a shortened SHA prefix for display purposes.
 *
 * @param value Full SHA or other identifier to shorten.
 * @param length Desired output length. Defaults to `7`.
 * @returns The shortened string, or `undefined` when the input is absent.
 */
export function shortSha(value: string | undefined, length = 7): string | undefined {
	if (!value) {
		return undefined;
	}

	return value.slice(0, Math.min(length, value.length));
}

/**
 * Parses an ISO-like timestamp into epoch milliseconds, returning `undefined` on failure.
 *
 * @param value Timestamp string to parse.
 * @returns Epoch milliseconds, or `undefined` when parsing fails.
 */
export function parseTimestamp(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Compares optional timestamps in descending order for stable card sorting.
 *
 * @param left Left timestamp string.
 * @param right Right timestamp string.
 * @returns Negative when `right` is newer, positive when `left` is newer, or `0`.
 */
export function compareOptionalTimestampsDesc(left?: string, right?: string): number {
	return (parseTimestamp(right) ?? 0) - (parseTimestamp(left) ?? 0);
}

/**
 * Formats a date-only checkpoint group key (`YYYY-MM-DD`) for display.
 *
 * @param dayKey Date bucket key used to group checkpoint commits.
 * @returns A stable English label such as `Thursday 2 Apr`, or the original value on parse failure.
 */
export function formatCheckpointGroupDate(dayKey: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
	if (!match) {
		return dayKey;
	}

	const [, yearText, monthText, dayText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const date = new Date(Date.UTC(year, month - 1, day, 12));
	const parts = new Intl.DateTimeFormat("en", {
		weekday: "long",
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	}).formatToParts(date);

	const weekday = parts.find((part) => part.type === "weekday")?.value;
	const dayNumber = parts.find((part) => part.type === "day")?.value;
	const monthName = parts.find((part) => part.type === "month")?.value;

	if (!weekday || !dayNumber || !monthName) {
		return dayKey;
	}

	return `${weekday} ${dayNumber} ${monthName}`;
}

/**
 * Totals primary and nested subagent token usage into a single count.
 *
 * @param tokenUsage Token usage object to total.
 * @returns Total token count, or `undefined` when no token usage is present.
 */
export function totalTokenUsage(tokenUsage: TokenUsage | undefined): number | undefined {
	if (!tokenUsage) {
		return undefined;
	}

	const subtotal = tokenUsage.inputTokens
		+ tokenUsage.cacheCreationTokens
		+ tokenUsage.cacheReadTokens
		+ tokenUsage.outputTokens;
	const subagentTotal = totalTokenUsage(tokenUsage.subagentTokens);

	return subtotal + (subagentTotal ?? 0);
}

/**
 * Parses a raw checkpoint `metadata.json` object into the normalized summary record.
 *
 * @param raw Raw JSON object read from committed checkpoint summary metadata.
 * @returns Normalized checkpoint summary record.
 */
export function parseCheckpointSummary(raw: JsonObject): CheckpointSummaryRecord {
	return {
		checkpointId: asString(raw.checkpoint_id, ""),
		strategy: asString(raw.strategy, ""),
		branch: asString(raw.branch),
		checkpointsCount: asNumber(raw.checkpoints_count, 0),
		filesTouched: asStringArray(raw.files_touched),
		sessions: asSessionFilePathsArray(raw.sessions),
		tokenUsage: parseTokenUsage(raw.token_usage),
		cliVersion: asString(raw.cli_version),
		raw,
	};
}

/**
 * Parses raw committed session metadata into the normalized session metadata record.
 *
 * @param raw Raw JSON object read from committed session metadata.
 * @returns Normalized committed session metadata.
 */
export function parseCommittedMetadata(raw: JsonObject): CommittedMetadataRecord {
	return {
		checkpointId: asString(raw.checkpoint_id, ""),
		sessionId: asString(raw.session_id, ""),
		strategy: asString(raw.strategy, ""),
		createdAt: asString(raw.created_at),
		branch: asString(raw.branch),
		checkpointsCount: asNumber(raw.checkpoints_count, 0),
		filesTouched: asStringArray(raw.files_touched),
		agent: asString(raw.agent),
		model: asString(raw.model),
		turnId: asString(raw.turn_id),
		isTask: asBoolean(raw.is_task, false),
		toolUseId: asString(raw.tool_use_id),
		transcriptIdentifierAtStart: asString(raw.transcript_identifier_at_start),
		checkpointTranscriptStart:
			asNumber(raw.checkpoint_transcript_start) ?? asNumber(raw.transcript_lines_at_start),
		tokenUsage: parseTokenUsage(raw.token_usage),
		sessionMetrics: parseSessionMetrics(raw.session_metrics),
		summary: parseSummary(raw.summary),
		initialAttribution: parseInitialAttribution(raw.initial_attribution),
		raw,
	};
}

/**
 * Parses a token-usage JSON object into the recursive token usage model.
 *
 * @param value Raw JSON token-usage object.
 * @returns Normalized token usage, or `undefined` when the value is not an object.
 */
export function parseTokenUsage(value: JsonValue | undefined): TokenUsage | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}

	return {
		inputTokens: asNumber(value.input_tokens, 0),
		cacheCreationTokens: asNumber(value.cache_creation_tokens, 0),
		cacheReadTokens: asNumber(value.cache_read_tokens, 0),
		outputTokens: asNumber(value.output_tokens, 0),
		apiCallCount: asNumber(value.api_call_count, 0),
		subagentTokens: parseTokenUsage(value.subagent_tokens),
	};
}

/**
 * Parses committed session metrics from raw JSON metadata.
 *
 * @param value Raw JSON session-metrics object.
 * @returns Normalized session metrics, or `undefined` when absent.
 */
export function parseSessionMetrics(value: JsonValue | undefined): SessionMetrics | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}

	return {
		durationMs: asNumber(value.duration_ms),
		turnCount: asNumber(value.turn_count),
		contextTokens: asNumber(value.context_tokens),
		contextWindowSize: asNumber(value.context_window_size),
	};
}

/**
 * Parses optional checkpoint summary metadata from raw committed JSON.
 *
 * @param value Raw JSON summary object.
 * @returns Normalized summary metadata, or `undefined` when absent.
 */
export function parseSummary(value: JsonValue | undefined): SummaryRecord | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}

	return {
		intent: asString(value.intent, ""),
		outcome: asString(value.outcome, ""),
		learnings: parseLearnings(value.learnings),
		friction: asStringArray(value.friction),
		openItems: asStringArray(value.open_items),
	};
}

function parseLearnings(value: JsonValue | undefined): LearningsSummary {
	if (!isJsonObject(value)) {
		return { repo: [], code: [], workflow: [] };
	}

	return {
		repo: asStringArray(value.repo),
		code: parseCodeLearnings(value.code),
		workflow: asStringArray(value.workflow),
	};
}

function parseCodeLearnings(value: JsonValue | undefined): CodeLearning[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((entry): entry is JsonObject => isJsonObject(entry))
		.map((entry) => ({
			path: asString(entry.path, ""),
			line: asNumber(entry.line),
			endLine: asNumber(entry.end_line),
			finding: asString(entry.finding, ""),
		}))
		.filter((entry) => entry.path.length > 0 && entry.finding.length > 0);
}

function parseInitialAttribution(value: JsonValue | undefined): InitialAttribution | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}

	return {
		calculatedAt: asString(value.calculated_at),
		agentLines: asNumber(value.agent_lines, 0),
		humanAdded: asNumber(value.human_added, 0),
		humanModified: asNumber(value.human_modified, 0),
		humanRemoved: asNumber(value.human_removed, 0),
		totalCommitted: asNumber(value.total_committed, 0),
		agentPercentage: asNumber(value.agent_percentage, 0),
	};
}

function asSessionFilePathsArray(value: JsonValue | undefined): SessionFilePaths[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((entry): entry is JsonObject => isJsonObject(entry))
		.map((entry) => ({
			metadata: asString(entry.metadata, ""),
			transcript: asString(entry.transcript, ""),
			context: asString(entry.context),
			contentHash: asString(entry.content_hash, ""),
			prompt: asString(entry.prompt, ""),
		}));
}

/**
 * Reads a string value from raw JSON, with an optional fallback when the value is absent or not a string.
 *
 * @param value Raw JSON value to inspect.
 * @returns The string value, or `undefined` when no string is present.
 */
function asString(value: JsonValue | undefined): string | undefined;
/**
 * Reads a string value from raw JSON, with an optional fallback when the value is absent or not a string.
 *
 * @param value Raw JSON value to inspect.
 * @param defaultValue Fallback value returned when the raw JSON value is not a string.
 * @returns The string value, or the provided fallback.
 */
function asString(value: JsonValue | undefined, defaultValue: string): string;
function asString(value: JsonValue | undefined, defaultValue?: string): string | undefined {
	return typeof value === "string" ? value : defaultValue;
}

/**
 * Reads a numeric value from raw JSON, with an optional fallback when the value is absent or not numeric.
 *
 * @param value Raw JSON value to inspect.
 * @returns The numeric value, or `undefined` when no number is present.
 */
function asNumber(value: JsonValue | undefined): number | undefined;
/**
 * Reads a numeric value from raw JSON, with an optional fallback when the value is absent or not numeric.
 *
 * @param value Raw JSON value to inspect.
 * @param defaultValue Fallback value returned when the raw JSON value is not numeric.
 * @returns The numeric value, or the provided fallback.
 */
function asNumber(value: JsonValue | undefined, defaultValue: number): number;
function asNumber(value: JsonValue | undefined, defaultValue?: number): number | undefined {
	return typeof value === "number" ? value : defaultValue;
}

/**
 * Reads a boolean value from raw JSON, with an optional fallback when the value is absent or not boolean.
 *
 * @param value Raw JSON value to inspect.
 * @returns The boolean value, or `undefined` when no boolean is present.
 */
function asBoolean(value: JsonValue | undefined): boolean | undefined;
/**
 * Reads a boolean value from raw JSON, with an optional fallback when the value is absent or not boolean.
 *
 * @param value Raw JSON value to inspect.
 * @param defaultValue Fallback value returned when the raw JSON value is not boolean.
 * @returns The boolean value, or the provided fallback.
 */
function asBoolean(value: JsonValue | undefined, defaultValue: boolean): boolean;
function asBoolean(value: JsonValue | undefined, defaultValue?: boolean): boolean | undefined {
	return typeof value === "boolean" ? value : defaultValue;
}

function asStringArray(value: JsonValue | undefined): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((entry): entry is string => typeof entry === "string");
}
