/**
 * Claude Code Router (`@musistudio/claude-code-router`, MIT, github.com/musistudio/claude-code-router)
 * as a Chat Marks module: its npm release, the versions this app supports, and the npm commands
 * that install it.
 *
 * Why npm (and not the tarball alone, like OpenCode): CCR is a Node.js program (`dist/main/cli.js`,
 * `engines.node >= 22`) with runtime dependencies, one of them native (`better-sqlite3`, its
 * configuration store). 3.1.3 pulls 101 packages (~108 MB unpacked), so resolving and extracting
 * that tree is left to the system's own `npm`, under these rules:
 * - The main package's tarball is downloaded from the registry by the app (npm-release.ts: only
 *   registry.npmjs.org, no redirect, canonical URL) and used only after its SHA-512 equals the
 *   registry's `dist.integrity`. npm installs exactly that verified file; the dependencies come
 *   from the same registry with npm's own integrity checks.
 * - `npm install --ignore-scripts` (no package runs anything at install), with an empty user
 *   config (no `.npmrc` redirects the registry) and `--registry=https://registry.npmjs.org/`.
 * - Then `npm rebuild <name>` runs the install script of the allowlisted native packages only
 *   (`NATIVE_PACKAGES`: better-sqlite3's `prebuild-install || node-gyp rebuild`), and the binding
 *   must load before the copy is used.
 * Every step is argv to a fixed program (`node`, `npm`), never shell text.
 */
import { isNewerVersion, versionCore } from '../github-release.js';
import { fetchNpmVersion, npmTarballUrl, NPM_REGISTRY, type NpmVersion } from '../npm-release.js';
import { CCR_NPM_PACKAGE, CCR_VERSION, type CcrSupport } from '../../shared/ccr-module.js';

/** The version this integration was written and checked against (CLI, health endpoint, daemon). */
export const CCR_TESTED = '3.1.3';
/** The program inside the package (`bin.ccr`). */
export const CCR_CLI = 'dist/main/cli.js';
/** Packages whose install script may run (by `npm rebuild <name>`), because the program needs their native build. */
export const NATIVE_PACKAGES = ['better-sqlite3'] as const;
/** 3.1.3's tarball is 6.5 MB. */
export const CCR_TARBALL_LIMIT = 64 * 1024 * 1024;
/** The Node.js major CCR's `engines` asks for when the registry document says nothing usable. */
export const CCR_MIN_NODE = 22;

/** 3.x is the line the CLI (`start --daemon`, `stop`), `/health` and the config store were checked on. */
export function ccrSupport(version: string | null): CcrSupport | null {
  const core = versionCore(version);
  if (!core) return null;
  if (core[0] !== 3) return 'unsupported';
  return isNewerVersion(CCR_TESTED, version) ? 'newer' : 'ok';
}

/** The registry's latest version (exact x.y.z). */
export async function ccrLatest(fetchImpl?: typeof fetch): Promise<string> {
  return (await fetchNpmVersion(CCR_NPM_PACKAGE, 'latest', fetchImpl)).version;
}

/**
 * The version document of exactly `expected`, after checking that it is still the latest (the
 * user confirmed that version) and that its tarball URL is the registry's canonical one.
 */
export async function ccrRelease(expected: string, fetchImpl?: typeof fetch): Promise<NpmVersion> {
  if (!CCR_VERSION.test(expected)) throw new Error('release_unavailable');
  if (await ccrLatest(fetchImpl) !== expected) throw new Error('version_changed');
  const meta = await fetchNpmVersion(CCR_NPM_PACKAGE, expected, fetchImpl);
  if (meta.tarball !== npmTarballUrl(CCR_NPM_PACKAGE, expected)) throw new Error('download_failed');
  return meta;
}

/** The lowest Node.js major an `engines.node` range like `>=22` or `^22.0.0 || >=24` accepts. */
export function minimumNodeMajor(range: string | undefined): number {
  if (!range) return CCR_MIN_NODE;
  const majors = [...range.matchAll(/(\d+)(?:\.\d+){0,2}/g)].map(match => Number(match[1])).filter(Number.isFinite);
  return majors.length ? Math.min(...majors) : CCR_MIN_NODE;
}

/** `v22.23.4` → 22; null for anything else. */
export function nodeMajor(output: string): number | null {
  const match = /^v?(\d+)\.\d+\.\d+/.exec(output.trim());
  return match ? Number(match[1]) : null;
}

/** Options every npm call gets: the public registry only, no user config, no audit/fund noise. */
export function npmIsolation(userconfig: string): string[] {
  return [`--registry=${NPM_REGISTRY}`, `--userconfig=${userconfig}`, '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=warn'];
}

/** `npm install` of the verified tarball into a prefix; no package runs a script. */
export function npmInstallArgv(prefix: string, tarball: string, userconfig: string, global = false): string[] {
  return ['install', ...(global ? ['--global'] : []), `--prefix=${prefix}`, '--ignore-scripts', '--omit=dev', '--no-save', ...npmIsolation(userconfig), '--', tarball];
}

/** `npm rebuild` of the allowlisted native packages only (their install script runs). */
export function npmRebuildArgv(projectDir: string, userconfig: string): string[] {
  return ['rebuild', `--prefix=${projectDir}`, '--foreground-scripts', ...npmIsolation(userconfig), '--', ...NATIVE_PACKAGES];
}

/** A `node -e` check that the installed tree's native binding loads (better-sqlite3 opens a memory database). */
export const NATIVE_CHECK_SCRIPT = 'const D=require(process.argv[1]);const d=new D(":memory:");if(d.prepare("select 1 as x").get().x!==1)process.exit(3);d.close();';

/** The CLI's argv for the service actions (the user's configuration decides host and ports). */
export function ccrServiceArgv(action: 'start' | 'stop'): string[] {
  return action === 'start' ? ['start', '--daemon', '--no-open'] : ['stop'];
}
