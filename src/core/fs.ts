export interface DirAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
}

export async function ensureDir(adapter: DirAdapter, path: string): Promise<void> {
	if (!path) {
		return;
	}

	if (await adapter.exists(path)) {
		return;
	}

	try {
		await adapter.mkdir(path);
	} catch (error) {
		if (!await adapter.exists(path)) {
			throw error;
		}
	}
}
