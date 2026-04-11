import * as vscode from "vscode";
import {
	listSessionsForCheckpointIds,
	type EntireSessionCard,
	type InitialAttribution,
	type SessionCheckpointEntry,
	type SessionDetailTarget,
	type SessionFilePaths,
	type SessionTranscriptTarget,
	type SessionStatus,
} from "../checkpoints";
import { EntireStatusState, type EntireWorkspaceState } from "../workspaceProbe";

const CONTEXT_SESSION = "session-bridge-session";
const CONTEXT_DETAIL = "session-bridge-session-detail";
const CONTEXT_ACTION = "session-bridge-session-action";
const LOAD_TIMEOUT_MS = 50_000;

export interface SessionsViewCommands {
	readonly refresh: string;
	readonly showStatus: string;
	readonly openSessionTranscript: string;
}

export interface CheckpointSessionSelection {
	checkpointId: string;
	sessionPaths: SessionFilePaths[];
	commitSha?: string;
}

type SessionTreeCard = {
	sessionId: string;
	status: SessionStatus;
	promptPreview: string;
	agent?: string;
	model?: string;
	author?: string;
	startedAt?: string;
	lastActivityAt?: string;
	durationMs?: number;
	attribution?: InitialAttribution;
	checkpointCount: number;
	stepCount?: number;
	toolCount?: number;
	tokenCount?: number;
	checkpointIds: string[];
	checkpointEntries?: SessionCheckpointEntry[];
	lastCheckpointId?: string;
	canOpenLastCheckpoint: boolean;
	canOpenTranscript: boolean;
	searchText: string;
};

type LoadState =
	| { kind: "ready" }
	| { kind: "loading" }
	| { kind: "loaded"; cards: SessionTreeCard[] }
	| { kind: "error"; message: string };

class EmptyStateItem extends vscode.TreeItem {
	constructor(label: string, icon: string, tooltip?: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.tooltip = tooltip;
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = CONTEXT_DETAIL;
	}
}

class SessionDetailItem extends vscode.TreeItem {
	constructor(label: string, description: string, icon: string, tooltip?: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.tooltip = tooltip ?? `${label}: ${description}`;
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = CONTEXT_DETAIL;
	}
}

class SessionActionItem extends vscode.TreeItem {
	constructor(
		label: string,
		icon: string,
		command: vscode.Command,
		description?: string,
	) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.iconPath = new vscode.ThemeIcon(icon);
		this.command = command;
		this.contextValue = CONTEXT_ACTION;
	}
}

export class SessionsTreeItem extends vscode.TreeItem {
	constructor(
		public readonly card: SessionTreeCard,
	) {
		super(buildSessionIdentity(card), vscode.TreeItemCollapsibleState.Collapsed);
		this.description = card.status;
		this.tooltip = buildSessionTooltip(card);
		this.iconPath = new vscode.ThemeIcon(selectSessionIcon(card));
		this.contextValue = CONTEXT_SESSION;
	}
}

export function getSessionDetailTarget(element: vscode.TreeItem | undefined): SessionDetailTarget | undefined {
	if (!(element instanceof SessionsTreeItem)) {
		return undefined;
	}

	return {
		sessionId: element.card.sessionId,
		promptPreview: element.card.promptPreview,
		source: "checkpoint",
		checkpointIds: element.card.checkpointIds,
		checkpointEntries: element.card.checkpointEntries,
	};
}

