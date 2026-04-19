import { Platform, normalizePath } from "obsidian";
import { MODEL_IDS } from "./types";
import type VoiceNotesPlugin from "./main";
import type { LocalAssetConfig, VoiceNotesSettings } from "./types";

// Injected at build time by esbuild. Off in shipped builds.
declare const DEBUG_LOGS: boolean;

export interface CachedFileInfo {
	/** Display label (e.g. "onnx-community/moonshine-base-ONNX/config.json") */
	label: string;
	/** Vault-relative path */
	vaultPath: string;
	/** Whether the file currently exists on disk */
	exists: boolean;
	/** File size in bytes (0 if missing) */
	bytes: number;
}

const CACHE_SCHEMA_VERSION = 2;
const TRANSFORMERS_VERSION = "4.0.0";
const ORT_VERSION = "1.25.0-dev.20260327-722743c0e2";
const HUGGING_FACE_HOST = "https://huggingface.co";
const HUGGING_FACE_REVISION = "main";
const CACHE_ROOT_PROBE_FILE = ".cache-root";
const CACHE_MANIFEST_FILE = "cache-manifest.json";

const MOONSHINE_ROOT_FILES = [
	"config.json",
	"generation_config.json",
	"preprocessor_config.json",
	"special_tokens_map.json",
	"tokenizer.json",
	"tokenizer_config.json",
];

const MOONSHINE_ENCODER_FILE = "onnx/encoder_model.onnx";
const MOONSHINE_DECODER_FILE = "onnx/decoder_model_merged_q4.onnx";

const SILERO_FILES = [
	"onnx/model.onnx",
];

const RUNTIME_FILES = [
	{
		fileName: "ort-wasm-simd-threaded.wasm",
		url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.wasm`,
	},
	{
		fileName: "ort-wasm-simd-threaded.asyncify.wasm",
		url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.asyncify.wasm`,
	},
	{
		fileName: "ort-wasm-simd-threaded.mjs",
		url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.mjs`,
	},
	{
		fileName: "ort-wasm-simd-threaded.asyncify.mjs",
		url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.asyncify.mjs`,
	},
] as const;

// Transformers.js 4.x picks the .asyncify. WASM variant on every
// non-Safari browser (including Electron/Obsidian desktop); Safari and
// mobile fall back to the plain files.  On Android, the plain binary
// is loaded via a blob URL from inside the worker (see worker.ts), so
// caching both sets keeps every platform working from a single layout.
const MOBILE_RUNTIME_FILES = RUNTIME_FILES;

interface CacheManifest {
	schemaVersion: number;
	transformersVersion: string;
	platformKey: string;
	modelId: string;
	updatedAt: string;
}

export class AssetCacheManager {
	constructor(private plugin: VoiceNotesPlugin) {}

	/**
	 * Return status info for every file the current settings require.
	 */
	async getCacheStatus(
		modelSize: VoiceNotesSettings["modelSize"]
	): Promise<CachedFileInfo[]> {
		const modelId = MODEL_IDS[modelSize];
		const modelsCacheDir = this.getModelsCacheDir();
		const runtimeCacheDir = this.getRuntimeCacheDir();
		const adapter = this.plugin.app.vault.adapter;
		const results: CachedFileInfo[] = [];

		const modelFiles = [
			...MOONSHINE_ROOT_FILES,
			MOONSHINE_ENCODER_FILE,
			MOONSHINE_DECODER_FILE,
		];

		const repoEntries: Array<{ repo: string; file: string }> = [
			...modelFiles.map((f) => ({ repo: modelId, file: f })),
			...SILERO_FILES.map((f) => ({ repo: "onnx-community/silero-vad", file: f })),
		];

		for (const { repo, file } of repoEntries) {
			const vaultPath = normalizePath(`${modelsCacheDir}/${repo}/${file}`);
			const exists = await adapter.exists(vaultPath);
			let bytes = 0;
			if (exists) {
				const stat = await adapter.stat(vaultPath);
				bytes = stat?.size ?? 0;
			}
			results.push({ label: `${repo}/${file}`, vaultPath, exists, bytes });
		}

		for (const rtFile of this.getRuntimeFiles()) {
			const vaultPath = normalizePath(`${runtimeCacheDir}/${rtFile.fileName}`);
			const exists = await adapter.exists(vaultPath);
			let bytes = 0;
			if (exists) {
				const stat = await adapter.stat(vaultPath);
				bytes = stat?.size ?? 0;
			}
			results.push({ label: `runtime/${rtFile.fileName}`, vaultPath, exists, bytes });
		}

		return results;
	}

