import * as assert from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import { parseNativeSessionTranscript } from "../../checkpoints/nativeTranscript";

const claudeFixturePath = path.resolve(
	__dirname,
	"../../../src/test/checkpoints/fixtures/transcript/162eec7c33-0-sample.jsonl",
);

function toJsonl(lines: unknown[]): string {
	return lines.map((line) => JSON.stringify(line)).join("\n");
}

suite("Native Transcript Parsing", () => {
	test("parses Claude Code JSONL transcripts", () => {
		const transcript = readFileSync(claudeFixturePath, "utf8");
		const parsed = parseNativeSessionTranscript(transcript);

		assert.ok(parsed);
		assert.strictEqual(parsed?.parserId, "claude_code");
		assert.strictEqual(parsed?.sessionId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
		assert.strictEqual(parsed?.workspace, "/workspace/fixture-project");
		assert.strictEqual(parsed?.promptPreview, "Can you inspect the failing CI run and tell me why the fallback agent is erroring?");
		assert.strictEqual(parsed?.toolCount, 1);
		assert.strictEqual(parsed?.turns.length, 4);
		assert.strictEqual(parsed?.turns[2]?.toolActivities[0]?.label, "Bash");
	});

	test("parses current Codex rollout transcripts and skips synthetic primers", () => {
		const transcript = toJsonl([
			{
				timestamp: "2026-04-01T23:31:26.000Z",
				type: "session_meta",
				payload: {
					id: "019d4f9e-feac-7be2-a885-bf0727a50a92",
					timestamp: "2026-04-01T23:31:26.000Z",
					cwd: "/repo",
					cli_version: "0.118.0",
				},
			},
			{
				timestamp: "2026-04-01T23:31:26.002Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text: "<permissions instructions>\nYou are sandboxed.\n</permissions instructions>" }],
				},
			},
			{
				timestamp: "2026-04-01T23:31:26.003Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "# AGENTS.md\nThese are the project instructions." },
						{ type: "input_text", text: "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>" },
					],
				},
			},
			{
				timestamp: "2026-04-01T23:31:26.500Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Bootstrapping the workspace context before we begin." }],
				},
			},
			{
				timestamp: "2026-04-01T23:31:27.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "create a hello.txt file with a greeting" }],
				},
			},
			{
				timestamp: "2026-04-01T23:31:27.001Z",
				type: "event_msg",
				payload: {
					type: "user_message",
					message: "create a hello.txt file with a greeting",
				},
			},
			{
				timestamp: "2026-04-01T23:31:31.001Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Creating the file now." }],
				},
			},
			{
				timestamp: "2026-04-01T23:31:32.000Z",
				type: "response_item",
				payload: {
					type: "function_call",
					name: "exec_command",
					arguments: JSON.stringify({
						cmd: "cat > hello.txt << 'EOF'\nHello, world!\nEOF",
						workdir: "/repo",
					}),
					call_id: "call_abc123",
				},
			},
			{
				timestamp: "2026-04-01T23:31:32.501Z",
				type: "response_item",
				payload: {
					type: "function_call_output",
					call_id: "call_abc123",
					output: "Command: cat > hello.txt\nWall time: 0.001 seconds\nProcess exited with code 0",
				},
			},
			{
				timestamp: "2026-04-01T23:31:38.501Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Done. hello.txt created." }],
				},
			},
		]);

		const parsed = parseNativeSessionTranscript(transcript);

		assert.ok(parsed);
		assert.strictEqual(parsed?.parserId, "codex");
		assert.strictEqual(parsed?.sessionId, "019d4f9e-feac-7be2-a885-bf0727a50a92");
		assert.strictEqual(parsed?.workspace, "/repo");
		assert.strictEqual(parsed?.promptPreview, "create a hello.txt file with a greeting");
		assert.strictEqual(parsed?.toolCount, 1);
		assert.strictEqual(parsed?.turns[0]?.actor.kind, "user");
		assert.strictEqual(parsed?.turns[0]?.text, "create a hello.txt file with a greeting");
		assert.strictEqual(parsed?.turns.some((turn) => turn.text?.includes("Bootstrapping the workspace context")), false);
		assert.strictEqual(parsed?.turns.some((turn) => turn.text?.includes("Done. hello.txt created.")), true);
		assert.strictEqual(parsed?.turns.filter((turn) => turn.text === "create a hello.txt file with a greeting").length, 1);
		assert.strictEqual(parsed?.turns.some((turn) => turn.toolActivities[0]?.detail?.includes("cat > hello.txt")), true);
	});

	test("parses Codex reasoning and command output as auxiliary blocks", () => {
		const transcript = toJsonl([
			{
				timestamp: "2026-04-01T23:31:26.000Z",
				type: "session_meta",
				payload: {
					id: "codex-session-with-thinking",
					timestamp: "2026-04-01T23:31:26.000Z",
					cwd: "/repo",
				},
			},
			{
				timestamp: "2026-04-01T23:31:27.000Z",
				type: "event_msg",
				payload: {
					type: "user_message",
					message: "render the transcript view",
				},
			},
			{
				timestamp: "2026-04-01T23:31:28.000Z",
				type: "event_msg",
				payload: {
					type: "agent_reasoning",
					text: "Need a layout that keeps auxiliary events out of the primary reading flow.",
				},
			},
			{
				timestamp: "2026-04-01T23:31:29.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Drafting the redesign now." }],
				},
			},
			{
				timestamp: "2026-04-01T23:31:30.000Z",
				type: "response_item",
				payload: {
					type: "function_call",
					name: "exec_command",
					arguments: JSON.stringify({ cmd: "pnpm test", workdir: "/repo" }),
					call_id: "call_redesign",
				},
			},
			{
				timestamp: "2026-04-01T23:31:31.000Z",
				type: "response_item",
				payload: {
					type: "function_call_output",
					call_id: "call_redesign",
					output: "[success] View rendered at 15:10:42.",
				},
			},
		]);

		const parsed = parseNativeSessionTranscript(transcript, { agentHint: "codex", userHint: "Save Kirk" });

		assert.ok(parsed);
		assert.strictEqual(parsed?.turns.some((turn) => turn.auxiliaryBlocks?.some((block) => block.kind === "thinking")), true);
		assert.strictEqual(parsed?.turns.some((turn) => turn.auxiliaryBlocks?.some((block) => block.kind === "tool_use")), true);
		assert.strictEqual(parsed?.turns.some((turn) => turn.auxiliaryBlocks?.some((block) => block.kind === "output")), true);
		assert.strictEqual(parsed?.turns.some((turn) => turn.text === "Drafting the redesign now."), true);
		assert.strictEqual(parsed?.turns[0]?.actor.name, "Save Kirk");
		assert.strictEqual(parsed?.turns[2]?.actor.name, "Codex");
	});

	test("parses Gemini JSON transcripts", () => {
		const transcript = JSON.stringify({
			sessionId: "gemini-session-1",
			projectHash: "abc123",
			startTime: "2026-03-18T21:05:13.497Z",
			lastUpdated: "2026-03-18T21:05:20.932Z",
			messages: [
				{
					id: "u1",
					timestamp: "2026-03-18T21:05:13.497Z",
					type: "user",
					content: "create a test.go",
				},
				{
					id: "a1",
					timestamp: "2026-03-18T21:05:20.932Z",
					type: "gemini",
					content: "",
					toolCalls: [
						{
							id: "write_file-1",
							name: "write_file",
							args: {
								file_path: "test.go",
								content: "package main",
							},
						},
					],
					model: "gemini-2.5-flash",
				},
				{
					id: "a2",
					timestamp: "2026-03-18T21:05:21.500Z",
					type: "gemini",
					content: [{ text: "Created `test.go`." }],
					model: "gemini-2.5-flash",
				},
			],
		});

		const parsed = parseNativeSessionTranscript(transcript);

		assert.ok(parsed);
		assert.strictEqual(parsed?.parserId, "gemini");
		assert.strictEqual(parsed?.sessionId, "gemini-session-1");
		assert.strictEqual(parsed?.promptPreview, "create a test.go");
		assert.strictEqual(parsed?.model, "gemini-2.5-flash");
		assert.strictEqual(parsed?.startedAt, "2026-03-18T21:05:13.497Z");
		assert.strictEqual(parsed?.toolCount, 1);
		assert.strictEqual(parsed?.turns[1]?.toolActivities[0]?.label, "write_file");
	});

	test("parses Copilot CLI event logs", () => {
		const transcript = toJsonl([
			{
				type: "session.start",
				data: {
					sessionId: "copilot-session-1",
					copilotVersion: "1.0.20",
					context: {
						cwd: "/repo",
						branch: "feature/test",
					},
				},
				id: "1",
				timestamp: "2026-04-07T21:07:18.780Z",
			},
			{
				type: "user.message",
				data: {
					content: "create hello.txt",
				},
				id: "2",
				timestamp: "2026-04-07T21:07:50.689Z",
			},
			{
				type: "tool.execution_complete",
				data: {
					toolCallId: "tc1",
					model: "claude-sonnet-4.6",
					toolTelemetry: {
						properties: {
							filePaths: "[\"/repo/hello.txt\"]",
						},
						metrics: {
							linesAdded: 1,
							linesRemoved: 0,
						},
					},
				},
				id: "3",
				timestamp: "2026-04-07T21:08:33.660Z",
			},
			{
				type: "assistant.message",
				data: {
					content: "Created hello.txt.",
				},
				id: "4",
				timestamp: "2026-04-07T21:08:41.062Z",
			},
		]);

		const parsed = parseNativeSessionTranscript(transcript);

		assert.ok(parsed);
		assert.strictEqual(parsed?.parserId, "copilot_cli");
		assert.strictEqual(parsed?.sessionId, "copilot-session-1");
		assert.strictEqual(parsed?.workspace, "/repo");
		assert.strictEqual(parsed?.model, "claude-sonnet-4.6");
		assert.strictEqual(parsed?.promptPreview, "create hello.txt");
		assert.strictEqual(parsed?.toolCount, 1);
		assert.strictEqual(parsed?.metadata.branch, "feature/test");
		assert.strictEqual(parsed?.turns[1]?.toolActivities[0]?.detail, "files: /repo/hello.txt · +1 · -0");
	});

	test("parses OpenCode export transcripts", () => {
		const transcript = JSON.stringify({
			info: {
				id: "ses_opencode_1",
				title: "Replace entire with go run command",
				directory: "/private/entire/cli",
				time: {
					created: 1773867525006,
					updated: 1773867821539,
				},
			},
			messages: [
				{
					info: {
						role: "user",
						id: "msg_user_1",
						time: {
							created: 1773867525015,
						},
						sessionID: "ses_opencode_1",
					},
					parts: [
						{
							type: "text",
							text: "<system-reminder>tooling note</system-reminder>\nFix the parser",
						},
					],
				},
				{
					info: {
						role: "assistant",
						id: "msg_assistant_1",
						modelID: "claude-opus-4-6",
						path: {
							cwd: "/private/entire/cli",
						},
						time: {
							created: 1773867525023,
						},
						sessionID: "ses_opencode_1",
					},
					parts: [
						{
							type: "text",
							text: "Let me inspect the integration first.",
						},
						{
							type: "tool",
							callID: "toolu_01",
							tool: "task",
							state: {
								input: {
									description: "Explore opencode agent integration",
								},
								output: "task complete",
							},
						},
					],
				},
			],
		});

		const parsed = parseNativeSessionTranscript(transcript);

		assert.ok(parsed);
		assert.strictEqual(parsed?.parserId, "opencode");
		assert.strictEqual(parsed?.sessionId, "ses_opencode_1");
		assert.strictEqual(parsed?.title, "Replace entire with go run command");
		assert.strictEqual(parsed?.workspace, "/private/entire/cli");
		assert.strictEqual(parsed?.promptPreview, "Fix the parser");
		assert.strictEqual(parsed?.model, "claude-opus-4-6");
		assert.strictEqual(parsed?.toolCount, 1);
		assert.strictEqual(parsed?.turns[1]?.toolActivities[0]?.label, "task");
	});

	test("parses Factory Droid transcripts", () => {
		const transcript = toJsonl([
			{
				type: "session_start",
				id: "factory-session-1",
				title: "create a markdown file",
				owner: "testuser",
				cwd: "/repo",
			},
			{
				type: "message",
				id: "1",
				timestamp: "2026-03-30T18:50:09.639Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "create hello.md" }],
				},
			},
			{
				type: "message",
				id: "2",
				timestamp: "2026-03-30T18:50:12.100Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I'll create hello.md for you." },
						{ type: "tool_use", id: "tu-1", name: "Write", input: { file_path: "hello.md" } },
					],
				},
			},
		]);

		const parsed = parseNativeSessionTranscript(transcript);

		assert.ok(parsed);
		assert.strictEqual(parsed?.parserId, "factory");
		assert.strictEqual(parsed?.sessionId, "factory-session-1");
		assert.strictEqual(parsed?.workspace, "/repo");
		assert.strictEqual(parsed?.promptPreview, "create hello.md");
		assert.strictEqual(parsed?.toolCount, 1);
		assert.strictEqual(parsed?.metadata.owner, "testuser");
	});

	test("parses Cursor transcripts and strips user_query wrappers", () => {
		const transcript = toJsonl([
			{
				role: "user",
				message: {
					content: [{ type: "text", text: "<user_query>\nhello\n</user_query>" }],
				},
			},
			{
				role: "assistant",
				message: {
					content: [{ type: "text", text: "Hi there!" }],
				},
			},
		]);

		const parsed = parseNativeSessionTranscript(transcript);

		assert.ok(parsed);
		assert.strictEqual(parsed?.parserId, "cursor");
		assert.strictEqual(parsed?.promptPreview, "hello");
		assert.strictEqual(parsed?.toolCount, 0);
		assert.strictEqual(parsed?.turns[0]?.text, "hello");
		assert.strictEqual(parsed?.turns[1]?.text, "Hi there!");
	});
});
