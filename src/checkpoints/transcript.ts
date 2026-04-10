import {
	countNativeTranscriptToolUses,
	extractNativeTranscriptFirstTimestamp,
	extractNativeTranscriptLatestTimestamp,
	extractNativeTranscriptPrompt,
	parseNativeTranscriptEvents,
} from "./nativeTranscript";
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
	return parseNativeTranscriptEvents(content);
}

/**
 * Extracts the first best-effort user prompt from a transcript for card and detail previews.
 *
 * @param content Raw transcript content, or `null` when unavailable.
 * @returns The first extracted user prompt, or `undefined` when none can be inferred.
 */
export function extractTranscriptPrompt(content: string | null): string | undefined {
	return extractNativeTranscriptPrompt(content);
}

/**
 * Counts likely tool-use events in a transcript using best-effort structural heuristics.
 *
 * @param content Raw transcript content, or `null` when unavailable.
 * @returns The inferred tool-use count, or `undefined` when no transcript is available.
 */
export function countTranscriptToolUses(content: string | null): number | undefined {
	return countNativeTranscriptToolUses(content);
}

/**
 * Extracts the earliest top-level event timestamp from transcript JSONL content without
 * parsing the entire transcript into normalized events.
 *
 * @param content Raw transcript content, or `null` when unavailable.
 * @returns The earliest timestamp string found near the start of the transcript.
 */
export function extractTranscriptFirstTimestamp(content: string | null): string | undefined {
	return extractNativeTranscriptFirstTimestamp(content);
}

/**
 * Extracts the latest top-level event timestamp from transcript JSONL content without
 * parsing the entire transcript into normalized events.
 *
 * @param content Raw transcript content, or `null` when unavailable.
 * @returns The latest timestamp string found near the end of the transcript.
 */
export function extractTranscriptLatestTimestamp(content: string | null): string | undefined {
	return extractNativeTranscriptLatestTimestamp(content);
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
