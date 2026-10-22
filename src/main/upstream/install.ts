/**
 * Chat Marks: install and update an upstream CLI from its official GitHub release into the
 * user's own module folder (no administrator rights). Shared by OpenCode and ZeroClaw.
 *
 * - The renderer sends the version the user confirmed; a different latest release is refused.
 * - The archive comes from the trusted repository's release hosts only (bounded), and its
 *   SHA-256 must equal what the release publishes (the API digest, and `SHA256SUMS` when the
 *   module has one) before anything is extracted.
 * - The archive's listing is checked first: only regular files and folders, no absolute or `..`
 *   path, nothing outside the module's allowlist. Only the allowlisted members are extracted,
 *   into a private 0700 staging folder inside the module folder (same filesystem, so the final
 *   step is a rename).
 * - Every binary must be ELF and report exactly the confirmed x.y.z through `--version`, run with
 *   a private HOME/XDG folder so the probe never touches the user's own data.
 * - Promotion: `file` layout renames the one binary over the old one (a running process keeps the
 *   old inode); `directory` layout swaps the whole `bin` folder (bin → bin.old, stage → bin) so
 *   several binaries always change together.
 *
 * Every step runs through a Runner: directly on Linux, inside WSL (`wsl.exe --exec`) on Windows,
 * with the same POSIX commands. Arguments are argv entries, never shell text.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { UpstreamInstallProgress, UpstreamModuleId } from '../../shared/upstream-module.js';
import {
  downloadReleaseAsset, fetchLatestRelease, parseChecksums, verifySha256, type GitHubAsset, type GitHubRelease
} from '../github-release.js';

const exec = promisify(execFile);

/** What the archive name depends on. */
export interface HostInfo {
  arch: 'x64' | 'arm64' | null;
  avx2: boolean;
  musl: boolean;
}

