import * as assert from "assert";
import { execFileSync } from "child_process";
import { cpSync, mkdirSync, writeFileSync } from "fs";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	buildCheckpointGitEnv,
	buildCheckpointMirrorRevision,
	FileSystemCheckpointStore,
	GitCheckpointStore,
	countTranscriptToolUses,
	extractTranscriptPrompt,
	getGitRepoRoot,
	parseGitRemoteURL,
	parseTranscript,
	resolveCheckpointStore,
} from "../../checkpoints";

const fixtureRoot = path.resolve(__dirname, "../../../src/test/checkpoints/fixtures/store");

suite("Checkpoint Stores", () => {
	test("FileSystemCheckpointStore lists checkpoint summaries", async () => {
		const store = new FileSystemCheckpointStore(fixtureRoot);
		const checkpoints = await store.listCheckpoints();

		assert.strictEqual(checkpoints.length, 4);
		assert.strictEqual(checkpoints[0].checkpointId, "b4c5d6e7f8a9");
		assert.strictEqual(checkpoints[1].checkpointId, "a3b2c4d5e6f7");
		assert.strictEqual(checkpoints[2].checkpointId, "c6d7e8f9a0b1");
		assert.strictEqual(checkpoints[3].checkpointId, "d7e8f9a0b1c2");
		assert.strictEqual(checkpoints[1].sessions.length, 2);
		assert.strictEqual(checkpoints[1].cliVersion, "0.5.2");
	});

	test("FileSystemCheckpointStore reads session content by id with rich metadata", async () => {
		const store = new FileSystemCheckpointStore(fixtureRoot);
		const session = await store.getSessionContentById("a3b2c4d5e6f7", "2026-03-30-alpha");

		assert.strictEqual(session.metadata.sessionId, "2026-03-30-alpha");
		assert.strictEqual(session.metadata.sessionMetrics?.turnCount, 4);
		assert.strictEqual(session.metadata.summary?.intent, "Build the parser");
		assert.strictEqual(session.metadata.initialAttribution?.agentLines, 42);
		assert.match(session.context ?? "", /Parser context/);
	});

	test("FileSystemCheckpointStore groups checkpoints into sessions", async () => {
		const store = new FileSystemCheckpointStore(fixtureRoot);
		const sessions = await store.listSessions();

		assert.strictEqual(sessions.length, 5);

		const alpha = sessions.find((session) => session.id === "2026-03-30-alpha");
		assert.ok(alpha);
		assert.strictEqual(alpha.checkpoints.length, 2);
		assert.strictEqual(alpha.description, "Build the parser");

		const gamma = sessions.find((session) => session.id === "2026-03-30-gamma");
		assert.ok(gamma);
		assert.strictEqual(gamma.startTime, "2026-03-30T09:30:00Z");
		assert.strictEqual(gamma.description, "Follow the chunked transcript");
	});

	test("FileSystemCheckpointStore returns null transcript and prompt when fixture files are missing", async () => {
		const store = new FileSystemCheckpointStore(fixtureRoot);
		const session = await store.getSessionContent("b4c5d6e7f8a9", 0);

		assert.strictEqual(session.transcript, null);
		assert.strictEqual(session.context, null);
		assert.strictEqual(session.prompts, null);
		assert.strictEqual(session.metadata.initialAttribution?.agentPercentage, 100);
	});

	test("transcript helpers derive prompt and tool count", async () => {
		const store = new FileSystemCheckpointStore(fixtureRoot);
		const session = await store.getSessionContent("a3b2c4d5e6f7", 0);
		const events = parseTranscript(session.transcript ?? "");

		assert.strictEqual(events.length, 3);
		assert.strictEqual(events[0].eventType, "user");
		assert.strictEqual(extractTranscriptPrompt(session.transcript), "Build the parser");
		assert.strictEqual(countTranscriptToolUses(session.transcript), 2);
	});

	test("stores read chunked jsonl transcripts and legacy full.log transcripts", async () => {
		const store = new FileSystemCheckpointStore(fixtureRoot);
		const chunked = await store.getSessionContentById("c6d7e8f9a0b1", "2026-03-30-gamma");
		const legacy = await store.getSessionContentById("c6d7e8f9a0b1", "2026-03-30-delta");

		assert.ok(chunked.transcript?.includes("Follow the chunked transcript"));
		assert.ok(chunked.transcript?.includes("Chunked transcript complete"));
		assert.strictEqual(extractTranscriptPrompt(chunked.transcript), "Follow the chunked transcript");
		assert.strictEqual(countTranscriptToolUses(chunked.transcript), 1);

		assert.ok(legacy.transcript?.includes("Review the legacy log transcript"));
		assert.ok(legacy.transcript?.includes("Legacy log review complete"));
	});

	test("GitCheckpointStore reads metadata branch and commit trailer links", async () => {
		const repoDir = createTempRepo();

		try {
			git(repoDir, ["init"]);
			git(repoDir, ["config", "user.name", "Test User"]);
			git(repoDir, ["config", "user.email", "test@example.com"]);
			git(repoDir, ["checkout", "-b", "main"]);

			writeFileSync(path.join(repoDir, "README.md"), "# temp repo\n", "utf8");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "Initial commit\n\nEntire-Checkpoint: a3b2c4d5e6f7"]);

			git(repoDir, ["checkout", "--orphan", "entire/checkpoints/v1"]);
			git(repoDir, ["rm", "-rf", "."]);
			cpSync(fixtureRoot, repoDir, { recursive: true });
			git(repoDir, ["add", "."]);
			git(repoDir, ["commit", "-m", "Checkpoint metadata"]);
			git(repoDir, ["checkout", "main"]);

			await withGitEnvironment(repoDir, async () => {
				const store = new GitCheckpointStore(repoDir);
				assert.strictEqual(await store.findCheckpointIdForCommit("HEAD"), "a3b2c4d5e6f7");

				const summary = await store.getCheckpointSummary("a3b2c4d5e6f7");
				assert.ok(summary);
				assert.strictEqual(summary.sessions.length, 2);
				assert.strictEqual(summary.sessions[0].context, "/a3/b2c4d5e6f7/0/context.md");

				const session = await store.getSessionContentById("a3b2c4d5e6f7", "2026-03-30-alpha");
				assert.match(session.context ?? "", /Parser context/);
				assert.match(session.prompts ?? "", /Build the parser/);

				const chunked = await store.getSessionContentById("c6d7e8f9a0b1", "2026-03-30-gamma");
				assert.ok(chunked.transcript?.includes("Chunked transcript complete"));

				const legacy = await store.getSessionContentById("c6d7e8f9a0b1", "2026-03-30-delta");
				assert.ok(legacy.transcript?.includes("Legacy log review complete"));
			});
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});

	test("resolveCheckpointStore reads checkpoint metadata from mirror ref when local branch is missing", async () => {
		const repoDir = createTempRepo();

		try {
			git(repoDir, ["init"]);
			git(repoDir, ["config", "user.name", "Test User"]);
			git(repoDir, ["config", "user.email", "test@example.com"]);
			git(repoDir, ["checkout", "-b", "main"]);

			writeFileSync(path.join(repoDir, "README.md"), "# temp repo\n", "utf8");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "Initial commit\n\nEntire-Checkpoint: a3b2c4d5e6f7"]);

			installMetadataRef(repoDir, buildCheckpointMirrorRevision("github", "org/checkpoints"));
			writeSettings(repoDir, {
				enabled: true,
				strategy_options: {
					checkpoint_remote: {
						provider: "github",
						repo: "org/checkpoints",
					},
				},
			});

			await withGitEnvironment(repoDir, async () => {
				const localStore = new GitCheckpointStore(repoDir);
				assert.strictEqual(await localStore.getCheckpointSummary("a3b2c4d5e6f7"), null);

				const store = await resolveCheckpointStore(repoDir, { requiredCheckpointIds: ["a3b2c4d5e6f7"] });
				const summary = await store.getCheckpointSummary("a3b2c4d5e6f7");
				assert.ok(summary);
				assert.strictEqual(summary?.sessions.length, 2);

				const session = await store.getSessionContentById("a3b2c4d5e6f7", "2026-03-30-alpha");
				assert.match(session.context ?? "", /Parser context/);
				assert.match(session.prompts ?? "", /Build the parser/);
			});
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});

	test("resolveCheckpointStore falls back to origin remote-tracking metadata", async () => {
		const repoDir = createTempRepo();

		try {
			git(repoDir, ["init"]);
			git(repoDir, ["config", "user.name", "Test User"]);
			git(repoDir, ["config", "user.email", "test@example.com"]);
			git(repoDir, ["checkout", "-b", "main"]);

			writeFileSync(path.join(repoDir, "README.md"), "# temp repo\n", "utf8");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "Initial commit\n\nEntire-Checkpoint: a3b2c4d5e6f7"]);

			installMetadataRef(repoDir, "refs/remotes/origin/entire/checkpoints/v1");

			await withGitEnvironment(repoDir, async () => {
				const localStore = new GitCheckpointStore(repoDir);
				assert.strictEqual(await localStore.getCheckpointSummary("a3b2c4d5e6f7"), null);

				const store = await resolveCheckpointStore(repoDir, { requiredCheckpointIds: ["a3b2c4d5e6f7"] });
				const summary = await store.getCheckpointSummary("a3b2c4d5e6f7");
				assert.ok(summary);
				assert.strictEqual(summary?.sessions.length, 2);
			});
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});

	test("checkpoint remote helpers preserve CLI auth and parsing behavior", () => {
		const previousToken = process.env.ENTIRE_CHECKPOINT_TOKEN;
		process.env.ENTIRE_CHECKPOINT_TOKEN = "secret-token";

		try {
			const httpsEnv = buildCheckpointGitEnv("https://github.com/org/checkpoints.git", { ...process.env });
			assert.strictEqual(httpsEnv.GIT_TERMINAL_PROMPT, "0");
			assert.strictEqual(httpsEnv.GIT_CONFIG_COUNT, "1");
			assert.strictEqual(httpsEnv.GIT_CONFIG_KEY_0, "http.extraHeader");
			assert.ok((httpsEnv.GIT_CONFIG_VALUE_0 ?? "").includes("Authorization: Basic "));

			const sshEnv = buildCheckpointGitEnv("git@github.com:org/checkpoints.git", { ...process.env });
			assert.strictEqual(sshEnv.GIT_TERMINAL_PROMPT, "0");
			assert.strictEqual(sshEnv.GIT_CONFIG_COUNT, undefined);

			const localEnv = buildCheckpointGitEnv("/tmp/checkpoints.git", { ...process.env });
			assert.strictEqual(localEnv.GIT_TERMINAL_PROMPT, "0");
			assert.strictEqual(localEnv.GIT_CONFIG_COUNT, undefined);

			const remoteInfo = parseGitRemoteURL("ssh://git@github.example.com/org/repo.git");
			assert.strictEqual(remoteInfo.protocol, "ssh");
			assert.strictEqual(remoteInfo.host, "github.example.com");
			assert.strictEqual(remoteInfo.owner, "org");
			assert.strictEqual(remoteInfo.repo, "repo");
		} finally {
			if (previousToken === undefined) {
				delete process.env.ENTIRE_CHECKPOINT_TOKEN;
			} else {
				process.env.ENTIRE_CHECKPOINT_TOKEN = previousToken;
			}
		}
	});

	test("getGitRepoRoot resolves nested file paths to the repository root", async () => {
		const repoDir = createTempRepo();

		try {
			git(repoDir, ["init"]);
			git(repoDir, ["config", "user.name", "Test User"]);
			git(repoDir, ["config", "user.email", "test@example.com"]);
			const nestedDir = path.join(repoDir, "src", "nested");
			mkdirSync(nestedDir, { recursive: true });
			const nestedFile = path.join(nestedDir, "example.ts");
			writeFileSync(nestedFile, "export const value = 1;\n", "utf8");

			await withGitEnvironment(repoDir, async () => {
				assert.strictEqual(fs.realpathSync(await getGitRepoRoot(nestedFile) ?? ""), fs.realpathSync(repoDir));
				assert.strictEqual(fs.realpathSync(await getGitRepoRoot(nestedDir) ?? ""), fs.realpathSync(repoDir));
			});
		} finally {
			fs.rmSync(repoDir, { recursive: true, force: true });
		}
	});
});

function createTempRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "session-bridge-checkpoints-"));
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

function installMetadataRef(repoDir: string, refName: string): void {
	const currentBranch = git(repoDir, ["branch", "--show-current"]).trim();
	const tempBranch = `metadata-${Date.now().toString(16)}`;

	git(repoDir, ["checkout", "--orphan", tempBranch]);
	git(repoDir, ["rm", "-rf", "."]);
	cpSync(fixtureRoot, repoDir, { recursive: true });
	git(repoDir, ["add", "."]);
	git(repoDir, ["commit", "-m", "Checkpoint metadata"]);
	const metadataCommit = git(repoDir, ["rev-parse", "HEAD"]).trim();
	git(repoDir, ["update-ref", refName, metadataCommit]);
	git(repoDir, ["checkout", currentBranch]);
	git(repoDir, ["branch", "-D", tempBranch]);
}

function writeSettings(repoDir: string, settings: Record<string, unknown>): void {
	const settingsDir = path.join(repoDir, ".entire");
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(path.join(settingsDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function withGitEnvironment<T>(repoPath: string, callback: () => Promise<T>): Promise<T> {
	const previous = {
		HOME: process.env.HOME,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
	};

	Object.assign(process.env, gitEnvironment(repoPath));

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

function restoreEnv(previous: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}
