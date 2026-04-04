import * as vscode from "vscode";
import {
	getCheckpointDetail,
	getCommitDetail,
	getRawExplainOutput,
	getRawTranscript,
	type CheckpointDetailModel,
	type CommitDetailModel,
	type RewindAvailability,
} from "../checkpoints";

export interface ExplainPanelTarget {
	commitSha?: string;
	checkpointId?: string;
	sessionId?: string;
}

export interface CheckpointDetailPanelContext {
	repoPath: string;
	outputChannel?: vscode.OutputChannel;
}

export interface RewindTarget {
	checkpointId?: string;
	rewindPointId?: string;
	isLogsOnly: boolean;
}

type PanelView =
	| { kind: "loading"; title: string; subtitle?: string }
	| { kind: "commit"; target: ExplainPanelTarget; detail: CommitDetailModel }
	| { kind: "checkpoint"; target: ExplainPanelTarget; detail: CheckpointDetailModel }
	| {
		kind: "raw";
		target: ExplainPanelTarget;
		title: string;
		subtitle?: string;
		label: string;
		body: string;
		backTarget?: ExplainPanelTarget;
	};

type WebviewMessage =
	| { type: "close" }
	| { type: "copy"; value: string }
	| { type: "open-checkpoint"; checkpointId?: string }
	| { type: "open-raw-transcript"; checkpointId?: string; sessionId?: string }
	| { type: "rewind"; checkpointId?: string; rewindPointId?: string; isLogsOnly?: boolean }
	| { type: "back"; commitSha?: string; checkpointId?: string; sessionId?: string };

export async function openCheckpointDetailPanel(
	target: ExplainPanelTarget,
	context: CheckpointDetailPanelContext,
): Promise<void> {
	await CheckpointDetailPanel.reveal(target, context);
}

export async function openCheckpointRawTranscriptPanel(
	target: ExplainPanelTarget,
	context: CheckpointDetailPanelContext,
): Promise<void> {
	await CheckpointDetailPanel.revealRawTranscript(target, context);
}

export async function launchCheckpointRewind(
	target: RewindTarget,
	context: CheckpointDetailPanelContext,
): Promise<void> {
	const rewindTarget = target.checkpointId ?? target.rewindPointId;
	if (!rewindTarget) {
		await vscode.window.showWarningMessage("Rewind target could not be resolved.");
		return;
	}

	const actionLabel = target.isLogsOnly ? "Open Terminal and Restore Logs" : "Open Terminal and Continue";
	const detail = target.isLogsOnly
		? "This will hand off to Entire's native logs-only rewind flow in the terminal."
		: "This may restore files and remove untracked files depending on repo state. Entire's native rewind flow will run in the terminal.";
	const choice = await vscode.window.showWarningMessage(
		`Rewind to ${rewindTarget}? ${detail}`,
		{ modal: true },
		actionLabel,
	);
	if (choice !== actionLabel) {
		return;
	}

	const command = [
		"entire",
		"rewind",
		"--to",
		shellQuote(rewindTarget),
		...(target.isLogsOnly ? ["--logs-only"] : []),
	].join(" ");
	context.outputChannel?.appendLine(`[rewind] ${command}`);

	const terminal = vscode.window.createTerminal({
		name: "Entire: Rewind",
		cwd: context.repoPath,
	});
	terminal.show(true);
	terminal.sendText(command, true);
}

class CheckpointDetailPanel {
	private static currentPanel: CheckpointDetailPanel | undefined;

	static async reveal(target: ExplainPanelTarget, context: CheckpointDetailPanelContext): Promise<void> {
		if (CheckpointDetailPanel.currentPanel) {
			CheckpointDetailPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
			await CheckpointDetailPanel.currentPanel.showStructuredTarget(target, context.repoPath);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"entireExplain",
			"Checkpoint Details",
			vscode.ViewColumn.Active,
			{
				enableFindWidget: true,
				enableScripts: true,
			},
		);

		CheckpointDetailPanel.currentPanel = new CheckpointDetailPanel(panel, context.repoPath, context.outputChannel);
		await CheckpointDetailPanel.currentPanel.showStructuredTarget(target, context.repoPath);
	}

