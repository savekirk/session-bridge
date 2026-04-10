import type { SessionDetailAuxiliaryBlock, SessionDetailToolActivity, SessionDetailTurn } from "./models";
import type { JsonObject, JsonValue, TranscriptEvent } from "./types";
import { collapseWhitespace, isJsonObject } from "./util";

export type NativeTranscriptParserId =
	| "claude_code"
	| "codex"
	| "gemini"
	| "copilot_cli"
	| "opencode"
	| "factory"
	| "cursor"
	| "generic_json"
	| "generic_jsonl";

export interface ParseNativeSessionTranscriptOptions {
	agentHint?: string;
	sessionIdHint?: string;
	userHint?: string;
}

export interface ParsedNativeTranscriptMessage {
	id: string;
	idx: number;
	role: string;
	author?: string;
	createdAt?: string;
	content?: string;
	toolActivities: SessionDetailToolActivity[];
	raw: JsonValue | string;
}

export interface ParsedNativeTranscript {
	parserId: NativeTranscriptParserId;
	agentSlug: string;
	sessionId?: string;
	title?: string;
	promptPreview?: string;
	workspace?: string;
	startedAt?: string;
	endedAt?: string;
	model?: string;
	toolCount: number;
	metadata: JsonObject;
	messages: ParsedNativeTranscriptMessage[];
	turns: SessionDetailTurn[];
}

interface ParsedJsonlRecord {
	index: number;
	raw: JsonValue | string;
	rawText: string;
}

interface TranscriptBuildState {
	sessionId?: string;
	title?: string;
	workspace?: string;
	startedAt?: string;
	endedAt?: string;
	model?: string;
	metadata: JsonObject;
	messages: ParsedNativeTranscriptMessage[];
}

type TranscriptParser = (input: string, options: ParseNativeSessionTranscriptOptions) => ParsedNativeTranscript | null;

const AGENT_DISPLAY_NAMES: Record<string, string> = {
	claude_code: "Claude Code",
	codex: "Codex",
	gemini: "Gemini",
	copilot_cli: "Copilot CLI",
	opencode: "OpenCode",
	factory: "Factory",
	cursor: "Cursor",
};

/**
 * Parses transcript content into a normalized transcript model.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when the content is empty or no messages can be produced.
 */
export function parseNativeSessionTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions = {},
): ParsedNativeTranscript | null {
	if (content.trim().length === 0) {
		return null;
	}

	const hintedParser = parserForAgentHint(options.agentHint);
	if (hintedParser) {
		const parsed = hintedParser(content, options);
		if (parsed) {
			return parsed;
		}
	}

	const parser = detectNativeSessionTranscriptParser(content, options);
	return parser(content, options);
}

/**
 * Parses transcript content into low-level transcript events without applying agent-specific normalization.
 *
 * @param content Transcript text to parse.
 * @returns Parsed transcript events in source order.
 */
export function parseNativeTranscriptEvents(content: string): TranscriptEvent[] {
	const trimmed = content.trim();
	if (trimmed.length === 0) {
		return [];
	}

	const records = parseJsonlRecords(content);
	if (records.length === 1) {
		return [toTranscriptEvent(records[0].index, records[0].raw, records[0].rawText)];
	}

	return records.map((record) => toTranscriptEvent(record.index, record.raw, record.rawText));
}

/**
 * Extracts the first user-authored preview string from transcript content.
 *
 * @param content Transcript text, or `null` when unavailable.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The extracted preview string, or `undefined` when none can be derived.
 */
export function extractNativeTranscriptPrompt(
	content: string | null,
	options: ParseNativeSessionTranscriptOptions = {},
): string | undefined {
	if (!content) {
		return undefined;
	}

	return parseNativeSessionTranscript(content, options)?.promptPreview;
}

/**
 * Counts normalized tool activities present in transcript content.
 *
 * @param content Transcript text, or `null` when unavailable.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The tool-use count, or `undefined` when none can be derived.
 */
export function countNativeTranscriptToolUses(
	content: string | null,
	options: ParseNativeSessionTranscriptOptions = {},
): number | undefined {
	if (!content) {
		return undefined;
	}

	const total = parseNativeSessionTranscript(content, options)?.toolCount;
	return typeof total === "number" && total > 0 ? total : undefined;
}

/**
 * Returns the earliest normalized timestamp found in transcript content.
 *
 * @param content Transcript text, or `null` when unavailable.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The earliest timestamp, or `undefined` when none can be derived.
 */
export function extractNativeTranscriptFirstTimestamp(
	content: string | null,
	options: ParseNativeSessionTranscriptOptions = {},
): string | undefined {
	if (!content) {
		return undefined;
	}

	return parseNativeSessionTranscript(content, options)?.startedAt;
}

/**
 * Returns the latest normalized timestamp found in transcript content.
 *
 * @param content Transcript text, or `null` when unavailable.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The latest timestamp, or `undefined` when none can be derived.
 */
export function extractNativeTranscriptLatestTimestamp(
	content: string | null,
	options: ParseNativeSessionTranscriptOptions = {},
): string | undefined {
	if (!content) {
		return undefined;
	}

	return parseNativeSessionTranscript(content, options)?.endedAt;
}

/**
 * Returns the parser that best matches the transcript's structure.
 *
 * @param content Transcript text to inspect.
 * @param options Optional parser hints that take precedence over content-based detection.
 * @returns The parser function that should be used for the supplied content.
 */
export function detectNativeSessionTranscriptParser(
	content: string,
	options: ParseNativeSessionTranscriptOptions = {},
): TranscriptParser {
	const hintedParser = parserForAgentHint(options.agentHint);
	if (hintedParser) {
		return hintedParser;
	}

	const document = parseJsonDocument(content);
	if (isJsonObject(document)) {
		if (looksLikeOpenCodeTranscript(document)) {
			return parseOpenCodeTranscript;
		}
		if (looksLikeGeminiTranscript(document)) {
			return parseGeminiTranscript;
		}
		if (looksLikeClaudeTranscriptDocument(document)) {
			return parseClaudeTranscript;
		}
		if (looksLikeCopilotTranscriptDocument(document)) {
			return parseCopilotCliTranscript;
		}
		return parseGenericJsonTranscript;
	}

	const records = parseJsonlRecords(content);
	if (looksLikeCodexTranscript(records)) {
		return parseCodexTranscript;
	}
	if (looksLikeCopilotCliTranscript(records)) {
		return parseCopilotCliTranscript;
	}
	if (looksLikeFactoryTranscript(records)) {
		return parseFactoryTranscript;
	}
	if (looksLikeCursorTranscript(records)) {
		return parseCursorTranscript;
	}
	if (looksLikeClaudeTranscriptJsonl(records)) {
		return parseClaudeTranscript;
	}
	return parseGenericJsonlTranscript;
}

/**
 * Maps an agent hint to a concrete parser implementation.
 *
 * @param agentHint Optional agent identifier or alias.
 * @returns The matching parser, or `undefined` when the hint is unknown.
 */
function parserForAgentHint(agentHint: string | undefined): TranscriptParser | undefined {
	switch (canonicalizeAgentHint(agentHint)) {
		case "claude_code":
			return parseClaudeTranscript;
		case "codex":
			return parseCodexTranscript;
		case "gemini":
			return parseGeminiTranscript;
		case "copilot_cli":
			return parseCopilotCliTranscript;
		case "opencode":
			return parseOpenCodeTranscript;
		case "factory":
			return parseFactoryTranscript;
		case "cursor":
			return parseCursorTranscript;
		default:
			return undefined;
	}
}

/**
 * Normalizes agent aliases into the internal parser identifiers used by this module.
 *
 * @param value Raw agent identifier or alias.
 * @returns The canonical parser identifier, or the normalized input when no alias mapping exists.
 */
function canonicalizeAgentHint(value: string | undefined): string | undefined {
	const normalized = value?.trim().toLowerCase();
	switch (normalized) {
		case "claude":
		case "claudecode":
		case "claude_code":
			return "claude_code";
		case "codex":
		case "codexcli":
		case "codex_cli":
			return "codex";
		case "gemini":
		case "geminicli":
		case "gemini_cli":
			return "gemini";
		case "copilotcli":
		case "copilot_cli":
		case "gh-copilot":
			return "copilot_cli";
		case "opencode":
			return "opencode";
		case "factory":
		case "factoryaidroid":
		case "factory_ai_droid":
		case "droid":
			return "factory";
		case "cursor":
			return "cursor";
		default:
			return normalized;
	}
}

/**
 * Parses transcripts that follow the Claude-style message envelope.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when the content does not match this layout.
 */
function parseClaudeTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const document = parseJsonDocument(content);
	if (isJsonObject(document) && Array.isArray(document.messages)) {
		const state = createBuildState();
		state.sessionId = readString(document.sessionId) ?? options.sessionIdHint;
		state.title = readString(document.title);

		for (const entry of document.messages) {
			if (!isJsonObject(entry)) {
				continue;
			}

			const role = normalizeMessageRole(readString(entry.role) ?? readString(entry.type));
			if (!role) {
				continue;
			}

			const contentValue = entry.content ?? entry.text;
			const message = buildMessage({
				id: readString(entry.uuid) ?? readString(entry.id),
				idx: state.messages.length,
				role,
				author: undefined,
				createdAt: normalizeTimestamp(entry.timestamp ?? entry.time),
				content: extractContentText(contentValue),
				toolActivities: extractContentToolActivities(contentValue),
				raw: entry,
			});
			if (!message) {
				continue;
			}

			pushMessage(state, message);
		}

		return finalizeTranscript({
			parserId: "claude_code",
			agentSlug: "claude_code",
			state,
			fallbackSessionId: options.sessionIdHint,
			userHint: options.userHint,
		});
	}

	const records = parseJsonlRecords(content);
	if (records.length === 0) {
		return null;
	}

	const state = createBuildState();
	for (const record of records) {
		if (!isJsonObject(record.raw)) {
			continue;
		}

		const root = record.raw;
		const message = asJsonObject(root.message);
		const role = normalizeMessageRole(
			readString(message?.role)
			?? readString(root.type)
			?? readString(root.role),
		);
		if (!role) {
			continue;
		}

		const contentValue = message?.content ?? root.content ?? root.text;
		const built = buildMessage({
			id: readString(root.uuid) ?? readString(root.id) ?? `turn-${record.index}`,
			idx: state.messages.length,
			role,
			author: readString(message?.model),
			createdAt: normalizeTimestamp(root.timestamp ?? root.ts ?? root.created_at),
			content: extractContentText(contentValue),
			toolActivities: extractContentToolActivities(contentValue),
			raw: root,
		});
		if (!built) {
			continue;
		}

		state.sessionId ??= readString(root.sessionId) ?? options.sessionIdHint;
		state.workspace ??= readString(root.cwd);
		state.model ??= readString(message?.model);
		if (typeof root.gitBranch === "string") {
			state.metadata.gitBranch = root.gitBranch;
		}

		pushMessage(state, built);
	}

	return finalizeTranscript({
		parserId: "claude_code",
		agentSlug: "claude_code",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Parses transcripts that use Codex response and event records.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when the content does not match this layout.
 */
function parseCodexTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const document = parseJsonDocument(content);
	if (isJsonObject(document) && Array.isArray(document.items)) {
		const state = createBuildState();
		state.sessionId = options.sessionIdHint;
		state.workspace = readString(asJsonObject(document.session)?.cwd);

		for (const entry of document.items) {
			if (!isJsonObject(entry)) {
				continue;
			}

			const role = normalizeMessageRole(readString(entry.role));
			const contentValue = entry.content;
			const built = buildMessage({
				id: readString(entry.id) ?? `turn-${state.messages.length}`,
				idx: state.messages.length,
				role: role ?? "assistant",
				author: undefined,
				createdAt: normalizeTimestamp(entry.timestamp),
				content: extractContentText(contentValue),
				toolActivities: extractContentToolActivities(contentValue),
				raw: entry,
			});
			if (!built) {
				continue;
			}

			pushMessage(state, built);
		}

		return finalizeTranscript({
			parserId: "codex",
			agentSlug: "codex",
			state,
			fallbackSessionId: options.sessionIdHint,
			userHint: options.userHint,
		});
	}

	const records = parseJsonlRecords(content);
	if (records.length === 0) {
		return null;
	}

	const state = createBuildState();
	for (const record of records) {
		if (!isJsonObject(record.raw)) {
			continue;
		}

		const root = record.raw;
		const eventType = readString(root.type);
		const payload = asJsonObject(root.payload);
		const createdAt = normalizeTimestamp(root.timestamp);

		switch (eventType) {
			case "session_meta":
				state.sessionId ??= readString(payload?.id) ?? options.sessionIdHint;
				state.workspace ??= readString(payload?.cwd);
				if (payload && typeof payload.cli_version === "string") {
					state.metadata.cliVersion = payload.cli_version;
				}
				mergeTimeBounds(state, createdAt);
				break;
			case "response_item": {
				if (!payload) {
					break;
				}

				const payloadType = readString(payload.type);
				if (payloadType === "message") {
					const built = buildMessage({
						id: readString(payload.id) ?? `turn-${state.messages.length}`,
						idx: state.messages.length,
						role: normalizeMessageRole(readString(payload.role)) ?? "assistant",
						author: undefined,
						createdAt,
						content: extractContentText(payload.content),
						toolActivities: extractContentToolActivities(payload.content),
						raw: root,
					});
					if (built) {
						pushMessage(state, built);
					}
					break;
				}

				if (payloadType === "function_call") {
					const built = buildMessage({
						id: readString(payload.call_id) ?? readString(payload.id) ?? `turn-${state.messages.length}`,
						idx: state.messages.length,
						role: "assistant",
						author: undefined,
						createdAt,
						content: undefined,
						toolActivities: [buildToolActivity(
							readString(payload.call_id) ?? readString(payload.id) ?? `tool-${state.messages.length}`,
							readString(payload.name) ?? "Tool",
							formatToolDetail(payload.arguments),
						)],
						raw: root,
					});
					if (built) {
						pushMessage(state, built);
					}
					break;
				}

				if (payloadType === "function_call_output") {
					const built = buildMessage({
						id: readString(payload.call_id) ?? readString(payload.id) ?? `turn-${state.messages.length}`,
						idx: state.messages.length,
						role: "assistant",
						author: undefined,
						createdAt,
						content: extractContentText(payload.output ?? payload.content ?? payload.text),
						toolActivities: [],
						raw: root,
					});
					if (built) {
						pushMessage(state, built);
					}
					break;
				}

				if (payloadType === "custom_tool_call") {
					const built = buildMessage({
						id: readString(payload.call_id) ?? readString(payload.id) ?? `turn-${state.messages.length}`,
						idx: state.messages.length,
						role: "assistant",
						author: undefined,
						createdAt,
						content: undefined,
						toolActivities: [buildToolActivity(
							readString(payload.call_id) ?? readString(payload.id) ?? `tool-${state.messages.length}`,
							readString(payload.name) ?? "Tool",
							formatToolDetail(payload.input),
						)],
						raw: root,
					});
					if (built) {
						pushMessage(state, built);
					}
					break;
				}

				if (payloadType === "custom_tool_call_output") {
					const built = buildMessage({
						id: readString(payload.call_id) ?? `turn-${state.messages.length}`,
						idx: state.messages.length,
						role: "assistant",
						author: undefined,
						createdAt,
						content: extractContentText(payload.output ?? payload.content ?? payload.text),
						toolActivities: [],
						raw: root,
					});
					if (built) {
						pushMessage(state, built);
					}
				}
				break;
			}
			case "event_msg": {
				if (!payload) {
					break;
				}

				const payloadType = readString(payload.type);
				if (payloadType === "user_message") {
					const content = readString(payload.message);
					if (content && hasTrailingDuplicateMessage(state.messages, "user", content)) {
						break;
					}

					const built = buildMessage({
						id: readString(payload.id) ?? `turn-${state.messages.length}`,
						idx: state.messages.length,
						role: "user",
						author: undefined,
						createdAt,
						content,
						toolActivities: [],
						raw: root,
					});
					if (built) {
						pushMessage(state, built);
					}
					break;
				}

				if (payloadType === "agent_reasoning") {
					const built = buildMessage({
						id: readString(payload.id) ?? `turn-${state.messages.length}`,
						idx: state.messages.length,
						role: "assistant",
						author: "reasoning",
						createdAt,
						content: readString(payload.text),
						toolActivities: [],
						raw: root,
					});
					if (built) {
						pushMessage(state, built);
					}
					break;
				}

				if (payloadType === "tool_call") {
					const built = buildMessage({
						id: readString(payload.call_id) ?? readString(payload.id) ?? `turn-${state.messages.length}`,
						idx: state.messages.length,
						role: "assistant",
						author: undefined,
						createdAt,
						content: undefined,
						toolActivities: [buildToolActivity(
							readString(payload.call_id) ?? readString(payload.id) ?? `tool-${state.messages.length}`,
							readString(payload.name) ?? "Tool",
							formatToolDetail(payload.input ?? payload.arguments),
						)],
						raw: root,
					});
					if (built) {
						pushMessage(state, built);
					}
				}
				break;
			}
			default:
				break;
		}
	}

	return finalizeTranscript({
		parserId: "codex",
		agentSlug: "codex",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Parses Gemini transcript documents into normalized messages and tool activity.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when the content does not match this layout.
 */
function parseGeminiTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const document = parseJsonDocument(content);
	if (!isJsonObject(document) || !Array.isArray(document.messages)) {
		return null;
	}

	const state = createBuildState();
	state.sessionId = readString(document.sessionId) ?? options.sessionIdHint;
	mergeTimeBounds(state, normalizeTimestamp(document.startTime));
	mergeTimeBounds(state, normalizeTimestamp(document.lastUpdated));

	for (const entry of document.messages) {
		if (!isJsonObject(entry)) {
			continue;
		}

		const role = normalizeGeminiRole(readString(entry.type));
		if (!role) {
			continue;
		}

		const toolActivities = extractGeminiToolActivities(entry.toolCalls);
		const built = buildMessage({
			id: readString(entry.id) ?? `turn-${state.messages.length}`,
			idx: state.messages.length,
			role,
			author: undefined,
			createdAt: normalizeTimestamp(entry.timestamp),
			content: extractGeminiContentText(entry.content),
			toolActivities,
			raw: entry,
		});
		if (!built) {
			continue;
		}

		state.model ??= readString(entry.model)
			?? readString(asJsonObject(entry.modelConfig)?.modelName)
			?? readString(entry.modelType)
			?? readString(entry.modelID);

		pushMessage(state, built);
	}

	state.workspace ??= extractWorkspaceFromTranscriptText(state.messages);

	return finalizeTranscript({
		parserId: "gemini",
		agentSlug: "gemini",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Parses Copilot event logs from either JSONL or document-style payloads.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when the content does not match this layout.
 */
function parseCopilotCliTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const document = parseJsonDocument(content);
	if (isJsonObject(document)) {
		return parseCopilotCliDocument(document, options);
	}

	const records = parseJsonlRecords(content);
	if (records.length === 0) {
		return null;
	}

	const state = createBuildState();
	for (const record of records) {
		if (!isJsonObject(record.raw)) {
			continue;
		}

		const root = record.raw;
		const eventType = readString(root.type) ?? "";
		const data = asJsonObject(root.data);
		const createdAt = normalizeTimestamp(root.timestamp ?? root.createdAt ?? root.created_at ?? root.ts);
		const sessionId = readString(root.session_id) ?? readString(root.sessionId);
		const workspace = readString(root.cwd) ?? readString(root.workingDirectory) ?? readString(root.workspace);

		state.sessionId ??= sessionId ?? options.sessionIdHint;
		state.workspace ??= workspace;

		if (eventType === "session.start") {
			const context = asJsonObject(asJsonObject(data?.context));
			state.sessionId ??= readString(data?.sessionId) ?? options.sessionIdHint;
			state.workspace ??= readString(context?.cwd) ?? state.workspace;
			if (typeof context?.branch === "string") {
				state.metadata.branch = context.branch;
			}
			if (typeof data?.copilotVersion === "string") {
				state.metadata.copilotVersion = data.copilotVersion;
			}
			mergeTimeBounds(state, createdAt);
			continue;
		}

		if (eventType === "session.model_change") {
			state.model = readString(data?.newModel) ?? state.model;
			continue;
		}

		if (eventType === "tool.execution_complete") {
			const detail = formatCopilotToolDetail(data);
			const built = buildMessage({
				id: readString(root.id) ?? `turn-${state.messages.length}`,
				idx: state.messages.length,
				role: "assistant",
				author: undefined,
				createdAt,
				content: undefined,
				toolActivities: [buildToolActivity(
					readString(data?.toolCallId) ?? readString(root.id) ?? `tool-${state.messages.length}`,
					"Tool execution",
					detail,
				)],
				raw: root,
			});
			if (built) {
				pushMessage(state, built);
			}
			state.model ??= readString(data?.model);
			continue;
		}

		const normalized = normalizeCopilotEventMessage(root);
		if (!normalized) {
			continue;
		}

		const built = buildMessage({
			id: readString(root.id) ?? `turn-${state.messages.length}`,
			idx: state.messages.length,
			role: normalized.role,
			author: normalized.role === "user" ? "user" : "copilot-cli",
			createdAt,
			content: normalized.content,
			toolActivities: [],
			raw: root,
		});
		if (built) {
			pushMessage(state, built);
		}
	}

	return finalizeTranscript({
		parserId: "copilot_cli",
		agentSlug: "copilot_cli",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Parses Copilot transcripts that already contain an event array in a single JSON document.
 *
 * @param document Parsed transcript document.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when the document does not expose any usable events.
 */
function parseCopilotCliDocument(
	document: JsonObject,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const events = extractCopilotDocumentEvents(document);
	if (events.length === 0) {
		return null;
	}

	const state = createBuildState();
	state.sessionId = readString(document.session_id) ?? readString(document.sessionId) ?? readString(document.id) ?? options.sessionIdHint;
	state.workspace = readString(document.cwd) ?? readString(document.workingDirectory) ?? readString(document.workspace);

	for (const event of events) {
		if (!isJsonObject(event)) {
			continue;
		}

		const eventType = readString(event.type) ?? "";
		const createdAt = normalizeTimestamp(event.timestamp ?? event.createdAt ?? event.created_at ?? event.ts);
		if (eventType === "session.start") {
			const data = asJsonObject(event.data);
			const context = asJsonObject(asJsonObject(data?.context));
			state.sessionId ??= readString(data?.sessionId) ?? options.sessionIdHint;
			state.workspace ??= readString(context?.cwd) ?? state.workspace;
			if (typeof context?.branch === "string") {
				state.metadata.branch = context.branch;
			}
			if (typeof data?.copilotVersion === "string") {
				state.metadata.copilotVersion = data.copilotVersion;
			}
			mergeTimeBounds(state, createdAt);
			continue;
		}
		if (eventType === "session.model_change") {
			state.model = readString(asJsonObject(event.data)?.newModel) ?? state.model;
			continue;
		}
		if (eventType === "tool.execution_complete") {
			const built = buildMessage({
				id: readString(event.id) ?? `turn-${state.messages.length}`,
				idx: state.messages.length,
				role: "assistant",
				author: undefined,
				createdAt,
				content: undefined,
				toolActivities: [buildToolActivity(
					readString(asJsonObject(event.data)?.toolCallId) ?? readString(event.id) ?? `tool-${state.messages.length}`,
					"Tool execution",
					formatCopilotToolDetail(asJsonObject(event.data)),
				)],
				raw: event,
			});
			if (built) {
				pushMessage(state, built);
			}
			state.model ??= readString(asJsonObject(event.data)?.model);
			continue;
		}

		const normalized = normalizeCopilotEventMessage(event);
		if (!normalized) {
			continue;
		}

		const built = buildMessage({
			id: readString(event.id) ?? `turn-${state.messages.length}`,
			idx: state.messages.length,
			role: normalized.role,
			author: normalized.role === "user" ? "user" : "copilot-cli",
			createdAt,
			content: normalized.content,
			toolActivities: [],
			raw: event,
		});
		if (built) {
			pushMessage(state, built);
		}
	}

	return finalizeTranscript({
		parserId: "copilot_cli",
		agentSlug: "copilot_cli",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Parses OpenCode export documents into normalized turns.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when the content does not match this layout.
 */
function parseOpenCodeTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const document = parseJsonDocument(content);
	if (!isJsonObject(document) || !looksLikeOpenCodeTranscript(document)) {
		return null;
	}

	const info = asJsonObject(document.info);
	const infoTime = asJsonObject(info?.time);
	const messages = Array.isArray(document.messages) ? document.messages : [];
	const state = createBuildState();
	state.sessionId = readString(info?.id) ?? options.sessionIdHint;
	state.title = readString(info?.title);
	state.workspace = readString(info?.directory);
	mergeTimeBounds(state, normalizeTimestamp(infoTime?.created ?? info?.createdAt));
	mergeTimeBounds(state, normalizeTimestamp(infoTime?.updated ?? info?.updatedAt));

	for (const entry of messages) {
		if (!isJsonObject(entry)) {
			continue;
		}

		const messageInfo = asJsonObject(entry.info);
		const role = normalizeMessageRole(readString(messageInfo?.role));
		if (!role) {
			continue;
		}

		const parts = Array.isArray(entry.parts) ? entry.parts : [];
		const built = buildMessage({
			id: readString(messageInfo?.id) ?? `turn-${state.messages.length}`,
			idx: state.messages.length,
			role,
			author: undefined,
			createdAt: normalizeTimestamp(asJsonObject(messageInfo?.time)?.created),
			content: extractOpenCodeText(parts, role),
			toolActivities: extractOpenCodeToolActivities(parts),
			raw: entry,
		});
		if (!built) {
			continue;
		}

		state.model ??= readString(messageInfo?.modelID);
		state.workspace ??= readString(asJsonObject(messageInfo?.path)?.cwd);
		pushMessage(state, built);
	}

	return finalizeTranscript({
		parserId: "opencode",
		agentSlug: "opencode",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Parses Factory-style session envelopes and message records.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when the content does not match this layout.
 */
function parseFactoryTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const records = parseJsonlRecords(content);
	if (records.length === 0) {
		return null;
	}

	const state = createBuildState();
	for (const record of records) {
		if (!isJsonObject(record.raw)) {
			continue;
		}

		const root = record.raw;
		const rootType = readString(root.type);
		if (rootType === "session_start") {
			state.sessionId ??= readString(root.id) ?? options.sessionIdHint;
			state.title ??= readString(root.title);
			state.workspace ??= readString(root.cwd);
			if (typeof root.owner === "string") {
				state.metadata.owner = root.owner;
			}
			continue;
		}

		if (rootType !== "message") {
			continue;
		}

		const message = asJsonObject(root.message);
		const role = normalizeMessageRole(readString(message?.role));
		if (!role) {
			continue;
		}

		const built = buildMessage({
			id: readString(root.id) ?? `turn-${state.messages.length}`,
			idx: state.messages.length,
			role,
			author: readString(message?.model),
			createdAt: normalizeTimestamp(root.timestamp),
			content: extractContentText(message?.content),
			toolActivities: extractContentToolActivities(message?.content),
			raw: root,
		});
		if (!built) {
			continue;
		}

		pushMessage(state, built);
	}

	return finalizeTranscript({
		parserId: "factory",
		agentSlug: "factory",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Parses Cursor transcripts and unwraps tagged user prompts.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when the content does not match this layout.
 */
function parseCursorTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const records = parseJsonlRecords(content);
	if (records.length === 0) {
		return null;
	}

	const state = createBuildState();
	state.sessionId = options.sessionIdHint;

	for (const record of records) {
		if (!isJsonObject(record.raw)) {
			continue;
		}

		const root = record.raw;
		const role = normalizeMessageRole(readString(root.role));
		if (!role) {
			continue;
		}

		const contentValue = asJsonObject(root.message)?.content;
		const built = buildMessage({
			id: readString(root.id) ?? `turn-${state.messages.length}`,
			idx: state.messages.length,
			role,
			author: undefined,
			createdAt: normalizeTimestamp(root.timestamp),
			content: role === "user"
				? stripCursorUserQuery(extractContentText(contentValue))
				: extractContentText(contentValue),
			toolActivities: extractContentToolActivities(contentValue),
			raw: root,
		});
		if (!built) {
			continue;
		}

		pushMessage(state, built);
	}

	return finalizeTranscript({
		parserId: "cursor",
		agentSlug: "cursor",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Parses unknown JSON transcript documents using generic message heuristics.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when no usable messages can be inferred.
 */
function parseGenericJsonTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const document = parseJsonDocument(content);
	if (!isJsonObject(document)) {
		return null;
	}

	const entries = Array.isArray(document.messages)
		? document.messages
		: Array.isArray(document.events)
			? document.events
			: Array.isArray(document.history)
				? document.history
				: Array.isArray(document.conversation)
					? document.conversation
					: [];

	if (entries.length === 0) {
		return null;
	}

	const state = createBuildState();
	state.sessionId = readString(document.sessionId) ?? readString(document.id) ?? options.sessionIdHint;
	state.workspace = readString(document.cwd) ?? readString(document.workspace);

	for (const entry of entries) {
		const built = buildGenericMessage(entry, state.messages.length);
		if (!built) {
			continue;
		}
		pushMessage(state, built);
	}

	return finalizeTranscript({
		parserId: "generic_json",
		agentSlug: canonicalizeAgentHint(options.agentHint) ?? "unknown",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Parses unknown JSONL transcripts using generic message heuristics.
 *
 * @param content Transcript text to parse.
 * @param options Optional parser hints and fallback identifiers.
 * @returns The normalized transcript, or `null` when no usable messages can be inferred.
 */
function parseGenericJsonlTranscript(
	content: string,
	options: ParseNativeSessionTranscriptOptions,
): ParsedNativeTranscript | null {
	const records = parseJsonlRecords(content);
	if (records.length === 0) {
		return null;
	}

	const state = createBuildState();
	state.sessionId = options.sessionIdHint;

	for (const record of records) {
		const built = buildGenericMessage(record.raw, state.messages.length);
		if (!built) {
			continue;
		}
		pushMessage(state, built);
	}

	return finalizeTranscript({
		parserId: "generic_jsonl",
		agentSlug: canonicalizeAgentHint(options.agentHint) ?? "unknown",
		state,
		fallbackSessionId: options.sessionIdHint,
		userHint: options.userHint,
	});
}

/**
 * Creates the mutable accumulator used while building a parsed transcript.
 *
 * @returns An empty build state.
 */
function createBuildState(): TranscriptBuildState {
	return {
		metadata: {},
		messages: [],
	};
}

/**
 * Finalizes the accumulated state into the public transcript result.
 *
 * @param args Finalization inputs, including parser identity and accumulated message state.
 * @returns The completed transcript model, or `null` when no messages were accumulated.
 */
function finalizeTranscript(args: {
	parserId: NativeTranscriptParserId;
	agentSlug: string;
	state: TranscriptBuildState;
	fallbackSessionId?: string;
	userHint?: string;
}): ParsedNativeTranscript | null {
	if (args.state.messages.length === 0) {
		return null;
	}

	const visibleMessages = trimLeadingBootstrapMessages(args.state.messages);
	const promptPreview = selectPromptPreview(visibleMessages);
	const title = args.state.title ?? promptPreview;
	const toolCount = visibleMessages.reduce((sum, message) => sum + message.toolActivities.length, 0);
	const turns = visibleMessages.map((message) => buildTurnFromMessage(message, args.agentSlug, args.state.model, args.userHint));

	return {
		parserId: args.parserId,
		agentSlug: args.agentSlug,
		sessionId: args.state.sessionId ?? args.fallbackSessionId,
		title,
		promptPreview,
		workspace: args.state.workspace,
		startedAt: args.state.startedAt,
		endedAt: args.state.endedAt,
		model: args.state.model,
		toolCount,
		metadata: args.state.metadata,
		messages: visibleMessages,
		turns,
	};
}

/**
 * Appends a message to the accumulator and expands the transcript time bounds.
 *
 * @param state Mutable transcript build state.
 * @param message Normalized message to append.
 * @returns Nothing.
 */
function pushMessage(state: TranscriptBuildState, message: ParsedNativeTranscriptMessage): void {
	state.messages.push(message);
	if (message.createdAt) {
		mergeTimeBounds(state, message.createdAt);
	}
}

/**
 * Builds a normalized message, ignoring entries with no text or tool activity.
 *
 * @param args Message fields to normalize.
 * @returns The normalized message, or `null` when the input carries no renderable content.
 */
function buildMessage(args: {
	id?: string;
	idx: number;
	role: string;
	author?: string;
	createdAt?: string;
	content?: string;
	toolActivities: SessionDetailToolActivity[];
	raw: JsonValue | string;
}): ParsedNativeTranscriptMessage | null {
	const content = args.content?.trim();
	if ((!content || content.length === 0) && args.toolActivities.length === 0) {
		return null;
	}

	return {
		id: args.id ?? `turn-${args.idx}`,
		idx: args.idx,
		role: args.role,
		author: args.author,
		createdAt: args.createdAt,
		content,
		toolActivities: args.toolActivities,
		raw: args.raw,
	};
}

/**
 * Converts an unknown value into a best-effort normalized message.
 *
 * @param value Raw message candidate.
 * @param idx Stable index used to generate fallback identifiers.
 * @returns A normalized message, or `null` when the value cannot be interpreted as one.
 */
function buildGenericMessage(value: JsonValue | string, idx: number): ParsedNativeTranscriptMessage | null {
	if (typeof value === "string") {
		const content = value.trim();
		return content.length > 0
			? buildMessage({
				id: `turn-${idx}`,
				idx,
				role: "assistant",
				author: undefined,
				createdAt: undefined,
				content,
				toolActivities: [],
				raw: value,
			})
			: null;
	}

	if (!isJsonObject(value)) {
		return null;
	}

	const message = asJsonObject(value.message);
	const role = normalizeMessageRole(
		readString(message?.role)
		?? readString(value.role)
		?? readString(value.type),
	);
	if (!role) {
		return null;
	}

	return buildMessage({
		id: readString(value.uuid) ?? readString(value.id) ?? `turn-${idx}`,
		idx,
		role,
		author: readString(message?.model),
		createdAt: normalizeTimestamp(value.timestamp ?? value.ts ?? value.created_at),
		content: extractContentText(message?.content ?? value.content ?? value.text),
		toolActivities: extractContentToolActivities(message?.content ?? value.content),
		raw: value,
	});
}

/**
 * Converts a normalized message into the turn shape used by the detail model.
 *
 * @param message Normalized message to convert.
 * @param agentSlug Canonical agent identifier associated with the transcript.
 * @param model Optional model name to use when no explicit author is present.
 * @returns The corresponding normalized turn.
 */
function buildTurnFromMessage(
	message: ParsedNativeTranscriptMessage,
	agentSlug: string,
	model: string | undefined,
	userHint: string | undefined,
): SessionDetailTurn {
	const actorLabel = message.role === "user"
		? userHint ?? "You"
		: resolveAgentDisplayName(agentSlug, message.author, model);
	const presentation = splitMessagePresentation(message);

	return {
		id: message.id,
		actor: {
			kind: message.role === "user" ? "user" : "agent",
			name: actorLabel,
			initials: buildInitials(actorLabel),
		},
		timestamp: message.createdAt,
		text: presentation.primaryText,
		toolActivities: message.toolActivities,
		auxiliaryBlocks: presentation.auxiliaryBlocks,
	};
}

function splitMessagePresentation(message: ParsedNativeTranscriptMessage): {
	primaryText?: string;
	auxiliaryBlocks: SessionDetailAuxiliaryBlock[];
} {
	const rawEnvelope = asJsonObject(message.raw);
	const contentValue = resolveMessageContentValue(rawEnvelope);
	const auxiliaryBlocks = contentValue !== undefined
		? extractAuxiliaryBlocksFromContent(contentValue, message.id)
		: [];
	let primaryText = contentValue !== undefined
		? extractVisibleMessageText(contentValue)
		: message.content;

	if (message.author === "reasoning") {
		if (message.content) {
			auxiliaryBlocks.unshift(buildAuxiliaryBlock({
				id: `${message.id}-thinking`,
				kind: "thinking",
				label: "Thinking Process",
				detail: message.content,
				display: "text",
			}));
		}
		primaryText = undefined;
	}

	if (isToolOutputEnvelope(rawEnvelope)) {
		if (message.content) {
			auxiliaryBlocks.unshift(buildAuxiliaryBlock({
				id: `${message.id}-output`,
				kind: "output",
				label: inferToolOutputLabel(rawEnvelope),
				detail: message.content,
				display: "code",
				tone: inferToolOutputTone(rawEnvelope),
			}));
		}
		primaryText = undefined;
	}

	for (const activity of message.toolActivities) {
		if (auxiliaryBlocks.some((block) => block.id === activity.id || (block.kind === "tool_use" && block.label === activity.label && block.detail === activity.detail))) {
			continue;
		}

		auxiliaryBlocks.push(buildAuxiliaryBlock({
			id: activity.id,
			kind: "tool_use",
			label: activity.label,
			detail: activity.detail,
			display: "code",
		}));
	}

	if (!primaryText && auxiliaryBlocks.length === 0) {
		primaryText = message.content;
	}

	return {
		primaryText,
		auxiliaryBlocks,
	};
}

function resolveAgentDisplayName(
	agentSlug: string,
	author: string | undefined,
	model: string | undefined,
): string {
	const canonical = AGENT_DISPLAY_NAMES[agentSlug];
	if (canonical) {
		return canonical;
	}

	const normalizedAuthor = normalizeAuthorLabel(author);
	if (normalizedAuthor) {
		return normalizedAuthor;
	}

	const normalizedModel = normalizeModelLabel(model);
	if (normalizedModel) {
		return normalizedModel;
	}

	return "AI";
}

function normalizeAuthorLabel(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	if (value === "reasoning" || value === "user") {
		return undefined;
	}

	if (value === "copilot-cli") {
		return "Copilot CLI";
	}

	return humanizeIdentifier(value);
}

function normalizeModelLabel(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	return humanizeIdentifier(value);
}

function humanizeIdentifier(value: string): string {
	const normalized = value
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length === 0) {
		return value;
	}

	return normalized
		.split(" ")
		.map((part) => part.length > 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part)
		.join(" ");
}

function resolveMessageContentValue(rawEnvelope: JsonObject | undefined): unknown {
	if (!rawEnvelope) {
		return undefined;
	}

	const payload = asJsonObject(rawEnvelope.payload);
	const message = asJsonObject(rawEnvelope.message);
	return message?.content
		?? message?.text
		?? payload?.content
		?? payload?.output
		?? payload?.text
		?? rawEnvelope.content
		?? rawEnvelope.output
		?? rawEnvelope.text;
}

function extractVisibleMessageText(value: unknown): string | undefined {
	const parts = collectVisibleMessageTextParts(value)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function collectVisibleMessageTextParts(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}

	if (Array.isArray(value)) {
		return value.flatMap((entry) => collectVisibleMessageTextParts(entry));
	}

	if (!isJsonObject(value)) {
		return [];
	}

	const entryType = readString(value.type);
	if (entryType === "tool_use" || entryType === "tool_result" || entryType === "reasoning") {
		return [];
	}
	if ((entryType === "text" || entryType === "input_text" || entryType === "output_text")
		&& typeof value.text === "string") {
		return [value.text];
	}
	if (typeof value.text === "string") {
		return [value.text];
	}
	if (typeof value.content === "string") {
		return [value.content];
	}
	if (Array.isArray(value.content)) {
		return collectVisibleMessageTextParts(value.content);
	}
	return [];
}

function extractAuxiliaryBlocksFromContent(value: unknown, idPrefix: string): SessionDetailAuxiliaryBlock[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((entry, index) => {
		if (!isJsonObject(entry)) {
			return [];
		}

		const entryType = readString(entry.type);
		if (entryType === "reasoning") {
			const detail = extractContentText(entry.text ?? entry.content);
			return detail
				? [buildAuxiliaryBlock({
					id: `${idPrefix}-thinking-${index}`,
					kind: "thinking",
					label: "Thinking Process",
					detail,
					display: "text",
				})]
				: [];
		}

		if (entryType === "tool_use") {
			return [buildAuxiliaryBlock({
				id: readString(entry.id) ?? `${idPrefix}-tool-${index}`,
				kind: "tool_use",
				label: readString(entry.name) ?? "Tool Execution",
				detail: formatToolDetail(entry.input),
				display: "code",
			})];
		}

		if (entryType === "tool_result") {
			const detail = extractContentText(entry.content ?? entry.output ?? entry.text);
			return detail
				? [buildAuxiliaryBlock({
					id: readString(entry.tool_use_id) ?? readString(entry.id) ?? `${idPrefix}-output-${index}`,
					kind: "output",
					label: "Tool Output",
					detail,
					display: "code",
					tone: entry.is_error === true ? "error" : "success",
				})]
				: [];
		}

		return [];
	});
}

function isToolOutputEnvelope(rawEnvelope: JsonObject | undefined): boolean {
	if (!rawEnvelope) {
		return false;
	}

	const payload = asJsonObject(rawEnvelope.payload);
	const payloadType = readString(payload?.type);
	return payloadType === "function_call_output"
		|| payloadType === "custom_tool_call_output";
}

function inferToolOutputLabel(rawEnvelope: JsonObject | undefined): string {
	const payloadType = readString(asJsonObject(rawEnvelope?.payload)?.type);
	if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
		return "Command Output";
	}

	return "Tool Output";
}

function inferToolOutputTone(rawEnvelope: JsonObject | undefined): "default" | "success" | "error" {
	const payload = asJsonObject(rawEnvelope?.payload);
	if (payload?.is_error === true) {
		return "error";
	}

	return "success";
}

function buildAuxiliaryBlock(args: SessionDetailAuxiliaryBlock): SessionDetailAuxiliaryBlock {
	return args;
}

/**
 * Selects the first meaningful user-authored message for previews and titles.
 *
 * @param messages Messages to inspect in source order.
 * @returns The first user-authored preview string, or `undefined` when none is available.
 */
function selectPromptPreview(messages: ParsedNativeTranscriptMessage[]): string | undefined {
	const firstMeaningfulUserMessageIndex = findFirstMeaningfulUserMessageIndex(messages);
	if (firstMeaningfulUserMessageIndex === undefined) {
		return undefined;
	}

	return collapseWhitespace(messages[firstMeaningfulUserMessageIndex]?.content ?? "") || undefined;
}

/**
 * Checks whether the most recent message already carries the same role and content.
 *
 * @param messages Existing normalized messages.
 * @param role Role expected on the trailing message.
 * @param content Content to compare against the trailing message.
 * @returns `true` when the trailing message is a duplicate, otherwise `false`.
 */
function hasTrailingDuplicateMessage(
	messages: ParsedNativeTranscriptMessage[],
	role: string,
	content: string,
): boolean {
	const lastMessage = messages.at(-1);
	if (!lastMessage || lastMessage.role !== role || !lastMessage.content) {
		return false;
	}

	return collapseWhitespace(lastMessage.content) === collapseWhitespace(content);
}

/**
 * Derives short initials from a display label.
 *
 * @param value Display label to abbreviate.
 * @returns One or two uppercase initials.
 */
function buildInitials(value: string): string {
	const parts = value
		.split(/[\s_-]+/g)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length === 0) {
		return "AI";
	}
	if (parts.length === 1) {
		return parts[0].slice(0, 2).toUpperCase();
	}
	return parts
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("");
}

/**
 * Detects setup or context messages that should not become the prompt preview.
 *
 * @param value Candidate preview text.
 * @returns `true` when the text looks like setup or environment scaffolding.
 */
function isLikelyTranscriptPrimer(value: string): boolean {
	return value.startsWith("# AGENTS.md")
		|| value.includes("<environment_context>")
		|| value.includes("<permissions instructions>")
		|| value.includes("<cwd>");
}

/**
 * Trims leading bootstrap and primer entries so the visible transcript starts at the first real user prompt.
 *
 * @param messages Messages to inspect in source order.
 * @returns The visible message list, starting from the first meaningful user prompt when one exists.
 */
function trimLeadingBootstrapMessages(messages: ParsedNativeTranscriptMessage[]): ParsedNativeTranscriptMessage[] {
	const firstMeaningfulUserMessageIndex = findFirstMeaningfulUserMessageIndex(messages);
	if (firstMeaningfulUserMessageIndex === undefined || firstMeaningfulUserMessageIndex === 0) {
		return messages;
	}

	return messages.slice(firstMeaningfulUserMessageIndex);
}

/**
 * Finds the first user-authored message that looks like an actual prompt rather than session scaffolding.
 *
 * @param messages Messages to inspect in source order.
 * @returns The first meaningful user-message index, or `undefined` when none can be found.
 */
function findFirstMeaningfulUserMessageIndex(messages: ParsedNativeTranscriptMessage[]): number | undefined {
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "user" || !message.content) {
			continue;
		}

		const normalized = collapseWhitespace(message.content);
		if (normalized.length > 0 && !isLikelyTranscriptPrimer(normalized)) {
			return index;
		}
	}

	return undefined;
}

/**
 * Updates the earliest and latest timestamps tracked in the accumulator.
 *
 * @param state Mutable transcript build state.
 * @param candidate Timestamp candidate to merge into the current bounds.
 * @returns Nothing.
 */
function mergeTimeBounds(state: TranscriptBuildState, candidate: string | undefined): void {
	if (!candidate) {
		return;
	}

	state.startedAt = pickEarlierTimestamp(state.startedAt, candidate);
	state.endedAt = pickLaterTimestamp(state.endedAt, candidate);
}

/**
 * Returns the earlier of two timestamp strings when both can be parsed.
 *
 * @param left Existing lower bound.
 * @param right Candidate timestamp.
 * @returns The earlier timestamp, or the existing value when comparison is not possible.
 */
function pickEarlierTimestamp(left: string | undefined, right: string): string {
	if (!left) {
		return right;
	}
	const leftValue = timestampToMillis(left);
	const rightValue = timestampToMillis(right);
	if (leftValue === undefined || rightValue === undefined) {
		return left;
	}
	return leftValue <= rightValue ? left : right;
}

/**
 * Returns the later of two timestamp strings when both can be parsed.
 *
 * @param left Existing upper bound.
 * @param right Candidate timestamp.
 * @returns The later timestamp, or the existing value when comparison is not possible.
 */
function pickLaterTimestamp(left: string | undefined, right: string): string {
	if (!left) {
		return right;
	}
	const leftValue = timestampToMillis(left);
	const rightValue = timestampToMillis(right);
	if (leftValue === undefined || rightValue === undefined) {
		return left;
	}
	return leftValue >= rightValue ? left : right;
}

/**
 * Parses a JSON document and returns `undefined` when decoding fails.
 *
 * @param content Raw JSON text.
 * @returns The parsed JSON value, or `undefined` when parsing fails.
 */
function parseJsonDocument(content: string): JsonValue | undefined {
	try {
		return JSON.parse(content) as JsonValue;
	} catch {
		return undefined;
	}
}

/**
 * Parses non-empty JSONL lines into raw records with stable indexes.
 *
 * @param content Raw JSONL text.
 * @returns Parsed records in source order.
 */
function parseJsonlRecords(content: string): ParsedJsonlRecord[] {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line, index) => ({
			index,
			raw: parseJsonLine(line),
			rawText: line,
		}));
}

/**
 * Parses one JSONL line, falling back to the raw text when it is not valid JSON.
 *
 * @param line Raw line text.
 * @returns The parsed JSON value, or the original line when parsing fails.
 */
function parseJsonLine(line: string): JsonValue | string {
	try {
		return JSON.parse(line) as JsonValue;
	} catch {
		return line;
	}
}

/**
 * Converts a parsed line into the event shape used by transcript consumers.
 *
 * @param index Stable line index.
 * @param value Parsed line value.
 * @param rawText Original line text.
 * @returns The transcript event for that line.
 */
function toTranscriptEvent(index: number, value: JsonValue | string, rawText: string): TranscriptEvent {
	if (isJsonObject(value)) {
		return {
			index,
			eventType: readFirstObjectString(value, ["type", "event_type", "eventType", "kind"]),
			timestamp: readFirstObjectString(value, ["timestamp", "ts", "created_at"]),
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

/**
 * Detects the Codex event layout from parsed JSONL records.
 *
 * @param records Parsed JSONL records.
 * @returns `true` when the records match the expected Codex event types.
 */
function looksLikeCodexTranscript(records: ParsedJsonlRecord[]): boolean {
	return records.some((record) => {
		if (!isJsonObject(record.raw)) {
			return false;
		}
		const type = readString(record.raw.type);
		return type === "session_meta" || type === "response_item" || type === "event_msg";
	});
}

/**
 * Detects the Copilot event layout from parsed JSONL records.
 *
 * @param records Parsed JSONL records.
 * @returns `true` when the records match the expected Copilot event types.
 */
function looksLikeCopilotCliTranscript(records: ParsedJsonlRecord[]): boolean {
	return records.some((record) => {
		if (!isJsonObject(record.raw)) {
			return false;
		}
		const type = readString(record.raw.type) ?? "";
		return type.includes(".message") || type === "tool.execution_complete" || type === "session.model_change";
	});
}

/**
 * Detects the Factory envelope layout from parsed JSONL records.
 *
 * @param records Parsed JSONL records.
 * @returns `true` when the records match the expected Factory envelope types.
 */
function looksLikeFactoryTranscript(records: ParsedJsonlRecord[]): boolean {
	let hasEnvelope = false;
	for (const record of records) {
		if (!isJsonObject(record.raw)) {
			continue;
		}
		const type = readString(record.raw.type);
		if (type === "session_start") {
			return true;
		}
		const message = asJsonObject(record.raw.message);
		if (type === "message" && typeof message?.role === "string") {
			hasEnvelope = true;
		}
	}
	return hasEnvelope;
}

/**
 * Detects the Cursor message layout from parsed JSONL records.
 *
 * @param records Parsed JSONL records.
 * @returns `true` when the records match the expected Cursor message structure.
 */
function looksLikeCursorTranscript(records: ParsedJsonlRecord[]): boolean {
	return records.some((record) => {
		if (!isJsonObject(record.raw)) {
			return false;
		}
		return typeof record.raw.role === "string"
			&& isJsonObject(record.raw.message)
			&& Array.isArray(record.raw.message.content);
	});
}

/**
 * Detects Claude-style JSONL transcripts.
 *
 * @param records Parsed JSONL records.
 * @returns `true` when the records match the expected Claude message envelope.
 */
function looksLikeClaudeTranscriptJsonl(records: ParsedJsonlRecord[]): boolean {
	return records.some((record) => {
		if (!isJsonObject(record.raw)) {
			return false;
		}
		const type = readString(record.raw.type);
		const message = asJsonObject(record.raw.message);
		return (type === "user" || type === "assistant" || type === "message")
			&& typeof message?.role === "string";
	});
}

/**
 * Detects Gemini transcript documents.
 *
 * @param document Parsed JSON document.
 * @returns `true` when the document matches the expected Gemini transcript shape.
 */
function looksLikeGeminiTranscript(document: JsonObject): boolean {
	return Array.isArray(document.messages)
		&& (
			typeof document.sessionId === "string"
			|| typeof document.projectHash === "string"
			|| (document.messages.length > 0 && isJsonObject(document.messages[0]) && typeof document.messages[0].type === "string")
		);
}

/**
 * Detects OpenCode export documents.
 *
 * @param document Parsed JSON document.
 * @returns `true` when the document matches the expected OpenCode export shape.
 */
function looksLikeOpenCodeTranscript(document: JsonObject): boolean {
	return isJsonObject(document.info) && Array.isArray(document.messages);
}

/**
 * Detects Claude-style transcript documents that store messages in a single JSON object.
 *
 * @param document Parsed JSON document.
 * @returns `true` when the document matches the expected Claude document structure.
 */
function looksLikeClaudeTranscriptDocument(document: JsonObject): boolean {
	return Array.isArray(document.messages)
		&& !isJsonObject(document.info)
		&& typeof document.sessionId !== "undefined";
}

/**
 * Detects Copilot transcript documents that embed events in a JSON object.
 *
 * @param document Parsed JSON document.
 * @returns `true` when the document exposes one of the supported Copilot event arrays.
 */
function looksLikeCopilotTranscriptDocument(document: JsonObject): boolean {
	return Array.isArray(document.events)
		|| Array.isArray(document.history)
		|| Array.isArray(document.conversation)
		|| (Array.isArray(document.messages) && !isJsonObject(document.info));
}

/**
 * Returns the event list from the supported Copilot document wrappers.
 *
 * @param document Parsed JSON document.
 * @returns The extracted event list, or an empty array when no supported wrapper is present.
 */
function extractCopilotDocumentEvents(document: JsonObject): JsonValue[] {
	if (Array.isArray(document.events)) {
		return document.events;
	}
	if (Array.isArray(document.history)) {
		return document.history;
	}
	if (Array.isArray(document.messages)) {
		return document.messages;
	}
	if (Array.isArray(document.conversation)) {
		return document.conversation;
	}
	return [];
}

/**
 * Normalizes raw role labels into the reduced role set used by this module.
 *
 * @param value Raw role label.
 * @returns The normalized role, or `undefined` when the role is not recognized.
 */
function normalizeMessageRole(value: string | undefined): string | undefined {
	switch (value?.toLowerCase()) {
		case "user":
		case "human":
			return "user";
		case "assistant":
		case "agent":
			return "assistant";
		case "developer":
		case "system":
			return "system";
		case "tool":
			return value.toLowerCase();
		default:
			return undefined;
	}
}

/**
 * Normalizes Gemini-specific message roles into user or assistant turns.
 *
 * @param value Raw Gemini message type.
 * @returns The normalized role, or `undefined` when the role is not recognized.
 */
function normalizeGeminiRole(value: string | undefined): string | undefined {
	switch (value?.toLowerCase()) {
		case "user":
			return "user";
		case "model":
		case "gemini":
		case "assistant":
			return "assistant";
		default:
			return undefined;
	}
}

/**
 * Extracts a message role and text payload from a Copilot event record.
 *
 * @param value Copilot event record.
 * @returns The extracted role and content, or `null` when the event is not message-like.
 */
function normalizeCopilotEventMessage(value: JsonObject): { role: string; content: string } | null {
	const eventType = (readString(value.type) ?? "").toLowerCase();
	const data = asJsonObject(value.data);
	const explicitRole = normalizeMessageRole(readString(value.role));
	const role = explicitRole
		?? (eventType.includes("user") || eventType === "prompt" || eventType === "userpromptsubmitted"
			? "user"
			: eventType.includes("assistant") || eventType === "response" || eventType === "completion"
				? "assistant"
				: undefined);
	if (!role) {
		return null;
	}

	const content = extractContentText(
		data?.content
		?? value.content
		?? data?.message
		?? value.message
		?? data?.text
		?? value.text
		?? data?.output
		?? value.output
		?? data?.result
		?? value.result,
	);
	if (!content) {
		return null;
	}

	return { role, content };
}

/**
 * Flattens Gemini content blocks into a single text string.
 *
 * @param value Raw Gemini content field.
 * @returns Flattened text, or `undefined` when no text is present.
 */
function extractGeminiContentText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value.trim() || undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	const parts = value
		.map((entry) => (isJsonObject(entry) ? readString(entry.text) : undefined))
		.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		.map((entry) => entry.trim());

	return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Extracts Gemini tool calls into normalized tool activity entries.
 *
 * @param value Raw Gemini tool-call collection.
 * @returns Normalized tool activity entries.
 */
function extractGeminiToolActivities(value: unknown): SessionDetailToolActivity[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((entry, index) => {
		if (!isJsonObject(entry)) {
			return [];
		}

		return [buildToolActivity(
			readString(entry.id) ?? `tool-${index}`,
			readString(entry.name) ?? "Tool",
			formatToolDetail(entry.args),
		)];
	});
}

/**
 * Collects user or assistant text from OpenCode message parts.
 *
 * @param parts Raw message parts.
 * @param role Normalized message role.
 * @returns Flattened text, or `undefined` when no text parts are present.
 */
function extractOpenCodeText(parts: unknown[], role: string): string | undefined {
	const textParts: string[] = [];
	for (const entry of parts) {
		if (!isJsonObject(entry)) {
			continue;
		}

		if (readString(entry.type) === "text") {
			const text = readString(entry.text)?.trim();
			if (text) {
				textParts.push(text);
			}
		}
	}

	if (textParts.length === 0) {
		return undefined;
	}

	const combined = textParts.join("\n\n");
	if (role === "user") {
		const stripped = stripOpenCodeSystemReminders(combined);
		return stripped.length > 0 ? stripped : undefined;
	}
	return combined;
}

/**
 * Converts OpenCode tool parts into normalized tool activity entries.
 *
 * @param parts Raw message parts.
 * @returns Normalized tool activity entries.
 */
function extractOpenCodeToolActivities(parts: unknown[]): SessionDetailToolActivity[] {
	const activities: SessionDetailToolActivity[] = [];
	for (const [index, entry] of parts.entries()) {
		if (!isJsonObject(entry) || readString(entry.type) !== "tool") {
			continue;
		}

		const state = asJsonObject(entry.state);
		const detailParts = [
			formatToolDetail(state?.input),
			readString(state?.output),
		].filter((part): part is string => typeof part === "string" && part.trim().length > 0);

		activities.push(buildToolActivity(
			readString(entry.callID) ?? readString(entry.id) ?? `tool-${index}`,
			readString(entry.tool) ?? "Tool",
			detailParts.length > 0 ? detailParts.join("\n") : undefined,
		));
	}
	return activities;
}

/**
 * Flattens text-bearing content blocks into a single string.
 *
 * @param value Raw content value.
 * @returns Flattened text, or `undefined` when no text can be extracted.
 */
function extractContentText(value: unknown): string | undefined {
	const parts = collectContentTextParts(value)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Recursively collects text fragments from nested content structures.
 *
 * @param value Raw content value.
 * @returns Text fragments extracted from the value.
 */
function collectContentTextParts(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}

	if (Array.isArray(value)) {
		return value.flatMap((entry) => collectContentTextParts(entry));
	}

	if (!isJsonObject(value)) {
		return [];
	}

	const entryType = readString(value.type);
	if (entryType === "tool_use") {
		return [];
	}
	if ((entryType === "text" || entryType === "input_text" || entryType === "output_text" || entryType === "reasoning")
		&& typeof value.text === "string") {
		return [value.text];
	}
	if (entryType === "tool_result") {
		return collectContentTextParts(value.content ?? value.output ?? value.text);
	}
	if (typeof value.text === "string") {
		return [value.text];
	}
	if (typeof value.content === "string") {
		return [value.content];
	}
	if (Array.isArray(value.content)) {
		return collectContentTextParts(value.content);
	}
	if (typeof value.output === "string") {
		return [value.output];
	}
	return [];
}

/**
 * Extracts generic tool-use content blocks into normalized tool activity entries.
 *
 * @param value Raw content value.
 * @returns Normalized tool activity entries.
 */
function extractContentToolActivities(value: unknown): SessionDetailToolActivity[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((entry, index) => {
		if (!isJsonObject(entry) || readString(entry.type) !== "tool_use") {
			return [];
		}

		return [buildToolActivity(
			readString(entry.id) ?? `tool-${index}`,
			readString(entry.name) ?? "Tool",
			formatToolDetail(entry.input),
		)];
	});
}

/**
 * Builds a normalized tool activity object.
 *
 * @param id Stable tool activity identifier.
 * @param label Tool label to display.
 * @param detail Optional human-readable detail string.
 * @returns The normalized tool activity object.
 */
function buildToolActivity(id: string, label: string, detail: string | undefined): SessionDetailToolActivity {
	return {
		id,
		kind: "tool_use",
		label,
		detail,
	};
}

/**
 * Formats structured tool input into a compact human-readable description.
 *
 * @param value Raw tool input value.
 * @returns A formatted description, or `undefined` when no useful detail can be derived.
 */
function formatToolDetail(value: unknown): string | undefined {
	if (typeof value === "string") {
		const normalized = value.trim();
		if (normalized.length === 0) {
			return undefined;
		}

		const parsed = parseJsonDocument(normalized);
		if (isJsonObject(parsed)) {
			return formatToolDetail(parsed);
		}

		return normalized;
	}

	if (!isJsonObject(value)) {
		return undefined;
	}

	const command = readString(value.command);
	if (command) {
		return command;
	}
	const cmd = readString(value.cmd);
	if (cmd) {
		return cmd;
	}

	const pieces = [
		readString(value.workdir) ? `cwd: ${readString(value.workdir)}` : undefined,
		readString(value.file_path) ? `file: ${readString(value.file_path)}` : undefined,
		readString(value.filePath) ? `file: ${readString(value.filePath)}` : undefined,
		readString(value.path) ? `path: ${readString(value.path)}` : undefined,
		readString(value.notebook_path) ? `notebook: ${readString(value.notebook_path)}` : undefined,
		readString(value.notebookPath) ? `notebook: ${readString(value.notebookPath)}` : undefined,
		readString(value.pattern) ? `pattern: ${readString(value.pattern)}` : undefined,
		readString(value.query) ? `query: ${readString(value.query)}` : undefined,
		readString(value.search_query) ? `search: ${readString(value.search_query)}` : undefined,
		readString(value.description),
	].filter((piece): piece is string => typeof piece === "string" && piece.length > 0);

	if (pieces.length > 0) {
		return pieces.join(" · ");
	}

	return JSON.stringify(value);
}

/**
 * Summarizes Copilot tool telemetry into a short detail string.
 *
 * @param value Copilot tool execution payload.
 * @returns A formatted summary, or `undefined` when no useful telemetry is available.
 */
function formatCopilotToolDetail(value: JsonObject | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const telemetry = asJsonObject(value.toolTelemetry);
	const properties = asJsonObject(telemetry?.properties);
	const metrics = asJsonObject(telemetry?.metrics);
	const filePaths = parseStringArray(readString(properties?.filePaths));
	const pieces = [
		filePaths.length > 0 ? `files: ${filePaths.join(", ")}` : undefined,
		typeof metrics?.linesAdded === "number" ? `+${metrics.linesAdded}` : undefined,
		typeof metrics?.linesRemoved === "number" ? `-${metrics.linesRemoved}` : undefined,
	].filter((piece): piece is string => typeof piece === "string" && piece.length > 0);

	return pieces.length > 0 ? pieces.join(" · ") : undefined;
}

/**
 * Parses a JSON-encoded string array and ignores malformed values.
 *
 * @param value JSON-encoded string array.
 * @returns The parsed string array, or an empty array when parsing fails.
 */
function parseStringArray(value: string | undefined): string[] {
	if (!value) {
		return [];
	}

	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
			: [];
	} catch {
		return [];
	}
}

/**
 * Extracts the inner user prompt from Cursor's tagged query wrapper.
 *
 * @param value Raw user message text.
 * @returns The unwrapped prompt text, or `undefined` when no text remains.
 */
function stripCursorUserQuery(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const match = value.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
	if (!match) {
		return value.trim() || undefined;
	}

	const stripped = match[1]?.trim();
	return stripped ? stripped : undefined;
}

/**
 * Removes inline system-reminder blocks from OpenCode user content.
 *
 * @param value Raw user content.
 * @returns The content with reminder blocks removed.
 */
function stripOpenCodeSystemReminders(value: string): string {
	let current = value;
	for (; ;) {
		const start = current.indexOf("<system-reminder>");
		if (start === -1) {
			break;
		}
		const end = current.indexOf("</system-reminder>", start);
		if (end === -1) {
			break;
		}
		current = current.slice(0, start) + current.slice(end + "</system-reminder>".length);
	}
	return current.trim();
}

/**
 * Infers a workspace path from early transcript messages when it is not explicit.
 *
 * @param messages Normalized transcript messages.
 * @returns The inferred workspace path, or `undefined` when no path-like text is found.
 */
function extractWorkspaceFromTranscriptText(messages: ParsedNativeTranscriptMessage[]): string | undefined {
	for (const message of messages.slice(0, 50)) {
		const content = message.content;
		if (!content) {
			continue;
		}

		const agentsMatch = content.match(/AGENTS\.md instructions for (\S+)/);
		if (agentsMatch?.[1]) {
			return trimTrailingDelimiter(agentsMatch[1]);
		}

		const cwdMatch = content.match(/Working directory:\s+(\S+)/);
		if (cwdMatch?.[1]) {
			return trimTrailingDelimiter(cwdMatch[1]);
		}
	}

	for (const message of messages.slice(0, 5)) {
		const content = message.content;
		if (!content) {
			continue;
		}

		const projectMatch = content.match(/(\/data\/projects\/[^\s"'`)>\]]+)/);
		if (projectMatch?.[1]) {
			return trimTrailingDelimiter(projectMatch[1]);
		}
	}

	return undefined;
}

/**
 * Removes trailing punctuation commonly attached to captured paths.
 *
 * @param value Candidate path string.
 * @returns The cleaned path string.
 */
function trimTrailingDelimiter(value: string): string {
	return value.replace(/[/:)\]>",']+$/g, "");
}

/**
 * Normalizes timestamps from numbers or strings into ISO strings when possible.
 *
 * @param value Raw timestamp value.
 * @returns A normalized timestamp string, or `undefined` when normalization fails.
 */
function normalizeTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return epochNumberToIso(value);
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		return epochNumberToIso(Number(trimmed));
	}

	const parsed = Date.parse(trimmed);
	if (Number.isFinite(parsed)) {
		return new Date(parsed).toISOString();
	}

	return trimmed;
}

/**
 * Converts epoch seconds or milliseconds into an ISO timestamp.
 *
 * @param value Epoch timestamp in seconds or milliseconds.
 * @returns An ISO timestamp string, or `undefined` when conversion fails.
 */
function epochNumberToIso(value: number): string | undefined {
	if (!Number.isFinite(value) || value <= 0) {
		return undefined;
	}

	const millis = value < 100_000_000_000 ? value * 1000 : value;
	const date = new Date(millis);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Parses an ISO-compatible timestamp string into epoch milliseconds.
 *
 * @param value Timestamp string to parse.
 * @returns Epoch milliseconds, or `undefined` when parsing fails.
 */
function timestampToMillis(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Returns the first matching string value from a JSON object.
 *
 * @param value Object to inspect.
 * @param keys Keys to test in order.
 * @returns The first matching string value, or `undefined` when none is present.
 */
function readFirstObjectString(value: JsonObject, keys: string[]): string | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}

	return undefined;
}

/**
 * Returns the value when it is a plain JSON object.
 *
 * @param value Value to inspect.
 * @returns The object value, or `undefined` when the value is not a plain object.
 */
function asJsonObject(value: unknown): JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

/**
 * Returns the value when it is a non-empty string.
 *
 * @param value Value to inspect.
 * @returns The string value, or `undefined` when the value is empty or not a string.
 */
function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
