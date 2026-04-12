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
let isRecording = false;
let bufferPointer = 0;
let postSpeechSamples = 0;
let prevBuffers: Float32Array[] = [];
let BUFFER: Float32Array;

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

async function loadModels(modelId: string): Promise<void> {
	// Don't override wasmPaths - let Transformers.js use its CDN default.
	// Electron's blob worker context blocks file:// dynamic imports, so local
	// .mjs bootstrappers can't be loaded. The CDN-fetched files get cached
	// by the browser Cache API after first download.
	env.allowLocalModels = false;

	const device = (await supportsWebGPU()) ? "webgpu" : "wasm";
	self.postMessage({ type: "info", message: `Using device: "${device}"` });
	self.postMessage({ type: "status", status: "loading", message: "Loading models..." });

	// Load Silero VAD
	sileroVad = await AutoModel.from_pretrained("onnx-community/silero-vad", {
		config: { model_type: "custom" },
		dtype: "fp32",
	}).catch((error: Error) => {
		self.postMessage({ type: "error", error: `Failed to load VAD model: ${error.message}` });
		throw error;
	});

	// Load Moonshine transcriber with device-specific quantization
	const dtypeConfig = device === "webgpu"
		? { encoder_model: "fp32", decoder_model_merged: "q4" }
		: { encoder_model: "fp32", decoder_model_merged: "q8" };

	transcriber = await pipeline("automatic-speech-recognition", modelId, {
		device,
		dtype: dtypeConfig as Record<string, string>,
	}).catch((error: Error) => {
		self.postMessage({ type: "error", error: `Failed to load transcription model: ${error.message}` });
		throw error;
	});

	// Warm-up inference to compile shaders
	await transcriber(new Float32Array(SAMPLE_RATE));

	// Initialize global buffer
	BUFFER = new Float32Array(MAX_BUFFER_DURATION * SAMPLE_RATE);

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
	if (bufferPointer > MIN_SPEECH_DURATION_SAMPLES) {
		dispatchForTranscriptionAndReset();
	} else {
		reset();
	}
	prevBuffers = [];
}

async function processAudioChunk(buffer: Float32Array): Promise<void> {
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

// Message handler
self.onmessage = async (event: MessageEvent) => {
	const data = event.data;

	if (data.type === "init") {
		await loadModels(data.modelId);
		return;
	}

	if (data.type === "flush") {
		flushBuffer();
		return;
	}

	if (data.buffer) {
		await processAudioChunk(data.buffer);
	}
};
