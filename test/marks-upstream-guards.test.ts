import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM build script without type declarations
import { extensionStamp, STAMP_FILE } from '../scripts/write-extension-stamp.mjs';

/**
 * Marks contracts a community merge can undo without any upstream test noticing. Each one comes
 * from a regression that reached a Marks build; see the marks-community-merge skill.
 */
const root = path.join(__dirname, '..');

describe('extension build stamp', () => {
  // 2026-10-20: the merge changed extension/ and nothing rewrote the ignored stamp, so the app run
  // from the checkout called its own extension outdated and refused its work (stale_extension_build).
  it('is rewritten by every command that runs or bundles the app', () => {
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const name of ['dev', 'build']) expect(scripts[name], name).toMatch(/^node scripts\/write-extension-stamp\.mjs && /);
    expect(readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8')).toContain("'scripts/write-extension-stamp.mjs'");
  });

  it('matches the extension folder whenever a checkout holds one', () => {
    const file = path.join(root, 'extension', STAMP_FILE);
    if (!existsSync(file)) return;
    expect(readFileSync(file, 'utf8').trim(), 'run: node scripts/write-extension-stamp.mjs').toBe(extensionStamp(path.join(root, 'extension')));
  });
});

describe('Chat Marks brand', () => {
  // The fork renames connectors to "Chat Marks …" (src/shared/connector-names.ts), so UI text that
  // names "Chat On Steroids" sends people looking for plugins that do not exist. Older strings are
  // listed until rebranded; a merge may only shrink the list, never add to it.
  it('lets no new community UI string name the upstream brand', () => {
    const baselineFile = path.join(root, 'test', 'fixtures', 'marks-legacy-brand-strings.json');
    const baseline = new Set(JSON.parse(readFileSync(baselineFile, 'utf8')) as string[]);
    const found = new Set<string>();
    const dir = path.join(root, 'src', 'renderer', 'locales');
    for (const file of readdirSync(dir)) {
      for (const key of Object.keys(JSON.parse(readFileSync(path.join(dir, file), 'utf8')))) {
        if (key.includes('Chat On Steroids')) found.add(key);
      }
    }
    expect([...found].filter(key => !baseline.has(key)), 'new UI text: say "Chat Marks" and translate it').toEqual([]);
    expect([...baseline].filter(key => !found.has(key)), 'rebranded: remove these from the baseline file').toEqual([]);
  });
});
