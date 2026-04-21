import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_COMMANDS, getProtocolHandlerActions, parseProtocolCommand } from "../src/core/protocol";

test("protocol handler actions include base route and aliases", () => {
	assert.deepEqual(getProtocolHandlerActions("voice-notes-plus"), [
		"voice-notes-plus",
		...PROTOCOL_COMMANDS.map((command) => `voice-notes-plus-${command}`),
	]);
});

test("protocol parser accepts golden-path commands", () => {
	assert.equal(parseProtocolCommand({ command: "start" }, "voice-notes-plus"), "start");
	assert.equal(parseProtocolCommand({ command: "start-new-note" }, "voice-notes-plus"), "start-new-note");
	assert.equal(parseProtocolCommand({ command: "stop" }, "voice-notes-plus"), "stop");
	assert.equal(parseProtocolCommand({ command: "toggle" }, "voice-notes-plus"), "toggle");
	assert.equal(parseProtocolCommand({ command: "download-models" }, "voice-notes-plus"), "download-models");
});

test("protocol parser supports legacy aliases and empty default", () => {
	assert.equal(parseProtocolCommand({}, "voice-notes-plus"), "start");
	assert.equal(parseProtocolCommand({ action: "voice-notes-plus" }, "voice-notes-plus"), "start");
	assert.equal(parseProtocolCommand({ mode: "new_note" }, "voice-notes-plus"), "start-new-note");
	assert.equal(parseProtocolCommand({ intent: "initialize" }, "voice-notes-plus"), "download-models");
});

test("protocol parser rejects unknown commands", () => {
	assert.equal(parseProtocolCommand({ command: "transcribe-file" }, "voice-notes-plus"), null);
});
