import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting } from "obsidian";
import { AssetCacheManager } from "./cache";
import type { CachedFileInfo } from "./cache";
import type VoiceNotesPlugin from "./main";
import type { VoiceNotesSettings } from "./types";

interface CommandSuggestion {
	id: string;
	name: string;
}

interface CommandManagerLike {
	commands: Record<string, CommandSuggestion>;
}

class CommandInputSuggest extends AbstractInputSuggest<CommandSuggestion> {
	constructor(
		app: App,
		textInputEl: HTMLInputElement,
		private getCommands: () => CommandSuggestion[]
	) {
		super(app, textInputEl);
	}

	protected getSuggestions(query: string): CommandSuggestion[] {
		const normalizedQuery = query.trim().toLowerCase();
		return this.getCommands()
			.filter((command) => {
				if (!normalizedQuery) return true;
				return (
					command.name.toLowerCase().includes(normalizedQuery) ||
					command.id.toLowerCase().includes(normalizedQuery)
				);
			})
			.slice(0, 50);
	}

	renderSuggestion(command: CommandSuggestion, el: HTMLElement): void {
		el.createDiv({ text: command.name });
		el.createEl("small", { text: command.id });
	}
}

export class VoiceNotesSettingTab extends PluginSettingTab {
	plugin: VoiceNotesPlugin;

