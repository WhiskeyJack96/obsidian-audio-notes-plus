import test from "node:test";
import assert from "node:assert/strict";
import {
	formatDateToken,
	formatDuration,
	hasTranscriptionOutputAfterEmbed,
	renderTemplate,
	renderTranscriptOutput,
	sanitizeFileNameSegment,
} from "../src/core/templates";

test("renderTemplate replaces supported tokens and preserves unknown tokens", () => {
	const output = renderTemplate(
		"{{audio}} {{transcript}} {{duration}} {{noteName}} {{date:YYYY}} {{unknown}}",
		{
			audio: "![[clip.webm]]",
			transcript: "hello world",
			duration: "0:12",
			noteName: "Daily Note",
			date: new Date("2026-04-20T12:34:56.000Z"),
		},
		(date, format) => `${format}:${date.getUTCFullYear()}`
	);

	assert.equal(output, "![[clip.webm]] hello world 0:12 Daily Note YYYY:2026 {{unknown}}");
});

test("formatDateToken falls back to ISO-style timestamp when no formatter exists", () => {
	assert.equal(
		formatDateToken(new Date("2026-04-20T12:34:56.789Z")),
		"2026-04-20-12-34-56-789"
	);
});

test("renderTranscriptOutput returns default golden-path block", () => {
	const output = renderTranscriptOutput({
		template: "{{audio}}\n> [!transcript]\n> {{transcript}}",
		audioFilePath: "Audio/clip.webm",
		includeAudioEmbed: true,
		transcript: "  hello there  ",
		durationSeconds: 12.4,
		noteName: "My Note",
		date: new Date("2026-04-20T12:34:56.000Z"),
	});

	assert.equal(output, "![[Audio/clip.webm]]\n> [!transcript]\n> hello there");
});

test("renderTranscriptOutput supports custom transcript templates", () => {
	const output = renderTranscriptOutput({
		template: "---\nduration: {{duration}}\nsource: {{audio}}\n---\n{{transcript}}",
		audioFilePath: "Audio/clip.webm",
		includeAudioEmbed: true,
		transcript: "hello there",
		durationSeconds: 3723,
		noteName: "My Note",
		date: new Date("2026-04-20T12:34:56.000Z"),
	});

	assert.equal(
		output,
		"---\nduration: 1:02:03\nsource: ![[Audio/clip.webm]]\n---\nhello there"
	);
});

test("renderTranscriptOutput returns only the audio embed when transcript is empty", () => {
	const output = renderTranscriptOutput({
		template: "{{audio}}\n> [!transcript]\n> {{transcript}}",
		audioFilePath: "Audio/clip.webm",
		includeAudioEmbed: true,
		transcript: "   ",
		durationSeconds: 0,
		noteName: "My Note",
		date: new Date("2026-04-20T12:34:56.000Z"),
	});

	assert.equal(output, "![[Audio/clip.webm]]");
});

test("hasTranscriptionOutputAfterEmbed matches both default and custom templates", () => {
	assert.equal(
		hasTranscriptionOutputAfterEmbed("\n> [!transcript]\n> hello there", "{{audio}}\n> [!transcript]\n> {{transcript}}"),
		true
	);
	assert.equal(
		hasTranscriptionOutputAfterEmbed("\n---\nkind: transcript\nhello there\n---", "---\nkind: transcript\n{{transcript}}\n---"),
		true
	);
	assert.equal(
		hasTranscriptionOutputAfterEmbed("\nhello there", "{{transcript}}"),
		false
	);
});

test("formatDuration and sanitizeFileNameSegment cover common golden-path values", () => {
	assert.equal(formatDuration(9.6), "0:10");
	assert.equal(formatDuration(3723), "1:02:03");
	assert.equal(sanitizeFileNameSegment("daily: note/clip?"), "daily- note-clip-");
});
