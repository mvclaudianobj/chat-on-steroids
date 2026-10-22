/**
 * Chat Marks Brain H2: filtered copies of the sources this account can read itself
 * (the running MarksCode 2.0.25 `opencode.db`, MarksClaw `sessions.db`). The database, its -wal
 * and -shm are copied together into a private scratch folder first; only that copy is opened
 * (so its WAL replays there), and only conversation tables reach the staged copy. Source hashes
 * are taken before and after; a source that changed during the copy is copied again (3 tries).
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { filteredCopyStatements, MARKSCLAW_TABLES, OPENCODE_TABLES, userSources, type ImportSource } from './sources.js';
import { fileMeta, type Manifest, type ManifestSource } from './staging.js';

type Kind = 'opencode-db' | 'marksclaw-db';

async function sourceMeta(file: string): Promise<{ db: unknown; wal: unknown }> {
  return { db: await fileMeta(file), wal: await fileMeta(`${file}-wal`) };
}

/** Builds one filtered copy from an already-private raw copy. */
export function filteredCopy(raw: string, out: string, kind: Kind): Record<string, number> {
  const allowed = new Set<string>(kind === 'opencode-db' ? OPENCODE_TABLES : MARKSCLAW_TABLES);
  const db = new DatabaseSync(out);
  try {
    db.prepare('ATTACH DATABASE ? AS src').run(raw);
    const present = new Set((db.prepare(`SELECT name FROM src.sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map(row => row.name).filter(name => allowed.has(name)));
    db.exec('BEGIN');
    for (const statement of filteredCopyStatements(kind, present)) db.exec(statement);
    db.exec('COMMIT');
    db.exec('DETACH DATABASE src');
    if (db.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) throw new Error('The staged copy failed its check');
    const counts: Record<string, number> = {};
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(row => row.name);
    for (const table of tables) if (allowed.has(table)) counts[table] = (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
    if (kind === 'marksclaw-db' && tables.includes('sessions')) counts.conversations = (db.prepare('SELECT count(DISTINCT session_key) AS n FROM sessions').get() as { n: number }).n;
    return counts;
  } finally { db.close(); }
}

async function copyOne(source: ImportSource, folder: string): Promise<ManifestSource> {
  const base: ManifestSource = { id: source.id, family: source.family, kind: source.kind, path: source.path, status: 'missing' };
  let stat;
  try { stat = lstatSync(source.path); } catch { return base; }
  if (!stat.isFile()) return base;
  const raw = path.join(folder, '.raw', source.id);
  await mkdir(raw, { recursive: true, mode: 0o700 });
  const rawDb = path.join(raw, 'source.db');
  let before: { db: unknown; wal: unknown } | null = null, after: { db: unknown; wal: unknown } | null = null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      before = await sourceMeta(source.path);
      await rm(raw, { recursive: true, force: true }); await mkdir(raw, { recursive: true, mode: 0o700 });
      await copyFile(source.path, rawDb);
      for (const suffix of ['-wal', '-shm']) if (existsSync(source.path + suffix)) await copyFile(source.path + suffix, rawDb + suffix);
      after = await sourceMeta(source.path);
      if (JSON.stringify(before) === JSON.stringify(after)) break;
    }
    const output = `db/${source.id}.sqlite`;
    const counts = filteredCopy(rawDb, path.join(folder, output), source.kind as Kind);
    return { ...base, status: 'copied', output, before, after, unchanged: JSON.stringify(before) === JSON.stringify(after), counts, bytes: lstatSync(path.join(folder, output)).size };
  } catch {
    return { ...base, status: 'failed', before: before ?? undefined, after: after ?? undefined };
  } finally {
    await rm(raw, { recursive: true, force: true });
  }
}

export async function exportUserSources(stagingRoot: string, sources: readonly ImportSource[] = userSources(),
  onProgress: (phase: string, source: string) => void = () => undefined): Promise<{ stagingId: string; manifest: Manifest }> {
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  let need = 0;
  for (const source of sources) for (const suffix of ['', '-wal']) { try { need += lstatSync(source.path + suffix).size; } catch { /* absent */ } }
  const space = await statfs(stagingRoot);
  if (space.bavail * space.bsize < need * 2) throw new Error('Not enough free space for the staged copy');
  const stagingId = randomUUID();
  const folder = path.join(stagingRoot, stagingId);
  await mkdir(folder, { mode: 0o700 });
  await mkdir(path.join(folder, 'db'), { mode: 0o700 });
  const entries: ManifestSource[] = [];
  try {
    for (const source of sources) {
      if (source.kind !== 'opencode-db' && source.kind !== 'marksclaw-db') continue;
      onProgress('copy', source.id);
      entries.push(await copyOne(source, folder));
      onProgress('verify', source.id);
    }
  } finally {
    await rm(path.join(folder, '.raw'), { recursive: true, force: true });
  }
  const manifest: Manifest = { version: 1, kind: 'user', id: stagingId, createdAt: Date.now(), complete: true, sources: entries };
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { stagingId, manifest };
}
