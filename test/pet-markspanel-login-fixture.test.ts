import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isPetMarkspanelLoginWindow, isPetMarkspanelLoginDocument } = require('../scripts/fixtures/pet-markspanel-login.cjs') as {
  isPetMarkspanelLoginWindow: (window: unknown) => boolean;
  isPetMarkspanelLoginDocument: (url: string) => boolean;
};

function fixtureWindow(title: string, preload?: string) {
  return { getTitle: () => title, webContents: { getLastWebPreferences: () => ({ preload }) } };
}

describe('pet GUI test login admission fixture', () => {
  it('detects the real login preload before native window titles stabilize', () => {
    expect(isPetMarkspanelLoginWindow(fixtureWindow('', '/app/preload/markspanel-login.js'))).toBe(true);
    expect(isPetMarkspanelLoginWindow(fixtureWindow('Chat Marks — Entrar', '/app/preload/index.js'))).toBe(false);
    expect(isPetMarkspanelLoginWindow(fixtureWindow('Chat Marks', '/app/preload/index.js'))).toBe(false);
  });

  it('falls back to the native login title when preload metadata is absent', () => {
    expect(isPetMarkspanelLoginWindow(fixtureWindow('Chat Marks — Entrar'))).toBe(true);
    expect(isPetMarkspanelLoginWindow(fixtureWindow('Chat Marks — Entrar', ''))).toBe(true);
    expect(isPetMarkspanelLoginWindow(fixtureWindow('Chat Marks', ''))).toBe(false);
  });

  it('waits for the actual login document, not about:blank or a different page', () => {
    expect(isPetMarkspanelLoginDocument('file:///app/renderer/markspanel-login.html')).toBe(true);
    expect(isPetMarkspanelLoginDocument('http://127.0.0.1:5173/markspanel-login.html')).toBe(true);
    expect(isPetMarkspanelLoginDocument('about:blank')).toBe(false);
    expect(isPetMarkspanelLoginDocument('file:///app/renderer/index.html')).toBe(false);
    expect(isPetMarkspanelLoginDocument('https://example.test/markspanel-login.html-evil')).toBe(false);
    expect(isPetMarkspanelLoginDocument('ftp://example.test/markspanel-login.html')).toBe(false);
  });
});
