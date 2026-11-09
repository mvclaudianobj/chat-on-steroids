/**
 * Upstream OpenCode 2.x (`anomalyco/opencode`, MIT) as a Chat Marks module: which npm platform
 * package fits this computer, and which versions the `opencode` engine supports.
 *
 * OpenCode 2.x is published only on npm: `@opencode/cli` lists one platform package per build in
 * its `optionalDependencies` (`@opencode/cli-linux-<x64|arm64>[-baseline][-musl]`, …), each a
 * tarball holding `package/package.json` and the binary `package/bin/opencode`. Baseline on x64
 * without avx2 and musl on Alpine or a musl `ldd` (the same checks as upstream's install script).
 * The registry's `dist.integrity` (SHA-512) is the checksum. There are no GitHub release assets
 * for 2.x.
 */
import type { UpstreamSupport } from '../../shared/upstream-module.js';
import { readBounded, versionCore } from '../github-release.js';
import { UPSTREAM_VERSION } from '../../shared/upstream-module.js';
import { npmSource, type HostInfo, type UpstreamSpec } from '../upstream/install.js';

/** The version this integration was written and checked against. */
export const OPENCODE_TESTED = '2.1.2';
export const OPENCODE_NPM_PACKAGE = '@opencode/cli';

export function opencodePlatformPackage(host: HostInfo): string | null {
  if (!host.arch) return null;
  return `${OPENCODE_NPM_PACKAGE}-linux-${host.arch}${host.arch === 'x64' && !host.avx2 ? '-baseline' : ''}${host.musl ? '-musl' : ''}`;
}

/**
 * OpenCode's own update channel, the one its official installer (`opencode.ai/v2/install`) asks:
 * `{"channel":"latest","distribution":"npm","version":"2.1.2","metadata":{"package":"@opencode/cli"},…}`.
 * Used only when the npm registry's `latest` document fails; it must name this package.
 */
export const OPENCODE_UPDATE_URL = 'https://opencode.ai/update/api/latest/cli/npm';
export async function opencodeLatestHint(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(OPENCODE_UPDATE_URL, { headers: { Accept: 'application/json', 'User-Agent': 'Chat-Marks' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = JSON.parse((await readBounded(response, 64 * 1024)).toString('utf8')) as { channel?: unknown; distribution?: unknown; version?: unknown; metadata?: { package?: unknown } };
    if (body.channel !== 'latest' || body.distribution !== 'npm' || body.metadata?.package !== OPENCODE_NPM_PACKAGE) return null;
    return typeof body.version === 'string' && UPSTREAM_VERSION.test(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

const ENTRIES = new Set(['package/', 'package/bin/', 'package/package.json', 'package/bin/opencode']);

export const OPENCODE_SPEC: UpstreamSpec = {
  id: 'opencode',
  name: 'OpenCode',
  source: npmSource({ name: OPENCODE_NPM_PACKAGE, platformPackage: opencodePlatformPackage, latestHint: opencodeLatestHint }),
  // 2.1.2 linux-x64: 99 MB compressed, 214 MB unpacked.
  archiveLimit: 256 * 1024 * 1024,
  allowedEntry: name => ENTRIES.has(name),
  members: ['package/bin/opencode'],
  strip: 2,
  binaries: ['opencode'],
  layout: 'file'
};

/**
 * 2.1.x is what the engine was checked against; a newer 2.x is used with a warning (the `/api`
 * routes are versioned with the 2.x line); 1.x (a different server API), 2.0 and 3.x are not
 * supported.
 */
export function opencodeSupport(version: string | null): UpstreamSupport | null {
  const core = versionCore(version);
  if (!core) return null;
  const [major, minor] = core;
  if (major !== 2 || minor < 1) return 'unsupported';
  return minor === 1 ? 'ok' : 'newer';
}
