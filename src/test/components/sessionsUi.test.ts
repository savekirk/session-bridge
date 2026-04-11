import * as assert from "assert";
import * as vscode from "vscode";
import { SessionsTreeViewProvider, getSessionDetailTarget, type SessionsViewCommands } from "../../components/sessionsTreeView";
import { EntireStatusState, type EntireWorkspaceState } from "../../workspaceProbe";
import type { EntireSessionCard, SessionFilePaths } from "../../checkpoints";

suite("Sessions UI", () => {
	const commands: SessionsViewCommands = {
		refresh: "session.bridge.entire.refresh",
		showStatus: "session.bridge.entire.showStatus",
		openSessionTranscript: "session.bridge.entire.openSessionTranscript",
	};

	test("checkpoint provider prompts for a checkpoint selection before loading sessions", () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
		);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 2);
		assert.strictEqual(getLabel(items[0]), "Select a checkpoint to view sessions");
		assert.strictEqual(items[1].command?.command, commands.refresh);
	});

	test("checkpoint provider loads selected checkpoint sessions from the chosen checkpoint", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async (_repoPath, checkpointId, sessionPaths) => {
				assert.strictEqual(checkpointId, "a3b2c4d5e6f7");
				assert.deepStrictEqual(sessionPaths, createSessionPaths());
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

		provider.setCheckpointSelection(createCheckpointSelection({ commitSha: "1234567890abcdef" }));

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
			async () => {
				throw new Error("boom");
			},
		);

		provider.setCheckpointSelection(createCheckpointSelection());
		const loaded = waitForTreeChange(provider);
		provider.getChildren();
		await loaded;

		const items = provider.getChildren();
		assert.strictEqual(getLabel(items[0]), "boom");
		assert.strictEqual(items[1].command?.command, commands.refresh);
		assert.strictEqual(items[2].command?.command, commands.showStatus);
	});

	test("provider child rows expose transcript actions for checkpoint sessions", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [
				createCheckpointSessionCard({
					sessionId: "checkpoint-session-with-transcript",
					latestCheckpointId: "b4c5d6e7f8a9",
					checkpointIds: ["a3b2c4d5e6f7", "b4c5d6e7f8a9"],
					checkpointEntries: [
						createCheckpointEntry({
							checkpointId: "a3b2c4d5e6f7",
							sessionId: "checkpoint-session-with-transcript",
							createdAt: "2026-04-04T10:00:00Z",
						}),
						createCheckpointEntry({
							checkpointId: "b4c5d6e7f8a9",
							sessionId: "checkpoint-session-with-transcript",
							sessionIndex: 1,
							createdAt: "2026-04-04T11:00:00Z",
						}),
					],
				}),
			],
		);

		provider.setCheckpointSelection(createCheckpointSelection());
		const loaded = waitForTreeChange(provider);
		provider.getChildren();
		await loaded;

		const [sessionItem] = provider.getChildren();
		const children = provider.getChildren(sessionItem);
		const transcriptAction = children.find((child) => getLabel(child) === "View Session Transcript");
		assert.ok(transcriptAction);
		assert.strictEqual(transcriptAction?.command?.command, commands.openSessionTranscript);
		assert.deepStrictEqual(transcriptAction?.command?.arguments?.[0], {
			sessionId: "checkpoint-session-with-transcript",
			promptPreview: "Checkpoint session prompt",
			source: "checkpoint",
			checkpointIds: ["a3b2c4d5e6f7", "b4c5d6e7f8a9"],
			checkpointEntries: [
				createCheckpointEntry({
					checkpointId: "a3b2c4d5e6f7",
					sessionId: "checkpoint-session-with-transcript",
					createdAt: "2026-04-04T10:00:00Z",
				}),
				createCheckpointEntry({
					checkpointId: "b4c5d6e7f8a9",
					sessionId: "checkpoint-session-with-transcript",
					sessionIndex: 1,
					createdAt: "2026-04-04T11:00:00Z",
				}),
			],
			lastCheckpointId: "b4c5d6e7f8a9",
		});
	});

	test("provider derives duration from timestamps when stored duration is zero", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [
				createCheckpointSessionCard({
					sessionId: "session-with-derived-duration",
					createdAt: "2026-04-04T09:00:00Z",
					lastActivityAt: "2026-04-04T10:00:00Z",
					durationMs: 0,
					checkpointEntries: [
						createCheckpointEntry({
							checkpointId: "a3b2c4d5e6f7",
							sessionId: "session-with-derived-duration",
							createdAt: "2026-04-04T09:00:00Z",
						}),
					],
				}),
				],
		);

		provider.setCheckpointSelection(createCheckpointSelection());
		const loaded = waitForTreeChange(provider);
		provider.getChildren();
		await loaded;

		const [sessionItem] = provider.getChildren();
		const children = provider.getChildren(sessionItem);
		const durationRow = children.find((child) => getLabel(child) === "Duration");
		assert.ok(durationRow);
		assert.strictEqual(durationRow?.description, "1h");
	});

	test("provider child rows expose attribution for checkpoint-backed sessions", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [
				createCheckpointSessionCard({
					sessionId: "checkpoint-session-with-attribution",
					attribution: {
						calculatedAt: "2026-04-04T11:00:00Z",
						agentLines: 18,
						humanAdded: 0,
						humanModified: 0,
						humanRemoved: 0,
						totalCommitted: 18,
						agentPercentage: 100,
					},
				}),
			],
		);

		provider.setCheckpointSelection(createCheckpointSelection());
		const loaded = waitForTreeChange(provider);
		provider.getChildren();
		await loaded;

		const [sessionItem] = provider.getChildren();
		const children = provider.getChildren(sessionItem);
		const attributionRow = children.find((child) => getLabel(child) === "Attribution");
		assert.ok(attributionRow);
		assert.strictEqual(attributionRow?.description, "100% agent · 18/18 lines");
	});

	test("session items expose selection targets for the details panel", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			undefined,
			async () => [
				createCheckpointSessionCard({
					sessionId: "checkpoint-session",
					checkpointIds: ["a3b2c4d5e6f7", "b4c5d6e7f8a9"],
					promptPreview: "Checkpoint prompt",
					checkpointEntries: [
						createCheckpointEntry({
							checkpointId: "a3b2c4d5e6f7",
							sessionId: "checkpoint-session",
							createdAt: "2026-04-04T10:00:00Z",
						}),
						createCheckpointEntry({
							checkpointId: "b4c5d6e7f8a9",
							sessionId: "checkpoint-session",
							sessionIndex: 1,
							createdAt: "2026-04-04T11:00:00Z",
						}),
					],
				}),
			],
		);

		provider.setCheckpointSelection(createCheckpointSelection());
		const loaded = waitForTreeChange(provider);
		provider.getChildren();
		await loaded;

		const [checkpointItem] = provider.getChildren();
		assert.deepStrictEqual(getSessionDetailTarget(checkpointItem), {
			sessionId: "checkpoint-session",
			promptPreview: "Checkpoint prompt",
			source: "checkpoint",
			checkpointIds: ["a3b2c4d5e6f7", "b4c5d6e7f8a9"],
			checkpointEntries: [
				createCheckpointEntry({
					checkpointId: "a3b2c4d5e6f7",
					sessionId: "checkpoint-session",
					createdAt: "2026-04-04T10:00:00Z",
				}),
				createCheckpointEntry({
					checkpointId: "b4c5d6e7f8a9",
					sessionId: "checkpoint-session",
					sessionIndex: 1,
					createdAt: "2026-04-04T11:00:00Z",
				}),
			],
		});
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

