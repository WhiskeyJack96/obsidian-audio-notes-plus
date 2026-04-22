import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_COMMANDS, getProtocolHandlerActions, parseProtocol } from "../src/core/protocol";

test("protocol handler actions include base route and aliases", () => {
	assert.deepEqual(getProtocolHandlerActions("voice-notes-plus"), [
		"voice-notes-plus",
		...PROTOCOL_COMMANDS.map((command) => `voice-notes-plus-${command}`),
	]);
});

test("protocol parser accepts golden-path commands", () => {
	assert.equal(parseProtocol({ command: "start" }, "voice-notes-plus")?.command, "start");
	assert.equal(parseProtocol({ command: "start-new-note" }, "voice-notes-plus")?.command, "start-new-note");
	assert.equal(parseProtocol({ command: "stop" }, "voice-notes-plus")?.command, "stop");
	assert.equal(parseProtocol({ command: "toggle" }, "voice-notes-plus")?.command, "toggle");
	assert.equal(parseProtocol({ command: "download-models" }, "voice-notes-plus")?.command, "download-models");
});

test("protocol parser supports legacy aliases and empty default", () => {
	assert.equal(parseProtocol({}, "voice-notes-plus")?.command, "start");
	assert.equal(parseProtocol({ action: "voice-notes-plus" }, "voice-notes-plus")?.command, "start");
	assert.equal(parseProtocol({ mode: "new_note" }, "voice-notes-plus")?.command, "start-new-note");
	assert.equal(parseProtocol({ intent: "initialize" }, "voice-notes-plus")?.command, "download-models");
});

test("protocol parser rejects unknown commands", () => {
	assert.equal(parseProtocol({ command: "transcribe-file" }, "voice-notes-plus"), null);
});

test("protocol parser extracts file and template params", () => {
	const result = parseProtocol({ command: "start", file: "notes/meeting.md", template: "{{transcript}}" }, "voice-notes-plus");
	assert.equal(result?.command, "start");
	assert.equal(result?.file, "notes/meeting.md");
	assert.equal(result?.template, "{{transcript}}");
});

test("protocol parser omits empty file and template", () => {
	const result = parseProtocol({ command: "start", file: "", template: "" }, "voice-notes-plus");
	assert.equal(result?.command, "start");
	assert.equal(result?.file, undefined);
	assert.equal(result?.template, undefined);
});
