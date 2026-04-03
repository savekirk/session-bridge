import * as vscode from "vscode";
import { EntireStatusState, EntireWorkspaceState } from "../workspaceProbe";
import { CheckpointDateGroup, listCheckpointSummaries, CommitCheckpointGroup, ResolvedCheckpointRef, totalTokenUsage, type CheckpointSummaryModel } from "../checkpoints";

const CONTEXT_CHECKPOINT_COMMITTED = "session-bridge-checkpoint-committed";
const CONTEXT_CHECKPOINT_EPHEMERAL = "session-bridge-checkpoint-ephemeral";
const CONTEXT_CHECKPOINT_DETAIL = "session-bridge-checkpoint-detail";

export interface CheckpointViewCommands {
	readonly refresh: string;
	readonly explainCheckpoint: string;
	readonly rewindInteractive: string;
	readonly openRawTranscript: string;
}

export class ToplevelCheckpointTreeItem extends vscode.TreeItem {
	constructor(
		public readonly card: CheckpointDateGroup,
		private readonly commands: CheckpointViewCommands,
	) {
		super(card.formattedDate, vscode.TreeItemCollapsibleState.Collapsed);

		const totalCommits = card.checkpointCommits.length;
		this.description = `[${card.checkpointCommits.length} ${totalCommits > 1 ? 'commits' : 'commit'}]`;
		this.tooltip = buildCheckpointTooltip(card);
		this.iconPath = new vscode.ThemeIcon('clock');
		this.contextValue = CONTEXT_CHECKPOINT_COMMITTED;
	}
}

export class CheckpointTreeItem extends vscode.TreeItem {
	constructor(
		public readonly card: CommitCheckpointGroup,
		private readonly commands: CheckpointViewCommands,
	) {
		super(
			buildCheckpointLabel(card),
			hasChildren(card)
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);

		this.description = buildCheckpointDescription(card);
		this.tooltip = buildCommitTooltip(card);
		this.iconPath = new vscode.ThemeIcon('git-commit');
		this.contextValue = CONTEXT_CHECKPOINT_COMMITTED;

		this.command = {
			command: commands.explainCheckpoint,
			title: "Explain Checkpoint",
			arguments: [card],
		};
	}
}

class CheckpointDetailItem extends vscode.TreeItem {
	constructor(label: string, description: string, icon: string, tooltip?: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.tooltip = tooltip ?? `${label}: ${description}`;
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = CONTEXT_CHECKPOINT_DETAIL;
	}
}

class EmptyStateItem extends vscode.TreeItem {
	constructor(label: string, icon: string, tooltip?: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.tooltip = tooltip;
		this.iconPath = new vscode.ThemeIcon(icon);
		this.contextValue = "session-bridge-checkpoint-empty";
	}
}

/** Maximum time (ms) to wait for checkpoint data before showing a timeout error. */
const LOAD_TIMEOUT_MS = 50_000;

type LoadState =
	| { kind: "ready" }
	| { kind: "loading" }
	| { kind: "loaded"; cards: CheckpointDateGroup[] }
	| { kind: "error"; message: string };

