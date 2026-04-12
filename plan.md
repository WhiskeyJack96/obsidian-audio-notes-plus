# Voice Notes Plus - Implementation Plan

## Context

Building an Obsidian plugin that records audio in-note, saves the recording as an embedded file, and transcribes it locally using Moonshine ONNX models via Transformers.js in a Web Worker. After transcription, the plugin can optionally trigger another Obsidian command (pipe pattern) for downstream processing (e.g., LLM formatting via a separate plugin).

LLM integration is explicitly out of scope. The post-transcription command hook makes the plugin composable with any other Obsidian plugin.

---

## Architecture

```
obsidian-audio-notes-plus/
  manifest.json
  package.json
  tsconfig.json
  esbuild.config.mjs
  scripts/copy-wasm.mjs
  styles.css
  src/
    main.ts                     # Plugin lifecycle, commands, ribbon
    settings.ts                 # Settings tab + types
    types.ts                    # Shared type definitions
    recorder.ts                 # AudioContext + AudioWorklet + MediaRecorder
    transcription/
      worker.ts                 # Web Worker: Transformers.js + Moonshine + Silero VAD
      constants.ts              # Sample rate, VAD thresholds, buffer sizes
      manager.ts                # Main-thread worker lifecycle + message routing
    ui/
      recording-controls.ts     # Status bar + ribbon state management
      model-download-notice.ts  # Progress notice for first-time model download
```

Output files (in plugin directory, served via symlink during dev):
```
main.js           # Plugin entry (CJS)
worker.js         # Transcription worker (ESM, self-contained bundle)
manifest.json
styles.css
ort-wasm-*.wasm   # ONNX Runtime WASM binaries (~7-12MB each)
```

---

## Key Design Decisions

### 1. Two-pass esbuild build

Obsidian expects a single `main.js` (CJS), but the transcription worker needs its own self-contained ESM bundle with `@huggingface/transformers` included. The AudioWorkletProcessor is tiny and dependency-free, so it gets inlined as a string literal + Blob URL at runtime.

**esbuild.config.mjs** runs two parallel builds:
- **Pass 1**: `src/main.ts` -> `main.js` (CJS, externals: obsidian, electron, codemirror, etc.)
- **Pass 2**: `src/transcription/worker.ts` -> `worker.js` (ESM, browser platform, bundles everything)

### 2. Worker loading strategy

The worker is loaded from the plugin directory via `file://` URL:
```typescript
const adapter = this.plugin.app.vault.adapter as FileSystemAdapter;
const basePath = adapter.getBasePath();
const pluginDir = this.plugin.manifest.dir;
const workerUrl = `file://${basePath}/${pluginDir}/worker.js`;
this.worker = new Worker(workerUrl, { type: 'module' });
```

**Fallback if `file://` Workers fail in Electron**: Read `worker.js` via `adapter.readBinary()`, create a Blob URL, and load from that. WASM files would then need to be passed as ArrayBuffers from the main thread.

### 3. WASM file shipping

ONNX Runtime Web requires `.wasm` binaries at runtime. These can't be bundled inline. A `scripts/copy-wasm.mjs` postinstall script copies them from `node_modules/onnxruntime-web/dist/` to the project root. The worker configures `env.backends.onnx.wasm.wasmPaths` to point to the plugin directory.

Required files (~26MB total):
- `ort-wasm-simd.wasm`
- `ort-wasm-simd-threaded.wasm`
- `ort-wasm-simd.jsep.wasm` (WebGPU)

### 4. Audio saving

Every recording saves a `.webm` file to a configurable vault folder (default: `Voice Notes/`). The audio embed (`![[Voice Notes/recording-2026-04-12-143022.webm]]`) is inserted at the cursor, and the transcription text appears below it. Uses MediaRecorder API running in parallel with the AudioWorklet pipeline.

### 5. Post-transcription command (pipe pattern)

Instead of built-in LLM integration, a setting allows configuring an Obsidian command ID to execute after transcription completes. This makes the plugin composable - any other plugin's command can serve as a post-processor.

### 6. Model options

| Setting | Model ID | Params | Download | WER |
|---------|----------|--------|----------|-----|
| `base` (default) | `onnx-community/moonshine-base-ONNX` | ~61M | ~150MB | ~7.7% |
| `tiny` | `onnx-community/moonshine-tiny-ONNX` | ~27M | ~70MB | ~12% |

