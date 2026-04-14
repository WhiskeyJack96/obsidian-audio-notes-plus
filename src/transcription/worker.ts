/**
 * Transcription Web Worker
 *
 * Runs Transformers.js with Moonshine ONNX models and Silero VAD
 * in a background thread. Adapted from the moonshine-web reference
 * implementation.
 */
import { env, AutoModel, Tensor, pipeline } from "@huggingface/transformers";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import {
	MAX_BUFFER_DURATION,
	SAMPLE_RATE,
	SPEECH_THRESHOLD,
	EXIT_THRESHOLD,
	SPEECH_PAD_SAMPLES,
	MAX_NUM_PREV_BUFFERS,
	MIN_SILENCE_DURATION_SAMPLES,
	MIN_SPEECH_DURATION_SAMPLES,
} from "./constants";

// State
let transcriber: AutomaticSpeechRecognitionPipeline;
let sileroVad: Awaited<ReturnType<typeof AutoModel.from_pretrained>>;
let inferenceChain = Promise.resolve();
let messageQueue = Promise.resolve();
let workerReady = false;
let isRecording = false;
let bufferPointer = 0;
let postSpeechSamples = 0;
let prevBuffers: Float32Array[] = [];
let BUFFER = new Float32Array(MAX_BUFFER_DURATION * SAMPLE_RATE);

// Silero VAD state tensors
const sr = new Tensor("int64", [BigInt(SAMPLE_RATE)], []);
let state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);

async function supportsWebGPU(): Promise<boolean> {
	try {
		if (!navigator.gpu) return false;
		await navigator.gpu.requestAdapter();
		return true;
	} catch {
		return false;
	}
}

// Synthetic URL prefix used on mobile when real file:// URLs are not
// fetchable from within this blob-URL worker.
const MOBILE_MODEL_PREFIX = "http://voice-notes-plus.local/models/";

/**
 * On mobile, Obsidian's getResourcePath returns file:// URLs which
 * cannot be fetched from a blob-URL Web Worker.  When the main thread
 * provides pre-read ArrayBuffers (assetBlobs), we create blob URLs
 * inside the worker scope and install a fetch interceptor so that
 * Transformers.js and ONNX Runtime resolve every model/runtime file
 * from memory instead of the network.
 *
 * Returns { modelBaseUrl, wasmPaths } to use for this session.
 */
function installBlobAssets(
	assetBlobs: Record<string, ArrayBuffer>,
): {
	modelBaseUrl: string;
	wasmPaths: Record<string, string>;
	wasmBinary: ArrayBuffer | undefined;
} {
	const blobUrlMap = new Map<string, string>();

	// Build blob URLs for every model file keyed under "models/..."
	for (const [key, buffer] of Object.entries(assetBlobs)) {
		if (!key.startsWith("models/")) continue;
		// Strip the "models/" prefix to get the relative path that
		// Transformers.js will append to localModelPath.
		const relativePath = key.slice("models/".length);
		const mime = key.endsWith(".onnx")
			? "application/octet-stream"
			: "application/json";
		const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
		blobUrlMap.set(MOBILE_MODEL_PREFIX + relativePath, url);
	}

	// Build blob URLs for runtime files.  The bundled onnxruntime-web
	// always requests the .jsep. variants.
	const wasmBuf = assetBlobs["runtime/ort-wasm-simd-threaded.jsep.wasm"];
	const mjsBuf = assetBlobs["runtime/ort-wasm-simd-threaded.jsep.mjs"];
	const mjsBlobUrl = mjsBuf
		? URL.createObjectURL(new Blob([mjsBuf], { type: "application/javascript" }))
		: "";

	// Override fetch so Transformers.js and Emscripten resolve from blob
	// URLs instead of trying to hit the filesystem.
	const originalFetch = self.fetch.bind(self);
	self.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
		const blobUrl = blobUrlMap.get(url);
		if (blobUrl) {
			return originalFetch(blobUrl, init);
		}
		// Return a clean 404 for model-prefixed URLs that are not in the
		// map (e.g. optional config files), so Transformers.js falls back
		// gracefully instead of throwing a network error.
		if (url.startsWith(MOBILE_MODEL_PREFIX)) {
			return Promise.resolve(new Response(null, { status: 404 }));
		}
		return originalFetch(input, init);
	}) as typeof self.fetch;

	return {
		modelBaseUrl: MOBILE_MODEL_PREFIX,
		// mjs blob URL for the Emscripten JS glue (loaded via import()).
		// wasmBinary is passed separately so Emscripten skips fetching .wasm.
		wasmPaths: { mjs: mjsBlobUrl },
		wasmBinary: wasmBuf,
	};
}

