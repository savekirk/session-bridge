import * as vscode from 'vscode';
import { isEntireBinary, resolveEntireBinary } from './entireBinaryResolver';
import { probeEntireWorkspace } from './workspaceProbe';
import { createStatusBarItem, updateStatusBarItem } from './components/entireStatusBarItem';
import { EmptyViewCommands, EmptyViewKind, EmptyViewProvider } from './components/emptyViews';
import { CheckpointTreeViewProvider, CheckpointViewCommands } from './components/checkpointTreeView';
import { getCheckpointDetail, getRawTranscript } from './checkpoints';

const ENTIRE_OUTPUT_CHANNEL = 'SESSION_BRIDGE';
const ENTIRE_CONTAINER_ID = 'session-bridge';
const enum COMMAND_ID {
	SHOW_STATUS = "session.bridge.entire.showStatus",
	ENABLE = "session.bridge.entire.enable",
	DISABLE = "session.bridge.entire.disable",
	REFRESH = "session.bridge.entire.refresh",
	BROWSE_CHECKPOINTS = "session.bridge.entire.browseCheckpoints",
	EXPLAIN_CHECKPOINT = "session.bridge.entire.explainCheckpoint",
	EXPLAIN_COMMIT = "session.bridge.entire.explainCommit",
	OPEN_RAW_TRANSCRIPT = "session.bridge.entire.openRawTranscript",
	REWIND_INTERACTIVE = "session.bridge.entire.rewindInteractive",
	RESUME_BRANCH = "session.bridge.entire.resumeBranch",
	RUN_DOCTOR = "session.bridge.entire.runDoctor",
	CLEAN = "session.bridge.entire.clean",
	RESET = "session.bridge.entire.reset",
	SHOW_TRACE = "session.bridge.entire.showTrace"
}

const VIEW_DEFINITIONS = [
	{
		id: 'session.bridge.entire.workspace',
		label: 'Workspace',
	},
	{
		id: 'session.bridge.entire.activeSessions',
		label: 'Active Sessions',
	},
	{
		id: 'session.bridge.entire.checkpoints',
		label: 'Checkpoints',
	},
	{
		id: 'session.bridge.entire.recovery',
		label: 'Recovery',
	}
] as const;

