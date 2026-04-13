import * as vscode from "vscode";
import type { EntireSessionDetailModel, SessionDetailTarget } from "../checkpoints";

const PANEL_VIEW_TYPE = "session.bridge.entire.sessionDetails";
const PANEL_TITLE = "Session Details";

export type SessionDetailsViewState =
	| {
		kind: "loading";
		promptPreview: string;
		sessionId: string;
	}
	| {
		kind: "detail";
		detail: EntireSessionDetailModel;
	}
	| {
		kind: "error";
		message: string;
	};

export class SessionDetailsPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;

	constructor(private readonly outputChannel?: vscode.OutputChannel) { }

	showLoading(target: SessionDetailTarget): void {
		this.render({
			kind: "loading",
			promptPreview: target.promptPreview,
			sessionId: target.sessionId,
		});
	}

	showDetail(detail: EntireSessionDetailModel): void {
		this.render({
			kind: "detail",
			detail,
		});
	}

	showError(message: string): void {
		this.render({
			kind: "error",
			message,
		});
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}

	private render(state: SessionDetailsViewState): void {
		const panel = this.ensurePanel();
		panel.webview.html = renderSessionDetailsHtml(state, {
			cspSource: panel.webview.cspSource,
		});
	}

	private ensurePanel(): vscode.WebviewPanel {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Beside, true);
			return this.panel;
		}

		this.outputChannel?.appendLine("[session-details] creating webview panel");
		this.panel = vscode.window.createWebviewPanel(
			PANEL_VIEW_TYPE,
			PANEL_TITLE,
			vscode.ViewColumn.Beside,
			{
				enableFindWidget: true,
				enableScripts: false,
				retainContextWhenHidden: false,
			},
		);
		this.panel.onDidDispose(() => {
			this.outputChannel?.appendLine("[session-details] panel disposed");
			this.panel = undefined;
		});
		return this.panel;
	}
}

