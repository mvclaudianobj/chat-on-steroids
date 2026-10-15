import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { firefoxAddonUrl, FIREFOX_ADDON_ASSET } from '../src/shared/firefox-addon.js';
// @ts-expect-error The script is plain Node without type declarations.
import * as script from '../scripts/firefox-update-manifest.mjs';

const { FIREFOX_ADDON_ID, FIREFOX_SIGN_CHECK_ADDON_ID, FIREFOX_XPI, firefoxUpdateManifest, firefoxSigningTestVersion, verifySignedFirefoxXpi, writeFirefoxUpdateManifest } = script as {
  FIREFOX_ADDON_ID: string; FIREFOX_SIGN_CHECK_ADDON_ID: string; FIREFOX_XPI: string;
  firefoxUpdateManifest(options: { version: string; sha256: string }): unknown;
  firefoxSigningTestVersion(npmVersion: string, runNumber: number | string): string;
  verifySignedFirefoxXpi(xpi: string, version: string, exec?: (bin: string, args: string[]) => string | Buffer, addonId?: string): boolean;
  writeFirefoxUpdateManifest(options: { xpi: string; version: string; out: string }, verifySigned?: (xpi: string, version: string) => boolean): Promise<void>;
};

// Firefox checks the add-on's update_url (the latest release's firefox-updates.json) and installs
// the signed package it names, after checking that package's hash.
describe('Firefox update manifest', () => {
  it('uses a fork-specific Gecko ID rather than the community add-on identity', () => {
    expect(FIREFOX_ADDON_ID).toBe('companion@chatmarks.app');
    expect(FIREFOX_ADDON_ID).not.toBe('companion@chatonsteroids.app');
    expect(FIREFOX_SIGN_CHECK_ADDON_ID).toBe('companion-signcheck@chatmarks.app');
    expect(FIREFOX_SIGN_CHECK_ADDON_ID).not.toBe(FIREFOX_ADDON_ID);
    expect(FIREFOX_ADDON_ASSET).toBe(FIREFOX_XPI);
    expect(firefoxAddonUrl('2.1.38.1')).toBe('https://github.com/mvclaudianobj/chat-on-steroids/releases/download/v2.1.38.1/Chat-Marks-Firefox.xpi');
    expect(() => firefoxAddonUrl('2.1.38+1')).toThrow();
  });

  it('names exactly this release\'s signed package and its hash', () => {
    expect(firefoxUpdateManifest({ version: '2.1.38', sha256: 'a'.repeat(64) })).toEqual({
      addons: {
        [FIREFOX_ADDON_ID]: {
          updates: [{
            version: '2.1.38',
            update_link: `https://github.com/mvclaudianobj/chat-on-steroids/releases/download/v2.1.38/${FIREFOX_XPI}`,
            update_hash: `sha256:${'a'.repeat(64)}`
          }]
        }
      }
    });
  });

  it('refuses anything that is not a release version or a sha256', () => {
    expect(firefoxUpdateManifest({ version: '2.1.38.1', sha256: 'a'.repeat(64) })).toBeTruthy();
    expect(() => firefoxUpdateManifest({ version: '2.1', sha256: 'a'.repeat(64) })).toThrow();
    expect(() => firefoxUpdateManifest({ version: '2.1.38', sha256: 'xyz' })).toThrow();
    expect(() => firefoxUpdateManifest({ version: '02.1.38.1', sha256: 'a'.repeat(64) })).toThrow();
    expect(() => firefoxUpdateManifest({ version: '2.1.38.1.2', sha256: 'a'.repeat(64) })).toThrow();
    expect(() => firefoxUpdateManifest({ version: '2.1.38+1', sha256: 'a'.repeat(64) })).toThrow();
  });

  it('derives a unique four-part AMO test version from npm build metadata, not a fifth component', () => {
    expect(firefoxSigningTestVersion('2.1.38+1', 1)).toBe('2.1.38.1001');
    expect(firefoxSigningTestVersion('2.1.38+1', 44)).toBe('2.1.38.1044');
    expect(() => firefoxSigningTestVersion('2.1.38+1', 0)).toThrow();
    expect(() => firefoxSigningTestVersion('2.1.38+1', 'abc')).toThrow();
    expect(() => firefoxSigningTestVersion('2.1.38+1001', 1)).toThrow();
    expect(() => firefoxSigningTestVersion('2.1.38+1', 999999000)).toThrow();
  });

  it('refuses unsigned, wrong-ID or wrong-version artifacts before generating updates', () => {
    const archiveEntries = ['manifest.json', 'META-INF/manifest.mf', 'META-INF/mozilla.sf', 'META-INF/mozilla.rsa'];
    const manifest = { version: '2.1.38.1', browser_specific_settings: { gecko: { id: FIREFOX_ADDON_ID } } };
    const fake = (name: string, args: string[]): string => {
      if (name === 'openssl') return 'subject= CN = companion@chatmarks.app\nissuer= CN = Mozilla Production Signing CA';
      if (args[0] === '-Z1') return archiveEntries.join('\n');
      if (args[0] === '-p' && args[2] === 'manifest.json') return JSON.stringify(manifest);
      return 'test-signature';
    };
    expect(verifySignedFirefoxXpi('signed.xpi', '2.1.38.1', fake)).toBe(true);
    const unsigned = (name: string, args: string[]): string => args[0] === '-Z1' ? 'manifest.json' : fake(name, args);
    expect(() => verifySignedFirefoxXpi('unsigned.xpi', '2.1.38.1', unsigned)).toThrow(/missing META-INF/);
    expect(() => verifySignedFirefoxXpi('signed.xpi', '2.1.38.2', fake)).toThrow(/version/);
    expect(() => verifySignedFirefoxXpi('signed.xpi', '2.1.38.1', (name, args) =>
      name === 'openssl' ? 'issuer= Unrelated Authority' : fake(name, args))).toThrow(/Mozilla-issued/);
    expect(() => verifySignedFirefoxXpi('signed.xpi', '2.1.38.1', (name, args) =>
      args[0] === '-p' && args[2] === 'manifest.json'
        ? JSON.stringify({ ...manifest, browser_specific_settings: { gecko: { id: 'companion@chatonsteroids.app' } } })
        : fake(name, args))).toThrow(/Gecko ID/);
    expect(verifySignedFirefoxXpi('probe.xpi', '2.1.38.1001', (name, args) =>
      args[0] === '-p' && args[2] === 'manifest.json'
        ? JSON.stringify({ version: '2.1.38.1001', browser_specific_settings: { gecko: { id: FIREFOX_SIGN_CHECK_ADDON_ID } } })
        : fake(name, args), FIREFOX_SIGN_CHECK_ADDON_ID)).toBe(true);
  });

  it('hashes the signed package on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-ff-update-'));
    try {
      const xpi = path.join(dir, FIREFOX_XPI);
      await fs.writeFile(xpi, 'signed bytes');
      const out = path.join(dir, 'firefox-updates.json');
      await expect(writeFirefoxUpdateManifest({ xpi, version: '2.1.38', out })).rejects.toThrow();
      await writeFirefoxUpdateManifest({ xpi, version: '2.1.38', out }, () => true);
      const written = JSON.parse(await fs.readFile(out, 'utf8'));
      expect(written.addons[FIREFOX_ADDON_ID].updates[0].update_hash)
        .toBe(`sha256:${createHash('sha256').update('signed bytes').digest('hex')}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
