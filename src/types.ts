/** Messages sent FROM the worker TO the main thread */
export type WorkerOutMessage =
	| { type: "status"; status: WorkerStatus; message: string }
	| { type: "output"; message: string; start: number; end: number; duration: number }
	| { type: "error"; error: string }
	| { type: "download-progress"; file: string; progress: number; loaded: number; total: number }
	| { type: "info"; message: string };

/** Messages sent FROM the main thread TO the worker */
export type WorkerInMessage =
	| { type: "init"; modelId: string }
	| { type: "flush" }
	| { buffer: Float32Array };

export type WorkerStatus = "loading" | "ready" | "recording_start" | "recording_end";

export interface RecordingCallbacks {
	onTranscription: (text: string) => void;
	onStatusChange: (status: WorkerStatus, message: string) => void;
	onError: (error: string) => void;
}

export interface VoiceNotesSettings {
	/** Which Moonshine model to use */
	modelSize: "tiny" | "base";
	/** Prefer WebGPU over WASM when available */
	preferWebGPU: boolean;

	/** Vault folder for saved audio files */
	audioFolder: string;

	/** VAD speech detection threshold (0-1) */
	speechThreshold: number;
	/** Minimum silence duration (ms) before ending a speech segment */
	silenceDuration: number;

	/** Obsidian command ID to execute after transcription completes */
	postTranscriptionCommandId: string;

	/** Keep models loaded in memory between recordings */
	keepModelsLoaded: boolean;
}

export const DEFAULT_SETTINGS: VoiceNotesSettings = {
	modelSize: "base",
	preferWebGPU: true,
	audioFolder: "Voice Notes",
	speechThreshold: 0.3,
	silenceDuration: 400,
	postTranscriptionCommandId: "",
	keepModelsLoaded: true,
};

export const MODEL_IDS: Record<VoiceNotesSettings["modelSize"], string> = {
	base: "onnx-community/moonshine-base-ONNX",
	tiny: "onnx-community/moonshine-tiny-ONNX",
};
