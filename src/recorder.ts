import { SAMPLE_RATE } from "./transcription/constants";

const PREFERRED_MIME_TYPES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/ogg;codecs=opus",
	"audio/mp4",
] as const;

function pickMimeType(): { mimeType: string; extension: string } {
	for (const mime of PREFERRED_MIME_TYPES) {
		if (MediaRecorder.isTypeSupported(mime)) {
			const ext = mime.startsWith("audio/mp4") ? "m4a"
				: mime.startsWith("audio/ogg") ? "ogg"
				: "webm";
			return { mimeType: mime, extension: ext };
		}
	}
	return { mimeType: "", extension: "webm" };
}

/**
 * Inline AudioWorkletProcessor source code.
 * This is tiny and has zero dependencies, so we inline it
 * as a string and load via Blob URL to avoid a third output file.
 */
const PROCESSOR_CODE = `
const MIN_CHUNK_SIZE = 512;
let globalPointer = 0;
let globalBuffer = new Float32Array(MIN_CHUNK_SIZE);

class VADProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const buffer = inputs[0][0];
    if (!buffer) return true;

    if (buffer.length > MIN_CHUNK_SIZE) {
      this.port.postMessage({ buffer: new Float32Array(buffer) });
    } else {
      const remaining = MIN_CHUNK_SIZE - globalPointer;
      if (buffer.length >= remaining) {
        globalBuffer.set(buffer.subarray(0, remaining), globalPointer);
        this.port.postMessage({ buffer: globalBuffer });
        globalBuffer = new Float32Array(MIN_CHUNK_SIZE);
        globalBuffer.set(buffer.subarray(remaining), 0);
        globalPointer = buffer.length - remaining;
      } else {
        globalBuffer.set(buffer, globalPointer);
        globalPointer += buffer.length;
      }
    }
    return true;
  }
}
registerProcessor("vad-processor", VADProcessor);
`;

export class AudioRecorder {
	private audioContext: AudioContext | null = null;
	private stream: MediaStream | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private workletNode: AudioWorkletNode | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private recordedChunks: Blob[] = [];
	private chosenMime: { mimeType: string; extension: string } | null = null;

	get fileExtension(): string {
		return this.chosenMime?.extension ?? "webm";
	}

	/**
	 * Start dual-stream recording:
	 * 1. AudioWorklet -> onAudioChunk callbacks (PCM for transcription)
	 * 2. MediaRecorder -> internal buffer (compressed .webm for saving)
	 */
	async start(onAudioChunk: (buffer: Float32Array) => void): Promise<void> {
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				autoGainControl: true,
				noiseSuppression: true,
				sampleRate: SAMPLE_RATE,
			},
		});

		// Set up AudioContext + WorkletNode for PCM streaming
		this.audioContext = new AudioContext({
			sampleRate: SAMPLE_RATE,
		});

		const blob = new Blob([PROCESSOR_CODE], { type: "application/javascript" });
		const processorUrl = URL.createObjectURL(blob);
		await this.audioContext.audioWorklet.addModule(processorUrl);
		URL.revokeObjectURL(processorUrl);

		this.source = this.audioContext.createMediaStreamSource(this.stream);
		this.workletNode = new AudioWorkletNode(this.audioContext, "vad-processor", {
			numberOfInputs: 1,
			numberOfOutputs: 0,
			channelCount: 1,
			channelCountMode: "explicit",
			channelInterpretation: "discrete",
		});

		this.workletNode.port.onmessage = (event: MessageEvent) => {
			onAudioChunk(event.data.buffer as Float32Array);
		};

		this.source.connect(this.workletNode);

		// Set up MediaRecorder for audio file saving
		this.recordedChunks = [];
		this.chosenMime = pickMimeType();
		const recorderOptions: MediaRecorderOptions = {};
		if (this.chosenMime.mimeType) {
			recorderOptions.mimeType = this.chosenMime.mimeType;
		}
		this.mediaRecorder = new MediaRecorder(this.stream, recorderOptions);
		this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
			if (event.data.size > 0) {
				this.recordedChunks.push(event.data);
			}
		};
		this.mediaRecorder.start(1000); // Collect data every second
	}

	/**
	 * Stop recording and return the audio blob for saving.
	 */
	async stop(): Promise<Blob> {
		return new Promise((resolve) => {
			// Stop PCM delivery immediately so no chunks arrive after the main thread flushes.
			this.workletNode?.port && (this.workletNode.port.onmessage = null);
			this.workletNode?.disconnect();
			this.source?.disconnect();

			const blobType = this.chosenMime?.mimeType || "audio/webm";
			if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
				this.mediaRecorder.onstop = () => {
					const blob = new Blob(this.recordedChunks, { type: blobType });
					this.cleanup();
					resolve(blob);
				};
				this.mediaRecorder.stop();
			} else {
				const blob = new Blob(this.recordedChunks, { type: blobType });
				this.cleanup();
				resolve(blob);
			}
		});
	}

	private cleanup(): void {
		this.workletNode?.disconnect();
		this.source?.disconnect();
		this.stream?.getTracks().forEach((t) => t.stop());
		if (this.audioContext?.state !== "closed") {
			this.audioContext?.close();
		}
		this.workletNode = null;
		this.source = null;
		this.stream = null;
		this.audioContext = null;
		this.mediaRecorder = null;
	}
}
