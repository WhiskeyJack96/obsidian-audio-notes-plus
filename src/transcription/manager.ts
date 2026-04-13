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

		this.worker.postMessage(initMsg, transfer);
	}

	private handleMessage(data: WorkerOutMessage): void {
		switch (data.type) {
			case "status":
				if (data.status === "ready") {
					this.isReady = true;
				}
				this.callbacks?.onStatusChange(data.status as WorkerStatus, data.message);
				break;
			case "output":
				this.callbacks?.onTranscription(data.message);
				break;
			case "flush-complete":
				this.completeFlush();
				break;
			case "error":
				this.completeFlush();
				this.callbacks?.onError(data.error);
				new Notice(`Voice Notes Plus: ${data.error}`);
				break;
			case "info":
				// Informational messages (device type, etc.)
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

	destroy(): void {
		this.completeFlush();
		this.worker?.terminate();
		this.worker = null;
		this.isReady = false;
		this.callbacks = null;
		this.loadedModelId = null;
	}

	private completeFlush(): void {
		this.resolveFlush?.();
	}

	private clearFlushTimeout(): void {
		if (this.flushTimeoutId !== null) {
			window.clearTimeout(this.flushTimeoutId);
			this.flushTimeoutId = null;
		}
	}
}
