import * as assert from "assert";
import { execFileSync } from "child_process";
import { cpSync, mkdirSync, writeFileSync } from "fs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	buildGitEnrichmentIndex,
	filterSessionCards,
	getCommitDetail,
	getCheckpointDetail,
	GitCheckpointStore,
	getRawExplainOutput,
	getRawTranscript,
	listActiveSessions,
	listCheckpointCards,
	listCheckpointSummaries,
	listSessionsForCheckpointIds,
	listSessionCards,
	loadRewindIndex,
	shadowBranchNameForCommit,
} from "../../checkpoints";

const fixtureRoot = path.resolve(__dirname, "../../../src/test/checkpoints/fixtures/store");

suite("Checkpoint Module", () => {
	test("loadRewindIndex normalizes current rewind points", async () => {
		const repoDir = createTempRepo();
		try {
			const rewindOutput = JSON.stringify([
				{
					id: "1111111111111111111111111111111111111111",
					message: "Committed checkpoint",
					date: "2026-03-30T13:00:00Z",
					is_task_checkpoint: false,
					is_logs_only: true,
					condensation_id: "a3b2c4d5e6f7",
					session_id: "2026-03-30-alpha",
					session_prompt: "Build the parser",
				},
				{
					id: "2222222222222222222222222222222222222222",
					message: "Inspect live state",
					date: "2026-03-30T14:00:00Z",
					is_task_checkpoint: true,
					is_logs_only: false,
					session_id: "live-only",
					session_prompt: "Investigate failing test",
				},
			], null, 2);

			await withMockEntire(repoDir, rewindOutput, async () => {
				const rewindIndex = await loadRewindIndex(repoDir);
				assert.strictEqual(rewindIndex.points.length, 2);
				assert.strictEqual(rewindIndex.byCheckpointId.get("a3b2c4d5e6f7")?.length, 1);
				assert.strictEqual(rewindIndex.points[1].isTemporary, false);
				assert.strictEqual(rewindIndex.points[0].isTemporary, true);
			});
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});

	test("module APIs build active-branch cards, session joins, and detail models", async () => {
		const repoDir = createTempRepo();

		try {
			const setup = createRepoWithMetadata(repoDir);
			const liveTranscriptPath = path.join(repoDir, "live-transcript.jsonl");
			writeFileSync(liveTranscriptPath, "{\"type\":\"message\",\"text\":\"live transcript\"}\n", "utf8");
			createShadowBranch(repoDir, shadowBranchNameForCommit(setup.mainHead, ""));
			const now = Date.now();
			const startedAlpha = new Date(now - 30 * 60 * 1000).toISOString();
			const interactedAlpha = new Date(now - 2 * 60 * 60 * 1000).toISOString();
			const startedLiveOnly = new Date(now - 20 * 60 * 1000).toISOString();
			const interactedLiveOnly = new Date(now - 5 * 60 * 1000).toISOString();
			const staleInteraction = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
			writeLiveSessionState(repoDir, {
				session_id: "2026-03-30-alpha",
				base_commit: setup.mainHead,
				worktree_path: repoDir,
				started_at: startedAlpha,
				phase: "active",
				last_interaction_time: interactedAlpha,
				checkpoint_count: 2,
				last_checkpoint_id: "a3b2c4d5e6f7",
				agent_type: "Claude Code",
				model_name: "claude-sonnet-4-20250514",
				token_usage: {
					input_tokens: 100,
					cache_creation_tokens: 0,
					cache_read_tokens: 0,
					output_tokens: 50,
					api_call_count: 1,
				},
			});
			writeLiveSessionState(repoDir, {
				session_id: "live-only",
				base_commit: setup.mainHead,
				worktree_path: repoDir,
				started_at: startedLiveOnly,
				phase: "idle",
				last_interaction_time: interactedLiveOnly,
				checkpoint_count: 1,
				agent_type: "Cursor",
				model_name: "cursor-sonnet",
				last_prompt: "Investigate failing test",
				transcript_path: liveTranscriptPath,
				token_usage: {
					input_tokens: 10,
					cache_creation_tokens: 0,
					cache_read_tokens: 0,
					output_tokens: 5,
					api_call_count: 1,
				},
			});
			writeLiveSessionState(repoDir, {
				session_id: "other-worktree",
				base_commit: setup.mainHead,
				worktree_path: path.join(repoDir, "..", "other"),
				started_at: startedLiveOnly,
				phase: "active",
			});
			writeLiveSessionState(repoDir, {
				session_id: "unreachable-base",
				base_commit: setup.featureOnlyCommit,
				worktree_path: repoDir,
				started_at: startedLiveOnly,
				phase: "active",
				last_interaction_time: interactedLiveOnly,
			});
			writeLiveSessionState(repoDir, {
				session_id: "orphan-idle",
				base_commit: setup.secondCommit,
				worktree_path: repoDir,
				started_at: startedLiveOnly,
				phase: "idle",
				last_interaction_time: interactedLiveOnly,
			});
			writeLiveSessionState(repoDir, {
				session_id: "stale-session",
				base_commit: setup.mainHead,
				worktree_path: repoDir,
				started_at: staleInteraction,
				phase: "active",
				last_interaction_time: staleInteraction,
			});
			writeLiveSessionState(repoDir, {
				session_id: "ended-session",
				base_commit: setup.mainHead,
				worktree_path: repoDir,
				started_at: startedLiveOnly,
				ended_at: interactedLiveOnly,
				phase: "ended",
				last_interaction_time: interactedLiveOnly,
				checkpoint_count: 1,
				last_checkpoint_id: "a3b2c4d5e6f7",
			});

			const rewindOutput = JSON.stringify([
				{
					id: setup.secondCommit,
					message: "Second parser commit",
					date: "2026-03-30T15:00:00Z",
					is_task_checkpoint: false,
					is_logs_only: true,
					condensation_id: "a3b2c4d5e6f7",
					session_id: "2026-03-30-alpha",
					session_prompt: "Build the parser",
				},
				{
					id: "3333333333333333333333333333333333333333",
					message: "Investigate failing test",
					date: "2026-03-30T16:05:00Z",
					is_task_checkpoint: true,
					is_logs_only: false,
					session_id: "live-only",
					session_prompt: "Investigate failing test",
				},
			], null, 2);

			await withMockEntire(repoDir, rewindOutput, async () => {
				const enrichmentIndex = await buildGitEnrichmentIndex(repoDir);
				assert.ok(enrichmentIndex.checkpointCommits.every((commit) => commit.checkpointIds.length > 0));
				assert.strictEqual(enrichmentIndex.checkpointCommits.some((commit) => commit.message === "Initial commit"), false);

				const checkpointSummaries = await listCheckpointSummaries(repoDir);
				assert.ok(checkpointSummaries.every((group) => group.checkpointCommits.every((commit) => commit.checkpoints.length > 0)));

				const checkpointCards = await listCheckpointCards(repoDir);
				assert.strictEqual(checkpointCards.length, 3);
				const committedCard = checkpointCards.find((card) => card.checkpointId === "a3b2c4d5e6f7");
				assert.ok(committedCard);
				assert.strictEqual(committedCard.associatedCommitCount, 3);
				assert.strictEqual(committedCard.status, "ACTIVE");
				assert.strictEqual(committedCard.diffSummary?.filesChanged, 3);
				const secondaryCard = checkpointCards.find((card) => card.checkpointId === "b4c5d6e7f8a9");
				assert.ok(secondaryCard);
				assert.strictEqual(secondaryCard.associatedCommitCount, 1);
				const temporaryCard = checkpointCards.find((card) => card.rewindPointId === "3333333333333333333333333333333333333333");
				assert.ok(temporaryCard);
				assert.strictEqual(temporaryCard.status, "IDLE");

				const sessionCards = await listSessionCards(repoDir);
				assert.strictEqual(sessionCards.length, 4);
				const liveOnlySession = sessionCards.find((card) => card.sessionId === "live-only");
				assert.ok(liveOnlySession);
				assert.strictEqual(liveOnlySession.status, "IDLE");
				const alphaSession = sessionCards.find((card) => card.sessionId === "2026-03-30-alpha");
				assert.ok(alphaSession);
				assert.strictEqual(alphaSession.status, "ACTIVE");
				assert.strictEqual(alphaSession.checkpointCount, 2);

				const selectedCheckpointSessions = await listSessionsForCheckpointIds(repoDir, ["a3b2c4d5e6f7"]);
				assert.strictEqual(selectedCheckpointSessions.length, 2);
				assert.strictEqual(selectedCheckpointSessions.some((card) => card.sessionId === "2026-03-30-alpha"), true);
				assert.strictEqual(selectedCheckpointSessions.some((card) => card.sessionId === "2026-03-30-beta"), true);
				assert.strictEqual(selectedCheckpointSessions.some((card) => card.sessionId === "live-only"), false);
				const selectedAlphaSession = selectedCheckpointSessions.find((card) => card.sessionId === "2026-03-30-alpha");
				assert.strictEqual(selectedAlphaSession?.lastActivityAt, "2026-03-30T10:01:00Z");
				const betaSession = selectedCheckpointSessions.find((card) => card.sessionId === "2026-03-30-beta");
				assert.strictEqual(betaSession?.lastActivityAt, "2026-03-30T11:02:00Z");

				const activeSessions = await listActiveSessions(repoDir);
				assert.strictEqual(activeSessions.length, 2);
				const activeAlpha = activeSessions.find((card) => card.sessionId === "2026-03-30-alpha");
				assert.ok(activeAlpha);
				assert.strictEqual(activeAlpha.status, "ACTIVE");
				assert.strictEqual(activeAlpha.author, "Test User");
				assert.strictEqual(activeAlpha.promptPreview, "Build the parser");
				assert.strictEqual(activeAlpha.hasShadowBranch, true);
				assert.strictEqual(activeAlpha.canRunDoctor, true);
				assert.strictEqual(activeAlpha.canOpenLastCheckpoint, true);
				assert.strictEqual(activeAlpha.canOpenTranscript, false);
				const activeLiveOnly = activeSessions.find((card) => card.sessionId === "live-only");
				assert.ok(activeLiveOnly);
				assert.strictEqual(activeLiveOnly.status, "IDLE");
				assert.strictEqual(activeLiveOnly.promptPreview, "Investigate failing test");
				assert.strictEqual(activeLiveOnly.canOpenTranscript, true);
				assert.strictEqual(activeLiveOnly.hasShadowBranch, true);
				assert.strictEqual(activeSessions.some((card) => card.sessionId === "stale-session"), false);
				assert.strictEqual(activeSessions.some((card) => card.sessionId === "orphan-idle"), false);
				assert.strictEqual(activeSessions.some((card) => card.sessionId === "unreachable-base"), false);
				assert.strictEqual(activeSessions.some((card) => card.sessionId === "ended-session"), false);

				const detail = await getCheckpointDetail(repoDir, "a3b2c4d5e6f7");
				assert.ok(detail);
				assert.strictEqual(detail?.primaryCommit?.sha, setup.multiTrailerCommit);
				assert.strictEqual(detail?.associatedCommits.length, 3);
				assert.ok(detail?.rawTranscriptAvailable);
				assert.ok(detail?.diff.patchText?.includes("Squash merged feature work"));

				const secondCommitDetail = await getCommitDetail(repoDir, setup.secondCommit);
				assert.ok(secondCommitDetail);
				assert.strictEqual(secondCommitDetail?.commit.sha, setup.secondCommit);
				assert.strictEqual(secondCommitDetail?.checkpoints.length, 1);
				assert.ok((secondCommitDetail?.overview.filesChanged ?? 0) >= 1);
				assert.ok(secondCommitDetail?.diff.patchText?.includes("Second parser commit"));

				const multiCheckpointDetail = await getCommitDetail(repoDir, setup.multiTrailerCommit);
				assert.ok(multiCheckpointDetail);
				assert.strictEqual(multiCheckpointDetail?.checkpoints.length, 2);
				assert.strictEqual(multiCheckpointDetail?.overview.sessionCount, 2);

				const transcript = await getRawTranscript(repoDir, "a3b2c4d5e6f7");
				assert.ok(transcript?.includes("Review complete"));
				const alphaTranscript = await getRawTranscript(repoDir, "a3b2c4d5e6f7", "2026-03-30-alpha");
				assert.ok(alphaTranscript?.includes("Build the parser"));
				const chunkedTranscript = await getRawTranscript(repoDir, "c6d7e8f9a0b1");
				assert.ok(chunkedTranscript?.includes("Chunked transcript complete"));
				const rawExplain = await getRawExplainOutput(repoDir, { checkpointId: "a3b2c4d5e6f7" });
				assert.ok(rawExplain?.includes("Explain checkpoint a3b2c4d5e6f7"));
				const rawFullExplain = await getRawExplainOutput(repoDir, { checkpointId: "a3b2c4d5e6f7", fullTranscript: true });
				assert.ok(rawFullExplain?.includes("Full transcript for a3b2c4d5e6f7"));

				const filteredSessions = filterSessionCards(sessionCards, { agent: "Cursor", query: "Investigate" });
				assert.strictEqual(filteredSessions.length, 1);
				assert.strictEqual(filteredSessions[0].sessionId, "live-only");
			});
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});

	test("session cards derive createdAt from transcript start timestamps", async () => {
		const repoDir = createTempRepo();
		const customFixtureRoot = cloneFixtureRoot("session-bridge-module-fixtures-");

		try {
			updateSessionMetadataCreatedAt(customFixtureRoot, path.join("a3", "b2c4d5e6f7", "0", "metadata.json"), "2026-03-30T10:05:00Z");
			updateSessionMetadataCreatedAt(customFixtureRoot, path.join("b4", "c5d6e7f8a9", "0", "metadata.json"), "2026-03-30T12:04:00Z");
			createRepoWithMetadata(repoDir, customFixtureRoot);

			await withMockEntire(repoDir, "[]", async () => {
				const selectedCheckpointSessions = await listSessionsForCheckpointIds(repoDir, ["a3b2c4d5e6f7"]);
				const selectedAlphaSession = selectedCheckpointSessions.find((card) => card.sessionId === "2026-03-30-alpha");
				assert.strictEqual(selectedAlphaSession?.createdAt, "2026-03-30T10:00:00Z");
				assert.strictEqual(selectedAlphaSession?.lastActivityAt, "2026-03-30T10:01:00Z");

				const sessionCards = await listSessionCards(repoDir);
				const alphaSession = sessionCards.find((card) => card.sessionId === "2026-03-30-alpha");
				assert.strictEqual(alphaSession?.createdAt, "2026-03-30T10:00:00Z");
				assert.strictEqual(alphaSession?.lastActivityAt, "2026-03-30T12:04:00Z");
			});
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
			fs.rmSync(customFixtureRoot, { recursive: true, force: true });
		}
	});

	test("listSessionsForCheckpointIds only hydrates selected checkpoints", async () => {
		const repoDir = createTempRepo();

		try {
			createRepoWithMetadata(repoDir);
			const originalGetCheckpointSummary = GitCheckpointStore.prototype.getCheckpointSummary;

			GitCheckpointStore.prototype.getCheckpointSummary = async function checkpointSummaryGuard(checkpointId: string) {
				if (checkpointId === "b4c5d6e7f8a9") {
					throw new Error("unrelated checkpoint should not be read");
				}
				return originalGetCheckpointSummary.call(this, checkpointId);
			};

			try {
				await withMockEntire(repoDir, "[]", async () => {
					const selectedCheckpointSessions = await listSessionsForCheckpointIds(repoDir, ["a3b2c4d5e6f7"]);
					assert.strictEqual(selectedCheckpointSessions.length, 2);
					assert.strictEqual(selectedCheckpointSessions.some((card) => card.sessionId === "2026-03-30-alpha"), true);
					assert.strictEqual(selectedCheckpointSessions.some((card) => card.sessionId === "2026-03-30-beta"), true);
				});
			} finally {
				GitCheckpointStore.prototype.getCheckpointSummary = originalGetCheckpointSummary;
			}
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});
});

function createRepoWithMetadata(
	repoDir: string,
	metadataRoot: string = fixtureRoot,
): {
	mainHead: string;
	secondCommit: string;
	multiTrailerCommit: string;
	featureOnlyCommit: string;
} {
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.name", "Test User"]);
	git(repoDir, ["config", "user.email", "test@example.com"]);
	git(repoDir, ["checkout", "-b", "main"]);

	mkdirSync(path.join(repoDir, "src"), { recursive: true });
	writeFileSync(path.join(repoDir, "README.md"), "# repo\n", "utf8");
	writeFileSync(path.join(repoDir, "src", "app.ts"), "export const parser = 'one';\n", "utf8");
	git(repoDir, ["add", "README.md", "src/app.ts"]);
	git(repoDir, ["commit", "-m", "Initial commit"]);

	writeFileSync(path.join(repoDir, "src", "app.ts"), "export const parser = 'two';\n", "utf8");
	git(repoDir, ["add", "src/app.ts"]);
	git(repoDir, ["commit", "-m", "First parser commit\n\nEntire-Checkpoint: a3b2c4d5e6f7"]);

	writeFileSync(path.join(repoDir, "README.md"), "# repo\n\nUpdated parser docs.\n", "utf8");
	git(repoDir, ["add", "README.md"]);
	git(repoDir, ["commit", "-m", "Second parser commit\n\nEntire-Checkpoint: a3b2c4d5e6f7"]);
	const secondCommit = git(repoDir, ["rev-parse", "HEAD"]).trim();

	git(repoDir, ["checkout", "-b", "feature/other"]);
	writeFileSync(path.join(repoDir, "src", "parser.ts"), "export const other = true;\n", "utf8");
	git(repoDir, ["add", "src/parser.ts"]);
	git(repoDir, ["commit", "-m", "Feature-only parser commit\n\nEntire-Checkpoint: b4c5d6e7f8a9"]);
	const featureOnlyCommit = git(repoDir, ["rev-parse", "HEAD"]).trim();
	git(repoDir, ["checkout", "main"]);

	writeFileSync(path.join(repoDir, "src", "merge.ts"), "export const squashed = true;\n", "utf8");
	git(repoDir, ["add", "src/merge.ts"]);
	git(repoDir, ["commit", "-m", "Squash merged feature work\n\nEntire-Checkpoint: a3b2c4d5e6f7\nEntire-Checkpoint: b4c5d6e7f8a9"]);
	const multiTrailerCommit = git(repoDir, ["rev-parse", "HEAD"]).trim();

	git(repoDir, ["checkout", "--orphan", "entire/checkpoints/v1"]);
	git(repoDir, ["rm", "-rf", "."]);
	cpSync(metadataRoot, repoDir, { recursive: true });
	git(repoDir, ["add", "."]);
	git(repoDir, ["commit", "-m", "Checkpoint metadata"]);
	git(repoDir, ["checkout", "main"]);

	return {
		mainHead: git(repoDir, ["rev-parse", "HEAD"]).trim(),
		secondCommit,
		multiTrailerCommit,
		featureOnlyCommit,
	};
}

function writeLiveSessionState(repoDir: string, state: Record<string, unknown>): void {
	const stateDir = path.join(repoDir, ".git", "entire-sessions");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(path.join(stateDir, `${state.session_id as string}.json`), JSON.stringify(state, null, 2), "utf8");
}

function createShadowBranch(repoDir: string, branchName: string): void {
	git(repoDir, ["branch", branchName, "HEAD"]);
}

function git(repoPath: string, args: string[]): string {
	const isolatedHome = path.join(repoPath, ".git-home");
	const isolatedGlobalConfig = path.join(isolatedHome, ".gitconfig");
	mkdirSync(isolatedHome, { recursive: true });
	writeFileSync(isolatedGlobalConfig, "", "utf8");

	return execFileSync("git", args, {
		cwd: repoPath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: gitEnvironment(repoPath),
	});
}

async function withMockEntire<T>(
	repoPath: string,
	rewindOutput: string,
	callback: () => Promise<T>,
): Promise<T> {
	const binDir = path.join(repoPath, ".mock-bin");
	const mockPath = path.join(binDir, "entire");
	mkdirSync(binDir, { recursive: true });

	const rewindFile = path.join(binDir, "rewind.json");
	const explainFile = path.join(binDir, "explain.txt");
	const explainFullFile = path.join(binDir, "explain-full.txt");
	writeFileSync(rewindFile, rewindOutput, "utf8");
	writeFileSync(explainFile, "Explain checkpoint a3b2c4d5e6f7", "utf8");
	writeFileSync(explainFullFile, "Full transcript for a3b2c4d5e6f7", "utf8");
	writeFileSync(
		mockPath,
		[
			"#!/bin/sh",
			"if [ \"$1\" = \"rewind\" ] && [ \"$2\" = \"--list\" ]; then",
			`  cat "${rewindFile}"`,
			"  exit 0",
			"fi",
			"if [ \"$1\" = \"explain\" ]; then",
			"  case \" $* \" in",
			"    *\" --full \"*)",
			`      cat "${explainFullFile}"`,
			"      exit 0",
			"      ;;",
			"    *)",
			`      cat "${explainFile}"`,
			"      exit 0",
			"      ;;",
			"  esac",
			"fi",
			"echo unsupported >&2",
			"exit 1",
			"",
		].join("\n"),
		"utf8",
	);
	fs.chmodSync(mockPath, 0o755);

	const previous = {
		HOME: process.env.HOME,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
		PATH: process.env.PATH,
	};

	Object.assign(process.env, gitEnvironment(repoPath));
	process.env.PATH = `${binDir}:${previous.PATH ?? ""}`;

	try {
		return await callback();
	} finally {
		restoreEnv(previous);
	}
}

function gitEnvironment(repoPath: string): NodeJS.ProcessEnv {
	const isolatedHome = path.join(repoPath, ".git-home");
	const isolatedGlobalConfig = path.join(isolatedHome, ".gitconfig");

	return {
		...process.env,
		HOME: isolatedHome,
		XDG_CONFIG_HOME: isolatedHome,
		GIT_CONFIG_GLOBAL: isolatedGlobalConfig,
		GIT_CONFIG_SYSTEM: "/dev/null",
	};
}

function createTempRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "session-bridge-module-"));
}

function cloneFixtureRoot(prefix: string): string {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cpSync(fixtureRoot, tempRoot, { recursive: true });
	return tempRoot;
}

function updateSessionMetadataCreatedAt(rootDir: string, metadataPath: string, createdAt: string): void {
	const fullPath = path.join(rootDir, metadataPath);
	const metadata = JSON.parse(fs.readFileSync(fullPath, "utf8")) as { created_at?: string };
	metadata.created_at = createdAt;
	writeFileSync(fullPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function restoreEnv(previous: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}