	/**
	 * Delete all cached files so the next ensureTranscriptionAssets
	 * re-downloads everything from scratch.
	 */
	async clearCache(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter as typeof this.plugin.app.vault.adapter & {
			rmdir: (normalizedPath: string, recursive: boolean) => Promise<void>;
		};
		const root = this.getPluginCacheRoot();
		if (await adapter.exists(root)) {
			await adapter.rmdir(root, true);
		}
	}

	/**
	 * Delete and re-download a single cached file.
	 */
	async recacheFile(file: CachedFileInfo): Promise<void> {
		const adapter = this.plugin.app.vault.adapter as typeof this.plugin.app.vault.adapter & {
			remove: (normalizedPath: string) => Promise<void>;
		};

		if (file.exists) {
			await adapter.remove(file.vaultPath);
		}

		const url = this.getDownloadUrl(file.label);
		if (!url) {
			throw new Error(`Cannot determine download URL for ${file.label}`);
		}

		await this.downloadBinary(url, file.vaultPath);
	}

	async ensureTranscriptionAssets(
		modelSize: VoiceNotesSettings["modelSize"],
		onProgress?: (message: string) => void
	): Promise<LocalAssetConfig> {
		const modelId = MODEL_IDS[modelSize];
		const modelsCacheDir = this.getModelsCacheDir();
		const runtimeCacheDir = this.getRuntimeCacheDir();
		const platformKey = this.getPlatformKey();

		await this.ensureDir(modelsCacheDir);
		await this.ensureDir(runtimeCacheDir);

		await this.ensureProbeFile(modelsCacheDir);

		const modelFiles = [
			...MOONSHINE_ROOT_FILES,
			MOONSHINE_ENCODER_FILE,
			MOONSHINE_DECODER_FILE,
		];

		await this.ensureRepoFiles(modelId, modelFiles, modelsCacheDir, onProgress);
		await this.ensureRepoFiles("onnx-community/silero-vad", SILERO_FILES, modelsCacheDir, onProgress);
		await this.ensureRuntimeFiles(runtimeCacheDir, onProgress);
		await this.writeManifest({
			schemaVersion: CACHE_SCHEMA_VERSION,
			transformersVersion: TRANSFORMERS_VERSION,
			platformKey,
			modelId,
			updatedAt: new Date().toISOString(),
		});

		const config: LocalAssetConfig = {
			assetMode: "local",
			modelBaseUrl: this.getDirectoryResourceBase(
				normalizePath(`${modelsCacheDir}/${CACHE_ROOT_PROBE_FILE}`),
				CACHE_ROOT_PROBE_FILE
			),
			runtimeBaseUrl: this.getDirectoryResourceBase(
				normalizePath(`${runtimeCacheDir}/${RUNTIME_FILES[0].fileName}`),
				RUNTIME_FILES[0].fileName
			),
			platformKey,
		};

		// On mobile, file:// URLs are not fetchable from a blob-URL Web
		// Worker.  Read every cached file on the main thread and hand the
		// raw ArrayBuffers to the worker so it can create blob URLs in its
		// own scope.
		if (Platform.isMobileApp) {
			onProgress?.("Preparing models for worker...");
			config.assetBlobs = await this.readCachedAssetBlobs(
				modelId, modelFiles, modelsCacheDir, runtimeCacheDir
			);
		}

		return config;
	}

	private async ensureRepoFiles(
		repoId: string,
		files: string[],
		modelsCacheDir: string,
		onProgress?: (message: string) => void
	): Promise<void> {
		for (const file of files) {
			const relativePath = normalizePath(`${modelsCacheDir}/${repoId}/${file}`);
			if (await this.plugin.app.vault.adapter.exists(relativePath)) {
				continue;
			}

			onProgress?.(`Caching ${repoId}/${file}`);
			await this.downloadBinary(
				this.getHuggingFaceResolveUrl(repoId, file),
				relativePath
			);
		}
	}