export interface Runner {
  readonly windows: boolean;
  run(file: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
}

export const localRunner: Runner = {
  windows: false,
  async run(file, args, timeoutMs = 60_000) {
    const { stdout, stderr } = await exec(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' });
    return { stdout: String(stdout), stderr: String(stderr) };
  }
};

export const wslRunner: Runner = {
  windows: true,
  async run(file, args, timeoutMs = 60_000) {
    const { stdout, stderr } = await exec('wsl.exe', ['--exec', file, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { stdout: String(stdout), stderr: String(stderr) };
  }
};

export const platformRunner = (): Runner => process.platform === 'win32' ? wslRunner : localRunner;

/** Same checks as upstream OpenCode's `install` script: avx2 in /proc/cpuinfo, musl from Alpine or `ldd --version`. */
export const HOST_PROBE_SCRIPT = 'm=$(uname -m); a=0; grep -qwi avx2 /proc/cpuinfo 2>/dev/null && a=1; l=0; [ -f /etc/alpine-release ] && l=1; ldd --version 2>&1 | grep -qi musl && l=1; echo "$m $a $l"';

export function parseHostProbe(output: string): HostInfo {
  const [machine, avx2, musl] = output.trim().split(/\s+/);
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'x64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : null;
  return { arch, avx2: avx2 === '1', musl: musl === '1' };
}

export async function probeHost(runner: Runner): Promise<HostInfo> {
  const { stdout } = await runner.run('/bin/sh', ['-c', HOST_PROBE_SCRIPT, 'marks-host-probe'], 8_000);
  return parseHostProbe(stdout);
}

export interface UpstreamSpec {
  id: UpstreamModuleId;
  name: string;
  repository: string;
  /** Release tags this module accepts; group 1 is x.y.z. */
  tag: RegExp;
  archiveLimit: number;
  /** The archive (and checksum file) for this host, or null when there is no build for it. */
  assets(release: GitHubRelease, host: HostInfo): { archive: GitHubAsset; checksums?: GitHubAsset } | null;
  /** Whether an archive entry may exist at all (a listed entry outside this refuses the archive). */
  allowedEntry(name: string): boolean;
  /** What is extracted, as tar member names (folders end with `/`). */
  members: readonly string[];
  /** The executables among the members; each must be ELF and report the version. */
  binaries: readonly string[];
  layout: 'file' | 'directory';
}

/** The first x.y.z in a `--version` line (`1.19.3`, `zeroclaw 0.8.6`). */
export function parseVersion(output: string): string | null {
  return /(?:^|[^\d.])v?(\d+\.\d+\.\d+)(?![\d.])/.exec(output)?.[1] ?? null;
}

/** A private HOME and XDG set, so a probe of the binary never reads or writes the user's own data. */
export function probeEnvironment(home: string): string[] {
  return ['HOME=' + home, 'XDG_DATA_HOME=' + `${home}/data`, 'XDG_CONFIG_HOME=' + `${home}/config`, 'XDG_STATE_HOME=' + `${home}/state`,
    'XDG_CACHE_HOME=' + `${home}/cache`, 'PATH=/usr/bin:/bin', 'LANG=C', 'OPENCODE_DISABLE_AUTOUPDATE=1', 'NO_COLOR=1'];
}

/** `<binary> --version` under `env -i` with the private probe folder; null when it does not answer a version. */
export async function probeVersion(runner: Runner, binary: string, probeHome: string): Promise<string | null> {
  try {
    await runner.run('/bin/mkdir', ['-p', '-m', '700', '--', probeHome], 8_000);
    const { stdout, stderr } = await runner.run('/usr/bin/env', ['-i', ...probeEnvironment(probeHome), binary, '--version'], 15_000);
    return parseVersion(`${stdout}\n${stderr}`.split(/\r?\n/).find(line => parseVersion(line)) ?? '');
  } catch {
    return null;
  }
}

/** A tar listing entry: its type character (`-` file, `d` folder, anything else refused) and name. */
export function checkListing(names: string[], verbose: string[], spec: Pick<UpstreamSpec, 'allowedEntry' | 'members'>): void {
  if (!names.length || names.length !== verbose.length) throw new Error('archive_unexpected');
  for (const [index, raw] of names.entries()) {
    const name = raw.replace(/^\.\//, '');
    const type = verbose[index]![0];
    if (!name || name.startsWith('/') || name.split('/').includes('..') || /[\u0000-\u001f\\]/.test(name)) throw new Error('archive_unexpected');
    if (type !== '-' && type !== 'd') throw new Error('archive_unexpected');
    if (!spec.allowedEntry(name)) throw new Error('archive_unexpected');
  }
  for (const member of spec.members) {
    if (!names.some(raw => raw.replace(/^\.\//, '') === member)) throw new Error('archive_unexpected');
  }
}

export interface InstallOptions {
  /** The modules folder as the runner sees it (`<userData>/modules`, or the WSL prefix). */
  modulesRoot: string;
  runner?: Runner;
  fetchImpl?: typeof fetch;
  onProgress?(progress: UpstreamInstallProgress): void;
  /** Tests: the release instead of GitHub's latest. */
  release?: GitHubRelease;
  host?: HostInfo;
}

const running = new Set<UpstreamModuleId>();
export const upstreamInstallRunning = (id: UpstreamModuleId): boolean => running.has(id);

const SAFE_PATH = /^\/[A-Za-z0-9._@+/ -]{1,900}$/;

/**
 * Installs `expected` (the version the user confirmed) of the module. Resolves with the final
 * progress (`done`); rejects with a short code (`version_changed`, `unsupported_platform`,
 * `checksum_mismatch`, `archive_unexpected`, `extract_failed`, `version_mismatch`, `install_failed`).
 */
export async function installUpstream(spec: UpstreamSpec, expected: string, mode: 'install' | 'update', options: InstallOptions): Promise<UpstreamInstallProgress> {
  if (running.has(spec.id)) throw new Error('install_running');
  running.add(spec.id);
  const runner = options.runner ?? platformRunner();
  const sh = (file: string, args: string[], timeoutMs?: number) => runner.run(file, args, timeoutMs);
  let progress: UpstreamInstallProgress = { module: spec.id, mode, phase: 'downloading', version: expected };
  const report = (next: Partial<UpstreamInstallProgress>): void => {
    progress = { ...progress, ...next };
    options.onProgress?.(progress);
  };
  const moduleDir = `${options.modulesRoot}/${spec.id}`;
  const stage = `${moduleDir}/.stage-${randomUUID()}`;
  let windowsCopy: string | null = null;
  let stageMade = false;
  try {
    if (!SAFE_PATH.test(options.modulesRoot)) throw new Error('install_failed');
    const release = options.release ?? await fetchLatestRelease(spec.repository, spec.tag, options.fetchImpl);
    if (release.version !== expected) throw new Error('version_changed');
    const host = options.host ?? await probeHost(runner);
    const assets = spec.assets(release, host);
    if (!assets) throw new Error('unsupported_platform');
    const prefix = `https://github.com/${spec.repository}/releases/download/`;
    for (const asset of [assets.archive, assets.checksums]) {
      if (asset && asset.url !== `${prefix}v${release.version}/${asset.name}`) throw new Error('unsupported_platform');
    }
    report({ phase: 'downloading' });
    const [archive, checksums] = await Promise.all([
      downloadReleaseAsset(assets.archive.url, prefix, spec.archiveLimit, options.fetchImpl),
      assets.checksums ? downloadReleaseAsset(assets.checksums.url, prefix, 64 * 1024, options.fetchImpl) : Promise.resolve(null)
    ]);
    report({ phase: 'verifying' });
    // The API digest is required; a published checksum file must agree with it.
    verifySha256(archive, assets.archive.sha256);
    if (checksums) verifySha256(archive, parseChecksums(checksums.toString('utf8')).get(assets.archive.name));

    report({ phase: 'extracting' });
    await sh('/bin/mkdir', ['-p', '-m', '700', '--', moduleDir]);
    await sh('/usr/bin/test', ['!', '-L', options.modulesRoot]);
    await sh('/usr/bin/test', ['!', '-L', moduleDir]);
    await sh('/bin/mkdir', ['-m', '700', '--', stage]);
    stageMade = true;
    const archivePath = `${stage}/release.tar.gz`;
    if (runner.windows) {
      windowsCopy = join(tmpdir(), `marks-${spec.id}-${randomUUID()}.tar.gz`);
      await writeFile(windowsCopy, archive, { mode: 0o600 });
      const source = (await sh('/usr/bin/wslpath', ['-a', windowsCopy], 8_000)).stdout.trim();
      if (!SAFE_PATH.test(source)) throw new Error('install_failed');
      await sh('/bin/cp', ['--', source, archivePath], 120_000);
      const copied = (await sh('/usr/bin/sha256sum', ['--', archivePath], 60_000)).stdout.trim().split(/\s+/)[0];
      if (copied !== assets.archive.sha256) throw new Error('checksum_mismatch');
    } else {
      await writeFile(archivePath, archive, { mode: 0o600 });
    }
    const names = (await sh('/usr/bin/tar', ['-tzf', archivePath], 120_000)).stdout.split('\n').filter(Boolean);
    const verbose = (await sh('/usr/bin/tar', ['-tvzf', archivePath], 120_000)).stdout.split('\n').filter(Boolean);
    checkListing(names, verbose, spec);
    const bin = `${stage}/bin`;
    await sh('/bin/mkdir', ['-m', '700', '--', bin]);
    try {
      await sh('/usr/bin/tar', ['-xzf', archivePath, '-C', bin, '--no-same-owner', '--no-same-permissions', '--', ...spec.members], 300_000);
    } catch { throw new Error('extract_failed'); }
    await sh('/bin/rm', ['-f', '--', archivePath]);
    for (const name of spec.binaries) {
      const file = `${bin}/${name}`;
      // A regular file, not a link (`test` answers by exit code, whatever the locale), starting with the ELF magic.
      const regular = await sh('/usr/bin/test', ['-f', file]).then(() => sh('/usr/bin/test', ['!', '-L', file])).then(() => true, () => false);
      const magic = (await sh('/usr/bin/od', ['-An', '-tx1', '-N4', '--', file]).catch(() => ({ stdout: '' }))).stdout.replace(/\s+/g, '');
      if (!regular || magic !== '7f454c46') throw new Error('extract_failed');
      await sh('/bin/chmod', ['700', '--', file]);
    }
    report({ phase: 'checking' });
    for (const name of spec.binaries) {
      const reported = await probeVersion(runner, `${bin}/${name}`, `${stage}/probe`);
      if (reported !== expected) throw new Error('version_mismatch');
    }
    await sh('/bin/rm', ['-rf', '--', `${stage}/probe`]);

    report({ phase: 'installing' });
    const target = `${moduleDir}/bin`;
    if (spec.layout === 'file') {
      await sh('/bin/mkdir', ['-p', '-m', '700', '--', target]);
      await sh('/usr/bin/test', ['!', '-L', target]);
      // rename(2) over the old binary: a running server keeps the inode it opened.
      for (const name of spec.binaries) await sh('/bin/mv', ['-f', '--', `${bin}/${name}`, `${target}/${name}`]);
    } else {
      const old = `${moduleDir}/bin.old-${randomUUID()}`;
      const had = await sh('/usr/bin/test', ['-e', target]).then(() => true, () => false);
      if (had) {
        await sh('/usr/bin/test', ['!', '-L', target]);
        await sh('/bin/mv', ['--', target, old]);
      }
      try {
        await sh('/bin/chmod', ['700', '--', bin]);
        await sh('/bin/mv', ['--', bin, target]);
      } catch (error) {
        if (had) await sh('/bin/mv', ['--', old, target]).catch(() => undefined);
        throw error;
      }
      if (had) await sh('/bin/rm', ['-rf', '--', old], 120_000).catch(() => undefined);
    }
    report({ phase: 'done' });
    return progress;
  } catch (error) {
    const known = ['version_changed', 'unsupported_platform', 'checksum_mismatch', 'archive_unexpected', 'extract_failed', 'version_mismatch',
      'download_failed', 'release_unavailable', 'install_running'];
    const code = known.includes((error as Error).message) ? (error as Error).message : 'install_failed';
    report({ phase: 'failed', error: code });
    throw new Error(code, { cause: error });
  } finally {
    running.delete(spec.id);
    if (stageMade) await sh('/bin/rm', ['-rf', '--', stage], 120_000).catch(() => undefined);
    if (windowsCopy) await rm(windowsCopy, { force: true }).catch(() => undefined);
  }
}

/** Removes only the module's `bin` (and leftovers of an interrupted install); never any data folder. */
export async function uninstallUpstream(spec: Pick<UpstreamSpec, 'id'>, modulesRoot: string, runner: Runner = platformRunner()): Promise<void> {
  if (!SAFE_PATH.test(modulesRoot)) throw new Error('install_failed');
  const moduleDir = `${modulesRoot}/${spec.id}`;
  await runner.run('/bin/rm', ['-rf', '--', `${moduleDir}/bin`, `${moduleDir}/.probe`]);
}