export class CheckpointTreeViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	private workspaceState: EntireWorkspaceState;
	private repoPath: string | undefined;
	private loadState: LoadState = { kind: "ready" };
	private loadGeneration = 0;

	constructor(
		workspaceState: EntireWorkspaceState,
		repoPath: string | undefined,
		private readonly commands: CheckpointViewCommands,
		private readonly outputChannel?: vscode.OutputChannel,
	) {
		this.workspaceState = workspaceState;
		this.repoPath = repoPath;
		this.debug(`constructor: state=${workspaceState.state}, repoPath=${repoPath ?? "(none)"}`);
	}

	private debug(message: string): void {
		this.outputChannel?.appendLine(`[checkpoints] ${message}`);
	}

	/**
	 * Update workspace state without reloading checkpoint data.
	 * Re-renders the tree so enabled/disabled transitions take effect
	 * while preserving any already-loaded checkpoint cards.
	 */
	setWorkspaceState(workspaceState: EntireWorkspaceState, repoPath: string | undefined): void {
		const repoChanged = this.repoPath !== repoPath;
		const enabledChanged = this.workspaceState.state !== workspaceState.state;
		this.debug(`setWorkspaceState: state=${workspaceState.state}, repoPath=${repoPath ?? "(none)"}, loadState=${this.loadState.kind}, repoChanged=${repoChanged}`);
		this.workspaceState = workspaceState;
		this.repoPath = repoPath;

		if (repoChanged || enabledChanged) {
			this.loadGeneration++;
			this.loadState = { kind: "ready" };
		}

		this.changeEmitter.fire();
	}

	/**
	 * Lightweight re-render: fires onDidChangeTreeData so VS Code
	 * re-calls getChildren with the current cached state.
	 * Does NOT spawn any CLI processes.
	 */
	refresh(): void {
		this.debug(`refresh: loadState=${this.loadState.kind}`);
		this.changeEmitter.fire();
	}

	/**
	 * Full reload: discard cached cards and spawn CLI processes to
	 * re-read checkpoint data. Only call on explicit user action.
	 */
	reload(): void {
		this.loadGeneration++;
		const gen = this.loadGeneration;
		this.loadState = { kind: "ready" };

		if (this.workspaceState.state !== EntireStatusState.ENABLED || !this.repoPath) {
			this.debug(`reload: skipped (state=${this.workspaceState.state}, repoPath=${this.repoPath ?? "(none)"}), gen=${gen}`);
			this.changeEmitter.fire();
			return;
		}

		this.debug(`reload: starting background load, gen=${gen}, repoPath=${this.repoPath}`);
		this.startBackgroundLoad(this.repoPath);
		this.changeEmitter.fire();
	}

	/** Return the most recently loaded checkpoint cards. */
	getCards(): ReadonlyArray<CheckpointDateGroup> {
		return this.loadState.kind === "loaded" ? this.loadState.cards : [];
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
		if (element instanceof ToplevelCheckpointTreeItem) {
			return buildCommitCheckpointItems(element.card.checkpointCommits, this.commands);
		}

		if (element instanceof CheckpointTreeItem) {
			return buildChildItems(element.card);
		}

		if (this.workspaceState.state !== EntireStatusState.ENABLED) {
			this.debug(`getChildren: disabled state=${this.workspaceState.state}`);
			return buildDisabledItems(this.workspaceState, this.commands);
		}

		if (!this.repoPath) {
			this.debug("getChildren: no repoPath");
			return [new EmptyStateItem("No workspace folder", "folder", "Open a folder to see checkpoints.")];
		}

		this.debug(`getChildren: loadState=${this.loadState.kind}${this.loadState.kind === "loaded" ? `, cards=${this.loadState.cards.length}` : ""}${this.loadState.kind === "error" ? `, error=${this.loadState.message}` : ""}`);

		switch (this.loadState.kind) {
			case "ready":
				this.debug(`getChildren: auto-starting initial load, gen=${this.loadGeneration}, repoPath=${this.repoPath}`);
				this.startBackgroundLoad(this.repoPath);
				return [new EmptyStateItem("Loading checkpoints\u2026", "loading~spin")];

			case "loading":
				return [new EmptyStateItem("Loading checkpoints\u2026", "loading~spin")];

			case "error":
				return [
					new EmptyStateItem(this.loadState.message, "warning", "An error occurred while reading checkpoint data. Try refreshing."),
					buildRefreshAction(this.commands),
				];

			case "loaded": {
				if (this.loadState.cards.length === 0) {
					return [
						new EmptyStateItem(
							"No checkpoints on this branch",
							"history",
							"Committed checkpoints and rewind-only points will appear here.",
						),
						buildRefreshAction(this.commands),
					];
				}
				return this.loadState.cards.map((card) => new ToplevelCheckpointTreeItem(card, this.commands));
			}
		}
	}

	/**
	 * Runs checkpoint summary loading in the background. When done it updates loadState
	 * and fires onDidChangeTreeData so VS Code re-calls getChildren with the result.
	 */
	private startBackgroundLoad(repoPath: string): void {
		const generation = this.loadGeneration;
		this.loadState = { kind: "loading" };
		const startTime = Date.now();
		this.debug(`startBackgroundLoad: gen=${generation}, timeout=${LOAD_TIMEOUT_MS}ms`);

		const work = listCheckpointSummaries(repoPath);
		const timeout = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("Checkpoint load timed out")), LOAD_TIMEOUT_MS);
		});

		Promise.race([work, timeout])
			.then((cards) => {
				const elapsed = Date.now() - startTime;
				if (this.loadGeneration !== generation) {
					this.debug(`startBackgroundLoad: stale gen=${generation} (current=${this.loadGeneration}), discarding ${cards.length} cards after ${elapsed}ms`);
					return;
				}
				this.debug(`startBackgroundLoad: success, gen=${generation}, ${cards.length} cards in ${elapsed}ms`);
				this.loadState = { kind: "loaded", cards };
				this.changeEmitter.fire();
			})
			.catch((error) => {
				const elapsed = Date.now() - startTime;
				if (this.loadGeneration !== generation) {
					this.debug(`startBackgroundLoad: stale gen=${generation} (current=${this.loadGeneration}), ignoring error after ${elapsed}ms: ${error}`);
					return;
				}
				const message = error instanceof Error ? error.message : "Failed to load checkpoints";
				this.debug(`startBackgroundLoad: error, gen=${generation}, ${elapsed}ms: ${message}`);
				this.loadState = { kind: "error", message };
				this.changeEmitter.fire();
			});
	}
}

