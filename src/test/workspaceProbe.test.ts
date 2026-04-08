import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { METADATA_BRANCH_NAME } from "../checkpoints";
import { EntireStatusState, probeEntireWorkspace, resetAutomaticCheckpointFetchAttempt } from "../workspaceProbe";

const fixtureRoot = path.resolve(__dirname, "../../src/test/checkpoints/fixtures/store");

suite("Workspace Probe", () => {
	test("enables a repository when the local checkpoint metadata branch exists without .entire settings", async () => {
		const repoDir = createTempRepo();
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-probe-home-"));
		const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-probe-bin-"));
		const originalHome = process.env["HOME"];
		const originalPath = process.env["PATH"];

		try {
			createFakeEntireBinary(binDir);
			createMetadataBranch(repoDir);

			process.env["HOME"] = homeDir;
			process.env["PATH"] = `${binDir}${path.delimiter}${originalPath ?? ""}`;

			const workspaceState = await probeEntireWorkspace(repoDir);
			assert.strictEqual(workspaceState.state, EntireStatusState.ENABLED);
			assert.ok(workspaceState.warnings.includes("No Entire settings file found."));
			assert.ok(
				workspaceState.warnings.some((warning) => warning.includes(METADATA_BRANCH_NAME)),
				`expected a warning mentioning ${METADATA_BRANCH_NAME}`,
			);
		} finally {
			if (originalHome === undefined) {
				delete process.env["HOME"];
			} else {
				process.env["HOME"] = originalHome;
			}
			if (originalPath === undefined) {
				delete process.env["PATH"];
			} else {
				process.env["PATH"] = originalPath;
			}
			fs.rmSync(repoDir, { recursive: true, force: true });
			fs.rmSync(homeDir, { recursive: true, force: true });
			fs.rmSync(binDir, { recursive: true, force: true });
		}
	});

	test("fetches the default checkpoint branch automatically when .entire is absent", async () => {
		const repoDir = createTempRepo();
		const remoteDir = createRemoteRepoWithMetadata();
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-probe-home-"));
		const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-probe-bin-"));
		const originalHome = process.env["HOME"];
		const originalPath = process.env["PATH"];

		try {
			createFakeEntireBinary(binDir);
			execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
			resetAutomaticCheckpointFetchAttempt(repoDir);

			process.env["HOME"] = homeDir;
			process.env["PATH"] = `${binDir}${path.delimiter}${originalPath ?? ""}`;

			const workspaceState = await probeEntireWorkspace(repoDir);
			assert.strictEqual(workspaceState.state, EntireStatusState.ENABLED);
			assert.ok(workspaceState.warnings.includes("No Entire settings file found."));
			assert.ok(workspaceState.warnings.includes(`Fetched ${METADATA_BRANCH_NAME} from origin automatically.`));
			assert.ok(
				execFileSync("git", ["show-ref", "--verify", `refs/heads/${METADATA_BRANCH_NAME}`], {
					cwd: repoDir,
					stdio: ["ignore", "pipe", "pipe"],
				}).toString().includes(METADATA_BRANCH_NAME),
			);
		} finally {
			resetAutomaticCheckpointFetchAttempt(repoDir);
			if (originalHome === undefined) {
				delete process.env["HOME"];
			} else {
				process.env["HOME"] = originalHome;
			}
			if (originalPath === undefined) {
				delete process.env["PATH"];
			} else {
				process.env["PATH"] = originalPath;
			}
			fs.rmSync(repoDir, { recursive: true, force: true });
			fs.rmSync(remoteDir, { recursive: true, force: true });
			fs.rmSync(homeDir, { recursive: true, force: true });
			fs.rmSync(binDir, { recursive: true, force: true });
		}
	});
});

function createTempRepo(): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-probe-repo-"));
	execFileSync("git", ["init"], { cwd: repoDir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
	fs.writeFileSync(path.join(repoDir, "README.md"), "workspace probe fixture\n", "utf8");
	execFileSync("git", ["add", "README.md"], { cwd: repoDir });
	execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });
	return repoDir;
}

function createMetadataBranch(repoDir: string): void {
	execFileSync("git", ["branch", METADATA_BRANCH_NAME], { cwd: repoDir });
}

function createRemoteRepoWithMetadata(): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-probe-remote-"));
	execFileSync("git", ["init"], { cwd: repoDir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
	execFileSync("git", ["checkout", "--orphan", METADATA_BRANCH_NAME], { cwd: repoDir });
	fs.cpSync(fixtureRoot, repoDir, { recursive: true });
	execFileSync("git", ["add", "."], { cwd: repoDir });
	execFileSync("git", ["commit", "-m", "Checkpoint metadata"], { cwd: repoDir });
	return repoDir;
}

function createFakeEntireBinary(binDir: string): void {
	const binaryPath = path.join(binDir, "entire");
	fs.writeFileSync(
		binaryPath,
		[
			"#!/bin/sh",
			"if [ \"$1\" = \"version\" ]; then",
			"  printf 'entire version 0.1.0\\nGo version: go1.24.0\\nOS/Arch: test/test\\n'",
			"  exit 0",
			"fi",
			"if [ \"$1\" = \"status\" ]; then",
			"  printf 'disabled\\n'",
			"  exit 1",
			"fi",
			"exit 1",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
}
