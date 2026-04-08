import * as assert from "assert";
import * as vscode from "vscode";
import { SessionsTreeViewProvider, type SessionsViewCommands } from "../../components/sessionsTreeView";
import { EntireStatusState, type EntireWorkspaceState } from "../../workspaceProbe";
import type { EntireActiveSessionCard, EntireSessionCard } from "../../checkpoints";

suite("Sessions UI", () => {
	const commands: SessionsViewCommands = {
		refresh: "session.bridge.entire.refresh",
		showStatus: "session.bridge.entire.showStatus",
		runDoctor: "session.bridge.entire.runDoctor",
	};

	test("provider sorts live sessions from the workspace probe snapshot", () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState({
				activeSessions: [
					createLiveCard({
						sessionId: "older-session-id",
						lastInteractionAt: "2026-04-04T09:00:00Z",
						agent: "Cursor",
						promptPreview: "Review the parser edge cases",
					}),
					createLiveCard({
						sessionId: "newer-session-id",
						lastInteractionAt: "2026-04-04T10:00:00Z",
						agent: "Claude Code",
						model: "sonnet",
						promptPreview: "Fix the auth redirect loop",
					}),
				],
			}),
			"/repo",
			commands,
		);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 2);
		assert.strictEqual(getLabel(items[0]), "Claude Code (sonnet) · Fix the auth redirect loop");
		assert.strictEqual(items[0].description, "ACTIVE");
		assert.strictEqual(getLabel(items[1]), "Cursor (model-x) · Review the parser edge cases");
	});

	test("provider shows an empty state when there are no live sessions and no checkpoint selection", () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
		);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 2);
		assert.strictEqual(getLabel(items[0]), "No sessions to show");
		assert.strictEqual(items[1].command?.command, commands.refresh);
	});

	test("provider loads selected checkpoint sessions when there are no live sessions", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [],
			async (_repoPath, checkpointIds) => {
				assert.deepStrictEqual(checkpointIds, ["a3b2c4d5e6f7"]);
				return [
					createCheckpointSessionCard({
						sessionId: "older-checkpoint-session",
						createdAt: "2026-04-04T09:00:00Z",
						lastActivityAt: "2026-04-04T09:30:00Z",
						agent: "Cursor",
						status: "ENDED",
						latestCheckpointId: "a3b2c4d5e6f7",
						promptPreview: "Review the parser notes",
					}),
					createCheckpointSessionCard({
						sessionId: "newer-checkpoint-session",
						createdAt: "2026-04-04T10:00:00Z",
						lastActivityAt: "2026-04-04T11:00:00Z",
						agent: "Claude Code",
						model: "sonnet",
						status: "IDLE",
						latestCheckpointId: "a3b2c4d5e6f7",
						promptPreview: "Summarize the checkpoint changes",
					}),
				];
			},
		);

		provider.setCheckpointSelection({ checkpointIds: ["a3b2c4d5e6f7"], commitSha: "1234567890abcdef" });

		const loaded = waitForTreeChange(provider);
		const initial = provider.getChildren();
		assert.strictEqual(getLabel(initial[0]), "Loading sessions…");
		await loaded;

		const items = provider.getChildren();
		assert.strictEqual(items.length, 2);
		assert.strictEqual(getLabel(items[0]), "Claude Code (sonnet) · Summarize the checkpoint changes");
		assert.strictEqual(items[0].description, "IDLE");
		assert.strictEqual(getLabel(items[1]), "Cursor (model-x) · Review the parser notes");
		assert.strictEqual(items[1].description, "ENDED");
	});

	test("provider keeps checkpoint session load errors in-tree", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [],
			async () => {
				throw new Error("boom");
			},
		);

		provider.setCheckpointSelection({ checkpointIds: ["a3b2c4d5e6f7"] });
		const loaded = waitForTreeChange(provider);
		provider.getChildren();
		await loaded;

		const items = provider.getChildren();
		assert.strictEqual(getLabel(items[0]), "boom");
		assert.strictEqual(items[1].command?.command, commands.refresh);
		assert.strictEqual(items[2].command?.command, commands.showStatus);
	});

	test("provider child rows expose doctor and transcript actions for live sessions", () => {
		const transcriptPath = "/tmp/live-transcript.jsonl";
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState({
				activeSessions: [
					createLiveCard({
						sessionId: "session-with-actions",
						durationMs: 125_000,
						lastCheckpointId: "a3b2c4d5e6f7",
						canOpenTranscript: true,
						transcriptPath,
						canRunDoctor: true,
						isStuck: true,
					}),
				],
			}),
			"/repo",
			commands,
		);

		const [sessionItem] = provider.getChildren();
		const children = provider.getChildren(sessionItem);

		const promptRow = children.find((child) => getLabel(child) === "Prompt");
		assert.ok(promptRow);
		const sessionIdRow = children.find((child) => getLabel(child) === "Session ID");
		assert.ok(sessionIdRow);
		assert.strictEqual(sessionIdRow?.description, "session-with-actions");
		const durationRow = children.find((child) => getLabel(child) === "Duration");
		assert.ok(durationRow);
		assert.strictEqual(durationRow?.description, "2m 5s");
		const startedRow = children.find((child) => getLabel(child) === "Started");
		assert.ok(startedRow);
		assert.strictEqual(startedRow?.description, formatShortTimestamp("2026-04-04T09:00:00Z"));
		assert.strictEqual(children.some((child) => getLabel(child) === "Last Active"), false);
		const transcriptAction = children.find((child) => getLabel(child) === "Open Live Transcript");
		assert.ok(transcriptAction);
		assert.strictEqual(transcriptAction?.command?.command, "vscode.open");
		assert.strictEqual((transcriptAction?.command?.arguments?.[0] as vscode.Uri).fsPath, transcriptPath);

		const doctorAction = children.find((child) => getLabel(child) === "Run Doctor");
		assert.ok(doctorAction);
		assert.strictEqual(doctorAction?.command?.command, commands.runDoctor);
	});

	test("provider derives duration from timestamps when stored duration is zero", () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState({
				activeSessions: [
					createLiveCard({
						sessionId: "session-with-derived-duration",
						startedAt: "2026-04-04T09:00:00Z",
						lastInteractionAt: "2026-04-04T10:00:00Z",
						durationMs: 0,
					}),
				],
			}),
			"/repo",
			commands,
		);

		const [sessionItem] = provider.getChildren();
		const children = provider.getChildren(sessionItem);
		const durationRow = children.find((child) => getLabel(child) === "Duration");
		assert.ok(durationRow);
		assert.strictEqual(durationRow?.description, "1h");
	});

	test("provider prefers live sessions over checkpoint selection", () => {
		let checkpointLoadCalls = 0;
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState({
				activeSessions: [createLiveCard({ sessionId: "live-session", agent: "OpenCode" })],
			}),
			"/repo",
			commands,
			undefined,
			async () => [],
			async () => {
				checkpointLoadCalls += 1;
				return [];
			},
		);

		provider.setCheckpointSelection({ checkpointIds: ["a3b2c4d5e6f7"] });
		const items = provider.getChildren();
		assert.strictEqual(items.length, 1);
		assert.strictEqual(getLabel(items[0]), "OpenCode (model-x) · Investigate failing test");
		assert.strictEqual(checkpointLoadCalls, 0);
	});

	test("provider adopts passive workspace probe session updates without reload", () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [],
		);

		assert.strictEqual(getLabel(provider.getChildren()[0]), "No sessions to show");

		provider.setWorkspaceState(
			createWorkspaceState({
				activeSessions: [createLiveCard({ sessionId: "passive-update", agent: "OpenCode" })],
			}),
			"/repo",
		);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 1);
		assert.strictEqual(getLabel(items[0]), "OpenCode (model-x) · Investigate failing test");
	});
});

