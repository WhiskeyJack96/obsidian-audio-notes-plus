import test from "node:test";
import assert from "node:assert/strict";
import { extractAudioLinkFromSelection, findAudioEmbedAtCursor } from "../src/core/markdown";

test("extractAudioLinkFromSelection unwraps wiki links and embeds", () => {
	assert.equal(extractAudioLinkFromSelection("![[Audio/clip.webm]]"), "Audio/clip.webm");
	assert.equal(extractAudioLinkFromSelection("[[Audio/clip.webm|Clip]]"), "Audio/clip.webm");
	assert.equal(extractAudioLinkFromSelection("Audio/clip.webm"), "Audio/clip.webm");
	assert.equal(extractAudioLinkFromSelection("   "), null);
});

test("findAudioEmbedAtCursor locates the embed under the cursor", () => {
	const line = "Before ![[Audio/clip.webm|Clip]] after";
	assert.deepEqual(findAudioEmbedAtCursor(line, 10), {
		linkPath: "Audio/clip.webm",
		endCh: 32,
	});
	assert.deepEqual(findAudioEmbedAtCursor(line, 31), {
		linkPath: "Audio/clip.webm",
		endCh: 32,
	});
	assert.equal(findAudioEmbedAtCursor(line, 2), null);
});
