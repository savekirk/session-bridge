import * as vscode from "vscode";
import { listActiveSessions, type EntireActiveSessionCard } from "../checkpoints";
import { EntireStatusState, type EntireWorkspaceState } from "../workspaceProbe";

const CONTEXT_SESSION = "session-bridge-active-session";
const CONTEXT_DETAIL = "session-bridge-active-session-detail";
const CONTEXT_ACTION = "session-bridge-active-session-action";
const LOAD_TIMEOUT_MS = 50_000;

export interface ActiveSessionViewCommands {
	readonly refresh: string;
	readonly showStatus: string;
	readonly explainCheckpoint: string;
	readonly runDoctor: string;
}

type LoadState =
	| { kind: "ready" }
	| { kind: "loading" }
	| { kind: "loaded"; cards: EntireActiveSessionCard[] }
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

export class ActiveSessionTreeItem extends vscode.TreeItem {
	constructor(
		public readonly card: EntireActiveSessionCard,
	) {
		super(buildSessionIdentity(card), vscode.TreeItemCollapsibleState.Collapsed);
		this.description = card.status;
		this.tooltip = buildSessionTooltip(card);
		this.iconPath = new vscode.ThemeIcon(selectSessionIcon(card));
		this.contextValue = CONTEXT_SESSION;
	}
}

export class ActiveSessionTreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	private workspaceState: EntireWorkspaceState;
	private repoPath: string | undefined;
	private loadState: LoadState;
	private loadGeneration = 0;

	constructor(
		workspaceState: EntireWorkspaceState,
		repoPath: string | undefined,
		private readonly commands: ActiveSessionViewCommands,
		private readonly outputChannel?: vscode.OutputChannel,
		private readonly loadSessions: (repoPath: string) => Promise<EntireActiveSessionCard[]> = listActiveSessions,
	) {
		this.workspaceState = workspaceState;
		this.repoPath = repoPath;
		this.loadState = workspaceState.state === EntireStatusState.ENABLED && workspaceState.activeSessions.length > 0
			? { kind: "loaded", cards: sortCards(workspaceState.activeSessions) }
			: { kind: "ready" };
		this.debug(`constructor: state=${workspaceState.state}, repoPath=${repoPath ?? "(none)"}`);
	}

	private debug(message: string): void {
		this.outputChannel?.appendLine(`[active-sessions] ${message}`);
	}

	setWorkspaceState(workspaceState: EntireWorkspaceState, repoPath: string | undefined): void {
		const previousState = this.workspaceState;
		const repoChanged = this.repoPath !== repoPath;
		const enabledChanged = previousState.state !== workspaceState.state;
		const sessionSnapshotChanged = !sameSessionSnapshot(previousState.activeSessions, workspaceState.activeSessions);
		this.workspaceState = workspaceState;
		this.repoPath = repoPath;
		this.debug(`setWorkspaceState: state=${workspaceState.state}, repoPath=${repoPath ?? "(none)"}, repoChanged=${repoChanged}, enabledChanged=${enabledChanged}, sessionSnapshotChanged=${sessionSnapshotChanged}, loadState=${this.loadState.kind}`);

		if (repoChanged || enabledChanged) {
			this.loadGeneration++;
			this.loadState = workspaceState.state === EntireStatusState.ENABLED && workspaceState.activeSessions.length > 0
				? { kind: "loaded", cards: sortCards(workspaceState.activeSessions) }
				: { kind: "ready" };
		} else if (workspaceState.state === EntireStatusState.ENABLED && sessionSnapshotChanged) {
			// Keep the tree aligned with passive workspace probes without forcing another live-state read.
			this.loadState = { kind: "loaded", cards: sortCards(workspaceState.activeSessions) };
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
		this.loadState = { kind: "ready" };

		if (this.workspaceState.state !== EntireStatusState.ENABLED || !this.repoPath) {
			this.debug(`reload: skipped (state=${this.workspaceState.state}, repoPath=${this.repoPath ?? "(none)"}), gen=${generation}`);
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
		if (element instanceof ActiveSessionTreeItem) {
			return buildSessionChildItems(element.card, this.commands);
		}

		if (this.workspaceState.state !== EntireStatusState.ENABLED) {
			return buildDisabledItems(this.workspaceState, this.commands);
		}

		if (!this.repoPath) {
			return [new EmptyStateItem("No workspace folder", "folder", "Open a folder to see active sessions.")];
		}

		switch (this.loadState.kind) {
			case "ready":
				this.debug(`getChildren: auto-starting initial load, gen=${this.loadGeneration}, repoPath=${this.repoPath}`);
				this.startBackgroundLoad(this.repoPath);
				return [new EmptyStateItem("Loading active sessions…", "loading~spin")];

			case "loading":
				return [new EmptyStateItem("Loading active sessions…", "loading~spin")];

			case "error":
				return [
					new EmptyStateItem(this.loadState.message, "warning", "An error occurred while reading live session state. Try refreshing."),
					buildRefreshAction(this.commands),
					buildShowStatusAction(this.commands),
				];

			case "loaded":
				if (this.loadState.cards.length === 0) {
					return [
						new EmptyStateItem("No active sessions", "play-circle", "Current branch session activity will appear here."),
						buildRefreshAction(this.commands),
					];
				}

				return this.loadState.cards.map((card) => new ActiveSessionTreeItem(card));
		}
	}

	private startBackgroundLoad(repoPath: string): void {
		const generation = this.loadGeneration;
		this.loadState = { kind: "loading" };
		const startTime = Date.now();
		this.debug(`startBackgroundLoad: gen=${generation}, timeout=${LOAD_TIMEOUT_MS}ms`);

		const work = this.loadSessions(repoPath);
		const timeout = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("Active session load timed out")), LOAD_TIMEOUT_MS);
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

				const message = error instanceof Error ? error.message : "Failed to load active sessions";
				this.debug(`startBackgroundLoad: error, gen=${generation}, ${elapsed}ms: ${message}`);
				this.loadState = { kind: "error", message };
				this.changeEmitter.fire();
			});
	}
}

