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
| Toggle voice recording | Start or stop recording and transcribing at the cursor |
| Start voice recording in new note | Run the configured "new note command", then start recording in the new note |
| Toggle recording to clipboard | Start or stop recording; transcript is copied to clipboard instead of inserted into a note |
| Transcribe audio | Transcribe the selected audio link/embed, the audio embed under the cursor, or pick a vault audio file (only available when a note is open) |
| Transcribe all audio embeds in current file | Transcribe every audio embed in the active note |
| Transcribe audio file to clipboard | Pick a vault audio file and copy transcript to clipboard (no note needed) |
| Download transcription models | Pre-download models without recording |

### URI Actions

Use `obsidian://voice-notes-plus?command=...` from Shortcuts, Raycast, Alfred, or shell scripts:

- `obsidian://voice-notes-plus?command=start`
- `obsidian://voice-notes-plus?command=start-new-note`
- `obsidian://voice-notes-plus?command=stop`
- `obsidian://voice-notes-plus?command=toggle`
- `obsidian://voice-notes-plus?command=download-models`

Alias URIs are also registered for direct invocation:

- `obsidian://voice-notes-plus-start`
- `obsidian://voice-notes-plus-start-new-note`
- `obsidian://voice-notes-plus-stop`
- `obsidian://voice-notes-plus-toggle`
- `obsidian://voice-notes-plus-download-models`

### Plugin API

Other plugins can call the plugin directly and await the transcript:

```ts
const plugin = app.plugins.plugins["voice-notes-plus"];
const transcript = await plugin.transcribe(fileOrPcm);
```

- `fileOrPcm` can be a vault `TFile` or a `Float32Array` of 16 kHz mono PCM samples.
- The existing workspace event still fires after successful transcriptions.

After every successful transcription the plugin also emits a workspace event that other plugins (QuickAdd, Templater, etc.) can subscribe to:

```js
app.workspace.on("voice-notes-plus:transcription", (transcript, filePath) => {
    // transcript: string — the transcribed text
    // filePath: string | null — vault path of the target note (null for clipboard transcriptions)
});
```

## Settings

- **Model size** — Base (more accurate) or Tiny (faster, less memory)
- **Keep models loaded** — keep models in memory between recordings
- **Audio filename template** — template for saved recordings; supports `{{date}}`, `{{date:FORMAT}}`, and `{{noteName}}` (default: `recording-{{date}}`)
- **Transcript template** — template for inserted output; supports `{{transcript}}`, `{{audio}}`, `{{date}}`, `{{date:FORMAT}}`, `{{duration}}`, and `{{noteName}}`
- **Post-transcription command** — Obsidian command to run after transcription completes; the transcribed text is selected so text-transformation plugins can act on it directly
- **New note command** — command to run before starting a recording in a new note

## License

MIT