export class SessionsTreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	private workspaceState: EntireWorkspaceState;
	private repoPath: string | undefined;
	private selectedCheckpointSelection: CheckpointSessionSelection | undefined;
	private loadState: LoadState;
	private loadGeneration = 0;

	constructor(
		workspaceState: EntireWorkspaceState,
		repoPath: string | undefined,
		private readonly commands: SessionsViewCommands,
		private readonly outputChannel?: vscode.OutputChannel,
		private readonly loadCheckpointSessions: (
			repoPath: string,
			checkpointId: string,
			sessionPaths: SessionFilePaths[],
		) => Promise<EntireSessionCard[]> = listSessionsForCheckpointIds,
	) {
		this.workspaceState = workspaceState;
		this.repoPath = repoPath;
		this.loadState = buildInitialLoadState();
		this.debug(`constructor: state=${workspaceState.state}, repoPath=${repoPath ?? "(none)"}`);
	}

	private debug(message: string): void {
		this.outputChannel?.appendLine(`[sessions] ${message}`);
	}

	setCheckpointSelection(selection: CheckpointSessionSelection | undefined): void {
		const normalizedSelection = normalizeCheckpointSelection(selection);
		if (sameCheckpointSelection(this.selectedCheckpointSelection, normalizedSelection)) {
			return;
		}

		this.selectedCheckpointSelection = normalizedSelection;
		this.debug(
			`setCheckpointSelection: checkpointId=${normalizedSelection?.checkpointId ?? "(none)"}, sessionPaths=${normalizedSelection?.sessionPaths.length ?? 0}`,
		);

		if (this.workspaceState.state !== EntireStatusState.ENABLED) {
			this.changeEmitter.fire();
			return;
		}

		this.loadGeneration++;
		this.loadState = buildInitialLoadState();
		if (this.repoPath && normalizedSelection) {
			this.startBackgroundLoad(this.repoPath);
		}
		this.changeEmitter.fire();
	}

	setWorkspaceState(workspaceState: EntireWorkspaceState, repoPath: string | undefined): void {
		const repoChanged = this.repoPath !== repoPath;
		const enabledChanged = this.workspaceState.state !== workspaceState.state;
		if (repoChanged) {
			this.selectedCheckpointSelection = undefined;
		}
		this.workspaceState = workspaceState;
		this.repoPath = repoPath;
		this.debug(`setWorkspaceState: state=${workspaceState.state}, repoPath=${repoPath ?? "(none)"}, repoChanged=${repoChanged}, enabledChanged=${enabledChanged}, loadState=${this.loadState.kind}`);

		if (repoChanged || enabledChanged) {
			this.loadGeneration++;
			this.loadState = buildInitialLoadState();
		}

		this.changeEmitter.fire();
	}

	refresh(): void {
		this.debug(`refresh: loadState=${this.loadState.kind}`);
		this.changeEmitter.fire();
	}

	reload(): void {
		this.loadGeneration++;
		const generation = this.loadGeneration;
		this.loadState = buildInitialLoadState();

		if (this.workspaceState.state !== EntireStatusState.ENABLED || !this.repoPath) {
			this.debug(`reload: skipped (state=${this.workspaceState.state}, repoPath=${this.repoPath ?? "(none)"}), gen=${generation}`);
			this.changeEmitter.fire();
			return;
		}

		if (!hasCheckpointSelection(this.selectedCheckpointSelection)) {
			this.debug(`reload: skipped (no checkpoint selection), gen=${generation}`);
			this.changeEmitter.fire();
			return;
		}

		this.debug(`reload: starting background load, gen=${generation}, repoPath=${this.repoPath}`);
		this.startBackgroundLoad(this.repoPath);
		this.changeEmitter.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		if (element instanceof SessionsTreeItem) {
			return buildSessionChildItems(element.card, this.commands);
		}

		if (this.workspaceState.state !== EntireStatusState.ENABLED) {
			return [];
		}

		if (!this.repoPath) {
			return [];
		}

		if (!hasCheckpointSelection(this.selectedCheckpointSelection)) {
			return [
				new EmptyStateItem(
					"Select a checkpoint to view sessions",
					"history",
					"Choose a checkpoint in the Checkpoints tree to load only the sessions captured in that checkpoint.",
				),
				buildRefreshAction(this.commands),
			];
		}

		switch (this.loadState.kind) {
			case "ready":
				this.debug(`getChildren: auto-starting initial load, gen=${this.loadGeneration}, repoPath=${this.repoPath}`);
				this.startBackgroundLoad(this.repoPath);
				return [new EmptyStateItem("Loading sessions…", "loading~spin")];

			case "loading":
				return [new EmptyStateItem("Loading sessions…", "loading~spin")];

			case "error":
				return [
					new EmptyStateItem(this.loadState.message, "warning", "An error occurred while reading session data. Try refreshing."),
					buildRefreshAction(this.commands),
					buildShowStatusAction(this.commands),
				];

			case "loaded":
				if (this.loadState.cards.length === 0) {
					return [
						new EmptyStateItem(
							"No sessions in selected checkpoint",
							"history",
							"The selected checkpoint does not have any resolved sessions in the current repository context.",
						),
						buildRefreshAction(this.commands),
					];
				}

				return this.loadState.cards.map((card) => new SessionsTreeItem(card));
		}
	}

	private startBackgroundLoad(repoPath: string): void {
		if (!hasCheckpointSelection(this.selectedCheckpointSelection)) {
			return;
		}

		const generation = this.loadGeneration;
		this.loadState = { kind: "loading" };
		const startTime = Date.now();
		this.debug(`startBackgroundLoad: gen=${generation}, timeout=${LOAD_TIMEOUT_MS}ms`);

		const selection = this.selectedCheckpointSelection;
		const work = this.loadCheckpointSessions(
			repoPath,
			selection?.checkpointId ?? "",
			selection?.sessionPaths ?? [],
		).then((cards) => cards.map(adaptCheckpointSessionCard));
		const timeout = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("Session load timed out")), LOAD_TIMEOUT_MS);
		});

		Promise.race([work, timeout])
			.then((cards) => {
				const elapsed = Date.now() - startTime;
				if (this.loadGeneration !== generation) {
					this.debug(`startBackgroundLoad: stale gen=${generation} (current=${this.loadGeneration}), discarding ${cards.length} cards after ${elapsed}ms`);
					return;
				}

				const sortedCards = sortCards(cards);
				this.debug(`startBackgroundLoad: success, gen=${generation}, ${cards.length} cards in ${elapsed}ms`);
				this.loadState = { kind: "loaded", cards: sortedCards };
				this.changeEmitter.fire();
			})
			.catch((error) => {
				const elapsed = Date.now() - startTime;
				if (this.loadGeneration !== generation) {
					this.debug(`startBackgroundLoad: stale gen=${generation} (current=${this.loadGeneration}), ignoring error after ${elapsed}ms: ${error}`);
					return;
				}

				const message = error instanceof Error ? error.message : "Failed to load sessions";
				this.debug(`startBackgroundLoad: error, gen=${generation}, ${elapsed}ms: ${message}`);
				this.loadState = { kind: "error", message };
				this.changeEmitter.fire();
			});
	}
}

