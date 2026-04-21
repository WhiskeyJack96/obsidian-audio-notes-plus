export interface TemplateDateFormatter {
	(date: Date, format: string): string | null | undefined;
}

export interface TemplateValues {
	audio?: string;
	transcript?: string;
	duration?: string;
	noteName?: string;
	date: Date;
}

export interface TranscriptOutputOptions {
	template: string;
	audioFilePath: string;
	includeAudioEmbed: boolean;
	transcript: string;
	durationSeconds: number;
	noteName: string;
	date: Date;
	formatDate?: TemplateDateFormatter;
}

export function renderTemplate(
	template: string,
	values: TemplateValues,
	formatDate?: TemplateDateFormatter
): string {
	return template.replace(/\{\{(\w+)(?::([^}]+))?\}\}/g, (match, key: string, tokenFormat?: string) => {
		switch (key) {
			case "audio":
				return values.audio ?? "";
			case "transcript":
				return values.transcript ?? "";
			case "duration":
				return values.duration ?? "";
			case "noteName":
				return values.noteName ?? "";
			case "date":
				return formatDateToken(values.date, tokenFormat, formatDate);
			default:
				return match;
		}
	});
}

export function formatDateToken(
	date: Date,
	format?: string,
	formatDate?: TemplateDateFormatter
): string {
	if (format && formatDate) {
		const formatted = formatDate(date, format);
		if (formatted) {
			return formatted;
		}
	}

	return date
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "-")
		.replace("Z", "");
}

export function formatDuration(durationSeconds: number): string {
	const totalSeconds = Math.max(0, Math.round(durationSeconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}

	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function sanitizeFileNameSegment(value: string): string {
	return value.replace(/[\\/:*?"<>|]/g, "-").trim();
}

export function renderTranscriptOutput(options: TranscriptOutputOptions): string {
	const audioMarkup = options.includeAudioEmbed ? `![[${options.audioFilePath}]]` : "";
	const trimmedTranscript = options.transcript.trim();
	if (!trimmedTranscript) {
		return audioMarkup;
	}

	return renderTemplate(
		options.template,
		{
			audio: audioMarkup,
			transcript: trimmedTranscript,
			duration: formatDuration(options.durationSeconds),
			noteName: options.noteName,
			date: options.date,
		},
		options.formatDate
	).trim();
}

export function hasTranscriptionOutputAfterEmbed(
	afterEmbed: string,
	template: string
): boolean {
	const sentinel = "__VOICE_NOTES_PLUS_SENTINEL__";
	const rendered = renderTemplate(template, {
		audio: "",
		transcript: sentinel,
		duration: "0:00",
		noteName: "",
		date: new Date(0),
	}).trim();
	const sentinelIndex = rendered.indexOf(sentinel);
	if (sentinelIndex < 0) {
		return false;
	}

	const prefix = rendered.slice(0, sentinelIndex).trimStart();
	const suffix = rendered.slice(sentinelIndex + sentinel.length).trimEnd();
	if (!prefix && !suffix) {
		return false;
	}

	const normalized = afterEmbed.trimStart();
	if (prefix && !normalized.startsWith(prefix)) {
		return false;
	}
	if (suffix && !normalized.includes(suffix)) {
		return false;
	}
	return true;
}
