import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../src/main/version';
import { RELEASE_VERSION_PATTERN, isNewer, isReleaseVersion } from '../src/shared/types';

/**
 * Marks ships the community release with a fourth revision number (2.1.42.1). A version check
 * copied from upstream that knows only three numbers rejects every Marks build: Setup refused the
 * 2.1.42.1 extension as "could not be verified" (2026-10-20). One pattern owns the format.
 */
describe('release version format', () => {
  it('accepts the shipped Marks version and compares the fourth number', () => {
    expect(isReleaseVersion(APP_VERSION)).toBe(true);
    expect(isReleaseVersion('2.1.42')).toBe(true);
    expect(isReleaseVersion('2.1.42.1')).toBe(true);
    for (const bad of ['2.1', '2.1.42.1.1', 'v2.1.42', '2.1.42+1', '', null, 2142]) expect(isReleaseVersion(bad)).toBe(false);
    expect(isNewer('2.1.42.1', '2.1.42')).toBe(true);
    expect(isNewer('2.1.43', '2.1.42.9')).toBe(true);
    expect(isNewer('2.1.42', '2.1.42.1')).toBe(false);
  });

  it('keeps every app and extension version check on the one shared pattern', () => {
    const root = path.join(__dirname, '..');
    const owner = path.join('src', 'shared', 'types.ts');
    const threeNumbers = String.raw`\d+\.\d+\.\d+`;
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(relative);
        else if (/\.(?:ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && relative !== owner) {
          readFileSync(path.join(root, relative), 'utf8').split('\n').forEach((line, index) => {
            if (line.includes(threeNumbers)) offenders.push(`${relative}:${index + 1}`);
          });
        }
      }
    };
    visit('src');
    visit('extension');
    expect(RELEASE_VERSION_PATTERN.startsWith(threeNumbers)).toBe(true);
    expect(offenders, 'use isReleaseVersion / RELEASE_VERSION_PATTERN from src/shared/types.ts').toEqual([]);
  });
});
