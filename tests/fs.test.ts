import test from "node:test";
import assert from "node:assert/strict";
import { ensureDir } from "../src/core/fs";

test("ensureDir no-ops when path already exists", async () => {
	let mkdirCalls = 0;
	await ensureDir({
		async exists(path) {
			assert.equal(path, "cache/models");
			return true;
		},
		async mkdir() {
			mkdirCalls += 1;
		},
	}, "cache/models");

	assert.equal(mkdirCalls, 0);
});

test("ensureDir creates the directory when missing", async () => {
	let mkdirPath: string | null = null;
	await ensureDir({
		async exists() {
			return false;
		},
		async mkdir(path) {
			mkdirPath = path;
		},
	}, "cache/models");

	assert.equal(mkdirPath, "cache/models");
});

test("ensureDir tolerates mkdir races when the path appears after failure", async () => {
	let existsCalls = 0;
	await ensureDir({
		async exists() {
			existsCalls += 1;
			return existsCalls > 1;
		},
		async mkdir() {
			throw new Error("EEXIST");
		},
	}, "cache/models");
});

test("ensureDir rethrows mkdir failures when the path still does not exist", async () => {
	await assert.rejects(
		ensureDir({
			async exists() {
				return false;
			},
			async mkdir() {
				throw new Error("permission denied");
			},
		}, "cache/models"),
		/permission denied/
	);
});
