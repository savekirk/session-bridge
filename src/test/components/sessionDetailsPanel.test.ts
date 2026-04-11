import * as assert from "assert";
import { renderSessionDetailsHtml, type SessionDetailsViewState } from "../../components/sessionDetailsPanel";

suite("Session Details Panel", () => {
	test("detail renderer keeps tool activity inside the turn without duplicate rows", () => {
		const state: SessionDetailsViewState = {
			kind: "detail",
			detail: {
				sessionId: "session-123",
				source: "live",
				promptPreview: "Build the session details panel",
				status: "ACTIVE",
				startedAt: "2026-04-04T10:00:00Z",
				lastActivityAt: "2026-04-04T10:05:00Z",
				durationMs: 300_000,
				checkpointCount: 2,
				turnCount: 2,
				toolCount: 1,
				tokenCount: 1_200,
				model: "sonnet",
				transcriptAvailable: true,
				turns: [
					{
						id: "turn-user",
						actor: {
							kind: "user",
							name: "Save Kirk",
							initials: "SK",
						},
						timestamp: "2026-04-04T10:00:00Z",
						text: "Build a session details webview.",
						toolActivities: [],
					},
					{
						id: "turn-agent",
						actor: {
							kind: "agent",
							name: "Claude Code",
							initials: "CC",
						},
						timestamp: "2026-04-04T10:01:00Z",
						text: "I’m grounding in the extension structure first.",
						toolActivities: [
							{
								id: "tool-bash",
								kind: "tool_use",
								label: "Bash",
								detail: "rg -n session src",
							},
						],
					},
				],
			},
		};

		const html = renderSessionDetailsHtml(state, { cspSource: "vscode-webview:" });
		assert.ok(html.includes("Build the session details panel"));
		assert.ok(html.includes("Save Kirk"));
		assert.ok(html.includes("Claude Code"));
		assert.ok(html.includes("Bash"));
		assert.ok(html.includes("rg -n session src"));
		assert.strictEqual(html.match(/class="avatar"/g)?.length, 2);
		assert.strictEqual(html.includes(">SK<"), false);
		assert.strictEqual(html.includes(">CC<"), false);
		assert.strictEqual(html.match(/class="auxiliary auxiliary--tool_use"/g)?.length, 1);
		assert.strictEqual(html.includes("Tool: Bash"), true);
		assert.strictEqual(html.includes(">Tool Execution<"), false);
		assert.strictEqual(html.includes("<details"), true);
		assert.strictEqual(html.match(/rg -n session src/g)?.length, 1);
		assert.strictEqual(html.includes("turn__raw"), false);
	});

	test("detail renderer uses full dates in header meta cards", () => {
		const html = renderSessionDetailsHtml({
			kind: "detail",
			detail: {
				sessionId: "session-header-dates",
				source: "live",
				promptPreview: "Header dates",
				status: "ACTIVE",
				startedAt: "2026-04-04T10:00:00Z",
				lastActivityAt: "2026-04-04T10:05:00Z",
				durationMs: 300_000,
				checkpointCount: 1,
				transcriptAvailable: true,
				turns: [],
			},
		}, { cspSource: "vscode-webview:" });

		assert.strictEqual(html.match(/April/g)?.length, 2);
		assert.strictEqual(html.match(/2026/g)?.length, 2);
	});

	test("detail renderer derives the header agent label from transcript turns when detail agent is missing", () => {
		const html = renderSessionDetailsHtml({
			kind: "detail",
			detail: {
				sessionId: "session-missing-agent",
				source: "live",
				promptPreview: "Agent summary fallback",
				status: "ACTIVE",
				startedAt: "2026-04-04T10:00:00Z",
				lastActivityAt: "2026-04-04T10:05:00Z",
				durationMs: 300_000,
				checkpointCount: 1,
				model: "sonnet",
				transcriptAvailable: true,
				turns: [
					{
						id: "turn-user",
						actor: {
							kind: "user",
							name: "Save Kirk",
							initials: "SK",
						},
						timestamp: "2026-04-04T10:00:00Z",
						text: "Build a session details webview.",
						toolActivities: [],
					},
					{
						id: "turn-agent",
						actor: {
							kind: "agent",
							name: "Claude Code",
							initials: "CC",
						},
						timestamp: "2026-04-04T10:01:00Z",
						text: "Grounding in the extension structure first.",
						toolActivities: [],
					},
				],
			},
		}, { cspSource: "vscode-webview:" });

		assert.ok(html.includes("Claude Code (sonnet)"));
		assert.strictEqual(html.includes("undefined"), false);
	});

	test("detail renderer lets the header title expand beside the status badge", () => {
		const html = renderSessionDetailsHtml({
			kind: "detail",
			detail: {
				sessionId: "session-wide-header",
				source: "live",
				promptPreview: "Add vscode and .idea ignores to .gitignore",
				status: "IDLE",
				startedAt: "2026-04-04T10:00:00Z",
				lastActivityAt: "2026-04-04T10:05:00Z",
				durationMs: 300_000,
				checkpointCount: 1,
				transcriptAvailable: true,
				turns: [],
			},
		}, { cspSource: "vscode-webview:" });

		assert.ok(html.includes('class="summary__headline"'));
		assert.ok(html.includes("margin-left: auto;"));
		assert.ok(html.includes("overflow-wrap: anywhere;"));
		assert.strictEqual(html.includes("max-width: 12ch;"), false);
	});

	test("detail renderer hides agent identity chrome for tool-only turns", () => {
		const html = renderSessionDetailsHtml({
			kind: "detail",
			detail: {
				sessionId: "session-tool-only",
				source: "live",
				promptPreview: "Tool only turn",
				status: "ACTIVE",
				startedAt: "2026-04-04T10:00:00Z",
				lastActivityAt: "2026-04-04T10:01:00Z",
				durationMs: 60_000,
				checkpointCount: 1,
				transcriptAvailable: true,
				turns: [
					{
						id: "turn-agent-tool-only",
						actor: {
							kind: "agent",
							name: "Claude Code",
							initials: "CC",
						},
						timestamp: "2026-04-04T10:01:00Z",
						toolActivities: [
							{
								id: "tool-read",
								kind: "tool_use",
								label: "ReadFile",
								detail: "src/components/sessionDetailsPanel.ts",
							},
						],
					},
				],
			},
		}, { cspSource: "vscode-webview:" });

		assert.strictEqual(html.match(/class="turn turn--agent turn--auxiliary-only"/g)?.length, 1);
		assert.strictEqual(html.includes("turn--auxiliary-only"), true);
		assert.strictEqual(html.includes("turn__content--auxiliary-only"), true);
		assert.strictEqual(html.match(/class="auxiliary auxiliary--tool_use"/g)?.length, 1);
		assert.strictEqual(html.includes("Tool: ReadFile"), true);
		assert.strictEqual(html.includes(">Tool Execution<"), false);
		assert.ok(html.includes("ReadFile"));
		assert.ok(html.includes("src/components/sessionDetailsPanel.ts"));
		assert.strictEqual(html.match(/class="turn__header"/g)?.length ?? 0, 0);
		assert.strictEqual(html.match(/class="turn__author"/g)?.length ?? 0, 0);
		assert.strictEqual(html.match(/class="avatar"/g)?.length ?? 0, 0);
	});

	test("detail renderer collapses thinking and command output blocks", () => {
		const html = renderSessionDetailsHtml({
			kind: "detail",
			detail: {
				sessionId: "session-thinking-output",
				source: "live",
				promptPreview: "Thinking and output",
				status: "ACTIVE",
				startedAt: "2026-04-04T10:00:00Z",
				lastActivityAt: "2026-04-04T10:03:00Z",
				durationMs: 180_000,
				checkpointCount: 1,
				transcriptAvailable: true,
				turns: [
					{
						id: "turn-agent-thinking",
						actor: {
							kind: "agent",
							name: "Codex",
							initials: "CC",
						},
						timestamp: "2026-04-04T10:01:00Z",
						text: "I’ve drafted the redesign direction.",
						toolActivities: [],
						auxiliaryBlocks: [
							{
								id: "thinking-1",
								kind: "thinking",
								label: "Thinking Process",
								detail: "Need to separate primary message text from auxiliary transcript events.",
								display: "text",
							},
							{
								id: "output-1",
								kind: "output",
								label: "Command Output",
								detail: "[success] View rendered at 15:10:42.",
								display: "code",
								tone: "success",
							},
						],
					},
				],
			},
		}, { cspSource: "vscode-webview:" });

		assert.strictEqual(html.match(/class="auxiliary auxiliary--thinking"/g)?.length, 1);
		assert.strictEqual(html.match(/class="auxiliary auxiliary--output"/g)?.length, 1);
		assert.ok(html.includes("Thinking Process"));
		assert.ok(html.includes("Command Output"));
		assert.ok(html.includes("Success"));
		assert.ok(html.includes("View rendered at 15:10:42."));
	});

	test("detail renderer uses day and time for multi-day sessions without full date", () => {
		const html = renderSessionDetailsHtml({
			kind: "detail",
			detail: {
				sessionId: "session-456",
				source: "checkpoint",
				promptPreview: "Long running session",
				status: "IDLE",
				durationMs: 100_000_000,
				checkpointCount: 1,
				transcriptAvailable: true,
				turns: [
					{
						id: "turn-agent",
						actor: {
							kind: "agent",
							name: "Cursor",
							initials: "CC",
						},
						timestamp: "2026-04-05T12:00:00Z",
						text: "Wrapped up the long-running task.",
						toolActivities: [],
					},
				],
			},
		}, { cspSource: "vscode-webview:" });

		assert.ok(html.includes("Apr"));
		assert.strictEqual(html.includes("2026"), false);
	});
});
