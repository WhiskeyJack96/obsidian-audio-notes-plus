export function extractAudioLinkFromSelection(selection: string): string | null {
	const trimmed = selection.trim();
	if (!trimmed) {
		return null;
	}

	const linkMatch = trimmed.match(/^!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
	return linkMatch ? linkMatch[1] : trimmed;
}

export function findAudioEmbedAtCursor(
	line: string,
	cursorCh: number
): { linkPath: string; endCh: number } | null {
	const embedRegex = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
	let match: RegExpExecArray | null;

	while ((match = embedRegex.exec(line)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (cursorCh < start || cursorCh > end) {
			continue;
		}

		return {
			linkPath: match[1],
			endCh: end,
		};
	}

	return null;
}
