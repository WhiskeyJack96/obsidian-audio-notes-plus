import test from "node:test";
import assert from "node:assert/strict";
import { formatInsertion } from "../src/core/insertion";

test("formatInsertion adds spacing around inserted blocks", () => {
	assert.deepEqual(formatInsertion("hello", 5, "BLOCK"), {
		text: "\n\nBLOCK",
		cursorOffset: 12,
	});

	assert.deepEqual(formatInsertion("hello\n", 6, "BLOCK"), {
		text: "\nBLOCK",
		cursorOffset: 12,
	});

	assert.deepEqual(formatInsertion("hello\n\nworld", 7, "BLOCK"), {
		text: "BLOCK\n\n",
		cursorOffset: 12,
	});
});
