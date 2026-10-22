/**
 * Upstream ZeroClaw (`zeroclaw-labs/zeroclaw`, Apache-2.0) as a Chat Marks module.
 *
 * The Linux archive `zeroclaw-<x86_64|aarch64>-unknown-linux-<gnu|musl>.tar.gz` holds `zeroclaw`
 * (the agent and its daemon), `zerocode` (the terminal UI), `zerorelay` and the dashboard's
 * `web/dist/`. The release publishes `SHA256SUMS` beside the API digests; both must match.
 * `zeroclaw` and `zerocode` are installed together (the TUI refuses a daemon of another version),
 * with the dashboard next to them (`<dir-of-binary>/web/dist` is one of the gateway's own
 * auto-detected locations).
 */
import { UPSTREAM_REPOSITORIES, UPSTREAM_TAG } from '../../shared/upstream-module.js';
import type { HostInfo, UpstreamSpec } from '../upstream/install.js';

export const ZEROCLAW_TESTED = '0.8.6';

export function zeroclawAssetName(host: HostInfo): string | null {
  if (!host.arch) return null;
  return `zeroclaw-${host.arch === 'x64' ? 'x86_64' : 'aarch64'}-unknown-linux-${host.musl ? 'musl' : 'gnu'}.tar.gz`;
}

const TOP = new Set(['zeroclaw', 'zerocode', 'zerorelay', 'web/', 'web/dist/']);
/** Dashboard files: plain relative names under web/dist/. */
const DASHBOARD = /^web\/dist\/(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]*$/;

export const ZEROCLAW_SPEC: UpstreamSpec = {
  id: 'zeroclaw',
  name: 'ZeroClaw',
  repository: UPSTREAM_REPOSITORIES.zeroclaw,
  tag: UPSTREAM_TAG,
  archiveLimit: 96 * 1024 * 1024,
  assets(release, host) {
    const name = zeroclawAssetName(host);
    const archive = name ? release.assets.find(asset => asset.name === name) : undefined;
    const checksums = release.assets.find(asset => asset.name === 'SHA256SUMS');
    return archive && checksums ? { archive, checksums } : null;
  },
  allowedEntry: name => TOP.has(name) || DASHBOARD.test(name),
  members: ['zeroclaw', 'zerocode', 'web/dist/'],
  binaries: ['zeroclaw', 'zerocode'],
  layout: 'directory'
};