function createCheckpointSelection(overrides: {
	checkpointId?: string;
	sessionPaths?: SessionFilePaths[];
	commitSha?: string;
} = {}) {
	return {
		checkpointId: overrides.checkpointId ?? "a3b2c4d5e6f7",
		sessionPaths: overrides.sessionPaths ?? createSessionPaths(overrides.checkpointId),
		commitSha: overrides.commitSha,
	};
}

function createSessionPaths(checkpointId = "a3b2c4d5e6f7"): SessionFilePaths[] {
	const prefix = `/${checkpointId.slice(0, 2)}/${checkpointId.slice(2)}/0`;
	return [
		{
			metadata: `${prefix}/metadata.json`,
			transcript: `${prefix}/full.jsonl`,
			context: `${prefix}/context.md`,
			prompt: `${prefix}/prompt.txt`,
			contentHash: `${prefix}/content_hash.txt`,
		},
	];
}

function createCheckpointSessionCard(overrides: Partial<EntireSessionCard> = {}): EntireSessionCard {
	return {
		id: overrides.sessionId ?? "checkpoint-session",
		sessionId: overrides.sessionId ?? "checkpoint-session",
		promptPreview: overrides.promptPreview ?? "Checkpoint session prompt",
		displayHash: overrides.displayHash ?? "a3b2c4d5e6f7",
		checkpointIds: overrides.checkpointIds ?? ["a3b2c4d5e6f7"],
		checkpointEntries: overrides.checkpointEntries,
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

function createCheckpointEntry(overrides: {
	checkpointId?: string;
	sessionId?: string;
	sessionIndex?: number;
	createdAt?: string;
} = {}) {
	return {
		checkpointId: overrides.checkpointId ?? "a3b2c4d5e6f7",
		sessionIndex: overrides.sessionIndex ?? 0,
		session: {
			metadata: {
				checkpointId: overrides.checkpointId ?? "a3b2c4d5e6f7",
				sessionId: overrides.sessionId ?? "checkpoint-session",
				strategy: "manual-commit",
				createdAt: overrides.createdAt ?? "2026-04-04T10:00:00Z",
				checkpointsCount: 1,
				filesTouched: [],
				isTask: false,
				raw: {},
			},
			transcript: "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Checkpoint prompt\"}}\n",
			context: null,
			prompts: "Checkpoint prompt",
			contentHash: null,
		},
		checkpointTokenUsage: {
			inputTokens: 10,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			outputTokens: 5,
			apiCallCount: 1,
		},
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