function buildSessionChildItems(card: EntireActiveSessionCard, commands: ActiveSessionViewCommands): vscode.TreeItem[] {
	const items: vscode.TreeItem[] = [
		new SessionDetailItem("Prompt", truncate(card.promptPreview, 96), "comment-discussion", card.promptPreview),
	];

	if (card.startedAt) {
		items.push(new SessionDetailItem(
			"Started",
			formatShortTimestamp(card.startedAt),
			"clock",
			card.startedAt,
		));
	}

	if (card.lastInteractionAt) {
		items.push(new SessionDetailItem(
			"Last Active",
			formatShortTimestamp(card.lastInteractionAt),
			"history",
			card.lastInteractionAt,
		));
	}

	if (card.author) {
		items.push(new SessionDetailItem("Author", card.author, "person"));
	}

	const stats = buildStats(card);
	if (stats) {
		items.push(new SessionDetailItem("Stats", stats, "graph"));
	}

	if (card.isStuck) {
		items.push(new SessionDetailItem(
			"Warning",
			card.status === "ACTIVE" ? "Session may be stuck" : "Session needs recovery attention",
			"warning",
			"Entire doctor can diagnose and recover stale live session state.",
		));
	}

	if (card.canOpenLastCheckpoint && card.lastCheckpointId) {
		items.push(new SessionActionItem(
			"Open Last Checkpoint",
			"history",
			{
				command: commands.explainCheckpoint,
				title: "Open Last Checkpoint",
				arguments: [{
					checkpointId: card.lastCheckpointId,
					sessionId: card.sessionId,
				}],
			},
		));
	}

	if (card.canOpenTranscript && card.transcriptPath) {
		items.push(new SessionActionItem(
			"Open Live Transcript",
			"file",
			{
				command: "vscode.open",
				title: "Open Live Transcript",
				arguments: [vscode.Uri.file(card.transcriptPath)],
			},
			truncate(card.transcriptPath, 42),
		));
	}

	if (card.canRunDoctor) {
		items.push(new SessionActionItem(
			"Run Doctor",
			"search",
			{
				command: commands.runDoctor,
				title: "Run Doctor",
			},
		));
	}

	return items;
}

function buildDisabledItems(
	workspaceState: EntireWorkspaceState,
	commands: ActiveSessionViewCommands,
): vscode.TreeItem[] {
	switch (workspaceState.state) {
		case EntireStatusState.CLI_MISSING:
			return [new EmptyStateItem("Entire CLI not found", "warning", "Install the Entire CLI and refresh.")];
		case EntireStatusState.NOT_GIT_REPO:
			return [new EmptyStateItem("Not a Git repository", "repo", "Open a Git repository to see active sessions.")];
		case EntireStatusState.DISABLED:
		default:
			return [
				new EmptyStateItem("Entire not enabled", "circle-slash", "Enable Entire in this repository to see active sessions."),
				buildRefreshAction(commands),
			];
	}
}

