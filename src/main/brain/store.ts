/** Chat Marks: one local SQLite/FTS5 Brain database, no external history or services. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brainMemorySchema, brainSaveSchema, type BrainMemory, type BrainSaveInput } from '../../shared/brain.js';
import { redactSecretText } from '../redaction.js';
import { redactVaultText } from '../marks-vault-redaction.js';

let filePath = '';
let db: DatabaseSync | null = null;
let unavailable = false;
let writes: Promise<unknown> = Promise.resolve();
const LIMIT = 10000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
 id TEXT PRIMARY KEY, content TEXT NOT NULL, title TEXT, subject TEXT,
 tags TEXT NOT NULL, type TEXT NOT NULL, mode TEXT NOT NULL, importance REAL NOT NULL,
 scope TEXT NOT NULL, provenance TEXT NOT NULL, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, deleted_at INTEGER, content_hash TEXT NOT NULL UNIQUE, remote TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, title, subject, tags,
 content='memories', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS brain_ai AFTER INSERT ON memories BEGIN
 INSERT INTO memories_fts(rowid, content, title, subject, tags)
 VALUES (new.rowid, new.content, new.title, new.subject, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS brain_ad AFTER DELETE ON memories BEGIN
 INSERT INTO memories_fts(memories_fts, rowid, content, title, subject, tags)
 VALUES ('delete', old.rowid, old.content, old.title, old.subject, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS brain_au AFTER UPDATE ON memories BEGIN
 INSERT INTO memories_fts(memories_fts, rowid, content, title, subject, tags)
 VALUES ('delete', old.rowid, old.content, old.title, old.subject, old.tags);
 INSERT INTO memories_fts(rowid, content, title, subject, tags)
 VALUES (new.rowid, new.content, new.title, new.subject, new.tags);
END;`;

export function initBrain(userData: string): void {
  db?.close(); db = null; unavailable = false;
  filePath = path.join(userData, 'brain', 'brain.sqlite');
  writes = Promise.resolve();
}
/** Explicit test path so no test opens the installed user's database. */
export function configureBrainForTests(filename: string): void {
  db?.close(); db = null; unavailable = false; filePath = filename; writes = Promise.resolve();
}
function open(): DatabaseSync {
  if (unavailable || !filePath) throw new Error('Brain is unavailable');
  if (db) return db;
  try {
    const parent = path.dirname(filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const exists = existsSync(filePath);
    if (exists) {
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid Brain database');
    }
    const candidate = new DatabaseSync(filePath, { timeout: 5000 });
    try {
      // Check existing bytes before schema alterations. Corruption must never be replaced.
      if (exists && candidate.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) throw new Error('Damaged Brain database');
      if (exists) {
        const objects = candidate.prepare("SELECT name FROM sqlite_master WHERE name IN ('memories','memories_fts')").all();
        if (objects.length !== 2) throw new Error('Unrecognized existing Brain schema');
      }
      candidate.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      candidate.exec(SCHEMA);
      chmodSync(filePath, 0o600);
      db = candidate;
      return candidate;
    } catch (error) { candidate.close(); throw error; }
  } catch {
    unavailable = true;
    throw new Error('Local Brain database unavailable; original files preserved');
  }
}
const clean = (text: string) => redactVaultText(redactSecretText(text));
const hash = (content: string) => createHash('sha256').update(content.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()).digest('hex');
function decode(row: Record<string, unknown>): BrainMemory {
  return brainMemorySchema.parse({
    id: row.id, content: row.content, title: row.title ?? undefined, subject: row.subject ?? undefined,
    tags: JSON.parse(String(row.tags)), type: row.type, mode: row.mode,
    importance: row.importance, scope: row.scope, provenance: JSON.parse(String(row.provenance)),
    createdAt: row.created_at, updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined, contentHash: row.content_hash,
    remote: row.remote ? JSON.parse(String(row.remote)) : undefined
  });
}
const columns = 'id, content, title, subject, tags, type, mode, importance, scope, provenance, created_at, updated_at, deleted_at, content_hash, remote';
function serial<T>(work: () => T): Promise<T> {
  const running = writes.then(work);
  writes = running.catch(() => undefined);
  return running;
}
export async function brainSave(input: BrainSaveInput): Promise<BrainMemory> {
  return serial(() => {
    const parsed = brainSaveSchema.parse(input);
    const content = clean(parsed.content);
    const candidate = brainSaveSchema.parse({ ...parsed, content,
      title: parsed.title ? clean(parsed.title) : undefined,
      subject: parsed.subject ? clean(parsed.subject) : undefined,
      tags: parsed.tags.map(clean) });
    const connection = open();
    const contentHash = hash(candidate.content);
    const found = connection.prepare(`SELECT ${columns} FROM memories WHERE content_hash = ? AND deleted_at IS NULL`).get(contentHash);
    if (found) return decode(found);
    if ((connection.prepare('SELECT count(*) AS total FROM memories WHERE deleted_at IS NULL').get() as { total: number }).total >= LIMIT) throw new Error('Brain memory limit reached');
    const now = Date.now();
    const memory: BrainMemory = brainMemorySchema.parse({ ...candidate, id: randomUUID(), contentHash, createdAt: now, updatedAt: now });
    connection.prepare(`INSERT INTO memories (${columns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      memory.id, memory.content, memory.title ?? null, memory.subject ?? null, JSON.stringify(memory.tags),
      memory.type, memory.mode, memory.importance, memory.scope, JSON.stringify(memory.provenance),
      memory.createdAt, memory.updatedAt, null, memory.contentHash, null);
    return memory;
  });
}
export async function brainGet(id: string): Promise<BrainMemory | null> {
  const row = open().prepare(`SELECT ${columns} FROM memories WHERE id=? AND deleted_at IS NULL`).get(id);
  return row ? decode(row) : null;
}
export async function brainList(limit = 1000): Promise<BrainMemory[]> {
  return open().prepare(`SELECT ${columns} FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`).all(Math.max(1, Math.min(limit, LIMIT))).map(decode);
}
export async function brainSearch(query: string, limit = 6): Promise<BrainMemory[]> {
  const tokens = clean(query).normalize('NFC').match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 12) ?? [];
  if (!tokens.length) return [];
  const expression = tokens.map(token => `"${token.replace(/"/g, '')}"`).join(' OR ');
  return open().prepare(`SELECT memories.* FROM memories JOIN memories_fts ON memories_fts.rowid = memories.rowid WHERE memories_fts MATCH ? AND memories.deleted_at IS NULL ORDER BY bm25(memories_fts) LIMIT ?`).all(expression, Math.max(1, Math.min(limit, 12))).map(decode);
}
export async function brainUpdate(id: string, changes: Partial<BrainSaveInput>): Promise<BrainMemory> {
  return serial(() => {
    const connection = open();
    const prior = connection.prepare(`SELECT ${columns} FROM memories WHERE id=? AND deleted_at IS NULL`).get(id);
    if (!prior) throw new Error('Memory not found');
    const old = decode(prior);
    const candidate = brainSaveSchema.parse({ content: old.content, title: old.title, subject: old.subject,
      tags: old.tags, type: old.type, mode: old.mode, importance: old.importance,
      scope: old.scope, provenance: old.provenance, ...changes });
    const content = clean(candidate.content);
    const contentHash = hash(content);
    connection.prepare(`UPDATE memories SET content=?, title=?, subject=?, tags=?, type=?, mode=?, importance=?, scope=?, provenance=?, updated_at=?, content_hash=? WHERE id=?`).run(
      content, candidate.title ? clean(candidate.title) : null, candidate.subject ? clean(candidate.subject) : null,
      JSON.stringify(candidate.tags.map(clean)), candidate.type, candidate.mode, candidate.importance,
      candidate.scope, JSON.stringify(candidate.provenance), Date.now(), contentHash, id);
    const row = connection.prepare(`SELECT ${columns} FROM memories WHERE id=?`).get(id);
    return decode(row!);
  });
}
export async function brainDelete(id: string): Promise<boolean> {
  // H1a has no remote replica requiring tombstones; remove local content and its FTS row.
  return serial(() => open().prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0);
}
export async function brainStatus(): Promise<{ available: boolean; count: number; bytes: number }> {
  try {
    const connection = open();
    const count = (connection.prepare('SELECT count(*) AS total FROM memories WHERE deleted_at IS NULL').get() as { total: number }).total;
    return { available: true, count, bytes: lstatSync(filePath).size };
  } catch { return { available: false, count: 0, bytes: 0 }; }
}
export async function brainDoctor(): Promise<{ available: boolean; quickCheck: boolean; fts: boolean }> {
  try {
    const connection = open();
    const quickCheck = connection.prepare('PRAGMA quick_check').all().every(row => row.quick_check === 'ok');
    connection.prepare(`SELECT count(*) AS total FROM memories_fts WHERE memories_fts MATCH 'brain'`).get();
    return { available: true, quickCheck, fts: true };
  } catch { return { available: false, quickCheck: false, fts: false }; }
}
/** Chat Marks H1b: records where a memory was synchronized; content is unchanged. */
export async function brainSetRemote(id: string, remote: NonNullable<BrainMemory['remote']>): Promise<boolean> {
  return serial(() => open().prepare('UPDATE memories SET remote=? WHERE id=?').run(JSON.stringify(brainMemorySchema.shape.remote.parse(remote)), id).changes > 0);
}