function buildCheckpointLabel(card: CommitCheckpointGroup): string {
	return `[${card.commit.shortSha}]`;
}

function buildCheckpointDescription(card: CommitCheckpointGroup): string {
	return card.commit.message;
}

function buildCheckpointTooltip(card: CheckpointDateGroup): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.isTrusted = false;
	tooltip.supportThemeIcons = true;

	tooltip.appendMarkdown(`**Date:** ${card.formattedDate}\n\n`);

	const commitCount = card.checkpointCommits.length;
	tooltip.appendMarkdown(`**Commits:** ${commitCount}\n\n`);

	const allFiles = new Set<string>();
	let totalTokens = 0;
	let hasTokens = false;
	let totalSessions = 0;
	let checkpointCount = 0;

	for (const committedCheckpoint of card.checkpointCommits) {
		checkpointCount += committedCheckpoint.checkpoints.length;
		for (const checkpoint of committedCheckpoint.checkpoints) {
			if (checkpoint.summary) {
				for (const file of checkpoint.summary.filesTouched) {
					allFiles.add(file);
				}
				totalSessions += checkpoint.summary.sessions.length;
				const tokens = totalTokenUsage(checkpoint.summary.tokenUsage);
				if (typeof tokens === "number") {
					totalTokens += tokens;
					hasTokens = true;
				}
			}
		}
	}

	if (checkpointCount > 0) {
		tooltip.appendMarkdown(`**Checkpoints:** ${checkpointCount}\n\n`);
	}

	if (totalSessions > 0) {
		tooltip.appendMarkdown(`**Sessions:** ${totalSessions}\n\n`);
	}

	if (hasTokens) {
		tooltip.appendMarkdown(`**Tokens:** ${formatTokenCount(totalTokens)}\n\n`);
	}

	if (allFiles.size > 0) {
		tooltip.appendMarkdown(`**Files touched:** ${allFiles.size}\n\n`);
	}

	return tooltip;
}

function buildCommitTooltip(card: CommitCheckpointGroup): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.isTrusted = false;
	tooltip.supportThemeIcons = true;

	tooltip.appendMarkdown(`**Commit:** \`${escapeMarkdown(card.commit.shortSha)}\`\n\n`);
	tooltip.appendMarkdown(`**Message:** ${escapeMarkdown(card.commit.message)}\n\n`);

	if (card.commit.authorName) {
		tooltip.appendMarkdown(`**Author:** ${escapeMarkdown(card.commit.authorName)}\n\n`);
	}

	if (card.commit.authoredAt) {
		tooltip.appendMarkdown(`**Authored:** ${escapeMarkdown(formatShortTimestamp(card.commit.authoredAt))}\n\n`);
	}

	tooltip.appendMarkdown(`**Checkpoints:** ${card.checkpoints.length}\n\n`);

	let totalSessions = 0;
	let totalTokens = 0;
	let hasTokens = false;
	const filesTouched = new Set<string>();

	for (const checkpoint of card.checkpoints) {
		if (!checkpoint.summary) {
			continue;
		}

		totalSessions += checkpoint.summary.sessions.length;
		for (const file of checkpoint.summary.filesTouched) {
			filesTouched.add(file);
		}

		const tokens = totalTokenUsage(checkpoint.summary.tokenUsage);
		if (typeof tokens === "number") {
			totalTokens += tokens;
			hasTokens = true;
		}
	}

	if (totalSessions > 0) {
		tooltip.appendMarkdown(`**Sessions:** ${totalSessions}\n\n`);
	}

	if (filesTouched.size > 0) {
		tooltip.appendMarkdown(`**Files touched:** ${filesTouched.size}\n\n`);
	}

	if (card.diffSummary) {
		const parts = [`${card.diffSummary.filesChanged} file(s)`];
		if (typeof card.diffSummary.linesAdded === "number") {
			parts.push(`+${card.diffSummary.linesAdded}`);
		}
		if (typeof card.diffSummary.linesRemoved === "number") {
			parts.push(`-${card.diffSummary.linesRemoved}`);
		}
		tooltip.appendMarkdown(`**Changes:** ${parts.join(", ")}\n\n`);
	}

	if (hasTokens) {
		tooltip.appendMarkdown(`**Tokens:** ${formatTokenCount(totalTokens)}\n\n`);
	}

	return tooltip;
}