function buildSessionChildItems(card: SessionTreeCard, commands: SessionsViewCommands): vscode.TreeItem[] {
	const items: vscode.TreeItem[] = [
		new SessionDetailItem("Prompt", truncate(card.promptPreview, 96), "comment-discussion", card.promptPreview),
		new SessionDetailItem("Session ID", card.sessionId, "key", card.sessionId),
	];

	const duration = buildDurationDetail(card);
	if (duration) {
		items.push(new SessionDetailItem(
			"Duration",
			duration.description,
			"clock",
			duration.tooltip,
		));
	}

	if (card.startedAt) {
		items.push(new SessionDetailItem(
			"Started",
			formatShortTimestamp(card.startedAt),
			"history",
			card.startedAt,
		));
	}

	if (card.lastActivityAt && card.lastActivityAt !== card.startedAt) {
		items.push(new SessionDetailItem(
			"Last Active",
			formatShortTimestamp(card.lastActivityAt),
			"pulse",
			card.lastActivityAt,
		));
	}

	if (card.author) {
		items.push(new SessionDetailItem("Author", card.author, "person"));
	}

	const attribution = buildAttributionDetail(card.attribution);
	if (attribution) {
		items.push(new SessionDetailItem(
			"Attribution",
			attribution.description,
			"pie-chart",
			attribution.tooltip,
		));
	}

	const stats = buildStats(card);
	if (stats) {
		items.push(new SessionDetailItem("Stats", stats, "graph"));
	}

	if (card.canOpenTranscript) {
		items.push(buildTranscriptAction(card, commands.openSessionTranscript));
	}

	return items;
}

function buildTranscriptAction(card: SessionTreeCard, commandId: string): SessionActionItem {
	return new SessionActionItem(
		"View Session Transcript",
		"file",
		{
			command: commandId,
			title: "View Session Transcript",
			arguments: [buildSessionTranscriptTarget(card)],
		},
		"Committed transcript",
	);
}

function buildSessionTranscriptTarget(card: SessionTreeCard): SessionTranscriptTarget {
	return {
		sessionId: card.sessionId,
		promptPreview: card.promptPreview,
		source: "checkpoint",
		checkpointIds: card.checkpointIds,
		checkpointEntries: card.checkpointEntries,
		lastCheckpointId: card.lastCheckpointId,
	};
}

function buildRefreshAction(commands: SessionsViewCommands): vscode.TreeItem {
	return new SessionActionItem("Refresh", "refresh", { command: commands.refresh, title: "Refresh" });
}

function buildShowStatusAction(commands: SessionsViewCommands): vscode.TreeItem {
	return new SessionActionItem("Show Raw CLI Status", "output", { command: commands.showStatus, title: "Show Raw CLI Status" });
}

function buildSessionIdentity(card: SessionTreeCard): string {
	const identity = [
		formatAgentName(card.agent) ?? "Unknown Agent",
		card.model ? `(${card.model})` : undefined,
		card.promptPreview === "" ? "" : "·",
		card.promptPreview,
	].filter((part): part is string => typeof part === "string");

	return identity.join(" ");
}

