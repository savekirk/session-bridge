import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { isJsonObject, readJsonFile } from "./checkpoints/util";

/** Log verbosity levels supported by the Entire CLI. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Remote repository target for pushing checkpoint branches separately from the main repository. */
export interface CheckpointRemote {
	provider: string;
	repo: string;
}

/** Controls how Entire captures and stores session data. */
export interface StrategyOptions {
	/** Automatically push `entire/checkpoints/v1` branch on `git push`. Defaults to `true`. */
	push_sessions?: boolean;
	/** Push checkpoint branches to a separate repository instead of the main code repository. */
	checkpoint_remote?: CheckpointRemote | null;
	/** Auto-generate AI summaries at commit time. Defaults to `false`. */
	"summarize.enabled"?: boolean;
}

/**
 * Resolved Entire settings representing the merged result of global,
 * project, and local configuration layers with environment variable overrides applied.
 *
 * Configuration precedence (highest to lowest):
 * 1. Environment variables (`ENTIRE_ENABLED`, `ENTIRE_LOG_LEVEL`, `ENTIRE_TELEMETRY`)
 * 2. Local settings (`.entire/settings.local.json`)
 * 3. Project settings (`.entire/settings.json`)
 * 4. Global settings (`~/.config/entire/settings.json`)
 * 5. Defaults
 */
export interface EntireSettings {
	/** Whether Entire is active in this repository. Defaults to `true`. */
	enabled: boolean;
	/** Enable discovery of external agent plugins from `$PATH`. Defaults to `false`. */
	external_agents: boolean;
	/** Log verbosity level. Defaults to `"info"`. */
	log_level: LogLevel;
	/** Send anonymous usage analytics. `null` = not asked yet, `true` = opted in, `false` = opted out. */
	telemetry: boolean | null;
	/** Additional configuration for session capture and storage. */
	strategy_options: StrategyOptions;
	/** Embed the full path to the `entire` binary in Git hooks. Defaults to `false`. */
	absolute_git_hook_path: boolean;
	/** Absolute paths to the settings files that contributed to this resolved configuration. */
	settingsPaths: string[];
}

/** A single raw settings file parsed from disk. All fields are optional since any layer may be partial. */
type PartialSettings = Partial<Omit<EntireSettings, "strategy_options" | "settingsPaths">> & {
	strategy_options?: Partial<StrategyOptions>;
};

/** Default settings used as the lowest-priority base layer. */
const DEFAULT_SETTINGS: EntireSettings = {
	enabled: true,
	external_agents: false,
	log_level: "info",
	telemetry: null,
	strategy_options: {},
	absolute_git_hook_path: false,
	settingsPaths: [],
};

/**
 * Returns the absolute path to the global Entire settings file.
 *
 * @returns Absolute path to `~/.config/entire/settings.json`.
 */
export function getGlobalSettingsPath(): string {
	return path.join(os.homedir(), ".config", "entire", "settings.json");
}

/**
 * Returns the absolute path to the project Entire settings directory.
 *
 * @param cwd - Optional working directory. Defaults to `process.cwd()`.
 * @returns Absolute path to the `.entire` directory within the project root.
 */
export function getEntireDir(cwd?: string): string {
	const root = cwd ?? process.cwd();
	return path.resolve(root, ".entire");
}

/**
 * Returns absolute paths to all settings files found in the project's `.entire` directory.
 * Settings files match the pattern `.entire/settings*.json`.
 *
 * @param cwd - Optional working directory. Defaults to `process.cwd()`.
 * @returns Absolute paths to each discovered settings file.
 */
export async function getEntireSettingsPaths(cwd?: string): Promise<string[]> {
	const entireDir = getEntireDir(cwd);

	try {
		const files = await fs.promises.readdir(entireDir);
		return files
			.filter((file) => file.startsWith("settings") && file.endsWith(".json"))
			.map((file) => path.join(entireDir, file));
	} catch {
		return [];
	}
}

/**
 * Reads and parses a single JSON settings file from disk.
 * Returns `undefined` when the file does not exist or cannot be parsed.
 *
 * @param filePath - Absolute path to the settings JSON file.
 * @returns Parsed partial settings, or `undefined` when unavailable.
 */
async function readSettingsFile(filePath: string): Promise<PartialSettings | undefined> {
	try {
		const parsed = await readJsonFile(filePath);
		return parsed as PartialSettings;
	} catch (error) {
		// Malformed JSON or other read error -- treat as missing
		return undefined;
	}
}

