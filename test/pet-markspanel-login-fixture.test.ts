import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { petFixtureDocumentKind } = require('../scripts/fixtures/pet-markspanel-login.cjs') as {
  petFixtureDocumentKind: (url: string) => 'login' | 'owner' | 'overlay' | null;
};

describe('pet GUI test login admission fixture', () => {
  it('classifies the loaded production document independently from window title or preload metadata', () => {
    expect(petFixtureDocumentKind('file:///app/renderer/markspanel-login.html')).toBe('login');
    expect(petFixtureDocumentKind('file:///app/renderer/index.html')).toBe('owner');
    expect(petFixtureDocumentKind('file:///app/renderer/pet-overlay.html')).toBe('overlay');
  });

  it('accepts only the intended page for each role during local development', () => {
    expect(petFixtureDocumentKind('http://127.0.0.1:5173/markspanel-login.html')).toBe('login');
    expect(petFixtureDocumentKind('http://localhost:5173/index.html')).toBe('owner');
    expect(petFixtureDocumentKind('http://localhost:5173/pet-overlay.html')).toBe('overlay');
  });

  it('abstains until a known document loads; never promotes about:blank or an unrelated page', () => {
    expect(petFixtureDocumentKind('')).toBeNull();
    expect(petFixtureDocumentKind('about:blank')).toBeNull();
    expect(petFixtureDocumentKind('file:///app/renderer/unknown.html')).toBeNull();
    expect(petFixtureDocumentKind('https://example.test/markspanel-login.html-evil')).toBeNull();
    expect(petFixtureDocumentKind('https://example.test/index.html')).toBeNull();
    expect(petFixtureDocumentKind('ftp://example.test/markspanel-login.html')).toBeNull();
  });
});