	static async revealRawTranscript(target: ExplainPanelTarget, context: CheckpointDetailPanelContext): Promise<void> {
		if (CheckpointDetailPanel.currentPanel) {
			CheckpointDetailPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
			await CheckpointDetailPanel.currentPanel.showRawTranscript(target);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"entireExplain",
			"Checkpoint Details",
			vscode.ViewColumn.Active,
			{
				enableFindWidget: true,
				enableScripts: true,
			},
		);

		CheckpointDetailPanel.currentPanel = new CheckpointDetailPanel(panel, context.repoPath, context.outputChannel);
		await CheckpointDetailPanel.currentPanel.showRawTranscript(target);
	}

	private currentView: PanelView | undefined;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private repoPath: string,
		private readonly outputChannel?: vscode.OutputChannel,
	) {
		this.panel.onDidDispose(() => {
			if (CheckpointDetailPanel.currentPanel === this) {
				CheckpointDetailPanel.currentPanel = undefined;
			}
		});

		this.panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
			await this.handleMessage(message);
		});
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case "close":
				this.panel.dispose();
				return;
			case "copy":
				await vscode.env.clipboard.writeText(message.value);
				return;
			case "open-checkpoint":
				if (message.checkpointId) {
					await this.showStructuredTarget({ checkpointId: message.checkpointId }, this.repoPath);
				}
				return;
			case "open-raw-transcript":
				if (message.checkpointId) {
					await this.showRawTranscript({
						checkpointId: message.checkpointId,
						sessionId: message.sessionId,
					});
				}
				return;
			case "rewind":
				await this.launchRewind({
					checkpointId: message.checkpointId,
					rewindPointId: message.rewindPointId,
					isLogsOnly: message.isLogsOnly === true,
				});
				return;
			case "back":
				await this.showStructuredTarget(
					{
						commitSha: message.commitSha,
						checkpointId: message.checkpointId,
						sessionId: message.sessionId,
					},
					this.repoPath,
				);
				return;
		}
	}

	private async showStructuredTarget(target: ExplainPanelTarget, repoPath: string): Promise<void> {
		this.repoPath = repoPath;
		this.updateView({
			kind: "loading",
			title: target.commitSha ? `Commit ${target.commitSha}` : `Checkpoint ${target.checkpointId ?? ""}`.trim(),
			subtitle: "Loading details…",
		});

		if (target.commitSha) {
			const detail = await getCommitDetail(repoPath, target.commitSha);
			if (detail) {
				this.updateView({ kind: "commit", target, detail });
				return;
			}

			await this.showRawExplain(
				target,
				`Commit ${target.commitSha}`,
				`Commit ${target.commitSha} is not available as structured detail. Showing raw Entire output.`,
			);
			return;
		}

		if (target.checkpointId) {
			const detail = await getCheckpointDetail(repoPath, target.checkpointId);
			if (detail) {
				this.updateView({ kind: "checkpoint", target, detail });
				return;
			}

			await this.showRawExplain(
				target,
				`Checkpoint ${target.checkpointId}`,
				`Checkpoint ${target.checkpointId} is not available as structured detail. Showing raw Entire output.`,
			);
			return;
		}

		await vscode.window.showWarningMessage("Checkpoint detail could not be opened.");
	}

	private async showRawExplain(
		target: ExplainPanelTarget,
		title: string,
		subtitle?: string,
		backTarget?: ExplainPanelTarget,
	): Promise<void> {
		this.updateView({ kind: "loading", title, subtitle: "Loading raw Entire output…" });
		const raw = await getRawExplainOutput(this.repoPath, {
			commitSha: target.commitSha,
			checkpointId: target.checkpointId,
		});

		this.updateView({
			kind: "raw",
			target,
			title,
			subtitle,
			label: "RAW ENTIRE OUTPUT",
			body: raw ?? "No raw Entire output is available for this target.",
			backTarget,
		});
	}

	private async showRawTranscript(target: ExplainPanelTarget): Promise<void> {
		if (!target.checkpointId) {
			await vscode.window.showWarningMessage("Raw transcript could not be opened.");
			return;
		}

		this.updateView({
			kind: "loading",
			title: `Checkpoint ${target.checkpointId}`,
			subtitle: "Loading raw transcript…",
		});
		const transcript = await getRawTranscript(this.repoPath, target.checkpointId, target.sessionId);
		const rawBody = transcript ?? await getRawExplainOutput(this.repoPath, {
			checkpointId: target.checkpointId,
			fullTranscript: true,
		});
		const backTarget = this.currentView && this.currentView.kind !== "raw" && this.currentView.kind !== "loading"
			? this.currentView.target
			: undefined;

		this.updateView({
			kind: "raw",
			target,
			title: `Checkpoint ${target.checkpointId}`,
			subtitle: "Committed transcript when available, with CLI fallback.",
			label: "RAW TRANSCRIPT",
			body: rawBody ?? "No raw transcript is available for this checkpoint.",
			backTarget,
		});
	}

	private async launchRewind(target: {
		checkpointId?: string;
		rewindPointId?: string;
		isLogsOnly: boolean;
	}): Promise<void> {
		await launchCheckpointRewind(target, {
			repoPath: this.repoPath,
			outputChannel: this.outputChannel,
		});
	}

	private updateView(view: PanelView): void {
		this.currentView = view;
		this.panel.title = "Checkpoint Details";
		this.panel.webview.html = renderDetailPanelHtml(view, this.panel.webview.cspSource);
	}
}

