/** Messages sent FROM the worker TO the main thread */
export type WorkerOutMessage =
	| { type: "status"; status: WorkerStatus; message: string }
	| { type: "output"; message: string; start: number; end: number; duration: number }
	| { type: "flush-complete" }
	| { type: "error"; error: string }
	| { type: "info"; message: string }
	| { type: "transcribe-file-complete" };

/** Messages sent FROM the main thread TO the worker */
export type WorkerInMessage =
	| {
		type: "init";
		modelId: string;
		modelBaseUrl: string;
		runtimeBaseUrl: string;
		assetBlobs?: Record<string, ArrayBuffer>;
	}
	| { type: "flush" }
	| { type: "transcribe-file"; audio: Float32Array }
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

	/** Obsidian command ID to execute after transcription completes */
	postTranscriptionCommandId: string;
	/** Obsidian command ID to create/open a target note before recording */
	newNoteCommandId: string;

	/** Keep models loaded in memory between recordings */
	keepModelsLoaded: boolean;

	/**
	 * Filename template for saved recordings.
	 * Supported tokens: {{date}}, {{noteName}}
	 */
	recordingFilenameTemplate: string;
}

export interface LocalAssetConfig {
	modelBaseUrl: string;
	runtimeBaseUrl: string;
	/**
	 * On mobile, file:// URLs are not fetchable from a Web Worker.
	 * When present, this map provides all model and runtime files as
	 * ArrayBuffers keyed by relative path so the worker can create
	 * blob URLs in its own scope.
	 */
	assetBlobs?: Record<string, ArrayBuffer>;
}

export const DEFAULT_SETTINGS: VoiceNotesSettings = {
	modelSize: "base",
	postTranscriptionCommandId: "",
	newNoteCommandId: "",
	keepModelsLoaded: true,
	recordingFilenameTemplate: "recording-{{date}}",
};

export interface CommandManagerLike {
	executeCommandById: (id: string) => boolean;
}

export const MODEL_IDS: Record<VoiceNotesSettings["modelSize"], string> = {
	base: "onnx-community/moonshine-base-ONNX",
	tiny: "onnx-community/moonshine-tiny-ONNX",
};
