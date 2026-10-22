/**
 * Chat Marks: the Claude Code Router module (main side). Finds the copies of CCR, installs and
 * updates Chat Marks' own copy (or, confirmed, the copy the user installed), starts, stops and
 * restarts its daemon through its own CLI, reports its state, opens its web UI, and tells the chat
 * routes (agent-engine/router.ts) whether the router can take a chat now.
 *
 * Copies
 * - Managed: `<userData>/modules/ccr/versions/v<x.y.z>-<id>/` (an npm prefix), the one in use named
 *   by `<userData>/modules/ccr/current`, plus a `bin/ccr` launcher. A new version is a new folder;
 *   the pointer is replaced by rename, so a running daemon keeps the files it was started from,
 *   and an older folder is removed only when no daemon runs from it. It takes precedence over PATH.
 * - External: the `ccr` on PATH (or the usual npm prefixes), shown as "Using installed <path>
 *   <version>". It is used as it is; updating it in place needs the user's confirmation and a
 *   prefix the user can write (no administrator rights are ever asked).
 *
 * Service (checked against 3.1.3): `ccr start --daemon --no-open` starts `cli.js serve
 * --daemon-child` (web UI) and a gateway child (the address Codex and Claude Code use, default
 * 127.0.0.1:3456) and exits; `ccr stop` stops the daemon `service.json` names. Its stdout carries
 * the web UI address with its token, so it is never logged or returned. State: the gateway's own
 * `GET /health` (`{"status":"ok",…}`), plus the process list for which copy runs. The gateway
 * address is read, read-only, from CCR's config store (`~/.claude-code-router/config.sqlite`,
 * `app_config` `default` → `gateway.host`/`gateway.port`, nothing else), else from the user's CLI
 * files, else 127.0.0.1:3456.
 *
 * The user's files: this module never writes `~/.claude/settings.json`, `~/.codex/config.toml`
 * or anything in `~/.claude-code-router` (CCR edits those itself), never prints or copies a key.
 * After an update the router restarts only when no routed Codex/Claude Code turn runs.
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { logInfo, logWarn } from '../logger.js';
import { isNewerVersion } from '../github-release.js';
import { downloadNpmTarball } from '../npm-release.js';
import {
  detectClaudeRouter, detectCodexRouter, registerRouterAvailability, routedTurnsRunning, routerAddressFromCliFiles, type RouterUnavailable
} from '../agent-engine/router.js';
import {
  CCR_NPM_PACKAGE, CCR_VERSION,
  type CcrInstallation, type CcrInstallMode, type CcrInstallProgress, type CcrServiceAction, type CcrServiceView, type CcrStatus
} from '../../shared/ccr-module.js';
import {
  CCR_CLI, CCR_TARBALL_LIMIT, ccrLatest, ccrRelease, ccrServiceArgv, ccrSupport, minimumNodeMajor, NATIVE_CHECK_SCRIPT, nodeMajor,
  npmInstallArgv, npmRebuildArgv
} from './release.js';

const exec = promisify(execFile);
const PACKAGE_PATH = `node_modules/${CCR_NPM_PACKAGE}`;
/** Where an npm prefix keeps a global package's CLI (`<prefix>/lib/node_modules/@musistudio/claude-code-router/dist/main/cli.js`). */
const GLOBAL_CLI = /^(\/.+)\/lib\/node_modules\/@musistudio\/claude-code-router\/dist\/main\/cli\.js$/;
const VERSION_DIR = /^v(\d+(?:\.\d+){2})-[0-9a-f]{8}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._@+/ -]{1,900}$/;
const DEFAULT_ADDRESS = { host: '127.0.0.1', port: 3456 };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const AVAILABILITY_TTL_MS = 5_000;
const LATEST_TTL_MS = 60 * 60_000;
const RESTART_POLL_MS = 5_000;

