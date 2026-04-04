import * as assert from "assert";
import * as vscode from "vscode";
import { ActiveSessionTreeViewProvider, type ActiveSessionViewCommands } from "../../components/activeSessionTreeView";
import { EntireStatusState, type EntireWorkspaceState } from "../../workspaceProbe";
import type { EntireActiveSessionCard } from "../../checkpoints";

suite("Active Session UI", () => {
	const commands: ActiveSessionViewCommands = {
		refresh: "session.bridge.entire.refresh",
		showStatus: "session.bridge.entire.showStatus",
		explainCheckpoint: "session.bridge.entire.explainCheckpoint",
		runDoctor: "session.bridge.entire.runDoctor",
	};

	test("provider sorts sessions and exposes top-level identity rows", async () => {
		const provider = new ActiveSessionTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [
				createCard({
					sessionId: "older-session-id",
					lastInteractionAt: "2026-04-04T09:00:00Z",
					agent: "Cursor",
				}),
				createCard({
					sessionId: "newer-session-id",
					lastInteractionAt: "2026-04-04T10:00:00Z",
					agent: "Claude Code",
					model: "sonnet",
				}),
			],
		);

		const loaded = waitForTreeChange(provider);
		const initial = provider.getChildren();
		assert.strictEqual(getLabel(initial[0]), "Loading active sessions…");
		await loaded;

		const items = provider.getChildren();
		assert.strictEqual(items.length, 2);
		assert.strictEqual(getLabel(items[0]), "Claude Code (sonnet) · newer-sessio…");
		assert.strictEqual(items[0].description, "ACTIVE");
		assert.strictEqual(getLabel(items[1]), "Cursor (model-x) · older-sessio…");
	});

	test("provider renders error and empty states in-tree", async () => {
		const emptyProvider = new ActiveSessionTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [],
		);
		const emptyLoaded = waitForTreeChange(emptyProvider);
		emptyProvider.getChildren();
		await emptyLoaded;
		const emptyItems = emptyProvider.getChildren();
		assert.strictEqual(getLabel(emptyItems[0]), "No active sessions");
		assert.strictEqual(emptyItems[1].command?.command, commands.refresh);

		const errorProvider = new ActiveSessionTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => {
				throw new Error("boom");
			},
		);
		const errorLoaded = waitForTreeChange(errorProvider);
		errorProvider.getChildren();
		await errorLoaded;
		const errorItems = errorProvider.getChildren();
		assert.strictEqual(getLabel(errorItems[0]), "boom");
		assert.strictEqual(errorItems[1].command?.command, commands.refresh);
		assert.strictEqual(errorItems[2].command?.command, commands.showStatus);
	});

	test("provider child rows expose checkpoint, doctor, and transcript actions", async () => {
		const transcriptPath = "/tmp/live-transcript.jsonl";
		const provider = new ActiveSessionTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [
				createCard({
					sessionId: "session-with-actions",
					lastCheckpointId: "a3b2c4d5e6f7",
					canOpenLastCheckpoint: true,
					canOpenTranscript: true,
					transcriptPath,
					canRunDoctor: true,
					isStuck: true,
				}),
			],
		);

		const loaded = waitForTreeChange(provider);
		provider.getChildren();
		await loaded;
		const [sessionItem] = provider.getChildren();
		const children = provider.getChildren(sessionItem);

		const promptRow = children.find((child) => getLabel(child) === "Prompt");
		assert.ok(promptRow);
		const checkpointAction = children.find((child) => getLabel(child) === "Open Last Checkpoint");
		assert.ok(checkpointAction);
		assert.strictEqual(checkpointAction?.command?.command, commands.explainCheckpoint);
		assert.deepStrictEqual(checkpointAction?.command?.arguments?.[0], {
			checkpointId: "a3b2c4d5e6f7",
			sessionId: "session-with-actions",
		});

		const transcriptAction = children.find((child) => getLabel(child) === "Open Live Transcript");
		assert.ok(transcriptAction);
		assert.strictEqual(transcriptAction?.command?.command, "vscode.open");
		assert.strictEqual((transcriptAction?.command?.arguments?.[0] as vscode.Uri).fsPath, transcriptPath);

		const doctorAction = children.find((child) => getLabel(child) === "Run Doctor");
		assert.ok(doctorAction);
		assert.strictEqual(doctorAction?.command?.command, commands.runDoctor);
	});

	test("provider adopts passive workspace probe session updates without reload", async () => {
		const provider = new ActiveSessionTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [],
		);

		const initialLoaded = waitForTreeChange(provider);
		provider.getChildren();
		await initialLoaded;
		assert.strictEqual(getLabel(provider.getChildren()[0]), "No active sessions");

		provider.setWorkspaceState(
			{
				...createWorkspaceState(),
				activeSessions: [createCard({ sessionId: "passive-update", agent: "OpenCode" })],
			},
			"/repo",
		);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 1);
		assert.strictEqual(getLabel(items[0]), "OpenCode (model-x) · passive-upda…");
	});

	test("provider renders existing workspace probe sessions immediately", () => {
		let loadCalls = 0;
		const provider = new ActiveSessionTreeViewProvider(
			{
				...createWorkspaceState(),
				activeSessions: [createCard({ sessionId: "already-probed", agent: "OpenCode" })],
			},
			"/repo",
			commands,
			undefined,
			async () => {
				loadCalls += 1;
				return [];
			},
		);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 1);
		assert.strictEqual(getLabel(items[0]), "OpenCode (model-x) · already-prob…");
		assert.strictEqual(loadCalls, 0);
	});
});

