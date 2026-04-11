import { resolveEntireSettings } from "../entireSettings";
import { runCommandAsync } from "../runCommand";
import { GitCheckpointStore } from "./gitStore";
import { BaseCheckpointStore } from "./store";
import { METADATA_BRANCH_NAME, isCheckpointId } from "./util";
import type { CheckpointSummaryRecord, SessionContentRecord, SessionFilePaths } from "./types";

const CHECKPOINT_TOKEN_ENV_VAR = "ENTIRE_CHECKPOINT_TOKEN";
const ORIGIN_REMOTE_NAME = "origin";
const ORIGIN_REMOTE_METADATA_REVISION = `refs/remotes/${ORIGIN_REMOTE_NAME}/${METADATA_BRANCH_NAME}`;
const MIRROR_REF_PREFIX = "refs/entire/checkpoint-remotes";

/** Git transport protocols supported by the checkpoint-remote URL derivation logic. */
export type GitRemoteProtocol = "ssh" | "https";

/**
 * Resolved checkpoint-remote target derived from local Entire settings and the
 * repository's `origin` remote.
 *
 * Read-side support only needs enough information to derive the alternate
 * metadata repository URL and a stable local mirror ref to store fetched data.
 */
export interface CheckpointRemoteTarget {
	/** Source remote used to infer the checkpoint repository host and transport. */
	sourceRemoteName: string;
	/** Raw URL of the source remote used during derivation. */
	sourceRemoteUrl: string;
	/** Fully-qualified checkpoint metadata URL when one could be derived. */
	checkpointUrl?: string;
	/** Provider name from `strategy_options.checkpoint_remote`. */
	provider: string;
	/** `owner/repo` target from `strategy_options.checkpoint_remote`. */
	repo: string;
	/** Stable local git ref used to cache fetched remote checkpoint metadata. */
	mirrorRevision: string;
}

/** Options controlling how checkpoint metadata stores are resolved for a read operation. */
export interface ResolveCheckpointStoreOptions {
	/** Checkpoint IDs that must be available for the current read path. */
	requiredCheckpointIds?: string[];
}

/** Parsed host and repository details extracted from a git remote URL. */
export interface GitRemoteInfo {
	protocol: GitRemoteProtocol;
	host: string;
	owner: string;
	repo: string;
}

interface CheckpointStoreSource {
	name: string;
	store: BaseCheckpointStore;
}

/**
 * Checkpoint store that reads from multiple metadata sources in order.
 *
 * This allows the extension to prefer local metadata, fall back to cached
 * checkpoint-remote mirror refs, and then use `origin` remote-tracking refs
 * without forcing higher-level orchestration code to care where the data lives.
 */
export class ResolvedCheckpointStore extends BaseCheckpointStore {
	constructor(private readonly sources: ReadonlyArray<CheckpointStoreSource>) {
		super();
	}

	async listCheckpointIds(): Promise<string[]> {
		const allIds = await Promise.all(this.sources.map(async ({ store }) => store.listCheckpointIds()));
		return [...new Set(allIds.flat())].sort((left, right) => left.localeCompare(right));
	}

	async getCheckpointSummary(checkpointId: string): Promise<CheckpointSummaryRecord | null> {
		for (const { store } of this.sources) {
			const summary = await store.getCheckpointSummary(checkpointId);
			if (summary !== null) {
				return summary;
			}
		}

		return null;
	}

	async getSessionContent(
		checkpointId: string,
		sessionIndex: number,
		sessionPaths?: SessionFilePaths,
	): Promise<SessionContentRecord> {
		for (const { store } of this.sources) {
			if (!sessionPaths) {
				const summary = await store.getCheckpointSummary(checkpointId);
				if (summary === null) {
					continue;
				}
			}

			try {
				return await store.getSessionContent(checkpointId, sessionIndex, sessionPaths);
			} catch {
				continue;
			}
		}

		throw new Error(`Session ${sessionIndex} not found in checkpoint ${checkpointId}`);
	}
}

