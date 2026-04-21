export const PROTOCOL_COMMANDS = [
	"start",
	"start-new-note",
	"stop",
	"toggle",
	"download-models",
] as const;

export type ProtocolCommand = typeof PROTOCOL_COMMANDS[number];

export interface ProtocolParams {
	action?: string;
	command?: string;
	intent?: string;
	mode?: string;
	[key: string]: string | undefined;
}

export function parseProtocolCommand(
	params: ProtocolParams,
	pluginId: string
): ProtocolCommand | null {
	const raw = (params.command ?? params.mode ?? params.intent ?? params.action ?? "").toLowerCase();
	switch (raw) {
		case "":
		case pluginId:
		case "start":
			return "start";
		case "start-new-note":
		case "start_new_note":
		case "new-note":
		case "new_note":
			return "start-new-note";
		case "stop":
			return "stop";
		case "toggle":
			return "toggle";
		case "download-models":
		case "download_models":
		case "initialize-models":
		case "initialize_models":
		case "initialize":
			return "download-models";
		default:
			return null;
	}
}

export function getProtocolHandlerActions(pluginId: string): string[] {
	return [pluginId, ...PROTOCOL_COMMANDS.map((command) => `${pluginId}-${command}`)];
}