function createWorkspaceState(overrides: Partial<EntireWorkspaceState> = {}): EntireWorkspaceState {
	return {
		state: EntireStatusState.ENABLED,
		warnings: [],
		activeSessions: [],
		...overrides,
	};
}

function createLiveCard(overrides: Partial<EntireActiveSessionCard> = {}): EntireActiveSessionCard {
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

function createCheckpointSessionCard(overrides: Partial<EntireSessionCard> = {}): EntireSessionCard {
	return {
		id: overrides.sessionId ?? "checkpoint-session",
		sessionId: overrides.sessionId ?? "checkpoint-session",
		promptPreview: overrides.promptPreview ?? "Checkpoint session prompt",
		displayHash: overrides.displayHash ?? "a3b2c4d5e6f7",
		checkpointIds: overrides.checkpointIds ?? ["a3b2c4d5e6f7"],
		agent: overrides.agent ?? "Cursor",
		model: overrides.model ?? "model-x",
		status: overrides.status ?? "ENDED",
		author: overrides.author,
		branch: overrides.branch,
		createdAt: overrides.createdAt ?? "2026-04-04T09:00:00Z",
		lastActivityAt: overrides.lastActivityAt ?? overrides.createdAt ?? "2026-04-04T09:00:00Z",
		durationMs: overrides.durationMs,
		stepCount: overrides.stepCount,
		toolCount: overrides.toolCount,
		tokenCount: overrides.tokenCount,
		attribution: overrides.attribution,
		checkpointCount: overrides.checkpointCount ?? (overrides.checkpointIds?.length ?? 1),
		latestCheckpointId: overrides.latestCheckpointId ?? "a3b2c4d5e6f7",
		latestAssociatedCommitSha: overrides.latestAssociatedCommitSha,
		isLiveOnly: overrides.isLiveOnly ?? false,
		searchText: overrides.searchText ?? "checkpoint session prompt",
	};
}

function getLabel(item: vscode.TreeItem): string {
	return typeof item.label === "string" ? item.label : item.label?.label ?? "";
}

function formatShortTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${month}-${day} ${hours}:${minutes}`;
}

function waitForTreeChange(provider: SessionsTreeViewProvider): Promise<void> {
	return new Promise((resolve) => {
		const disposable = provider.onDidChangeTreeData(() => {
			disposable.dispose();
			resolve();
		});
	});
}
