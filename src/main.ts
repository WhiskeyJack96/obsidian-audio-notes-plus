import { App, Editor, EditorPosition, FuzzySuggestModal, MarkdownView, Notice, Plugin, TFile, setIcon, setTooltip } from "obsidian";
import { AssetCacheManager } from "./cache";
import { VoiceNotesSettingTab } from "./settings";
import { TranscriptionManager } from "./transcription/manager";
import { AudioRecorder } from "./recorder";
import { DEFAULT_SETTINGS } from "./types";
import type { CommandManagerLike, VoiceNotesSettings, WorkerStatus } from "./types";
import type { ObsidianProtocolData } from "obsidian";
import { formatInsertion } from "./core/insertion";
import { extractAudioLinkFromSelection, findAudioEmbedAtCursor } from "./core/markdown";
import { parseProtocolCommand, PROTOCOL_COMMANDS } from "./core/protocol";
import type { ProtocolCommand } from "./core/protocol";
import {
	formatDateToken,
	renderTemplate,
	renderTranscriptOutput,
	sanitizeFileNameSegment,
} from "./core/templates";

type RecordingStartMode = "inline" | "new-note" | "clipboard";

interface RecordingTarget {
	filePath: string;
	insertOffset: number;
}

interface TranscriptSelection {
	editor: Editor;
	from: EditorPosition;
	to: EditorPosition;
}

interface DecodedAudio {
	pcm: Float32Array;
	durationSeconds: number;
}

interface TemplateMoment {
	format: (template: string) => string;
}

