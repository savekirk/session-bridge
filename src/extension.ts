import * as vscode from 'vscode';
import { isEntireBinary, resolveEntireBinary } from './EntireBinaryResolver';

const ENTIRE_OUTPUT_CHANNEL = 'Entire';
const ENTIRE_CONTAINER_ID = 'entire';

const VIEW_DEFINITIONS = [
	{
		id: 'entire.workspace',
		label: 'Workspace',
		description: 'Workspace and Entire CLI status will appear here.'
	},
	{
		id: 'entire.activeSessions',
		label: 'Active Sessions',
		description: 'Active Entire sessions will appear here.'
	},
	{
		id: 'entire.checkpoints',
		label: 'Checkpoints',
		description: 'Rewindable checkpoints will appear here.'
	},
	{
		id: 'entire.recovery',
		label: 'Recovery',
		description: 'Recovery and maintenance actions will appear here.'
	}
] as const;

const COMMAND_TITLES: Record<string, string> = {
	'entire.showStatus': 'Entire: Show Status',
	'entire.enable': 'Entire: Enable In Repository',
	'entire.disable': 'Entire: Disable In Repository',
	'entire.refresh': 'Entire: Refresh',
	'entire.browseCheckpoints': 'Entire: Browse Checkpoints',
	'entire.explainCheckpoint': 'Entire: Explain Checkpoint',
	'entire.explainCommit': 'Entire: Explain Commit',
	'entire.openRawTranscript': 'Entire: Open Raw Transcript',
	'entire.rewindInteractive': 'Entire: Rewind To Checkpoint',
	'entire.resumeBranch': 'Entire: Resume Branch Session',
	'entire.runDoctor': 'Entire: Run Doctor',
	'entire.clean': 'Entire: Clean Entire State',
	'entire.reset': 'Entire: Reset Entire Session Data',
	'entire.showTrace': 'Entire: Show Trace'
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
	statusBarItem.name = 'Entire Status';
	statusBarItem.text = '$(link) Entire';
	statusBarItem.tooltip = 'Entire extension is active';
	statusBarItem.command = 'entire.showStatus';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	const appendCommandRun = (commandId: string) => {
		outputChannel.appendLine(`[command] ${COMMAND_TITLES[commandId] ?? commandId}`);
	};

	const showPlaceholder = async (commandId: string, message?: string) => {
		appendCommandRun(commandId);
		outputChannel.show(true);
		await vscode.window.showInformationMessage(message ?? `${COMMAND_TITLES[commandId]} is not implemented yet.`);
	};

	const showStatus = async () => {
		appendCommandRun("entire.showStatus");
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

	for (const commandId of Object.keys(COMMAND_TITLES)) {
		const disposable = vscode.commands.registerCommand(commandId, async () => {
			switch (commandId) {
				case 'entire.refresh':
					for (const provider of viewProviders.values()) {
						provider.refresh();
					}
					appendCommandRun(commandId);
					await vscode.window.showInformationMessage('Entire views refreshed.');
					return;
				case 'entire.browseCheckpoints':
					appendCommandRun(commandId);
					await vscode.commands.executeCommand('entire.checkpoints.focus');
					return;
				case 'entire.explainCheckpoint':
				case 'entire.explainCommit': {
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
				case 'entire.openRawTranscript': {
					appendCommandRun(commandId);
					const document = await vscode.workspace.openTextDocument({
						language: 'text',
						content: 'Raw Entire transcript output will appear here once CLI integration is implemented.\n'
					});
					await vscode.window.showTextDocument(document, { preview: false });
					return;
				}
				case "entire.showStatus": {
					await showStatus();
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