export function renderDetailPanelHtml(view: PanelView, cspSource: string, nonce = getNonce()): string {
	const body = view.kind === "loading"
		? renderLoadingView(view)
		: view.kind === "commit"
		? renderCommitView(view.detail)
		: view.kind === "checkpoint"
			? renderCheckpointView(view.detail)
			: renderRawView(view);

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
	/>
	<title>Checkpoint Details</title>
	<style>
		:root {
			color-scheme: light dark;
		}

		* {
			box-sizing: border-box;
		}

		body {
			margin: 0;
			font-family: var(--vscode-font-family);
			font-size: 13px;
			line-height: 1.5;
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
		}

		button,
		input,
		textarea {
			font: inherit;
		}

		.panel {
			min-height: 100vh;
			padding-bottom: 24px;
		}

		.header {
			position: sticky;
			top: 0;
			z-index: 10;
			padding: 16px 20px 14px;
			border-bottom: 1px solid var(--vscode-panel-border);
			background: color-mix(in srgb, var(--vscode-editor-background) 86%, transparent);
			backdrop-filter: blur(8px);
		}

		.header-top {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			margin-bottom: 14px;
		}

		.eyebrow {
			font-size: 11px;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--vscode-descriptionForeground);
		}

		.icon-button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 28px;
			height: 28px;
			border: 1px solid transparent;
			border-radius: 8px;
			background: transparent;
			color: var(--vscode-descriptionForeground);
			cursor: pointer;
		}

		.icon-button:hover,
		.icon-button:focus-visible {
			border-color: var(--vscode-focusBorder);
			color: var(--vscode-editor-foreground);
			outline: none;
		}

		.title {
			margin: 0;
			font-size: 26px;
			line-height: 1.2;
			font-weight: 600;
		}

		.subtitle {
			margin: 6px 0 0;
			color: var(--vscode-descriptionForeground);
			max-width: 72ch;
		}

		.meta-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
			gap: 12px;
			margin-top: 16px;
		}

		.meta-item {
			padding: 10px 12px;
			border: 1px solid var(--vscode-widget-border);
			border-radius: 12px;
			background: color-mix(in srgb, var(--vscode-sideBar-background) 72%, transparent);
		}

		.meta-label {
			display: block;
			margin-bottom: 4px;
			font-size: 11px;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--vscode-descriptionForeground);
		}

		.meta-value {
			display: flex;
			align-items: center;
			gap: 8px;
			font-weight: 600;
			word-break: break-word;
		}

		.badge-row {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-top: 16px;
		}

		.badge {
			display: inline-flex;
			align-items: center;
			padding: 4px 10px;
			border-radius: 999px;
			font-size: 12px;
			line-height: 1;
			color: var(--vscode-badge-foreground);
			background: var(--vscode-badge-background);
		}

		.tabs {
			display: flex;
			gap: 8px;
			padding: 0 20px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}

		.tab {
			position: relative;
			padding: 14px 2px;
			border: none;
			background: transparent;
			color: var(--vscode-descriptionForeground);
			cursor: pointer;
		}

		.tab[aria-selected="true"] {
			color: var(--vscode-editor-foreground);
		}

		.tab[aria-selected="true"]::after {
			content: "";
			position: absolute;
			right: 0;
			bottom: -1px;
			left: 0;
			height: 2px;
			border-radius: 999px;
			background: var(--vscode-textLink-foreground);
		}

		.content {
			padding: 20px;
		}

		.tab-panel[hidden] {
			display: none;
		}

		.stack {
			display: grid;
			gap: 18px;
		}

		.section {
			padding: 18px;
			border: 1px solid var(--vscode-widget-border);
			border-radius: 16px;
			background: color-mix(in srgb, var(--vscode-sideBar-background) 76%, transparent);
		}

		.section-title {
			margin: 0 0 14px;
			font-size: 11px;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--vscode-descriptionForeground);
		}

		.summary-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
			gap: 12px;
		}

		.summary-item {
			display: grid;
			gap: 4px;
		}

		.summary-key {
			color: var(--vscode-descriptionForeground);
		}

		.summary-value {
			font-size: 22px;
			font-weight: 700;
		}

		.summary-value.added {
			color: var(--vscode-testing-iconPassed);
		}

		.summary-value.removed {
			color: var(--vscode-errorForeground);
		}

		.message {
			margin: 0;
			white-space: pre-wrap;
		}

		.checkpoint-list {
			display: grid;
			gap: 12px;
		}

		.checkpoint-card {
			padding: 16px;
			border-radius: 14px;
			border: 1px solid var(--vscode-widget-border);
			background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
		}

		.checkpoint-card-header {
			display: flex;
			align-items: start;
			justify-content: space-between;
			gap: 12px;
		}

		.checkpoint-card-title {
			margin: 0;
			font-size: 16px;
		}

		.checkpoint-card-meta {
			margin: 6px 0 0;
			color: var(--vscode-descriptionForeground);
		}

		.checkpoint-card-actions,
		.actions-row {
			display: flex;
			flex-wrap: wrap;
			gap: 10px;
			margin-top: 14px;
		}

		.action-button {
			padding: 8px 12px;
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 10px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			cursor: pointer;
		}

		.action-button.primary {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}

		.action-button:hover,
		.action-button:focus-visible,
		.icon-button:focus-visible,
		.tab:focus-visible {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: 2px;
		}

		.files-table {
			width: 100%;
			border-collapse: collapse;
		}

		.files-table th,
		.files-table td {
			padding: 10px 0;
			border-bottom: 1px solid var(--vscode-panel-border);
			text-align: left;
		}

		.files-table th {
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--vscode-descriptionForeground);
		}

		.numeric {
			width: 96px;
			text-align: right !important;
		}

		.added {
			color: var(--vscode-testing-iconPassed);
		}

		.removed {
			color: var(--vscode-errorForeground);
		}

		.code-block {
			margin: 0;
			padding: 16px;
			border-radius: 14px;
			overflow: auto;
			border: 1px solid var(--vscode-widget-border);
			background: color-mix(in srgb, var(--vscode-textCodeBlock-background) 86%, transparent);
			color: var(--vscode-editor-foreground);
			font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
			font-size: 12px;
			line-height: 1.6;
			white-space: pre-wrap;
			word-break: break-word;
		}

		.raw-shell {
			padding: 20px;
		}

		.raw-toolbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			margin-bottom: 16px;
		}

		.empty-state {
			color: var(--vscode-descriptionForeground);
		}
	</style>
