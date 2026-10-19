import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserWindowIconPath } from '../src/main/window-icon.js';

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
});
