/** Idempotent CCR 3.x configuration. The secret never leaves main; backups remain private. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { apiChatKey } from '../api-chat/settings.js';

export type CcrAutoConfigState = 'configured' | 'unchanged' | 'proxy_unavailable' | 'key_missing' | 'config_unavailable';
const MODEL = 'gpt-6-luna';
const PROVIDER = 'CLIProxy Local';
const ROUTE = `${PROVIDER},${MODEL}`;
const BASE = 'http://127.0.0.1:18081/v1/chat/completions';

export function plannedCcrConfig(source: unknown, key: string): { changed: boolean; config: Record<string, unknown> } {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('config_unavailable');
  const config = source as Record<string, unknown>;
  const entries = Array.isArray(config.Providers) ? config.Providers : [];
  if (entries.some(entry => entry && typeof entry === 'object' && (entry as { name?: unknown }).name === PROVIDER &&
      (entry as { api_base_url?: unknown }).api_base_url !== BASE)) throw new Error('config_conflict');
  const prior = entries.find(entry => entry && typeof entry === 'object' && (entry as { name?: unknown }).name === PROVIDER) as Record<string, unknown> | undefined;
  const provider = { ...(prior ?? {}), name: PROVIDER, api_base_url: BASE, api_key: key,
    models: [...new Set([...(Array.isArray(prior?.models) ? prior.models.filter((item): item is string => typeof item === 'string') : []), MODEL])] };
  const routes = config.Router && typeof config.Router === 'object' && !Array.isArray(config.Router) ? config.Router as Record<string, unknown> : {};
  // Preserve explicit custom routes. Only fill absent defaults; never replace a working user choice.
  const next = { ...config, Providers: [...entries.filter(entry => !(entry && typeof entry === 'object' && (entry as { name?: unknown }).name === PROVIDER)), provider],
    Router: { ...routes, ...(routes.default ? {} : { default: ROUTE }), ...(routes.background ? {} : { background: ROUTE }) } };
  return { config: next, changed: JSON.stringify(config) !== JSON.stringify(next) };
}

/** The file is owned by CCR. Operate only on its known SQLite store and retain a private backup. */
export async function configureCcrFromCliProxy(home: string, options: {
  fetchImpl?: typeof fetch;
  key?: () => Promise<string | null>;
} = {}): Promise<CcrAutoConfigState> {
  let response: Response;
  try { response = await (options.fetchImpl ?? fetch)('http://127.0.0.1:18081/v1/models', { signal: AbortSignal.timeout(2500) }); }
  catch { return 'proxy_unavailable'; }
  if (response.status >= 500 || response.status === 404) return 'proxy_unavailable';
  const key = await (options.key ?? apiChatKey)();
  if (!key) return 'key_missing';
  const file = path.join(home, '.claude-code-router', 'config.sqlite');
  type CcrDatabase = {
    prepare(sql: string): { get(): unknown; run(...args: unknown[]): unknown };
    close(): void;
  };
  let db: CcrDatabase | null = null;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return 'config_unavailable';
    const builtin = 'node:sqlite';
    const sqlite = await import(/* @vite-ignore */ builtin) as unknown as {
      DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => CcrDatabase;
      backup: (db: CcrDatabase, destination: string) => Promise<unknown>;
    };
    db = new sqlite.DatabaseSync(file);
    const row = db.prepare("SELECT value_json FROM app_config WHERE key = 'default'").get() as { value_json?: unknown } | undefined;
    if (typeof row?.value_json !== 'string' || row.value_json.length > 4 * 1024 * 1024) return 'config_unavailable';
    const { changed, config } = plannedCcrConfig(JSON.parse(row.value_json), key);
    if (!changed) return 'unchanged';
    const backup = path.join(path.dirname(file), `config.marks-backup-${Date.now()}.sqlite`);
    // Exclusive private backup with SQLite's online-backup API, which respects WAL state.
    await sqlite.backup(db, backup);
    await fs.chmod(backup, 0o600);
    db.prepare("UPDATE app_config SET value_json = ?, updated_at = ? WHERE key = 'default'")
      .run(JSON.stringify(config), new Date().toISOString());
    return 'configured';
  } catch { return 'config_unavailable'; }
  finally { try { db?.close(); } catch { /* close only */ } }
}