function workerLog(message: string): void {
	self.postMessage({ type: "info", message });
}

async function loadModels(
	modelId: string,
	modelBaseUrl: string,
	runtimeBaseUrl: string,
	assetBlobs?: Record<string, ArrayBuffer>
): Promise<void> {
	workerLog("loadModels: configuring env");
	env.allowLocalModels = true;
	env.allowRemoteModels = false;
	env.useBrowserCache = false;
	workerLog("loadModels: basic env set");

	// Disable multi-threaded WASM. The threaded path spawns a sub-Worker
	// that imports 'worker_threads' (a Node.js module), which fails in
	// Obsidian's blob-URL worker context. Single-threaded WASM avoids this.
	workerLog("loadModels: accessing env.backends.onnx.wasm");
	env.backends.onnx.wasm.numThreads = 1;
	workerLog("loadModels: numThreads set");

	if (assetBlobs) {
		workerLog(`loadModels: mobile path, ${Object.keys(assetBlobs).length} asset blobs`);
		for (const [key, buf] of Object.entries(assetBlobs)) {
			workerLog(`  blob: ${key} (${buf.byteLength} bytes)`);
		}
		const resolved = installBlobAssets(assetBlobs);
		env.localModelPath = resolved.modelBaseUrl;
		env.backends.onnx.wasm.wasmPaths = resolved.wasmPaths;
		workerLog(`loadModels: wasmPaths.mjs = ${resolved.wasmPaths.mjs ? "set" : "MISSING"}`);
		workerLog(`loadModels: wasmBinary = ${resolved.wasmBinary ? `${resolved.wasmBinary.byteLength} bytes` : "MISSING"}`);
		if (resolved.wasmBinary) {
			env.backends.onnx.wasm.wasmBinary = resolved.wasmBinary;
		}
	} else {
		workerLog("loadModels: desktop path");
		env.localModelPath = modelBaseUrl;
		env.backends.onnx.wasm.wasmPaths = runtimeBaseUrl;
	}

	workerLog("loadModels: detecting device");
	const device = (await supportsWebGPU()) ? "webgpu" : "wasm";
	workerLog(`loadModels: device = "${device}"`);
	self.postMessage({ type: "status", status: "loading", message: "Loading models..." });

	// Load Silero VAD
	// Verify the mjs blob URL is importable before handing off to ONNX Runtime.
	if (assetBlobs && env.backends.onnx.wasm.wasmPaths) {
		const mjsUrl = (env.backends.onnx.wasm.wasmPaths as Record<string, string>).mjs;
		if (mjsUrl) {
			workerLog(`loadModels: testing mjs blob URL import`);
			try {
				await import(/* webpackIgnore: true */ mjsUrl);
				workerLog("loadModels: mjs blob URL import succeeded");
			} catch (e) {
				workerLog(`loadModels: mjs blob URL import failed: ${e}`);
			}
		}
	}

	workerLog("loadModels: loading Silero VAD");
	sileroVad = await AutoModel.from_pretrained("onnx-community/silero-vad", {
		config: { model_type: "custom" },
		dtype: "fp32",
		local_files_only: true,
	}).catch((error: Error) => {
		self.postMessage({ type: "error", error: `Failed to load VAD model: ${error.message}` });
		throw error;
	});
	workerLog("loadModels: Silero VAD loaded");

	// Load Moonshine transcriber with device-specific quantization
	const dtypeConfig = device === "webgpu"
		? { encoder_model: "fp32", decoder_model_merged: "q4" }
		: { encoder_model: "fp32", decoder_model_merged: "q8" };

	workerLog(`loadModels: loading Moonshine (${modelId})`);
	transcriber = await pipeline("automatic-speech-recognition", modelId, {
		device,
		dtype: dtypeConfig as Record<string, string>,
		local_files_only: true,
	}).catch((error: Error) => {
		self.postMessage({ type: "error", error: `Failed to load transcription model: ${error.message}` });
		throw error;
	});
	workerLog("loadModels: Moonshine loaded");

	// Warm-up inference to compile shaders / verify WASM works
	workerLog("loadModels: running warmup inference");
	await transcriber(new Float32Array(SAMPLE_RATE));
	workerLog("loadModels: warmup complete");

	workerReady = true;
	self.postMessage({ type: "status", status: "ready", message: "Ready" });
}

