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
import { allowedDownloadUrl, downloadReleaseAsset, fetchLatestRelease, isNewerVersion, parseChecksums, readBounded } from '../github-release.js';

const exec = promisify(execFile);
export const CLIPROXY_BINARY = '/usr/local/bin/cli-proxy-api';
const DOWNLOAD_PREFIX = `https://github.com/${CLIPROXY_REPOSITORY}/releases/download/`;
const LATEST_TTL_MS = 60 * 60_000;
export const ARCHIVE_LIMIT = 96 * 1024 * 1024;
export const CHECKSUMS_LIMIT = 64 * 1024;

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

/** An update exists when the latest release is newer than the installed build's base version. */
export const isUpdateAvailable = isNewerVersion;

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

export { readBounded };

let latest: { at: number; release: CliProxyRelease } | null = null;

/** The latest official, non-draft, non-prerelease release; cached for an hour. */
export async function latestRelease(options: { refresh?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<CliProxyRelease> {
  const now = options.now ?? Date.now();
  if (latest && !options.refresh && now - latest.at < LATEST_TTL_MS) return latest.release;
  const found = await fetchLatestRelease(CLIPROXY_REPOSITORY, CLIPROXY_TAG, options.fetchImpl);
  const release: CliProxyRelease = { version: found.version, assets: found.assets.map(({ name, url, size }) => ({ name, url, size })) };
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

export { allowedDownloadUrl };

/** Follows at most five redirects, each checked against the host allowlist, and bounds the body. */
export function downloadAsset(url: string, limit: number, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  return downloadReleaseAsset(url, DOWNLOAD_PREFIX, limit, fetchImpl);
}

export { parseChecksums };

export function verifyChecksum(data: Buffer, name: string, checksums: string): void {
  const expected = parseChecksums(checksums).get(name);
  const actual = createHash('sha256').update(data).digest('hex');
  if (!expected || expected !== actual) throw new Error('checksum_mismatch');
}