const COMMAND_TITLES: Record<COMMAND_ID, string> = {
	[COMMAND_ID.SHOW_STATUS]: 'Show Status',
	[COMMAND_ID.ENABLE]: 'Enable In Repository',
	[COMMAND_ID.DISABLE]: 'Disable In Repository',
	[COMMAND_ID.REFRESH]: 'Refresh',
	[COMMAND_ID.BROWSE_CHECKPOINTS]: 'Browse Checkpoints',
	[COMMAND_ID.EXPLAIN_CHECKPOINT]: 'Explain Checkpoint',
	[COMMAND_ID.EXPLAIN_COMMIT]: 'Explain Commit',
	[COMMAND_ID.OPEN_RAW_TRANSCRIPT]: 'Open Raw Transcript',
	[COMMAND_ID.REWIND_INTERACTIVE]: 'Rewind To Checkpoint',
	[COMMAND_ID.RESUME_BRANCH]: 'Resume Branch Session',
	[COMMAND_ID.RUN_DOCTOR]: 'Run Doctor',
	[COMMAND_ID.CLEAN]: 'Clean Entire State',
	[COMMAND_ID.RESET]: 'Reset Entire Session Data',
	[COMMAND_ID.SHOW_TRACE]: 'Show Trace'
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const outputChannel = vscode.window.createOutputChannel(ENTIRE_OUTPUT_CHANNEL);
	context.subscriptions.push(outputChannel);

	let workspaceState = await probeEntireWorkspace(getProbeTargetPath());
	const statusBarItem = createStatusBarItem(COMMAND_ID.SHOW_STATUS, workspaceState);
	if (vscode.workspace.workspaceFolders?.length) {
		statusBarItem.show();
		context.subscriptions.push(statusBarItem);
	}

	const sharedCommands = {
		refresh: COMMAND_ID.REFRESH,
		showStatus: COMMAND_ID.SHOW_STATUS,
		runDoctor: COMMAND_ID.RUN_DOCTOR,
		resumeBranch: COMMAND_ID.RESUME_BRANCH,
		clean: COMMAND_ID.CLEAN,
		reset: COMMAND_ID.RESET,
		showTrace: COMMAND_ID.SHOW_TRACE,
	} satisfies EmptyViewCommands;

	const checkpointCommands = {
		refresh: COMMAND_ID.REFRESH,
		explainCheckpoint: COMMAND_ID.EXPLAIN_CHECKPOINT,
		rewindInteractive: COMMAND_ID.REWIND_INTERACTIVE,
		openRawTranscript: COMMAND_ID.OPEN_RAW_TRANSCRIPT,
	} satisfies CheckpointViewCommands;

	const checkpointProvider = new CheckpointTreeViewProvider(
		workspaceState,
		getProbeTargetPath(),
		checkpointCommands,
		outputChannel,
	);

	const viewProviders = new Map<string, EmptyViewProvider>();
	for (const view of VIEW_DEFINITIONS) {
		if (view.id === 'session.bridge.entire.checkpoints') {
			context.subscriptions.push(vscode.window.registerTreeDataProvider(view.id, checkpointProvider));
			continue;
		}
		const provider = new EmptyViewProvider(getViewKind(view.id), workspaceState, sharedCommands);
		viewProviders.set(view.id, provider);
		context.subscriptions.push(vscode.window.registerTreeDataProvider(view.id, provider));
	}

	const appendCommandRun = (commandId: COMMAND_ID) => {
		outputChannel.appendLine(`[command] ${COMMAND_TITLES[commandId] ?? commandId}`);
	};

	const showPlaceholder = async (commandId: COMMAND_ID, message?: string) => {
		appendCommandRun(commandId);
		outputChannel.show(true);
		await vscode.window.showInformationMessage(message ?? `${COMMAND_TITLES[commandId]} is not implemented yet.`);
	};

	const showStatus = async () => {
		appendCommandRun(COMMAND_ID.SHOW_STATUS);
		outputChannel.show(true);
		try {
			const resolved = await resolveEntireBinary();
			if (isEntireBinary(resolved)) {
				await vscode.window.showInformationMessage(resolved.raw);
			} else {
				await vscode.window.showErrorMessage(resolved.message);
			}
		} catch (error) {
			console.error(error);
			await vscode.window.showErrorMessage("Error getting status of entire cli. Make sure the cli is installed and try again");
		}
	};

	const refreshWorkspaceProbe = async (reason: string) => {
		const cwd = getProbeTargetPath();
		workspaceState = await probeEntireWorkspace(cwd);
		updateStatusBarItem(statusBarItem, COMMAND_ID.SHOW_STATUS, workspaceState);
		for (const provider of viewProviders.values()) {
			provider.setWorkspaceState(workspaceState);
			provider.refresh();
		}
		checkpointProvider.setWorkspaceState(workspaceState, cwd);
		checkpointProvider.refresh();

		if (cwd) {
			outputChannel.appendLine(`[probe] ${reason}: ${cwd}`);
			return;
		}

		outputChannel.appendLine(`[probe] ${reason}: no file-backed workspace target`);
	};

	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
		if (!isFileBackedEditor(editor)) {
			return;
		}

		await refreshWorkspaceProbe('active editor changed');
	}));

	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (document) => {
		if (document.uri.scheme !== 'file') {
			return;
		}

		await refreshWorkspaceProbe('file opened');
	}));

	for (const commandId of Object.keys(COMMAND_TITLES) as COMMAND_ID[]) {
		const disposable = vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
			switch (commandId) {
				case COMMAND_ID.REFRESH:
					appendCommandRun(commandId);
					outputChannel.appendLine(`[command] REFRESH: starting workspace probe`);
					await refreshWorkspaceProbe('manual refresh');
					outputChannel.appendLine(`[command] REFRESH: probe done, triggering checkpoint reload`);
					checkpointProvider.reload();
					await vscode.window.showInformationMessage('Session Bridge Entire views refreshed.');
					return;
				case COMMAND_ID.BROWSE_CHECKPOINTS:
					appendCommandRun(commandId);
					outputChannel.appendLine(`[command] BROWSE_CHECKPOINTS: triggering checkpoint reload and focusing view`);
					checkpointProvider.reload();
					await vscode.commands.executeCommand('session.bridge.entire.checkpoints.focus');
					return;
				case COMMAND_ID.EXPLAIN_CHECKPOINT:
				case COMMAND_ID.EXPLAIN_COMMIT: {
					appendCommandRun(commandId);
					const checkpointArg = args[0] as { checkpointId?: unknown } | undefined;
					if (!checkpointArg || typeof checkpointArg.checkpointId !== "string") {
						await vscode.window.showWarningMessage("Checkpoint detail could not be opened.");
						return;
					}
					const detail = await getCheckpointDetail(getProbeTargetPath() ?? "", checkpointArg.checkpointId);
					if (!detail) {
						await vscode.window.showWarningMessage(`Checkpoint ${checkpointArg.checkpointId} could not be resolved.`);
						return;
					}
					const panel = vscode.window.createWebviewPanel(
						'entireExplain',
						COMMAND_TITLES[commandId],
						vscode.ViewColumn.Active,
						{ enableFindWidget: true }
					);
					panel.webview.html = renderCheckpointDetailHtml(detail);
					return;
				}
				case COMMAND_ID.OPEN_RAW_TRANSCRIPT: {
					appendCommandRun(commandId);
					const checkpointArg = args[0] as { checkpointId?: unknown; sessionId?: unknown } | undefined;
					if (!checkpointArg || typeof checkpointArg.checkpointId !== "string") {
						await vscode.window.showWarningMessage("Raw transcript could not be opened.");
						return;
					}
					const sessionId = typeof checkpointArg.sessionId === "string" ? checkpointArg.sessionId : undefined;
					const transcript = await getRawTranscript(getProbeTargetPath() ?? "", checkpointArg.checkpointId, sessionId);
					const document = await vscode.workspace.openTextDocument({
						language: 'text',
						content: transcript ?? 'No raw transcript is available for this checkpoint.\n'
					});
					await vscode.window.showTextDocument(document, { preview: false });
					return;
				}
				case COMMAND_ID.SHOW_STATUS: {
					await showStatus();
					break;
				}
				default:
					await showPlaceholder(commandId);
			}
		});

		context.subscriptions.push(disposable);
	}

	outputChannel.appendLine(`[activate] Registered Entire container: ${ENTIRE_CONTAINER_ID}`);
	outputChannel.appendLine(`[activate] Registered views: ${VIEW_DEFINITIONS.map((view) => view.id).join(', ')}`);
}