function buildSessionTooltip(card: SessionTreeCard): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.isTrusted = false;
	tooltip.supportThemeIcons = true;

	tooltip.appendMarkdown(`**Session:** ${card.sessionId}\n\n`);
	tooltip.appendMarkdown(`**Status:** ${escapeMarkdown(card.status)}\n\n`);
	tooltip.appendMarkdown(`**Prompt:** ${escapeMarkdown(card.promptPreview)}\n\n`);
	tooltip.appendMarkdown(`**Source:** Selected checkpoint\n\n`);

	if (card.agent) {
		tooltip.appendMarkdown(`**Agent:** ${escapeMarkdown(card.agent)}\n\n`);
	}

	if (card.model) {
		tooltip.appendMarkdown(`**Model:** ${escapeMarkdown(card.model)}\n\n`);
	}

	if (card.lastActivityAt && card.lastActivityAt !== card.startedAt) {
		tooltip.appendMarkdown(`**Last Active:** ${escapeMarkdown(card.lastActivityAt)}\n\n`);
	}

	if (card.lastCheckpointId) {
		tooltip.appendMarkdown(`**Latest Checkpoint:** ${escapeMarkdown(card.lastCheckpointId)}\n\n`);
	}

	const duration = buildDurationDetail(card);
	if (duration) {
		tooltip.appendMarkdown(`**Duration:** ${escapeMarkdown(duration.description)}\n\n`);
	}

	if (typeof card.tokenCount === "number") {
		tooltip.appendMarkdown(`**Tokens:** ${formatTokenCount(card.tokenCount)}\n\n`);
	}

	const attribution = buildAttributionDetail(card.attribution);
	if (attribution) {
		tooltip.appendMarkdown(`**Attribution:** ${escapeMarkdown(attribution.description)}\n\n`);
	}

	if (card.checkpointCount > 0) {
		tooltip.appendMarkdown(`**Checkpoints:** ${card.checkpointCount}\n\n`);
	}

	return tooltip;
}

function buildStats(card: SessionTreeCard): string | undefined {
	const parts: string[] = [];

	if (typeof card.tokenCount === "number") {
		parts.push(`${formatTokenCount(card.tokenCount)} tokens`);
	}

	if (card.checkpointCount > 0) {
		parts.push(`${card.checkpointCount} checkpoint${card.checkpointCount === 1 ? "" : "s"}`);
	}

	if (typeof card.stepCount === "number") {
		parts.push(`${card.stepCount} step${card.stepCount === 1 ? "" : "s"}`);
	}

	if (typeof card.toolCount === "number") {
		parts.push(`${card.toolCount} tool${card.toolCount === 1 ? "" : "s"}`);
	}

	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function selectSessionIcon(card: SessionTreeCard): string {
	if (card.status === "ENDED") {
		return "history";
	}

	return card.status === "ACTIVE" ? "pulse" : "clock";
}

function formatAgentName(agent: string | undefined): string | undefined {
	if (!agent) {
		return undefined;
	}

	return agent
		.split(/[-_]/g)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength - 1)}…`;
}

function formatShortTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return timestamp;
	}

	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${month}-${day} ${hours}:${minutes}`;
}

function buildDurationDetail(card: SessionTreeCard): { description: string; tooltip: string } | undefined {
	const durationMs = resolveDurationMs(card);
	if (durationMs === undefined) {
		return undefined;
	}

	const lines = [`Duration: ${formatDuration(durationMs)}`];
	if (card.startedAt) {
		lines.push(`Started: ${card.startedAt}`);
	}
	if (card.lastActivityAt) {
		lines.push(`Last active: ${card.lastActivityAt}`);
	}

	return {
		description: formatDuration(durationMs),
		tooltip: lines.join("\n"),
	};
}

function buildAttributionDetail(attribution: InitialAttribution | undefined): { description: string; tooltip: string } | undefined {
	if (!attribution) {
		return undefined;
	}

	const description = `${formatPercentage(attribution.agentPercentage)} agent · ${attribution.agentLines}/${attribution.totalCommitted} lines`;
	const tooltipLines = [
		`Agent authored: ${attribution.agentLines}/${attribution.totalCommitted} committed lines (${formatPercentage(attribution.agentPercentage)})`,
		`Human added: ${attribution.humanAdded}`,
		`Human modified: ${attribution.humanModified}`,
		`Human removed: ${attribution.humanRemoved}`,
	];

	if (attribution.calculatedAt) {
		tooltipLines.push(`Calculated: ${attribution.calculatedAt}`);
	}

	return {
		description,
		tooltip: tooltipLines.join("\n"),
	};
}

