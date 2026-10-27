/**
 * Chat Marks Brain H2: reads ONE conversation from a staged copy for the read-only viewer and
 * for confirmed imports. Bounded: 64k characters per message, 2k per tool output, 5 MB and
 * 5,000 messages per conversation. Everything returned is redacted.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryConversation, HistoryMessage, HistoryRef, HistoryTool } from '../../../shared/brain-import.js';
import { redactSecretText } from '../../redaction.js';
import { redactVaultText } from '../../marks-vault-redaction.js';

export const MESSAGE_CHARS = 64_000;
export const TOOL_OUTPUT_CHARS = 2_000;
export const CONVERSATION_BYTES = 5 * 1024 * 1024;
export const CONVERSATION_MESSAGES = 5_000;

export const redact = (text: string): string => redactVaultText(redactSecretText(text));

export interface IndexedConversation {
  key: string; source: string; family: string; kind: string; db: string; session_id: string; parent_key: string | null;
  title: string | null; directory: string | null; project: string | null; model: string | null; created: number; updated: number; messages: number;
}

const SAFE_ID = /^[A-Za-z0-9_:.@-]{1,200}$/;
function bounded(list: HistoryMessage[]): { messages: HistoryMessage[]; truncated: boolean } {
  let bytes = 0, truncated = false;
  const out: HistoryMessage[] = [];
  for (const message of list) {
    if (out.length >= CONVERSATION_MESSAGES) { truncated = true; break; }
    let text = message.text;
    if (text.length > MESSAGE_CHARS) { text = `${text.slice(0, MESSAGE_CHARS)}\n…`; truncated = true; }
    const tools = message.tools.map(tool => ({ name: tool.name.slice(0, 120), summary: redact(tool.summary.slice(0, 300)), output: redact(tool.output.slice(0, TOOL_OUTPUT_CHARS)) }));
    const size = text.length * 2 + tools.reduce((sum, tool) => sum + (tool.summary.length + tool.output.length) * 2, 0);
    if (bytes + size > CONVERSATION_BYTES) { truncated = true; break; }
    bytes += size;
    out.push({ role: message.role, time: message.time, text: redact(text), tools });
  }
  return { messages: out, truncated };
}

function summarize(input: unknown): string {
  if (typeof input !== 'string' || !input) return '';
  try {
    const value = JSON.parse(input) as Record<string, unknown>;
    if (value && typeof value === 'object') {
      for (const key of ['command', 'filePath', 'path', 'pattern', 'url', 'query', 'description']) if (typeof value[key] === 'string') return `${key}: ${String(value[key])}`;
    }
  } catch { /* not JSON */ }
  return input;
}

function readV2(db: DatabaseSync, id: string): HistoryMessage[] {
  const rows = db.prepare(`SELECT m.seq AS seq, m.type AS type, m.time_created AS time,
 CASE WHEN m.type = 'user' THEN json_extract(m.data, '$.text') WHEN m.type = 'compaction' THEN json_extract(m.data, '$.summary') END AS text
 FROM session_message m WHERE m.session_id = ? AND m.type IN ('user', 'assistant', 'compaction') AND json_valid(m.data) ORDER BY m.seq LIMIT ?`).all(id, CONVERSATION_MESSAGES + 1) as Array<Record<string, unknown>>;
  const parts = db.prepare(`SELECT json_extract(j.value, '$.type') AS type, substr(json_extract(j.value, '$.text'), 1, ${MESSAGE_CHARS + 1}) AS text,
 json_extract(j.value, '$.name') AS name, substr(json_extract(j.value, '$.state.input'), 1, 2000) AS input,
 substr(coalesce(json_extract(j.value, '$.state.content[0].text'), json_extract(j.value, '$.state.output'), json_extract(j.value, '$.state.error')), 1, ${TOOL_OUTPUT_CHARS}) AS output
 FROM session_message m, json_each(m.data, '$.content') j WHERE m.session_id = ? AND m.seq = ? AND json_extract(j.value, '$.type') IN ('text', 'tool') ORDER BY CAST(j.key AS INTEGER)`);
  return rows.map(row => {
    if (row.type !== 'assistant') return { role: row.type === 'compaction' ? 'summary' : 'user', time: Number(row.time), text: String(row.text ?? ''), tools: [] };
    const texts: string[] = [], tools: HistoryTool[] = [];
    for (const part of parts.all(id, row.seq as number) as Array<Record<string, unknown>>) {
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      if (part.type === 'tool') tools.push({ name: String(part.name ?? 'tool'), summary: summarize(part.input), output: String(part.output ?? '') });
    }
    return { role: 'assistant', time: Number(row.time), text: texts.join('\n'), tools };
  });
}