/**
 * Resolves the metadata store used for checkpoint reads in a repository.
 *
 * The store always includes local metadata and `origin` remote-tracking
 * metadata. When `checkpoint_remote` is configured, it also includes a local
 * mirror ref and may fetch that mirror on demand if required checkpoint IDs
 * are missing from the currently cached sources.
 *
 * @param repoPath Repository root used to inspect settings and git refs.
 * @param options Read requirements for the current operation.
 * @returns A composite checkpoint store ordered by the preferred read sources.
 */
export async function resolveCheckpointStore(
	repoPath: string,
	options: ResolveCheckpointStoreOptions = {},
): Promise<BaseCheckpointStore> {
	const requiredCheckpointIds = normalizeCheckpointIds(options.requiredCheckpointIds ?? []);
	const localStore = new GitCheckpointStore(repoPath);
	const originRemoteStore = new GitCheckpointStore(repoPath, ORIGIN_REMOTE_METADATA_REVISION);
	const target = await resolveCheckpointRemoteTarget(repoPath);
	const mirrorStore = target ? new GitCheckpointStore(repoPath, target.mirrorRevision) : null;
	const existingSources = [
		localStore,
		...(mirrorStore ? [mirrorStore] : []),
		originRemoteStore,
	];

	let fetchedMirror = false;
	if (
		target?.checkpointUrl
		&& requiredCheckpointIds.length > 0
		&& !(await hasCheckpointCoverage(existingSources, requiredCheckpointIds))
	) {
		try {
			await fetchCheckpointMirror(repoPath, target);
			fetchedMirror = true;
		} catch {
			// Remote checkpoint fetch failures must not break read-side browsing.
		}
	}

	const orderedSources: CheckpointStoreSource[] = fetchedMirror && mirrorStore
		? [
			{ name: "checkpoint-remote-mirror", store: mirrorStore },
			{ name: "local", store: localStore },
			{ name: "origin-remote-tracking", store: originRemoteStore },
		]
		: [
			{ name: "local", store: localStore },
			...(mirrorStore ? [{ name: "checkpoint-remote-mirror", store: mirrorStore }] : []),
			{ name: "origin-remote-tracking", store: originRemoteStore },
		];

	return new ResolvedCheckpointStore(orderedSources);
}

/**
 * Resolves the read-side checkpoint-remote target configured for a repository.
 *
 * This intentionally follows the CLI's read path and derives the alternate
 * checkpoint repository from `origin`, not from push-remote or fork logic.
 *
 * @param repoPath Repository root used to resolve Entire settings and git remotes.
 * @returns The derived checkpoint target, or `null` when checkpoint-remote is not configured.
 */
export async function resolveCheckpointRemoteTarget(repoPath: string): Promise<CheckpointRemoteTarget | null> {
	const settings = await resolveEntireSettings(repoPath);
	const config = settings.strategy_options.checkpoint_remote;
	if (!config?.provider || !config.repo || !config.repo.includes("/")) {
		return null;
	}

	const mirrorRevision = buildCheckpointMirrorRevision(config.provider, config.repo);
	const sourceRemoteUrl = await getRemoteURL(repoPath, ORIGIN_REMOTE_NAME) ?? "";
	if (!sourceRemoteUrl) {
		return {
			sourceRemoteName: ORIGIN_REMOTE_NAME,
			sourceRemoteUrl,
			provider: config.provider,
			repo: config.repo,
			mirrorRevision,
		};
	}

	try {
		const sourceInfo = parseGitRemoteURL(sourceRemoteUrl);
		return {
			sourceRemoteName: ORIGIN_REMOTE_NAME,
			sourceRemoteUrl,
			checkpointUrl: deriveCheckpointURLFromInfo(sourceInfo, config.repo),
			provider: config.provider,
			repo: config.repo,
			mirrorRevision,
		};
	} catch {
		return {
			sourceRemoteName: ORIGIN_REMOTE_NAME,
			sourceRemoteUrl,
			provider: config.provider,
			repo: config.repo,
			mirrorRevision,
		};
	}
}