</head>
<body>
	${body}
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
		const panels = Array.from(document.querySelectorAll('[data-panel]'));

		function activateTab(tabName) {
			for (const tab of tabs) {
				const selected = tab.dataset.tab === tabName;
				tab.setAttribute('aria-selected', String(selected));
				tab.tabIndex = selected ? 0 : -1;
			}
			for (const panel of panels) {
				panel.hidden = panel.dataset.panel !== tabName;
			}
		}

		if (tabs.length > 0) {
			activateTab('overview');
		}

		document.addEventListener('click', (event) => {
			const target = event.target.closest('[data-action], [role="tab"]');
			if (!target) {
				return;
			}

			if (target.getAttribute('role') === 'tab') {
				activateTab(target.dataset.tab);
				return;
			}

			const action = target.dataset.action;
			switch (action) {
				case 'close':
					vscode.postMessage({ type: 'close' });
					return;
			case 'copy':
				if (target.dataset.copyTarget) {
					const source = document.getElementById(target.dataset.copyTarget);
					vscode.postMessage({ type: 'copy', value: source?.textContent || '' });
					return;
				}
				vscode.postMessage({ type: 'copy', value: target.dataset.value || '' });
				return;
				case 'open-checkpoint':
					vscode.postMessage({ type: 'open-checkpoint', checkpointId: target.dataset.checkpointId });
					return;
				case 'open-raw-transcript':
					vscode.postMessage({
						type: 'open-raw-transcript',
						checkpointId: target.dataset.checkpointId,
						sessionId: target.dataset.sessionId,
					});
					return;
				case 'rewind':
					vscode.postMessage({
						type: 'rewind',
						checkpointId: target.dataset.checkpointId,
						rewindPointId: target.dataset.rewindPointId,
						isLogsOnly: target.dataset.logsOnly === 'true',
					});
					return;
				case 'back':
					vscode.postMessage({
						type: 'back',
						commitSha: target.dataset.commitSha,
						checkpointId: target.dataset.checkpointId,
						sessionId: target.dataset.sessionId,
					});
					return;
			}
		});
	</script>
