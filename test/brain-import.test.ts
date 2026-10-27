import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ADMIN_EXPORT_SCRIPT, adminExportCommand, adminExportScript, manualExportCommand, runAdminExport } from '../src/main/brain/import/admin-export.js';
import { buildIndex, type IndexSource } from '../src/main/brain/import/indexer.js';
import { startIndexWorker } from '../src/main/brain/import/worker.js';
import { FORBIDDEN_TABLES, type ImportSource } from '../src/main/brain/import/sources.js';
import { exportUserSources } from '../src/main/brain/import/user-export.js';
import { listStagings, readManifest } from '../src/main/brain/import/staging.js';
import { configureBrainImport, handleBrainImport, runBrainImport } from '../src/main/brain/import/ipc.js';
import { materializeConversation, type MaterializeDeps } from '../src/main/brain/import/materialize.js';
import { memoryContentHash } from '../src/main/brain/import/memories.js';
import { closeArchive } from '../src/main/brain/import/archive.js';
import { brainList, brainSave, configureBrainForTests } from '../src/main/brain/store.js';
import type { HistoryConversation, HistorySearchResult } from '../src/shared/brain-import.js';

const MARKER = 'CREDENTIAL_MARKER_7f3a';
const TOKEN = `ghp_${'B'.repeat(40)}`;
let dir = '';
const originals: string[] = [];
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
function hashes(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (target: string): void => {
    const stat = lstatSync(target);
    if (stat.isDirectory()) for (const name of readdirSync(target).sort()) walk(path.join(target, name));
    else if (stat.isFile() && !target.endsWith('-shm')) out[target] = sha(target);
  };
  for (const file of originals) for (const candidate of [file, `${file}-wal`]) { try { walk(candidate); } catch { /* absent */ } }
  return out;
}
function allBytesContain(root: string, needle: string): boolean {
  let found = false;
  const walk = (target: string): void => {
    const stat = lstatSync(target);
    if (stat.isDirectory()) for (const name of readdirSync(target)) walk(path.join(target, name));
    else if (stat.isFile() && readFileSync(target).includes(needle)) found = true;
  };
  walk(root);
  return found;
}

function opencodeDb(file: string, options: { v2: boolean; v1: boolean; secrets?: boolean; sessions: Array<{ id: string; title: string; parent?: string; v1Only?: boolean; texts: string[] }> }): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER, time_updated INTEGER, sandboxes TEXT);
INSERT INTO project VALUES ('p1', '/work/chat-marks', NULL, 1, 1, '[]');`);
  if (options.secrets) db.exec(`CREATE TABLE credential (id TEXT, value TEXT); INSERT INTO credential VALUES ('c', '${MARKER}');
