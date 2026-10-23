/**
 * Chat Marks Brain H2: the full-text index of ONE staged copy, `<staging>/index.sqlite`.
 *
 * `buildIndex` must stay self-contained: `worker.ts` runs its source text in a worker thread
 * (`Function.prototype.toString`), so it may use only its parameters, never module imports or
 * helpers outside its body. It reads staged copies only (read-only), never an original file.
 *
 * Incremental and resumable: each source/pass keeps a cursor `(time, id)` committed in the same
 * transaction as its batch of sessions, so a cancel, crash or quit resumes after the last batch.
 * Dedupe inside one index is by conversation key (OpenCode `ses_` id across every database and
 * the legacy JSON); v2 beats v1 beats legacy, then more messages, then the newer update.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface IndexSource { id: string; family: string; kind: 'opencode-db' | 'marksclaw-db' | 'legacy-json'; path: string; rel: string }
export interface IndexJob { indexPath: string; sources: IndexSource[]; batchSize?: number; maxChunkChars?: number }
export interface IndexIo {
  DatabaseSync: typeof DatabaseSync;
  fs: typeof import('node:fs');
  path: typeof import('node:path');
  progress(event: { source: string; done: number; total: number }): void;
  cancelled(): boolean;
}
export interface IndexResult { cancelled: boolean; complete: boolean; conversations: number; chunks: number; duplicates: number }

export const INDEX_VERSION = '1';

export function buildIndex(job: IndexJob, io: IndexIo): IndexResult {
  const batch = Math.max(1, Math.min(job.batchSize ?? 50, 500));
  const maxChars = Math.max(1000, Math.min(job.maxChunkChars ?? 64_000, 64_000));
  const index = new io.DatabaseSync(job.indexPath, { timeout: 5000 });
  let duplicates = 0;
  let cancelled = false;
  try {
    index.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(key TEXT PRIMARY KEY, source TEXT NOT NULL, family TEXT NOT NULL, kind TEXT NOT NULL,
 db TEXT NOT NULL, session_id TEXT NOT NULL, parent_key TEXT, title TEXT, directory TEXT, project TEXT, model TEXT,
 created INTEGER NOT NULL, updated INTEGER NOT NULL, messages INTEGER NOT NULL, rank INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS conversations_parent ON conversations(parent_key);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, conv_key TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, time INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_conv ON chunks(conv_key);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
CREATE TABLE IF NOT EXISTS cursors(source TEXT NOT NULL, pass TEXT NOT NULL, last_time INTEGER NOT NULL, last_id TEXT NOT NULL,
 done INTEGER NOT NULL, processed INTEGER NOT NULL, total INTEGER NOT NULL, PRIMARY KEY(source, pass));`);
    index.prepare(`INSERT INTO meta(k, v) VALUES ('version', ?) ON CONFLICT(k) DO NOTHING`).run('1');
    index.prepare(`INSERT INTO meta(k, v) VALUES ('complete', '0') ON CONFLICT(k) DO UPDATE SET v = '0'`).run();

    const getConversation = index.prepare('SELECT rank, messages, updated FROM conversations WHERE key = ?');
    const deleteChunks = index.prepare('DELETE FROM chunks WHERE conv_key = ?');
    const deleteConversation = index.prepare('DELETE FROM conversations WHERE key = ?');
    const insertConversation = index.prepare(`INSERT INTO conversations(key, source, family, kind, db, session_id, parent_key, title, directory, project, model, created, updated, messages, rank)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertChunk = index.prepare('INSERT INTO chunks(conv_key, seq, role, time, text) VALUES (?,?,?,?,?)');
    const getCursor = index.prepare('SELECT last_time, last_id, done, processed FROM cursors WHERE source = ? AND pass = ?');
    const putCursor = index.prepare(`INSERT INTO cursors(source, pass, last_time, last_id, done, processed, total) VALUES (?,?,?,?,?,?,?)
 ON CONFLICT(source, pass) DO UPDATE SET last_time = excluded.last_time, last_id = excluded.last_id, done = excluded.done, processed = excluded.processed, total = excluded.total`);

    type Message = { seq: number; role: string; time: number; text: string };
    type Conversation = { key: string; source: string; family: string; kind: string; db: string; sessionId: string; parentKey: string | null;
      title: string | null; directory: string | null; project: string | null; model: string | null; created: number; updated: number; rank: number };
    const num = (value: unknown, fallback = 0): number => { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : fallback; };
    const str = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null;
    const clip = (value: string): string => value.length > maxChars ? value.slice(0, maxChars) : value;

    function store(conversation: Conversation, messages: Message[]): void {
      const counted = messages.filter(message => message.role === 'user' || message.role === 'assistant').length;
      const prior = getConversation.get(conversation.key) as { rank: number; messages: number; updated: number } | undefined;
      if (prior) {
        const better = conversation.rank > prior.rank || (conversation.rank === prior.rank && (counted > prior.messages || (counted === prior.messages && conversation.updated > prior.updated)));
        if (!better) { duplicates++; return; }
        duplicates++;
        deleteChunks.run(conversation.key); deleteConversation.run(conversation.key);
      }
      insertConversation.run(conversation.key, conversation.source, conversation.family, conversation.kind, conversation.db, conversation.sessionId,
        conversation.parentKey, conversation.title, conversation.directory, conversation.project, conversation.model,
        conversation.created, conversation.updated, counted, conversation.rank);
      if (conversation.title) insertChunk.run(conversation.key, -1, 'title', conversation.created, clip(conversation.title));
      for (const message of messages) {
        const text = message.text.trim();
        if (text) insertChunk.run(conversation.key, message.seq, message.role, message.time, clip(text));
      }
    }

    /** One pass over a cursor-ordered list of sessions, `fetch(after)` returning the next batch. */
    function pass<Row>(source: IndexSource, name: string, total: number, fetch: (lastTime: number, lastId: string) => Row[],
      position: (row: Row) => [number, string], handle: (row: Row) => void): boolean {
      const cursor = getCursor.get(source.id, name) as { last_time: number; last_id: string; done: number; processed: number } | undefined;
      if (cursor?.done) { io.progress({ source: `${source.id}:${name}`, done: cursor.processed, total }); return true; }
      let lastTime = cursor?.last_time ?? -1, lastId = cursor?.last_id ?? '', processed = cursor?.processed ?? 0;
      for (;;) {
        if (io.cancelled()) { cancelled = true; return false; }
        const rows = fetch(lastTime, lastId);
        index.exec('BEGIN IMMEDIATE');
        try {
          for (const row of rows) { handle(row); [lastTime, lastId] = position(row); processed++; }
          putCursor.run(source.id, name, lastTime, lastId, rows.length < batch ? 1 : 0, processed, total);
          index.exec('COMMIT');
        } catch (error) { index.exec('ROLLBACK'); throw error; }
        io.progress({ source: `${source.id}:${name}`, done: processed, total });
        if (rows.length < batch) return true;
      }
    }

    function tablesOf(db: DatabaseSync): Set<string> {
      return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(row => row.name));
    }

    function indexOpenCode(source: IndexSource): boolean {
      const db = new io.DatabaseSync(source.path, { readOnly: true });
      try {
        const tables = tablesOf(db);
        const projectOf = tables.has('project') ? db.prepare('SELECT name, worktree FROM project WHERE id = ?') : null;
        const projectName = (id: unknown): string | null => {
          if (!projectOf || typeof id !== 'string') return null;
          const row = projectOf.get(id) as { name?: string | null; worktree?: string | null } | undefined;
          return str(row?.name) ?? (row?.worktree && row.worktree !== '/' ? io.path.basename(row.worktree) : null);
        };
        if (tables.has('session_v2') && tables.has('session_message')) {
          const total = num((db.prepare('SELECT count(*) AS n FROM session_v2').get() as { n: number }).n);
          const next = db.prepare(`SELECT id, project_id, parent_id, title, directory, model, time_created, time_updated FROM session_v2
 WHERE time_created > ? OR (time_created = ? AND id > ?) ORDER BY time_created, id LIMIT ?`);
          const messages = db.prepare(`SELECT m.seq AS seq, m.type AS role, m.time_created AS time,
 CASE WHEN m.type = 'user' THEN json_extract(m.data, '$.text')
      WHEN m.type = 'compaction' THEN json_extract(m.data, '$.summary')
      ELSE (SELECT group_concat(json_extract(j.value, '$.text'), char(10)) FROM json_each(m.data, '$.content') j WHERE json_extract(j.value, '$.type') = 'text') END AS text,
 CASE WHEN m.type = 'assistant' THEN (SELECT group_concat(json_extract(j.value, '$.name'), ' ') FROM json_each(m.data, '$.content') j WHERE json_extract(j.value, '$.type') = 'tool') END AS tools
 FROM session_message m WHERE m.session_id = ? AND m.type IN ('user', 'assistant', 'compaction') AND json_valid(m.data) ORDER BY m.seq`);
          const ok = pass(source, 'v2', total,
            (time, id) => next.all(time, time, id, batch) as Array<Record<string, unknown>>,
            row => [num(row.time_created), String(row.id)],
            row => {
              let model: string | null = null;
              if (typeof row.model === 'string') { try { const parsed = JSON.parse(row.model) as { id?: unknown }; model = str(parsed?.id) ?? str(row.model); } catch { model = str(row.model); } }
              const list = (messages.all(String(row.id)) as Array<Record<string, unknown>>).map(message => ({
                seq: num(message.seq), role: message.role === 'compaction' ? 'summary' : String(message.role), time: num(message.time),
                text: [typeof message.text === 'string' ? message.text : '', typeof message.tools === 'string' && message.tools ? `[tools: ${message.tools}]` : ''].filter(Boolean).join('\n')
              }));
              store({ key: `opencode:${row.id}`, source: source.id, family: source.family, kind: 'v2', db: source.rel, sessionId: String(row.id),
                parentKey: str(row.parent_id) ? `opencode:${row.parent_id}` : null, title: str(row.title), directory: str(row.directory),
                project: projectName(row.project_id), model, created: num(row.time_created), updated: num(row.time_updated), rank: 3 }, list);
            });
          if (!ok) return false;
        }
        if (tables.has('session') && tables.has('message')) {
          const total = num((db.prepare('SELECT count(*) AS n FROM session').get() as { n: number }).n);
          const next = db.prepare(`SELECT id, project_id, parent_id, title, directory, time_created, time_updated FROM session
 WHERE time_created > ? OR (time_created = ? AND id > ?) ORDER BY time_created, id LIMIT ?`);
          const hasPart = tables.has('part');
          const messages = db.prepare(`SELECT m.time_created AS time, json_extract(m.data, '$.role') AS role,
 ${hasPart ? `(SELECT group_concat(json_extract(p.data, '$.text'), char(10)) FROM part p WHERE p.message_id = m.id AND json_valid(p.data) AND json_extract(p.data, '$.type') = 'text' AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0)` : 'NULL'} AS text,
 ${hasPart ? `(SELECT group_concat(json_extract(p.data, '$.tool'), ' ') FROM part p WHERE p.message_id = m.id AND json_valid(p.data) AND json_extract(p.data, '$.type') = 'tool')` : 'NULL'} AS tools
 FROM message m WHERE m.session_id = ? AND json_valid(m.data) ORDER BY m.time_created, m.id`);
          const ok = pass(source, 'v1', total,
            (time, id) => next.all(time, time, id, batch) as Array<Record<string, unknown>>,
            row => [num(row.time_created), String(row.id)],
            row => {
              const list = (messages.all(String(row.id)) as Array<Record<string, unknown>>).map((message, seq) => ({
                seq, role: String(message.role ?? 'assistant'), time: num(message.time),
                text: [typeof message.text === 'string' ? message.text : '', typeof message.tools === 'string' && message.tools ? `[tools: ${message.tools}]` : ''].filter(Boolean).join('\n')
              }));
              store({ key: `opencode:${row.id}`, source: source.id, family: source.family, kind: 'v1', db: source.rel, sessionId: String(row.id),
                parentKey: str(row.parent_id) ? `opencode:${row.parent_id}` : null, title: str(row.title), directory: str(row.directory),
                project: projectName(row.project_id), model: null, created: num(row.time_created), updated: num(row.time_updated), rank: 2 }, list);
            });
          if (!ok) return false;
        }
        return true;
      } finally { db.close(); }
    }

    function indexMarksClaw(source: IndexSource): boolean {
      const db = new io.DatabaseSync(source.path, { readOnly: true });
      try {
        const tables = tablesOf(db);
        if (!tables.has('sessions')) return true;
        const names = tables.has('session_metadata') ? db.prepare('SELECT name FROM session_metadata WHERE session_key = ?') : null;
        const total = num((db.prepare('SELECT count(DISTINCT session_key) AS n FROM sessions').get() as { n: number }).n);
        const next = db.prepare(`SELECT session_key AS key, min(created_at) AS created, max(created_at) AS updated FROM sessions
 WHERE session_key > ? GROUP BY session_key ORDER BY session_key LIMIT ?`);
        const messages = db.prepare('SELECT id, role, content, created_at FROM sessions WHERE session_key = ? ORDER BY id');
        const time = (value: unknown): number => { const parsed = Date.parse(String(value ?? '')); return Number.isFinite(parsed) ? parsed : 0; };
        return pass(source, 'marksclaw', total,
          (_time, id) => next.all(id, batch) as Array<Record<string, unknown>>,
          row => [0, String(row.key)],
          row => {
            const key = String(row.key);
            const name = names ? str((names.get(key) as { name?: string } | undefined)?.name) : null;
            const list = (messages.all(key) as Array<Record<string, unknown>>).map(message => ({
              seq: num(message.id), role: String(message.role ?? 'assistant'), time: time(message.created_at), text: typeof message.content === 'string' ? message.content : '' }));
            store({ key: `marksclaw:${key}`, source: source.id, family: source.family, kind: 'marksclaw', db: source.rel, sessionId: key, parentKey: null,
              title: name ?? key, directory: null, project: null, model: null, created: time(row.created), updated: time(row.updated), rank: 1 }, list);
          });
      } finally { db.close(); }
    }

    function readJson(file: string): Record<string, unknown> | null {
      try {
        const stat = io.fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
        const value = JSON.parse(io.fs.readFileSync(file, 'utf8')) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      } catch { return null; }
    }
    function listJson(dir: string): string[] {
      try {
        const stat = io.fs.lstatSync(dir);
        if (!stat.isDirectory()) return [];
        return io.fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort();
      } catch { return []; }
    }
    function listDirs(dir: string): string[] {
      try { return io.fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); } catch { return []; }
    }

    function indexLegacy(source: IndexSource): boolean {
      const sessions: string[] = [];
      for (const project of listDirs(io.path.join(source.path, 'session'))) for (const file of listJson(io.path.join(source.path, 'session', project))) sessions.push(io.path.join('session', project, file));
      sessions.sort();
      const projects = new Map<string, string | null>();
      const projectName = (id: unknown): string | null => {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
        if (!projects.has(id)) {
          const record = readJson(io.path.join(source.path, 'project', `${id}.json`));
          const worktree = typeof record?.worktree === 'string' ? record.worktree : null;
          projects.set(id, str(record?.name) ?? (worktree && worktree !== '/' ? io.path.basename(worktree) : null));
        }
        return projects.get(id) ?? null;
      };
      return pass(source, 'legacy', sessions.length,
        (_time, last) => sessions.filter(name => name > last).slice(0, batch),
        name => [0, name],
        name => {
          const session = readJson(io.path.join(source.path, name));
          const id = str(session?.id);
          if (!session || !id || !/^[A-Za-z0-9_-]+$/.test(id)) return;
          const times = (session.time ?? {}) as Record<string, unknown>;
          const list: Message[] = [];
          for (const file of listJson(io.path.join(source.path, 'message', id))) {
            const message = readJson(io.path.join(source.path, 'message', id, file));
            const messageId = str(message?.id);
            if (!message || !messageId || !/^[A-Za-z0-9_-]+$/.test(messageId)) continue;
            const texts: string[] = [], tools: string[] = [];
            for (const partFile of listJson(io.path.join(source.path, 'part', messageId))) {
              const part = readJson(io.path.join(source.path, 'part', messageId, partFile));
              if (part?.type === 'text' && typeof part.text === 'string' && !part.synthetic) texts.push(part.text);
              if (part?.type === 'tool' && typeof part.tool === 'string') tools.push(part.tool);
            }
            const time = num(((message.time ?? {}) as Record<string, unknown>).created);
            list.push({ seq: list.length, role: String(message.role ?? 'assistant'), time, text: [texts.join('\n'), tools.length ? `[tools: ${tools.join(' ')}]` : ''].filter(Boolean).join('\n') });
          }
          list.sort((a, b) => a.time - b.time);
          store({ key: `opencode:${id}`, source: source.id, family: source.family, kind: 'legacy', db: source.rel, sessionId: id,
            parentKey: str(session.parentID) ? `opencode:${session.parentID}` : null, title: str(session.title), directory: str(session.directory),
            project: projectName(session.projectID), model: null, created: num(times.created), updated: num(times.updated ?? times.created), rank: 1 }, list);
        });
    }

    // Databases first so a legacy JSON session already in a database is recognised as a duplicate.
    const ordered = [...job.sources].sort((a, b) => Number(a.kind === 'legacy-json') - Number(b.kind === 'legacy-json'));
    let complete = true;
    for (const source of ordered) {
      const ok = source.kind === 'opencode-db' ? indexOpenCode(source) : source.kind === 'marksclaw-db' ? indexMarksClaw(source) : indexLegacy(source);
      if (!ok) { complete = false; break; }
    }
    if (complete) index.prepare(`UPDATE meta SET v = '1' WHERE k = 'complete'`).run();
    const conversations = num((index.prepare('SELECT count(*) AS n FROM conversations').get() as { n: number }).n);
    const chunks = num((index.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n);
    return { cancelled, complete, conversations, chunks, duplicates };
  } finally { index.close(); }
}
