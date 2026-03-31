import * as vscode from 'vscode';
import { isEntireBinary, resolveEntireBinary } from './entireBinaryResolver';

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
		description: 'Workspace and Entire CLI status will appear here.'
	},
	{
		id: 'session.bridge.entire.activeSessions',
		label: 'Active Sessions',
		description: 'Active Entire sessions will appear here.'
	},
	{
		id: 'session.bridge.entire.checkpoints',
		label: 'Checkpoints',
		description: 'Rewindable checkpoints will appear here.'
	},
	{
		id: 'session.bridge.entire.recovery',
		label: 'Recovery',
		description: 'Recovery and maintenance actions will appear here.'
	}
] as const;

const COMMAND_TITLES: Record<COMMAND_ID, string> = {
	[COMMAND_ID.SHOW_STATUS]: 'Session Bridge: (Entire) Show Status',
	[COMMAND_ID.ENABLE]: 'Session Bridge: (Entire) Enable In Repository',
	[COMMAND_ID.DISABLE]: 'Session Bridge: (Entire) Disable In Repository',
	[COMMAND_ID.REFRESH]: 'Session Bridge: (Entire) Refresh',
	[COMMAND_ID.BROWSE_CHECKPOINTS]: 'Session Bridge: (Entire) Browse Checkpoints',
	[COMMAND_ID.EXPLAIN_CHECKPOINT]: 'Session Bridge: (Entire) Explain Checkpoint',
	[COMMAND_ID.EXPLAIN_COMMIT]: 'Session Bridge: (Entire) Explain Commit',
	[COMMAND_ID.OPEN_RAW_TRANSCRIPT]: 'Session Bridge: (Entire) Open Raw Transcript',
	[COMMAND_ID.REWIND_INTERACTIVE]: 'Session Bridge: (Entire) Rewind To Checkpoint',
	[COMMAND_ID.RESUME_BRANCH]: 'Session Bridge: (Entire) Resume Branch Session',
	[COMMAND_ID.RUN_DOCTOR]: 'Session Bridge: (Entire) Run Doctor',
	[COMMAND_ID.CLEAN]: 'Session Bridge: (Entire) Clean Entire State',
	[COMMAND_ID.RESET]: 'Session Bridge: (Entire) Reset Entire Session Data',
	[COMMAND_ID.SHOW_TRACE]: 'Session Bridge: (Entire) Show Trace'
};

class PlaceholderTreeItem extends vscode.TreeItem {
	constructor(label: string, description: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.contextValue = 'placeholder';
	}
}

class PlaceholderTreeDataProvider implements vscode.TreeDataProvider<PlaceholderTreeItem> {
	private readonly item: PlaceholderTreeItem;
	private readonly changeEmitter = new vscode.EventEmitter<PlaceholderTreeItem | undefined | null | void>();

	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(label: string, description: string) {
		this.item = new PlaceholderTreeItem(label, description);
	}

	refresh(): void {
		this.changeEmitter.fire();
	}

	getTreeItem(element: PlaceholderTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): PlaceholderTreeItem[] {
		return [this.item];
	}
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel(ENTIRE_OUTPUT_CHANNEL);
	context.subscriptions.push(outputChannel);

	const viewProviders = new Map<string, PlaceholderTreeDataProvider>();
	for (const view of VIEW_DEFINITIONS) {
		const provider = new PlaceholderTreeDataProvider(view.label, view.description);
		viewProviders.set(view.id, provider);
		context.subscriptions.push(vscode.window.registerTreeDataProvider(view.id, provider));
	}

	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.name = 'Session Bridge Status';
	statusBarItem.text = '$(link) Entire';
	statusBarItem.tooltip = 'Session Bridge for Entire extension is active';
	statusBarItem.command = COMMAND_ID.SHOW_STATUS;
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

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
			console.log(resolved);
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

	for (const commandId of Object.keys(COMMAND_TITLES) as COMMAND_ID[]) {
		const disposable = vscode.commands.registerCommand(commandId, async () => {
			switch (commandId) {
				case COMMAND_ID.REFRESH:
					for (const provider of viewProviders.values()) {
						provider.refresh();
					}
					appendCommandRun(commandId);
					await vscode.window.showInformationMessage('Session Bridge Entire views refreshed.');
					return;
				case COMMAND_ID.BROWSE_CHECKPOINTS:
					appendCommandRun(commandId);
					await vscode.commands.executeCommand('session.bridge.entire.checkpoints.focus');
					return;
				case COMMAND_ID.EXPLAIN_CHECKPOINT:
				case COMMAND_ID.EXPLAIN_COMMIT: {
					appendCommandRun(commandId);
					const panel = vscode.window.createWebviewPanel(
						'entireExplain',
						COMMAND_TITLES[commandId],
						vscode.ViewColumn.Active,
						{ enableFindWidget: true }
					);
					panel.webview.html = renderPlaceholderExplainHtml(COMMAND_TITLES[commandId]);
					return;
				}
				case COMMAND_ID.OPEN_RAW_TRANSCRIPT: {
					appendCommandRun(commandId);
					const document = await vscode.workspace.openTextDocument({
						language: 'text',
						content: 'Raw Entire transcript output will appear here once CLI integration is implemented.\n'
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
  <p>This placeholder panel reserves the explain surface required by the technical PRD. CLI-backed explain rendering can be wired in next.</p>
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