interface TemplateWindow extends Window {
	moment?: (input?: Date | number | string) => TemplateMoment;
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
	private recordingStartedAt: number | null = null;
	private clipboardRecording = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.assetCache = new AssetCacheManager(this);
		this.addSettingTab(new VoiceNotesSettingTab(this.app, this));
		this.registerProtocolHandlers();

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
			checkCallback: (checking: boolean) => {
				if (!this.isRecording && !this.app.workspace.getActiveViewOfType(MarkdownView)) return false;
				if (!checking) this.toggleRecording();
				return true;
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
			id: "transcribe-audio",
			name: "Transcribe audio",
			checkCallback: (checking: boolean) => {
				if (!this.app.workspace.getActiveViewOfType(MarkdownView)) return false;
				if (!checking) this.startTranscribeAudioFile();
				return true;
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

		this.addCommand({
			id: "toggle-recording-to-clipboard",
			name: "Toggle recording to clipboard",
			callback: () => {
				this.toggleRecordingToClipboard();
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

	getAssetCacheManager(): AssetCacheManager {
		if (!this.assetCache) {
			this.assetCache = new AssetCacheManager(this);
		}
		return this.assetCache;
	}

	private registerProtocolHandlers(): void {
		this.registerObsidianProtocolHandler(this.manifest.id, (params) => {
			void this.handleProtocolCommand(this.parseProtocolCommand(params));
		});

		for (const command of PROTOCOL_COMMANDS) {
			this.registerObsidianProtocolHandler(`${this.manifest.id}-${command}`, () => {
				void this.handleProtocolCommand(command);
			});
		}
	}

	private parseProtocolCommand(params: ObsidianProtocolData): ProtocolCommand | null {
		return parseProtocolCommand(params, this.manifest.id);
	}

	private async handleProtocolCommand(command: ProtocolCommand | null): Promise<void> {
		if (!command) {
			new Notice("Voice Notes Plus: Unknown URI action");
			return;
		}

		switch (command) {
			case "start":
				if (this.requireIdle() && !this.isRecording) {
					await this.startRecording();
				}
				return;
			case "start-new-note":
				if (this.requireIdle() && !this.isRecording) {
					await this.startRecording("new-note");
				}
				return;
			case "stop":
				if (!this.isRecording) {
					new Notice("Voice Notes Plus: No active recording to stop");
					return;
				}
				await this.stopRecording();
				return;
			case "toggle":
				await this.toggleRecording();
				return;
			case "download-models":
				if (this.requireIdle()) {
					await this.ensureModelsLoaded();
				}
				return;
		}
	}

	private requireIdle(allowStop = false): boolean {
		if (this.busyState === "idle") return true;
		if (allowStop && this.busyState === "recording") return true;
		new Notice("Voice Notes Plus: Already busy — wait for the current operation to finish.");
		return false;
	}

	private async ensureModelsLoaded(): Promise<void> {
		this.updateStatusBar("loading", "Caching models...");
		const assetConfig = await this.getAssetCacheManager().ensureTranscriptionAssets(
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

	public async transcribe(input: TFile | Float32Array): Promise<string> {
		if (!this.requireIdle()) {
			throw new Error("Voice Notes Plus is busy");
		}

		this.busyState = "transcribing";
		try {
			const transcript = input instanceof TFile
				? await this.transcribeDecodedAudio(await this.decodeVaultAudioFile(input), "Transcribing...")
				: await this.transcribeDecodedAudio(
					{ pcm: input, durationSeconds: input.length / 16000 },
					"Transcribing..."
				);
			this.app.workspace.trigger("voice-notes-plus:transcription", transcript, null);
			return transcript;
		} finally {
			this.finishTranscriptionSession();
		}
	}

	private startTranscribeAudioFile(): void {
		if (!this.requireIdle()) return;

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const selectionTarget = activeView ? this.resolveSelectedAudioTarget(activeView) : null;
		if (selectionTarget) {
			void this.transcribeAudioFile(selectionTarget.file, selectionTarget.insertOffset);
			return;
		}

		const embedTarget = activeView ? this.resolveAudioEmbedAtCursor(activeView) : null;
		if (embedTarget) {
			void this.transcribeAudioFile(embedTarget.file, embedTarget.insertOffset);
			return;
		}

		this.pickAudioFile((file) => {
			void this.transcribeAudioFile(file);
		});
	}

	private pickAudioFile(onChoose: (file: TFile) => void): void {
		const audioFiles = this.getAudioFiles();
		if (audioFiles.length === 0) {
			new Notice("Voice Notes Plus: No audio files found in vault");
			return;
		}

		new AudioFileSuggestModal(this.app, audioFiles, onChoose).open();
	}

	private getAudioFiles(): TFile[] {
		return this.app.vault.getFiles()
			.filter((f) => AUDIO_EXTENSIONS.has(f.extension.toLowerCase()))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	private resolveSelectedAudioTarget(view: MarkdownView): { file: TFile; insertOffset: number } | null {
		const selection = view.editor.getSelection();
		if (!selection || !view.file) {
			return null;
		}

		const linkedFile = this.resolveLinkedAudioFile(
			extractAudioLinkFromSelection(selection) ?? "",
			view.file.path
		);
		if (!linkedFile) {
			return null;
		}

		return {
			file: linkedFile,
			insertOffset: view.editor.posToOffset(view.editor.getCursor("to")),
		};
	}

	private resolveAudioEmbedAtCursor(view: MarkdownView): { file: TFile; insertOffset: number } | null {
		if (!view.file) {
			return null;
		}

		const cursor = view.editor.getCursor();
		const line = view.editor.getLine(cursor.line);
		const embed = findAudioEmbedAtCursor(line, cursor.ch);
		if (!embed) {
			return null;
		}

		const linkedFile = this.resolveLinkedAudioFile(embed.linkPath, view.file.path);
		if (!linkedFile) {
			return null;
		}

		return {
			file: linkedFile,
			insertOffset: view.editor.posToOffset({ line: cursor.line, ch: embed.endCh }),
		};
	}

	private resolveLinkedAudioFile(linkPath: string, sourcePath: string): TFile | null {
		const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
		if (!(resolved instanceof TFile)) {
			return null;
		}
		return AUDIO_EXTENSIONS.has(resolved.extension.toLowerCase()) ? resolved : null;
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
			const decodedAudio = await this.decodeVaultAudioFile(file);
			const transcript = await this.transcribeDecodedAudio(decodedAudio, "Transcribing file...");
			let transcriptSelection: TranscriptSelection | null = null;

			if (appendAfterOffset != null) {
				const block = this.renderTranscriptOutput({
					audioFilePath: file.path,
					includeAudioEmbed: false,
					transcript,
					durationSeconds: decodedAudio.durationSeconds,
					noteName: activeView.file.basename,
					date: new Date(),
				});
				if (block) {
					const editor = activeView.editor;
					const insertion = formatInsertion(editor.getValue(), insertOffset, block);
					editor.replaceRange(insertion.text, editor.offsetToPos(insertOffset));
					transcriptSelection = this.computeTranscriptSelection(editor, insertOffset, insertion.text, block, transcript);
				}
			} else {
				const insertTarget: RecordingTarget = {
					filePath: activeView.file!.path,
					insertOffset,
				};
				transcriptSelection = await this.insertRecordingOutput(
					insertTarget,
					file.path,
					transcript,
					decodedAudio.durationSeconds,
					new Date()
				);
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

			new Notice("Voice Notes Plus: Transcription complete");
		} catch (e) {
			new Notice(
				`Voice Notes Plus: Transcription failed - ${e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			this.finishTranscriptionSession();
		}
	}

	private pickAndTranscribeToClipboard(): void {
		if (!this.requireIdle()) return;

		this.pickAudioFile((file) => {
			void this.transcribeToClipboard(file);
		});
	}

	private async transcribeToClipboard(file: TFile): Promise<void> {
		if (!this.requireIdle()) return;

		this.busyState = "transcribing";
		try {
			const transcript = await this.transcribeDecodedAudio(
				await this.decodeVaultAudioFile(file),
				"Transcribing..."
			);
			await navigator.clipboard.writeText(transcript);

			this.app.workspace.trigger("voice-notes-plus:transcription", transcript, null);
			new Notice("Voice Notes Plus: Transcript copied to clipboard");
		} catch (e) {
			new Notice(
				`Voice Notes Plus: Transcription failed - ${e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			this.finishTranscriptionSession();
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
		let failed = 0;

		// Process in reverse order so earlier offsets remain valid after insertions
		const sortedEmbeds = [...audioEmbeds].sort(
			(a, b) => b.position.end.offset - a.position.end.offset
		);

		for (const embed of sortedEmbeds) {
			const editor = activeView.editor;
			const currentContent = editor.getValue();

			const file = this.app.metadataCache.getFirstLinkpathDest(embed.link, activeView.file!.path);
			if (!(file instanceof TFile)) {
				new Notice(`Voice Notes Plus: Audio file not found: ${embed.link}`);
				failed++;
				continue;
			}

			this.updateStatusBar("recording_end", `Transcribing ${transcribed + 1}/${audioEmbeds.length}...`);

			try {
				const decodedAudio = await this.decodeVaultAudioFile(file);
				const transcript = await this.transcribeDecodedAudio(
					decodedAudio,
					`Transcribing ${transcribed + 1}/${audioEmbeds.length}...`
				);
				const block = this.renderTranscriptOutput({
					audioFilePath: file.path,
					includeAudioEmbed: false,
					transcript,
					durationSeconds: decodedAudio.durationSeconds,
					noteName: activeView.file.basename,
					date: new Date(),
				});

				if (block) {
					const insertPos = editor.offsetToPos(embed.position.end.offset);
					editor.replaceRange(`\n${block}`, insertPos);
					transcribed++;
					this.app.workspace.trigger("voice-notes-plus:transcription", transcript, activeView.file!.path);
				}
			} catch (e) {
				failed++;
				new Notice(`Voice Notes Plus: Failed to transcribe ${embed.link} - ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		this.finishTranscriptionSession();
		const parts = [`Transcribed ${transcribed} embed${transcribed !== 1 ? "s" : ""}`];
		if (failed > 0) parts.push(`${failed} failed`);
		new Notice(`Voice Notes Plus: ${parts.join(", ")}`);

		if (transcribed > 0 && this.settings.postTranscriptionCommandId) {
			if (!this.executeCommand(this.settings.postTranscriptionCommandId)) {
				new Notice("Voice Notes Plus: Post-transcription command failed to execute");
			}
		}
	}

	private finishTranscriptionSession(): void {
		if (!this.settings.keepModelsLoaded) {
			this.transcriptionManager?.destroy();
			this.transcriptionManager = null;
		}
		this.busyState = "idle";
		this.updateStatusBar(null, "");
	}

	private async decodeVaultAudioFile(file: TFile): Promise<DecodedAudio> {
		this.updateStatusBar("loading", "Decoding audio...");
		const arrayBuffer = await this.app.vault.readBinary(file);
		return this.decodeAudioToPcm(arrayBuffer);
	}

	private async transcribeDecodedAudio(
		decodedAudio: DecodedAudio,
		statusMessage: string
	): Promise<string> {
		await this.ensureModelsLoaded();
		this.updateStatusBar("recording_end", statusMessage);
		return this.transcriptionManager!.transcribeFile(decodedAudio.pcm);
	}

	private async decodeAudioToPcm(arrayBuffer: ArrayBuffer): Promise<DecodedAudio> {
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
		return {
			pcm: rendered.getChannelData(0),
			durationSeconds: audioBuffer.duration,
		};
	}

	private async toggleRecording(): Promise<void> {
		if (this.isRecording) {
			await this.stopRecording();
		} else {
			if (!this.requireIdle()) return;
			await this.startRecording();
		}
	}

	private async toggleRecordingToClipboard(): Promise<void> {
		if (this.isRecording && this.clipboardRecording) {
			await this.stopRecording();
		} else if (this.isRecording) {
			new Notice("Voice Notes Plus: A recording is already in progress");
		} else {
			if (!this.requireIdle()) return;
			this.clipboardRecording = true;
			await this.startRecording("clipboard");
		}
	}

	private async startRecording(mode: RecordingStartMode = "inline"): Promise<void> {
		let target: RecordingTarget | null = null;
		if (mode !== "clipboard") {
			target = await this.resolveRecordingTarget(mode);
			if (!target) {
				return;
			}
		}

		this.busyState = "loading";
		try {
			await this.ensureModelsLoaded();
		} catch (e) {
			this.busyState = "idle";
			this.clipboardRecording = false;
			new Notice(`Voice Notes Plus: Failed to initialize - ${e instanceof Error ? e.message : String(e)}`);
			this.updateStatusBar(null, "");
			return;
		}

		this.isRecording = true;
		this.busyState = "recording";
		this.recordingTarget = target;
		this.recordingStartedAt = Date.now();
		this.pendingTranscriptChunks = [];
		this.updateRecordingUi();
		this.updateStatusBar("recording_start", this.clipboardRecording ? "Recording to clipboard..." : "Recording...");

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
			this.clipboardRecording = false;
			this.recordingTarget = null;
			this.recordingStartedAt = null;
			this.pendingTranscriptChunks = [];
			this.updateRecordingUi();
			this.updateStatusBar(null, "");
			new Notice(`Voice Notes Plus: Microphone access denied or unavailable`);
		}
	}

	private async stopRecording(): Promise<void> {
		if (!this.recorder || !this.isRecording) return;
		if (!this.clipboardRecording && !this.recordingTarget) return;

		this.isRecording = false;
		this.updateRecordingUi();
		this.updateStatusBar("recording_end", "Finishing...");

		if (this.clipboardRecording) {
			try {
				const audioBlobPromise = this.recorder.stop();
				const flushPromise = this.transcriptionManager?.flush() ?? Promise.resolve();
				await Promise.all([audioBlobPromise, flushPromise]);
				const transcript = this.getBufferedTranscript();
				await navigator.clipboard.writeText(transcript);

				this.app.workspace.trigger("voice-notes-plus:transcription", transcript, null);
				new Notice("Voice Notes Plus: Transcript copied to clipboard");
			} catch (e) {
				new Notice(`Voice Notes Plus: Failed to finish recording - ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				this.recorder = null;
				this.recordingTarget = null;
				this.recordingStartedAt = null;
				this.pendingTranscriptChunks = [];
				this.clipboardRecording = false;
				this.transcriptionManager?.clearCallbacks();
				this.finishTranscriptionSession();
				this.updateRecordingUi();
			}
			return;
		}

		let outputInserted = false;
		let finalTranscript = "";
		const targetFilePath = this.recordingTarget!.filePath;
		let transcriptSelection: TranscriptSelection | null = null;
		const finishedAt = new Date();
		const durationSeconds = this.recordingStartedAt === null
			? 0
			: Math.max(0, (finishedAt.getTime() - this.recordingStartedAt) / 1000);

		try {
			const audioBlobPromise = this.recorder.stop();
			const flushPromise = this.transcriptionManager?.flush() ?? Promise.resolve();
			const [audioBlob] = await Promise.all([audioBlobPromise, flushPromise]);
			const audioFilePath = await this.saveAudioFile(audioBlob);
			finalTranscript = this.getBufferedTranscript();
			transcriptSelection = await this.insertRecordingOutput(
				this.recordingTarget!,
				audioFilePath,
				finalTranscript,
				durationSeconds,
				finishedAt
			);
			outputInserted = true;
		} catch (e) {
			new Notice(`Voice Notes Plus: Failed to finish recording - ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.recorder = null;
			this.recordingTarget = null;
			this.recordingStartedAt = null;
			this.pendingTranscriptChunks = [];
			this.transcriptionManager?.clearCallbacks();

			this.finishTranscriptionSession();
			this.updateRecordingUi();
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
		const now = new Date();
		const activeFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		const template = this.settings.recordingFilenameTemplate || "recording-{{date}}";
		const baseName = sanitizeFileNameSegment(renderTemplate(template, {
			date: now,
			noteName: activeFile?.basename ?? "",
		}, this.getTemplateDateFormatter())) || `recording-${formatDateToken(now)}`;
		const fileName = `${baseName}.${ext}`;

		// Use the active note as source so Obsidian respects the user's
		// "Default location for new attachments" setting.
		const sourcePath = activeFile?.path ?? "";
		const filePath = await this.app.fileManager.getAvailablePathForAttachment(fileName, sourcePath);

		const arrayBuffer = await audioBlob.arrayBuffer();
		await this.app.vault.createBinary(filePath, arrayBuffer);
		return filePath;
	}

	private renderTranscriptOutput({
		audioFilePath,
		includeAudioEmbed,
		transcript,
		durationSeconds,
		noteName,
		date,
	}: {
		audioFilePath: string;
		includeAudioEmbed: boolean;
		transcript: string;
		durationSeconds: number;
		noteName: string;
		date: Date;
	}): string {
		const audioMarkup = includeAudioEmbed ? `![[${audioFilePath}]]` : "";
		const trimmedTranscript = transcript.trim();
		if (!trimmedTranscript) {
			return audioMarkup;
		}

		return renderTranscriptOutput({
			template: this.settings.transcriptTemplate.trim() || DEFAULT_SETTINGS.transcriptTemplate,
			audioFilePath,
			includeAudioEmbed,
			transcript: trimmedTranscript,
			durationSeconds,
			noteName,
			date,
			formatDate: this.getTemplateDateFormatter(),
		});
	}

	private async insertRecordingOutput(
		target: RecordingTarget,
		audioFilePath: string,
		transcript: string,
		durationSeconds: number,
		date: Date
	): Promise<TranscriptSelection | null> {
		const targetFile = this.app.vault.getAbstractFileByPath(target.filePath);
		if (!(targetFile instanceof TFile)) {
			throw new Error("Target note no longer exists");
		}
		const block = this.renderTranscriptOutput({
			audioFilePath,
			includeAudioEmbed: true,
			transcript,
			durationSeconds,
			noteName: targetFile.basename,
			date,
		});

		const openView = this.findOpenMarkdownView(target.filePath);
		if (openView?.file?.path === target.filePath) {
			const editor = openView.editor;
			const safeOffset = Math.min(target.insertOffset, editor.getValue().length);
			const insertion = formatInsertion(editor.getValue(), safeOffset, block);
			editor.replaceRange(insertion.text, editor.offsetToPos(safeOffset));
			editor.setCursor(editor.offsetToPos(insertion.cursorOffset));
			return this.computeTranscriptSelection(editor, safeOffset, insertion.text, block, transcript);
		}

		await this.app.vault.process(targetFile, (current) => {
			const safeOffset = Math.min(target.insertOffset, current.length);
			const insertion = formatInsertion(current, safeOffset, block);
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
		const trimmedTranscript = transcript.trim();
		if (!trimmedTranscript) return null;
		const transcriptIdx = block.indexOf(trimmedTranscript);
		if (transcriptIdx < 0) return null;
		const blockStartInInsertion = insertionText.indexOf(block);
		if (blockStartInInsertion < 0) return null;
		const transcriptAbsStart = insertOffset + blockStartInInsertion + transcriptIdx;
		const transcriptAbsEnd = transcriptAbsStart + trimmedTranscript.length;
		return {
			editor,
			from: editor.offsetToPos(transcriptAbsStart),
			to: editor.offsetToPos(transcriptAbsEnd),
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
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === filePath) {
				return view;
			}
		}
		return null;
	}

	private async waitForMarkdownView(previousPath: string | null): Promise<MarkdownView | null> {
		const current = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (current?.file && current.file.path !== previousPath) {
			return current;
		}

		return new Promise<MarkdownView | null>((resolve) => {
			let settled = false;
			const finish = (view: MarkdownView | null) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeoutId);
				this.app.workspace.offref(fileOpenRef);
				resolve(view);
			};

			const timeoutId = window.setTimeout(() => {
				finish(null);
			}, 5000);

			const fileOpenRef = this.app.workspace.on("file-open", (file) => {
				if (!file || file.path === previousPath) {
					return;
				}
				const view = this.findOpenMarkdownView(file.path) ?? this.app.workspace.getActiveViewOfType(MarkdownView);
				finish(view?.file?.path === file.path ? view : null);
			});

			this.registerEvent(fileOpenRef);
		});
	}

	private getTemplateDateFormatter(): ((date: Date, format: string) => string | null) | undefined {
		const moment = (window as TemplateWindow).moment;
		if (!moment) {
			return undefined;
		}
		return (date: Date, format: string) => moment(date).format(format);
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
