import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { browserWindowIconPath, WINDOWS_APP_USER_MODEL_ID } from '../src/main/window-icon.js';

const root = path.join(__dirname, '..');

describe('native BrowserWindow icon policy', () => {
  it.each(['linux', 'win32'] as const)('uses the packaged branded runtime PNG on %s', (platform) => {
    expect(browserWindowIconPath(platform, true, '/opt/chat/resources')).toBe(
      path.join('/opt/chat/resources', 'runtime-icon.png')
    );
  });

  it('preserves the native app bundle icon on macOS', () => {
    expect(browserWindowIconPath('darwin', true, '/irrelevant/resources')).toBeUndefined();
  });

  it.each(['linux', 'win32'] as const)('uses the original artwork in %s development runs without generated assets', (platform) => {
    expect(browserWindowIconPath(platform, false, '/electron/resources')).toBe(
      path.join(process.cwd(), 'icon_marks.png')
    );
  });

  it('does not override the native macOS icon in development', () => {
    expect(browserWindowIconPath('darwin', false, '/electron/resources')).toBeUndefined();
  });

  it('gives the Windows window the id the installer writes into its shortcuts', () => {
    const builder = yaml.load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')) as { appId: string };
    expect(WINDOWS_APP_USER_MODEL_ID).toBe(builder.appId);
    const entry = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const declared = entry.indexOf("app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)");
    expect(declared).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(entry.indexOf('app.requestSingleInstanceLock()'));
  });
});

describe('Linux desktop icon set', () => {
  // Menus, launchers and the taskbar find the icon through the desktop entry's hicolor name;
  // themes have no 1024px folder, so a lone 1024px icon left every one of them blank.
  it('packages square icons at the sizes hicolor themes list', () => {
    const builder = yaml.load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')) as { linux: { icon: string } };
    expect(builder.linux.icon).toBe('build/icons');
    const work = mkdtempSync(path.join(tmpdir(), 'marks-icons-'));
    try {
      for (const dir of ['scripts', 'extension/icons', 'src/renderer/browser-icons']) mkdirSync(path.join(work, dir), { recursive: true });
      cpSync(path.join(root, 'scripts', 'make-icon.mjs'), path.join(work, 'scripts', 'make-icon.mjs'));
      cpSync(path.join(root, 'icon_marks.png'), path.join(work, 'icon_marks.png'));
      execFileSync(process.execPath, [path.join(work, 'scripts', 'make-icon.mjs')], { cwd: work, stdio: 'ignore' });
      for (const size of [16, 22, 24, 32, 48, 64, 128, 256, 512]) {
        const png = readFileSync(path.join(work, 'build', 'icons', `${size}x${size}.png`));
        expect([png.readUInt32BE(16), png.readUInt32BE(20)], `${size}px`).toEqual([size, size]);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
