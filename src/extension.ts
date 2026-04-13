import * as vscode from 'vscode';
import * as path from 'path';
import { isEntireBinary, resolveEntireBinary } from './entireBinaryResolver';
import { getGitCommonDir, getGitRepoRoot, METADATA_BRANCH_NAME, tryExecGit } from './checkpoints/util';
import { fetchDefaultCheckpointBranch } from './checkpointBranch';
import { EntireStatusState, probeEntireWorkspace, resetAutomaticCheckpointFetchAttempt } from './workspaceProbe';
import { createStatusBarItem, updateStatusBarItem } from './components/entireStatusBarItem';
import { SessionDetailsPanel } from './components/sessionDetailsPanel';
import { SessionsTreeViewProvider, getSessionDetailTarget, type SessionsViewCommands } from './components/sessionsTreeView';
import { CheckpointTreeViewProvider, getCheckpointSelectionContext, type CheckpointViewCommands } from './components/checkpointTreeView';
import { getRawTranscript, getSessionDetail, type SessionCheckpointEntry, type SessionTranscriptTarget } from './checkpoints';
import { runCommandAsync } from './runCommand';

const ENTIRE_OUTPUT_CHANNEL = 'SESSION_BRIDGE';
const ENTIRE_CONTAINER_ID = 'session-bridge';
const SESSIONS_VIEW_ID = 'session.bridge.entire.sessions';
const CHECKPOINTS_VIEW_ID = 'session.bridge.entire.checkpoints';
const enum COMMAND_ID {
	SHOW_STATUS = "session.bridge.entire.showStatus",
	ENABLE = "session.bridge.entire.enable",
	DISABLE = "session.bridge.entire.disable",
	REFRESH = "session.bridge.entire.refresh",
	FETCH_CHECKPOINT_BRANCH = "session.bridge.entire.fetchCheckpointBranch",
	BROWSE_CHECKPOINTS = "session.bridge.entire.browseCheckpoints",
	OPEN_COMMIT_CHANGES = "session.bridge.entire.openCommitChanges",
	OPEN_SESSION_TRANSCRIPT = "session.bridge.entire.openSessionTranscript",
	CLEAN = "session.bridge.entire.clean",
	RESET = "session.bridge.entire.reset",
	SHOW_TRACE = "session.bridge.entire.showTrace"
}

const TREE_VIEW_IDS = [
	SESSIONS_VIEW_ID,
	CHECKPOINTS_VIEW_ID,
] as const;

const COMMAND_TITLES: Record<COMMAND_ID, string> = {
	[COMMAND_ID.SHOW_STATUS]: 'Show Status',
	[COMMAND_ID.ENABLE]: 'Enable In Repository',
	[COMMAND_ID.DISABLE]: 'Disable In Repository',
	[COMMAND_ID.REFRESH]: 'Refresh',
	[COMMAND_ID.FETCH_CHECKPOINT_BRANCH]: 'Fetch Checkpoint Branch',
	[COMMAND_ID.BROWSE_CHECKPOINTS]: 'Browse Checkpoints',
	[COMMAND_ID.OPEN_COMMIT_CHANGES]: 'Open Commit Changes',
	[COMMAND_ID.OPEN_SESSION_TRANSCRIPT]: 'Open Session Transcript',
	[COMMAND_ID.CLEAN]: 'Clean Entire State',
	[COMMAND_ID.RESET]: 'Reset Entire Session Data',
	[COMMAND_ID.SHOW_TRACE]: 'Show Trace'
};


const WORKSPACE_CONTEXT: [EntireStatusState, string][] = [
	[EntireStatusState.CLI_MISSING, 'session.bridge.state.cli-missing'],
	[EntireStatusState.DISABLED, 'session.bridge.state.disabled'],
	[EntireStatusState.ENABLED, 'session.bridge.state.enabled'],
	[EntireStatusState.NOT_GIT_REPO, 'session.bridge.state.not-git-repo']
];

interface GitApi {
	getRepository(uri: vscode.Uri): GitRepository | null;
	openRepository(uri: vscode.Uri): Promise<GitRepository | null>;
}

interface GitRepository {
	readonly rootUri: vscode.Uri;
}