function buildRefreshAction(commands: ActiveSessionViewCommands): vscode.TreeItem {
	return new SessionActionItem("Refresh", "refresh", { command: commands.refresh, title: "Refresh" });
}

function buildShowStatusAction(commands: ActiveSessionViewCommands): vscode.TreeItem {
	return new SessionActionItem("Show Raw CLI Status", "output", { command: commands.showStatus, title: "Show Raw CLI Status" });
}

function buildSessionIdentity(card: EntireActiveSessionCard): string {
	const identity = [
		formatAgentName(card.agent) ?? "Unknown Agent",
		card.model ? `(${card.model})` : undefined,
		"·",
		shortSessionId(card.sessionId),
	].filter((part): part is string => typeof part === "string");

	return identity.join(" ");
}

function buildSessionTooltip(card: EntireActiveSessionCard): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.isTrusted = false;
	tooltip.supportThemeIcons = true;

	tooltip.appendMarkdown(`**Session:** \`${escapeMarkdown(card.sessionId)}\`\n\n`);
	tooltip.appendMarkdown(`**Status:** ${escapeMarkdown(card.status)}\n\n`);
	tooltip.appendMarkdown(`**Prompt:** ${escapeMarkdown(card.promptPreview)}\n\n`);

	if (card.agent) {
		tooltip.appendMarkdown(`**Agent:** ${escapeMarkdown(card.agent)}\n\n`);
	}

	if (card.model) {
		tooltip.appendMarkdown(`**Model:** ${escapeMarkdown(card.model)}\n\n`);
	}

	if (card.startedAt) {
		tooltip.appendMarkdown(`**Started:** ${escapeMarkdown(card.startedAt)}\n\n`);
	}

	if (card.lastInteractionAt) {
		tooltip.appendMarkdown(`**Last Active:** ${escapeMarkdown(card.lastInteractionAt)}\n\n`);
	}

	if (typeof card.tokenCount === "number") {
		tooltip.appendMarkdown(`**Tokens:** ${formatTokenCount(card.tokenCount)}\n\n`);
	}

	if (card.checkpointCount > 0) {
		tooltip.appendMarkdown(`**Checkpoints:** ${card.checkpointCount}\n\n`);
	}

	if (card.isStuck) {
		tooltip.appendMarkdown(`**Warning:** Session may be stuck\n\n`);
	}

	return tooltip;
}

function buildStats(card: EntireActiveSessionCard): string | undefined {
	const parts: string[] = [];

	if (typeof card.tokenCount === "number") {
		parts.push(`${formatTokenCount(card.tokenCount)} tokens`);
	}

	if (card.checkpointCount > 0) {
		parts.push(`${card.checkpointCount} checkpoint${card.checkpointCount === 1 ? "" : "s"}`);
	}

	if (typeof card.turnCount === "number") {
		parts.push(`${card.turnCount} turn${card.turnCount === 1 ? "" : "s"}`);
	}

	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function selectSessionIcon(card: EntireActiveSessionCard): string {
	if (card.isStuck) {
		return "warning";
	}

	return card.status === "ACTIVE" ? "pulse" : "clock";
}

function shortSessionId(sessionId: string): string {
	return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
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

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}

	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}k`;
	}

	return String(count);
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_{}\[\]()#+\-.!|]/g, "\\$&");
}

function sortCards(cards: EntireActiveSessionCard[]): EntireActiveSessionCard[] {
	return [...cards].sort((left, right) => {
		const leftTimestamp = Date.parse(left.lastInteractionAt ?? left.startedAt ?? "");
		const rightTimestamp = Date.parse(right.lastInteractionAt ?? right.startedAt ?? "");
		return (Number.isNaN(rightTimestamp) ? 0 : rightTimestamp) - (Number.isNaN(leftTimestamp) ? 0 : leftTimestamp);
	});
}

function sameSessionSnapshot(left: EntireActiveSessionCard[], right: EntireActiveSessionCard[]): boolean {
	if (left.length !== right.length) {
		return false;
	}

	for (let index = 0; index < left.length; index += 1) {
		const leftCard = left[index];
		const rightCard = right[index];
		if (
			leftCard?.sessionId !== rightCard?.sessionId
			|| leftCard?.status !== rightCard?.status
			|| leftCard?.lastInteractionAt !== rightCard?.lastInteractionAt
			|| leftCard?.promptPreview !== rightCard?.promptPreview
		) {
			return false;
		}
	}

	return true;
}
