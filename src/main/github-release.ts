/**
 * Chat Marks: official GitHub release downloads, shared by every module that installs an
 * upstream binary from GitHub (CLIProxyAPI, ZeroClaw; OpenCode 2.x comes from npm, npm-release.ts). Only one repository's releases are trusted
 * per caller; every download is bounded, every redirect stays on GitHub's release hosts, and an
 * archive is only used after its SHA-256 matches what the release publishes.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/** github.com answers a release download with a redirect to one of these asset hosts. */
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const API_LIMIT = 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface GitHubAsset {
  name: string;
  url: string;
  size: number;
  /** The API's own `digest` (`sha256:<hex>`), lower-case hex; null when the release has none. */
  sha256: string | null;
}

export interface GitHubRelease {
  version: string;
  assets: GitHubAsset[];
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

/**
 * The latest non-draft, non-prerelease release of `repository` whose tag matches `tag` (group 1
 * is the version). The caller caches it.
 */
export async function fetchLatestRelease(repository: string, tag: RegExp, fetchImpl: typeof fetch = fetch): Promise<GitHubRelease> {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Chat-Marks', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('release_unavailable'); }
  let body: { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  try { body = JSON.parse((await readBounded(response, API_LIMIT)).toString('utf8')) as typeof body; }
  catch { throw new Error('release_unavailable'); }
  const match = typeof body.tag_name === 'string' ? tag.exec(body.tag_name) : null;
  if (!match || body.draft === true || body.prerelease === true || !Array.isArray(body.assets)) throw new Error('release_unavailable');
  const assets = body.assets.flatMap((asset): GitHubAsset[] => {
    const { name, browser_download_url: url, size, digest } = (asset ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || typeof url !== 'string' || typeof size !== 'number') return [];
    const sha = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(digest)?.[1]?.toLowerCase() ?? null : null;
    return [{ name, url, size, sha256: sha }];
  });
  return { version: match[1]!, assets };
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

/**
 * Downloads one asset of the trusted repository (`url` must start with `prefix`, the repository's
 * `…/releases/download/`). Follows at most five redirects, each checked against the host
 * allowlist, and bounds the body.
 */
export async function downloadReleaseAsset(url: string, prefix: string, limit: number, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (!prefix.startsWith('https://github.com/') || !prefix.endsWith('/releases/download/') || !url.startsWith(prefix)) throw new Error('download_failed');
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedDownloadUrl(current)) throw new Error('download_failed');
    const response = await fetchImpl(current, { redirect: 'manual', headers: { 'User-Agent': 'Chat-Marks' }, signal: AbortSignal.timeout(300_000) });
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

export const sha256Hex = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Throws `checksum_mismatch` unless the data's SHA-256 is exactly `expected`. */
export function verifySha256(data: Buffer, expected: string | null | undefined): void {
  if (!expected || !/^[0-9a-f]{64}$/.test(expected) || sha256Hex(data) !== expected) throw new Error('checksum_mismatch');
}

/** x.y.z → numbers; null for anything else. */
export function versionCore(version: string | null | undefined): [number, number, number] | null {
  const match = version ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** An update exists when `latest` is newer than `installed`'s base version. */
export function isNewerVersion(installed: string | null, latest: string | null): boolean {
  const from = versionCore(installed), to = versionCore(latest);
  if (!from || !to) return false;
  for (let index = 0; index < 3; index++) if (to[index] !== from[index]) return to[index]! > from[index]!;
  return false;
}

/** Whether a file starts with the ELF magic. */
export async function isElfFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    return head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    await handle.close();
  }
}