/**
 * Builds the stable local mirror ref used to cache checkpoint-remote metadata.
 *
 * Provider and repository path segments are sanitized so the resulting ref can
 * be written safely into the local git namespace.
 *
 * @param provider Checkpoint-remote provider from Entire settings.
 * @param repo `owner/repo` target from Entire settings.
 * @returns A namespaced git ref under `refs/entire/checkpoint-remotes/...`.
 */
export function buildCheckpointMirrorRevision(provider: string, repo: string): string {
	const segments = [
		provider,
		...repo.split("/"),
	]
		.map(sanitizeRefSegment)
		.filter((segment) => segment.length > 0);

	return `${MIRROR_REF_PREFIX}/${segments.join("/")}`;
}

/**
 * Parses a git remote URL into transport, host, and repository components.
 *
 * Supported inputs include SCP-style SSH URLs, `ssh://` URLs, and `https://`
 * URLs. The helper throws for unsupported or malformed inputs.
 *
 * @param rawURL Remote URL to parse.
 * @returns Parsed remote connection details.
 */
export function parseGitRemoteURL(rawURL: string): GitRemoteInfo {
	const normalizedUrl = rawURL.trim();
	if (!normalizedUrl) {
		throw new Error("remote URL is empty");
	}

	if (normalizedUrl.includes(":") && !normalizedUrl.includes("://")) {
		const parts = normalizedUrl.split(":", 2);
		if (parts.length !== 2) {
			throw new Error(`invalid SSH URL: ${redactURL(normalizedUrl)}`);
		}

		let host = parts[0] ?? "";
		if (host.includes("@")) {
			host = host.slice(host.indexOf("@") + 1);
		}

		const [owner, repo] = splitOwnerRepo(parts[1] ?? "");
		return { protocol: "ssh", host, owner, repo };
	}

	let url: URL;
	try {
		url = new URL(normalizedUrl);
	} catch {
		throw new Error(`invalid URL: ${redactURL(normalizedUrl)}`);
	}

	if (url.protocol !== "https:" && url.protocol !== "ssh:") {
		throw new Error(`unsupported protocol in URL: ${redactURL(normalizedUrl)}`);
	}

	const [owner, repo] = splitOwnerRepo(url.pathname.replace(/^\/+/, ""));
	return {
		protocol: url.protocol === "https:" ? "https" : "ssh",
		host: url.hostname,
		owner,
		repo,
	};
}

/**
 * Derives the checkpoint repository URL using the source remote's transport.
 *
 * Read-side checkpoint-remote fetches preserve the source remote's SSH versus
 * HTTPS choice so authentication expectations stay aligned with the host repo.
 *
 * @param info Parsed source remote information.
 * @param repo Target checkpoint repository in `owner/repo` form.
 * @returns The derived checkpoint metadata repository URL.
 */
export function deriveCheckpointURLFromInfo(info: GitRemoteInfo, repo: string): string {
	switch (info.protocol) {
		case "ssh":
			return `git@${info.host}:${repo}.git`;
		case "https":
			return `https://${info.host}/${repo}.git`;
		default:
			throw new Error(`unsupported protocol ${String((info as { protocol?: string }).protocol ?? "")}`);
	}
}

/**
 * Builds git environment overrides for checkpoint-remote fetches.
 *
 * All fetches disable terminal prompting. HTTPS targets additionally receive
 * the CLI-compatible `http.extraHeader` auth override when
 * `ENTIRE_CHECKPOINT_TOKEN` is present and valid.
 *
 * @param target Remote URL that will be fetched.
 * @param baseEnv Base environment to clone before applying overrides.
 * @returns Environment variables suitable for a non-interactive metadata fetch.
 */
