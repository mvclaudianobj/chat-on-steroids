/** Official npm Codex / Claude Code releases. Running CLIs keep their immutable version directory. */
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { downloadNpmTarball, fetchNpmVersion, npmTarballUrl } from './npm-release.js';
import { npmInstallArgv } from './ccr/release.js';
import { localRunner, probeEnvironment, wslRunner } from './upstream/install.js';
import { isNewerVersion } from './github-release.js';

/** A third-party CLI's x.y.z (not the app's own four-part release version). */
const CLI_VERSION = String.raw`\d+(?:\.\d+){2}`;
const CODEX_VERSION_LINE = new RegExp(String.raw`^codex(?:-cli)?\s+v?(${CLI_VERSION})(?:[-+][0-9A-Za-z.-]+)?$`, 'i');
const CLAUDE_VERSION_LINE = new RegExp(String.raw`^(?:claude(?: code)?\s+v?(${CLI_VERSION})|(?:(${CLI_VERSION})\s+\(Claude Code\)))(?:[-+][0-9A-Za-z.-]+)?$`, 'i');

export type PublishedId = 'codex' | 'claude';
const PACKAGES: Readonly<Record<PublishedId, string>> = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' };
const LIMIT = 100 * 1024 * 1024;
const exec = promisify(execFile);
const cache = new Map<PublishedId, { until: number; latest: string | null }>();
const active = new Set<PublishedId>();

export async function publishedLatest(id: PublishedId): Promise<string | null> {
  const previous = cache.get(id);
  if (previous && previous.until > Date.now()) return previous.latest;
  const latest = await fetchNpmVersion(PACKAGES[id], 'latest').then(meta => meta.version, () => null);
  cache.set(id, { latest, until: Date.now() + (latest ? 15 * 60_000 : 60_000) });
  return latest;
}

export function publishedUpdateAvailable(installed: string | null, latest: string | null): boolean {
  return !!installed && !!latest && isNewerVersion(installed, latest);
}

/** A file installed by npm --global --prefix=$HOME/.local, with an exact publisher. */
export async function externalNpmPrefix(id: PublishedId, binary: string, home: string): Promise<string | null> {
  if (!path.isAbsolute(binary) || process.platform === 'win32') return null;
  const prefix = path.join(home, '.local');
  const packageDir = path.join(prefix, 'lib', 'node_modules', PACKAGES[id]);
  const real = await fs.realpath(binary).catch(() => null);
  if (!real || !real.startsWith(`${packageDir}${path.sep}`)) return null;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')) as { name?: string };
    if (meta.name !== PACKAGES[id]) return null;
    await fs.access(packageDir, constants.W_OK);
    await fs.access(prefix, constants.W_OK);
    return prefix;
  } catch { return null; }
}

export type InstallMode = 'install' | 'update' | 'update-external';

/** The confirmed version is rechecked against latest, its canonical tarball and SHA512. */
export async function installPublishedCli(id: PublishedId, packageName: string, expected: string, mode: InstallMode,
  externalPrefix: string | null = null): Promise<void> {
  if (PACKAGES[id] !== packageName) throw new Error('unexpected_package');
  if (active.has(id)) throw new Error('install_running');
  active.add(id);
  try {
    if ((await fetchNpmVersion(packageName, 'latest')).version !== expected) throw new Error('version_changed');
    const meta = await fetchNpmVersion(packageName, expected);
    if (meta.tarball !== npmTarballUrl(packageName, expected)) throw new Error('download_failed');
    const archive = await downloadNpmTarball(meta, LIMIT);
    if (process.platform === 'win32') await installWsl(id, expected, mode, archive, externalPrefix);
    else await installLocal(id, expected, mode, archive, externalPrefix);
    cache.delete(id);
  } finally { active.delete(id); }
}

async function privateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_prefix');
}

const safeEnv = (home: string): NodeJS.ProcessEnv => {
  return { HOME: home, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C', TMPDIR: os.tmpdir(), NO_COLOR: '1', npm_config_update_notifier: 'false' };
};

async function installLocal(id: PublishedId, expected: string, mode: InstallMode, archive: Buffer, externalPrefix: string | null): Promise<void> {
  const root = path.join(app.getPath('userData'), 'modules');
  const moduleDir = path.join(root, id);
  const stage = path.join(moduleDir, `.stage-${randomUUID()}`);
  const tarball = path.join(stage, 'release.tgz');
  const npmrc = path.join(stage, 'npmrc');
  await privateDir(root);
  await privateDir(moduleDir);
  await privateDir(stage);
  try {
    await fs.writeFile(tarball, archive, { mode: 0o600 });
    await fs.writeFile(npmrc, '', { mode: 0o600 });
    const runNpm = async (prefix: string, global = false): Promise<void> => {
      await exec('npm', npmInstallArgv(prefix, tarball, npmrc, global), {
        timeout: 180_000, maxBuffer: 1024 * 1024, env: safeEnv(os.homedir()), windowsHide: true
      });
    };
    const staged = path.join(stage, 'app');
    await runNpm(staged);
    const binary = path.join(staged, 'node_modules', '.bin', id);
    const real = await fs.realpath(binary);
    if (!real.startsWith(`${staged}${path.sep}`)) throw new Error('unsafe_executable');
    const version = await verifiedVersion(id, binary, path.join(stage, 'probe'));
    if (version !== expected) throw new Error('version_mismatch');
    if (mode === 'update-external') {
      if (!externalPrefix || externalPrefix !== path.join(os.homedir(), '.local')) throw new Error('external_not_writable');
      await runNpm(externalPrefix, true);
      return;
    }
    const versions = path.join(moduleDir, 'versions');
    const launcherDir = path.join(moduleDir, 'bin');
    await privateDir(versions);
    await privateDir(launcherDir);
    const folder = `v${expected}-${randomUUID()}`;
    const target = path.join(versions, folder);
    await fs.rename(staged, target);
    // The launcher is a single atomic pointer. Old version directories remain valid for
    // a currently running app-server, npm CLI, or tmux terminal after the switch.
    const tempLink = path.join(launcherDir, `.next-${randomUUID()}`);
    try {
      await fs.symlink(path.join('..', 'versions', folder, 'node_modules', '.bin', id), tempLink);
      await fs.rename(tempLink, path.join(launcherDir, id));
    } finally { await fs.rm(tempLink, { force: true }).catch(() => undefined); }
  } finally { await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined); }
}