async function vad(buffer: Float32Array): Promise<boolean> {
	const input = new Tensor("float32", buffer, [1, buffer.length]);
	const result = await (inferenceChain = inferenceChain.then(() =>
		sileroVad({ input, sr, state })
	));
	state = result.stateN;
	const isSpeech = result.output.data[0] as number;

	return (
		isSpeech > SPEECH_THRESHOLD ||
		(isRecording && isSpeech >= EXIT_THRESHOLD)
	);
}

async function transcribe(buffer: Float32Array, data: Record<string, number>): Promise<void> {
	if (!buffer || buffer.length === 0) {
		return;
	}

	const result = await (inferenceChain = inferenceChain.then(() =>
		transcriber(buffer)
	));
	const text = (result as { text: string }).text;
	self.postMessage({ type: "output", message: text, ...data });
}

function reset(offset = 0): void {
	self.postMessage({
		type: "status",
		status: "recording_end",
		message: "Transcribing...",
	});
	BUFFER.fill(0, offset);
	bufferPointer = offset;
	isRecording = false;
	postSpeechSamples = 0;
}

function dispatchForTranscriptionAndReset(overflow?: Float32Array): void {
	const now = Date.now();
	const end = now - ((postSpeechSamples + SPEECH_PAD_SAMPLES) / SAMPLE_RATE) * 1000;
	const start = end - (bufferPointer / SAMPLE_RATE) * 1000;
	const duration = end - start;
	const overflowLength = overflow?.length ?? 0;

	const buffer = BUFFER.slice(0, bufferPointer + SPEECH_PAD_SAMPLES);
	const prevLength = prevBuffers.reduce((acc, b) => acc + b.length, 0);
	const paddedBuffer = new Float32Array(prevLength + buffer.length);
	let offset = 0;
	for (const prev of prevBuffers) {
		paddedBuffer.set(prev, offset);
		offset += prev.length;
	}
	paddedBuffer.set(buffer, offset);

	transcribe(paddedBuffer, { start, end, duration });

	if (overflow) {
		BUFFER.set(overflow, 0);
	}
	reset(overflowLength);
}

function flushBuffer(): void {
	if (!workerReady) return;

	if (bufferPointer > MIN_SPEECH_DURATION_SAMPLES) {
		dispatchForTranscriptionAndReset();
	} else {
		reset();
	}
	prevBuffers = [];
}