	constructor(app: App, plugin: VoiceNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// -- Transcription section --
		new Setting(containerEl).setName("Transcription").setHeading();

		new Setting(containerEl)
			.setName("Model size")
			.setDesc("Base is more accurate (~7.7% WER). Tiny is faster and uses less memory (~12% WER).")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("base", "Base (~150 MB)")
					.addOption("tiny", "Tiny (~70 MB)")
					.setValue(this.plugin.settings.modelSize)
					.onChange(async (value) => {
						this.plugin.settings.modelSize = value as VoiceNotesSettings["modelSize"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Keep models loaded")
			.setDesc("Keep transcription models in memory between recordings for faster startup.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.keepModelsLoaded)
					.onChange(async (value) => {
						this.plugin.settings.keepModelsLoaded = value;
						await this.plugin.saveSettings();
					})
			);

		// -- Recording section --
		new Setting(containerEl).setName("Recording").setHeading();

		new Setting(containerEl)
			.setName("Audio filename template")
			.setDesc(
				"Template for saved audio filenames. " +
				"Supported tokens: {{date}} (ISO timestamp), {{noteName}} (active note basename)."
			)
			.addText((text) =>
				text
					.setPlaceholder("recording-{{date}}")
					.setValue(this.plugin.settings.recordingFilenameTemplate)
					.onChange(async (value) => {
						this.plugin.settings.recordingFilenameTemplate = value;
						await this.plugin.saveSettings();
					})
			);

		// -- Post-transcription section --
		new Setting(containerEl).setName("Post-transcription").setHeading();

		new Setting(containerEl)
			.setName("Post-transcription command")
			.setDesc(
				"Obsidian command to execute after transcription completes. " +
				"Works like a unix pipe: the transcription is inserted first, " +
				"then this command runs. Leave empty to disable."
			)
			.addText((text) =>
				this.configureCommandText(
					text.inputEl,
					this.plugin.settings.postTranscriptionCommandId,
					"e.g., my-llm-plugin:format-selection",
					async (value) => {
						this.plugin.settings.postTranscriptionCommandId = value;
						await this.plugin.saveSettings();
					}
				)
			);

		new Setting(containerEl)
			.setName("New note command")
			.setDesc(
				"Command to execute before 'Start voice recording in new note'. " +
				"It should create or focus the note that should receive the audio clip and transcript."
			)
			.addText((text) =>
				this.configureCommandText(
					text.inputEl,
					this.plugin.settings.newNoteCommandId,
					"e.g., workspace:new-tab",
					async (value) => {
						this.plugin.settings.newNoteCommandId = value;
						await this.plugin.saveSettings();
					}
				)
			);

		// -- Cache section --
		new Setting(containerEl).setName("Model cache").setHeading();

		const cacheListEl = containerEl.createDiv({ cls: "voice-notes-plus-cache-list" });
		this.renderCacheStatus(cacheListEl);

		new Setting(containerEl)
			.setName("Re-download all models")
			.setDesc("Delete the local cache and download every model and runtime file again.")
			.addButton((button) =>
				button
					.setButtonText("Re-download")
					.setWarning()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("Working...");
						try {
							const cache = new AssetCacheManager(this.plugin);
							await cache.clearCache();
							await cache.ensureTranscriptionAssets(
								this.plugin.settings.modelSize
							);
							// Tear down the loaded worker so the next
							// recording picks up the fresh files.
							this.plugin.transcriptionManager?.destroy();
							this.plugin.transcriptionManager = null;
							new Notice("Voice Notes Plus: Cache rebuilt successfully.");
						} catch (e) {
							new Notice(
								`Voice Notes Plus: Cache rebuild failed - ${e instanceof Error ? e.message : String(e)}`
							);
						} finally {
							button.setDisabled(false);
							button.setButtonText("Re-download");
							this.renderCacheStatus(cacheListEl);
						}
					})
			);
	}

	private renderCacheStatus(container: HTMLElement): void {
		container.empty();
		container.createEl("p", {
			text: "Loading cache status...",
			cls: "voice-notes-plus-cache-loading",
		});

		const cache = new AssetCacheManager(this.plugin);
		cache.getCacheStatus(this.plugin.settings.modelSize).then((files) => {
			container.empty();

			if (files.length === 0) {
				container.createEl("p", { text: "No files expected for current settings." });
				return;
			}

			const table = container.createEl("table", { cls: "voice-notes-plus-cache-table" });
			const thead = table.createEl("thead");
			const headerRow = thead.createEl("tr");
			headerRow.createEl("th", { text: "File" });
			headerRow.createEl("th", { text: "Size" });
			headerRow.createEl("th", { text: "Status" });
			headerRow.createEl("th", { text: "" });

			const tbody = table.createEl("tbody");
			let totalBytes = 0;

			for (const file of files) {
				const row = tbody.createEl("tr");
				row.createEl("td", { text: file.label, cls: "voice-notes-plus-cache-file-label" });
				row.createEl("td", { text: file.exists ? this.formatBytes(file.bytes) : "-" });
				const statusCell = row.createEl("td");
				if (file.exists) {
					statusCell.createSpan({ text: "Cached", cls: "voice-notes-plus-cache-ok" });
				} else {
					statusCell.createSpan({ text: "Missing", cls: "voice-notes-plus-cache-missing" });
				}

				const actionsCell = row.createEl("td");
				const recacheBtn = actionsCell.createEl("button", {
					text: file.exists ? "Re-download" : "Download",
					cls: "voice-notes-plus-cache-recache-btn",
				});
				recacheBtn.addEventListener("click", async () => {
					recacheBtn.disabled = true;
					recacheBtn.textContent = "Working...";
					try {
						const cache = new AssetCacheManager(this.plugin);
						await cache.recacheFile(file);
						this.plugin.transcriptionManager?.destroy();
						this.plugin.transcriptionManager = null;
						new Notice(`Voice Notes Plus: ${file.label} re-cached.`);
					} catch (e) {
						new Notice(
							`Voice Notes Plus: Failed - ${e instanceof Error ? e.message : String(e)}`
						);
					} finally {
						this.renderCacheStatus(container);
					}
				});

				totalBytes += file.bytes;
			}

			const cachedCount = files.filter((f) => f.exists).length;
			container.createEl("p", {
				text: `${cachedCount}/${files.length} files cached (${this.formatBytes(totalBytes)} total)`,
				cls: "setting-item-description",
			});
		});
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";
		const units = ["B", "KB", "MB", "GB"];
		const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
		const value = bytes / Math.pow(1024, i);
		return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}

	private configureCommandText(
		inputEl: HTMLInputElement,
		value: string,
		placeholder: string,
		onChange: (value: string) => Promise<void>
	): void {
		inputEl.placeholder = placeholder;
		inputEl.value = value;

		const suggest = new CommandInputSuggest(this.app, inputEl, () => this.getAvailableCommands());
		suggest.onSelect(async (command) => {
			inputEl.value = command.id;
			await onChange(command.id);
		});

		inputEl.addEventListener("change", () => {
			void onChange(inputEl.value.trim());
		});
	}

	private getAvailableCommands(): CommandSuggestion[] {
		const commandManager = (this.app as unknown as { commands: CommandManagerLike }).commands;
		return Object.values(commandManager.commands)
			.slice()
			.sort((left, right) => left.name.localeCompare(right.name));
	}
}
