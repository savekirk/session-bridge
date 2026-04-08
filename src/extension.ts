import * as vscode from 'vscode';
import * as path from 'path';
import { isEntireBinary, resolveEntireBinary } from './entireBinaryResolver';
import { getCurrentBranchName, getGitCommonDir, getGitRepoRoot, METADATA_BRANCH_NAME, tryExecGit } from './checkpoints/util';
import { EntireStatusState, probeEntireWorkspace } from './workspaceProbe';
import { createStatusBarItem, updateStatusBarItem } from './components/entireStatusBarItem';
import { SessionsTreeViewProvider, type SessionsViewCommands } from './components/sessionsTreeView';
import { CheckpointTreeViewProvider, getCheckpointSelectionContext, type CheckpointViewCommands } from './components/checkpointTreeView';
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
	RESUME_BRANCH = "session.bridge.entire.resumeBranch",
	RUN_DOCTOR = "session.bridge.entire.runDoctor",
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
	[COMMAND_ID.RESUME_BRANCH]: 'Resume Branch Session',
	[COMMAND_ID.RUN_DOCTOR]: 'Run Doctor',
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

const setWorkspaceContext = async (workspaceState: EntireStatusState) => {
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
		runDoctor: COMMAND_ID.RUN_DOCTOR,
	} satisfies SessionsViewCommands;
	const sessionsProvider = new SessionsTreeViewProvider(
		workspaceState,
		initialProbeTarget,
		sessionCommands,
		outputChannel,
	);

	context.subscriptions.push(vscode.window.registerTreeDataProvider(SESSIONS_VIEW_ID, sessionsProvider));
	const checkpointTreeView = vscode.window.createTreeView(CHECKPOINTS_VIEW_ID, {
		treeDataProvider: checkpointProvider,
		showCollapseAll: true,
	});
	context.subscriptions.push(checkpointTreeView);
	context.subscriptions.push(checkpointTreeView.onDidChangeSelection((event) => {
		sessionsProvider.setCheckpointSelection(getCheckpointSelectionContext(event.selection[0]));
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
		workspaceState = await probeEntireWorkspace(cwd);
		await setWorkspaceContext(workspaceState.state);
		await updateProbeWatchers(cwd);
		updateStatusBarItem(statusBarItem, COMMAND_ID.SHOW_STATUS, workspaceState);
		sessionsProvider.setWorkspaceState(workspaceState, cwd);
		sessionsProvider.refresh();
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

		const remoteName = await resolveDefaultRemoteName(repoPath);
		if (!remoteName) {
			await vscode.window.showWarningMessage("No Git remote is configured for this repository.");
			return;
		}

		outputChannel.appendLine(`[fetch] Attempting ${METADATA_BRANCH_NAME} from ${remoteName}`);
		const fetchResult = await runCommandAsync(
			"git",
			["fetch", remoteName, `refs/heads/${METADATA_BRANCH_NAME}:refs/heads/${METADATA_BRANCH_NAME}`],
			repoPath,
		);

		if (fetchResult.exitCode !== 0) {
			const details = fetchResult.stderr.trim() || fetchResult.stdout.trim() || `exit code ${fetchResult.exitCode}`;
			outputChannel.appendLine(`[fetch] Failed: ${details}`);
			await vscode.window.showWarningMessage(
				`Could not fetch ${METADATA_BRANCH_NAME} from ${remoteName}. ${details}`,
			);
			return;
		}

		outputChannel.appendLine(`[fetch] Fetched ${METADATA_BRANCH_NAME} from ${remoteName}`);
		await refreshWorkspaceProbe(`fetched ${METADATA_BRANCH_NAME} from ${remoteName}`);
		sessionsProvider.reload();
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
					outputChannel.appendLine(`[command] REFRESH: probe done, triggering sessions reload`);
					sessionsProvider.reload();
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
 * repository root when possible, so active-session loading, checkpoint loading,
 * and file watchers operate on the repository that actually owns the current context.
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

async function resolveDefaultRemoteName(repoPath: string): Promise<string | null> {
	const currentBranch = await getCurrentBranchName(repoPath);
	if (currentBranch) {
		const branchRemote = (await tryExecGit(repoPath, ["config", "--get", `branch.${currentBranch}.remote`]))?.trim();
		if (branchRemote) {
			return branchRemote;
		}
	}

	const remoteOutput = await tryExecGit(repoPath, ["remote"]);
	if (!remoteOutput) {
		return null;
	}

	const remotes = remoteOutput
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (remotes.length === 0) {
		return null;
	}

	return remotes.includes("origin") ? "origin" : remotes[0];
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
