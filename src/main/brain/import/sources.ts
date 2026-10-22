/**
 * Chat Marks Brain H2: which old-app files may be read, and which of their tables.
 *
 * Only conversation tables are ever copied. `credential`, `account`, `kv`, `auth.json` and
 * every other table or file are never opened by name, copied, indexed or archived.
 */
import os from 'node:os';
import path from 'node:path';

/** Tables an OpenCode-family database (MarksCode, OpenCode) may contribute. */
export const OPENCODE_TABLES = ['project', 'session_v2', 'session_message', 'session', 'message', 'part'] as const;
/** Tables a MarksClaw `sessions.db` may contribute. */
export const MARKSCLAW_TABLES = ['sessions', 'session_metadata'] as const;
/** Never read, whatever database they are in. Tests assert none of these names reach a copy. */
export const FORBIDDEN_TABLES = ['credential', 'account', 'account_state', 'control_account', 'kv', 'permission', 'remote_ssh_profile'] as const;
/** Legacy JSON storage subfolders worth copying (`session_diff` is file diffs, skipped). */
export const LEGACY_FOLDERS = ['session', 'message', 'part', 'project'] as const;
export const MEMORY_FILES = ['hybrid.jsonl', 'hybrid.markscode-memvid.jsonl'] as const;

export type SourceKind = 'opencode-db' | 'marksclaw-db' | 'memory' | 'legacy-json';
export interface ImportSource { id: string; family: 'opencode' | 'marksclaw' | 'memory'; kind: SourceKind; path: string }

/** Files only the administrator account can read; copied by the one pkexec export script. */
export const ADMIN_SOURCES: readonly ImportSource[] = [
  { id: 'root-markscode', family: 'opencode', kind: 'opencode-db', path: '/root/.local/share/markscode/markscode.db' },
  { id: 'root-opencode', family: 'opencode', kind: 'opencode-db', path: '/root/.local/share/opencode/opencode.db' },
  { id: 'root-markscode-11510', family: 'opencode', kind: 'opencode-db', path: '/root/.local/share/markscode/markscode-11510.db' },
  { id: 'root-markscode-143', family: 'opencode', kind: 'opencode-db', path: '/root/.local/share/markscode/markscode-143.db' },
  { id: 'root-markscode-1227_7', family: 'opencode', kind: 'opencode-db', path: '/root/.local/share/markscode/markscode-1227_7.db' },
  { id: 'root-memory', family: 'memory', kind: 'memory', path: '/root/.local/share/markscode/memory' },
  { id: 'root-legacy-markscode', family: 'opencode', kind: 'legacy-json', path: '/root/.local/share/markscode/storage' }
];

/** Files this account can read itself (copied in-process, no administrator rights). */
export function userSources(home = os.homedir()): ImportSource[] {
  return [
    { id: 'home-opencode', family: 'opencode', kind: 'opencode-db', path: path.join(home, '.local/share/markscode/opencode.db') },
    { id: 'marksclaw', family: 'marksclaw', kind: 'marksclaw-db', path: path.join(home, '.marksclaw/data/sessions/sessions.db') }
  ];
}

export function defaultStagingRoot(home = os.homedir()): string {
  return path.join(home, '.local/state/chat-marks/brain-import/staging');
}

/**
 * The statements that build one filtered copy, with the source attached as `src` and the copy
 * as `main`. The administrator script spells out the same rules in shell; a test runs both.
 * v1 sessions (session/message/part) are kept only when the database has no v2 row for them.
 */
export function filteredCopyStatements(kind: 'opencode-db' | 'marksclaw-db', tables: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (kind === 'marksclaw-db') {
    if (tables.has('sessions')) out.push('CREATE TABLE sessions AS SELECT * FROM src.sessions', 'CREATE INDEX sessions_key_idx ON sessions(session_key, id)');
    if (tables.has('session_metadata')) out.push('CREATE TABLE session_metadata AS SELECT * FROM src.session_metadata');
    return out;
  }
  const v2 = tables.has('session_v2') && tables.has('session_message');
  if (v2) out.push('CREATE TABLE session_v2 AS SELECT * FROM src.session_v2', 'CREATE TABLE session_message AS SELECT * FROM src.session_message',
    'CREATE INDEX session_message_idx ON session_message(session_id, seq)');
  if (tables.has('project')) out.push('CREATE TABLE project AS SELECT * FROM src.project');
  if (tables.has('session') && tables.has('message')) {
    out.push(`CREATE TABLE session AS SELECT * FROM src.session${v2 ? ' WHERE id NOT IN (SELECT id FROM src.session_v2)' : ''}`,
      'CREATE TABLE message AS SELECT * FROM src.message WHERE session_id IN (SELECT id FROM main.session)',
      'CREATE INDEX message_idx ON message(session_id, time_created, id)');
    if (tables.has('part')) out.push('CREATE TABLE part AS SELECT * FROM src.part WHERE session_id IN (SELECT id FROM main.session)',
      'CREATE INDEX part_idx ON part(message_id, id)');
  }
  return out;
}