/**
 * Merges a higher-priority partial settings layer onto a base settings object.
 * Only defined keys in the overlay replace values in the base. `strategy_options`
 * is shallow-merged so individual strategy keys can be overridden independently.
 *
 * @param base - The accumulated settings so far.
 * @param overlay - A partial settings layer to apply on top.
 * @returns A new settings object with the overlay applied.
 */
function mergeSettings(base: EntireSettings, overlay: PartialSettings): EntireSettings {
	const merged: EntireSettings = { ...base };

	if (overlay.enabled !== undefined) {
		merged.enabled = overlay.enabled;
	}
	if (overlay.external_agents !== undefined) {
		merged.external_agents = overlay.external_agents;
	}
	if (overlay.log_level !== undefined) {
		merged.log_level = overlay.log_level;
	}
	if (overlay.telemetry !== undefined) {
		merged.telemetry = overlay.telemetry;
	}
	if (overlay.absolute_git_hook_path !== undefined) {
		merged.absolute_git_hook_path = overlay.absolute_git_hook_path;
	}
	if (overlay.strategy_options !== undefined) {
		merged.strategy_options = { ...base.strategy_options, ...overlay.strategy_options };
	}

	return merged;
}

/**
 * Applies environment variable overrides to a resolved settings object.
 * Supported variables: `ENTIRE_ENABLED`, `ENTIRE_LOG_LEVEL`, `ENTIRE_TELEMETRY`.
 *
 * @param settings - The merged settings before environment overrides.
 * @returns A new settings object with environment overrides applied.
 */
function applyEnvironmentOverrides(settings: EntireSettings): EntireSettings {
	const result = { ...settings };

	const envEnabled = process.env["ENTIRE_ENABLED"];
	if (envEnabled !== undefined) {
		result.enabled = envEnabled.toLowerCase() !== "false";
	}

	const envLogLevel = process.env["ENTIRE_LOG_LEVEL"];
	if (envLogLevel !== undefined && isLogLevel(envLogLevel)) {
		result.log_level = envLogLevel;
	}

	const envTelemetry = process.env["ENTIRE_TELEMETRY"];
	if (envTelemetry !== undefined) {
		result.telemetry = envTelemetry.toLowerCase() !== "false";
	}

	return result;
}

/**
 * Type guard for valid log level values.
 *
 * @param value - String to test.
 * @returns `true` when the value is a valid `LogLevel`.
 */
function isLogLevel(value: string): value is LogLevel {
	return value === "debug" || value === "info" || value === "warn" || value === "error";
}

/**
 * Resolves the effective Entire settings by reading and merging all configuration layers.
 *
 * Reads settings from (lowest to highest priority):
 * 1. Built-in defaults
 * 2. Global settings (`~/.config/entire/settings.json`)
 * 3. Project settings (`.entire/settings.json`)
 * 4. Local settings (`.entire/settings.local.json`)
 * 5. Environment variable overrides
 *
 * @param cwd - Optional working directory for locating project settings. Defaults to `process.cwd()`.
 * @returns The fully resolved settings object.
 */
export async function resolveEntireSettings(cwd?: string): Promise<EntireSettings> {
	const entireDir = getEntireDir(cwd);

	const globalPath = getGlobalSettingsPath();
	const projectPath = path.join(entireDir, "settings.json");
	const localPath = path.join(entireDir, "settings.local.json");

	// Read all configuration layers in parallel
	const [globalLayer, projectLayer, localLayer] = await Promise.all([
		readSettingsFile(globalPath),
		readSettingsFile(projectPath),
		readSettingsFile(localPath),
	]);

	// Track which files contributed to the resolved configuration
	const settingsPaths: string[] = [];
	if (globalLayer) {
		settingsPaths.push(globalPath);
	}
	if (projectLayer) {
		settingsPaths.push(projectPath);
	}
	if (localLayer) {
		settingsPaths.push(localPath);
	}

	// Merge layers from lowest to highest priority
	let settings = { ...DEFAULT_SETTINGS };

	if (globalLayer) {
		settings = mergeSettings(settings, globalLayer);
	}
	if (projectLayer) {
		settings = mergeSettings(settings, projectLayer);
	}
	if (localLayer) {
		settings = mergeSettings(settings, localLayer);
	}

	// Environment variables have the highest priority
	settings = applyEnvironmentOverrides(settings);
	settings.settingsPaths = settingsPaths;

	return settings;
}