export function deactivate() { }

function renderPlaceholderExplainHtml(title: string): string {
	const escapedTitle = escapeHtml(title);
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapedTitle}</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 24px;
      line-height: 1.5;
    }
    h1 {
      font-size: 1.2rem;
      margin: 0 0 12px;
    }
    p {
      margin: 0;
      max-width: 60ch;
    }
  </style>
</head>
<body>
  <h1>${escapedTitle}</h1>
  <p>This is a placeholder panel . CLI-backed explain rendering can be wired in next.</p>
</body>
</html>`;
}

function renderCheckpointDetailHtml(detail: NonNullable<Awaited<ReturnType<typeof getCheckpointDetail>>>): string {
	const escape = escapeHtml;
	const files = detail.files.map((file) => `<li>${escape(file.path)}${file.additions !== undefined || file.deletions !== undefined ? ` (${file.additions ?? 0}/${file.deletions ?? 0})` : ""}</li>`).join("");
	const commits = detail.associatedCommits.map((commit) => `<li><strong>${escape(commit.shortSha)}</strong> ${escape(commit.message)}</li>`).join("");
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escape(detail.title)}</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 24px; line-height: 1.5; }
    h1 { margin: 0 0 8px; }
    .meta { opacity: .8; margin-bottom: 20px; }
    section { margin: 20px 0; }
    ul { margin: 8px 0 0 20px; }
    pre { white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>${escape(detail.title)}</h1>
  <div class="meta">${escape(detail.hash)}${detail.primaryCommit ? ` · ${escape(detail.primaryCommit.shortSha)}` : ""}</div>
  <section><strong>Prompt:</strong> ${escape(detail.promptPreview)}</section>
  <section><strong>Summary:</strong> ${escape(detail.overview.summary?.intent ?? detail.overview.summary?.outcome ?? "No summary available.")}</section>
  <section><strong>Commits:</strong><ul>${commits || "<li>No associated commits</li>"}</ul></section>
  <section><strong>Files:</strong><ul>${files || "<li>No file stats available</li>"}</ul></section>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function getProbeTargetPath(): string | undefined {
	const activeEditor = vscode.window.activeTextEditor;
	if (isFileBackedEditor(activeEditor)) {
		return getWorkspaceFolderPath(activeEditor.document.uri) ?? activeEditor.document.uri.fsPath;
	}

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	return workspaceFolder?.uri.fsPath;
}

function getWorkspaceFolderPath(uri: vscode.Uri): string | undefined {
	return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

function isFileBackedEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
	return editor?.document.uri.scheme === 'file';
}

function getViewKind(viewId: string): EmptyViewKind {
	switch (viewId) {
		case 'session.bridge.entire.workspace':
			return 'workspace';
		case 'session.bridge.entire.activeSessions':
			return 'activeSessions';
		case 'session.bridge.entire.checkpoints':
			return 'checkpoints';
		case 'session.bridge.entire.recovery':
			return 'recovery';
	}

	return 'workspace';
}