interface GitExtension {
	getAPI(version: 1): GitApi;
}

interface CommitChangesTarget {
	commitSha?: string;
	repoPath?: string;
}

const setWorkspaceContext = async (
	workspaceState: EntireStatusState,
) => {
	for (const context of WORKSPACE_CONTEXT) {
		const status = context[0] === workspaceState;
		const key = context[1];
		await vscode.commands.executeCommand('setContext', key, status);
	}
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const outputChannel = vscode.window.createOutputChannel(ENTIRE_OUTPUT_CHANNEL);
	context.subscriptions.push(outputChannel);

	const initialProbeTarget = await resolveProbeTargetPath();
	let workspaceState = await probeEntireWorkspace(initialProbeTarget);
	await setWorkspaceContext(workspaceState.state);
	const statusBarItem = createStatusBarItem(COMMAND_ID.SHOW_STATUS, workspaceState);
	if (vscode.workspace.workspaceFolders?.length) {
		statusBarItem.show();
		context.subscriptions.push(statusBarItem);
	}

	const checkpointCommands = {
		refresh: COMMAND_ID.REFRESH,
		openCommitChanges: COMMAND_ID.OPEN_COMMIT_CHANGES,
	} satisfies CheckpointViewCommands;

	const checkpointProvider = new CheckpointTreeViewProvider(
		workspaceState,
		initialProbeTarget,
		checkpointCommands,
		outputChannel,
	);
	const sessionCommands = {
		refresh: COMMAND_ID.REFRESH,
		showStatus: COMMAND_ID.SHOW_STATUS,
		openSessionTranscript: COMMAND_ID.OPEN_SESSION_TRANSCRIPT,
	} satisfies SessionsViewCommands;
	const checkpointSessionsProvider = new SessionsTreeViewProvider(
		workspaceState,
		initialProbeTarget,
		sessionCommands,
		outputChannel,
	);
	const sessionDetailsPanel = new SessionDetailsPanel(outputChannel);
	context.subscriptions.push(sessionDetailsPanel);

	const checkpointSessionsTreeView = vscode.window.createTreeView(SESSIONS_VIEW_ID, {
		treeDataProvider: checkpointSessionsProvider,
		showCollapseAll: true,
	});
	context.subscriptions.push(checkpointSessionsTreeView);
	const checkpointTreeView = vscode.window.createTreeView(CHECKPOINTS_VIEW_ID, {
		treeDataProvider: checkpointProvider,
		showCollapseAll: true,
	});
	context.subscriptions.push(checkpointTreeView);
	context.subscriptions.push(checkpointTreeView.onDidChangeSelection((event) => {
		const selection = getCheckpointSelectionContext(event.selection[0]);
		outputChannel.appendLine(
			`[checkpoint-selection] checkpointId=${selection?.checkpointId ?? "(none)"}, sessionPaths=${selection?.sessionPaths.length ?? 0}`,
		);
		checkpointSessionsProvider.setCheckpointSelection(selection);
	}));

	let sessionDetailLoadGeneration = 0;
	const showSelectedSessionDetail = async (selection: vscode.TreeItem | undefined) => {
		const target = getSessionDetailTarget(selection);
		if (!target) {
			return;
		}

		const repoPath = await resolveProbeTargetPath();
		if (!repoPath) {
			sessionDetailsPanel.showError("Open a repository folder to inspect session details.");
			return;
		}

		const generation = ++sessionDetailLoadGeneration;
		sessionDetailsPanel.showLoading(target);

		try {
			const detail = await getSessionDetail(repoPath, target);
			if (generation !== sessionDetailLoadGeneration) {
				return;
			}

			if (!detail) {
				sessionDetailsPanel.showError("Session details are no longer available for the selected item.");
				return;
			}

			sessionDetailsPanel.showDetail(detail);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to load session details";
			outputChannel.appendLine(`[session-details] load error: ${message}`);
			if (generation !== sessionDetailLoadGeneration) {
				return;
			}

			sessionDetailsPanel.showError(message);
		}
	};
	context.subscriptions.push(checkpointSessionsTreeView.onDidChangeSelection((event) => {
		void showSelectedSessionDetail(event.selection[0]);
	}));

	const appendCommandRun = (commandId: COMMAND_ID) => {
		outputChannel.appendLine(`[command] ${COMMAND_TITLES[commandId] ?? commandId}`);
	};

	let probeWatchers: vscode.Disposable[] = [];
	let watchedRepoPath: string | undefined;
	let pendingProbeRefresh: NodeJS.Timeout | undefined;

	const disposeProbeWatchers = () => {
		for (const disposable of probeWatchers) {
			disposable.dispose();
		}
		probeWatchers = [];
		watchedRepoPath = undefined;
	};

	const scheduleProbeRefresh = (reason: string) => {
		if (pendingProbeRefresh) {
			clearTimeout(pendingProbeRefresh);
		}

		pendingProbeRefresh = setTimeout(() => {
			pendingProbeRefresh = undefined;
			void refreshWorkspaceProbe(reason);
		}, 150);
	};


	const addProbeWatcher = (watcher: vscode.FileSystemWatcher, reason: string) => {
		probeWatchers.push(
			watcher,
			watcher.onDidCreate(() => scheduleProbeRefresh(reason)),
			watcher.onDidChange(() => scheduleProbeRefresh(reason)),
			watcher.onDidDelete(() => scheduleProbeRefresh(reason)),
		);
	};

	const updateProbeWatchers = async (repoPath: string | undefined) => {
		if (!repoPath) {
			disposeProbeWatchers();
			return;
		}

		if (watchedRepoPath === repoPath && probeWatchers.length > 0) {
			return;
		}

		disposeProbeWatchers();
		watchedRepoPath = repoPath;

		addProbeWatcher(
			vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.entire/settings*.json')),
			'entire settings changed',
		);

		const headRelativePath = (await tryExecGit(repoPath, ['rev-parse', '--git-path', 'HEAD']))?.trim();
		if (headRelativePath) {
			const headAbsolutePath = path.resolve(repoPath, headRelativePath);
			addProbeWatcher(
				vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(path.dirname(headAbsolutePath), path.basename(headAbsolutePath)),
				),
				'git HEAD changed',
			);
		}

		const gitCommonDir = await getGitCommonDir(repoPath);
		if (gitCommonDir) {
			addProbeWatcher(
				vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitCommonDir, 'entire-sessions/*.json')),
				'live session state changed',
			);
		}
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
		const cwd = await resolveProbeTargetPath();
		if (reason === 'manual refresh' && cwd) {
			resetAutomaticCheckpointFetchAttempt(cwd);
		}
		workspaceState = await probeEntireWorkspace(cwd);
		await setWorkspaceContext(workspaceState.state);
		await updateProbeWatchers(cwd);
		updateStatusBarItem(statusBarItem, COMMAND_ID.SHOW_STATUS, workspaceState);
		checkpointSessionsProvider.setWorkspaceState(workspaceState, cwd);
		checkpointSessionsProvider.refresh();
		checkpointProvider.setWorkspaceState(workspaceState, cwd);
		checkpointProvider.refresh();

		if (cwd) {
			outputChannel.appendLine(`[probe] ${reason}: ${cwd}`);
			return;
		}

		outputChannel.appendLine(`[probe] ${reason}: no file-backed workspace target`);
	};

	const fetchCheckpointBranch = async () => {
		appendCommandRun(COMMAND_ID.FETCH_CHECKPOINT_BRANCH);
		outputChannel.show(true);

		const repoPath = await resolveProbeTargetPath();
		if (!repoPath) {
			await vscode.window.showWarningMessage("Open a repository folder to fetch Entire checkpoint metadata.");
			return;
		}

		const fetchResult = await fetchDefaultCheckpointBranch(repoPath);
		if (fetchResult.reason === "no-remote") {
			await vscode.window.showWarningMessage("No Git remote is configured for this repository.");
			return;
		}

		const remoteName = fetchResult.remoteName ?? "unknown remote";
		outputChannel.appendLine(`[fetch] Attempting ${METADATA_BRANCH_NAME} from ${remoteName}`);

		if (!fetchResult.fetched) {
			const details = fetchResult.details ?? "unknown fetch failure";
			outputChannel.appendLine(`[fetch] Failed: ${details}`);
			await vscode.window.showWarningMessage(
				`Could not fetch ${METADATA_BRANCH_NAME} from ${remoteName}. ${details}`,
			);
			return;
		}

		outputChannel.appendLine(`[fetch] Fetched ${METADATA_BRANCH_NAME} from ${remoteName}`);
		await refreshWorkspaceProbe(`fetched ${METADATA_BRANCH_NAME} from ${remoteName}`);
		checkpointSessionsProvider.reload();
		checkpointProvider.reload();
		await vscode.window.showInformationMessage(`Fetched ${METADATA_BRANCH_NAME} from ${remoteName}.`);
	};

	const openCommitChanges = async (target: CommitChangesTarget) => {
		appendCommandRun(COMMAND_ID.OPEN_COMMIT_CHANGES);
		if (!target.commitSha) {
			await vscode.window.showWarningMessage("Checkpoint changes could not be opened.");
			return;
		}

		const repoPath = target.repoPath ?? await resolveProbeTargetPath();
		if (!repoPath) {
			await vscode.window.showWarningMessage("Open a repository folder to inspect commit changes.");
			return;
		}

		const gitApi = await getBuiltInGitApi();
		if (!gitApi) {
			await vscode.window.showWarningMessage("VS Code Git integration is not available.");
			return;
		}

		let repository = gitApi.getRepository(vscode.Uri.file(repoPath));
		if (!repository) {
			repository = await gitApi.openRepository(vscode.Uri.file(repoPath));
		}

		if (!repository) {
			await vscode.window.showWarningMessage("The repository is not available in VS Code Git.");
			return;
		}

		await vscode.commands.executeCommand('git.viewCommit', repository, target.commitSha);
	};

	const openSessionTranscript = async (target: SessionTranscriptTarget | undefined) => {
		appendCommandRun(COMMAND_ID.OPEN_SESSION_TRANSCRIPT);
		if (!target) {
			await vscode.window.showWarningMessage("Session transcript could not be opened.");
			return;
		}

		if (target.transcriptPath) {
			try {
				await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target.transcriptPath));
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				outputChannel.appendLine(`[session-transcript] failed to open ${target.transcriptPath}: ${message}`);
			}
		}

		let transcript = selectTranscriptFromTarget(target);
		if (!transcript) {
			const repoPath = await resolveProbeTargetPath();
			if (repoPath) {
				transcript = await getRawTranscript(repoPath, target.checkpoint.checkpointId, target.sessionId);
			}
		}

		if (!transcript) {
			await vscode.window.showWarningMessage("No transcript is available for the selected session.");
			return;
		}

		const document = await vscode.workspace.openTextDocument({
			language: "plaintext",
			content: transcript,
		});
		await vscode.window.showTextDocument(document, { preview: false });
	};

	await updateProbeWatchers(await resolveProbeTargetPath());
	context.subscriptions.push({
		dispose: () => {
			if (pendingProbeRefresh) {
				clearTimeout(pendingProbeRefresh);
				pendingProbeRefresh = undefined;
			}
			disposeProbeWatchers();
		},
	});

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
					outputChannel.appendLine(`[command] REFRESH: probe done, triggering checkpoint sessions reload`);
					checkpointSessionsProvider.reload();
					outputChannel.appendLine(`[command] REFRESH: probe done, triggering checkpoint reload`);
					checkpointProvider.reload();
					await vscode.window.showInformationMessage('Session Bridge Entire views refreshed.');
					return;
				case COMMAND_ID.FETCH_CHECKPOINT_BRANCH:
					await fetchCheckpointBranch();
					return;
				case COMMAND_ID.BROWSE_CHECKPOINTS:
					appendCommandRun(commandId);
					outputChannel.appendLine(`[command] BROWSE_CHECKPOINTS: triggering checkpoint reload and focusing view`);
					checkpointProvider.reload();
					await vscode.commands.executeCommand(`${CHECKPOINTS_VIEW_ID}.focus`);
					return;
				case COMMAND_ID.OPEN_COMMIT_CHANGES: {
					const target = normalizeCommitChangesTarget(args[0]);
					await openCommitChanges(target);
					return;
				}
				case COMMAND_ID.OPEN_SESSION_TRANSCRIPT: {
					const target = normalizeSessionTranscriptTarget(args[0]);
					await openSessionTranscript(target);
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
	outputChannel.appendLine(`[activate] Registered views: ${TREE_VIEW_IDS.join(', ')}`);
}