CREATE TABLE account (id TEXT, token TEXT); INSERT INTO account VALUES ('a', '${MARKER}');
CREATE TABLE kv (k TEXT, v TEXT); INSERT INTO kv VALUES ('k', '${MARKER}');`);
  if (options.v2) db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  if (options.v1) db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  let time = 1_700_000_000_000;
  for (const session of options.sessions) {
    time += 1000;
    if (options.v2 && !session.v1Only) {
      db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(session.id, 'p1', session.parent ?? null, 's', '/work/chat-marks', session.title, '1', 'build', JSON.stringify({ id: 'gpt-x', providerID: 'p' }), time, time + 10);
      session.texts.forEach((text, seq) => {
        const data = seq % 2 === 0 ? { text, time: { created: time } }
          : { agent: 'build', content: [{ type: 'text', text }, { type: 'tool', id: 't', name: 'bash', state: { status: 'completed', input: { command: 'npm test' }, content: [{ type: 'text', text: `ran ${MARKER.slice(0, 3)}` }] } }], time: { created: time } };
        db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(`${session.id}-m${seq}`, session.id, seq % 2 === 0 ? 'user' : 'assistant', seq, time + seq, time + seq, JSON.stringify(data));
      });
    }
    if (options.v1) {
      db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)').run(session.id, 'p1', session.parent ?? null, 's', '/work/chat-marks', session.title, '1', time, time + 10);
      session.texts.forEach((text, seq) => {
        const mid = `msg_${session.id}_${seq}`;
        db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(mid, session.id, time + seq, time + seq, JSON.stringify({ role: seq % 2 === 0 ? 'user' : 'assistant' }));
        db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(`prt_${mid}`, mid, session.id, time + seq, time + seq, JSON.stringify({ type: 'text', text }));
      });
    }
  }
  db.close();
}

let mixed = '', v1only = '', marksclaw = '', memory = '', legacy = '', stagingRoot = '';
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'marks-brain-import-'));
  const sources = path.join(dir, 'sources');
  mkdirSync(sources);
  mixed = path.join(sources, 'markscode.db');
  opencodeDb(mixed, { v2: true, v1: true, secrets: true, sessions: [
    { id: 'ses_aaa', title: 'Electron window bug', texts: ['why does the electron window flicker', `fixed it, token ${TOKEN}`] },
    { id: 'ses_child', title: 'Subagent research', parent: 'ses_aaa', texts: ['subagent electron probe', 'subagent answer'] },
    { id: 'ses_v1only', title: 'Old session', v1Only: true, texts: ['legacy electron question', 'legacy answer'] },
    { id: 'ses_ccc', title: 'Unrelated', texts: ['cooking recipes', 'pasta'] }
  ] });
  v1only = path.join(sources, 'markscode-143.db');
  opencodeDb(v1only, { v2: false, v1: true, sessions: [
    { id: 'ses_aaa', title: 'Electron window bug (old copy)', texts: ['why does the electron window flicker'] },
    { id: 'ses_ddd', title: 'Electron packaging', texts: ['electron builder packaging', 'done'] }
  ] });
  // MarksClaw: rows only in the WAL. The source files are copied while a writer holds them.
  const writer = path.join(dir, 'writer.db');
  const live = new DatabaseSync(writer);
  live.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE session_metadata (session_key TEXT PRIMARY KEY, created_at TEXT, last_activity TEXT, message_count INTEGER, name TEXT);
CREATE TABLE devices_secret (k TEXT); INSERT INTO devices_secret VALUES ('${MARKER}');
INSERT INTO sessions(session_key, role, content, created_at) VALUES ('claw-1', 'user', 'marksclaw electron gateway', '2026-01-01T00:00:00Z'), ('claw-1', 'assistant', 'gateway ok', '2026-01-01T00:00:01Z');
INSERT INTO session_metadata VALUES ('claw-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 2, 'Claw chat');`);
  marksclaw = path.join(sources, 'sessions.db');
  copyFileSync(writer, marksclaw); copyFileSync(`${writer}-wal`, `${marksclaw}-wal`); copyFileSync(`${writer}-shm`, `${marksclaw}-shm`);
  live.close();
  expect(statSync(`${marksclaw}-wal`).size).toBeGreaterThan(0);
  memory = path.join(sources, 'memory');
  mkdirSync(memory);
  writeFileSync(path.join(memory, 'hybrid.jsonl'), [
    { source: 'markscode', user_id: 'u', type: 'semantic', memory_mode: 'long_term', subject: 'Build', content: 'Chat Marks builds with electron-vite', importance: 0.8, tags: ['build'], source_path: '', source_id: 'mem-1', metadata: {} },
    { source: 'markscode', type: 'episodic', memory_mode: 'short_term', subject: 'Key', content: `Deploy key ${TOKEN}`, importance: 0.4, tags: [], source_id: 'mem-2', metadata: {} }
  ].map(row => JSON.stringify(row)).join('\n') + '\nnot json\n');
  writeFileSync(path.join(memory, 'hybrid.markscode-memvid.jsonl'), JSON.stringify({ id: 'mv-1', content: 'Memvid note about FTS5', source_id: 'mv-1', title: 'Memvid', uri: 'x', metadata: {} }) + '\n');
  legacy = path.join(sources, 'storage');
  const put = (rel: string, value: unknown): void => { mkdirSync(path.dirname(path.join(legacy, rel)), { recursive: true }); writeFileSync(path.join(legacy, rel), JSON.stringify(value)); };
  put('session/p1/ses_aaa.json', { id: 'ses_aaa', projectID: 'p1', directory: '/work', title: 'dup', time: { created: 1, updated: 2 } });
  put('session/p1/ses_leg.json', { id: 'ses_leg', projectID: 'p1', directory: '/work', title: 'Legacy electron notes', time: { created: 5, updated: 6 } });
  put('message/ses_leg/msg_l1.json', { id: 'msg_l1', sessionID: 'ses_leg', role: 'user', time: { created: 5 } });
  put('part/msg_l1/prt_1.json', { id: 'prt_1', type: 'text', text: 'electron legacy json text' });
  put('project/p1.json', { id: 'p1', worktree: '/work/legacy-project' });
  put('session_diff/ses_leg.json', { diff: MARKER });
  writeFileSync(path.join(sources, 'auth.json'), JSON.stringify({ token: MARKER }));
  originals.push(mixed, v1only, marksclaw, memory, legacy);
  stagingRoot = path.join(dir, 'staging');
  configureBrainForTests(path.join(dir, 'brain.sqlite'));
  configureBrainImport({ stagingRoot, archivePath: path.join(dir, 'userData', 'brain', 'archive.sqlite'),
    userSources: [{ id: 'home-opencode', family: 'opencode', kind: 'opencode-db', path: mixed }, { id: 'marksclaw', family: 'marksclaw', kind: 'marksclaw-db', path: marksclaw }] });
});
afterAll(() => { closeArchive(); configureBrainForTests(path.join(tmpdir(), 'marks-brain-unused.sqlite')); rmSync(dir, { recursive: true, force: true }); });

