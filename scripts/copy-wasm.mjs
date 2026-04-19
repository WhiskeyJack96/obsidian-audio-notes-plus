/**
 * Copies required ONNX Runtime files from node_modules
 * to the project root (which becomes the plugin directory).
 *
 * Includes both .wasm binaries and .mjs bootstrappers.
 * The ONNX Runtime dynamically imports the .mjs files at runtime
 * to initialize its WASM backend.
 */
import { copyFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let ortDir;
try {
	const ortMain = require.resolve("onnxruntime-web");
	ortDir = dirname(ortMain);
} catch {
	// onnxruntime-web is a transitive dep of @huggingface/transformers
	// Try to find it in the transformers package
	try {
		const hfDir = dirname(require.resolve("@huggingface/transformers"));
		ortDir = join(hfDir, "..", "onnxruntime-web", "dist");
	} catch {
		console.warn("Could not find onnxruntime-web. WASM files not copied.");
		console.warn("Run `npm install` first, then `npm run copy-wasm`.");
		process.exit(0);
	}
}

const files = [
	// WASM binaries
	"ort-wasm-simd-threaded.wasm",
	"ort-wasm-simd-threaded.asyncify.wasm",
	// JS bootstrappers (dynamically imported by ONNX Runtime at init)
	"ort-wasm-simd-threaded.mjs",
	"ort-wasm-simd-threaded.asyncify.mjs",
];

let copied = 0;
for (const file of files) {
	const src = join(ortDir, file);
	if (existsSync(src)) {
		copyFileSync(src, join(".", file));
		console.log(`Copied ${file}`);
		copied++;
	} else {
		// Try one directory up (different onnxruntime-web layouts)
		const altSrc = join(ortDir, "..", file);
		if (existsSync(altSrc)) {
			copyFileSync(altSrc, join(".", file));
			console.log(`Copied ${file} (from parent dir)`);
			copied++;
		} else {
			console.warn(`Not found: ${file}`);
		}
	}
}

console.log(`\nCopied ${copied}/${files.length} WASM files.`);
