import { Platform, normalizePath, requestUrl } from "obsidian";
import { MODEL_IDS } from "./types";
import type VoiceNotesPlugin from "./main";
import type { LocalAssetConfig, VoiceNotesSettings } from "./types";

const CACHE_SCHEMA_VERSION = 1;
const TRANSFORMERS_VERSION = "3.7.1";
const ORT_VERSION = "1.22.0-dev.20250409-89f8206ba4";
const HUGGING_FACE_HOST = "https://huggingface.co";
const HUGGING_FACE_REVISION = "main";
const CACHE_ROOT_PROBE_FILE = ".cache-root";
const CACHE_MANIFEST_FILE = "cache-manifest.json";
const MOBILE_CHUNK_SIZE_BYTES = 2 * 1024 * 1024;
const DESKTOP_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

const MOONSHINE_ROOT_FILES = [
	"config.json",
	"generation_config.json",
	"preprocessor_config.json",
	"special_tokens_map.json",
	"tokenizer.json",
	"tokenizer_config.json",
];

const MOONSHINE_ENCODER_FILE = "onnx/encoder_model.onnx";
const MOONSHINE_DECODER_Q4_FILE = "onnx/decoder_model_merged_q4.onnx";
const MOONSHINE_DECODER_Q8_FILE = "onnx/decoder_model_merged_quantized.onnx";

const SILERO_FILES = [
	"onnx/model.onnx",
];

const RUNTIME_FILES = [
	{
		fileName: "ort-wasm-simd-threaded.wasm",
		url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.wasm`,
	},
	{
		fileName: "ort-wasm-simd-threaded.jsep.wasm",
		url: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/ort-wasm-simd-threaded.jsep.wasm`,
	},
	{
		fileName: "ort-wasm-simd-threaded.mjs",
		url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.mjs`,
	},
	{
		fileName: "ort-wasm-simd-threaded.jsep.mjs",
		url: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/ort-wasm-simd-threaded.jsep.mjs`,
	},
] as const;

const MOBILE_RUNTIME_FILES = RUNTIME_FILES.filter((file) => !file.fileName.includes(".jsep."));

interface CacheManifest {
	schemaVersion: number;
	transformersVersion: string;
	platformKey: string;
	modelId: string;
	updatedAt: string;
}

export class AssetCacheManager {
	constructor(private plugin: VoiceNotesPlugin) {}

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
			this.shouldCacheQ4Decoder() ? MOONSHINE_DECODER_Q4_FILE : MOONSHINE_DECODER_Q8_FILE,
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

			onProgress?.(`Downloading ${repoId}/${file}...`);
			await this.downloadBinary(
				this.getHuggingFaceResolveUrl(repoId, file),
				relativePath
			);
			onProgress?.(`Cached ${repoId}/${file}`);
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

			onProgress?.(`Downloading runtime ${file.fileName}...`);
			await this.downloadBinary(
				file.url,
				relativePath
			);
			onProgress?.(`Cached runtime ${file.fileName}`);
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
		await this.downloadBinaryChunked(url, relativePath);
	}

	private async downloadBinaryChunked(url: string, relativePath: string): Promise<void> {
		const adapter = this.plugin.app.vault.adapter as typeof this.plugin.app.vault.adapter & {
			appendBinary?: (normalizedPath: string, data: ArrayBuffer) => Promise<void>;
			remove: (normalizedPath: string) => Promise<void>;
			rename: (normalizedPath: string, normalizedNewPath: string) => Promise<void>;
		};
		const tempPath = normalizePath(`${relativePath}.part`);
		const chunkSize = this.getDownloadChunkSize();
		let start = 0;
		let totalBytes: number | null = null;
		let chunkIndex = 0;

		if (await adapter.exists(tempPath)) {
			await adapter.remove(tempPath);
		}

		while (totalBytes === null || start < totalBytes) {
			const end = totalBytes === null
				? start + chunkSize - 1
				: Math.min(start + chunkSize - 1, totalBytes - 1);
			const response = await requestUrl({
				url,
				headers: {
					Range: `bytes=${start}-${end}`,
				},
				throw: false,
			});

			if (response.status !== 206 && response.status !== 200) {
				throw new Error(`Failed to download ${url} (${response.status})`);
			}

			if (totalBytes === null) {
				totalBytes = this.getTotalBytes(response.headers, response.arrayBuffer.byteLength);
			}

			if (chunkIndex === 0) {
				await adapter.writeBinary(tempPath, response.arrayBuffer);
			} else if (typeof adapter.appendBinary === "function") {
				await adapter.appendBinary(tempPath, response.arrayBuffer);
			} else {
				throw new Error("Chunked cache downloads require Obsidian 1.12.3+");
			}

			if (response.status === 200) {
				break;
			}

			start += response.arrayBuffer.byteLength;
			chunkIndex += 1;
		}

		if (await adapter.exists(relativePath)) {
			await adapter.remove(relativePath);
		}
		await adapter.rename(tempPath, relativePath);
	}

	private getHuggingFaceResolveUrl(repoId: string, file: string): string {
		return `${HUGGING_FACE_HOST}/${repoId}/resolve/${encodeURIComponent(HUGGING_FACE_REVISION)}/${file}`;
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

	private shouldCacheQ4Decoder(): boolean {
		return !Platform.isMobileApp;
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

	private getDownloadChunkSize(): number {
		return Platform.isMobileApp ? MOBILE_CHUNK_SIZE_BYTES : DESKTOP_CHUNK_SIZE_BYTES;
	}

	private getTotalBytes(headers: Record<string, string>, fallback: number): number {
		const contentRange = this.getHeader(headers, "content-range");
		if (contentRange) {
			const totalPart = contentRange.split("/")[1];
			const parsed = Number.parseInt(totalPart, 10);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}

		const contentLength = this.getHeader(headers, "content-length");
		if (contentLength) {
			const parsed = Number.parseInt(contentLength, 10);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}

		return fallback;
	}

	private getHeader(headers: Record<string, string>, name: string): string | null {
		const expected = name.toLowerCase();
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === expected) {
				return value;
			}
		}
		return null;
	}
}