function createWorkspaceState(): EntireWorkspaceState {
	return {
		state: EntireStatusState.ENABLED,
		warnings: [],
		activeSessions: [],
	};
}

function createCard(overrides: Partial<EntireActiveSessionCard> = {}): EntireActiveSessionCard {
	return {
		id: overrides.sessionId ?? "2026-03-30-session",
		sessionId: overrides.sessionId ?? "2026-03-30-session",
		status: overrides.status ?? "ACTIVE",
		phase: overrides.phase ?? "active",
		promptPreview: overrides.promptPreview ?? "Investigate failing test",
		agent: overrides.agent ?? "Cursor",
		model: overrides.model ?? "model-x",
		startedAt: overrides.startedAt ?? "2026-04-04T09:00:00Z",
		lastInteractionAt: overrides.lastInteractionAt ?? "2026-04-04T10:00:00Z",
		durationMs: overrides.durationMs ?? 60_000,
		checkpointCount: overrides.checkpointCount ?? 2,
		turnCount: overrides.turnCount ?? 1,
		tokenCount: overrides.tokenCount ?? 1_500,
		lastCheckpointId: overrides.lastCheckpointId,
		author: overrides.author,
		worktreePath: overrides.worktreePath ?? "/repo",
		worktreeId: overrides.worktreeId,
		baseCommit: overrides.baseCommit ?? "abcdef1234567890",
		transcriptPath: overrides.transcriptPath,
		hasShadowBranch: overrides.hasShadowBranch ?? true,
		isStuck: overrides.isStuck ?? false,
		canRunDoctor: overrides.canRunDoctor ?? false,
		canOpenLastCheckpoint: overrides.canOpenLastCheckpoint ?? false,
		canOpenTranscript: overrides.canOpenTranscript ?? false,
		searchText: overrides.searchText ?? "investigate failing test",
	};
}

function getLabel(item: vscode.TreeItem): string {
	return typeof item.label === "string" ? item.label : item.label?.label ?? "";
}

function waitForTreeChange(provider: ActiveSessionTreeViewProvider): Promise<void> {
	return new Promise((resolve) => {
		const disposable = provider.onDidChangeTreeData(() => {
			disposable.dispose();
			resolve();
		});
	});
}
