import * as assert from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import {
	countTranscriptToolUses,
	extractTranscriptFirstTimestamp,
	extractTranscriptLatestTimestamp,
	extractTranscriptPrompt,
	parseTranscript,
} from "../../checkpoints";

const transcriptFixturePath = path.resolve(
	__dirname,
	"../../../src/test/checkpoints/fixtures/transcript/162eec7c33-0-sample.jsonl",
);

suite("Checkpoint Transcript Parsing", () => {
	test("transcript helpers parse real CLI JSONL message fields", () => {
		const transcript = readFileSync(transcriptFixturePath, "utf8");
		const events = parseTranscript(transcript);

		assert.strictEqual(events.length, 4);
		assert.strictEqual(events[0].eventType, "user");
		assert.strictEqual(events[1].eventType, "assistant");
		assert.strictEqual(events[2].eventType, "assistant");
		assert.strictEqual(events[3].eventType, "user");

		const firstUserEvent = events[0].raw as { message?: { content?: string } };
		assert.strictEqual(
			firstUserEvent.message?.content,
			"Can you inspect the failing CI run and tell me why the fallback agent is erroring?",
		);

		assert.strictEqual(
			extractTranscriptPrompt(transcript),
			"Can you inspect the failing CI run and tell me why the fallback agent is erroring?",
		);
		assert.strictEqual(extractTranscriptFirstTimestamp(transcript), "2026-03-04T14:02:38.338Z");
		assert.strictEqual(extractTranscriptLatestTimestamp(transcript), "2026-03-04T14:15:26.911Z");
		assert.strictEqual(countTranscriptToolUses(transcript), 1);
	});
});