function resolveDurationMs(card: SessionTreeCard): number | undefined {
	if (typeof card.durationMs === "number" && Number.isFinite(card.durationMs) && card.durationMs > 0) {
		return card.durationMs;
	}

	const derivedDurationMs = deriveDurationFromTimestamps(card.startedAt, card.lastActivityAt);
	if (derivedDurationMs !== undefined) {
		return derivedDurationMs;
	}

	if (typeof card.durationMs === "number" && Number.isFinite(card.durationMs) && card.durationMs === 0) {
		return 0;
	}

	return undefined;
}

function deriveDurationFromTimestamps(startedAt: string | undefined, lastActivityAt: string | undefined): number | undefined {
	if (!startedAt || !lastActivityAt) {
		return undefined;
	}

	const startedAtMs = Date.parse(startedAt);
	const lastActivityAtMs = Date.parse(lastActivityAt);
	if (Number.isNaN(startedAtMs) || Number.isNaN(lastActivityAtMs) || lastActivityAtMs < startedAtMs) {
		return undefined;
	}

	return lastActivityAtMs - startedAtMs;
}

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (days > 0) {
		return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	}

	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}

	if (minutes > 0) {
		return seconds > 0 && minutes < 10 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}

	return `${seconds}s`;
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}

	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}k`;
	}

	return String(count);
}

function formatPercentage(value: number): string {
	if (!Number.isFinite(value)) {
		return "0%";
	}

	const fixed = value.toFixed(1);
	return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}%`;
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_{}\[\]()#+\-.!|]/g, "\\$&");
}

function sortCards(cards: SessionTreeCard[]): SessionTreeCard[] {
	return [...cards].sort((left, right) => {
		const leftTimestamp = Date.parse(left.lastActivityAt ?? left.startedAt ?? "");
		const rightTimestamp = Date.parse(right.lastActivityAt ?? right.startedAt ?? "");
		return (Number.isNaN(rightTimestamp) ? 0 : rightTimestamp) - (Number.isNaN(leftTimestamp) ? 0 : leftTimestamp);
	});
}

function buildInitialLoadState(): LoadState {
	return { kind: "ready" };
}

function hasCheckpointSelection(selection: CheckpointSessionSelection | undefined): selection is CheckpointSessionSelection {
	return !!selection && selection.checkpointId.length > 0;
}

function normalizeCheckpointSelection(selection: CheckpointSessionSelection | undefined): CheckpointSessionSelection | undefined {
	if (!selection) {
		return undefined;
	}

	const checkpointId = selection.checkpointId.trim();
	if (checkpointId.length === 0) {
		return undefined;
	}

	return {
		checkpointId,
		sessionPaths: selection.sessionPaths.filter((paths) => typeof paths.metadata === "string" && paths.metadata.length > 0),
		commitSha: selection.commitSha,
	};
}

function sameCheckpointSelection(
	left: CheckpointSessionSelection | undefined,
	right: CheckpointSessionSelection | undefined,
): boolean {
	if (!left && !right) {
		return true;
	}

	if (!left || !right) {
		return false;
	}

	if (left.commitSha !== right.commitSha || left.checkpointId !== right.checkpointId) {
		return false;
	}

	return sameSessionPaths(left.sessionPaths, right.sessionPaths);
}

function sameSessionPaths(left: SessionFilePaths[], right: SessionFilePaths[]): boolean {
	if (left.length !== right.length) {
		return false;
	}

	return left.every((paths, index) => {
		const other = right[index];
		return other?.metadata === paths.metadata
			&& other?.transcript === paths.transcript
			&& other?.context === paths.context
			&& other?.prompt === paths.prompt
			&& other?.contentHash === paths.contentHash;
	});
}

function adaptCheckpointSessionCard(card: EntireSessionCard): SessionTreeCard {
	return {
		sessionId: card.sessionId,
		status: card.status,
		promptPreview: card.promptPreview,
		agent: card.agent,
		model: card.model,
		author: card.author,
		startedAt: card.createdAt,
		lastActivityAt: card.lastActivityAt ?? card.createdAt,
		durationMs: card.durationMs,
		attribution: card.attribution,
		checkpointCount: card.checkpointCount,
		stepCount: card.stepCount,
		toolCount: card.toolCount,
		tokenCount: card.tokenCount,
		checkpointIds: [...card.checkpointIds],
		checkpointEntries: card.checkpointEntries,
		lastCheckpointId: card.latestCheckpointId,
		canOpenLastCheckpoint: typeof card.latestCheckpointId === "string" && card.latestCheckpointId.length > 0,
		canOpenTranscript: card.checkpointEntries?.some((entry) => typeof entry.session.transcript === "string" && entry.session.transcript.length > 0) ?? false,
		searchText: card.searchText,
	};
}