/** Check with a private HOME, never loading the actual account or updater. */
export async function verifiedVersion(id: PublishedId, binary: string, probeHome: string): Promise<string | null> {
  const runner = process.platform === 'win32' ? wslRunner : localRunner;
  try {
    await runner.run('/bin/mkdir', ['-p', '-m', '700', '--', probeHome], 8_000);
    const inheritedPath = process.platform === 'win32'
      ? (await runner.run('/usr/bin/env', ['printenv', 'PATH'], 8_000)).stdout.trim() : process.env.PATH;
    const searchPath = inheritedPath && inheritedPath.length < 4096 && !/[\u0000-\u001f]/.test(inheritedPath)
      ? inheritedPath : '/usr/local/bin:/usr/bin:/bin';
    const { stdout, stderr } = await runner.run('/usr/bin/env', [
      '-i', ...probeEnvironment(probeHome).filter(entry => !entry.startsWith('PATH=')), `PATH=${searchPath}`,
      `CODEX_HOME=${probeHome}/codex`, `CLAUDE_CONFIG_DIR=${probeHome}/claude`,
      'DISABLE_AUTOUPDATER=1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', binary, '--version'
    ], 15_000);
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
      const trimmed = line.trim();
      const match = (id === 'codex' ? CODEX_VERSION_LINE : CLAUDE_VERSION_LINE).exec(trimmed);
      if (match) return match[1] ?? match[2] ?? null;
    }
  } catch { /* unavailable or unrecognized binary */ }
  return null;
}

async function installWsl(id: PublishedId, expected: string, mode: InstallMode, archive: Buffer, externalPrefix: string | null): Promise<void> {
  const runner = wslRunner;
  const run = (file: string, args: string[], timeout?: number) => runner.run(file, args, timeout);
  const home = (await run('/usr/bin/env', ['printenv', 'HOME'])).stdout.trim();
  if (!/^\/home\/[^/\s]+$/.test(home)) throw new Error('unsafe_prefix');
  const moduleDir = `${home}/.local/share/chat-marks-modules/${id}`;
  const stage = `${moduleDir}/.stage-${randomUUID()}`;
  const localCopy = path.join(os.tmpdir(), `marks-cli-${randomUUID()}.tgz`);
  try {
    await run('/usr/bin/test', ['!', '-L', moduleDir]);
    await run('/bin/mkdir', ['-p', '-m', '700', '--', stage]);
    await fs.writeFile(localCopy, archive, { mode: 0o600 });
    const source = (await run('/usr/bin/wslpath', ['-a', localCopy])).stdout.trim();
    await run('/bin/cp', ['--', source, `${stage}/release.tgz`]);
    const hash = (await run('/usr/bin/sha512sum', [`${stage}/release.tgz`])).stdout.split(/\s+/)[0];
    if (hash !== createHash('sha512').update(archive).digest('hex')) throw new Error('checksum_mismatch');
    await run('/usr/bin/touch', [`${stage}/npmrc`]);
    const install = async (prefix: string, global = false): Promise<void> => {
      await run('/usr/bin/env', ['-i', `HOME=${home}`, 'PATH=/usr/local/bin:/usr/bin:/bin', 'npm',
        ...npmInstallArgv(prefix, `${stage}/release.tgz`, `${stage}/npmrc`, global)], 180_000);
    };
    await install(`${stage}/app`);
    const verified = await verifiedVersion(id, `${stage}/app/node_modules/.bin/${id}`, `${stage}/probe`);
    if (verified !== expected) throw new Error('version_mismatch');
    if (mode === 'update-external') {
      if (externalPrefix !== `${home}/.local`) throw new Error('external_not_writable');
      await install(externalPrefix, true);
      return;
    }
    const folder = `v${expected}-${randomUUID()}`;
    await run('/bin/mkdir', ['-p', '--', `${moduleDir}/versions`, `${moduleDir}/bin`]);
    await run('/usr/bin/test', ['!', '-L', `${moduleDir}/versions`]);
    await run('/usr/bin/test', ['!', '-L', `${moduleDir}/bin`]);
    await run('/bin/mv', ['--', `${stage}/app`, `${moduleDir}/versions/${folder}`]);
    const link = `${moduleDir}/bin/.next-${randomUUID()}`;
    await run('/bin/ln', ['-s', '--', `../versions/${folder}/node_modules/.bin/${id}`, link]);
    await run('/bin/mv', ['-f', '--', link, `${moduleDir}/bin/${id}`]);
  } finally {
    await run('/bin/rm', ['-rf', '--', stage]).catch(() => undefined);
    await fs.rm(localCopy, { force: true }).catch(() => undefined);
  }
}
