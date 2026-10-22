/**
 * Chat Marks: official npm registry downloads for a module whose upstream publishes its binaries
 * as npm platform packages (OpenCode 2.x: `@opencode/cli` + `@opencode/cli-<platform>`).
 *
 * - Only `https://registry.npmjs.org/` is trusted: no other host, no redirect, no credentials.
 * - Metadata is the registry's own version document (`/<package>/latest`, `/<package>/<x.y.z>`),
 *   bounded; a version that is not exactly x.y.z is refused.
 * - The tarball URL must be exactly the registry's canonical one for that package and version,
 *   and the archive is used only after its SHA-512 equals the metadata's `dist.integrity` (SRI).
 */
import { createHash } from 'node:crypto';
import { readBounded } from './github-release.js';
import { UPSTREAM_VERSION } from '../shared/upstream-module.js';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
const METADATA_LIMIT = 1024 * 1024;
/** A scoped or plain npm package name, the characters npm allows. */
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,100}$/;

export interface NpmVersion {
  name: string;
  version: string;
  tarball: string;
  /** `sha512-<base64>` from `dist.integrity`. */
  integrity: string;
  optionalDependencies: Record<string, string>;
}

/** Only https on the registry host; never credentials, another port, or a lookalike. */
export function allowedRegistryUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

/** `@scope/name` → `@scope%2fname`, the registry's document path. */
const documentPath = (name: string): string => name.replace('/', '%2f');

/** The registry's canonical tarball: `https://registry.npmjs.org/@scope/name/-/name-x.y.z.tgz`. */
export function npmTarballUrl(name: string, version: string): string {
  return `${NPM_REGISTRY}${name}/-/${name.split('/').pop()}-${version}.tgz`;
}

/**
 * One version document (`tag` is `latest` or an exact x.y.z). Throws `release_unavailable` for
 * anything unexpected: another name, a non-x.y.z version, a missing or non-sha512 integrity.
 */
export async function fetchNpmVersion(name: string, tag: string, fetchImpl: typeof fetch = fetch): Promise<NpmVersion> {
  if (!PACKAGE.test(name) || (tag !== 'latest' && !UPSTREAM_VERSION.test(tag))) throw new Error('release_unavailable');
  const url = `${NPM_REGISTRY}${documentPath(name)}/${tag}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'Chat-Marks' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error('release_unavailable'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error('release_unavailable'); }
  let body: { name?: unknown; version?: unknown; dist?: { tarball?: unknown; integrity?: unknown }; optionalDependencies?: unknown };
  try { body = JSON.parse((await readBounded(response, METADATA_LIMIT)).toString('utf8')) as typeof body; }
  catch { throw new Error('release_unavailable'); }
  const version = typeof body.version === 'string' ? body.version : '';
  const integrity = typeof body.dist?.integrity === 'string' ? body.dist.integrity : '';
  if (body.name !== name || !UPSTREAM_VERSION.test(version) || (tag !== 'latest' && version !== tag)
    || typeof body.dist?.tarball !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error('release_unavailable');
  const optional: Record<string, string> = {};
  if (body.optionalDependencies && typeof body.optionalDependencies === 'object') {
    for (const [dependency, range] of Object.entries(body.optionalDependencies as Record<string, unknown>)) if (typeof range === 'string') optional[dependency] = range;
  }
  return { name, version, tarball: body.dist.tarball, integrity, optionalDependencies: optional };
}

/** Throws `checksum_mismatch` unless the data's SHA-512 is exactly the SRI `sha512-<base64>`. */
export function verifyIntegrity(data: Buffer, integrity: string | null | undefined): void {
  if (!integrity || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error('checksum_mismatch');
  if (`sha512-${createHash('sha512').update(data).digest('base64')}` !== integrity) throw new Error('checksum_mismatch');
}

/**
 * Downloads a version's tarball: its URL must be the canonical registry URL, the response must
 * not redirect, the body is bounded and its SHA-512 must match `integrity` before it is returned.
 */
export async function downloadNpmTarball(meta: Pick<NpmVersion, 'name' | 'version' | 'tarball' | 'integrity'>, limit: number,
  fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (meta.tarball !== npmTarballUrl(meta.name, meta.version) || !allowedRegistryUrl(meta.tarball)) throw new Error('download_failed');
  let response: Response;
  try {
    response = await fetchImpl(meta.tarball, { redirect: 'error', headers: { 'User-Agent': 'Chat-Marks' }, signal: AbortSignal.timeout(600_000) });
  } catch { throw new Error('download_failed'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error('download_failed'); }
  const data = await readBounded(response, limit);
  verifyIntegrity(data, meta.integrity);
  return data;
}