</body>
</html>`;
}

function renderLoadingView(view: Extract<PanelView, { kind: "loading" }>): string {
	return `<div class="panel">
		<header class="header">
			<div class="header-top">
				<div class="eyebrow">Checkpoint Details</div>
				<button class="icon-button" type="button" data-action="close" aria-label="Close panel">×</button>
			</div>
			<h1 class="title">${escapeHtml(view.title)}</h1>
			${view.subtitle ? `<p class="subtitle">${escapeHtml(view.subtitle)}</p>` : ""}
		</header>
		<div class="content">
			<section class="section">
				<p class="empty-state">Loading detail data for this selection.</p>
			</section>
		</div>
	</div>`;
}

function renderCommitView(detail: CommitDetailModel): string {
	const linkedCheckpointMeta = detail.checkpoints.length === 1
		? renderMetaItem("Hash", detail.checkpoints[0].hash, detail.checkpoints[0].hash)
		: renderMetaItem("Checkpoints", `${detail.checkpoints.length}`, `${detail.checkpoints.length} linked checkpoints`);
	const singleCheckpoint = detail.checkpoints.length === 1 ? detail.checkpoints[0] : undefined;

	return `<div class="panel">
		<header class="header">
			<div class="header-top">
				<div class="eyebrow">Checkpoint Details</div>
				<button class="icon-button" type="button" data-action="close" aria-label="Close panel">×</button>
			</div>
			<h1 class="title">${escapeHtml(detail.title)}</h1>
			<p class="subtitle">${escapeHtml(detail.commit.message)}</p>
			<div class="meta-grid">
				${linkedCheckpointMeta}
				${renderMetaItem("Commit", detail.commit.shortSha, detail.commit.sha)}
				${renderMetaItem("Time", formatDateTime(detail.time), detail.time)}
				${renderMetaItem("User", detail.user)}
				${renderMetaItem("Branch", detail.branch)}
				${renderMetaItem("Tokens", formatTokenCount(detail.tokenCount))}
			</div>
			<div class="badge-row">
				${renderBadge(detail.agent)}
				${renderBadge(detail.model)}
				${renderStatusBadge(detail.status)}
			</div>
		</header>
		<nav class="tabs" aria-label="Checkpoint detail tabs">
			<button class="tab" type="button" role="tab" data-tab="overview" aria-selected="true">Overview</button>
			<button class="tab" type="button" role="tab" data-tab="files" aria-selected="false">Files (${detail.files.length})</button>
			<button class="tab" type="button" role="tab" data-tab="diff" aria-selected="false">Diff</button>
		</nav>
		<div class="content">
			<section class="tab-panel" data-panel="overview">
				<div class="stack">
					${renderSummarySection(detail.overview)}
					<section class="section">
						<h2 class="section-title">Commit Message</h2>
						<p class="message">${escapeHtml(detail.commit.body ? `${detail.commit.message}\n\n${detail.commit.body}` : detail.commit.message)}</p>
					</section>
					<section class="section">
						<h2 class="section-title">Linked Checkpoints</h2>
						<div class="checkpoint-list">
							${detail.checkpoints.map((checkpoint) => renderLinkedCheckpointCard(checkpoint)).join("")}
						</div>
					</section>
					${singleCheckpoint ? renderSingleCheckpointActions(singleCheckpoint) : ""}
				</div>
			</section>
			<section class="tab-panel" data-panel="files" hidden>
				${renderFilesSection(detail.files)}
			</section>
			<section class="tab-panel" data-panel="diff" hidden>
				${renderDiffSection(detail.diff.patchText)}
			</section>
		</div>
	</div>`;
}

function renderCheckpointView(detail: CheckpointDetailModel): string {
	return `<div class="panel">
		<header class="header">
			<div class="header-top">
				<div class="eyebrow">Checkpoint Details</div>
				<button class="icon-button" type="button" data-action="close" aria-label="Close panel">×</button>
			</div>
			<h1 class="title">${escapeHtml(detail.title)}</h1>
			<p class="subtitle">${escapeHtml(detail.promptPreview)}</p>
			<div class="meta-grid">
				${renderMetaItem("Hash", detail.hash, detail.hash)}
				${renderMetaItem("Commit", detail.primaryCommit?.shortSha, detail.primaryCommit?.sha)}
				${renderMetaItem("Time", formatDateTime(detail.time), detail.time)}
				${renderMetaItem("User", detail.user)}
				${renderMetaItem("Branch", detail.branch)}
				${renderMetaItem("Tokens", formatTokenCount(detail.tokenCount))}
			</div>
			<div class="badge-row">
				${renderBadge(detail.agent)}
				${renderBadge(detail.model)}
				${renderStatusBadge(detail.status)}
			</div>
		</header>
		<nav class="tabs" aria-label="Checkpoint detail tabs">
			<button class="tab" type="button" role="tab" data-tab="overview" aria-selected="true">Overview</button>
			<button class="tab" type="button" role="tab" data-tab="files" aria-selected="false">Files (${detail.files.length})</button>
			<button class="tab" type="button" role="tab" data-tab="diff" aria-selected="false">Diff</button>
		</nav>
		<div class="content">
			<section class="tab-panel" data-panel="overview">
				<div class="stack">
					${renderSummarySection(detail.overview)}
					<section class="section">
						<h2 class="section-title">Commit Message</h2>
						<p class="message">${escapeHtml(detail.primaryCommit?.body ? `${detail.primaryCommit.message}\n\n${detail.primaryCommit.body}` : detail.primaryCommit?.message ?? "No commit message available.")}</p>
					</section>
					${renderSingleCheckpointActions(detail)}
				</div>
			</section>
			<section class="tab-panel" data-panel="files" hidden>
				${renderFilesSection(detail.files)}
			</section>
			<section class="tab-panel" data-panel="diff" hidden>
				${renderDiffSection(detail.diff.patchText)}
			</section>
		</div>
	</div>`;
}

function renderRawView(view: Extract<PanelView, { kind: "raw" }>): string {
	const { text, truncated } = truncateForWebview(view.body, 200_000);
	const backButton = view.backTarget
		? `<button
				class="action-button"
				type="button"
				data-action="back"
				data-commit-sha="${escapeAttribute(view.backTarget.commitSha)}"
				data-checkpoint-id="${escapeAttribute(view.backTarget.checkpointId)}"
				data-session-id="${escapeAttribute(view.backTarget.sessionId)}"
			>Back to Details</button>`
		: "";

	return `<div class="panel">
		<header class="header">
			<div class="header-top">
				<div class="eyebrow">Checkpoint Details</div>
				<button class="icon-button" type="button" data-action="close" aria-label="Close panel">×</button>
			</div>
			<h1 class="title">${escapeHtml(view.title)}</h1>
			${view.subtitle ? `<p class="subtitle">${escapeHtml(view.subtitle)}</p>` : ""}
		</header>
		<div class="raw-shell">
			<div class="raw-toolbar">
				<div class="eyebrow">${escapeHtml(view.label)}</div>
				<div class="actions-row">
					${backButton}
					<button class="action-button" type="button" data-action="copy" data-copy-target="raw-output">Copy Output</button>
				</div>
			</div>
			${truncated ? `<p class="subtitle">Output was truncated for panel stability. Use the CLI explain command for the full body.</p>` : ""}
			<pre class="code-block" id="raw-output">${escapeHtml(text)}</pre>
		</div>
	</div>`;
}

function renderSummarySection(overview: {
	filesChanged?: number;
	linesAdded?: number;
	linesRemoved?: number;
	sessionCount: number;
}): string {
	return `<section class="section">
		<h2 class="section-title">Summary</h2>
		<div class="summary-grid">
			${renderSummaryItem("Files Changed", formatNumber(overview.filesChanged))}
			${renderSummaryItem("Lines Added", formatDelta(overview.linesAdded, true), "added")}
			${renderSummaryItem("Lines Removed", formatDelta(overview.linesRemoved, false), "removed")}
			${renderSummaryItem("Sessions", formatNumber(overview.sessionCount))}
		</div>
	</section>`;
}

function renderSingleCheckpointActions(detail: CheckpointDetailModel): string {
	const rewindButton = renderRewindButton(detail.rewindAvailability);
	const rawButton = detail.rawTranscriptAvailable
		? `<button
				class="action-button"
				type="button"
				data-action="open-raw-transcript"
				data-checkpoint-id="${escapeAttribute(detail.checkpointId)}"
			>View Raw Transcript</button>`
		: "";

	return `<section class="section">
		<h2 class="section-title">Actions</h2>
		<div class="actions-row">
			<button class="action-button" type="button" data-action="copy" data-value="${escapeAttribute(detail.hash)}">Copy Checkpoint ID</button>
			${rawButton}
			${rewindButton}
		</div>
	</section>`;
}

function renderLinkedCheckpointCard(detail: CheckpointDetailModel): string {
	const rewindButton = renderRewindButton(detail.rewindAvailability);
	const rawButton = detail.rawTranscriptAvailable
		? `<button
				class="action-button"
				type="button"
				data-action="open-raw-transcript"
				data-checkpoint-id="${escapeAttribute(detail.checkpointId)}"
			>Raw Transcript</button>`
		: "";

	return `<article class="checkpoint-card">
		<div class="checkpoint-card-header">
			<div>
				<h3 class="checkpoint-card-title">${escapeHtml(detail.title)}</h3>
				<p class="checkpoint-card-meta">
					${escapeHtml(detail.hash)}
					${detail.branch ? ` · ${escapeHtml(detail.branch)}` : ""}
					${detail.time ? ` · ${escapeHtml(formatDateTime(detail.time))}` : ""}
				</p>
			</div>
			<div class="badge-row">
				${renderBadge(detail.agent)}
				${renderStatusBadge(detail.status)}
			</div>
		</div>
		<div class="checkpoint-card-actions">
			<button
				class="action-button"
				type="button"
				data-action="open-checkpoint"
				data-checkpoint-id="${escapeAttribute(detail.checkpointId)}"
			>View Details</button>
			<button class="action-button" type="button" data-action="copy" data-value="${escapeAttribute(detail.hash)}">Copy ID</button>
			${rawButton}
			${rewindButton}
		</div>
	</article>`;
}

function renderRewindButton(rewind: RewindAvailability | undefined): string {
	if (!rewind?.isAvailable) {
		return "";
	}

	const label = rewind.isLogsOnly ? "Restore Logs" : "Rewind to Checkpoint";
	return `<button
		class="action-button primary"
		type="button"
		data-action="rewind"
		data-checkpoint-id="${escapeAttribute(rewind.checkpointId)}"
		data-rewind-point-id="${escapeAttribute(rewind.pointId)}"
		data-logs-only="${String(rewind.isLogsOnly)}"
	>${label}</button>`;
}

function renderFilesSection(files: Array<{ path: string; additions?: number; deletions?: number }>): string {
	if (files.length === 0) {
		return `<section class="section"><p class="empty-state">No file-level changes are available for this detail view.</p></section>`;
	}

	return `<section class="section">
		<h2 class="section-title">Files</h2>
		<table class="files-table">
			<thead>
				<tr>
					<th scope="col">Path</th>
					<th scope="col" class="numeric">Added</th>
					<th scope="col" class="numeric">Removed</th>
				</tr>
			</thead>
			<tbody>
				${files.map((file) => `<tr>
					<td>${escapeHtml(file.path)}</td>
					<td class="numeric added">${escapeHtml(formatDelta(file.additions, true))}</td>
					<td class="numeric removed">${escapeHtml(formatDelta(file.deletions, false))}</td>
				</tr>`).join("")}
			</tbody>
		</table>
	</section>`;
}

function renderDiffSection(patchText: string | undefined): string {
	if (!patchText) {
		return `<section class="section"><p class="empty-state">No diff is available for this selection.</p></section>`;
	}

	const { text, truncated } = truncateForWebview(patchText, 200_000);

	return `<section class="section">
		<h2 class="section-title">Diff</h2>
		${truncated ? `<p class="subtitle">Diff output was truncated for panel stability. Use raw explain for the full output.</p>` : ""}
		<pre class="code-block">${escapeHtml(text)}</pre>
	</section>`;
}

function renderMetaItem(label: string, value: string | undefined, title?: string): string {
	return `<div class="meta-item">
		<span class="meta-label">${escapeHtml(label)}</span>
		<span class="meta-value" title="${escapeAttribute(title ?? value)}">${escapeHtml(value ?? "Unknown")}</span>
	</div>`;
}

function renderSummaryItem(label: string, value: string, className = ""): string {
	const classes = className ? `summary-value ${className}` : "summary-value";
	return `<div class="summary-item">
		<div class="summary-key">${escapeHtml(label)}</div>
		<div class="${classes}">${escapeHtml(value)}</div>
	</div>`;
}

function renderBadge(value: string | undefined): string {
	if (!value) {
		return "";
	}

	return `<span class="badge">${escapeHtml(value)}</span>`;
}

function renderStatusBadge(status: string): string {
	return `<span class="badge">${escapeHtml(status)}</span>`;
}

function formatNumber(value: number | undefined): string {
	return typeof value === "number" ? value.toLocaleString() : "Unknown";
}

function formatDelta(value: number | undefined, positive: boolean): string {
	if (typeof value !== "number") {
		return "Unknown";
	}

	return `${positive ? "+" : "-"}${Math.abs(value).toLocaleString()}`;
}

function formatTokenCount(value: number | undefined): string {
	if (typeof value !== "number") {
		return "Unknown";
	}

	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}K`;
	}
	return value.toLocaleString();
}

function formatDateTime(value: string | undefined): string {
	if (!value) {
		return "Unknown";
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return value;
	}

	return new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(timestamp));
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("\"", "&quot;")
		.replaceAll("'", "&#39;");
}

function escapeAttribute(value: string | undefined): string {
	return escapeHtml(value ?? "");
}

function getNonce(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	for (let index = 0; index < 16; index += 1) {
		result += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return result;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncateForWebview(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (value.length <= maxChars) {
		return { text: value, truncated: false };
	}

	return {
		text: `${value.slice(0, maxChars)}\n\n[output truncated]`,
		truncated: true,
	};
}
