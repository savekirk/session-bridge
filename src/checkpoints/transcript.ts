import { collapseWhitespace, isJsonObject } from "./util";
import type { TranscriptEvent } from "./types";

const PRIMARY_TRANSCRIPT_FILE_NAME = "full.jsonl";
const LEGACY_TRANSCRIPT_FILE_NAME = "full.log";

interface TranscriptStorageReader {
	listEntryNames(): Promise<string[]>;
	readEntryText(entryName: string): Promise<string | null>;
}

/**
 * Loads stored transcript content from a checkpoint session directory.
 * Supports chunked `full.jsonl(.NNN)` transcripts and the legacy `full.log` filename.
 *
 * @param reader Reader capable of listing session files and loading text entries.
 * @returns Reassembled transcript text, or `null` when no supported transcript exists.
 */
export async function loadStoredTranscript(reader: TranscriptStorageReader): Promise<string | null> {
	const entryNames = [...new Set(await reader.listEntryNames())];
	const chunkNames = sortTranscriptChunkNames(entryNames.filter((entryName) => getTranscriptChunkIndex(entryName) !== undefined));

	if (chunkNames.length > 0) {
		const orderedNames = entryNames.includes(PRIMARY_TRANSCRIPT_FILE_NAME)
			? [PRIMARY_TRANSCRIPT_FILE_NAME, ...chunkNames]
			: chunkNames;
		const chunks: string[] = [];

		for (const entryName of orderedNames) {
			const content = await reader.readEntryText(entryName);
			if (content !== null) {
				chunks.push(content);
			}
		}

		if (chunks.length > 0) {
			return chunks.join("");
		}
	}

	const transcript = await reader.readEntryText(PRIMARY_TRANSCRIPT_FILE_NAME);
	if (transcript !== null) {
		return transcript;
	}

	return reader.readEntryText(LEGACY_TRANSCRIPT_FILE_NAME);
}

/**
 * Parses JSONL or single-line JSON transcript content into normalized transcript events.
 *
 * @param content Raw transcript content from `full.jsonl` or similar sources.
 * @returns Parsed transcript events in source order.
 */
export function parseTranscript(content: string): TranscriptEvent[] {
	const trimmed = content.trim();
	if (trimmed.length === 0) {
		return [];
	}

	const nonEmptyLines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (nonEmptyLines.length === 1) {
		const parsedSingle = parseJsonMaybe(nonEmptyLines[0]);
		if (parsedSingle !== undefined) {
			return [toTranscriptEvent(0, parsedSingle, nonEmptyLines[0])];
		}
	}

	return nonEmptyLines.map((line, index) => {
		const parsed = parseJsonMaybe(line);
		return toTranscriptEvent(index, parsed ?? line, line);
	});
}

/**
 * Extracts the first best-effort user prompt from a transcript for card and detail previews.
 *
 * @param content Raw transcript content, or `null` when unavailable.
 * @returns The first extracted user prompt, or `undefined` when none can be inferred.
 */
export function extractTranscriptPrompt(content: string | null): string | undefined {
	if (!content) {
		return undefined;
	}

	const events = parseTranscript(content);
	for (const event of events) {
		const extracted = extractPromptText(event.raw, event.eventType);
		if (extracted) {
			return collapseWhitespace(extracted);
		}
	}

	return undefined;
}

/**
 * Counts likely tool-use events in a transcript using best-effort structural heuristics.
 *
 * @param content Raw transcript content, or `null` when unavailable.
 * @returns The inferred tool-use count, or `undefined` when no transcript is available.
 */
export function countTranscriptToolUses(content: string | null): number | undefined {
	if (!content) {
		return undefined;
	}

	const events = parseTranscript(content);
	if (events.length === 0) {
		return undefined;
	}

	const total = events.reduce((sum, event) => sum + countPossibleToolUses(event.raw), 0);
	return total > 0 ? total : undefined;
}

function parseJsonMaybe(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function sortTranscriptChunkNames(entryNames: string[]): string[] {
	return [...entryNames].sort((left, right) => {
		const leftIndex = getTranscriptChunkIndex(left) ?? Number.MAX_SAFE_INTEGER;
		const rightIndex = getTranscriptChunkIndex(right) ?? Number.MAX_SAFE_INTEGER;
		if (leftIndex !== rightIndex) {
			return leftIndex - rightIndex;
		}

		return left.localeCompare(right);
	});
}

function getTranscriptChunkIndex(entryName: string): number | undefined {
	const match = entryName.match(/^full\.jsonl\.(\d+)$/);
	if (!match) {
		return undefined;
	}

	const parsed = Number(match[1]);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function toTranscriptEvent(index: number, value: unknown, rawText: string): TranscriptEvent {
	if (isJsonObject(value)) {
		return {
			index,
			eventType: readFirstString(value, ["type", "event_type", "eventType", "kind"]),
			timestamp: readFirstString(value, ["timestamp", "ts", "created_at"]),
			raw: value,
			rawText,
		};
	}

	return {
		index,
		raw: value,
		rawText,
	};
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") {
			return value;
		}
	}

	return undefined;
}

