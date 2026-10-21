/**
 * CLIProxyAPI versions and official release downloads (Chat Marks). Only the community
 * repository's GitHub releases are trusted; every download is bounded, every redirect stays on
 * GitHub's release hosts, and an archive is only used after its SHA-256 matches checksums.txt.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CLIPROXY_REPOSITORY, CLIPROXY_TAG, CLIPROXY_VERSION } from '../../shared/cliproxy.js';

const exec = promisify(execFile);
export const CLIPROXY_BINARY = '/usr/local/bin/cli-proxy-api';
const LATEST_URL = `https://api.github.com/repos/${CLIPROXY_REPOSITORY}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${CLIPROXY_REPOSITORY}/releases/download/`;
/** github.com answers a release download with a redirect to one of these asset hosts. */
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const LATEST_TTL_MS = 60 * 60_000;
const API_LIMIT = 1024 * 1024;
export const ARCHIVE_LIMIT = 96 * 1024 * 1024;
export const CHECKSUMS_LIMIT = 64 * 1024;
const MAX_REDIRECTS = 5;

export interface CliProxyRelease {
  version: string;
  assets: Array<{ name: string; url: string; size: number }>;
}

/** "CLIProxyAPI Version: v8.0.13-14-g8ef43e4d-dirty, Commit: …" → "8.0.13-14-g8ef43e4d-dirty". */
export function parseVersionOutput(output: string): string | null {
  const match = /CLIProxyAPI Version:\s*v?([0-9A-Za-z][0-9A-Za-z.+-]{0,63})/.exec(output);
  return match ? match[1]! : null;
}

/** Official release builds report exactly the tag's x.y.z; local builds add a describe suffix. */
export function isOfficialVersion(version: string | null): boolean {
  return !!version && CLIPROXY_VERSION.test(version);
}

function core(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** An update exists when the latest release is newer than the installed build's base version. */
export function isUpdateAvailable(installed: string | null, latest: string | null): boolean {
  const from = installed ? core(installed) : null, to = latest ? core(latest) : null;
  if (!from || !to) return false;
  for (let index = 0; index < 3; index++) if (to[index] !== from[index]) return to[index]! > from[index]!;
  return false;
}

/** The last probe, keyed by the binary's path, mtime and size: a refresh runs it only after a change. */
let probed: { key: string; version: string | null } | null = null;

/**
 * The installed binary prints its version before reading flags. `-h` with an absent config path
 * exits right after the usage text without touching the service's config, keys or network.
 */
export async function installedVersion(binary = CLIPROXY_BINARY): Promise<string | null> {
  const info = await stat(binary).catch(() => null);
  if (!info?.isFile()) return null;
  const key = `${binary}\n${info.mtimeMs}\n${info.size}`;
  if (probed?.key === key) return probed.version;
  let version: string | null;
  try {
    const { stdout, stderr } = await exec(binary, ['-config', '/nonexistent/marks-version-probe.yaml', '-h'], {
      timeout: 5_000, maxBuffer: 256 * 1024, cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, killSignal: 'SIGKILL'
    });
    version = parseVersionOutput(`${stdout}\n${stderr}`);
  } catch (error) {
    // Flag usage can exit non-zero on some builds; the version line was still printed first.
    const output = error as { stdout?: unknown; stderr?: unknown };
    version = parseVersionOutput(`${typeof output.stdout === 'string' ? output.stdout : ''}\n${typeof output.stderr === 'string' ? output.stderr : ''}`);
  }
  probed = { key, version };
  return version;
}

/** Reads at most `limit` bytes; a longer body is refused rather than truncated. */
export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit) { await response.body?.cancel(); throw new Error('download_failed'); }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('download_failed');
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts, size);
}

let latest: { at: number; release: CliProxyRelease } | null = null;

/** The latest official, non-draft, non-prerelease release; cached for an hour. */
export async function latestRelease(options: { refresh?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<CliProxyRelease> {
  const now = options.now ?? Date.now();
  if (latest && !options.refresh && now - latest.at < LATEST_TTL_MS) return latest.release;
  const response = await (options.fetchImpl ?? fetch)(LATEST_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Chat-Marks', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('release_unavailable'); }
  const body = JSON.parse((await readBounded(response, API_LIMIT)).toString('utf8')) as {
    tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown;
  };
  const tag = typeof body.tag_name === 'string' ? CLIPROXY_TAG.exec(body.tag_name) : null;
  if (!tag || body.draft === true || body.prerelease === true || !Array.isArray(body.assets)) throw new Error('release_unavailable');
  const assets = body.assets.flatMap(asset => {
    const { name, browser_download_url: url, size } = (asset ?? {}) as Record<string, unknown>;
    return typeof name === 'string' && typeof url === 'string' && typeof size === 'number' ? [{ name, url, size }] : [];
  });
  const release = { version: tag[1]!, assets };
  latest = { at: now, release };
  return release;
}

export function resetReleaseCacheForTests(): void { latest = null; probed = null; }

const ARCH: Partial<Record<string, string>> = { x64: 'amd64', arm64: 'aarch64' };

/** Linux x64/arm64 only, and the default (plugin-capable) build, never the `_no-plugin` one. */
export function releaseAssets(release: CliProxyRelease, platform: string = process.platform, arch: string = process.arch):
  { archive: CliProxyRelease['assets'][number]; checksums: CliProxyRelease['assets'][number] } | null {
  const assetArch = ARCH[arch];
  if (platform !== 'linux' || !assetArch) return null;
  const archiveName = `CLIProxyAPI_${release.version}_linux_${assetArch}.tar.gz`;
  const archive = release.assets.find(asset => asset.name === archiveName);
  const checksums = release.assets.find(asset => asset.name === 'checksums.txt');
  if (!archive || !checksums) return null;
  for (const asset of [archive, checksums]) {
    if (asset.url !== `${DOWNLOAD_PREFIX}v${release.version}/${asset.name}`) return null;
  }
  return { archive, checksums };
}

export function installablePlatform(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === 'linux' && !!ARCH[arch];
}

/** Only https on GitHub's release hosts; never credentials or other ports. */
export function allowedDownloadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && DOWNLOAD_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

/** Follows at most five redirects, each checked against the host allowlist, and bounds the body. */
export async function downloadAsset(url: string, limit: number, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (!url.startsWith(DOWNLOAD_PREFIX)) throw new Error('download_failed');
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedDownloadUrl(current)) throw new Error('download_failed');
    const response = await fetchImpl(current, { redirect: 'manual', headers: { 'User-Agent': 'Chat-Marks' }, signal: AbortSignal.timeout(180_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('download_failed');
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('download_failed'); }
    return readBounded(response, limit);
  }
  throw new Error('download_failed');
}

/** `sha256sum` output: "<64 hex>  <name>" per line. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

export function verifyChecksum(data: Buffer, name: string, checksums: string): void {
  const expected = parseChecksums(checksums).get(name);
  const actual = createHash('sha256').update(data).digest('hex');
  if (!expected || expected !== actual) throw new Error('checksum_mismatch');
}
