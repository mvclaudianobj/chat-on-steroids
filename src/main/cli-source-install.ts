/**
 * Install the npm-published coding CLIs (Codex, Claude Code) into their own module prefix, with
 * the previous install kept until the new one is verified. (The Marks forks' source builds are
 * gone: MarksCode and MarksClaw are retired; OpenCode and ZeroClaw install their official
 * releases through main/upstream.)
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';

const exec = promisify(execFile);

function root(): string {
  return path.join(app.getPath('userData'), 'modules');
}
async function run(file: string, args: string[], cwd: string, timeout = 20 * 60_000): Promise<string> {
  const { stdout } = await exec(file, args, { cwd, timeout, maxBuffer: 1024 * 1024 });
  return stdout;
}

async function privateDirectory(folder: string): Promise<void> {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Module installation directory must be a real directory');
}

async function wsl(file: string, args: string[], cwd?: string, timeout = 20 * 60_000): Promise<string> {
  const params = [...(cwd ? ['--cd', cwd] : []), '--exec', file, ...args];
  const { stdout } = await exec('wsl.exe', params, { timeout, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/** Staged, verified, then promoted; a failure keeps the earlier version. */
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
