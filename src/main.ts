import { App, Editor, EditorPosition, FuzzySuggestModal, MarkdownView, Notice, Plugin, TFile, setIcon, setTooltip } from "obsidian";
import { AssetCacheManager } from "./cache";
import { VoiceNotesSettingTab } from "./settings";
import { TranscriptionManager } from "./transcription/manager";
import { AudioRecorder } from "./recorder";
import { DEFAULT_SETTINGS } from "./types";
import type { CommandManagerLike, VoiceNotesSettings, WorkerStatus } from "./types";

type RecordingStartMode = "inline" | "new-note";

interface RecordingTarget {
	filePath: string;
	insertOffset: number;
}

interface TranscriptSelection {
	editor: Editor;
	from: EditorPosition;
	to: EditorPosition;
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

type BusyState = "idle" | "loading" | "recording" | "transcribing";

export default class VoiceNotesPlugin extends Plugin {
	settings: VoiceNotesSettings = DEFAULT_SETTINGS;
	transcriptionManager: TranscriptionManager | null = null;
	private assetCache: AssetCacheManager | null = null;
	private recorder: AudioRecorder | null = null;
	private statusBarEl: HTMLElement | null = null;
	private isRecording = false;
	private busyState: BusyState = "idle";
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
				if (this.requireIdle() && !this.isRecording) this.startRecording();
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
				if (this.requireIdle() && !this.isRecording) this.startRecording("new-note");
			},
		});

		this.addCommand({
			id: "initialize-models",
			name: "Download transcription models",
			callback: async () => {
				if (this.requireIdle()) await this.ensureModelsLoaded();
			},
		});

		this.addCommand({
			id: "transcribe-file",
			name: "Transcribe audio file",
			callback: () => {
				this.pickAndTranscribeAudioFile();
			},
		});

		this.addCommand({
			id: "transcribe-embeds",
			name: "Transcribe all audio embeds in current file",
			editorCallback: () => {
				this.transcribeAllEmbedsInCurrentFile();
			},
		});

		this.addCommand({
			id: "transcribe-to-clipboard",
			name: "Transcribe audio file to clipboard",
			callback: () => {
				this.pickAndTranscribeToClipboard();
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

	private requireIdle(allowStop = false): boolean {
		if (this.busyState === "idle") return true;
		if (allowStop && this.busyState === "recording") return true;
		new Notice("Voice Notes Plus: Already busy — wait for the current operation to finish.");
		return false;
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
		if (!this.requireIdle()) return;
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const selection = activeView?.editor.getSelection().trim() ?? "";

		if (selection && activeView?.file) {
			// Strip link/embed syntax: ![[path]] or [[path]] → path
			const linkMatch = selection.match(/^!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
			const linkPath = linkMatch ? linkMatch[1] : selection;

			const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, activeView.file.path);
			if (resolved instanceof TFile && AUDIO_EXTENSIONS.has(resolved.extension.toLowerCase())) {
				// Insert after the end of the selection (the embed/link)
				const selEnd = activeView.editor.getCursor("to");
				const insertOffset = activeView.editor.posToOffset(selEnd);
				this.transcribeAudioFile(resolved, insertOffset);
				return;
			}
		}

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

	private async transcribeAudioFile(file: TFile, appendAfterOffset?: number): Promise<void> {
		if (!this.requireIdle()) return;

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView?.file) {
			new Notice("Voice Notes Plus: Open a note to insert the transcription");
			return;
		}

		const insertOffset = appendAfterOffset
			?? activeView.editor.posToOffset(activeView.editor.getCursor());

		this.busyState = "transcribing";
		try {
			this.updateStatusBar("loading", "Decoding audio...");
			const arrayBuffer = await this.app.vault.readBinary(file);
			const pcm = await this.decodeAudioToPcm(arrayBuffer);

			await this.ensureModelsLoaded();
			this.updateStatusBar("recording_end", "Transcribing file...");

			const transcript = await this.transcriptionManager!.transcribeFile(pcm);
			let transcriptSelection: TranscriptSelection | null = null;

			if (appendAfterOffset != null) {
				if (transcript.trim()) {
					const editor = activeView.editor;
					const trimmed = transcript.trim();
					const block = `> [!transcript]\n> ${trimmed}`;
					const insertion = this.formatInsertion(editor.getValue(), insertOffset, block);
					editor.replaceRange(insertion.text, editor.offsetToPos(insertOffset));
					transcriptSelection = this.computeTranscriptSelection(editor, insertOffset, insertion.text, block, trimmed);
				}
			} else {
				const insertTarget: RecordingTarget = {
					filePath: activeView.file!.path,
					insertOffset,
				};
				transcriptSelection = await this.insertRecordingOutput(insertTarget, file.path, transcript);
			}

			this.app.workspace.trigger("voice-notes-plus:transcription", transcript, activeView.file!.path);

			if (this.settings.postTranscriptionCommandId) {
				if (transcriptSelection) {
					transcriptSelection.editor.setSelection(transcriptSelection.from, transcriptSelection.to);
				}
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
		} finally {
			this.busyState = "idle";
		}
	}

	private pickAndTranscribeToClipboard(): void {
		if (!this.requireIdle()) return;

		const audioFiles = this.app.vault.getFiles()
			.filter((f) => AUDIO_EXTENSIONS.has(f.extension.toLowerCase()))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);

		if (audioFiles.length === 0) {
			new Notice("Voice Notes Plus: No audio files found in vault");
			return;
		}

		new AudioFileSuggestModal(this.app, audioFiles, (file) => {
			void this.transcribeToClipboard(file);
		}).open();
	}

	private async transcribeToClipboard(file: TFile): Promise<void> {
		if (!this.requireIdle()) return;

		this.busyState = "transcribing";
		try {
			this.updateStatusBar("loading", "Decoding audio...");
			const arrayBuffer = await this.app.vault.readBinary(file);
			const pcm = await this.decodeAudioToPcm(arrayBuffer);

			await this.ensureModelsLoaded();
			this.updateStatusBar("recording_end", "Transcribing...");

			const transcript = await this.transcriptionManager!.transcribeFile(pcm);
			await navigator.clipboard.writeText(transcript);

			this.app.workspace.trigger("voice-notes-plus:transcription", transcript, null);

			if (!this.settings.keepModelsLoaded) {
				this.transcriptionManager?.destroy();
				this.transcriptionManager = null;
			}

			this.updateStatusBar(null, "");
			new Notice("Voice Notes Plus: Transcript copied to clipboard");
		} catch (e) {
			this.updateStatusBar(null, "");
			new Notice(
				`Voice Notes Plus: Transcription failed - ${e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			this.busyState = "idle";
		}
	}

	private async transcribeAllEmbedsInCurrentFile(): Promise<void> {
		if (!this.requireIdle()) return;

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView?.file) {
			new Notice("Voice Notes Plus: Open a note first");
			return;
		}

		const cache = this.app.metadataCache.getFileCache(activeView.file);
		const audioEmbeds = (cache?.embeds ?? []).filter((embed) => {
			const ext = embed.link.split(".").pop()?.toLowerCase() ?? "";
			return AUDIO_EXTENSIONS.has(ext);
		});

		if (audioEmbeds.length === 0) {
			new Notice("Voice Notes Plus: No audio embeds found in current file");
			return;
		}

		this.busyState = "transcribing";
		try {
			await this.ensureModelsLoaded();
		} catch (e) {
			this.busyState = "idle";
			new Notice(`Voice Notes Plus: Failed to initialize - ${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		let transcribed = 0;
		let skipped = 0;
		let failed = 0;

		// Process in reverse order so earlier offsets remain valid after insertions
		const sortedEmbeds = [...audioEmbeds].sort(
			(a, b) => b.position.end.offset - a.position.end.offset
		);

		for (const embed of sortedEmbeds) {
			const editor = activeView.editor;
			const currentContent = editor.getValue();

			// Skip if already transcribed (tolerate whitespace variations)
			const afterEmbed = currentContent.slice(embed.position.end.offset);
			if (/^\s*\n>\s*\[!transcript\]/.test(afterEmbed)) {
				skipped++;
				continue;
			}

			const file = this.app.metadataCache.getFirstLinkpathDest(embed.link, activeView.file!.path);
			if (!(file instanceof TFile)) {
				new Notice(`Voice Notes Plus: Audio file not found: ${embed.link}`);
				skipped++;
				continue;
			}

			this.updateStatusBar("recording_end", `Transcribing ${transcribed + 1}/${audioEmbeds.length}...`);

			try {
				const arrayBuffer = await this.app.vault.readBinary(file);
				const pcm = await this.decodeAudioToPcm(arrayBuffer);
				const transcript = await this.transcriptionManager!.transcribeFile(pcm);

				if (transcript.trim()) {
					const insertPos = editor.offsetToPos(embed.position.end.offset);
					editor.replaceRange(`\n> [!transcript]\n> ${transcript.trim()}`, insertPos);
					transcribed++;
					this.app.workspace.trigger("voice-notes-plus:transcription", transcript, activeView.file!.path);
				} else {
					skipped++;
				}
			} catch (e) {
				failed++;
				new Notice(`Voice Notes Plus: Failed to transcribe ${embed.link} - ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		if (!this.settings.keepModelsLoaded) {
			this.transcriptionManager?.destroy();
			this.transcriptionManager = null;
		}

		this.busyState = "idle";
		this.updateStatusBar(null, "");
		const parts = [`Transcribed ${transcribed} embed${transcribed !== 1 ? "s" : ""}`];
		if (skipped > 0) parts.push(`${skipped} skipped`);
		if (failed > 0) parts.push(`${failed} failed`);
		new Notice(`Voice Notes Plus: ${parts.join(", ")}`);

		if (transcribed > 0 && this.settings.postTranscriptionCommandId) {
			if (!this.executeCommand(this.settings.postTranscriptionCommandId)) {
				new Notice("Voice Notes Plus: Post-transcription command failed to execute");
			}
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
			if (!this.requireIdle()) return;
			await this.startRecording();
		}
	}

	private async startRecording(mode: RecordingStartMode = "inline"): Promise<void> {
		const target = await this.resolveRecordingTarget(mode);
		if (!target) {
			return;
		}

		this.busyState = "loading";
		try {
			await this.ensureModelsLoaded();
		} catch (e) {
			this.busyState = "idle";
			new Notice(`Voice Notes Plus: Failed to initialize - ${e instanceof Error ? e.message : String(e)}`);
			this.updateStatusBar(null, "");
			return;
		}

		this.isRecording = true;
		this.busyState = "recording";
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
			this.busyState = "idle";
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
		let finalTranscript = "";
		let targetFilePath = this.recordingTarget.filePath;
		let transcriptSelection: TranscriptSelection | null = null;

		try {
			const audioBlobPromise = this.recorder.stop();
			const flushPromise = this.transcriptionManager?.flush() ?? Promise.resolve();
			const [audioBlob] = await Promise.all([audioBlobPromise, flushPromise]);
			const audioFilePath = await this.saveAudioFile(audioBlob);
			finalTranscript = this.getBufferedTranscript();
			transcriptSelection = await this.insertRecordingOutput(
				this.recordingTarget,
				audioFilePath,
				finalTranscript
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

			this.busyState = "idle";
			this.updateRecordingUi();
			this.updateStatusBar(null, "");
		}

		if (outputInserted) {
			this.app.workspace.trigger("voice-notes-plus:transcription", finalTranscript, targetFilePath);

			if (this.settings.postTranscriptionCommandId) {
				if (transcriptSelection) {
					transcriptSelection.editor.setSelection(transcriptSelection.from, transcriptSelection.to);
				}
				if (!this.executeCommand(this.settings.postTranscriptionCommandId)) {
					new Notice("Voice Notes Plus: Post-transcription command failed to execute");
				}
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
		const ext = this.recorder?.fileExtension ?? "webm";
		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.replace("T", "-")
			.replace("Z", "");
		const activeFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		const template = this.settings.recordingFilenameTemplate || "recording-{{date}}";
		const baseName = template
			.replace("{{date}}", timestamp)
			.replace("{{noteName}}", activeFile?.basename ?? "");
		const fileName = `${baseName}.${ext}`;

		// Use the active note as source so Obsidian respects the user's
		// "Default location for new attachments" setting.
		const sourcePath = activeFile?.path ?? "";
		const filePath = await this.app.fileManager.getAvailablePathForAttachment(fileName, sourcePath);

		const arrayBuffer = await audioBlob.arrayBuffer();
		await this.app.vault.createBinary(filePath, new Uint8Array(arrayBuffer));
		return filePath;
	}

	private formatTranscriptionBlock(audioFilePath: string, transcript: string): string {
		if (!transcript) return `![[${audioFilePath}]]`;
		return `![[${audioFilePath}]]\n> [!transcript]\n> ${transcript}`;
	}

	private async insertRecordingOutput(
		target: RecordingTarget,
		audioFilePath: string,
		transcript: string
	): Promise<TranscriptSelection | null> {
		const block = this.formatTranscriptionBlock(audioFilePath, transcript);

		const openView = this.findOpenMarkdownView(target.filePath);
		if (openView?.file?.path === target.filePath) {
			const editor = openView.editor;
			const safeOffset = Math.min(target.insertOffset, editor.getValue().length);
			const insertion = this.formatInsertion(editor.getValue(), safeOffset, block);
			editor.replaceRange(insertion.text, editor.offsetToPos(safeOffset));
			editor.setCursor(editor.offsetToPos(insertion.cursorOffset));
			return this.computeTranscriptSelection(editor, safeOffset, insertion.text, block, transcript);
		}

		const file = this.app.vault.getAbstractFileByPath(target.filePath);
		if (!(file instanceof TFile)) {
			throw new Error("Target note no longer exists");
		}

		await this.app.vault.process(file, (current) => {
			const safeOffset = Math.min(target.insertOffset, current.length);
			const insertion = this.formatInsertion(current, safeOffset, block);
			return (
				current.slice(0, safeOffset) +
				insertion.text +
				current.slice(safeOffset)
			);
		});
		return null;
	}

	private computeTranscriptSelection(
		editor: Editor,
		insertOffset: number,
		insertionText: string,
		block: string,
		transcript: string
	): TranscriptSelection | null {
		if (!transcript.trim()) return null;
		const calloutHeader = "\n> [!transcript]\n> ";
		const headerIdx = block.indexOf(calloutHeader);
		if (headerIdx < 0) return null;
		const blockStartInInsertion = insertionText.indexOf(block);
		if (blockStartInInsertion < 0) return null;
		const transcriptAbsStart = insertOffset + blockStartInInsertion + headerIdx + calloutHeader.length;
		const transcriptAbsEnd = insertOffset + blockStartInInsertion + block.length;
		return {
			editor,
			from: editor.offsetToPos(transcriptAbsStart),
			to: editor.offsetToPos(transcriptAbsEnd),
		};
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
		// Check if already changed before subscribing
		const current = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (current?.file && current.file.path !== previousPath) {
			return current;
		}

		return new Promise<MarkdownView | null>((resolve) => {
			const timeoutId = window.setTimeout(() => {
				this.app.workspace.offref(ref);
				resolve(null);
			}, 5000);

			const ref = this.app.workspace.on("active-leaf-change", () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file && view.file.path !== previousPath) {
					window.clearTimeout(timeoutId);
					this.app.workspace.offref(ref);
					resolve(view);
				}
			});

			this.registerEvent(ref);
		});
	}

	private executeCommand(commandId: string): boolean {
		try {
			return (this.app as unknown as { commands: CommandManagerLike }).commands.executeCommandById(commandId);
		} catch {
			return false;
		}
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
