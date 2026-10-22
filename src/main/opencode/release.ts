/**
 * Upstream OpenCode (`anomalyco/opencode`, MIT) as a Chat Marks module: which release archive
 * fits this computer, and which versions the `opencode` engine supports.
 *
 * Assets follow upstream's own `install` script: `opencode-linux-<x64|arm64>[-baseline][-musl].tar.gz`
 * (baseline on x64 without avx2, musl on Alpine or a musl `ldd`). No checksum file is published;
 * each asset's GitHub API digest (`sha256:…`) is the checksum. The archive holds exactly one
 * member, `opencode`.
 */
import { UPSTREAM_REPOSITORIES, UPSTREAM_TAG, type UpstreamSupport } from '../../shared/upstream-module.js';
import { versionCore } from '../github-release.js';
import type { HostInfo, UpstreamSpec } from '../upstream/install.js';

/** The version this integration was written and checked against. */
export const OPENCODE_TESTED = '1.19.3';

export function opencodeAssetName(host: HostInfo): string | null {
  if (!host.arch) return null;
  return `opencode-linux-${host.arch}${host.arch === 'x64' && !host.avx2 ? '-baseline' : ''}${host.musl ? '-musl' : ''}.tar.gz`;
}

export const OPENCODE_SPEC: UpstreamSpec = {
  id: 'opencode',
  name: 'OpenCode',
  repository: UPSTREAM_REPOSITORIES.opencode,
  tag: UPSTREAM_TAG,
  archiveLimit: 160 * 1024 * 1024,
  assets(release, host) {
    const name = opencodeAssetName(host);
    const archive = name ? release.assets.find(asset => asset.name === name) : undefined;
    return archive ? { archive } : null;
  },
  allowedEntry: name => name === 'opencode',
  members: ['opencode'],
  binaries: ['opencode'],
  layout: 'file'
};

/**
 * 1.19.x is what the engine was checked against; a newer 1.x is used with a warning (the routes
 * it uses are the ones the TUI uses); older than 1.19 and 2.x (a new CLI is being prepared
 * upstream) are not supported.
 */
export function opencodeSupport(version: string | null): UpstreamSupport | null {
  const core = versionCore(version);
  if (!core) return null;
  const [major, minor] = core;
  if (major !== 1 || minor < 19) return 'unsupported';
  return minor === 19 ? 'ok' : 'newer';
}
