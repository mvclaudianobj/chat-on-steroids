import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ home: '', build: 'valid' as 'valid' | 'missing' | 'link', failNpm: false, commands: [] as string[][] }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.home } }));
vi.mock('node:child_process', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const execFile = vi.fn();
  (execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = async (file: string, args: string[]) => {
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
    if (args[0] === '--version') return { stdout: file === 'bun' ? '1.0.0' : file.includes('codex') ? 'codex-cli 0.162.0' : 'markscode 2.0.25', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { execFile };
});

import { installPublishedCli } from '../src/main/cli-source-install.js';

const onLinux = process.platform === 'linux' && process.arch === 'x64';
describe.skipIf(!onLinux)('published CLI installation safety', () => {
  beforeEach(() => {
    fixture.home = mkdtempSync(path.join(os.tmpdir(), 'marks-source-install-'));
    fixture.build = 'valid';
    fixture.failNpm = false;
    fixture.commands.length = 0;
  });
  afterEach(() => { if (fixture.home) rmSync(fixture.home, { recursive: true, force: true }); });

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
