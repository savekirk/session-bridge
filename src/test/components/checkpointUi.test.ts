import * as assert from "assert";
import { CheckpointTreeItem, type CheckpointViewCommands } from "../../components/checkpointTreeView";
import { renderDetailPanelHtml } from "../../components/checkpointDetailPanel";
import type { CommitCheckpointGroup, CommitDetailModel, CheckpointDetailModel } from "../../checkpoints";

suite("Checkpoint UI", () => {
	test("commit tree items pass commit explain arguments", () => {
		const commands: CheckpointViewCommands = {
			refresh: "session.bridge.entire.refresh",
			explainCheckpoint: "session.bridge.entire.explainCheckpoint",
			explainCommit: "session.bridge.entire.explainCommit",
			rewindInteractive: "session.bridge.entire.rewindInteractive",
			openRawTranscript: "session.bridge.entire.openRawTranscript",
		};
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
		assert.strictEqual(item.command?.command, commands.explainCommit);
		assert.deepStrictEqual(item.command?.arguments?.[0], {
			commitSha: "1234567890abcdef",
			checkpointId: "a3f9c2b1",
		});
	});

	test("detail panel html renders tabs and raw fallback", () => {
		const checkpointDetail: CheckpointDetailModel = {
			id: "a3f9c2b1",
			checkpointId: "a3f9c2b1",
			isEphemeral: false,
			title: "Refactor authentication flow",
			promptPreview: "Refactor authentication flow",
			hash: "a3f9c2b1",
			primaryCommit: {
				sha: "e7d4f1a0",
				shortSha: "e7d4f1a",
				message: "Refactor auth flow",
				authorName: "sarah.chen",
				authoredAt: "2026-03-31T13:15:00Z",
			},
			associatedCommits: [],
			additionalAssociatedCommitCount: 0,
			time: "2026-03-31T13:15:00Z",
			user: "sarah.chen",
			branch: "feature/auth-refactor",
			tokenCount: 1243,
			agent: "Cursor",
			model: "cursor-sonnet",
			status: "ACTIVE",
			overview: {
				filesChanged: 3,
				linesAdded: 127,
				linesRemoved: 43,
				sessionCount: 2,
				commitMessage: "Refactor auth flow",
			},
			files: [
				{ path: "src/auth/AuthProvider.tsx", additions: 89, deletions: 21 },
			],
			diff: {
				patchText: "diff --git a/src/auth/AuthProvider.tsx b/src/auth/AuthProvider.tsx",
				primaryCommitSha: "e7d4f1a0",
			},
			rawTranscriptAvailable: true,
		};
		const commitDetail: CommitDetailModel = {
			id: "e7d4f1a0",
			commit: {
				sha: "e7d4f1a0",
				shortSha: "e7d4f1a",
				message: "Refactor auth flow",
				authorName: "sarah.chen",
				authoredAt: "2026-03-31T13:15:00Z",
				fileStats: checkpointDetail.files,
				patchText: checkpointDetail.diff.patchText,
			},
			title: checkpointDetail.title,
			hash: "e7d4f1a",
			time: checkpointDetail.time,
			user: checkpointDetail.user,
			branch: checkpointDetail.branch,
			tokenCount: checkpointDetail.tokenCount,
			agent: checkpointDetail.agent,
			model: checkpointDetail.model,
			status: checkpointDetail.status,
			overview: checkpointDetail.overview,
			files: checkpointDetail.files,
			diff: checkpointDetail.diff,
			checkpoints: [checkpointDetail],
		};

		const structuredHtml = renderDetailPanelHtml(
			{
				kind: "commit",
				target: { commitSha: "e7d4f1a0" },
				detail: commitDetail,
			},
			"https://vscode-webview.test",
			"test-nonce",
		);
		assert.match(structuredHtml, /Overview/);
		assert.match(structuredHtml, /Files \(1\)/);
		assert.match(structuredHtml, /Diff/);
		assert.match(structuredHtml, /Linked Checkpoints/);

		const rawHtml = renderDetailPanelHtml(
			{
				kind: "raw",
				target: { commitSha: "e7d4f1a0" },
				title: "Commit e7d4f1a",
				label: "RAW ENTIRE OUTPUT",
				body: "raw explain output",
				backTarget: { commitSha: "e7d4f1a0" },
			},
			"https://vscode-webview.test",
			"test-nonce",
		);
		assert.match(rawHtml, /RAW ENTIRE OUTPUT/);
		assert.match(rawHtml, /Back to Details/);
		assert.match(rawHtml, /raw explain output/);
	});
});
