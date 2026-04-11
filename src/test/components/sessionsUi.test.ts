import * as assert from "assert";
import * as vscode from "vscode";
import { SessionsTreeViewProvider, getSessionDetailTarget, type SessionsViewCommands } from "../../components/sessionsTreeView";
import { EntireStatusState, type EntireWorkspaceState } from "../../workspaceProbe";
import type { EntireActiveSessionCard, EntireSessionCard } from "../../checkpoints";

suite("Sessions UI", () => {
	const commands: SessionsViewCommands = {
		refresh: "session.bridge.entire.refresh",
		showStatus: "session.bridge.entire.showStatus",
		runDoctor: "session.bridge.entire.runDoctor",
		openSessionTranscript: "session.bridge.entire.openSessionTranscript",
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
			"active",
		);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 2);
		assert.strictEqual(getLabel(items[0]), "Claude Code (sonnet) · Fix the auth redirect loop");
		assert.strictEqual(items[0].description, "ACTIVE");
		assert.strictEqual(getLabel(items[1]), "Cursor (model-x) · Review the parser edge cases");
	});

	test("checkpoint provider prompts for a checkpoint selection before loading sessions", () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			"checkpoint",
		);

		const items = provider.getChildren();
		assert.strictEqual(items.length, 2);
		assert.strictEqual(getLabel(items[0]), "Select a checkpoint to view sessions");
		assert.strictEqual(items[1].command?.command, commands.refresh);
	});

	test("checkpoint provider loads selected checkpoint sessions even when live sessions exist", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState({
				activeSessions: [createLiveCard({ sessionId: "live-session", agent: "OpenCode" })],
			}),
			"/repo",
			commands,
			"checkpoint",
			undefined,
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
			"checkpoint",
			undefined,
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
						attribution: {
							calculatedAt: "2026-04-04T10:01:00Z",
							agentLines: 42,
							humanAdded: 3,
							humanModified: 1,
							humanRemoved: 0,
							totalCommitted: 45,
							agentPercentage: 93.3,
						},
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
			"active",
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
		const lastActiveRow = children.find((child) => getLabel(child) === "Last Active");
		assert.ok(lastActiveRow);
		assert.strictEqual(lastActiveRow?.description, formatShortTimestamp("2026-04-04T10:00:00Z"));
		const worktreeRow = children.find((child) => getLabel(child) === "Worktree");
		assert.ok(worktreeRow);
		assert.strictEqual(worktreeRow?.description, "/repo");
		const checkpointRow = children.find((child) => getLabel(child) === "Latest Checkpoint");
		assert.ok(checkpointRow);
		assert.strictEqual(checkpointRow?.description, "a3b2c4d5e6f7");
		const attributionRow = children.find((child) => getLabel(child) === "Attribution");
		assert.ok(attributionRow);
		assert.strictEqual(attributionRow?.description, "93.3% agent · 42/45 lines");
		assert.strictEqual(attributionRow?.tooltip, "Agent authored: 42/45 committed lines (93.3%)\nHuman added: 3\nHuman modified: 1\nHuman removed: 0\nCalculated: 2026-04-04T10:01:00Z");
		const transcriptAction = children.find((child) => getLabel(child) === "View Session Transcript");
		assert.ok(transcriptAction);
		assert.strictEqual(transcriptAction?.command?.command, commands.openSessionTranscript);
		assert.deepStrictEqual(transcriptAction?.command?.arguments?.[0], {
			sessionId: "session-with-actions",
			promptPreview: "Investigate failing test",
			source: "live",
			checkpointIds: ["a3b2c4d5e6f7"],
			checkpointEntries: undefined,
			lastCheckpointId: "a3b2c4d5e6f7",
			transcriptPath,
		});

		const doctorAction = children.find((child) => getLabel(child) === "Run Doctor");
		assert.ok(doctorAction);
		assert.strictEqual(doctorAction?.command?.command, commands.runDoctor);
	});

	test("provider child rows expose transcript actions for checkpoint-backed sessions", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			"checkpoint",
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

		provider.setCheckpointSelection({ checkpointIds: ["a3b2c4d5e6f7", "b4c5d6e7f8a9"] });
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
			transcriptPath: undefined,
		});
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
			"active",
		);

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
			"checkpoint",
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

		provider.setCheckpointSelection({ checkpointIds: ["a3b2c4d5e6f7"] });
		const loaded = waitForTreeChange(provider);
		provider.getChildren();
		await loaded;

		const [sessionItem] = provider.getChildren();
		const children = provider.getChildren(sessionItem);
		const attributionRow = children.find((child) => getLabel(child) === "Attribution");
		assert.ok(attributionRow);
		assert.strictEqual(attributionRow?.description, "100% agent · 18/18 lines");
	});

	test("active provider ignores checkpoint selection and keeps the live-session snapshot", () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState({
				activeSessions: [createLiveCard({ sessionId: "live-session", agent: "OpenCode" })],
			}),
			"/repo",
			commands,
			"active",
		);

		provider.setCheckpointSelection({ checkpointIds: ["a3b2c4d5e6f7"] });
		const items = provider.getChildren();
		assert.strictEqual(items.length, 1);
		assert.strictEqual(getLabel(items[0]), "OpenCode (model-x) · Investigate failing test");
	});

	test("provider adopts passive workspace probe session updates without reload", () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			"active",
		);

		assert.strictEqual(getLabel(provider.getChildren()[0]), "No active sessions");

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

	test("session items expose selection targets for the details panel", async () => {
		const provider = new SessionsTreeViewProvider(
			createWorkspaceState(),
			"/repo",
			commands,
			"checkpoint",
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

		provider.setCheckpointSelection({ checkpointIds: ["a3b2c4d5e6f7", "b4c5d6e7f8a9"] });
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

		const liveProvider = new SessionsTreeViewProvider(
			createWorkspaceState({
				activeSessions: [createLiveCard({ sessionId: "live-session", lastCheckpointId: "a3b2c4d5e6f7" })],
			}),
			"/repo",
			commands,
			"active",
		);
		const [liveItem] = liveProvider.getChildren();
		assert.deepStrictEqual(getSessionDetailTarget(liveItem), {
			sessionId: "live-session",
			promptPreview: "Investigate failing test",
			source: "live",
			checkpointIds: ["a3b2c4d5e6f7"],
			checkpointEntries: undefined,
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
		attribution: overrides.attribution,
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
