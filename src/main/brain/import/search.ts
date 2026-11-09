/**
 * Chat Marks Brain H2: topic search over the staged indexes (never the originals) and the archive.
 * Matches are grouped by conversation; a sub-agent session's matches fold under its parent.
 * Across staged copies the same conversation key appears once (the most complete copy wins).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryConversation, HistoryHit, HistoryRef, HistorySearchResult } from '../../../shared/brain-import.js';
import { archiveHas, readArchived, searchArchive } from './archive.js';
import { readStagedConversation, redact, type IndexedConversation } from './reader.js';
import { listStagings, stagingPath } from './staging.js';

/** All words must match (FTS5 implicit AND); each is quoted so no FTS syntax reaches the engine. */
export function ftsExpression(query: string): string | null {
  const tokens = query.normalize('NFC').match(/[\p{L}\p{N}_]{2,}/gu)?.slice(0, 12) ?? [];
  return tokens.length ? tokens.map(token => `"${token}"`).join(' ') : null;
}

function openIndex(root: string, stagingId: string): DatabaseSync | null {
  const file = path.join(stagingPath(root, stagingId), 'index.sqlite');
  if (!existsSync(file)) return null;
  return new DatabaseSync(file, { readOnly: true });
}

export function searchHistory(root: string, query: string, limit = 50): HistorySearchResult {
  const expression = ftsExpression(query);
  if (!expression) return { query, conversations: 0, matches: 0, hits: [] };
  const best = new Map<string, HistoryHit & { rank: number }>();
  let matches = 0;
  for (const staging of listStagings(root)) {
    let db: DatabaseSync | null = null;
    try { db = openIndex(root, staging.id); } catch { db = null; }
    if (!db) continue;
    try {
      matches += (db.prepare('SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?').get(expression) as { n: number }).n;
      const rows = db.prepare(`SELECT c.conv_key AS key, snippet(chunks_fts, 0, char(1), char(2), '…', 16) AS snippet, bm25(chunks_fts) AS score
 FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY score LIMIT 2000`).all(expression) as Array<{ key: string; snippet: string }>;
      const meta = db.prepare('SELECT * FROM conversations WHERE key = ?');
      const local = new Map<string, { row: IndexedConversation & { rank: number }; snippet: string; hits: number; sub: number }>();
      for (const row of rows) {
        let conversation = meta.get(row.key) as (IndexedConversation & { rank: number }) | undefined;
        if (!conversation) continue;
        let sub = 0;
        // Fold sub-agent sessions (up to 3 levels) under the conversation that started them.
        for (let depth = 0; depth < 3 && conversation.parent_key; depth++) {
          const parent = meta.get(conversation.parent_key) as (IndexedConversation & { rank: number }) | undefined;
          if (!parent) break;
          conversation = parent; sub = 1;
        }
        const prior = local.get(conversation.key);
        if (prior) { prior.hits++; prior.sub += sub; }
        else local.set(conversation.key, { row: conversation, snippet: row.snippet, hits: 1, sub });
      }
      for (const [key, value] of local) {
        const hit: HistoryHit & { rank: number } = {
          ref: { stagingId: staging.id, key }, source: value.row.source, family: value.row.family,
          title: redact(value.row.title ?? value.row.session_id).slice(0, 300), project: value.row.project, directory: value.row.directory,
          created: value.row.created, updated: value.row.updated, messages: value.row.messages, hits: value.hits,
          snippet: redact(value.snippet), archived: archiveHas(key), rank: value.row.rank,
          ...(value.sub ? { subagentHits: value.sub } : {})
        };
        const prior = best.get(key);
        if (!prior || hit.rank > prior.rank || (hit.rank === prior.rank && hit.messages > prior.messages)) best.set(key, hit);
      }
    } catch { /* an index being rebuilt or damaged is skipped, never repaired from here */ }
    finally { db.close(); }
  }
  const archived = searchArchive(expression, limit);
  matches += archived.matches;
  for (const hit of archived.hits) if (!best.has(hit.ref.key)) best.set(hit.ref.key, { ...hit, rank: 0 });
  const hits = [...best.values()].sort((a, b) => b.hits - a.hits || b.updated - a.updated).slice(0, limit).map(({ rank: _rank, ...hit }) => hit);
  return { query, conversations: best.size, matches, hits };
}

export function readHistory(root: string, ref: HistoryRef): HistoryConversation {
  if ('archive' in ref) {
    const found = readArchived(ref.key);
    if (!found) throw new Error('Conversation not found');
    return found;
  }
  const folder = stagingPath(root, ref.stagingId);
  const db = openIndex(root, ref.stagingId);
  if (!db) throw new Error('This staged copy has no index yet');
  let row: IndexedConversation | undefined;
  let children: Array<{ key: string; title: string | null }> = [];
  try {
    row = db.prepare('SELECT * FROM conversations WHERE key = ?').get(ref.key) as IndexedConversation | undefined;
    children = db.prepare('SELECT key, title FROM conversations WHERE parent_key = ? ORDER BY created LIMIT 200').all(ref.key) as typeof children;
  } finally { db.close(); }
  if (!row) throw new Error('Conversation not found');
  const conversation = readStagedConversation(folder, row, ref);
  if (children.length) conversation.children = children.map(child => ({ ref: { stagingId: ref.stagingId, key: child.key }, title: redact(child.title ?? child.key).slice(0, 300) }));
  return conversation;
}
