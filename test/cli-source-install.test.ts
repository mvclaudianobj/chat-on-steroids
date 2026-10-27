import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readlinkSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({
  home: '', fail: false, latest: '1.2.3', commands: [] as string[][],
  claudeNativeReady: false, claudePostinstallCalls: 0
}));
vi.mock('electron', () => ({ app: { getPath: () => fixture.home } }));
vi.mock('../src/main/npm-release.js', () => ({
  NPM_REGISTRY: 'https://registry.npmjs.org/',
  fetchNpmVersion: vi.fn(async (name: string, version: string) => ({ name, version: version === 'latest' ? fixture.latest : version,
    tarball: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version === 'latest' ? fixture.latest : version}.tgz`, integrity: 'sha512-synthetic' })),
  npmTarballUrl: (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
  downloadNpmTarball: vi.fn(async () => Buffer.from('verified fixture'))
}));
vi.mock('../src/main/upstream/install.js', () => ({
  localRunner: { run: vi.fn(async (_file: string, args: string[]) => ({
    stdout: args.at(-1) === '--version' ? (args.at(-2)?.endsWith('/claude') ?
      (fixture.claudeNativeReady ? '1.2.3 (Claude Code)\n' : '') : 'codex-cli 1.2.3\n') : '',
    stderr: args.at(-1) === '--version' && args.at(-2)?.endsWith('/claude') && !fixture.claudeNativeReady
      ? 'Error: claude native binary not installed (postinstall did not run)\n' : ''
  })) },
  wslRunner: { run: vi.fn() }, probeEnvironment: (home: string) => [`HOME=${home}`, 'PATH=/usr/bin:/bin']
}));
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  (execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = async (file: string, args: string[]) => {
    fixture.commands.push([file, ...args]);
    if (file === 'npm' && args[0] === 'install') {
      if (fixture.fail) throw new Error('synthetic npm failure');
      const prefix = args.find(arg => arg.startsWith('--prefix='))!.slice('--prefix='.length);
      const bin = path.join(prefix, 'node_modules/.bin/codex');
      mkdirSync(path.dirname(bin), { recursive: true });
      writeFileSync(bin, 'codex fixture', { mode: 0o755 });
      const claudePackage = path.join(prefix, 'node_modules/@anthropic-ai/claude-code');
      mkdirSync(claudePackage, { recursive: true });
      writeFileSync(path.join(claudePackage, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '1.2.3' }));
      writeFileSync(path.join(claudePackage, 'install.cjs'), '/* synthetic official fixture */');
      writeFileSync(path.join(prefix, 'node_modules/.bin/claude'), 'stub fixture', { mode: 0o755 });
    }
    if (file === 'node' && args[0]?.endsWith('/@anthropic-ai/claude-code/install.cjs')) {
      fixture.claudePostinstallCalls++;
      fixture.claudeNativeReady = true;
    }
    return { stdout: '', stderr: '' };
  };
  return { execFile };
});

import { installPublishedCli, publishedLatest, publishedUpdateAvailable } from '../src/main/cli-source-install.js';

describe.skipIf(process.platform !== 'linux')('published CLI module updates', () => {
  beforeEach(() => { fixture.home = mkdtempSync(path.join(os.tmpdir(), 'marks-cli-test-')); fixture.fail = false; fixture.latest = '1.2.3'; fixture.commands = []; fixture.claudeNativeReady = false; fixture.claudePostinstallCalls = 0; });
  afterEach(() => { if (fixture.home) rmSync(fixture.home, { recursive: true, force: true }); });

  it('requires an exact official version and preserves the installed launcher on failure', async () => {
    expect(await publishedLatest('codex')).toBe('1.2.3');
    expect(publishedUpdateAvailable('1.2.2', '1.2.3')).toBe(true);
    expect(publishedUpdateAvailable('1.2.3', '1.2.3')).toBe(false);
    await expect(installPublishedCli('codex', '@untrusted/codex', '1.2.3', 'install')).rejects.toThrow('unexpected_package');
    await expect(installPublishedCli('codex', '@openai/codex', '1.2.2', 'install')).rejects.toThrow('version_changed');
    await installPublishedCli('codex', '@openai/codex', '1.2.3', 'install');
    const launcher = path.join(fixture.home, 'modules/codex/bin/codex');
    const before = readlinkSync(launcher);
    expect(before).toContain('versions/v1.2.3-');
    expect(fixture.commands.find(row => row[0] === 'npm')).toEqual(expect.arrayContaining(['--ignore-scripts']));
    fixture.fail = true;
    await expect(installPublishedCli('codex', '@openai/codex', '1.2.3', 'update')).rejects.toThrow('synthetic npm failure');
    expect(readlinkSync(launcher)).toBe(before);
    expect(existsSync(path.join(fixture.home, 'modules/codex/versions'))).toBe(true);
  });

  it('rechecks active turns after staging and before mutating an external npm prefix', async () => {
    const prefix = path.join(os.homedir(), '.local');
    let checks = 0;
    await expect(installPublishedCli('codex', '@openai/codex', '1.2.3', 'update-external', prefix, async () => {
      checks++;
      throw new Error('turn_started_during_download');
    })).rejects.toThrow('turn_started_during_download');
    expect(checks).toBe(1);
    expect(fixture.commands.filter(row => row.includes('--global'))).toHaveLength(0);
  });

  it('prepares the official Claude native binary before version verification, without running arbitrary npm lifecycle scripts', async () => {
    await installPublishedCli('claude', '@anthropic-ai/claude-code', '1.2.3', 'install');
    expect(fixture.claudePostinstallCalls).toBe(1);
    expect(fixture.commands.filter(row => row[0] === 'node')).toHaveLength(1);
    expect(fixture.commands.filter(row => row[0] === 'npm')).toEqual([
      expect.arrayContaining(['--ignore-scripts'])
    ]);
    expect(readlinkSync(path.join(fixture.home, 'modules/claude/bin/claude'))).toContain('versions/v1.2.3-');
  });

  it('never mutates the external Claude installation if native preparation fails', async () => {
    fixture.fail = true;
    await expect(installPublishedCli('claude', '@anthropic-ai/claude-code', '1.2.3', 'update-external',
      path.join(os.homedir(), '.local'))).rejects.toThrow('synthetic npm failure');
    expect(fixture.commands.some(row => row.includes('--global'))).toBe(false);
  });
});
