import { MarkdownView, Notice, Plugin, normalizePath } from "obsidian";
import type { Editor } from "obsidian";
import { VoiceNotesSettingTab } from "./settings";
import { TranscriptionManager } from "./transcription/manager";
import { AudioRecorder } from "./recorder";
import { DEFAULT_SETTINGS } from "./types";
import type { VoiceNotesSettings, WorkerStatus } from "./types";

export default class VoiceNotesPlugin extends Plugin {
	settings: VoiceNotesSettings = DEFAULT_SETTINGS;
	transcriptionManager: TranscriptionManager | null = null;
	private recorder: AudioRecorder | null = null;
	private statusBarEl: HTMLElement | null = null;
	private isRecording = false;
	private ribbonIconEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new VoiceNotesSettingTab(this.app, this));

		// Ribbon icon
		this.ribbonIconEl = this.addRibbonIcon(
			"microphone",
			"Toggle voice recording",
			() => { this.toggleRecording(); }
		);

		// Commands
		this.addCommand({
			id: "toggle-recording",
			name: "Toggle voice recording",
			editorCallback: () => {
				this.toggleRecording();
			},
		});

		this.addCommand({
			id: "start-recording",
			name: "Start voice recording",
			editorCallback: () => {
				if (!this.isRecording) this.startRecording();
			},
		});

		this.addCommand({
			id: "stop-recording",
			name: "Stop voice recording",
			editorCallback: () => {
				if (this.isRecording) this.stopRecording();
			},
		});

		this.addCommand({
			id: "initialize-models",
			name: "Download transcription models",
			callback: async () => {
				await this.ensureModelsLoaded();
			},
		});

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
	}

	onunload(): void {
		this.transcriptionManager?.destroy();
		this.transcriptionManager = null;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async ensureModelsLoaded(): Promise<void> {
		if (!this.transcriptionManager) {
			this.transcriptionManager = new TranscriptionManager(this);
		}
		if (!this.transcriptionManager.isReady) {
			this.updateStatusBar("loading", "Loading models...");
			new Notice("Voice Notes Plus: Downloading transcription models. This may take a minute on first use.");
			await this.transcriptionManager.initialize();
		}
	}

	private async toggleRecording(): Promise<void> {
		if (this.isRecording) {
			await this.stopRecording();
		} else {
			await this.startRecording();
		}
	}

	private async startRecording(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("Open a note to start recording");
			return;
		}
		const editor = view.editor;

		try {
			await this.ensureModelsLoaded();
		} catch (e) {
			new Notice(`Voice Notes Plus: Failed to initialize - ${e instanceof Error ? e.message : String(e)}`);
			this.updateStatusBar(null, "");
			return;
		}

		this.isRecording = true;
		this.ribbonIconEl?.addClass("voice-notes-plus-active");
		this.updateStatusBar("recording_start", "Recording...");

		this.recorder = new AudioRecorder();

		this.transcriptionManager!.setCallbacks({
			onTranscription: (text: string) => {
				this.insertTranscription(editor, text);
			},
			onStatusChange: (status: WorkerStatus, message: string) => {
				this.updateStatusBar(status, message);
			},
			onError: (error: string) => {
				new Notice(`Voice Notes Plus: ${error}`);
			},
		});

		try {
			await this.recorder.start((buffer: Float32Array) => {
				this.transcriptionManager!.sendAudioChunk(buffer);
			});
		} catch (e) {
			this.isRecording = false;
			this.ribbonIconEl?.removeClass("voice-notes-plus-active");
			this.updateStatusBar(null, "");
			new Notice(`Voice Notes Plus: Microphone access denied or unavailable`);
		}
	}

	private async stopRecording(): Promise<void> {
		if (!this.recorder || !this.isRecording) return;

		this.isRecording = false;
		this.ribbonIconEl?.removeClass("voice-notes-plus-active");
		this.updateStatusBar("recording_end", "Finishing...");

		// Flush remaining audio in the worker
		this.transcriptionManager?.flush();

		// Stop recorder and get audio blob
		const audioBlob = await this.recorder.stop();
		this.recorder = null;

		// Save audio file to vault
		await this.saveAudioFile(audioBlob);

		// Clear callbacks
		this.transcriptionManager?.clearCallbacks();

		// Tear down models if not keeping loaded
		if (!this.settings.keepModelsLoaded) {
			this.transcriptionManager?.destroy();
			this.transcriptionManager = null;
		}

		this.updateStatusBar(null, "");

		// Execute post-transcription command if configured
		if (this.settings.postTranscriptionCommandId) {
			try {
				(this.app as unknown as { commands: { executeCommandById: (id: string) => void } })
					.commands.executeCommandById(this.settings.postTranscriptionCommandId);
			} catch {
				new Notice("Voice Notes Plus: Post-transcription command failed to execute");
			}
		}
	}

	private insertTranscription(editor: Editor, text: string): void {
		const cursor = editor.getCursor();
		editor.replaceRange(text + " ", cursor);
		// Move cursor to end of inserted text
		const newCh = cursor.ch + text.length + 1;
		editor.setCursor({ line: cursor.line, ch: newCh });
	}

	private async saveAudioFile(audioBlob: Blob): Promise<void> {
		const folderPath = normalizePath(this.settings.audioFolder);

		// Ensure the audio folder exists
		if (!this.app.vault.getAbstractFileByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}

		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.replace("T", "-")
			.replace("Z", "");
		const fileName = `recording-${timestamp}.webm`;
		const filePath = normalizePath(`${folderPath}/${fileName}`);

		const arrayBuffer = await audioBlob.arrayBuffer();
		await this.app.vault.createBinary(filePath, new Uint8Array(arrayBuffer));

		// Insert audio embed at cursor in active editor
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			const editor = view.editor;
			const cursor = editor.getCursor();
			const embed = `\n![[${filePath}]]\n`;
			editor.replaceRange(embed, cursor);
			// Move cursor past the embed
			const lines = embed.split("\n");
			editor.setCursor({
				line: cursor.line + lines.length - 1,
				ch: lines[lines.length - 1].length,
			});
		}
	}

	private updateStatusBar(status: WorkerStatus | null, message: string): void {
		if (!this.statusBarEl) return;

		// Clear existing content
		while (this.statusBarEl.firstChild) {
			this.statusBarEl.removeChild(this.statusBarEl.firstChild);
		}

		if (!status || !message) return;

		const container = this.statusBarEl.createSpan();

		if (status === "recording_start") {
			container.addClass("voice-notes-plus-status-recording");
			const pulse = container.createSpan({ cls: "voice-notes-plus-pulse" });
			pulse.setAttribute("aria-hidden", "true");
			container.createSpan({ text: message });
		} else if (status === "recording_end") {
			container.addClass("voice-notes-plus-status-transcribing");
			container.setText(message);
		} else if (status === "loading") {
			container.addClass("voice-notes-plus-status-loading");
			container.setText(message);
		}
	}
}
