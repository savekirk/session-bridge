import * as assert from "assert";
import {
	CheckpointTreeItem,
	CheckpointTreeViewProvider,
	getCheckpointSelectionContext,
	type CheckpointViewCommands,
} from "../../components/checkpointTreeView";
import type { CommitCheckpointGroup, SessionFilePaths } from "../../checkpoints";
import { EntireStatusState } from "../../workspaceProbe";

suite("Checkpoint UI", () => {
	test("commit tree items do not bind detail commands", () => {
		const commands = createCheckpointCommands();
		const card: CommitCheckpointGroup = {
			commit: {
				sha: "1234567890abcdef",
				shortSha: "1234567",
				message: "Refactor authentication flow",
				authorName: "sarah.chen",
				authoredAt: "2026-03-31T13:15:00Z",
				checkpointIds: ["a3f9c2b1"],
			},
			diffSummary: {
				filesChanged: 3,
				linesAdded: 127,
				linesRemoved: 43,
			},
			checkpoints: [
				{
					checkpointId: "a3f9c2b1",
					summary: null,
					rewindPoints: [],
				},
			],
		};

		const item = new CheckpointTreeItem(card, commands);
		assert.strictEqual(item.command, undefined);
	});

	test("changes and view diff detail rows open commit changes with repo context", () => {
		const commands = createCheckpointCommands();
		const card: CommitCheckpointGroup = {
			commit: {
				sha: "1234567890abcdef",
				shortSha: "1234567",
				message: "Refactor authentication flow",
				authorName: "sarah.chen",
				authoredAt: "2026-03-31T13:15:00Z",
				checkpointIds: ["a3f9c2b1"],
			},
			diffSummary: {
				filesChanged: 3,
				linesAdded: 127,
				linesRemoved: 43,
			},
			checkpoints: [
				{
					checkpointId: "a3f9c2b1",
					summary: null,
					rewindPoints: [],
				},
			],
		};
		const provider = new CheckpointTreeViewProvider(
			{
				state: EntireStatusState.ENABLED,
				warnings: [],
				activeSessions: [],
			},
			"/workspace/repo",
			commands,
		);

		const detailItems = provider.getChildren(new CheckpointTreeItem(card, commands));
		const changesItem = detailItems.find((item) => item.label === "Changes");
		const viewDiffItem = detailItems.find((item) => item.label === "View Diff");
		assert.ok(changesItem, "expected a Changes detail item");
		assert.ok(viewDiffItem, "expected a View Diff detail item");
		assert.strictEqual(changesItem?.command?.command, commands.openCommitChanges);
		assert.strictEqual(viewDiffItem?.command?.command, commands.openCommitChanges);
		assert.deepStrictEqual(changesItem?.command?.arguments?.[0], {
			commitSha: "1234567890abcdef",
			repoPath: "/workspace/repo",
		});
		assert.deepStrictEqual(viewDiffItem?.command?.arguments?.[0], {
			commitSha: "1234567890abcdef",
			repoPath: "/workspace/repo",
		});
	});

	test("checkpoint selection context is available on commit rows and detail rows", () => {
		const commands = createCheckpointCommands();
		const sessionPaths: SessionFilePaths[] = [
			{
				metadata: "/a3/f9c2b1/0/metadata.json",
				transcript: "/a3/f9c2b1/0/full.jsonl",
				context: "/a3/f9c2b1/0/context.md",
				prompt: "/a3/f9c2b1/0/prompt.txt",
				contentHash: "/a3/f9c2b1/0/content_hash.txt",
			},
		];
		const card: CommitCheckpointGroup = {
			commit: {
				sha: "1234567890abcdef",
				shortSha: "1234567",
				message: "Refactor authentication flow",
				authorName: "sarah.chen",
				authoredAt: "2026-03-31T13:15:00Z",
				checkpointIds: ["a3f9c2b1", "b4c5d6e7"],
			},
			diffSummary: {
				filesChanged: 3,
				linesAdded: 127,
				linesRemoved: 43,
			},
			checkpoints: [
				{
					checkpointId: "a3f9c2b1",
					summary: {
						checkpointId: "a3f9c2b1",
						strategy: "manual-commit",
						checkpointsCount: 1,
						filesTouched: ["src/auth.ts"],
						sessions: sessionPaths,
						raw: {},
					},
					rewindPoints: [],
				},
				{
					checkpointId: "b4c5d6e7",
					summary: null,
					rewindPoints: [],
				},
			],
		};
		const provider = new CheckpointTreeViewProvider(
			{
				state: EntireStatusState.ENABLED,
				warnings: [],
				activeSessions: [],
			},
			"/workspace/repo",
			commands,
		);
		const treeItem = new CheckpointTreeItem(card, commands);
		const detailItems = provider.getChildren(treeItem);

		assert.deepStrictEqual(getCheckpointSelectionContext(treeItem), {
			checkpointId: "a3f9c2b1",
			sessionPaths,
			commitSha: "1234567890abcdef",
		});
		assert.deepStrictEqual(getCheckpointSelectionContext(detailItems[0]), {
			checkpointId: "a3f9c2b1",
			sessionPaths,
			commitSha: "1234567890abcdef",
		});
	});
});

function createCheckpointCommands(): CheckpointViewCommands {
	return {
		refresh: "session.bridge.entire.refresh",
		openCommitChanges: "session.bridge.entire.openCommitChanges",
	};
}
