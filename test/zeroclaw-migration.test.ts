import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { importMarksClaw, marksClawMigrationPreview, setMarksClawMigrationHomeForTests } from '../src/main/zeroclaw/migration.js';

const homes: string[] = [];
const sample = `[risk_profiles.careful]\nlevel = "supervised"\n\n[runtime_profiles.focus]\nagentic = false\nmax_tool_iterations = 5\n\n[agents.helper]\nrisk_profile = "careful"\nruntime_profile = "focus"\nmodel_provider = "marks"\nenabled = true\n\n[agents.old]\nenabled = false\n`;
async function fixture(): Promise<{ root: string; source: string; target: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'marksclaw-zc-test-'));
  homes.push(root);
  const source = path.join(root, '.marksclaw');
  const target = path.join(root, '.zeroclaw');
  await mkdir(path.join(source, 'data', 'sessions'), { recursive: true });
  await mkdir(target);
  await writeFile(path.join(source, 'config.toml'), sample);
  await writeFile(path.join(source, '.secret_key'), 'never-expose-secret');
  await writeFile(path.join(source, 'data', 'sessions', 'sessions.db'), 'synthetic-session');
  await writeFile(path.join(target, 'config.toml'), '[agents.old]\nenabled = true\n');
  setMarksClawMigrationHomeForTests(root);
  return { root, source, target };
}
afterEach(async () => { setMarksClawMigrationHomeForTests(null); for (const root of homes.splice(0)) await rm(root, { force: true, recursive: true }); });

describe('ZeroClaw migration with synthetic HOME', () => {
  it('previews without disclosing content, then backs up first and imports only compatible absent entries', async () => {
    const { root, source, target } = await fixture();
    const preview = await marksClawMigrationPreview();
    expect(preview).toMatchObject({ available: true, configuration: true, sessions: true, encryptedCredentials: true, conflicts: ['agents.old'], importable: 3 });
    expect(JSON.stringify(preview)).not.toContain('never-expose-secret');
    expect(await readFile(path.join(target, 'config.toml'), 'utf8')).toBe('[agents.old]\nenabled = true\n');
    const result = await importMarksClaw(preview.ticket);
    expect(result).toMatchObject({ backupCreated: true, imported: 3, skipped: 1 });
    const content = await readFile(path.join(target, 'config.toml'), 'utf8');
    expect(content).toContain('[agents.old]\nenabled = true');
    expect(content).toContain('[risk_profiles.careful]');
    expect(content).toContain('[runtime_profiles.focus]');
    expect(content).toContain('[agents.helper]');
    expect(content).not.toContain('model_provider = "marks"');
    expect(await readFile(path.join(source, 'config.toml'), 'utf8')).toBe(sample);
    const backup = path.join(root, result.backupName);
    expect((await lstat(backup)).mode & 0o777).toBe(0o700);
    expect(await readFile(path.join(backup, 'marksclaw', '.secret_key'), 'utf8')).toBe('never-expose-secret');
    expect(await readFile(path.join(backup, 'marksclaw', 'data', 'sessions', 'sessions.db'), 'utf8')).toBe('synthetic-session');
    expect(await readFile(path.join(backup, 'zeroclaw-config.toml'), 'utf8')).toBe('[agents.old]\nenabled = true\n');
    expect((await readdir(root)).some(name => name.includes('marksclaw-backup'))).toBe(true);
    await expect(importMarksClaw(preview.ticket)).rejects.toThrow('preview_expired');
  });

  it('refuses changed configurations before writing or making a backup', async () => {
    const { root, source } = await fixture();
    const preview = await marksClawMigrationPreview();
    await writeFile(path.join(source, 'config.toml'), sample + '\n# changed');
    await expect(importMarksClaw(preview.ticket)).rejects.toThrow('preview_changed');
    expect((await readdir(root)).filter(name => name.includes('marksclaw-backup'))).toHaveLength(0);
  });

  it('rejects unsafe source links without changing ZeroClaw configuration', async () => {
    const { root, source, target } = await fixture();
    await symlink(path.join(source, 'config.toml'), path.join(source, 'link'));
    const preview = await marksClawMigrationPreview();
    await expect(importMarksClaw(preview.ticket)).rejects.toThrow('unsafe_source');
    expect(await readFile(path.join(target, 'config.toml'), 'utf8')).toBe('[agents.old]\nenabled = true\n');
    expect((await readdir(root)).some(name => name.includes('marksclaw-backup'))).toBe(false);
  });
});