export function renderSessionDetailsHtml(
	state: SessionDetailsViewState,
	options: { cspSource: string },
): string {
	const body = state.kind === "detail"
		? renderDetailState(state.detail)
		: state.kind === "loading"
			? renderStatusState("Loading session details…", state.promptPreview || state.sessionId)
			: renderStatusState("Could not load session details", state.message);

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.cspSource} data:; style-src ${options.cspSource} 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>${escapeHtml(PANEL_TITLE)}</title>
	<style>
		:root {
			color-scheme: light dark;
			--session-detail-avatar-size: 38px;
			--session-detail-max-width: 940px;
			--session-detail-row-gap: 14px;
			--session-detail-surface:
				linear-gradient(
					180deg,
					color-mix(in srgb, var(--vscode-editorWidget-background) 92%, black 8%),
					color-mix(in srgb, var(--vscode-editor-background) 96%, black 4%)
				);
			--session-detail-muted: color-mix(in srgb, var(--vscode-descriptionForeground) 88%, transparent);
			--session-detail-border: color-mix(in srgb, var(--vscode-panel-border) 78%, transparent);
			--session-detail-accent: color-mix(in srgb, var(--vscode-button-background) 82%, transparent);
			--session-detail-track: color-mix(in srgb, var(--vscode-editorWidget-background) 86%, black 14%);
			--session-detail-code-bg: color-mix(in srgb, black 80%, var(--vscode-editor-background) 20%);
		}

		* {
			box-sizing: border-box;
		}

		html, body {
			height: 100%;
			margin: 0;
			background:
				radial-gradient(circle at top, color-mix(in srgb, var(--vscode-button-background) 10%, transparent), transparent 32%),
				linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 96%, black 4%), var(--vscode-editor-background));
			color: var(--vscode-editor-foreground);
			font: var(--vscode-font-family);
		}

		body {
			overflow: hidden;
		}

		.layout {
			display: grid;
			grid-template-rows: minmax(0, 1fr);
			height: 100vh;
		}

		.summary {
			margin-bottom: 20px;
			padding: 28px 24px 18px;
			border: 1px solid var(--session-detail-border);
			border-radius: 22px;
			box-shadow:
				inset 0 1px 0 color-mix(in srgb, white 4%, transparent),
				0 10px 24px color-mix(in srgb, black 16%, transparent);
			background:
				linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 90%, black 10%), color-mix(in srgb, var(--vscode-editor-background) 96%, black 4%));
		}

		.summary__inner,
		.conversation__inner {
			width: min(var(--session-detail-max-width), 100%);
			margin: 0 auto;
		}

		.summary__top {
			display: flex;
			align-items: flex-start;
			gap: 16px;
			margin-bottom: 18px;
		}

		.summary__top:last-child {
			margin-bottom: 0;
		}

		.summary__headline {
			flex: 1 1 auto;
			min-width: 0;
		}

		.summary__eyebrow {
			margin: 0 0 8px;
			font-size: 11px;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--vscode-descriptionForeground);
		}

		.summary__title {
			margin: 0;
			font-size: 24px;
			line-height: 1.2;
			font-weight: 600;
			overflow-wrap: anywhere;
		}

		.status {
			margin-left: auto;
			padding: 7px 11px;
			border-radius: 999px;
			border: 1px solid color-mix(in srgb, var(--session-detail-accent) 55%, transparent);
			background: color-mix(in srgb, var(--session-detail-accent) 16%, transparent);
			font-size: 11px;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			white-space: nowrap;
			flex: 0 0 auto;
			align-self: flex-start;
		}

		.summary__meta {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
			gap: 12px 16px;
		}

		.meta-card {
			padding: 12px 14px;
			border-radius: 12px;
			background: color-mix(in srgb, var(--vscode-editorWidget-background) 84%, black 16%);
			border: 1px solid var(--session-detail-border);
			box-shadow: inset 0 1px 0 color-mix(in srgb, white 5%, transparent);
		}

		.meta-card__label {
			margin: 0 0 6px;
			font-size: 11px;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--session-detail-muted);
		}

		.meta-card__value {
			margin: 0;
			font-size: 13px;
			line-height: 1.45;
			word-break: break-word;
		}

		.conversation {
			display: grid;
			grid-template-rows: auto minmax(0, 1fr);
			min-height: 0;
		}

		.conversation__heading {
			padding: 14px 24px 10px;
			font-size: 11px;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--session-detail-muted);
			border-bottom: 1px solid color-mix(in srgb, var(--session-detail-border) 70%, transparent);
		}

		.conversation__scroll {
			overflow-y: auto;
			padding: 18px 24px 40px;
		}

		.turn {
			display: grid;
			grid-template-columns: auto 1fr;
			align-items: start;
			gap: var(--session-detail-row-gap);
			padding: 18px 0 24px;
			border-bottom: 1px solid color-mix(in srgb, var(--session-detail-border) 54%, transparent);
		}

		.turn:last-child {
			border-bottom: 0;
		}

		.turn--auxiliary-only {
			grid-template-columns: 1fr;
			gap: 0;
			padding-top: 12px;
		}

		.turn__rail {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 10px;
			padding-top: 3px;
		}

		.avatar {
			width: var(--session-detail-avatar-size);
			height: var(--session-detail-avatar-size);
			border-radius: 10px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border: 1px solid var(--session-detail-border);
			background: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, black 18%);
			font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--vscode-editor-foreground);
			overflow: hidden;
		}

		.turn--agent .avatar {
			background: color-mix(in srgb, var(--session-detail-accent) 26%, black 18%);
			border-color: color-mix(in srgb, var(--session-detail-accent) 58%, transparent);
		}

		.avatar img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}

		.avatar svg {
			width: 18px;
			height: 18px;
			display: block;
		}

		.timestamp {
			font-size: 11px;
			color: var(--session-detail-muted);
			white-space: nowrap;
		}

		.turn__content {
			display: grid;
			gap: 12px;
			min-width: 0;
			align-self: start;
		}

		.turn__content--auxiliary-only {
			gap: 0;
		}

		.turn__header {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 6px;
			min-height: var(--session-detail-avatar-size);
		}

		.turn__author {
			font-size: 11px;
			font-weight: 700;
			letter-spacing: 0.08em;
			color: var(--session-detail-muted);
		}

		.turn__dot {
			color: var(--session-detail-muted);
		}

		.message {
			border-radius: 16px;
			padding: 16px 18px;
			background: var(--session-detail-surface);
			border: 1px solid var(--session-detail-border);
			box-shadow:
				inset 0 1px 0 color-mix(in srgb, white 4%, transparent),
				0 10px 24px color-mix(in srgb, black 24%, transparent);
		}

		.message--user {
			background:
				linear-gradient(
					180deg,
					color-mix(in srgb, var(--vscode-editorWidget-background) 88%, black 12%),
					color-mix(in srgb, var(--vscode-editor-background) 96%, black 4%)
				);
		}

		.message--agent {
			border-color: color-mix(in srgb, var(--session-detail-accent) 24%, var(--session-detail-border) 76%);
		}

		.message__text {
			margin: 0;
			font-size: 14px;
			line-height: 1.75;
			white-space: pre-wrap;
			word-break: break-word;
		}

		.turn__auxiliary {
			display: grid;
			gap: 10px;
		}

		.auxiliary {
			border-radius: 14px;
			border: 1px solid var(--session-detail-border);
			background: color-mix(in srgb, var(--vscode-editorWidget-background) 84%, black 16%);
			overflow: hidden;
		}

		.auxiliary[open] {
			box-shadow: 0 12px 24px color-mix(in srgb, black 20%, transparent);
		}

		.auxiliary__summary {
			list-style: none;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 12px 14px;
			cursor: pointer;
			background:
				linear-gradient(
					180deg,
					color-mix(in srgb, var(--vscode-editor-background) 84%, black 16%),
					color-mix(in srgb, var(--vscode-editorWidget-background) 90%, black 10%)
				);
		}

		.auxiliary__summary::-webkit-details-marker {
			display: none;
		}

		.auxiliary__heading {
			display: flex;
			align-items: center;
			gap: 10px;
			min-width: 0;
		}

		.auxiliary__chevron {
			font-size: 11px;
			color: var(--session-detail-muted);
			transition: transform 120ms ease;
		}

		.auxiliary[open] .auxiliary__chevron {
			transform: rotate(90deg);
		}

		.auxiliary__icon {
			width: 24px;
			height: 24px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			border-radius: 8px;
			background: color-mix(in srgb, var(--session-detail-accent) 14%, transparent);
			color: color-mix(in srgb, white 84%, var(--session-detail-accent) 16%);
			border: 1px solid color-mix(in srgb, var(--session-detail-accent) 34%, transparent);
			flex: 0 0 auto;
		}

		.auxiliary__icon svg {
			width: 14px;
			height: 14px;
			display: block;
		}

		.auxiliary__label-group {
			display: grid;
			gap: 2px;
			min-width: 0;
		}

		.auxiliary__eyebrow {
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--session-detail-muted);
		}

		.auxiliary__label {
			font-size: 13px;
			font-weight: 600;
			word-break: break-word;
		}

		.auxiliary__badge {
			padding: 4px 8px;
			border-radius: 999px;
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--session-detail-muted);
			border: 1px solid color-mix(in srgb, var(--session-detail-border) 90%, transparent);
			background: color-mix(in srgb, var(--vscode-editor-background) 78%, black 22%);
			flex: 0 0 auto;
		}

		.auxiliary__badge--success {
			color: var(--vscode-terminal-ansiGreen);
			border-color: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 40%, transparent);
			background: color-mix(in srgb, var(--vscode-terminal-ansiGreen) 10%, transparent);
		}

		.auxiliary__badge--error {
			color: var(--vscode-errorForeground);
			border-color: color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent);
			background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
		}

		.auxiliary__panel {
			padding: 0 14px 14px;
			border-top: 1px solid color-mix(in srgb, var(--session-detail-border) 78%, transparent);
		}

		.auxiliary__text,
		.auxiliary__code {
			margin: 0;
			padding: 14px 16px;
			border-radius: 12px;
			white-space: pre-wrap;
			word-break: break-word;
			line-height: 1.65;
		}

		.auxiliary__text {
			background: color-mix(in srgb, var(--vscode-editor-background) 74%, black 26%);
			font-size: 13px;
		}

		.auxiliary__code {
			background: var(--session-detail-code-bg);
			font-size: 12px;
			font-family: var(--vscode-editor-font-family);
			line-height: 1.7;
			overflow-x: auto;
		}

		.auxiliary--thinking .auxiliary__icon {
			background: color-mix(in srgb, var(--vscode-textPreformat-foreground) 10%, transparent);
			border-color: color-mix(in srgb, var(--vscode-textPreformat-foreground) 30%, transparent);
			color: var(--vscode-textPreformat-foreground);
		}

		.auxiliary--output .auxiliary__icon {
			background: color-mix(in srgb, var(--vscode-terminal-ansiBlue) 12%, transparent);
			border-color: color-mix(in srgb, var(--vscode-terminal-ansiBlue) 28%, transparent);
			color: var(--vscode-terminal-ansiBlue);
		}

		.auxiliary--tool_use .auxiliary__icon {
			background: color-mix(in srgb, var(--session-detail-accent) 14%, transparent);
		}

		.empty {
			padding: 32px 20px;
			color: var(--session-detail-muted);
			font-size: 13px;
			line-height: 1.6;
			border-radius: 14px;
			border: 1px solid var(--session-detail-border);
			background: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, black 18%);
		}

		@media (max-width: 760px), (max-height: 720px) {
			.summary {
				margin-bottom: 18px;
				padding: 16px 16px 14px;
				border-radius: 18px;
			}

			.conversation__heading {
				padding: 12px 16px 8px;
			}

			.conversation__scroll {
				padding: 14px 16px 32px;
			}

			.summary__top {
				flex-direction: column;
				align-items: stretch;
				gap: 10px;
			}

			.summary__eyebrow {
				display: none;
			}

			.summary__title {
				font-size: 18px;
				line-height: 1.3;
			}

			.status {
				margin-left: 0;
				align-self: flex-start;
				padding: 6px 10px;
			}

			.summary__meta {
				display: flex;
				gap: 8px;
				overflow-x: auto;
				overscroll-behavior-x: contain;
				padding: 2px 2px 4px;
				margin: 12px -2px -4px;
				scroll-snap-type: x proximity;
			}

			.meta-card {
				flex: 0 0 min(76vw, 240px);
				padding: 10px 12px;
				border-radius: 14px;
				scroll-snap-align: start;
			}

			.meta-card__label {
				margin-bottom: 4px;
			}

			.meta-card__value {
				font-size: 12px;
				line-height: 1.4;
			}
		}
	</style>
