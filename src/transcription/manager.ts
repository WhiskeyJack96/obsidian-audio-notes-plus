import { Notice } from "obsidian";
import type VoiceNotesPlugin from "../main";
import type { WorkerOutMessage, RecordingCallbacks, WorkerStatus } from "../types";
import { MODEL_IDS } from "../types";

// Injected at build time by esbuild — the worker bundle as Base64.
declare const WORKER_BASE64: string;

export class TranscriptionManager {
	private worker: Worker | null = null;
	private callbacks: RecordingCallbacks | null = null;
	isReady = false;

	constructor(private plugin: VoiceNotesPlugin) {}

	async initialize(): Promise<void> {
		if (this.worker) return;

		const modelId = MODEL_IDS[this.plugin.settings.modelSize];

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

		// Send init message with model ID.
		// WASM paths are left at the Transformers.js CDN default since
		// Electron's blob worker context can't load local file:// URLs.
		this.worker.postMessage({ type: "init", modelId });
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
			case "error":
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

	flush(): void {
		this.worker?.postMessage({ type: "flush" });
	}

	destroy(): void {
		this.worker?.terminate();
		this.worker = null;
		this.isReady = false;
		this.callbacks = null;
	}
}
