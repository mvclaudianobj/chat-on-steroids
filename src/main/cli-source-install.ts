/** Rebuild fork binaries from explicitly reviewed publisher repositories. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';

const exec = promisify(execFile);
type Fork = 'markscode' | 'marksclaw';
const repositories: Record<Fork, string> = {
  markscode: 'https://github.com/mvclaudianobj/markscode.git',
  marksclaw: 'https://github.com/mvclaudianobj/marksclaw.git'
};
const active = new Set<Fork>();

function platform(): string {
  return process.platform === 'win32' ? 'windows' : process.platform;
}
function executableName(id: Fork): string {
  return `${id}${process.platform === 'win32' ? '.exe' : ''}`;
}
function root(): string {
  return path.join(app.getPath('userData'), 'modules');
}
async function run(file: string, args: string[], cwd: string, timeout = 20 * 60_000): Promise<string> {
  const { stdout } = await exec(file, args, { cwd, timeout, maxBuffer: 1024 * 1024 });
  return stdout;
}
async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}

async function privateDirectory(folder: string): Promise<void> {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Module installation directory must be a real directory');
}

async function sourceBinary(file: string, stage: string, id: Fork): Promise<string> {
  // A build can emit a link instead of a binary. Never follow it outside the
  // disposable source checkout into another approved or personal directory.
  const resolved = await fs.realpath(file);
  if (!resolved.startsWith(`${stage}${path.sep}`)) throw new Error('Build output escaped its source directory');
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 100_000 || entry.size > 1_073_741_824) throw new Error('Unexpected compiled executable');
  const { stdout, stderr } = await exec(resolved, ['--version'], { timeout: 10_000, maxBuffer: 4096 });
  if (!(stdout || stderr).toLowerCase().includes(id)) throw new Error('Built executable did not identify as the requested CLI');
  return resolved;
}

/** Build in a fresh private staging tree, and install only after a verified, executable output exists. */
export async function installFork(id: Fork): Promise<{ commit: string; sha256: string }> {
  if (active.has(id)) throw new Error(`${id} installation is already running`);
  active.add(id);
  if (process.platform === 'win32') {
    try { return await installForkWsl(id); }
    finally { active.delete(id); }
  }
  const rootPath = root();
  const staging = path.join(rootPath, `.source-build-${id}-${randomUUID()}`);
  const destination = path.join(rootPath, id, 'bin');
  let candidate: string | null = null;
  let metadata: string | null = null;
  try {
    if (id === 'markscode' && !(await binaryAvailable('bun'))) throw new Error('Bun is required to build MarksCode from its publisher source.');
    if (id === 'marksclaw' && !(await binaryAvailable('cargo'))) throw new Error('Rust/Cargo is required to build MarksClaw from its publisher source.');
    await privateDirectory(rootPath);
    await privateDirectory(path.join(rootPath, id));
    await privateDirectory(destination);
    await run('git', ['clone', '--depth', '1', '--', repositories[id], staging], rootPath, 3 * 60_000);
    const commit = (await run('git', ['rev-parse', 'HEAD'], staging, 8_000)).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Cannot verify publisher source revision');
    let binary: string;
    if (id === 'markscode') {
      await run('bun', ['install', '--frozen-lockfile'], staging);
      await run('bun', ['run', '--cwd', 'packages/markscode', 'build', '--single', '--skip-embed-web-ui'], staging);
      binary = path.join(staging, 'packages', 'markscode', 'dist', `markscode-${platform()}-${process.arch}`, 'bin', executableName(id));
    } else {
      await run('cargo', ['build', '--release', '--locked', '--bin', 'marksclaw'], staging);
      binary = path.join(staging, 'target', 'release', executableName(id));
    }
    binary = await sourceBinary(binary, staging, id);
    const digest = await sha256(binary);
    candidate = path.join(destination, `.candidate-${randomUUID()}`);
    metadata = path.join(rootPath, id, `.source-${randomUUID()}.json`);
    await fs.copyFile(binary, candidate);
    await fs.chmod(candidate, 0o700);
    if ((await sha256(candidate)) !== digest) throw new Error('Candidate binary checksum changed during installation');
    await fs.writeFile(metadata, JSON.stringify({ repository: repositories[id], commit, sha256: digest }, null, 2), { flag: 'wx', mode: 0o600 });
    await fs.rename(candidate, path.join(destination, executableName(id)));
    candidate = null;
    await fs.rename(metadata, path.join(rootPath, id, 'source.json'));
    metadata = null;
    return { commit, sha256: digest };
  } finally {
    active.delete(id);
    if (candidate) await fs.rm(candidate, { force: true }).catch(() => undefined);
    if (metadata) await fs.rm(metadata, { force: true }).catch(() => undefined);
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function wsl(file: string, args: string[], cwd?: string, timeout = 20 * 60_000): Promise<string> {
  const params = [...(cwd ? ['--cd', cwd] : []), '--exec', file, ...args];
  const { stdout } = await exec('wsl.exe', params, { timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function wslArchitecture(): Promise<'x64' | 'arm64'> {
  const kernelArch = await wsl('uname', ['-m'], undefined, 8_000);
  if (kernelArch === 'x86_64') return 'x64';
  if (kernelArch === 'aarch64') return 'arm64';
  throw new Error(`Unsupported WSL processor architecture: ${kernelArch.slice(0, 40)}`);
}

/** Compile Linux targets inside the user's WSL distribution for detachable tmux sessions. */
async function installForkWsl(id: Fork): Promise<{ commit: string; sha256: string }> {
  const home = await wsl('/usr/bin/env', ['printenv', 'HOME'], undefined, 8_000);
  if (!/^\/(?:home\/[^/\s]+|root)$/.test(home)) throw new Error('WSL home directory is unavailable');
  const stage = `${home}/.cache/chat-marks-build-${id}-${randomUUID()}`;
  const moduleRoot = `${home}/.local/share/chat-marks-modules/${id}`;
  const target = `${moduleRoot}/bin/${id}`;
  const candidate = `${moduleRoot}/bin/.candidate-${randomUUID()}`;
  const metadata = `${moduleRoot}/.source-${randomUUID()}.json`;
  try {
    const prefix = `${home}/.local/share/chat-marks-modules`;
    await wsl('test', ['!', '-L', prefix]);
    await wsl('test', ['!', '-L', moduleRoot]);
    await wsl('test', ['!', '-L', `${moduleRoot}/bin`]);
    await wsl('git', ['clone', '--depth', '1', '--', repositories[id], stage], undefined, 3 * 60_000);
    const commit = await wsl('git', ['rev-parse', 'HEAD'], stage, 8_000);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid source revision');
    let binary: string;
    if (id === 'markscode') {
      await wsl('bun', ['install', '--frozen-lockfile'], stage);
      await wsl('bun', ['run', '--cwd', 'packages/markscode', 'build', '--single', '--skip-embed-web-ui'], stage);
      binary = `${stage}/packages/markscode/dist/markscode-linux-${await wslArchitecture()}/bin/markscode`;
    } else {
      await wsl('cargo', ['build', '--release', '--locked', '--bin', 'marksclaw'], stage);
      binary = `${stage}/target/release/marksclaw`;
    }
    const outputInfo = await wsl('stat', ['-c', '%F %s', binary], stage);
    const outputSize = /^regular file (\d+)$/.exec(outputInfo);
    if (!outputSize || +outputSize[1]! < 100_000 || +outputSize[1]! > 1_073_741_824) throw new Error('Unexpected WSL binary size or type');
    const observed = await wsl(binary, ['--version'], stage, 10_000);
    if (!observed.toLowerCase().includes(id)) throw new Error('WSL executable did not identify as the requested CLI');
    const sha256 = (await wsl('sha256sum', [binary], stage)).split(/\s+/)[0]!;
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Installed executable checksum unavailable');
    // A fixed script only to transport JSON into WSL; all values are positional
    // arguments. None is interpolated into shell syntax.
    const source = JSON.stringify({ repository: repositories[id], commit, sha256 });
    await wsl('mkdir', ['-p', `${moduleRoot}/bin`], stage);
    await wsl('install', ['-m', '700', binary, candidate], stage);
    const copyHash = (await wsl('sha256sum', [candidate], stage)).split(/\s+/)[0];
    if (copyHash !== sha256) throw new Error('WSL candidate binary checksum changed');
    await wsl('sh', ['-c', 'printf %s "$1" > "$2"', 'marks-source', source, metadata], stage);
    await wsl('chmod', ['600', metadata], stage);
    await wsl('mv', ['-f', '--', candidate, target], stage);
    await wsl('mv', ['-f', '--', metadata, `${moduleRoot}/source.json`], stage);
    return { commit, sha256 };
  } finally {
    await wsl('rm', ['-f', '--', candidate, metadata], undefined, 8_000).catch(() => undefined);
    await wsl('rm', ['-rf', '--', stage], undefined, 30_000).catch(() => undefined);
  }
}

async function binaryAvailable(binary: string): Promise<boolean> {
  try { await exec(binary, ['--version'], { timeout: 5_000, maxBuffer: 4096 }); return true; } catch { return false; }
}

/** npm packages use the same staging/rollback rule as compiled forks. */
export async function installPublishedCli(id: 'codex' | 'claude', packageName: string): Promise<void> {
  const name = id === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  if (packageName !== name) throw new Error('Unexpected CLI publisher package');
  if (activePublished.has(id)) throw new Error(`${id} installation is already running`);
  activePublished.add(id);
  try {
    if (process.platform === 'win32') await installPublishedInWsl(id, name);
    else await installPublishedLocally(id, name);
  } finally { activePublished.delete(id); }
}

const activePublished = new Set<'codex' | 'claude'>();

async function installPublishedLocally(id: 'codex' | 'claude', packageName: string): Promise<void> {
  const modules = root();
  const stage = path.join(modules, `.npm-stage-${id}-${randomUUID()}`);
  const existing = path.join(modules, id);
  const backup = path.join(modules, `.npm-backup-${id}-${randomUUID()}`);
  let movedPrevious = false;
  let promoted = false;
  try {
    await privateDirectory(modules);
    await privateDirectory(stage);
    await run('npm', ['install', '--prefix', stage, `${packageName}@latest`, '--no-audit', '--no-fund'], modules, 180_000);
    const binary = path.join(stage, 'node_modules', '.bin', id);
    const resolved = await fs.realpath(binary);
    if (!resolved.startsWith(`${stage}${path.sep}`)) throw new Error('npm executable escaped its staging directory');
    const output = await run(binary, ['--version'], stage, 10_000);
    if (!output.toLowerCase().includes(id)) throw new Error('npm package did not install the expected CLI');
    try {
      const stat = await fs.lstat(existing);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Existing module directory is not a real directory');
      await fs.rename(existing, backup);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(stage, existing);
      promoted = true;
    } catch (error) {
      if (movedPrevious) await fs.rename(backup, existing);
      movedPrevious = false;
      throw error;
    }
  } finally {
    if (!promoted) await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (promoted && movedPrevious) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installPublishedInWsl(id: 'codex' | 'claude', packageName: string): Promise<void> {
  const home = await wsl('/usr/bin/env', ['printenv', 'HOME'], undefined, 8_000);
  if (!/^\/(?:home\/[^/\s]+|root)$/.test(home)) throw new Error('WSL home directory is unavailable');
  const modules = `${home}/.local/share/chat-marks-modules`;
  const stage = `${modules}/.npm-stage-${id}-${randomUUID()}`;
  const existing = `${modules}/${id}`;
  const backup = `${modules}/.npm-backup-${id}-${randomUUID()}`;
  let movedPrevious = false;
  let promoted = false;
  try {
    await wsl('test', ['!', '-L', modules]);
    await wsl('mkdir', ['-p', '--', modules]);
    await wsl('npm', ['install', '--prefix', stage, `${packageName}@latest`, '--no-audit', '--no-fund'], undefined, 180_000);
    const binary = `${stage}/node_modules/.bin/${id}`;
    await wsl('test', ['-x', binary]);
    const output = await wsl(binary, ['--version'], undefined, 10_000);
    if (!output.toLowerCase().includes(id)) throw new Error('WSL npm executable did not identify as the expected CLI');
    await wsl('test', ['!', '-L', existing]);
    const previous = await wsl('test', ['-e', existing]).then(() => true, () => false);
    if (previous) {
      await wsl('test', ['-d', existing]);
      await wsl('test', ['!', '-L', existing]);
      await wsl('mv', ['--', existing, backup]);
      movedPrevious = true;
    }
    try {
      await wsl('mv', ['--', stage, existing]);
      promoted = true;
    } catch (error) {
      if (movedPrevious) await wsl('mv', ['--', backup, existing]);
      movedPrevious = false;
      throw error;
    }
  } finally {
    if (!promoted) await wsl('rm', ['-rf', '--', stage]).catch(() => undefined);
    if (promoted && movedPrevious) await wsl('rm', ['-rf', '--', backup]).catch(() => undefined);
  }
}