</head>
<body>
	${body}
</body>
</html>`;
}

function renderDetailState(detail: EntireSessionDetailModel): string {
	const includeDayInTimestamp = shouldIncludeDayInTimestamp(detail.durationMs);
	const statsParts = [
		`${detail.checkpointCount} checkpoint${detail.checkpointCount === 1 ? "" : "s"}`,
		typeof detail.turnCount === "number" ? `${detail.turnCount} turn${detail.turnCount === 1 ? "" : "s"}` : undefined,
		typeof detail.toolCount === "number" ? `${detail.toolCount} tool${detail.toolCount === 1 ? "" : "s"}` : undefined,
		typeof detail.tokenCount === "number" ? `${formatTokenCount(detail.tokenCount)} tokens` : undefined,
	].filter((part): part is string => typeof part === "string");

	const metaCards = [
		renderMetaCard("Session ID", detail.sessionId),
		renderMetaCard("Source", detail.source === "live" ? "Live session" : "Checkpoint snapshot"),
		renderMetaCard("User", formatUserSummary(detail)),
		renderMetaCard("Started", formatSummaryTimestamp(detail.startedAt)),
		renderMetaCard("Last Active", formatSummaryTimestamp(detail.lastActivityAt)),
		renderMetaCard("Duration", formatDuration(detail.durationMs)),
		renderMetaCard("Agent", formatAgentSummary(detail)),
		renderMetaCard("Stats", statsParts.join(" · ")),
		renderMetaCard("Attribution", formatAttribution(detail)),
	].filter((card): card is string => typeof card === "string");
	const summary = renderSummary({
		title: detail.promptPreview || detail.sessionId,
		status: detail.status,
		metaCards,
	});
	const content = detail.turns.length > 0
		? renderConversation(detail, includeDayInTimestamp)
		: `<div class="empty">${escapeHtml(detail.transcriptAvailable ? "No readable transcript turns were found." : "No transcript is available for this session.")}</div>`;

	return renderPanelLayout(summary, content);
}

function renderStatusState(title: string, message: string): string {
	return renderPanelLayout(
		renderSummary({
			title,
		}),
		`<div class="empty">${escapeHtml(message)}</div>`,
	);
}

function renderPanelLayout(
	summary: string,
	content: string,
): string {
	return `<div class="layout">
	<section class="conversation">
		<div class="conversation__heading">Conversation</div>
		<div class="conversation__scroll">
			<div class="conversation__inner">
				${summary}
				${content}
			</div>
		</div>
	</section>
	</div>`;
}

function renderSummary(options: {
	title: string;
	status?: string;
	metaCards?: string[];
}): string {
	const header = renderSummaryHeader(options.title, options.status);
	const meta = options.metaCards && options.metaCards.length > 0
		? `<div class="summary__meta">${options.metaCards.join("")}</div>`
		: "";

	return `<header class="summary">
		<div class="summary__inner">
			${header}
			${meta}
		</div>
	</header>`;
}

function renderSummaryHeader(title: string, status?: string): string {
	return `<div class="summary__top">
		<div class="summary__headline">
			<p class="summary__eyebrow">Session Details</p>
			<h1 class="summary__title">${escapeHtml(title)}</h1>
		</div>
		${status ? `<span class="status">${escapeHtml(status)}</span>` : ""}
	</div>`;
}

function renderMetaCard(label: string, value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	return `<div class="meta-card">
		<p class="meta-card__label">${escapeHtml(label)}</p>
		<p class="meta-card__value">${escapeHtml(value)}</p>
	</div>`;
}

function renderConversation(detail: EntireSessionDetailModel, includeDayInTimestamp: boolean): string {
	return detail.turns
		.filter((turn) => Boolean(turn.text) || getAuxiliaryBlocks(turn).length > 0)
		.map((turn) => renderTurn(turn, includeDayInTimestamp))
		.join("");
}

function renderTurn(turn: EntireSessionDetailModel["turns"][number], includeDayInTimestamp: boolean): string {
	const timestampLabel = formatDetailTimestamp(turn.timestamp, includeDayInTimestamp);
	const auxiliaryBlocks = getAuxiliaryBlocks(turn);
	const hasPrimaryMessage = Boolean(turn.text?.trim());
	const showActorChrome = turn.actor.kind === "user" || hasPrimaryMessage;
	const turnClassName = [
		"turn",
		`turn--${escapeHtml(turn.actor.kind)}`,
		showActorChrome ? undefined : "turn--auxiliary-only",
	].filter((part): part is string => typeof part === "string").join(" ");

	return `<article class="${turnClassName}">
		${showActorChrome ? `<div class="turn__rail">
			${renderAvatar(turn.actor)}
		</div>` : ""}
		<div class="turn__content${showActorChrome ? "" : " turn__content--auxiliary-only"}">
			${showActorChrome ? `<div class="turn__header">
				<span class="turn__author">${escapeHtml(formatActorLabel(turn.actor))}</span>
				${timestampLabel ? `<span class="turn__dot">•</span><time class="timestamp">${escapeHtml(timestampLabel)}</time>` : ""}
			</div>` : ""}
			${turn.text ? `<div class="message message--${escapeHtml(turn.actor.kind)}"><p class="message__text">${escapeHtml(turn.text)}</p></div>` : ""}
			${auxiliaryBlocks.length > 0 ? `<div class="turn__auxiliary">${auxiliaryBlocks.map((block) => renderAuxiliaryBlock(block)).join("")}</div>` : ""}
		</div>
	</article>`;
}

function renderAvatar(actor: EntireSessionDetailModel["turns"][number]["actor"]): string {
	if (actor.imageUri) {
		return `<span class="avatar"><img src="${escapeHtml(actor.imageUri)}" alt="" /></span>`;
	}

	return `<span class="avatar" aria-hidden="true">${renderActorIcon(actor.kind)}</span>`;
}

function renderAuxiliaryBlock(
	block: NonNullable<EntireSessionDetailModel["turns"][number]["auxiliaryBlocks"]>[number],
): string {
	const heading = getAuxiliaryHeading(block);
	const badge = block.tone === "success"
		? "Success"
		: block.tone === "error"
			? "Error"
			: undefined;
	const detail = block.detail && block.detail.length > 0
		? block.display === "code"
			? `<pre class="auxiliary__code">${escapeHtml(block.detail)}</pre>`
			: `<div class="auxiliary__text">${escapeHtml(block.detail)}</div>`
		: `<div class="auxiliary__text">No details available.</div>`;

	return `<details class="auxiliary auxiliary--${escapeHtml(block.kind)}">
		<summary class="auxiliary__summary">
			<span class="auxiliary__heading">
				<span class="auxiliary__chevron" aria-hidden="true">›</span>
				<span class="auxiliary__icon" aria-hidden="true">${renderAuxiliaryIcon(block.kind)}</span>
				<span class="auxiliary__label-group">
					${heading.eyebrow ? `<span class="auxiliary__eyebrow">${escapeHtml(heading.eyebrow)}</span>` : ""}
					<span class="auxiliary__label">${escapeHtml(heading.label)}</span>
				</span>
			</span>
			${badge ? `<span class="auxiliary__badge auxiliary__badge--${escapeHtml(block.tone ?? "default")}">${escapeHtml(badge)}</span>` : ""}
		</summary>
		<div class="auxiliary__panel">
			${detail}
		</div>
	</details>`;
}

function renderAuxiliaryIcon(kind: "thinking" | "tool_use" | "output"): string {
	if (kind === "thinking") {
		return `<svg viewBox="0 0 16 16" fill="none" role="presentation" focusable="false">
			<path d="M8 2.25a4.75 4.75 0 0 0-2.8 8.59c.39.28.8.83.8 1.41v.5h4v-.5c0-.58.41-1.13.8-1.4A4.75 4.75 0 0 0 8 2.25Z" stroke="currentColor" stroke-width="1.2"/>
			<path d="M6.5 14h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
		</svg>`;
	}

	if (kind === "output") {
		return `<svg viewBox="0 0 16 16" fill="none" role="presentation" focusable="false">
			<path d="M2.5 3.25h11v9.5h-11z" stroke="currentColor" stroke-width="1.2" rx="1.25"/>
			<path d="M4.75 6.5 6.5 8 4.75 9.5M7.75 9.5h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
		</svg>`;
	}

	return `<svg viewBox="0 0 16 16" fill="none" role="presentation" focusable="false">
		<path d="M9.58 2.5a2.88 2.88 0 0 0 3.92 3.92l-2.55 2.55 1.08 1.08a1.5 1.5 0 0 1-2.12 2.12l-1.08-1.08-2.99 2.99a1.25 1.25 0 1 1-1.77-1.77l2.99-2.99-1.08-1.08a1.5 1.5 0 1 1 2.12-2.12l1.08 1.08 2.4-2.4Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
	</svg>`;
}

function getAuxiliaryHeading(
	block: NonNullable<EntireSessionDetailModel["turns"][number]["auxiliaryBlocks"]>[number],
): { eyebrow?: string; label: string } {
	if (block.kind === "tool_use") {
		return {
			label: `Tool: ${block.label}`,
		};
	}

	return {
		eyebrow: formatAuxiliaryKindLabel(block.kind),
		label: block.label,
	};
}

function getAuxiliaryBlocks(
	turn: EntireSessionDetailModel["turns"][number],
): NonNullable<EntireSessionDetailModel["turns"][number]["auxiliaryBlocks"]> {
	if (turn.auxiliaryBlocks && turn.auxiliaryBlocks.length > 0) {
		return turn.auxiliaryBlocks;
	}

	return turn.toolActivities.map((activity) => ({
		id: activity.id,
		kind: "tool_use" as const,
		label: activity.label,
		detail: activity.detail,
		display: "code" as const,
	}));
}

function formatActorLabel(actor: EntireSessionDetailModel["turns"][number]["actor"]): string {
	return sanitizeDisplayLabel(actor.name) ?? (actor.kind === "user" ? "User" : "Agent");
}

function renderActorIcon(kind: "user" | "agent"): string {
	if (kind === "user") {
		return `<svg viewBox="0 0 16 16" fill="none" role="presentation" focusable="false">
			<path d="M8 8a2.38 2.38 0 1 0 0-4.75A2.38 2.38 0 0 0 8 8Zm-4.5 4.75A4.5 4.5 0 0 1 8 9.75a4.5 4.5 0 0 1 4.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
		</svg>`;
	}

	return `<svg viewBox="0 0 16 16" fill="none" role="presentation" focusable="false">
		<rect x="3.25" y="4.25" width="9.5" height="7.5" rx="1.75" stroke="currentColor" stroke-width="1.2"/>
		<path d="M6 7.5h4M6.5 10h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
		<path d="M5.5 4V2.75M10.5 4V2.75" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
	</svg>`;
}

function formatAuxiliaryKindLabel(kind: "thinking" | "tool_use" | "output"): string {
	switch (kind) {
		case "thinking":
			return "Thinking";
		case "output":
			return "Command Output";
		case "tool_use":
		default:
			return "Tool Execution";
	}
}

function formatAgentSummary(detail: EntireSessionDetailModel): string | undefined {
	const agentName = sanitizeDisplayLabel(detail.agent)
		?? detail.turns.find((turn) => turn.actor.kind === "agent")?.actor.name;
	const normalizedAgentName = sanitizeDisplayLabel(agentName);
	const normalizedModel = sanitizeDisplayLabel(detail.model);

	if (!normalizedAgentName && !normalizedModel) {
		return undefined;
	}

	if (!normalizedAgentName) {
		return normalizedModel;
	}

	if (!normalizedModel || normalizedModel.toLowerCase() === normalizedAgentName.toLowerCase()) {
		return normalizedAgentName;
	}

	return `${normalizedAgentName} (${normalizedModel})`;
}

function formatUserSummary(detail: EntireSessionDetailModel): string | undefined {
	return sanitizeDisplayLabel(detail.user)
		?? sanitizeDisplayLabel(detail.turns.find((turn) => turn.actor.kind === "user")?.actor.name);
}

function formatDetailTimestamp(timestamp: string | undefined, includeDayInTimestamp: boolean): string | undefined {
	if (!timestamp) {
		return undefined;
	}

	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return timestamp;
	}

	return new Intl.DateTimeFormat("en", includeDayInTimestamp ? {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	} : {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

function formatSummaryTimestamp(timestamp: string | undefined): string | undefined {
	if (!timestamp) {
		return undefined;
	}

	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return timestamp;
	}

	return new Intl.DateTimeFormat("en", {
		month: "long",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

function shouldIncludeDayInTimestamp(durationMs: number | undefined): boolean {
	return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 86_400_000;
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
		return undefined;
	}

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

function formatAttribution(detail: EntireSessionDetailModel): string | undefined {
	if (!detail.attribution) {
		return undefined;
	}

	return `${formatPercentage(detail.attribution.agentPercentage)} agent · ${detail.attribution.agentLines}/${detail.attribution.totalCommitted} lines`;
}

function formatPercentage(value: number): string {
	if (!Number.isFinite(value)) {
		return "0%";
	}

	const fixed = value.toFixed(1);
	return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}%`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function sanitizeDisplayLabel(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value.trim();
	if (normalized.length === 0) {
		return undefined;
	}

	if (normalized.toLowerCase() === "undefined" || normalized.toLowerCase() === "null") {
		return undefined;
	}

	return normalized;
}
