import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureBrainForTests, brainSave, brainSearch, brainUpdate, brainDelete, brainList, brainStatus, brainDoctor } from '../src/main/brain/store.js';

const folders: string[] = [];
function fixture(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'marks-brain-test-'));
  folders.push(folder);
  const file = path.join(folder, 'brain.sqlite');
  configureBrainForTests(file);
  return file;
}
afterEach(() => {
  configureBrainForTests(path.join(tmpdir(), 'marks-brain-unused.sqlite'));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('H1a local Brain store', () => {
  it('creates a private database, deduplicates and searches accented text', async () => {
    const file = fixture();
    const first = await brainSave({ content: 'Discussão técnica sobre integração e memória', tags: ['Projeto'] });
    const again = await brainSave({ content: '  DISCUSSÃO  técnica sobre integração e memória  ' });
    expect(again.id).toBe(first.id);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await brainSearch('integracao')).map(x => x.id)).toContain(first.id);
    expect((await brainStatus()).count).toBe(1);
    expect(await brainDoctor()).toEqual({ available: true, quickCheck: true, fts: true });
  });

  it('updates and soft-deletes memories without showing deleted content in search', async () => {
    fixture();
    const initial = await brainSave({ content: 'An old description' });
    await brainUpdate(initial.id, { content: 'An updated description' });
    expect((await brainSearch('updated')).length).toBe(1);
    expect(await brainDelete(initial.id)).toBe(true);
    expect(await brainList()).toEqual([]);
    expect(await brainSearch('updated')).toEqual([]);
  });

  it('redacts credential-shaped data before persistence', async () => {
    fixture();
    const item = await brainSave({ content: `Token ghp_${'A'.repeat(40)} must never appear` });
    expect(item.content).toContain('[redacted]');
    expect(item.content).not.toContain('ghp_');
    expect((await brainList())[0]?.content).not.toContain('ghp_');
  });

  it('rejects overlong content without writing anything', async () => {
    fixture();
    await expect(brainSave({ content: 'x'.repeat(4001) })).rejects.toThrow();
    expect(await brainList()).toEqual([]);
  });

  it('fails closed on damaged existing database without replacing the bytes', async () => {
    const file = fixture();
    const original = Buffer.from('not a SQLite database');
    writeFileSync(file, original); chmodSync(file, 0o600);
    expect(await brainStatus()).toMatchObject({ available: false });
    await expect(brainSave({ content: 'Must not recover by overwriting' })).rejects.toThrow();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(file)).toEqual(original);
  });
});