function extractPromptText(value: unknown, eventTypeHint?: string): string | undefined {
	if (typeof value === "string" && isUserEventType(eventTypeHint)) {
		return value;
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			const extracted = extractPromptText(entry, eventTypeHint);
			if (extracted) {
				return extracted;
			}
		}
		return undefined;
	}

	if (!isJsonObject(value)) {
		return undefined;
	}

	const recordType = normalizeString(readString(value, "type") ?? readString(value, "kind") ?? eventTypeHint);
	const role = normalizeString(readString(value.info, "role") ?? readString(value, "role")) ?? recordType;

	if (recordType === "queue-operation") {
		const queuedPrompt = readFirstString(value, ["content", "message", "prompt", "text", "input"]);
		if (queuedPrompt) {
			return queuedPrompt;
		}
	}

	if (role === "user") {
		const direct = readFirstString(value, ["content", "message", "prompt", "text", "input"]);
		if (direct) {
			return direct;
		}

		for (const key of ["content", "parts", "items"]) {
			const extracted = extractPromptTextParts(value[key], "user");
			if (extracted) {
				return extracted;
			}
		}
	}

	const direct = isUserEventType(eventTypeHint) ? readFirstString(value, ["content", "message", "prompt", "text", "input"]) : undefined;
	if (direct) {
		return direct;
	}

	if (value.message !== undefined) {
		const extracted = extractPromptText(value.message, role ?? eventTypeHint);
		if (extracted) {
			return extracted;
		}
	}

	for (const key of ["messages", "events", "items", "parts", "content", "data"]) {
		const nested = value[key];
		if (nested !== undefined) {
			const extracted = extractPromptTextParts(nested, role ?? eventTypeHint);
			if (extracted) {
				return extracted;
			}
		}
	}

	for (const nested of Object.values(value)) {
		const extracted = extractPromptText(nested, role ?? eventTypeHint);
		if (extracted) {
			return extracted;
		}
	}

	return undefined;
}

function countPossibleToolUses(value: unknown): number {
	if (Array.isArray(value)) {
		return value.reduce((sum, entry) => sum + countPossibleToolUses(entry), 0);
	}

	if (!isJsonObject(value)) {
		return 0;
	}

	let count = 0;
	const typeValue = normalizeString(readString(value, "type") ?? readString(value, "kind"));
	if (typeValue === "tool_result") {
		return 0;
	}

	if (typeValue === "tool_use" || typeValue === "tool_call") {
		count += 1;
	}

	if (Array.isArray(value.tool_calls)) {
		count += value.tool_calls.filter((toolCall) => isToolCallRecord(toolCall)).length;
	}

	if (isToolCallRecord(value.tool_call)) {
		count += 1;
	}

	if (count === 0 && isToolCallRecord(value)) {
		count += 1;
	}

	for (const key of ["message", "content", "parts", "items", "messages", "events", "data"]) {
		const nested = value[key];
		if (nested !== undefined) {
			count += countPossibleToolUses(nested);
		}
	}

	return count;
}

function isUserEventType(value: string | undefined): boolean {
	if (!value) {
		return false;
	}

	return ["user", "human", "prompt", "input"].includes(value.toLowerCase());
}

function readString(value: unknown, key: string): string | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}

	const rawValue = value[key];
	return typeof rawValue === "string" ? rawValue : undefined;
}

function extractPromptTextParts(value: unknown, eventTypeHint?: string): string | undefined {
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (typeof entry === "string" && isUserEventType(eventTypeHint)) {
				return entry;
			}

			if (!isJsonObject(entry)) {
				continue;
			}

			const entryType = normalizeString(readString(entry, "type") ?? readString(entry, "kind"));
			if (entryType === "tool_result") {
				continue;
			}

			if ((entryType === "text" || entryType === "input_text") && typeof entry.text === "string") {
				return entry.text;
			}

			const extracted = extractPromptText(entry, eventTypeHint);
			if (extracted) {
				return extracted;
			}
		}

		return undefined;
	}

	return extractPromptText(value, eventTypeHint);
}

function isToolCallRecord(value: unknown): boolean {
	if (!isJsonObject(value)) {
		return false;
	}

	const typeValue = normalizeString(readString(value, "type") ?? readString(value, "kind"));
	if (typeValue === "tool_result") {
		return false;
	}

	if (typeValue === "tool_use" || typeValue === "tool_call") {
		return true;
	}

	if (typeof value.name === "string") {
		return true;
	}

	if (isJsonObject(value.function) && typeof value.function.name === "string") {
		return true;
	}

	return false;
}

function normalizeString(value: string | undefined): string | undefined {
	return value?.toLowerCase();
}
