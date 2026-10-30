import { afterEach, beforeEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureCcrFromCliProxy, plannedCcrConfig } from '../src/main/ccr/autoconfig.js';

let home: string;
let file: string;
const fixture = { gateway: { port: 3456 }, Providers: [{ name: 'Other', api_base_url: 'https://example.test', models: ['old'] }], Router: { think: 'Other,old' } };
const fakeProxy = async () => new Response('Unauthorized', { status: 401 });
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'marks-ccr-config-'));
  await mkdir(path.join(home, '.claude-code-router'));
  file = path.join(home, '.claude-code-router', 'config.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE app_config(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL)');
  db.prepare('INSERT INTO app_config VALUES (?,?,?)').run('default', JSON.stringify(fixture), 'original');
  db.close();
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it('plans defaults without replacing existing providers and custom routes', () => {
  const result = plannedCcrConfig(fixture, 'synthetic-secret');
  expect(result.changed).toBe(true);
  const next = result.config as { Providers: Array<{ name: string; api_key?: string }>; Router: Record<string, string> };
  expect(next.Providers.map(row => row.name)).toEqual(['Other', 'CLIProxy Local']);
  expect(next.Providers[1]!.api_key).toBe('synthetic-secret');
  expect(next.Router.think).toBe('Other,old');
  expect(next.Router.default).toBe('CLIProxy Local,gpt-6-luna');
  expect(plannedCcrConfig(result.config, 'synthetic-secret').changed).toBe(false);
  expect(() => plannedCcrConfig({ Providers: [{ name: 'CLIProxy Local', api_base_url: 'https://different.test' }] }, 'key')).toThrow('config_conflict');
});

it('checks a local API and key, writes once with private SQLite backup, and is idempotent', async () => {
  const config = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return JSON.parse((db.prepare("SELECT value_json FROM app_config WHERE key='default'").get() as { value_json: string }).value_json); }
    finally { db.close(); }
  };
  const key = async () => 'synthetic-secret';
  expect(await configureCcrFromCliProxy(home, { fetchImpl: fakeProxy as typeof fetch, key })).toBe('configured');
  expect(config().Router.default).toBe('CLIProxy Local,gpt-6-luna');
  const backups = (await readdir(path.dirname(file))).filter(name => name.startsWith('config.marks-backup-'));
  expect(backups).toHaveLength(1);
  expect((await stat(path.join(path.dirname(file), backups[0]!))).mode & 0o777).toBe(0o600);
  expect((await readFile(path.join(path.dirname(file), backups[0]!))).length).toBeGreaterThan(0);
  expect(await configureCcrFromCliProxy(home, { fetchImpl: fakeProxy as typeof fetch, key })).toBe('unchanged');
  expect((await readdir(path.dirname(file))).filter(name => name.startsWith('config.marks-backup-'))).toHaveLength(1);
});

it('fails closed without proxy/key/database and leaves config unchanged', async () => {
  const before = await readFile(file);
  expect(await configureCcrFromCliProxy(home, { fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch, key: async () => 'x' })).toBe('proxy_unavailable');
  expect(await configureCcrFromCliProxy(home, { fetchImpl: fakeProxy as typeof fetch, key: async () => null })).toBe('key_missing');
  expect((await readFile(file)).equals(before)).toBe(true);
});
