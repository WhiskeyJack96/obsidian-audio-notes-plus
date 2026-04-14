import { Notice } from "obsidian";
import type VoiceNotesPlugin from "../main";
import type { LocalAssetConfig, WorkerOutMessage, RecordingCallbacks, WorkerStatus } from "../types";
import { MODEL_IDS } from "../types";

// Injected at build time by esbuild — the worker bundle as Base64.
declare const WORKER_BASE64: string;

export class TranscriptionManager {
	private worker: Worker | null = null;
	private callbacks: RecordingCallbacks | null = null;
	private flushPromise: Promise<void> | null = null;
	private resolveFlush: (() => void) | null = null;
	private flushTimeoutId: number | null = null;
	private loadedModelId: string | null = null;
	private fileTranscribeChunks: string[] | null = null;
	private resolveFileTranscribe: ((transcript: string) => void) | null = null;
	private fileTranscribeTimeoutId: number | null = null;
	private resolveInit: (() => void) | null = null;
	private rejectInit: ((reason: Error) => void) | null = null;
	isReady = false;

	constructor(private plugin: VoiceNotesPlugin) {}

	async initialize(assetConfig: LocalAssetConfig): Promise<void> {
		const modelId = MODEL_IDS[this.plugin.settings.modelSize];
		if (this.worker && this.loadedModelId === modelId) {
			return;
		}
		if (this.worker) {
			this.destroy();
		}

		// Decode the inlined worker from Base64 and create a Blob URL.
		// This avoids needing a separate worker.js file on disk, which
		// is required because BRAT and the community plugin store only
		// distribute main.js, manifest.json, and styles.css.
		const workerCode = atob(WORKER_BASE64);
		const blob = new Blob([workerCode], { type: "application/javascript" });
		const blobUrl = URL.createObjectURL(blob);
		this.worker = new Worker(blobUrl, { type: "module" });
		URL.revokeObjectURL(blobUrl);

		this.worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
			this.handleMessage(event.data);
		};
		this.worker.onerror = (event: ErrorEvent) => {
			this.rejectInit?.(new Error(event.message));
			this.resolveInit = null;
			this.rejectInit = null;
			this.callbacks?.onError(event.message);
			new Notice(`Voice Notes Plus: Worker error - ${event.message}`);
		};
		this.loadedModelId = modelId;

		const initMsg: Record<string, unknown> = {
			type: "init",
			modelId,
			modelBaseUrl: assetConfig.modelBaseUrl,
			runtimeBaseUrl: assetConfig.runtimeBaseUrl,
		};

		// On mobile, transfer the pre-read ArrayBuffers to the worker so
		// it can create fetchable blob URLs in its own scope.
		const transfer: ArrayBuffer[] = [];
		if (assetConfig.assetBlobs) {
			initMsg.assetBlobs = assetConfig.assetBlobs;
			for (const buf of Object.values(assetConfig.assetBlobs)) {
				transfer.push(buf);
			}
		}

		return new Promise<void>((resolve, reject) => {
			this.resolveInit = resolve;
			this.rejectInit = reject;
			this.worker!.postMessage(initMsg, transfer);
		});
	}

	private handleMessage(data: WorkerOutMessage): void {
		switch (data.type) {
			case "status":
				if (data.status === "ready") {
					this.isReady = true;
					this.resolveInit?.();
					this.resolveInit = null;
					this.rejectInit = null;
				}
				this.callbacks?.onStatusChange(data.status as WorkerStatus, data.message);
				break;
			case "output":
				if (this.fileTranscribeChunks !== null) {
					this.fileTranscribeChunks.push(data.message.trim());
				} else {
					this.callbacks?.onTranscription(data.message);
				}
				break;
			case "flush-complete":
				this.completeFlush();
				break;
			case "transcribe-file-complete":
				this.completeFileTranscribe();
				break;
			case "error":
				if (this.rejectInit) {
					this.rejectInit(new Error(data.error));
					this.resolveInit = null;
					this.rejectInit = null;
				}
				this.completeFlush();
				this.completeFileTranscribe();
				this.callbacks?.onError(data.error);
				new Notice(`Voice Notes Plus: ${data.error}`);
				break;
			case "info":
				console.log(`[worker] ${data.message}`);
				new Notice(`[worker] ${data.message}`, 0);
				break;
			case "download-progress":
				// Could update a progress indicator here
				break;
		}
	}

	setCallbacks(callbacks: RecordingCallbacks): void {
		this.callbacks = callbacks;
	}

	clearCallbacks(): void {
		this.callbacks = null;
	}

	sendAudioChunk(buffer: Float32Array): void {
		if (!this.worker) return;
		// Transfer the buffer for zero-copy performance
		this.worker.postMessage({ buffer }, [buffer.buffer]);
	}

	flush(): Promise<void> {
		if (!this.worker) return Promise.resolve();
		if (this.flushPromise) return this.flushPromise;

		this.flushPromise = new Promise((resolve) => {
			this.resolveFlush = () => {
				this.clearFlushTimeout();
				this.flushPromise = null;
				this.resolveFlush = null;
				resolve();
			};
			this.flushTimeoutId = window.setTimeout(() => {
				this.completeFlush();
			}, 10000);
		});

		this.worker.postMessage({ type: "flush" });
		return this.flushPromise;
	}

	transcribeFile(audio: Float32Array): Promise<string> {
		if (!this.worker || !this.isReady) {
			return Promise.reject(new Error("Worker not initialized"));
		}

		console.log(`[manager] transcribeFile: sending ${audio.length} samples`);
		new Notice(`[manager] sending ${audio.length} samples (${(audio.length / 16000).toFixed(1)}s)`, 0);
		this.fileTranscribeChunks = [];

		return new Promise<string>((resolve) => {
			this.resolveFileTranscribe = resolve;

			this.fileTranscribeTimeoutId = window.setTimeout(() => {
				console.log("[manager] transcribeFile: timed out after 120s");
				new Notice("[manager] transcribeFile timed out", 0);
				this.completeFileTranscribe();
			}, 120_000);

			this.worker!.postMessage(
				{ type: "transcribe-file", audio },
				[audio.buffer]
			);
		});
	}

	destroy(): void {
		this.rejectInit?.(new Error("Worker destroyed"));
		this.resolveInit = null;
		this.rejectInit = null;
		this.completeFlush();
		this.completeFileTranscribe();
		this.worker?.terminate();
		this.worker = null;
		this.isReady = false;
		this.callbacks = null;
		this.loadedModelId = null;
	}

	private completeFlush(): void {
		this.resolveFlush?.();
	}

	private completeFileTranscribe(): void {
		if (!this.resolveFileTranscribe) return;

		if (this.fileTranscribeTimeoutId !== null) {
			window.clearTimeout(this.fileTranscribeTimeoutId);
			this.fileTranscribeTimeoutId = null;
		}

		const chunks = this.fileTranscribeChunks ?? [];
		const transcript = chunks.join(" ").replace(/\s+/g, " ").trim();
		console.log(`[manager] completeFileTranscribe: ${chunks.length} chunks, ${transcript.length} chars`);
		new Notice(`[manager] complete: ${chunks.length} chunks, ${transcript.length} chars`, 0);
		this.resolveFileTranscribe(transcript);
		this.fileTranscribeChunks = null;
		this.resolveFileTranscribe = null;
	}

	private clearFlushTimeout(): void {
		if (this.flushTimeoutId !== null) {
			window.clearTimeout(this.flushTimeoutId);
			this.flushTimeoutId = null;
		}
	}
}
