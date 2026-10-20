import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const setPath = vi.fn();
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    commandLine: { hasSwitch: () => false },
    getPath: (name: string) => (name === 'appData' ? '/home/u/.config' : '/home/u/.config/chat-on-steroids'),
    getName: () => 'chat-on-steroids',
    setPath
  }
}));

describe('dev profile', () => {
  it('moves an unpackaged checkout to its own profile on import', async () => {
    const { DEV_PROFILE } = await import('../src/main/dev-profile');
    expect(setPath).toHaveBeenCalledWith('userData', path.join('/home/u/.config', DEV_PROFILE));
  });

  it('keeps packaged apps, explicit folders and scripts that chose their own', async () => {
    const { devUserDataDir } = await import('../src/main/dev-profile');
    const base = { packaged: false, explicitSwitch: false, appData: '/a', current: '/a/chat-on-steroids', name: 'chat-on-steroids' };
    expect(devUserDataDir(base)).toBe(path.join('/a', 'chat-marks-dev'));
    expect(devUserDataDir({ ...base, packaged: true })).toBeNull();
    expect(devUserDataDir({ ...base, explicitSwitch: true })).toBeNull();
    expect(devUserDataDir({ ...base, current: '/tmp/verify-runtime' })).toBeNull();
  });

  it('runs before anything in the main entry can read the profile', async () => {
    const { readFileSync } = await import('node:fs');
    const entry = readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    expect(entry.split('\n')[0]).toBe("import './dev-profile.js';");
  });
});
