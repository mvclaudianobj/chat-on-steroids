/**
 * Chat Marks Brain H2: `<userData>/brain/archive.sqlite` (0600), conversations the user chose to
 * keep. Separate from `brain.sqlite`, so it can be deleted or rebuilt without touching memories.
 * Content arrives already bounded and redacted by the reader, and is redacted again here.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryConversation, HistoryHit } from '../../../shared/brain-import.js';
import { redact } from './reader.js';

export const ARCHIVE_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
let file = '';
let db: DatabaseSync | null = null;

export function configureArchive(filename: string): void { db?.close(); db = null; file = filename; }
export function closeArchive(): void { db?.close(); db = null; }

function open(): DatabaseSync {
  if (db) return db;
  if (!file) throw new Error('Archive unavailable');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new Error('Archive unavailable');
  const connection = new DatabaseSync(file, { timeout: 5000 });
  try {
    connection.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, family TEXT NOT NULL, first_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(key TEXT PRIMARY KEY, source TEXT NOT NULL, family TEXT NOT NULL, session_id TEXT NOT NULL,
 parent_key TEXT, title TEXT NOT NULL, directory TEXT, project TEXT, model TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
 message_count INTEGER NOT NULL, content_hash TEXT NOT NULL, archived_at INTEGER NOT NULL, truncated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, conv_key TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, time INTEGER NOT NULL, text TEXT NOT NULL, tools TEXT NOT NULL, search TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv_key, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(search, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, search) VALUES (new.id, new.search); END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, search) VALUES ('delete', old.id, old.search); END;
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL);`);
    if (connection.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) throw new Error('Archive damaged');
    chmodSync(file, 0o600);
  } catch (error) { connection.close(); throw error; }
  db = connection;
  return connection;
}

export function archiveStatus(): { available: boolean; conversations: number; bytes: number } {
  try {
    const connection = open();
    return { available: true, conversations: (connection.prepare('SELECT count(*) AS n FROM conversations').get() as { n: number }).n, bytes: lstatSync(file).size };
  } catch { return { available: false, conversations: 0, bytes: 0 }; }
}

export function archiveHas(key: string): boolean {
  try { return !!open().prepare('SELECT 1 FROM conversations WHERE key = ?').get(key); } catch { return false; }
}

/** Keeps one conversation. Idempotent by key: an already archived conversation is not duplicated. */
export function archiveConversation(conversation: HistoryConversation, limitBytes = ARCHIVE_LIMIT_BYTES): { key: string; added: boolean } {
  const connection = open();
  if (connection.prepare('SELECT 1 FROM conversations WHERE key = ?').get(conversation.key)) return { key: conversation.key, added: false };
  const size = conversation.messages.reduce((sum, message) => sum + message.text.length * 2 + JSON.stringify(message.tools).length, 0);
  if (lstatSync(file).size + size > limitBytes) throw new Error('The archive size limit was reached');
  const messages = conversation.messages.map(message => ({ ...message, text: redact(message.text),
    tools: message.tools.map(tool => ({ name: tool.name, summary: redact(tool.summary), output: redact(tool.output) })) }));
  const hash = createHash('sha256').update(JSON.stringify(messages.map(message => [message.role, message.text]))).digest('hex');
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.prepare('INSERT INTO sources(id, family, first_seen) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').run(conversation.source, conversation.family, Date.now());
    connection.prepare(`INSERT INTO conversations(key, source, family, session_id, parent_key, title, directory, project, model, created, updated, message_count, content_hash, archived_at, truncated)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(conversation.key, conversation.source, conversation.family, conversation.sessionId, conversation.parentKey,
      redact(conversation.title), conversation.directory, conversation.project, conversation.model, conversation.created, conversation.updated,
      messages.length, hash, Date.now(), conversation.truncated ? 1 : 0);
    const insert = connection.prepare('INSERT INTO messages(conv_key, seq, role, time, text, tools, search) VALUES (?,?,?,?,?,?,?)');
    insert.run(conversation.key, -1, 'title', conversation.created, redact(conversation.title), '[]', redact(conversation.title));
    messages.forEach((message, seq) => insert.run(conversation.key, seq, message.role, message.time, message.text, JSON.stringify(message.tools),
      [message.text, ...message.tools.map(tool => `[${tool.name}] ${tool.summary}`)].filter(Boolean).join('\n')));
    connection.exec('COMMIT');
  } catch (error) { connection.exec('ROLLBACK'); throw error; }
  return { key: conversation.key, added: true };
}

export function readArchived(key: string): HistoryConversation | null {
  const connection = open();
  const row = connection.prepare('SELECT * FROM conversations WHERE key = ?').get(key) as Record<string, unknown> | undefined;
  if (!row) return null;
  const messages = (connection.prepare('SELECT role, time, text, tools FROM messages WHERE conv_key = ? AND seq >= 0 ORDER BY seq').all(key) as Array<Record<string, unknown>>)
    .map(message => ({ role: String(message.role), time: Number(message.time), text: String(message.text),
      tools: JSON.parse(String(message.tools)) as Array<{ name: string; summary: string; output: string }> }));
  return { ref: { archive: true, key }, key, source: String(row.source), family: String(row.family), sessionId: String(row.session_id),
    parentKey: (row.parent_key as string | null) ?? null, title: String(row.title), project: (row.project as string | null) ?? null,
    directory: (row.directory as string | null) ?? null, model: (row.model as string | null) ?? null, created: Number(row.created), updated: Number(row.updated),
    messages, truncated: Number(row.truncated) === 1 };
}

export function removeArchived(key: string): boolean {
  const connection = open();
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.prepare('DELETE FROM messages WHERE conv_key = ?').run(key);
    const changed = connection.prepare('DELETE FROM conversations WHERE key = ?').run(key).changes > 0;
    connection.exec('COMMIT');
    return changed;
  } catch (error) { connection.exec('ROLLBACK'); throw error; }
}

export function searchArchive(expression: string, limit: number): { hits: HistoryHit[]; matches: number } {
  let connection: DatabaseSync;
  try { connection = open(); } catch { return { hits: [], matches: 0 }; }
  const matches = (connection.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(expression) as { n: number }).n;
  const rows = connection.prepare(`SELECT m.conv_key AS key, snippet(messages_fts, 0, char(1), char(2), '…', 16) AS snippet, bm25(messages_fts) AS score
 FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY score LIMIT 400`).all(expression) as Array<{ key: string; snippet: string }>;
  const grouped = new Map<string, { snippet: string; hits: number }>();
  for (const row of rows) { const prior = grouped.get(row.key); if (prior) prior.hits++; else grouped.set(row.key, { snippet: row.snippet, hits: 1 }); }
  const meta = connection.prepare('SELECT source, family, title, project, directory, created, updated, message_count FROM conversations WHERE key = ?');
  const hits: HistoryHit[] = [];
  for (const [key, value] of grouped) {
    const row = meta.get(key) as Record<string, unknown> | undefined;
    if (!row) continue;
    hits.push({ ref: { archive: true, key }, source: String(row.source), family: String(row.family), title: String(row.title), project: (row.project as string) ?? null,
      directory: (row.directory as string) ?? null, created: Number(row.created), updated: Number(row.updated), messages: Number(row.message_count),
      hits: value.hits, snippet: redact(value.snippet), archived: true });
    if (hits.length >= limit) break;
  }
  return { hits, matches };
}
