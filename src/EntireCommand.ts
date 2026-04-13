import * as vscode from 'vscode';
import { runCommandAsync } from './runCommand';
import { loadRewindIndex } from './checkpoints/rewindIndex';

export interface EntireCommandContext {
	/** Resolves the current repository path anchored to the active editor or workspace folder. */
	resolveRepoPath: () => Promise<string | undefined>;
}

/**
 * A helper that opens a named integrated terminal in the given working directory
 * and sends a single command string to it.
 */
function runInTerminal(name: string, command: string, cwd: string | undefined): void {
	const terminal = vscode.window.createTerminal({ name, cwd });
	terminal.show();
	terminal.sendText(command);
}

/**
 * Show Entire status for the current repository via `entire status`.
 */
export async function showStatus(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	runInTerminal('Entire: Status', 'entire status', repoPath);
}

/**
 * Enable Entire in the current repository via `entire enable`.
 *
 * The CLI handles agent selection interactively inside the terminal.
 */
export async function enableEntire(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	if (!repoPath) {
		await vscode.window.showWarningMessage("Open a repository folder to enable Entire.");
		return;
	}

	runInTerminal('Entire: Enable', 'entire enable', repoPath);
}

/**
 * Disable Entire in the current repository via `entire disable`.
 *
 * Prompts for confirmation before opening the terminal.
 */
export async function disableEntire(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	if (!repoPath) {
		await vscode.window.showWarningMessage("Open a repository folder to disable Entire.");
		return;
	}

	const choice = await vscode.window.showWarningMessage(
		'Disable Entire in this repository? This stops session capture but preserves existing session data.',
		{ modal: true },
		'Disable',
	);
	if (choice !== 'Disable') {
		return;
	}

	runInTerminal('Entire: Disable', 'entire disable', repoPath);
}

/**
 * Remove orphaned Entire data via `entire clean`.
 *
 * Prompts for confirmation before opening the terminal.
 */
export async function cleanEntire(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	if (!repoPath) {
		await vscode.window.showWarningMessage("Open a repository folder to clean Entire state.");
		return;
	}

	const choice = await vscode.window.showWarningMessage(
		'Clean orphaned Entire data from this repository?',
		{ modal: true },
		'Clean',
	);
	if (choice !== 'Clean') {
		return;
	}

	runInTerminal('Entire: Clean', 'entire clean', repoPath);
}

/**
 * Delete the shadow branch and session state for the current commit via `entire reset --force`.
 *
 * Prompts with a destructive-action warning before opening the terminal.
 */
export async function resetEntire(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	if (!repoPath) {
		await vscode.window.showWarningMessage("Open a repository folder to reset Entire session data.");
		return;
	}

	const choice = await vscode.window.showWarningMessage(
		'Reset Entire session data for the current commit? This deletes shadow branch and session state and cannot be recovered.',
		{ modal: true },
		'Reset',
	);
	if (choice !== 'Reset') {
		return;
	}

	runInTerminal('Entire: Reset', 'entire reset --force', repoPath);
}

/**
 * Display hook performance traces via `entire trace`.
 */
export async function showTrace(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	runInTerminal('Entire: Trace', 'entire trace', repoPath);
}

/**
 * Configure Entire and manage agent hooks via `entire configure`.
 */
export async function configureEntire(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	runInTerminal('Entire: Configure', 'entire configure', repoPath);
}

/**
 * Scan for stuck or problematic sessions via `entire doctor`.
 */
export async function runDoctor(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	runInTerminal('Entire: Doctor', 'entire doctor', repoPath);
}

/**
 * Resume an agent session from a local branch via `entire resume <branch>`.
 *
 * Presents a QuickPick populated from local Git branches, then opens a
 * terminal to run the command.
 */
export async function resumeSession(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	if (!repoPath) {
		await vscode.window.showWarningMessage("Open a repository folder to resume an Entire session.");
		return;
	}

	const branchResult = await runCommandAsync('git', ['branch', '--format=%(refname:short)'], repoPath);
	if (branchResult.exitCode !== 0) {
		await vscode.window.showErrorMessage(`Could not list branches: ${branchResult.stderr.trim()}`);
		return;
	}

	const branches = branchResult.stdout.split('\n').map(b => b.trim()).filter(Boolean);
	if (branches.length === 0) {
		await vscode.window.showWarningMessage("No local branches found.");
		return;
	}

	const branch = await vscode.window.showQuickPick(branches, {
		placeHolder: 'Select a branch to resume the agent session from',
		title: 'Resume Entire Session',
	});
	if (!branch) {
		return;
	}

	runInTerminal('Entire: Resume', `entire resume ${branch}`, repoPath);
}

/**
 * Rewind to a previous checkpoint via `entire rewind --to <commit>`.
 *
 * Loads available rewind points via `entire rewind --list` and presents them
 * in a QuickPick. After the user selects a point and confirms the destructive
 * warning, opens a terminal to run the rewind.
 */
export async function rewindSession(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	if (!repoPath) {
		await vscode.window.showWarningMessage("Open a repository folder to rewind an Entire session.");
		return;
	}

	const index = await loadRewindIndex(repoPath);

	if (index.error) {
		await vscode.window.showWarningMessage(`Could not load rewind points: ${index.error}`);
		return;
	}

	if (index.points.length === 0) {
		await vscode.window.showInformationMessage("No rewind points available for the current session.");
		return;
	}

	const items = index.points.map(rp => ({
		label: rp.displayHash,
		description: rp.message.length > 80 ? `${rp.message.slice(0, 80)}…` : rp.message,
		detail: [rp.date, rp.sessionPrompt ? `Prompt: ${rp.sessionPrompt.slice(0, 60)}` : undefined]
			.filter(Boolean)
			.join(' · '),
		pointId: rp.pointId,
	}));

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select a checkpoint to rewind to',
		title: 'Rewind Entire Session',
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (!selected) {
		return;
	}

	const choice = await vscode.window.showWarningMessage(
		`Rewind to ${selected.label}? Changes made after this checkpoint will be discarded.`,
		{ modal: true },
		'Rewind',
	);
	if (choice !== 'Rewind') {
		return;
	}

	runInTerminal('Entire: Rewind', `entire rewind --to ${selected.pointId}`, repoPath);
}

/**
 * Generate a short AI-powered explanation of the current session via `entire explain -s`.
 */
export async function explainSession(ctx: EntireCommandContext): Promise<void> {
	const repoPath = await ctx.resolveRepoPath();
	runInTerminal('Entire: Explain', 'entire explain -s', repoPath);
}