export function deactivate() { }

/**
 * Returns the most specific file-backed path the extension can currently anchor on.
 *
 * When an editor is focused, the active file path is preferred because it can
 * belong to a nested repository that differs from the first workspace folder.
 * If there is no active file, the first workspace folder path is used as a
 * broader fallback.
 *
 * @returns Active file path when available, otherwise the first workspace folder path.
 */
function getProbeCandidatePath(): string | undefined {
	const activeEditor = vscode.window.activeTextEditor;
	if (isFileBackedEditor(activeEditor)) {
		return activeEditor.document.uri.fsPath;
	}

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	return workspaceFolder?.uri.fsPath;
}

/**
 * Resolves the path the extension should use for repository-backed probes and actions.
 *
 * This converts the current active file or workspace folder path into the git
 * repository root when possible, so checkpoint loading and file watchers operate
 * on the repository that actually owns the current context.
 *
 * @returns Repository root for the current UI context, or the original candidate path when no git root can be resolved.
 */
async function resolveProbeTargetPath(): Promise<string | undefined> {
	const candidatePath = getProbeCandidatePath();
	if (!candidatePath) {
		return undefined;
	}

	return await getGitRepoRoot(candidatePath) ?? candidatePath;
}

function isFileBackedEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
	return editor?.document.uri.scheme === 'file';
}