	private async ensureRuntimeFiles(
		runtimeCacheDir: string,
		onProgress?: (message: string) => void
	): Promise<void> {
		for (const file of this.getRuntimeFiles()) {
			const relativePath = normalizePath(`${runtimeCacheDir}/${file.fileName}`);
			if (await this.plugin.app.vault.adapter.exists(relativePath)) {
				continue;
			}

			onProgress?.(`Caching runtime ${file.fileName}`);
			await this.downloadBinary(
				file.url,
				relativePath
			);
		}
	}

	private async readCachedAssetBlobs(
		modelId: string,
		modelFiles: string[],
		modelsCacheDir: string,
		runtimeCacheDir: string
	): Promise<Record<string, ArrayBuffer>> {
		const adapter = this.plugin.app.vault.adapter;
		const blobs: Record<string, ArrayBuffer> = {};

		// Model files - keyed as "<repoId>/<file>" so the worker can
		// reconstruct the same path that Transformers.js will request.
		const repoFiles: Array<{ repo: string; file: string }> = [
			...modelFiles.map((f) => ({ repo: modelId, file: f })),
			...SILERO_FILES.map((f) => ({ repo: "onnx-community/silero-vad", file: f })),
		];

		for (const { repo, file } of repoFiles) {
			const vaultPath = normalizePath(`${modelsCacheDir}/${repo}/${file}`);
			blobs[`models/${repo}/${file}`] = await adapter.readBinary(vaultPath);
		}

		// Runtime files - keyed as "runtime/<fileName>"
		for (const rtFile of this.getRuntimeFiles()) {
			const vaultPath = normalizePath(`${runtimeCacheDir}/${rtFile.fileName}`);
			blobs[`runtime/${rtFile.fileName}`] = await adapter.readBinary(vaultPath);
		}

		return blobs;
	}

	private async downloadBinary(url: string, relativePath: string): Promise<void> {
		await this.ensureDir(this.dirname(relativePath));
		await this.downloadStreaming(url, relativePath);
	}

	private async downloadStreaming(url: string, relativePath: string): Promise<void> {
		const adapter = this.plugin.app.vault.adapter as typeof this.plugin.app.vault.adapter & {
			appendBinary?: (normalizedPath: string, data: ArrayBuffer) => Promise<void>;
			remove: (normalizedPath: string) => Promise<void>;
			rename: (normalizedPath: string, normalizedNewPath: string) => Promise<void>;
		};
		const tempPath = normalizePath(`${relativePath}.part`);
		const startTime = Date.now();
		const fileName = relativePath.split("/").pop() ?? relativePath;

		if (await adapter.exists(tempPath)) {
			await adapter.remove(tempPath);
		}

		if (DEBUG_LOGS) console.log(`[cache] downloading ${fileName} from ${url}`);

		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(
				`[cache] failed to download ${fileName}: HTTP ${response.status} ${response.statusText}`
			);
		}

		const contentLength = Number(response.headers.get("content-length") ?? 0);
		if (DEBUG_LOGS) console.log(`[cache] ${fileName}: HTTP ${response.status}, content-length=${contentLength}`);

		const body = response.body;
		if (!body) {
			throw new Error(`[cache] ${fileName}: response has no body (streaming not supported)`);
		}

		if (typeof adapter.appendBinary !== "function") {
			throw new Error("Streaming cache downloads require Obsidian 1.12.3+");
		}