WebGPU used when available (fp32 encoder + q4 decoder), WASM fallback (fp32 encoder + q8 decoder).

---

## Settings (`src/settings.ts`)

```typescript
interface VoiceNotesSettings {
  // Model
  modelSize: 'tiny' | 'base';          // default: 'base'
  preferWebGPU: boolean;                // default: true

  // Audio
  audioFolder: string;                  // default: 'Voice Notes'
  audioFilenameFormat: string;          // default: 'recording-{{datetime}}'

  // VAD tuning
  speechThreshold: number;              // default: 0.3
  silenceDuration: number;              // default: 400 (ms)

  // Post-transcription
  postTranscriptionCommandId: string;   // default: '' (none)

  // Behavior
  keepModelsLoaded: boolean;            // default: true
}
```

---

## Recording Pipeline

### Flow

1. User triggers "Start recording" (command palette or ribbon icon)
2. If worker not ready: initialize worker, load models (show progress notice)
3. Start `MediaRecorder` (for .webm file saving) and `AudioContext` + `AudioWorkletNode` (for PCM -> worker)
4. Status bar shows recording indicator
5. Audio chunks flow: `AudioWorklet` -> `Worker` (VAD + transcription) -> main thread
6. Each transcribed segment is appended at cursor in real-time
7. User triggers "Stop recording"
8. Worker flushes remaining buffer
9. MediaRecorder blob saved to vault as `.webm`
10. Audio embed + final transcription inserted into note
11. If `postTranscriptionCommandId` is set, execute that command

### Audio capture (`src/recorder.ts`)

Two parallel streams from the same `getUserMedia` call:
- **MediaRecorder**: records compressed `.webm` for saving to vault
- **AudioContext + AudioWorkletNode**: captures raw PCM at 16kHz for the transcription worker