async function getBuiltInGitApi(): Promise<GitApi | null> {
	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExtension) {
		return null;
	}

	const gitExports = gitExtension.isActive
		? gitExtension.exports
		: await gitExtension.activate();
	return gitExports?.getAPI(1) ?? null;
}

function normalizeCommitChangesTarget(value: unknown): CommitChangesTarget {
	if (!value || typeof value !== "object") {
		return {};
	}

	const candidate = value as {
		commitSha?: unknown;
		repoPath?: unknown;
	};

	return {
		commitSha: typeof candidate.commitSha === "string" ? candidate.commitSha : undefined,
		repoPath: typeof candidate.repoPath === "string" ? candidate.repoPath : undefined,
	};
}

function normalizeSessionTranscriptTarget(value: unknown): SessionTranscriptTarget | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const candidate = value as SessionTranscriptTarget;
	if (typeof candidate.sessionId !== "string") {
		return undefined;
	}
	if (candidate.source !== "live" && candidate.source !== "checkpoint") {
		return undefined;
	}

	const checkpoint = normalizeSessionCheckpointEntry(candidate.checkpoint);
	if (!checkpoint) {
		return undefined;
	}

	return {
		sessionId: candidate.sessionId,
		promptPreview: typeof candidate.promptPreview === "string" ? candidate.promptPreview : "",
		source: candidate.source,
		checkpoint,
		lastCheckpointId: typeof candidate.lastCheckpointId === "string" ? candidate.lastCheckpointId : undefined,
		transcriptPath: typeof candidate.transcriptPath === "string" ? candidate.transcriptPath : undefined,
	};
}

function selectTranscriptFromTarget(target: SessionTranscriptTarget): string | null {
	if (target.checkpoint.session.metadata.sessionId !== target.sessionId) {
		return null;
	}

	const transcript = target.checkpoint.session.transcript;
	return typeof transcript === "string" && transcript.length > 0 ? transcript : null;
}

function normalizeSessionCheckpointEntry(value: unknown): SessionCheckpointEntry | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const candidate = value as SessionCheckpointEntry;
	if (typeof candidate.checkpointId !== "string" || typeof candidate.sessionIndex !== "number") {
		return undefined;
	}
	if (!candidate.session || typeof candidate.session !== "object") {
		return undefined;
	}
	if (typeof candidate.session.metadata?.sessionId !== "string") {
		return undefined;
	}

	return candidate;
}
