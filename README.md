# Voice Notes Plus

Record audio in-note and transcribe locally using [Moonshine](https://github.com/usefulsensors/moonshine) ONNX models via [Transformers.js](https://huggingface.co/docs/transformers.js) — no cloud API required.

## Features

- **In-note recording** — capture audio directly in your note with a ribbon icon or command palette
- **Local transcription** — speech-to-text runs entirely on your device in a Web Worker
- **Audio file saving** — recordings are saved as `.webm` files and embedded in your note
- **Post-transcription command hook** — pipe transcribed text into any other Obsidian command (e.g., an LLM formatting plugin)
- **Voice activity detection** — Silero VAD segments speech automatically
- **WebGPU acceleration** — uses GPU when available, falls back to WASM

## Models

Two Moonshine ONNX model sizes are available (configurable in settings):

| Model | HuggingFace | Params | Download | WER |
|-------|-------------|--------|----------|-----|
| Base (default) | [onnx-community/moonshine-base-ONNX](https://huggingface.co/onnx-community/moonshine-base-ONNX) | ~61M | ~150 MB | ~7.7% |
| Tiny | [onnx-community/moonshine-tiny-ONNX](https://huggingface.co/onnx-community/moonshine-tiny-ONNX) | ~27M | ~70 MB | ~12% |

> **⚠️ Network required for first use:** The selected model is downloaded from HuggingFace on first launch and cached locally. After the initial download, the plugin works fully offline.

## Installation

This plugin is not yet available in the Obsidian Community Plugin directory.

### Install via BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `https://github.com/whiskeyjack96/obsidian-audio-notes-plus`
4. Enable **Voice Notes Plus** in Settings → Community Plugins

## Usage

1. Open a note and place your cursor where you want the recording
2. Click the microphone ribbon icon or run **Start voice recording** from the command palette
3. Speak — transcribed text appears in real-time below the audio embed
4. Click the ribbon icon again or run **Stop voice recording** to finish

### Commands

| Command | Description |
|---------|-------------|
| Start voice recording | Begin recording and transcribing at the cursor |
| Start voice recording in new note | Run the configured "new note command", then start recording in the new note |
| Stop voice recording | Stop recording and finalize transcription |
| Toggle voice recording | Start or stop recording |
| Transcribe audio file | Pick a vault audio file and insert transcript at cursor |
| Transcribe audio file to clipboard | Pick a vault audio file and copy transcript to clipboard (no note needed) |
| Transcribe all audio embeds in current file | Transcribe every audio embed in the active note |
| Download transcription models | Pre-download models without recording |

### Plugin API

After every successful transcription the plugin emits a workspace event that other plugins (QuickAdd, Templater, etc.) can subscribe to:

```js
app.workspace.on("voice-notes-plus:transcription", (transcript, filePath) => {
    // transcript: string — the transcribed text
    // filePath: string | null — vault path of the target note (null for clipboard transcriptions)
});
```

## Settings

- **Model size** — Base (more accurate) or Tiny (faster, less memory)
- **Keep models loaded** — keep models in memory between recordings
- **Audio filename template** — template for saved recordings; supports `{{date}}` and `{{noteName}}` tokens (default: `recording-{{date}}`)
- **Post-transcription command** — Obsidian command to run after transcription completes; the transcribed text is selected so text-transformation plugins can act on it directly
- **New note command** — command to run before starting a recording in a new note

## License

MIT
