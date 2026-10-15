import { describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
const shown: string[] = [];
vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => { opened.push(url); return Promise.resolve(); } },
  BrowserWindow: class {
    private destroyed = false;
    webContents = { setWindowOpenHandler: () => undefined, on: () => undefined };
    isDestroyed() { return this.destroyed; }
    focus() { }
    loadURL(url: string) { shown.push(url); return Promise.resolve(); }
    close() { this.destroyed = true; }
    on(_name: string, _callback: () => void) { }
  }
}));
const { safeManagementUrl, moduleAction, modulesStatus } = await import('../src/main/modules.js');

describe('Marks modules boundary', () => {
  it('accepts only local console addresses without credentials or fragments', () => {
    expect(safeManagementUrl('http://127.0.0.1:7070/management.html')).toBe('http://127.0.0.1:7070/management.html');
    expect(safeManagementUrl('http://localhost:8317/management.html')).toBe('http://localhost:8317/management.html');
    for (const url of [
      'https://github.com/router-for-me/CLIProxyAPI',
      'http://127.0.0.1.evil.com:8317/management.html',
      'http://admin:secret@localhost:8317/management.html',
      'file:///etc/passwd',
      'http://127.0.0.1:8317/management.html?key=secret',
      'http://127.0.0.1:8317/management.html#token',
      'javascript:alert(1)'
    ]) expect(() => safeManagementUrl(url)).toThrow();
  });

  it('opens only the existing local console in a dedicated window', async () => {
    shown.length = 0;
    opened.length = 0;
    await moduleAction('open', 'http://127.0.0.1:7070/management.html');
    expect(shown).toEqual(['http://127.0.0.1:7070/management.html']);
    await expect(moduleAction('open', 'http://evil.example/')).rejects.toThrow();
    expect(shown).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('offers upstream installation instructions without silently installing packages', async () => {
    opened.length = 0;
    await moduleAction('install');
    expect(opened).toEqual(['https://github.com/router-for-me/CLIProxyAPI']);
    const modules = await modulesStatus();
    expect(modules.map(module => module.id)).toEqual(['cli-proxy-api']);
  });
});
