import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/smoke-macos-bundle.mjs', import.meta.url));

// Exercise the real plist comparison on any CI platform. Only the macOS process identity and
// plutil response are simulated; no native binary, signature or deployment audit is skipped in
// the production script. A deliberately missing icon marks a passed plist preflight.
function auditPlist(npmVersion: string, shortVersion: string, bundleVersion: string) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'marks-macos-plist-'));
  try {
    const app = path.join(cwd, 'Chat Marks.app');
    const contents = path.join(app, 'Contents');
    mkdirSync(contents, { recursive: true });
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version: npmVersion }));
    writeFileSync(path.join(contents, 'Info.plist'), JSON.stringify({
      CFBundleIdentifier: 'com.chatonsteroids.app',
      CFBundleExecutable: 'Chat Marks',
      CFBundleName: 'Chat Marks',
      CFBundleDisplayName: 'Chat Marks',
      CFBundleIconFile: 'icon.icns',
      CFBundleShortVersionString: shortVersion,
      CFBundleVersion: bundleVersion,
      LSApplicationCategoryType: 'public.app-category.developer-tools',
      LSMinimumSystemVersion: '13.0',
      NSScreenCaptureUsageDescription:
        'Chat Marks captures a display or window only when the enabled Desktop connector asks to observe it.',
      NSLocalNetworkUsageDescription:
        'Chat Marks connects to devices and services on your local network when you run approved tools or commands.'
    }));
    const preload = path.join(cwd, 'mock-macos.mjs');
    writeFileSync(preload, `
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'darwin' });
childProcess.spawnSync = (command, args) => {
  if (command !== 'plutil') throw new Error('Unexpected native command: ' + command);
  const plist = JSON.parse(readFileSync(args[args.length - 1], 'utf8'));
  const output = args[0] === '-extract' ? plist[args[1]] : JSON.stringify(plist);
  return { status: output === undefined ? 1 : 0, stdout: output ?? '', stderr: '' };
};
syncBuiltinESMExports();
`);
    return spawnSync(process.execPath, ['--import', preload, script, 'arm64', app], {
      cwd,
      encoding: 'utf8'
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('macOS packaged plist versions', () => {
  it.each([
    ['2.1.41', '2.1.41'],
    ['2.1.41+1', '2.1.41.1']
  ])('accepts the product version for npm %s', (npmVersion, packagedVersion) => {
    const result = auditPlist(npmVersion, packagedVersion, packagedVersion);
    expect(result.stderr).toMatch(/ENOENT.*icon\.icns/);
    expect(result.stderr).not.toContain('Info.plist CFBundle');
  });

  it('rejects an npm metadata string mistakenly written into the short version', () => {
    const result = auditPlist('2.1.41+1', '2.1.41+1', '2.1.41.1');
    expect(result.stderr).toContain('Info.plist CFBundleShortVersionString="2.1.41+1", expected "2.1.41.1"');
  });

  it('rejects a stale CFBundleVersion even when the short version matches', () => {
    const result = auditPlist('2.1.41+1', '2.1.41.1', '2.1.41');
    expect(result.stderr).toContain('Info.plist CFBundleVersion="2.1.41", expected "2.1.41.1"');
  });
});