export interface CcrHost {
  platform: NodeJS.Platform;
  home(): string;
  /** `<userData>/modules`. */
  modulesRoot(): Promise<string>;
  env(): NodeJS.ProcessEnv;
  run(file: string, args: string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<{ stdout: string; stderr: string }>;
  /** `ps -eo pid=,args=` (Linux), for which copy a running daemon came from. */
  processList(): Promise<string>;
  /** CCR's own gateway address from its config store, read-only; null when it cannot be read. */
  configAddress(home: string): Promise<{ host: string; port: number } | null>;
  /** `which <name>`, absolute or null. */
  which(name: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  fetchImpl?: typeof fetch;
  now(): number;
}

async function defaultRun(file: string, args: string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await exec(file, args, {
    timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL', env: options.env ?? process.env, cwd: options.cwd, windowsHide: true
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** Reads only `gateway.host`/`gateway.port` (and the legacy `HOST`/`PORT`) of CCR's default config, read-only. */
export async function readCcrConfigAddress(home: string): Promise<{ host: string; port: number } | null> {
  const file = path.join(home, '.claude-code-router', 'config.sqlite');
  try { await fs.access(file, fsConstants.R_OK); } catch { return null; }
  let db: { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void } | null = null;
  try {
    // Node's built-in SQLite (Electron's Node 24), loaded only here; a variable keeps the bundler
    // from resolving a builtin it does not list.
    const builtin = 'node:sqlite';
    const { DatabaseSync } = await import(/* @vite-ignore */ builtin) as unknown as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => NonNullable<typeof db> };
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT value_json FROM app_config WHERE key = 'default'").get() as { value_json?: unknown } | undefined;
    if (typeof row?.value_json !== 'string' || row.value_json.length > 4 * 1024 * 1024) return null;
    return ccrAddressFromConfig(JSON.parse(row.value_json));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

/** The gateway address CCR's config names (`gateway.port`, else `PORT`); an any-address host is reached on loopback. */
export function ccrAddressFromConfig(config: unknown): { host: string; port: number } | null {
  if (!config || typeof config !== 'object') return null;
  const value = config as { gateway?: { host?: unknown; port?: unknown }; HOST?: unknown; PORT?: unknown };
  const port = Number(value.gateway?.port ?? value.PORT);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  const raw = typeof value.gateway?.host === 'string' ? value.gateway.host : typeof value.HOST === 'string' ? value.HOST : '127.0.0.1';
  const host = raw === '0.0.0.0' || raw === '' ? '127.0.0.1' : raw === '::' || raw === '[::]' ? '::1' : raw.replace(/^\[|\]$/g, '');
  return LOOPBACK.has(host) ? { host, port } : { host: '127.0.0.1', port };
}

function realHost(): CcrHost {
  return {
    platform: process.platform,
    home: () => os.homedir(),
    modulesRoot: async () => path.join((await import('electron')).app.getPath('userData'), 'modules'),
    env: () => process.env,
    run: defaultRun,
    processList: async () => (await defaultRun('/bin/ps', ['-eo', 'pid=,args='], { timeoutMs: 5_000 })).stdout,
    configAddress: readCcrConfigAddress,
    which: async name => {
      try {
        const out = (await defaultRun('/usr/bin/env', ['which', name], { timeoutMs: 5_000 })).stdout.split(/\r?\n/)[0]?.trim();
        return out && out.startsWith('/') ? out : null;
      } catch { return null; }
    },
    openExternal: async url => { await (await import('electron')).shell.openExternal(url); },
    now: () => Date.now()
  };
}

let host: CcrHost = realHost();
export function setCcrHostForTests(next: Partial<CcrHost> | null): void {
  host = next ? { ...realHost(), ...next } : realHost();
  resetCcrStateForTests();
}

// ------------------------------------------------------------------ copies

const tilde = (file: string): string => {
  const home = host.home();
  return home && (file === home || file.startsWith(`${home}/`)) ? `~${file.slice(home.length)}` : file;
};

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

/** The package's own version, when the folder holds exactly this package. */
export async function packageVersion(packageDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8');
    if (raw.length > 256 * 1024) return null;
    const body = JSON.parse(raw) as { name?: unknown; version?: unknown; bin?: { ccr?: unknown } };
    if (body.name !== CCR_NPM_PACKAGE || typeof body.version !== 'string' || !CCR_VERSION.test(body.version)) return null;
    return body.bin?.ccr === CCR_CLI || body.bin?.ccr === `./${CCR_CLI}` ? body.version : null;
  } catch { return null; }
}

export const ccrModuleDir = (modulesRoot: string): string => path.join(modulesRoot, 'ccr');

interface Copy { kind: 'managed' | 'external'; version: string | null; cli: string; packageDir: string; prefix: string | null; writable: boolean }

/** Chat Marks' own copy: the version folder `current` names, when its package and CLI are there. */
export async function locateManaged(modulesRoot: string): Promise<Copy | null> {
  const dir = ccrModuleDir(modulesRoot);
  let name: string;
  try { name = (await fs.readFile(path.join(dir, 'current'), 'utf8')).trim(); } catch { return null; }
  if (!VERSION_DIR.test(name)) return null;
  const prefix = path.join(dir, 'versions', name);
  const packageDir = path.join(prefix, PACKAGE_PATH);
  const cli = path.join(packageDir, CCR_CLI);
  if (!await exists(cli)) return null;
  const version = await packageVersion(packageDir);
  return version ? { kind: 'managed', version, cli, packageDir, prefix, writable: true } : null;
}

/** The usual places a user's npm puts `ccr` when the app's PATH (a desktop launch) lacks them. */
const externalCandidates = (home: string): string[] => [
  path.join(home, '.local', 'bin', 'ccr'), path.join(home, '.npm-global', 'bin', 'ccr'), path.join(home, '.volta', 'bin', 'ccr'),
  '/usr/local/bin/ccr', '/usr/bin/ccr'
];

/** A `ccr` the user installed (PATH first): it must resolve to this npm package's CLI. */
export async function locateExternal(modulesRoot: string): Promise<Copy | null> {
  const managedDir = ccrModuleDir(modulesRoot);
  const found = [await host.which('ccr'), ...externalCandidates(host.home())].filter((entry): entry is string => !!entry);
  for (const candidate of found) {
    let real: string;
    try { real = await fs.realpath(candidate); } catch { continue; }
    if (real.startsWith(`${managedDir}/`) || !real.endsWith(`/${PACKAGE_PATH}/${CCR_CLI}`)) continue;
    const packageDir = real.slice(0, -(CCR_CLI.length + 1));
    const version = await packageVersion(packageDir);
    if (!version) continue;
    const prefix = GLOBAL_CLI.exec(real)?.[1] ?? null;
    let writable = false;
    if (prefix) {
      try {
        await fs.access(path.dirname(packageDir), fsConstants.W_OK);
        await fs.access(packageDir, fsConstants.W_OK);
        writable = true;
      } catch { writable = false; }
    }
    return { kind: 'external', version, cli: real, packageDir, prefix, writable };
  }
  return null;
}

const view = (copy: Copy | null): CcrInstallation | null => copy
  ? { kind: copy.kind, version: copy.version, path: tilde(copy.kind === 'managed' ? path.join(path.dirname(path.dirname(copy.prefix!)), 'bin', 'ccr') : copy.cli),
    ...(copy.kind === 'external' ? { writable: copy.writable && !!copy.prefix } : {}) }
  : null;

/** Node.js and npm for running and installing CCR: absolute paths and the Node.js major. */
async function nodeTools(): Promise<{ node: string | null; npm: string | null; major: number | null }> {
  const node = await host.which('node') ?? ((await exists('/usr/bin/node')) ? '/usr/bin/node' : (await exists('/usr/local/bin/node')) ? '/usr/local/bin/node' : null);
  const npm = await host.which('npm') ?? (node && await exists(path.join(path.dirname(node), 'npm')) ? path.join(path.dirname(node), 'npm') : null);
  let major: number | null = null;
  if (node) {
    try { major = nodeMajor((await host.run(node, ['--version'], { timeoutMs: 8_000 })).stdout); } catch { major = null; }
  }
  return { node, npm, major };
}

/**
 * The environment CCR's own processes get: the user's, without the app's Electron/npm variables,
 * with the Node.js folder first on PATH (the daemon spawns `node` children).
 */
export function ccrEnvironment(base: NodeJS.ProcessEnv, node: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || /^(ELECTRON_|npm_|NODE_OPTIONS$|CHROME_DESKTOP$|ORIGINAL_XDG_)/i.test(key)) continue;
    env[key] = value;
  }
  if (node) env.PATH = [path.dirname(node), ...(env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').filter(entry => entry && entry !== path.dirname(node))].join(':');
  env.NO_COLOR = '1';
  return env;
}

// ------------------------------------------------------------------ service

/** A running CCR daemon from the process list: `<pid> <node> …/claude-code-router/dist/main/cli.js serve --daemon-child …`. */
export function parseDaemonProcesses(listing: string): Array<{ pid: number; cli: string }> {
  const found: Array<{ pid: number; cli: string }> = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[2]!;
    const cli = /(\/\S*\/@musistudio\/claude-code-router\/dist\/main\/cli\.js)\s+(?:serve|web|start|ui)\b(.*)$/.exec(args);
    if (!cli || !/--daemon-child\b/.test(cli[2] ?? '')) continue;
    found.push({ pid: Number(match[1]), cli: cli[1]! });
  }
  return found;
}

/** `/health` of the gateway: running when it answers 200 with a JSON object that has a `status`. */
export async function probeHealth(address: { host: string; port: number }, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const hostPart = address.host.includes(':') ? `[${address.host}]` : address.host;
  try {
    const response = await fetchImpl(`http://${hostPart}:${address.port}/health`, { redirect: 'error', signal: AbortSignal.timeout(1_500), headers: { Accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const text = (await response.text()).slice(0, 8192);
    const body = JSON.parse(text) as unknown;
    return !!body && typeof body === 'object' && typeof (body as { status?: unknown }).status === 'string';
  } catch { return false; }
}

/** The gateway address: CCR's config store, else the CLI files' router URL, else 127.0.0.1:3456. */
export async function gatewayAddress(): Promise<{ host: string; port: number }> {
  const home = host.home();
  return await host.configAddress(home).catch(() => null)
    ?? routerAddressFromCliFiles({ home, env: host.env(), platform: host.platform })
    ?? DEFAULT_ADDRESS;
}

/**
 * The web UI address CCR registered in `~/.claude-code-router/service.json` (`url`, with its own
 * one-time token): only an http loopback URL of a live pid. Never returned to the renderer or logged.
 */
export async function webUiUrl(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(host.home(), '.claude-code-router', 'service.json'), 'utf8');
    if (raw.length > 64 * 1024) return null;
    const body = JSON.parse(raw) as { url?: unknown; pid?: unknown };
    if (typeof body.url !== 'string' || typeof body.pid !== 'number' || !Number.isInteger(body.pid) || body.pid <= 1) return null;
    const url = new URL(body.url);
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, '')) || url.username || url.password) return null;
    try { process.kill(body.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null; }
    return url.toString();
  } catch { return null; }
}

// ------------------------------------------------------------------ state

let latestCache: { at: number; version: string } | null = null;
let lastInstall: CcrInstallProgress | null = null;
let installing = false;
let restartPending = false;
let restartTimer: NodeJS.Timeout | null = null;
let operations: Promise<unknown> = Promise.resolve();
let availability: { at: number; value: RouterUnavailable | null } | null = null;
let availabilityRun: Promise<void> | null = null;

export function resetCcrStateForTests(): void {
  latestCache = null; lastInstall = null; installing = false; restartPending = false;
  if (restartTimer) clearInterval(restartTimer);
  restartTimer = null; operations = Promise.resolve(); availability = null; availabilityRun = null;
}

/** One service or install operation at a time. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = operations.then(task, task);
  operations = next.catch(() => undefined);
  return next;
}

async function copies(): Promise<{ root: string; managed: Copy | null; external: Copy | null; inUse: Copy | null }> {
  const root = await host.modulesRoot();
  const [managed, external] = await Promise.all([locateManaged(root).catch(() => null), locateExternal(root).catch(() => null)]);
  return { root, managed, external, inUse: managed ?? external };
}

async function serviceView(root: string, external: Copy | null): Promise<CcrServiceView> {
  const address = await gatewayAddress();
  const [running, listing, ui] = await Promise.all([
    probeHealth(address, host.fetchImpl),
    host.platform === 'linux' ? host.processList().catch(() => '') : Promise.resolve(''),
    webUiUrl()
  ]);
  const daemon = parseDaemonProcesses(listing)[0] ?? null;
  const managedRoot = `${ccrModuleDir(root)}/`;
  const from = !daemon ? null : daemon.cli.startsWith(managedRoot) ? 'managed' : external && daemon.cli === external.cli ? 'external' : 'other';
  return {
    state: running ? 'running' : 'stopped', host: address.host, port: address.port, pid: daemon?.pid ?? null,
    from: running || daemon ? from : null, ui: !!ui, restartPending, routedTurns: routedTurnsRunning()
  };
}

/** Why a configured router cannot take a chat now (cached 5 s): not installed, or its gateway does not answer. */
export async function refreshCcrAvailability(force = false): Promise<RouterUnavailable | null> {
  // Windows runs the CLIs inside WSL, where no router is detected (router.ts): nothing to check.
  if (host.platform === 'win32') return null;
  if (!force && availability && host.now() - availability.at < AVAILABILITY_TTL_MS) return availability.value;
  availabilityRun ??= (async () => {
    try {
      const { inUse } = await copies();
      const value: RouterUnavailable | null = !inUse ? 'not_installed' : await probeHealth(await gatewayAddress(), host.fetchImpl) ? null : 'stopped';
      availability = { at: host.now(), value };
    } finally { availabilityRun = null; }
  })();
  await availabilityRun;
  return availability?.value ?? null;
}

/** The cached answer for router.ts (refreshed before each send, status and view). */
export const ccrAvailability = (): RouterUnavailable | null => availability?.value ?? null;

export function bindCcrRouting(): void {
  registerRouterAvailability(ccrAvailability, async () => { await refreshCcrAvailability(); });
}

async function latest(refresh: boolean): Promise<{ version: string | null; error?: string }> {
  if (!refresh && latestCache && host.now() - latestCache.at < LATEST_TTL_MS) return { version: latestCache.version };
  try {
    const version = await ccrLatest(host.fetchImpl);
    latestCache = { at: host.now(), version };
    return { version };
  } catch { return { version: null, error: 'release_unavailable' }; }
}

export async function ccrStatus(refresh = false): Promise<CcrStatus> {
  const { root, managed, external, inUse } = await copies();
  const [found, tools, service] = await Promise.all([latest(refresh), host.platform === 'linux' ? nodeTools() : Promise.resolve(null), serviceView(root, external)]);
  const latestSupport = ccrSupport(found.version);
  const newer = isNewerVersion(inUse?.version ?? null, found.version);
  const blocked: CcrStatus['installBlocked'] = host.platform !== 'linux' ? 'unsupported_platform'
    : !tools?.node ? 'node_missing' : (tools.major ?? 0) < 22 ? 'node_too_old' : !tools.npm ? 'npm_missing' : undefined;
  const claude = detectClaudeRouter({ home: host.home(), env: host.env(), platform: host.platform }).detected;
  const codex = detectCodexRouter({ home: host.home(), env: host.env(), platform: host.platform }).detected;
  availability = { at: host.now(), value: !inUse ? 'not_installed' : service.state === 'running' ? null : 'stopped' };
  return {
    managed: view(managed), external: view(external), inUse: inUse?.kind ?? null,
    latest: found.version, ...(found.error ? { latestError: found.error } : {}),
    updateAvailable: newer && latestSupport !== 'unsupported',
    latestUnsupported: latestSupport === 'unsupported' && (!inUse || newer),
    support: ccrSupport(inUse?.version ?? null),
    installable: !blocked, ...(blocked ? { installBlocked: blocked } : {}),
    service, configured: { claude, codex }, install: lastInstall
  };
}

// ------------------------------------------------------------------ service actions

async function runCli(copy: Copy, args: string[], timeoutMs: number): Promise<void> {
  const tools = await nodeTools();
  if (!tools.node) throw new Error('node_missing');
  // stdout names the web UI with its token: neither logged nor returned.
  await host.run(tools.node, [copy.cli, ...args], { timeoutMs, env: ccrEnvironment(host.env(), tools.node), cwd: host.home() });
}

async function waitFor(running: boolean, timeoutMs: number): Promise<boolean> {
  const address = await gatewayAddress();
  const until = host.now() + timeoutMs;
  for (;;) {
    if (await probeHealth(address, host.fetchImpl) === running) return true;
    if (host.now() >= until) return false;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

async function start(copy: Copy): Promise<void> {
  if (await probeHealth(await gatewayAddress(), host.fetchImpl)) return;
  await runCli(copy, ccrServiceArgv('start'), 60_000).catch(error => { throw new Error('start_failed', { cause: error }); });
  if (!await waitFor(true, 20_000)) throw new Error('start_failed');
  logInfo(`Claude Code Router: started (${copy.kind} ${copy.version ?? ''})`);
}

async function stop(copy: Copy): Promise<void> {
  await runCli(copy, ccrServiceArgv('stop'), 30_000).catch(error => { throw new Error('stop_failed', { cause: error }); });
  if (!await waitFor(false, 15_000)) throw new Error('stop_failed');
  logInfo('Claude Code Router: stopped');
}

export async function ccrService(action: CcrServiceAction): Promise<CcrStatus> {
  await serial(async () => {
    const { inUse } = await copies();
    if (!inUse) throw new Error('not_installed');
    if (action === 'start') await start(inUse);
    else if (action === 'stop') await stop(inUse);
    else {
      if (await probeHealth(await gatewayAddress(), host.fetchImpl)) await stop(inUse);
      await start(inUse);
      restartPending = false;
    }
  });
  availability = null;
  return ccrStatus();
}

export async function ccrOpenUi(): Promise<void> {
  const url = await webUiUrl();
  if (!url) throw new Error('ui_unavailable');
  await host.openExternal(url);
}

/**
 * After an update: a running router restarts with the copy in use now, at once when no routed
 * turn runs, else when the last one ends (checked every 5 s). A stopped router stays stopped.
 */
export async function requestCcrRestart(): Promise<void> {
  if (!await probeHealth(await gatewayAddress(), host.fetchImpl)) { restartPending = false; return; }
  if (routedTurnsRunning()) {
    restartPending = true;
    if (!restartTimer) {
      restartTimer = setInterval(() => {
        if (routedTurnsRunning()) return;
        if (restartTimer) clearInterval(restartTimer);
        restartTimer = null;
        void ccrService('restart').catch(error => logWarn(`Claude Code Router: restart after update failed: ${(error as Error).message}`));
      }, RESTART_POLL_MS);
      restartTimer.unref?.();
    }
    return;
  }
  await ccrService('restart');
}

export const ccrRestartPending = (): boolean => restartPending;

// ------------------------------------------------------------------ install

/** Whether a version folder may be removed: not the current one, and no daemon runs from it. */
export async function pruneVersions(root: string): Promise<void> {
  const dir = ccrModuleDir(root);
  let current = '';
  try { current = (await fs.readFile(path.join(dir, 'current'), 'utf8')).trim(); } catch { return; }
  const listing = await host.processList().catch(() => null);
  if (listing === null) return;
  const running = parseDaemonProcesses(listing).map(entry => entry.cli);
  let names: string[] = [];
  try { names = await fs.readdir(path.join(dir, 'versions')); } catch { return; }
  for (const name of names) {
    if (name === current || !VERSION_DIR.test(name)) continue;
    const folder = path.join(dir, 'versions', name);
    if (running.some(cli => cli.startsWith(`${folder}/`))) continue;
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeAtomic(file: string, content: string, mode: number): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode });
  await fs.rename(temporary, file);
}

/** The launcher Chat Marks' copy is started with from a terminal: `exec <node> <cli> "$@"`. */
export function launcherScript(node: string, cli: string): string {
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# Chat Marks: its own copy of Claude Code Router (Settings > Modules).\nexec ${quote(node)} ${quote(cli)} "$@"\n`;
}

/**
 * Installs `expected` (the version the user confirmed): `install`/`update` into Chat Marks' own
 * folder, `update-external` over the copy the user installed (its npm prefix, confirmed in the UI).
 */
export async function ccrInstall(mode: CcrInstallMode, expected: string, onProgress: (progress: CcrInstallProgress) => void = () => undefined): Promise<CcrStatus> {
  if (installing) throw new Error('install_running');
  installing = true;
  let progress: CcrInstallProgress = { mode, phase: 'downloading', version: expected };
  const report = (next: Partial<CcrInstallProgress>): void => { progress = { ...progress, ...next }; lastInstall = progress; onProgress(progress); };
  let stage: string | null = null;
  try {
    if (host.platform !== 'linux') throw new Error('unsupported_platform');
    if (!CCR_VERSION.test(expected) || ccrSupport(expected) === 'unsupported') throw new Error('unsupported_version');
    const tools = await nodeTools();
    if (!tools.node) throw new Error('node_missing');
    if (!tools.npm) throw new Error('npm_missing');
    const { root, external } = await copies();
    if (!SAFE_PATH.test(root)) throw new Error('install_failed');
    if (mode === 'update-external' && (!external?.prefix || !external.writable || !SAFE_PATH.test(external.prefix))) throw new Error('external_not_writable');
    report({ phase: 'downloading' });
    const meta = await ccrRelease(expected, host.fetchImpl);
    if ((tools.major ?? 0) < minimumNodeMajor(meta.engines.node)) throw new Error('node_too_old');
    const tarball = await downloadNpmTarball(meta, CCR_TARBALL_LIMIT, host.fetchImpl);
    report({ phase: 'verifying' });
    const dir = ccrModuleDir(root);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const folder of [root, dir]) if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error('install_failed');
    stage = path.join(dir, `.stage-${randomUUID()}`);
    await fs.mkdir(stage, { mode: 0o700 });
    const tarballFile = path.join(stage, 'package.tgz');
    await fs.writeFile(tarballFile, tarball, { mode: 0o600 });
    const userconfig = path.join(stage, 'npmrc');
    await fs.writeFile(userconfig, '', { mode: 0o600 });
    const env = ccrEnvironment(host.env(), tools.node);
    // npm's own cache stays the user's; nothing else of npm's configuration is read.
    for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
    report({ phase: 'installing' });
    const prefix = mode === 'update-external' ? external!.prefix! : path.join(stage, 'app');
    const packageDir = mode === 'update-external' ? external!.packageDir : path.join(prefix, PACKAGE_PATH);
    try {
      await host.run(tools.npm, npmInstallArgv(prefix, tarballFile, userconfig, mode === 'update-external'), { timeoutMs: 600_000, env, cwd: stage });
      // A prefix hoists the tree into its own node_modules; a global package keeps its own.
      await host.run(tools.npm, npmRebuildArgv(mode === 'update-external' ? packageDir : prefix, userconfig), { timeoutMs: 600_000, env, cwd: stage });
    } catch (error) { throw new Error('npm_failed', { cause: error }); }
    report({ phase: 'checking' });
    if (await packageVersion(packageDir) !== expected) throw new Error('version_mismatch');
    const sqlite = mode === 'update-external' ? path.join(packageDir, 'node_modules', 'better-sqlite3') : path.join(prefix, 'node_modules', 'better-sqlite3');
    try { await host.run(tools.node, ['-e', NATIVE_CHECK_SCRIPT, sqlite], { timeoutMs: 30_000, env }); }
    catch (error) { throw new Error('native_failed', { cause: error }); }
    if (mode !== 'update-external') {
      const name = `v${expected}-${randomBytes(4).toString('hex')}`;
      await fs.mkdir(path.join(dir, 'versions'), { recursive: true, mode: 0o700 });
      const target = path.join(dir, 'versions', name);
      await fs.rename(prefix, target);
      const cli = path.join(target, PACKAGE_PATH, CCR_CLI);
      await fs.mkdir(path.join(dir, 'bin'), { recursive: true, mode: 0o700 });
      await writeAtomic(path.join(dir, 'bin', 'ccr'), launcherScript(tools.node, cli), 0o700);
      await writeAtomic(path.join(dir, 'current'), `${name}\n`, 0o600);
    }
    report({ phase: 'done' });
    logInfo(`Claude Code Router: ${mode === 'update-external' ? 'updated the installed copy to' : 'installed'} ${expected} (npm integrity verified)`);
  } catch (error) {
    const known = ['unsupported_platform', 'unsupported_version', 'node_missing', 'node_too_old', 'npm_missing', 'external_not_writable', 'release_unavailable',
      'version_changed', 'download_failed', 'checksum_mismatch', 'npm_failed', 'version_mismatch', 'native_failed', 'install_running'];
    const code = known.includes((error as Error).message) ? (error as Error).message : 'install_failed';
    logWarn(`Claude Code Router: install ${expected} failed: ${code}`);
    report({ phase: 'failed', error: code });
    throw new Error(code, { cause: error });
  } finally {
    installing = false;
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
  latestCache = null;
  availability = null;
  await requestCcrRestart().catch(error => logWarn(`Claude Code Router: installed, but it did not restart yet: ${(error as Error).message}`));
  await pruneVersions(await host.modulesRoot()).catch(() => undefined);
  return ccrStatus();
}
