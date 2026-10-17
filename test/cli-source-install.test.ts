import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ home: '', build: 'valid' as 'valid' | 'missing' | 'link', failNpm: false, commands: [] as string[][] }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.home } }));
vi.mock('node:child_process', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const execFile = vi.fn();
  (execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = async (file: string, args: string[], options: { cwd: string }) => {
    fixture.commands.push([file, ...args]);
    if (file === 'git' && args[0] === 'clone') fs.mkdirSync(args.at(-1)!, { recursive: true });
    if (file === 'git' && args[0] === 'rev-parse') return { stdout: 'a'.repeat(40), stderr: '' };
    if (file === 'npm' && args[0] === 'install') {
      if (fixture.failNpm) throw new Error('npm network failure');
      const prefix = args[args.indexOf('--prefix') + 1]!;
      const bin = path.join(prefix, 'node_modules/.bin/codex');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, 'installed codex', { mode: 0o755 });
    }
    if (file === 'bun' && args[0] === 'run') {
      const output = path.join(options.cwd, 'packages/markscode/dist/markscode-linux-x64/bin/markscode');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      if (fixture.build === 'valid') fs.writeFileSync(output, Buffer.alloc(110_000, 65), { mode: 0o755 });
      if (fixture.build === 'link') {
        const outside = path.join(fixture.home, 'outside-binary');
        fs.writeFileSync(outside, Buffer.alloc(110_000, 65), { mode: 0o755 });
        fs.symlinkSync(outside, output);
      }
    }
    if (args[0] === '--version') return { stdout: file === 'bun' ? '1.0.0' : file.includes('codex') ? 'codex-cli 0.162.0' : 'markscode 2.0.25', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { execFile };
});

import { installFork, installPublishedCli } from '../src/main/cli-source-install.js';

const onLinux = process.platform === 'linux' && process.arch === 'x64';
describe.skipIf(!onLinux)('source-built CLI installation safety', () => {
  beforeEach(() => {
    fixture.home = mkdtempSync(path.join(os.tmpdir(), 'marks-source-install-'));
    fixture.build = 'valid';
    fixture.failNpm = false;
    fixture.commands.length = 0;
  });
  afterEach(() => { if (fixture.home) rmSync(fixture.home, { recursive: true, force: true }); });

  it('stages an executable, checks its digest and atomically promotes it with source provenance', async () => {
    const result = await installFork('markscode');
    const bin = path.join(fixture.home, 'modules/markscode/bin/markscode');
    expect(readFileSync(bin)).toEqual(Buffer.alloc(110_000, 65));
    expect(result.sha256).toBe(createHash('sha256').update(Buffer.alloc(110_000, 65)).digest('hex'));
    expect(JSON.parse(readFileSync(path.join(fixture.home, 'modules/markscode/source.json'), 'utf8'))).toMatchObject({
      commit: 'a'.repeat(40), sha256: result.sha256, repository: 'https://github.com/mvclaudianobj/markscode.git'
    });
    expect(lstatSync(bin).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.join(fixture.home, 'modules')).some(s => s.startsWith('.source-build-'))).toBe(false);
    expect(fixture.commands.some(args => args[0] === 'git' && args.includes('--depth') && args.includes('1'))).toBe(true);
  });

  it('leaves an earlier binary untouched when compilation fails or produces an escaped link', async () => {
    const binary = path.join(fixture.home, 'modules/markscode/bin/markscode');
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, 'preserved old binary');
    fixture.build = 'missing';
    await expect(installFork('markscode')).rejects.toThrow();
    expect(readFileSync(binary, 'utf8')).toBe('preserved old binary');
    fixture.build = 'link';
    await expect(installFork('markscode')).rejects.toThrow('escaped');
    expect(readFileSync(binary, 'utf8')).toBe('preserved old binary');
    expect(existsSync(path.join(fixture.home, 'modules/markscode/source.json'))).toBe(false);
  });

  it('refuses an installation directory redirected through a symlink before cloning', async () => {
    const root = path.join(fixture.home, 'modules');
    mkdirSync(root);
    mkdirSync(path.join(fixture.home, 'elsewhere'));
    symlinkSync(path.join(fixture.home, 'elsewhere'), path.join(root, 'markscode'));
    await expect(installFork('markscode')).rejects.toThrow('real directory');
    expect(fixture.commands.some(args => args[0] === 'git')).toBe(false);
  });

  it('atomically upgrades the official npm prefix, retaining its earlier version on failure', async () => {
    const directory = path.join(fixture.home, 'modules/codex/node_modules/.bin');
    mkdirSync(directory, { recursive: true });
    const binary = path.join(directory, 'codex');
    writeFileSync(binary, 'previous codex');
    fixture.failNpm = true;
    await expect(installPublishedCli('codex', '@openai/codex')).rejects.toThrow('npm network failure');
    expect(readFileSync(binary, 'utf8')).toBe('previous codex');
    fixture.failNpm = false;
    await installPublishedCli('codex', '@openai/codex');
    expect(readFileSync(binary, 'utf8')).toBe('installed codex');
    expect(readdirSync(path.join(fixture.home, 'modules')).sort()).toEqual(['codex']);
    expect(fixture.commands.some(args => args[0] === 'npm' && args.includes('@openai/codex@latest'))).toBe(true);
    await expect(installPublishedCli('codex', '@untrusted/codex')).rejects.toThrow('publisher');
  });
});
