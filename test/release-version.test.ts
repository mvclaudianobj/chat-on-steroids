import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Node ESM helper has no TypeScript declaration.
import { debianVersion, productVersion } from '../scripts/release-version.mjs';
// @ts-expect-error Node ESM helper has no TypeScript declaration.
import { verifyReleaseVersion } from '../scripts/verify-release-version.mjs';

function releaseFixture(npmVersion: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'marks-release-version-'));
  const version = productVersion(npmVersion);
  const put = (filename: string, content: string) => {
    const file = path.join(root, filename);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  put('package.json', JSON.stringify({ version: npmVersion }));
  put('package-lock.json', JSON.stringify({ version: npmVersion, packages: { '': { version: npmVersion } } }));
  put('extension/manifest.json', JSON.stringify({ version }));
  put('src/main/version.ts', `export const APP_VERSION = '${version}';`);
  put('electron-builder.yml', `buildVersion: ${version}\nbuildNumber: '${npmVersion.split('+')[1] || '1'}'\nextraMetadata:\n  version: ${version}\n`);
  put('CHANGELOG.md', `# Changelog\n\n## [${version}] — Release\n`);
  put(`docs/release-notes/v${version}.md`, `## Chat Marks ${version}\n`);
  return { root, put, version };
}

describe('GitHub release metadata', () => {
  it('maps npm build metadata to the app, tag and Debian versions', () => {
    expect(productVersion('2.1.37')).toBe('2.1.37');
    expect(productVersion('2.1.37+1')).toBe('2.1.37.1');
    expect(productVersion('2.1.37+2')).toBe('2.1.37.2');
    expect(debianVersion('2.1.37')).toBe('2.1.37');
    expect(debianVersion('2.1.37+1')).toBe('2.1.37.1-1');
    expect(() => productVersion('2.1.37.1')).toThrow(/Invalid stable package version/);
    expect(() => productVersion('2.1.37-rc.1')).toThrow(/Invalid stable package version/);
  });

  it.each(['2.1.37', '2.1.37+1', '2.1.37+2'])('accepts matching release files for %s', (npmVersion) => {
    const { root, version } = releaseFixture(npmVersion);
    expect(verifyReleaseVersion({ root, tag: `v${version}` })).toBe(version);
    const wrongTag = npmVersion.includes('+') ? `v${npmVersion}` : 'v2.1.36';
    expect(() => verifyReleaseVersion({ root, tag: wrongTag })).toThrow(/Tag/);
  });

  it('rejects a mismatched extension, builder and changelog before native packaging', () => {
    const { root, put } = releaseFixture('2.1.37+2');
    put('extension/manifest.json', JSON.stringify({ version: '2.1.37.1' }));
    expect(() => verifyReleaseVersion({ root })).toThrow(/extension version/);
    put('extension/manifest.json', JSON.stringify({ version: '2.1.37.2' }));
    put('electron-builder.yml', 'buildVersion: 2.1.37.1\nbuildNumber: 2\nextraMetadata:\n  version: 2.1.37.2\n');
    expect(() => verifyReleaseVersion({ root })).toThrow(/builder version/);
    put('electron-builder.yml', 'buildVersion: 2.1.37.2\nbuildNumber: 2\nextraMetadata:\n  version: 2.1.37.2\n');
    put('CHANGELOG.md', '## [2.1.37] — Stale\n');
    expect(() => verifyReleaseVersion({ root })).toThrow(/changelog version/);
    expect(verifyReleaseVersion({ root, packageOnly: true })).toBe('2.1.37.2');
  });

  it('allows an explicitly labeled higher Debian TEST revision without changing the app version or a release tag', () => {
    const { root, put } = releaseFixture('2.1.45+3');
    put('electron-builder.yml', '# localQaRebuild: 4\nbuildVersion: 2.1.45.3\nbuildNumber: 4\nextraMetadata:\n  version: 2.1.45.3\n');
    expect(verifyReleaseVersion({ root })).toBe('2.1.45.3');
    expect(() => verifyReleaseVersion({ root, tag: 'v2.1.45.3' })).toThrow(/builder revision/);
    put('electron-builder.yml', 'buildVersion: 2.1.45.3\nbuildNumber: 4\nextraMetadata:\n  version: 2.1.45.3\n');
    expect(() => verifyReleaseVersion({ root })).toThrow(/builder revision/);
  });
});
