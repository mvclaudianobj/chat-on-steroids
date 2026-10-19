import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const native = path.join(root, 'docs', 'licenses', 'native');
const pinnedName = 'fontconfig-40707235.tar.xz';

describe('pinned native source packaging', () => {
  it('stores an exact reviewed copy of fontconfig without relying on the intermittent registry', () => {
    const inventory = JSON.parse(readFileSync(path.join(native, 'sources.json'), 'utf8'));
    const source = inventory.sources.find((row: { file: string }) => row.file === pinnedName);
    expect(source).toBeDefined();
    const content = readFileSync(path.join(native, 'preverified', pinnedName));
    expect(content.length).toBe(source.bytes);
    expect(createHash('sha256').update(content).digest('hex')).toBe(source.sha256);
  });

  it('validates the reviewed archive before an offline source-package check succeeds', () => {
    const result = spawnSync(process.execPath, ['scripts/package-native-sources.mjs', '--check'], {
      cwd: root, encoding: 'utf8'
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Validated');
  });
});