function hasChildren(card: CommitCheckpointGroup): boolean {
	return buildCommitDetailRows(card).length > 0;
}

function buildCommitCheckpointItems(committedCheckpoints: CommitCheckpointGroup[], commands: CheckpointViewCommands): vscode.TreeItem[] {
	return committedCheckpoints.map((committed) => new CheckpointTreeItem(committed, commands));
}
function buildChildItems(card: CommitCheckpointGroup): vscode.TreeItem[] {
	return buildCommitDetailRows(card).map((detail) => new CheckpointDetailItem(
		detail.label,
		detail.description,
		detail.icon,
		detail.tooltip,
	));
}

function buildCommitDetailRows(card: CommitCheckpointGroup): Array<{
	label: string;
	description: string;
	icon: string;
	tooltip?: string;
}> {
	const rows: Array<{
		label: string;
		description: string;
		icon: string;
		tooltip?: string;
	}> = [];
	const checkpoint = selectRepresentativeCheckpoint(card);
	const summary = checkpoint?.summary;

	if (card.commit.authorName) {
		rows.push({
			label: "Author",
			description: card.commit.authorName,
			icon: "person",
		});
	}

	rows.push({
		label: "Checkpoints",
		description: `${card.checkpoints.length}`,
		icon: "history",
	});

	const changeParts: string[] = [];
	if (card.diffSummary) {
		changeParts.push(`${card.diffSummary.filesChanged} file(s)`);
		if (typeof card.diffSummary.linesAdded === "number") {
			changeParts.push(`+${card.diffSummary.linesAdded}`);
		}
		if (typeof card.diffSummary.linesRemoved === "number") {
			changeParts.push(`-${card.diffSummary.linesRemoved}`);
		}
	} else if (summary) {
		changeParts.push(`${summary.filesTouched.length} file(s)`);
	}

	if (changeParts.length > 0) {
		rows.push({
			label: "Changes",
			description: changeParts.join(", "),
			icon: "diff",
		});
	}

	const tokenCount = summary ? totalTokenUsage(summary.tokenUsage) : undefined;
	if (typeof tokenCount === "number") {
		rows.push({
			label: "Tokens",
			description: formatTokenCount(tokenCount),
			icon: "symbol-number",
		});
	}

	return rows;
}

function selectRepresentativeCheckpoint(card: CommitCheckpointGroup): ResolvedCheckpointRef | undefined {
	return card.checkpoints.find((entry) => entry.summary !== null) ?? card.checkpoints.at(0);
}

function buildDisabledItems(
	workspaceState: EntireWorkspaceState,
	commands: CheckpointViewCommands,
): vscode.TreeItem[] {
	switch (workspaceState.state) {
		case EntireStatusState.CLI_MISSING:
			return [new EmptyStateItem("Entire CLI not found", "warning", "Install the Entire CLI and refresh.")];
		case EntireStatusState.NOT_GIT_REPO:
			return [new EmptyStateItem("Not a Git repository", "repo", "Open a Git repository to see checkpoints.")];
		case EntireStatusState.DISABLED:
		default:
			return [
				new EmptyStateItem("Entire not enabled", "circle-slash", "Enable Entire in this repository to see checkpoints."),
				buildRefreshAction(commands),
			];
	}
}

function buildRefreshAction(commands: CheckpointViewCommands): vscode.TreeItem {
	const item = new vscode.TreeItem("Refresh", vscode.TreeItemCollapsibleState.None);
	item.iconPath = new vscode.ThemeIcon("refresh");
	item.command = { command: commands.refresh, title: "Refresh" };
	item.contextValue = "session-bridge-checkpoint-action";
	return item;
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength - 1)}\u2026`;
}

function formatShortTimestamp(timestamp: string): string {
	try {
		const date = new Date(timestamp);
		if (isNaN(date.getTime())) {
			return timestamp;
		}
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const hours = String(date.getHours()).padStart(2, "0");
		const minutes = String(date.getMinutes()).padStart(2, "0");
		return `${month}-${day} ${hours}:${minutes}`;
	} catch {
		return timestamp;
	}
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
