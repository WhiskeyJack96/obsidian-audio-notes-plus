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

const MOONSHINE_ROOT_FILES = [
	"config.json",
	"generation_config.json",
	"preprocessor_config.json",
	"special_tokens_map.json",
	"tokenizer.json",
	"tokenizer_config.json",
];

const MOONSHINE_ONNX_FILES = [
	"onnx/encoder_model.onnx",
	"onnx/decoder_model_merged_q4.onnx",
	"onnx/decoder_model_merged_quantized.onnx",
];

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
			...MOONSHINE_ONNX_FILES,
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

		return {
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
		for (const file of RUNTIME_FILES) {
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

	private async downloadBinary(url: string, relativePath: string): Promise<void> {
		await this.ensureDir(this.dirname(relativePath));

		const response = await requestUrl({
			url,
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(`Failed to download ${url} (${response.status})`);
		}

		await this.plugin.app.vault.adapter.writeBinary(relativePath, response.arrayBuffer);
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