export function buildCheckpointGitEnv(target: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	let env: NodeJS.ProcessEnv = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
	const token = (baseEnv[CHECKPOINT_TOKEN_ENV_VAR] ?? "").trim();
	if (!token || !isValidToken(token)) {
		return env;
	}

	try {
		const info = parseGitRemoteURL(target);
		if (info.protocol !== "https") {
			return env;
		}
	} catch {
		return env;
	}

	env = appendCheckpointTokenEnv(env, token);
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

async function fetchCheckpointMirror(repoPath: string, target: CheckpointRemoteTarget): Promise<void> {
	if (!target.checkpointUrl) {
		throw new Error("checkpoint URL is not configured");
	}

	const refSpec = `+refs/heads/${METADATA_BRANCH_NAME}:${target.mirrorRevision}`;
	const result = await runCommandAsync(
		"git",
		["fetch", "--no-tags", target.checkpointUrl, refSpec],
		repoPath,
		buildCheckpointGitEnv(target.checkpointUrl),
	);
	if (result.exitCode === 0) {
		return;
	}

	const redactedUrl = redactURL(target.checkpointUrl);
	const details = redactText(result.stderr.trim() || result.stdout.trim(), target.checkpointUrl);
	if (details) {
		throw new Error(`fetch from ${redactedUrl} failed: ${details}`);
	}
	throw new Error(`fetch from ${redactedUrl} failed with exit code ${result.exitCode}`);
}

async function getRemoteURL(repoPath: string, remoteName: string): Promise<string | null> {
	const result = await runCommandAsync("git", ["remote", "get-url", remoteName], repoPath);
	if (result.exitCode !== 0) {
		return null;
	}

	const remoteUrl = result.stdout.trim();
	return remoteUrl.length > 0 ? remoteUrl : null;
}

async function hasCheckpointCoverage(stores: BaseCheckpointStore[], checkpointIds: string[]): Promise<boolean> {
	for (const checkpointId of checkpointIds) {
		let found = false;
		for (const store of stores) {
			if (await store.getCheckpointSummary(checkpointId) !== null) {
				found = true;
				break;
			}
		}

		if (!found) {
			return false;
		}
	}

	return true;
}

function normalizeCheckpointIds(checkpointIds: string[]): string[] {
	return [...new Set(
		checkpointIds
			.map((checkpointId) => checkpointId.trim().toLowerCase())
			.filter(isCheckpointId),
	)].sort((left, right) => left.localeCompare(right));
}

function splitOwnerRepo(path: string): [string, string] {
	const normalizedPath = path.replace(/\.git$/, "");
	const parts = normalizedPath.split("/", 2);
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`cannot parse owner/repo from path: ${normalizedPath}`);
	}

	return [parts[0], parts[1]];
}

function sanitizeRefSegment(segment: string): string {
	const sanitized = segment
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^\.+/, "")
		.replace(/\.+$/, "");

	return sanitized.length > 0 ? sanitized : "unknown";
}

function isValidToken(token: string): boolean {
	for (const byte of Buffer.from(token, "utf8")) {
		if (byte < 0x20 || byte === 0x7f) {
			return false;
		}
	}

	return true;
}

function appendCheckpointTokenEnv(baseEnv: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
	const env = { ...baseEnv };
	for (const key of Object.keys(env)) {
		if (key === "GIT_CONFIG_COUNT" || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) {
			delete env[key];
		}
	}

	const encoded = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
	env.GIT_CONFIG_COUNT = "1";
	env.GIT_CONFIG_KEY_0 = "http.extraHeader";
	env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${encoded}`;
	return env;
}

function redactURL(rawURL: string): string {
	try {
		const url = new URL(rawURL);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		if (rawURL.includes("@")) {
			const hostPart = rawURL.slice(rawURL.indexOf("@") + 1);
			const colonIndex = hostPart.indexOf(":");
			if (colonIndex >= 0) {
				return `${hostPart.slice(0, colonIndex)}:***`;
			}
		}

		return "<unparseable>";
	}
}

function redactText(text: string, rawURL: string): string {
	if (!text) {
		return text;
	}

	return text.replaceAll(rawURL, redactURL(rawURL));
}