function readV1(db: DatabaseSync, id: string): HistoryMessage[] {
  const hasPart = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'part'`).get();
  const rows = db.prepare(`SELECT id, time_created AS time, json_extract(data, '$.role') AS role FROM message WHERE session_id = ? AND json_valid(data) ORDER BY time_created, id LIMIT ?`).all(id, CONVERSATION_MESSAGES + 1) as Array<Record<string, unknown>>;
  const parts = hasPart ? db.prepare(`SELECT json_extract(data, '$.type') AS type, substr(json_extract(data, '$.text'), 1, ${MESSAGE_CHARS + 1}) AS text, coalesce(json_extract(data, '$.synthetic'), 0) AS synthetic,
 json_extract(data, '$.tool') AS name, substr(json_extract(data, '$.state.input'), 1, 2000) AS input, substr(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error')), 1, ${TOOL_OUTPUT_CHARS}) AS output
 FROM part WHERE message_id = ? AND json_valid(data) AND json_extract(data, '$.type') IN ('text', 'tool') ORDER BY id`) : null;
  return rows.map(row => {
    const texts: string[] = [], tools: HistoryTool[] = [];
    for (const part of (parts?.all(String(row.id)) ?? []) as Array<Record<string, unknown>>) {
      if (part.type === 'text' && typeof part.text === 'string' && !Number(part.synthetic)) texts.push(part.text);
      if (part.type === 'tool') tools.push({ name: String(part.name ?? 'tool'), summary: summarize(part.input), output: String(part.output ?? '') });
    }
    return { role: String(row.role ?? 'assistant'), time: Number(row.time), text: texts.join('\n'), tools };
  });
}

function readMarksClaw(db: DatabaseSync, key: string): HistoryMessage[] {
  return (db.prepare('SELECT role, substr(content, 1, ?) AS content, created_at FROM sessions WHERE session_key = ? ORDER BY id LIMIT ?').all(MESSAGE_CHARS + 1, key, CONVERSATION_MESSAGES + 1) as Array<Record<string, unknown>>)
    .map(row => ({ role: String(row.role ?? 'assistant'), time: Date.parse(String(row.created_at ?? '')) || 0, text: String(row.content ?? ''), tools: [] }));
}

function json(file: string): Record<string, unknown> | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function names(dir: string): string[] {
  try { if (!lstatSync(dir).isDirectory()) return []; return readdirSync(dir).filter(name => name.endsWith('.json')).sort(); } catch { return []; }
}
function readLegacy(folder: string, id: string): HistoryMessage[] {
  const out: Array<HistoryMessage> = [];
  for (const file of names(path.join(folder, 'message', id))) {
    const message = json(path.join(folder, 'message', id, file));
    const messageId = typeof message?.id === 'string' && SAFE_ID.test(message.id) ? message.id : null;
    if (!message || !messageId) continue;
    const texts: string[] = [], tools: HistoryTool[] = [];
    for (const partFile of names(path.join(folder, 'part', messageId))) {
      const part = json(path.join(folder, 'part', messageId, partFile));
      if (part?.type === 'text' && typeof part.text === 'string' && !part.synthetic) texts.push(part.text);
      if (part?.type === 'tool') {
        const state = (part.state ?? {}) as Record<string, unknown>;
        tools.push({ name: String(part.tool ?? 'tool'), summary: summarize(JSON.stringify(state.input ?? '')), output: String(state.output ?? state.error ?? '') });
      }
    }
    out.push({ role: String(message.role ?? 'assistant'), time: Number(((message.time ?? {}) as Record<string, unknown>).created) || 0, text: texts.join('\n'), tools });
    if (out.length > CONVERSATION_MESSAGES) break;
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Reads the conversation an index row names; `folder` is its validated staging folder. */
export function readStagedConversation(folder: string, row: IndexedConversation, ref: HistoryRef): HistoryConversation {
  if (!SAFE_ID.test(row.session_id) || !/^(db\/[A-Za-z0-9_.-]+\.sqlite|legacy\/[A-Za-z0-9_.-]+)$/.test(row.db)) throw new Error('Invalid conversation reference');
  const file = path.join(folder, row.db);
  if (lstatSync(file).isSymbolicLink()) throw new Error('Invalid conversation reference');
  let list: HistoryMessage[];
  if (row.kind === 'legacy') list = readLegacy(file, row.session_id);
  else {
    const db = new DatabaseSync(file, { readOnly: true });
    try { list = row.kind === 'v2' ? readV2(db, row.session_id) : row.kind === 'v1' ? readV1(db, row.session_id) : readMarksClaw(db, row.session_id); }
    finally { db.close(); }
  }
  const { messages, truncated } = bounded(list.filter(message => message.text.trim() || message.tools.length));
  return { ref, key: row.key, source: row.source, family: row.family, sessionId: row.session_id, parentKey: row.parent_key,
    title: redact(row.title ?? row.session_id).slice(0, 300), project: row.project, directory: row.directory, model: row.model,
    created: row.created, updated: row.updated, messages, truncated: truncated || list.length > CONVERSATION_MESSAGES };
}
