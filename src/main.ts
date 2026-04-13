import { App, FuzzySuggestModal, MarkdownView, Notice, Plugin, TFile, normalizePath, setIcon, setTooltip } from "obsidian";
import { AssetCacheManager } from "./cache";
import { VoiceNotesSettingTab } from "./settings";
import { TranscriptionManager } from "./transcription/manager";
import { AudioRecorder } from "./recorder";
import { DEFAULT_SETTINGS } from "./types";
import type { VoiceNotesSettings, WorkerStatus } from "./types";

type RecordingStartMode = "inline" | "new-note";

interface RecordingTarget {
	filePath: string;
	insertOffset: number;
}

interface CommandManagerLike {
	executeCommandById: (id: string) => unknown;
}

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "webm", "flac", "m4a", "aac", "opus"]);

class AudioFileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private audioFiles: TFile[],
		private onChoose: (file: TFile) => void
	) {
		super(app);
		this.setPlaceholder("Select an audio file to transcribe");
	}

	getItems(): TFile[] {
		return this.audioFiles;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

export default class VoiceNotesPlugin extends Plugin {
	settings: VoiceNotesSettings = DEFAULT_SETTINGS;
	transcriptionManager: TranscriptionManager | null = null;
	private assetCache: AssetCacheManager | null = null;
	private recorder: AudioRecorder | null = null;
	private statusBarEl: HTMLElement | null = null;
	private isRecording = false;
	private ribbonIconEl: HTMLElement | null = null;
	private recordingNotice: Notice | null = null;
	private pendingTranscriptChunks: string[] = [];
	private recordingTarget: RecordingTarget | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.assetCache = new AssetCacheManager(this);
		this.addSettingTab(new VoiceNotesSettingTab(this.app, this));

		// Ribbon icon
		this.ribbonIconEl = this.addRibbonIcon(
			"microphone",
			"Toggle voice recording",
			() => { this.toggleRecording(); }
		);
		this.updateRecordingUi();

		// Commands
		this.addCommand({
			id: "toggle-recording",
			name: "Toggle voice recording",
			callback: () => {
				this.toggleRecording();
			},
		});

		this.addCommand({
			id: "start-recording",
			name: "Start voice recording",
			callback: () => {
				if (!this.isRecording) this.startRecording();
			},
		});

		this.addCommand({
			id: "stop-recording",
			name: "Stop voice recording",
			callback: () => {
				if (this.isRecording) this.stopRecording();
			},
		});

		this.addCommand({
			id: "start-recording-new-note",
			name: "Start voice recording in new note",
			callback: () => {
				if (!this.isRecording) this.startRecording("new-note");
			},
		});

		this.addCommand({
			id: "initialize-models",
			name: "Download transcription models",
			callback: async () => {
				await this.ensureModelsLoaded();
			},
		});

		this.addCommand({
			id: "transcribe-file",
			name: "Transcribe audio file",
			callback: () => {
				this.pickAndTranscribeAudioFile();
			},
		});

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
	}

	onunload(): void {
		this.hideRecordingNotice();
		this.transcriptionManager?.destroy();
		this.transcriptionManager = null;
		this.assetCache = null;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async ensureModelsLoaded(): Promise<void> {
		if (!this.assetCache) {
			this.assetCache = new AssetCacheManager(this);
		}

		this.updateStatusBar("loading", "Caching models...");
		const assetConfig = await this.assetCache.ensureTranscriptionAssets(
			this.settings.modelSize,
			(message) => this.updateStatusBar("loading", message)
		);

		if (!this.transcriptionManager) {
			this.transcriptionManager = new TranscriptionManager(this);
		}
		if (!this.transcriptionManager.isReady) {
			this.updateStatusBar("loading", "Loading models...");
			new Notice("Voice Notes Plus: Downloading transcription models. This may take a minute on first use.");
			await this.transcriptionManager.initialize(assetConfig);
		}
	}

	private pickAndTranscribeAudioFile(): void {
		const audioFiles = this.app.vault.getFiles()
			.filter((f) => AUDIO_EXTENSIONS.has(f.extension.toLowerCase()))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);

		if (audioFiles.length === 0) {
			new Notice("Voice Notes Plus: No audio files found in vault");
			return;
		}

		new AudioFileSuggestModal(this.app, audioFiles, (file) => {
			this.transcribeAudioFile(file);
		}).open();
	}

	private async transcribeAudioFile(file: TFile): Promise<void> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView?.file) {
			new Notice("Voice Notes Plus: Open a note to insert the transcription");
			return;
		}

		const insertTarget: RecordingTarget = {
			filePath: activeView.file.path,
			insertOffset: activeView.editor.posToOffset(activeView.editor.getCursor()),
		};

		try {
			this.updateStatusBar("loading", "Decoding audio...");
			const arrayBuffer = await this.app.vault.readBinary(file);
			const pcm = await this.decodeAudioToPcm(arrayBuffer);

			await this.ensureModelsLoaded();
			this.updateStatusBar("recording_end", "Transcribing file...");

			const transcript = await this.transcriptionManager!.transcribeFile(pcm);
			await this.insertRecordingOutput(insertTarget, file.path, transcript);

			if (this.settings.postTranscriptionCommandId) {
				if (!this.executeCommand(this.settings.postTranscriptionCommandId)) {
					new Notice("Voice Notes Plus: Post-transcription command failed to execute");
				}
			}

			if (!this.settings.keepModelsLoaded) {
				this.transcriptionManager?.destroy();
				this.transcriptionManager = null;
			}

			this.updateStatusBar(null, "");
			new Notice("Voice Notes Plus: Transcription complete");
		} catch (e) {
			this.updateStatusBar(null, "");
			new Notice(
				`Voice Notes Plus: Transcription failed - ${e instanceof Error ? e.message : String(e)}`
			);
		}
	}

	private async decodeAudioToPcm(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
		const audioCtx = new AudioContext();
		const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
		await audioCtx.close();

		const targetRate = 16000;
		const targetLength = Math.ceil(audioBuffer.duration * targetRate);
		const offlineCtx = new OfflineAudioContext(1, targetLength, targetRate);
		const source = offlineCtx.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(offlineCtx.destination);
		source.start();
		const rendered = await offlineCtx.startRendering();
		return rendered.getChannelData(0);
	}

	private async toggleRecording(): Promise<void> {
		if (this.isRecording) {
			await this.stopRecording();
		} else {
			await this.startRecording();
		}
	}

	private async startRecording(mode: RecordingStartMode = "inline"): Promise<void> {
		const target = await this.resolveRecordingTarget(mode);
		if (!target) {
			return;
		}

		try {
			await this.ensureModelsLoaded();
		} catch (e) {
			new Notice(`Voice Notes Plus: Failed to initialize - ${e instanceof Error ? e.message : String(e)}`);
			this.updateStatusBar(null, "");
			return;
		}

		this.isRecording = true;
		this.recordingTarget = target;
		this.pendingTranscriptChunks = [];
		this.updateRecordingUi();
		this.updateStatusBar("recording_start", "Recording...");

		this.recorder = new AudioRecorder();

		this.transcriptionManager!.setCallbacks({
			onTranscription: (text: string) => {
				this.bufferTranscription(text);
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
			this.recordingTarget = null;
			this.pendingTranscriptChunks = [];
			this.updateRecordingUi();
			this.updateStatusBar(null, "");
			new Notice(`Voice Notes Plus: Microphone access denied or unavailable`);
		}
	}

	private async stopRecording(): Promise<void> {
		if (!this.recorder || !this.isRecording || !this.recordingTarget) return;

		this.isRecording = false;
		this.updateRecordingUi();
		this.updateStatusBar("recording_end", "Finishing...");

		let outputInserted = false;

		try {
			const audioBlobPromise = this.recorder.stop();
			const flushPromise = this.transcriptionManager?.flush() ?? Promise.resolve();
			const [audioBlob] = await Promise.all([audioBlobPromise, flushPromise]);
			const audioFilePath = await this.saveAudioFile(audioBlob);
			await this.insertRecordingOutput(
				this.recordingTarget,
				audioFilePath,
				this.getBufferedTranscript()
			);
			outputInserted = true;
		} catch (e) {
			new Notice(`Voice Notes Plus: Failed to finish recording - ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.recorder = null;
			this.recordingTarget = null;
			this.pendingTranscriptChunks = [];
			this.transcriptionManager?.clearCallbacks();

			if (!this.settings.keepModelsLoaded) {
				this.transcriptionManager?.destroy();
				this.transcriptionManager = null;
			}

			this.updateRecordingUi();
			this.updateStatusBar(null, "");
		}

		if (outputInserted && this.settings.postTranscriptionCommandId) {
			if (!this.executeCommand(this.settings.postTranscriptionCommandId)) {
				new Notice("Voice Notes Plus: Post-transcription command failed to execute");
			}
		}
	}

	private bufferTranscription(text: string): void {
		const cleaned = text.trim();
		if (!cleaned) return;
		this.pendingTranscriptChunks.push(cleaned);
	}

	private getBufferedTranscript(): string {
		return this.pendingTranscriptChunks.join(" ").replace(/\s+/g, " ").trim();
	}

	private async saveAudioFile(audioBlob: Blob): Promise<string> {
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
		return filePath;
	}

	private async insertRecordingOutput(
		target: RecordingTarget,
		audioFilePath: string,
		transcript: string
	): Promise<void> {
		const block = transcript
			? `![[${audioFilePath}]]\n\n${transcript}`
			: `![[${audioFilePath}]]`;

		const openView = this.findOpenMarkdownView(target.filePath);
		if (openView?.file?.path === target.filePath) {
			const editor = openView.editor;
			const safeOffset = Math.min(target.insertOffset, editor.getValue().length);
			const insertion = this.formatInsertion(editor.getValue(), safeOffset, block);
			editor.replaceRange(insertion.text, editor.offsetToPos(safeOffset));
			editor.setCursor(editor.offsetToPos(insertion.cursorOffset));
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(target.filePath);
		if (!(file instanceof TFile)) {
			throw new Error("Target note no longer exists");
		}

		const current = await this.app.vault.read(file);
		const safeOffset = Math.min(target.insertOffset, current.length);
		const insertion = this.formatInsertion(current, safeOffset, block);
		const nextContent =
			current.slice(0, safeOffset) +
			insertion.text +
			current.slice(safeOffset);
		await this.app.vault.modify(file, nextContent);
	}

	private formatInsertion(
		existing: string,
		offset: number,
		block: string
	): { text: string; cursorOffset: number } {
		const before = existing.slice(0, offset);
		const after = existing.slice(offset);
		const prefix = before.length === 0
			? ""
			: before.endsWith("\n\n")
				? ""
				: before.endsWith("\n")
					? "\n"
					: "\n\n";
		const suffix = after.length === 0
			? ""
			: after.startsWith("\n\n")
				? ""
				: after.startsWith("\n")
					? "\n"
					: "\n\n";

		return {
			text: `${prefix}${block}${suffix}`,
			cursorOffset: offset + prefix.length + block.length,
		};
	}

	private async resolveRecordingTarget(mode: RecordingStartMode): Promise<RecordingTarget | null> {
		if (mode === "new-note") {
			const commandId = this.settings.newNoteCommandId.trim();
			if (!commandId) {
				new Notice("Voice Notes Plus: Configure a new note command in settings first");
				return null;
			}

			const previousPath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
			if (!this.executeCommand(commandId)) {
				new Notice("Voice Notes Plus: New note command failed to execute");
				return null;
			}

			const newView = await this.waitForMarkdownView(previousPath);
			if (!newView?.file) {
				new Notice("Voice Notes Plus: New note command did not open a note");
				return null;
			}

			return {
				filePath: newView.file.path,
				insertOffset: newView.editor.posToOffset(newView.editor.getCursor()),
			};
		}

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView?.file) {
			new Notice("Open a note to start recording");
			return null;
		}

		return {
			filePath: activeView.file.path,
			insertOffset: activeView.editor.posToOffset(activeView.editor.getCursor()),
		};
	}

	private findOpenMarkdownView(filePath: string): MarkdownView | null {
		let foundView: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (foundView) return;
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === filePath) {
				foundView = view;
			}
		});
		return foundView;
	}

	private async waitForMarkdownView(previousPath: string | null): Promise<MarkdownView | null> {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const currentPath = view?.file?.path ?? null;
			if (view?.file && currentPath !== previousPath) {
				return view;
			}
			await this.sleep(50);
		}
		return null;
	}

	private executeCommand(commandId: string): boolean {
		try {
			(this.app as unknown as { commands: CommandManagerLike }).commands.executeCommandById(commandId);
			return true;
		} catch {
			return false;
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	private updateRecordingUi(): void {
		if (this.ribbonIconEl) {
			setIcon(this.ribbonIconEl, this.isRecording ? "square" : "microphone");
			setTooltip(
				this.ribbonIconEl,
				this.isRecording ? "Stop voice recording" : "Start voice recording"
			);
			this.ribbonIconEl.toggleClass("voice-notes-plus-active", this.isRecording);
		}

		if (this.isRecording) {
			this.showRecordingNotice();
		} else {
			this.hideRecordingNotice();
		}
	}

	private showRecordingNotice(): void {
		if (this.recordingNotice) return;

		const notice = new Notice("", 0);
		notice.messageEl.empty();
		notice.messageEl.addClass("voice-notes-plus-recording-notice");
		notice.messageEl.createDiv({
			text: "Recording in progress",
			cls: "voice-notes-plus-recording-notice-text",
		});
		const stopButton = notice.messageEl.createEl("button", {
			text: "Stop Recording",
			cls: "mod-cta voice-notes-plus-stop-button",
		});
		stopButton.addEventListener("click", () => {
			void this.stopRecording();
		});
		this.recordingNotice = notice;
	}

	private hideRecordingNotice(): void {
		this.recordingNotice?.hide();
		this.recordingNotice = null;
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
