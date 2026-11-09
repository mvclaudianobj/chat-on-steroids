/**
 * Chat Marks Brain H2: staged copies under `~/.local/state/chat-marks/brain-import/staging/<uuid>`.
 * Every read of old history goes through these copies; originals are never opened here.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stagingIdSchema, type StagingView } from '../../../shared/brain-import.js';

export interface FileMeta { sha256: string; size: number; mtime: number }
export interface ManifestSource {
  id: string; family: string; kind: string; path: string; status: string; output?: string;
  before?: unknown; after?: unknown; unchanged?: boolean; counts?: Record<string, number>; bytes?: number;
}
export interface Manifest { version: 1; kind: 'admin' | 'user'; id: string; createdAt: number; complete: boolean; sources: ManifestSource[] }

export async function fileMeta(file: string): Promise<FileMeta | null> {
  let stat;
  try { stat = lstatSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve()).on('error', reject);
  });
  return { sha256: hash.digest('hex'), size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
}

/** A direct child folder of the staging root named by a UUID, never a link. */
export function stagingPath(root: string, id: string): string {
  stagingIdSchema.parse(id);
  const folder = path.join(root, id);
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid staging folder');
  return folder;
}

export function readManifest(folder: string): Manifest | null {
  try {
    const file = path.join(folder, 'manifest.json');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const value = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    if (value?.version !== 1 || !Array.isArray(value.sources)) return null;
    return value;
  } catch { return null; }
}

/** A staged output path from the manifest, confined to the staging folder. */
export function stagedOutput(folder: string, output: string): string | null {
  if (!/^(db|memory|legacy)\/[A-Za-z0-9_.:-]+(\.sqlite|\.jsonl)?$/.test(output)) return null;
  const file = path.join(folder, output);
  try { const stat = lstatSync(file); if (stat.isSymbolicLink()) return null; } catch { return null; }
  return file;
}

function folderBytes(folder: string, depth = 0): number {
  let total = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isFile()) total += lstatSync(file).size;
    else if (entry.isDirectory() && depth < 6) total += folderBytes(file, depth + 1);
  }
  return total;
}

export function indexState(folder: string): StagingView['index'] {
  const file = path.join(folder, 'index.sqlite');
  if (!existsSync(file)) return { state: 'none', conversations: 0, chunks: 0 };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const complete = (db.prepare(`SELECT v FROM meta WHERE k = 'complete'`).get() as { v?: string } | undefined)?.v === '1';
    const conversations = (db.prepare('SELECT count(*) AS n FROM conversations').get() as { n: number }).n;
    const chunks = (db.prepare('SELECT max(id) AS n FROM chunks').get() as { n: number | null }).n ?? 0;
    return { state: complete ? 'complete' : 'partial', conversations, chunks };
  } catch { return { state: 'partial', conversations: 0, chunks: 0 }; }
  finally { db?.close(); }
}

export function listStagings(root: string): StagingView[] {
  let names: string[] = [];
  try { names = readdirSync(root).filter(name => stagingIdSchema.safeParse(name).success); } catch { return []; }
  const views: StagingView[] = [];
  for (const id of names) {
    let folder: string;
    try { folder = stagingPath(root, id); } catch { continue; }
    const manifest = readManifest(folder);
    let bytes = 0;
    try { bytes = folderBytes(folder); } catch { /* unreadable parts count as zero */ }
    const sources = (manifest?.sources ?? []).map(source => ({
      id: source.id, family: source.family, kind: source.kind, status: source.status,
      unchanged: typeof source.unchanged === 'boolean' ? source.unchanged : null,
      sessions: Number(source.counts?.session_v2 ?? 0) + Number(source.counts?.session ?? 0) + Number(source.counts?.conversations ?? 0) + Number(source.counts?.files ?? 0),
      bytes: Number(source.bytes ?? 0)
    }));
    const memories = (manifest?.sources ?? []).filter(source => source.kind === 'memory' && source.status === 'copied').reduce((sum, source) => sum + Number(source.counts?.lines ?? 0), 0);
    views.push({ id, kind: manifest?.kind ?? 'unknown', createdAt: Number(manifest?.createdAt ?? lstatSync(folder).mtimeMs), complete: manifest?.complete === true,
      bytes, sources, memories, index: indexState(folder) });
  }
  return views.sort((a, b) => b.createdAt - a.createdAt);
}

/** Deletes one staged copy (copies only; originals are elsewhere and never named here). */
export async function deleteStaging(root: string, id: string): Promise<void> {
  const folder = stagingPath(root, id);
  await rm(folder, { recursive: true, force: true });
}