		const reader = body.getReader();
		let bytesWritten = 0;
		let chunkIndex = 0;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const buf = value.buffer.byteLength === value.byteLength
				? value.buffer
				: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);

			if (chunkIndex === 0) {
				await adapter.writeBinary(tempPath, buf);
			} else {
				await adapter.appendBinary(tempPath, buf);
			}

			bytesWritten += value.byteLength;
			chunkIndex += 1;
		}

		if (DEBUG_LOGS) {
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			console.log(
				`[cache] ${fileName}: wrote ${bytesWritten} bytes in ${chunkIndex} chunks (${elapsed}s)`
			);
		}

		if (bytesWritten === 0) {
			throw new Error(`[cache] ${fileName}: downloaded 0 bytes`);
		}

		if (contentLength > 0 && bytesWritten !== contentLength && DEBUG_LOGS) {
			console.warn(
				`[cache] ${fileName}: size mismatch - expected ${contentLength}, got ${bytesWritten}`
			);
		}

		if (await adapter.exists(relativePath)) {
			await adapter.remove(relativePath);
		}
		await adapter.rename(tempPath, relativePath);
	}

	private getHuggingFaceResolveUrl(repoId: string, file: string): string {
		return `${HUGGING_FACE_HOST}/${repoId}/resolve/${encodeURIComponent(HUGGING_FACE_REVISION)}/${file}`;
	}

	private getDownloadUrl(label: string): string | null {
		if (label.startsWith("runtime/")) {
			const fileName = label.slice("runtime/".length);
			const rtFile = RUNTIME_FILES.find((f) => f.fileName === fileName);
			return rtFile?.url ?? null;
		}

		// Model file: first two path segments are the HuggingFace repo ID,
		// remaining segments form the file path within the repo.
		const parts = label.split("/");
		if (parts.length < 3) return null;
		const repo = `${parts[0]}/${parts[1]}`;
		const filePath = parts.slice(2).join("/");
		return this.getHuggingFaceResolveUrl(repo, filePath);
	}

	private async ensureProbeFile(modelsCacheDir: string): Promise<void> {
		const probePath = normalizePath(`${modelsCacheDir}/${CACHE_ROOT_PROBE_FILE}`);
		if (await this.plugin.app.vault.adapter.exists(probePath)) {
			return;
		}
		await this.plugin.app.vault.adapter.write(probePath, "");
	}

	private async writeManifest(manifest: CacheManifest): Promise<void> {
		const path = normalizePath(`${this.getPluginCacheRoot()}/${CACHE_MANIFEST_FILE}`);
		await this.plugin.app.vault.adapter.write(path, JSON.stringify(manifest, null, 2));
	}

	private getDirectoryResourceBase(relativeFilePath: string, fileName: string): string {
		const resourceUrl = this.plugin.app.vault.adapter.getResourcePath(relativeFilePath);
		if (resourceUrl.endsWith(fileName)) {
			return resourceUrl.slice(0, resourceUrl.length - fileName.length);
		}
		const lastSlash = resourceUrl.lastIndexOf("/");
		return lastSlash >= 0 ? resourceUrl.slice(0, lastSlash + 1) : resourceUrl;
	}

	private getPluginCacheRoot(): string {
		return normalizePath(`${this.getPluginDir()}/cache`);
	}

	private getModelsCacheDir(): string {
		return normalizePath(`${this.getPluginCacheRoot()}/models`);
	}

	private getRuntimeCacheDir(): string {
		return normalizePath(
			`${this.getPluginCacheRoot()}/runtime/${this.getPlatformKey()}/transformers-${TRANSFORMERS_VERSION}-ort-${ORT_VERSION}`
		);
	}

	private getRuntimeFiles(): typeof RUNTIME_FILES {
		return Platform.isMobileApp ? MOBILE_RUNTIME_FILES : RUNTIME_FILES;
	}

	private getPluginDir(): string {
		return normalizePath(
			this.plugin.manifest.dir ??
			`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`
		);
	}

	private getPlatformKey(): string {
		const arch = this.getArchKey();

		if (Platform.isAndroidApp) {
			return `android-${arch}`;
		}
		if (Platform.isIosApp) {
			return `ios-${arch}`;
		}
		if (Platform.isWin) {
			return `windows-${arch}`;
		}
		if (Platform.isLinux) {
			return `linux-${arch}`;
		}
		if (Platform.isMacOS) {
			return `macos-${arch}`;
		}
		return `unknown-${arch}`;
	}

	private getArchKey(): string {
		if (typeof process !== "undefined" && process.arch) {
			return process.arch;
		}
		return "generic";
	}

	private dirname(path: string): string {
		const lastSlash = path.lastIndexOf("/");
		return lastSlash === -1 ? "" : path.slice(0, lastSlash);
	}

	private async ensureDir(path: string): Promise<void> {
		if (!path) return;

		const adapter = this.plugin.app.vault.adapter;
		const parts = normalizePath(path).split("/");
		let current = "";

		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (await adapter.exists(current)) {
				continue;
			}
			await adapter.mkdir(current);
		}
	}

}
