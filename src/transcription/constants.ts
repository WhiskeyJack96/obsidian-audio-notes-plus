/**
 * Audio sample rate in Hz.
 * Must match both Moonshine and Silero VAD expectations.
 */
export const SAMPLE_RATE = 16000;
export const SAMPLE_RATE_MS = SAMPLE_RATE / 1000;

/** Probabilities ABOVE this value are considered speech */
export const SPEECH_THRESHOLD = 0.3;

/**
 * If currently in SPEECH state, probabilities below this
 * value transition to NON-SPEECH.
 */
export const EXIT_THRESHOLD = 0.1;

/** Minimum silence (ms) before ending a speech segment */
export const MIN_SILENCE_DURATION_MS = 400;
export const MIN_SILENCE_DURATION_SAMPLES = MIN_SILENCE_DURATION_MS * SAMPLE_RATE_MS;

/** Pad each speech chunk by this amount on each side */
export const SPEECH_PAD_MS = 80;
export const SPEECH_PAD_SAMPLES = SPEECH_PAD_MS * SAMPLE_RATE_MS;

/** Speech segments shorter than this are discarded */
export const MIN_SPEECH_DURATION_SAMPLES = 250 * SAMPLE_RATE_MS;

/** Maximum audio buffer duration Moonshine can handle (seconds) */
export const MAX_BUFFER_DURATION = 30;

/** Minimum chunk size for the AudioWorklet processor */
export const NEW_BUFFER_SIZE = 512;

/** Number of previous buffers to keep for speech padding */
export const MAX_NUM_PREV_BUFFERS = Math.ceil(SPEECH_PAD_SAMPLES / NEW_BUFFER_SIZE);
