export function formatInsertion(
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