const adminSources = (): ImportSource[] => [
  { id: 'root-markscode', family: 'opencode', kind: 'opencode-db', path: mixed },
  { id: 'root-markscode-143', family: 'opencode', kind: 'opencode-db', path: v1only },
  { id: 'root-missing', family: 'opencode', kind: 'opencode-db', path: path.join(dir, 'sources', 'absent.db') },
  { id: 'root-memory', family: 'memory', kind: 'memory', path: memory },
  { id: 'root-legacy-markscode', family: 'opencode', kind: 'legacy-json', path: legacy }
];
const hasSqlite = process.platform === 'linux' && spawnSync('sqlite3', ['-version']).status === 0;
let adminStaging = '';

describe('H2 administrator export script', () => {
  it('is one constant pkexec shell script without single quotes or forbidden tables', () => {
    const [command, args] = adminExportCommand('12345678-1234-1234-1234-123456789abc');
    expect(command).toBe('/usr/bin/pkexec');
    expect(args).toEqual(['/bin/sh', '-c', ADMIN_EXPORT_SCRIPT, 'chat-marks-brain-export', '12345678-1234-1234-1234-123456789abc']);
    expect(ADMIN_EXPORT_SCRIPT).not.toContain("'");
    expect(ADMIN_EXPORT_SCRIPT).toContain('sqlite3 -readonly');
    expect(ADMIN_EXPORT_SCRIPT).toContain('mode=ro&immutable=1');
    expect(ADMIN_EXPORT_SCRIPT).toContain('/root/.local/share/markscode/markscode.db');
    for (const table of FORBIDDEN_TABLES) expect(ADMIN_EXPORT_SCRIPT).not.toMatch(new RegExp(`\\b(FROM|TABLE) (src\\.)?${table}\\b`));
    expect(ADMIN_EXPORT_SCRIPT).not.toContain('auth.json');
    expect(() => adminExportCommand('x; rm -rf /')).toThrow();
    expect(manualExportCommand('12345678-1234-1234-1234-123456789abc')).toMatch(/^sudo \/bin\/sh -c '[^']+' chat-marks-brain-export 12345678-/);
  });

  it('maps pkexec cancellation and failures without running anything else', async () => {
    const calls: string[][] = [];
    await expect(runAdminExport(path.join(dir, 'cancel-root'), () => undefined, async (command, args) => { calls.push([command, ...args]); return { code: 126, stderr: '' }; }))
      .rejects.toThrow('cancelled');
    await expect(runAdminExport(path.join(dir, 'cancel-root'), () => undefined, async () => ({ code: 1, stderr: 'error: not enough free space: 9 bytes needed, 1 available\n' })))
      .rejects.toThrow('not enough free space');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual(['/usr/bin/pkexec', '/bin/sh', '-c']);
  });

  it.skipIf(!hasSqlite)('makes a filtered, owned, verified copy and never changes the originals', () => {
    const before = hashes();
    const base = path.join(dir, 'admin-staging');
    mkdirSync(base, { mode: 0o700 });
    const uid = process.getuid!() === 0 ? 65534 : process.getuid!();
    if (process.getuid!() === 0) chownSync(base, uid, 65534);
    const id = '0f0f0f0f-1111-4222-8333-444455556666';
    const script = adminExportScript({ sources: adminSources(), base });
    const run = spawnSync('/bin/sh', ['-c', script, 'chat-marks-brain-export', id], { env: { ...process.env, PKEXEC_UID: String(uid) }, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`export-complete ${id}`);
    const folder = path.join(base, id);
    expect(statSync(folder).uid).toBe(uid);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const manifest = readManifest(folder)!;
    expect(manifest.complete).toBe(true);
    const byId = Object.fromEntries(manifest.sources.map(source => [source.id, source]));
    expect(byId['root-markscode']).toMatchObject({ status: 'copied', unchanged: true, counts: { session_v2: 3, session: 1, project: 1 } });
    expect(byId['root-markscode-143']).toMatchObject({ status: 'copied', unchanged: true, counts: { session: 2 } });
    expect(byId['root-missing']!.status).toBe('missing');
    expect(byId['root-memory:hybrid.jsonl']).toMatchObject({ status: 'copied', unchanged: true });
    expect(byId['root-legacy-markscode']).toMatchObject({ status: 'copied', unchanged: true });
    const copy = new DatabaseSync(path.join(folder, 'db', 'root-markscode.sqlite'), { readOnly: true });
    const tables = (copy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(row => row.name).sort();
    expect(tables).toEqual(['message', 'part', 'project', 'session', 'session_message', 'session_v2']);
    expect((copy.prepare('SELECT id FROM session').all() as Array<{ id: string }>).map(row => row.id)).toEqual(['ses_v1only']);
    copy.close();
    expect(readdirSync(path.join(folder, 'legacy', 'root-legacy-markscode')).sort()).toEqual(['message', 'part', 'project', 'session']);
    expect(allBytesContain(folder, MARKER)).toBe(false);
    expect(hashes()).toEqual(before);
    // Hand the copy to the import pipeline under the test staging root.
    if (process.getuid!() === 0) execFileSync('chown', ['-R', `${process.getuid!()}:${process.getgid!()}`, folder]);
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    fs.renameSync(folder, path.join(stagingRoot, id));
    adminStaging = id;
  });

  it.skipIf(!hasSqlite)('refuses to run as the administrator target, a foreign folder or a bad id', () => {
    const script = adminExportScript({ sources: adminSources(), base: path.join(dir, 'nowhere') });
    const bad = spawnSync('/bin/sh', ['-c', script, 'x', 'not-a-uuid'], { env: { ...process.env, PKEXEC_UID: '1000' }, encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
    const root = spawnSync('/bin/sh', ['-c', script, 'x', '0f0f0f0f-1111-4222-8333-444455556667'], { env: { ...process.env, PKEXEC_UID: '0' }, encoding: 'utf8' });
    expect(root.stderr).toContain('must not be the administrator');
  });
});

let userStaging = '';
describe('H2 user-readable export, index and search', () => {
  it('copies db, WAL and shm, keeps only conversation tables, and leaves originals unchanged', async () => {
    const before = hashes();
    const { stagingId, manifest } = await exportUserSources(stagingRoot, [
      { id: 'home-opencode', family: 'opencode', kind: 'opencode-db', path: mixed },
      { id: 'marksclaw', family: 'marksclaw', kind: 'marksclaw-db', path: marksclaw }
    ]);
    userStaging = stagingId;
    const folder = path.join(stagingRoot, stagingId);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(manifest.sources.map(source => [source.id, source.status, source.unchanged])).toEqual([['home-opencode', 'copied', true], ['marksclaw', 'copied', true]]);
    expect(manifest.sources[1]!.counts).toMatchObject({ sessions: 2, conversations: 1 });
    const claw = new DatabaseSync(path.join(folder, 'db', 'marksclaw.sqlite'), { readOnly: true });
    expect((claw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(row => row.name).sort()).toEqual(['session_metadata', 'sessions']);
    claw.close();
    expect(allBytesContain(folder, MARKER)).toBe(false);
    expect(hashes()).toEqual(before);
  });

  it('indexes resumably in batches, dedupes ses_ ids across copies and skips legacy duplicates', async () => {
    const indexPath = path.join(dir, 'resume-index.sqlite');
    const folder = path.join(stagingRoot, userStaging);
    const sources: IndexSource[] = [{ id: 'home-opencode', family: 'opencode', kind: 'opencode-db', path: path.join(folder, 'db/home-opencode.sqlite'), rel: 'db/home-opencode.sqlite' }];
    let batches = 0;
    const io = (stopAfter: number) => ({ DatabaseSync, fs, path, progress: () => { batches++; }, cancelled: () => batches >= stopAfter });
    const first = buildIndex({ indexPath, sources, batchSize: 1 }, io(1));
    expect(first).toMatchObject({ cancelled: true, complete: false, conversations: 1 });
    const second = buildIndex({ indexPath, sources, batchSize: 1 }, io(Infinity));
    expect(second).toMatchObject({ cancelled: false, complete: true, conversations: 4 });
    const again = buildIndex({ indexPath, sources, batchSize: 1 }, io(Infinity));
    expect(again.conversations).toBe(4);
    expect(again.chunks).toBe(second.chunks);
  });

  it.skipIf(!hasSqlite)('builds the admin copy index in a worker thread, preferring v2 and folding sub-agents', async () => {
    const reply = await handleBrainImport('import.index', { stagingId: adminStaging }, () => undefined) as { jobId: string };
    expect(reply.jobId).toMatch(/-/);
    const deadline = Date.now() + 20_000;
    while ((await handleBrainImport('import.status', {}, () => undefined) as { running: unknown }).running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const view = listStagings(stagingRoot).find(staging => staging.id === adminStaging)!;
    // ses_aaa (v2 beats the v1 copy), ses_child, ses_v1only, ses_ccc, ses_ddd, ses_leg; legacy ses_aaa skipped.
    expect(view.index).toMatchObject({ state: 'complete', conversations: 6 });
    const result = await handleBrainImport('history.search', { query: 'electron' }, () => undefined) as HistorySearchResult;
    const titles = result.hits.map(hit => hit.title).sort();
    expect(titles).toEqual(['Electron packaging', 'Electron window bug', 'Legacy electron notes', 'Old session']);
    const window = result.hits.find(hit => hit.title === 'Electron window bug')!;
    expect(window.subagentHits).toBeGreaterThan(0);
    expect(window.snippet).toContain('\u0001');
    const read = await handleBrainImport('history.read', { ref: window.ref }, () => undefined) as HistoryConversation;
    expect(read.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(read.messages[1]!.text).not.toContain('ghp_');
    expect(read.messages[1]!.tools[0]).toMatchObject({ name: 'bash', summary: 'command: npm test' });
    expect(read.children?.map(child => child.title)).toEqual(['Subagent research']);
    expect(read.project).toBe('chat-marks');
  });

  it('runs the real worker source directly', async () => {
    const indexPath = path.join(dir, 'worker-index.sqlite');
    const folder = path.join(stagingRoot, userStaging);
    const handle = startIndexWorker({ indexPath, sources: [{ id: 'marksclaw', family: 'marksclaw', kind: 'marksclaw-db', path: path.join(folder, 'db/marksclaw.sqlite'), rel: 'db/marksclaw.sqlite' }] }, () => undefined);
    await expect(handle.promise).resolves.toMatchObject({ complete: true, conversations: 1 });
  });
});

describe('H2 confirmed imports', () => {
  const staged = (): { stagingId: string } => ({ stagingId: hasSqlite ? adminStaging : userStaging });
  async function firstHit(query: string) {
    if (!listStagings(stagingRoot).find(view => view.id === userStaging)?.index.conversations) {
      const folder = path.join(stagingRoot, userStaging);
      buildIndex({ indexPath: path.join(folder, 'index.sqlite'), sources: [
        { id: 'home-opencode', family: 'opencode', kind: 'opencode-db', path: path.join(folder, 'db/home-opencode.sqlite'), rel: 'db/home-opencode.sqlite' },
        { id: 'marksclaw', family: 'marksclaw', kind: 'marksclaw-db', path: path.join(folder, 'db/marksclaw.sqlite'), rel: 'db/marksclaw.sqlite' }] },
      { DatabaseSync, fs, path, progress: () => undefined, cancelled: () => false });
    }
    return (await handleBrainImport('history.search', { query }, () => undefined) as HistorySearchResult).hits[0]!;
  }

  it('requires an explicit confirmation for every write', async () => {
    const hit = await firstHit('flicker');
    for (const [action, payload] of [['import.archive', { ref: hit.ref }], ['import.openChat', { ref: hit.ref }], ['import.memory', { ref: hit.ref, content: 'x' }],
      ['import.deleteStaging', staged()], ['import.adminExport', {}], ['import.userExport', {}]] as const) {
      expect(await runBrainImport(action, payload, () => undefined)).toEqual({ ok: false, error: 'Brain request failed or input was invalid' });
    }
  });

  it('keeps a conversation in the archive once, searchable later, and saves a user-written memory with provenance', async () => {
    const hit = await firstHit('flicker');
    const kept = await handleBrainImport('import.archive', { ref: hit.ref, confirmed: true }, () => undefined);
    expect(kept).toEqual({ key: 'opencode:ses_aaa', added: true });
    expect(await handleBrainImport('import.archive', { ref: hit.ref, confirmed: true }, () => undefined)).toEqual({ key: 'opencode:ses_aaa', added: false });
    const archive = path.join(dir, 'userData', 'brain', 'archive.sqlite');
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    expect(readFileSync(archive).includes('ghp_')).toBe(false);
    const again = await handleBrainImport('history.search', { query: 'flicker' }, () => undefined) as HistorySearchResult;
    expect(again.hits.find(item => item.ref.key === 'opencode:ses_aaa')?.archived).toBe(true);
    const fromArchive = await handleBrainImport('history.read', { ref: { archive: true, key: 'opencode:ses_aaa' } }, () => undefined) as HistoryConversation;
    expect(fromArchive.messages).toHaveLength(2);
    const memory = await handleBrainImport('import.memory', { ref: hit.ref, content: 'The flicker was fixed by disabling GPU compositing', confirmed: true }, () => undefined) as { provenance: unknown };
    expect(memory.provenance).toEqual({ source: 'import', importedFrom: { source: 'markscode-history', sourceId: 'opencode:ses_aaa' } });
    expect(await handleBrainImport('archive.remove', { key: 'opencode:ses_aaa', confirmed: true }, () => undefined)).toBe(true);
  });

  it.skipIf(!hasSqlite)('previews hybrid memories and imports only the selected ones, once', async () => {
    const preview = await handleBrainImport('import.memories.preview', { stagingId: adminStaging }, () => undefined) as Array<{ index: number; content: string; duplicate: boolean; file: string }>;
    expect(preview.map(item => item.file)).toEqual(['hybrid.jsonl', 'hybrid.jsonl', 'hybrid.markscode-memvid.jsonl']);
    expect(preview[1]!.content).not.toContain('ghp_');
    expect(preview.every(item => !item.duplicate)).toBe(true);
    const before = (await brainList()).length;
    expect(await handleBrainImport('import.memories.import', { stagingId: adminStaging, indexes: [0, 2], confirmed: true }, () => undefined)).toEqual({ saved: 2, skipped: 0 });
    expect((await brainList()).length).toBe(before + 2);
    expect(await handleBrainImport('import.memories.import', { stagingId: adminStaging, indexes: [0, 2], confirmed: true }, () => undefined)).toEqual({ saved: 0, skipped: 2 });
    const after = await handleBrainImport('import.memories.preview', { stagingId: adminStaging }, () => undefined) as Array<{ duplicate: boolean }>;
    expect(after.map(item => item.duplicate)).toEqual([true, false, true]);
  });

  it('hashes memory content exactly like the Brain store', async () => {
    const saved = await brainSave({ content: '  Hash   Parity Check ' });
    expect(memoryContentHash('  Hash   Parity Check ')).toBe(saved.contentHash);
  });

  it('opens a conversation as a read-only MarksCode chat, reusing an existing link', async () => {
    const records: Record<string, { engine?: string; backendSessionId?: string }> = {};
    const events: Array<{ id: string; kind: string; messageId?: string }> = [];
    const deps: MaterializeDeps = {
      records: async () => records, exists: async id => id in records,
      createSession: async () => ({ id: `s${Object.keys(records).length + 1}` }),
      setRecord: async (id, record) => { records[id] = record; },
      upsertMessage: async (id, event) => { events.push({ id, kind: event.kind, messageId: (event as { messageId?: string }).messageId }); },
      append: async (id, event) => { events.push({ id, kind: event.kind }); },
      changed: () => undefined
    };
    const conversation: HistoryConversation = { ref: { archive: true, key: 'opencode:ses_x' }, key: 'opencode:ses_x', source: 'root', family: 'opencode', sessionId: 'ses_x',
      parentKey: null, title: 'T', project: null, directory: null, model: 'gpt-x', created: 1, updated: 2, truncated: false,
      messages: [{ role: 'user', time: 1, text: 'q', tools: [] }, { role: 'assistant', time: 2, text: 'a', tools: [{ name: 'bash', summary: 'ls', output: '' }] }] };
    expect(await materializeConversation(conversation, 'cosapi-', deps)).toEqual({ sessionId: 's1', created: true });
    expect(records.s1).toMatchObject({ engine: 'markscode', backendSessionId: 'ses_x' });
    expect(events.map(event => event.kind)).toEqual(['user_message', 'turn_start', 'assistant_message', 'turn_end']);
    expect(await materializeConversation(conversation, 'cosapi-', deps)).toEqual({ sessionId: 's1', created: false });
  });

  it('deletes a staged copy only on confirmation and never an original', async () => {
    const before = hashes();
    expect(await handleBrainImport('import.deleteStaging', { stagingId: userStaging, confirmed: true }, () => undefined)).toBe(true);
    expect(listStagings(stagingRoot).some(view => view.id === userStaging)).toBe(false);
    expect(hashes()).toEqual(before);
    chmodSync(stagingRoot, 0o700);
  });
});