async function transcribeFullAudio(audio: Float32Array): Promise<void> {
	workerLog(`transcribeFile: received ${audio.length} samples (${(audio.length / SAMPLE_RATE).toFixed(1)}s)`);

	if (!workerReady) {
		self.postMessage({ type: "error", error: "Models not loaded" });
		self.postMessage({ type: "transcribe-file-complete" });
		return;
	}

	const chunkSamples = MAX_BUFFER_DURATION * SAMPLE_RATE;
	const totalChunks = Math.ceil(audio.length / chunkSamples);
	workerLog(`transcribeFile: splitting into ${totalChunks} chunks (${chunkSamples} samples each)`);

	let chunksProcessed = 0;
	for (let offset = 0; offset < audio.length; offset += chunkSamples) {
		const end = Math.min(offset + chunkSamples, audio.length);
		const chunk = audio.subarray(offset, end);

		// Skip chunks shorter than 0.5 seconds
		if (chunk.length < SAMPLE_RATE * 0.5) {
			workerLog(`transcribeFile: skipping short chunk (${chunk.length} samples)`);
			continue;
		}

		chunksProcessed++;
		workerLog(`transcribeFile: processing chunk ${chunksProcessed}/${totalChunks}`);
		await transcribe(chunk, {
			start: (offset / SAMPLE_RATE) * 1000,
			end: (end / SAMPLE_RATE) * 1000,
			duration: ((end - offset) / SAMPLE_RATE) * 1000,
		});
	}

	workerLog(`transcribeFile: done, processed ${chunksProcessed} chunks`);
	self.postMessage({ type: "transcribe-file-complete" });
}

async function processAudioChunk(buffer: Float32Array): Promise<void> {
	if (!workerReady) return;

	const wasRecording = isRecording;
	const isSpeech = await vad(buffer);

	if (!wasRecording && !isSpeech) {
		if (prevBuffers.length >= MAX_NUM_PREV_BUFFERS) {
			prevBuffers.shift();
		}
		prevBuffers.push(buffer);
		return;
	}

	const remaining = BUFFER.length - bufferPointer;
	if (buffer.length >= remaining) {
		BUFFER.set(buffer.subarray(0, remaining), bufferPointer);
		bufferPointer += remaining;
		const overflow = buffer.subarray(remaining);
		dispatchForTranscriptionAndReset(overflow);
		return;
	} else {
		BUFFER.set(buffer, bufferPointer);
		bufferPointer += buffer.length;
	}

	if (isSpeech) {
		if (!isRecording) {
			self.postMessage({
				type: "status",
				status: "recording_start",
				message: "Listening...",
			});
		}
		isRecording = true;
		postSpeechSamples = 0;
		return;
	}

	postSpeechSamples += buffer.length;

	if (postSpeechSamples < MIN_SILENCE_DURATION_SAMPLES) {
		return;
	}

	if (bufferPointer < MIN_SPEECH_DURATION_SAMPLES) {
		reset();
		return;
	}

	dispatchForTranscriptionAndReset();
}

async function handleMessage(data: {
	type?: string;
	modelId?: string;
	modelBaseUrl?: string;
	runtimeBaseUrl?: string;
	assetBlobs?: Record<string, ArrayBuffer>;
	buffer?: Float32Array;
	audio?: Float32Array;
}): Promise<void> {
	if (data.type === "init") {
		await loadModels(
			data.modelId!,
			data.modelBaseUrl!,
			data.runtimeBaseUrl!,
			data.assetBlobs
		);
		return;
	}

	if (data.type === "flush") {
		flushBuffer();
		await inferenceChain;
		self.postMessage({ type: "flush-complete" });
		return;
	}

	if (data.type === "transcribe-file") {
		await transcribeFullAudio(data.audio!);
		return;
	}

	if (data.buffer) {
		await processAudioChunk(data.buffer);
	}
}

function postWorkerError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	self.postMessage({ type: "error", error: message });
}

// Message handler
self.onmessage = (event: MessageEvent) => {
	messageQueue = messageQueue
		.then(() => handleMessage(event.data as { type?: string; modelId?: string; buffer?: Float32Array }))
		.catch((error) => {
			postWorkerError(error);
		});
};