The AudioWorkletProcessor is inlined as a string literal and loaded via Blob URL (no separate file needed - it's ~30 lines with zero dependencies).

### Worker (`src/transcription/worker.ts`)

Adapted from moonshine-web's `worker.js`:
- Waits for `init` message with `wasmBasePath` before loading models
- Configures `env.backends.onnx.wasm.wasmPaths` to the plugin directory
- Loads Silero VAD (fp32) + Moonshine ONNX (device-specific dtypes)
- Compiles shaders with a warm-up inference call
- Processes audio chunks: VAD -> buffer management -> transcription
- Handles `flush` message to transcribe remaining buffer on stop
- Posts `download-progress`, `status`, `output`, and `error` messages

### Manager (`src/transcription/manager.ts`)

Main-thread orchestrator:
- Creates/destroys the Worker
- Passes `wasmBasePath` on init
- Relays audio chunks from recorder to worker (with Transferable for zero-copy)
- Routes worker messages to callbacks (status changes, transcription output, errors)
- Handles the fetch proxy pattern if direct `fetch()` fails in the worker context (CORS workaround using Obsidian's `requestUrl`)

---

## Commands

| ID | Name | Type |
|----|------|------|
| `start-recording` | Start voice recording | `editorCallback` |
| `stop-recording` | Stop voice recording | `editorCallback` |
| `toggle-recording` | Toggle voice recording | `editorCallback` |
| `initialize-models` | Download transcription models | `callback` |

No default hotkeys (per Obsidian guidelines). Ribbon icon toggles recording.

---

## Implementation Phases

### Phase 1: Skeleton + build pipeline
- Initialize project: `package.json`, `tsconfig.json`, `manifest.json`, `esbuild.config.mjs`
- Implement two-pass esbuild config (main.js + worker.js)
- Create minimal `main.ts` that loads/unloads
- Create minimal `worker.ts` that posts a "hello" message
- Set up symlink: `ln -s <project-dir> ~/Workspace/plugin-test-vault/.obsidian/plugins/voice-notes-plus`
- **Validate**: Worker creation works in Obsidian (this is the highest-risk item)
- Write `scripts/copy-wasm.mjs`, run it, verify WASM files are accessible

### Phase 2: Audio capture + recording
- Implement `recorder.ts`: AudioContext + AudioWorkletNode (inline processor) + MediaRecorder
- Implement start/stop commands and ribbon toggle
- Implement status bar recording indicator
- Implement audio file saving (MediaRecorder -> Blob -> vault file via `vault.createBinary()`)
- Insert audio embed at cursor (`![[Voice Notes/recording-*.webm]]`)
- **Validate**: Record audio, see .webm file appear in vault, embed renders in note

### Phase 3: Transcription
- Port moonshine-web worker.js to TypeScript with WASM path configuration
- Implement `manager.ts` for worker lifecycle and message routing
- Implement model download progress notice
- Wire transcription output to progressive editor insertion
- Handle `flush` on stop for remaining buffered audio
- **Validate**: Speak -> text appears in note below audio embed

### Phase 4: Settings + post-transcription hook
- Implement full settings tab (model size, audio folder, VAD tuning, post-transcription command)
- Implement command picker for post-transcription hook (dropdown of available commands)
- Implement model switching (reinitialize worker on model change)
- Implement "keep models loaded" vs "load on demand" toggle
- **Validate**: Change settings, verify they take effect. Set a post-transcription command, verify it fires.

### Phase 5: Polish + edge cases
- Error handling: mic permission denied, worker crash, model download failure
- Edge cases: switching notes during recording, closing note during recording
- Memory management: worker termination on unload, model cache cleanup command
- Remove all `console.log` from `onload`/`onunload`
- Accessibility: ARIA labels on ribbon icon, keyboard-accessible controls, focus indicators
- CSS: scope all styles, use Obsidian CSS variables, support light/dark themes
- `normalizePath()` for all user-configured paths

---

## Test Vault Setup

```bash
# Create plugins directory if needed
mkdir -p ~/Workspace/plugin-test-vault/.obsidian/plugins

# Symlink the plugin
ln -s /Users/jacobmikesell/Workspace/expirements/obsidian-audio-notes-plus \
      /Users/jacobmikesell/Workspace/plugin-test-vault/.obsidian/plugins/voice-notes-plus
```

The symlink means `main.js`, `worker.js`, `manifest.json`, `styles.css`, and `ort-wasm-*.wasm` are all accessible from the plugin directory. Running `npm run dev` watches both entry points.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `file://` Worker URLs blocked in Electron | Blocks entire architecture | Test in Phase 1. Fallback: Blob URL worker + ArrayBuffer WASM transfer |
| WASM fetch fails from `app://` origin | Models won't load | Fetch proxy: worker requests go through main thread's `requestUrl()` |
| Model cache (~150MB) cleared by updates | Re-download on every Obsidian update | Use `env.useFSCache` with path inside plugin data dir |
| Worker bundle size (~2MB+ minified) | Slow first load | Acceptable tradeoff. Tree-shaking helps. One-time cost. |
| Mobile Web Workers unreliable | No mobile support | Mark `isDesktopOnly: false` but test. Fall back gracefully with Notice. |
| AudioWorklet not available (older browsers) | No recording | Check `audioContext.audioWorklet` exists, show error Notice if not |

---

## Critical Files (in order of implementation risk)

1. `esbuild.config.mjs` - Two-pass build is the foundation
2. `src/transcription/worker.ts` - WASM path config + model loading in Electron context
3. `src/transcription/manager.ts` - Worker lifecycle + potential fetch proxy
4. `src/recorder.ts` - Dual-stream audio (MediaRecorder + AudioWorklet)
5. `src/main.ts` - Command registration, recording toggle, editor insertion

## Reference Code

- **moonshine-web worker.js**: `/var/folders/wr/vl5x0dfs7dz3zcyj8t2v_8g80000gn/T/tmp.Ic2EffeV4q/transformers-js-examples/moonshine-web/src/worker.js` (primary reference for worker implementation)
- **moonshine-web processor.js**: same dir `/src/processor.js` (AudioWorkletProcessor to inline)
- **moonshine-web constants.js**: same dir `/src/constants.js` (VAD constants)
- **Obsidian plugin boilerplate**: `/Users/jacobmikesell/Workspace/expirements/obsidian-plugin-skill/tools/create-plugin.js` (esbuild config template, manifest structure)
- **Transformers.js**: `@huggingface/transformers@3.7.1` (pinned to match reference)
