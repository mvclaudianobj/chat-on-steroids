/**
 * Upstream OpenCode 2.x's background service, as Chat Marks uses it (`opencode service
 * start|stop|restart`, one per user, shared by the chat engine and every OpenCode TUI).
 *
 * - The service registers itself in `<XDG_STATE_HOME>/opencode/service.json` (`{ id, version,
 *   url, pid, password }`, upstream's own file; read here, never written). Only a loopback http
 *   URL is trusted with the password, and `/api/info` must answer the registered pid.
 * - It is the app's own only when its process runs the binary this app resolved (the module's
 *   own install first; Linux checks `/proc/<pid>/exe`, an updated file shows ` (deleted)`).
 *   A service another OpenCode program started is `foreign`: the engine refuses it rather than
 *   talk to a binary outside the version gate, and only the user's Restart replaces it.
 * - Started on demand (the engine's first create/send/models or a terminal open): `<binary>
 *   service start` with the app's environment minus Electron's node mode, inherited server auth
 *   and anything pointing at MarksCode (data-preservation rule), plus
 *   `OPENCODE_DISABLE_AUTOUPDATE=1` (2.x skips its update check with it); the service inherits
 *   that environment. Nothing sets `XDG_*` or `OPENCODE_CONFIG*`: upstream's default folders.
 * - Not tied to the app's lifetime: the service and TUIs attached to it outlive a quit; open
 *   turns are re-attached on the next start (engine recovery).
 * - After an update the running service keeps the old inode. `requestOpenCodeRestart` restarts it
 *   at once when no session runs (neither an app turn nor `/api/session/active`), else marks
 *   `restartPending`, retried when a turn ends and on the next use: no running answer is cut.
 * - Windows: the same commands inside WSL (`wsl.exe --exec`), the registration read there (untested).
 */
import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deleteEnvValue, envKey, normalizeEnvironment, setEnvValue, type MutableEnvironment } from '../env.js';
import { logInfo, logWarn } from '../logger.js';
import { OpenCodeClient, OpenCodeHttpError, type OpenCodeEndpoint } from '../agent-engine/opencode-client.js';
import type { OpenCodeServiceAction, OpenCodeServiceView } from '../../shared/upstream-module.js';

/** A path into MarksCode's data or install folders (`~/.local/share/markscode`, `~/.markscode/bin`, …). */
export const MARKSCODE_PATH = /(^|[\\/:;])\.?markscode([\\/:;]|$)/i;
const MAX_REGISTRATION_BYTES = 64 * 1024;
const READY_ATTEMPTS = 40;
const READY_DELAY_MS = 250;

export const OPENCODE_SERVICE_FOREIGN = 'The OpenCode background service runs another OpenCode program, not the one Chat Marks uses. Restart it from Settings > Modules > OpenCode.';

export interface OpenCodeServiceRuntime {
  binary: string;
  /** The binary's own `--version` (probed with a private HOME). */
  version: string | null;
  windows: boolean;
}

export interface OpenCodeServiceHost {
  runtime(): Promise<OpenCodeServiceRuntime>;
  /** The registration file's text, or null when there is none. */
  registration(): Promise<string | null>;
  /** `<binary> service <action>` with the given environment (inside WSL on Windows). */
  service(runtime: OpenCodeServiceRuntime, action: OpenCodeServiceAction, env: MutableEnvironment): Promise<void>;
  /** The executable a process runs (`/proc/<pid>/exe`), or null when it cannot be told. */
  executable(pid: number, windows: boolean): Promise<string | null>;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
}

export interface OpenCodeServiceRef {
  client: OpenCodeClient;
  url: string;
  pid: number;
  version: string;
}

const run = promisify(execFile);

/** `<XDG_STATE_HOME>/opencode/service.json` (upstream's `service-config` for the `latest` channel). */
export function registrationPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'opencode', 'service.json');
}

/** The registration's URL, password and pid; only a loopback http URL is trusted with the password. */
export function parseRegistration(text: string | null): (OpenCodeEndpoint & { pid: number; version: string | null }) | null {
  if (!text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const info = parsed as { url?: unknown; password?: unknown; pid?: unknown; version?: unknown };
  if (typeof info?.url !== 'string' || typeof info.pid !== 'number' || !Number.isInteger(info.pid) || info.pid <= 1) return null;
  let url: URL;
  try { url = new URL(info.url); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) return null;
  return {
    url: url.origin, password: typeof info.password === 'string' && info.password ? info.password : null, pid: info.pid,
    version: typeof info.version === 'string' ? info.version.slice(0, 40) : null
  };
}

/** The service's environment: the app's, minus Electron's node mode, inherited server auth and MarksCode, plus no self-update. */
export function opencodeServiceEnvironment(windows: boolean, source: NodeJS.ProcessEnv = process.env): MutableEnvironment {
  const env = normalizeEnvironment(source);
  deleteEnvValue(env, 'ELECTRON_RUN_AS_NODE');
  for (const name of Object.keys(env)) if (/^OPENCODE_(SERVER_|PASSWORD$)/i.test(name)) deleteEnvValue(env, name);
  // MarksCode's folders and binaries are never handed to OpenCode: no inherited variable points
  // there and PATH loses its MarksCode entries (upstream uses its own default folders).
  for (const [name, value] of Object.entries(env)) {
    if (/^PATH$/i.test(name) || value === undefined) continue;
    if (/^MARKSCODE_/i.test(name) || MARKSCODE_PATH.test(value)) deleteEnvValue(env, name);
  }
  const pathKey = envKey(env, 'PATH');
  if (pathKey && env[pathKey]) setEnvValue(env, 'PATH', env[pathKey]!.split(windows ? ';' : ':').filter(entry => !MARKSCODE_PATH.test(entry)).join(windows ? ';' : ':'));
  setEnvValue(env, 'OPENCODE_DISABLE_AUTOUPDATE', '1');
  return env;
}

const defaultHost = (): OpenCodeServiceHost => ({
  async runtime() {
    const { cliEngineRuntime, cliUpstreamVersion } = await import('../cli-modules.js');
    const resolved = await cliEngineRuntime('opencode');
    if (!resolved.ok) throw new Error(resolved.detail);
    return { binary: resolved.binary, windows: resolved.windows, version: await cliUpstreamVersion('opencode', resolved.binary) };
  },
  async registration() {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await run('wsl.exe', ['--exec', 'sh', '-c', 'cat -- "${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service.json"'],
          { timeout: 8_000, maxBuffer: MAX_REGISTRATION_BYTES });
        return stdout;
      }
      const text = await readFile(registrationPath(), 'utf8');
      return text.length > MAX_REGISTRATION_BYTES ? null : text;
    } catch { return null; }
  },
  async service(runtime, action, env) {
    if (runtime.windows) {
      // Only the no-update flag crosses into WSL; the Windows environment is not OpenCode's.
      await run('wsl.exe', ['--exec', '/usr/bin/env', 'OPENCODE_DISABLE_AUTOUPDATE=1', runtime.binary, 'service', action],
        { timeout: 90_000, maxBuffer: 65_536, windowsHide: true });
      return;
    }
    await run(runtime.binary, ['service', action], { env, timeout: 90_000, maxBuffer: 65_536 });
  },
  async executable(pid, windows) {
    try {
      if (windows) return (await run('wsl.exe', ['--exec', '/usr/bin/readlink', '--', `/proc/${pid}/exe`], { timeout: 8_000 })).stdout.trim() || null;
      if (process.platform !== 'linux') return null;
      return await readlink(`/proc/${pid}/exe`);
    } catch { return null; }
  },
  fetch: (...args) => fetch(...args),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
});

let host: OpenCodeServiceHost = defaultHost();
let starting: Promise<OpenCodeServiceRef> | null = null;
let restartPending = false;
let busy: () => boolean = () => false;
let operations: Promise<unknown> = Promise.resolve();
/** The last verified service: every chat request asks for it, so a check is reused briefly. */
let verified: { ref: OpenCodeServiceRef; at: number } | null = null;
const VERIFIED_MS = 3_000;

export function setOpenCodeServiceHostForTests(next: Partial<OpenCodeServiceHost> | null): void {
  host = next ? { ...defaultHost(), ...next } : defaultHost();
}

/** The engine tells whether one of its turns runs (a restart waits for none). */
export function bindOpenCodeService(options: { busy(): boolean }): void {
  busy = options.busy;
}

/** One service command at a time (start, stop, restart never overlap). */
function serial<T>(work: () => Promise<T>): Promise<T> {
  verified = null;
  const next = operations.then(work, work);
  operations = next.catch(() => undefined);
  return next;
}

type Probe =
  | { state: 'stopped' }
  | { state: 'running' | 'foreign'; ref: OpenCodeServiceRef; stale: boolean };

/** What runs now, without starting anything. */
async function probe(runtime: OpenCodeServiceRuntime): Promise<Probe> {
  if (MARKSCODE_PATH.test(runtime.binary)) throw new Error('This OpenCode binary is not usable');
  const found = parseRegistration(await host.registration());
  if (!found) return { state: 'stopped' };
  const client = new OpenCodeClient(found, host.fetch);
  let info: { version?: string; pid?: number };
  try { info = await client.info(); }
  catch (error) {
    if (error instanceof OpenCodeHttpError && error.status === 401) return { state: 'foreign', ref: { client, url: found.url, pid: found.pid, version: found.version ?? '' }, stale: false };
    return { state: 'stopped' };
  }
  // A registration left by a service that died names a pid nobody answers for.
  if (info?.pid !== found.pid) return { state: 'stopped' };
  const version = typeof info.version === 'string' ? info.version.slice(0, 40) : (found.version ?? '');
  const ref: OpenCodeServiceRef = { client, url: found.url, pid: found.pid, version };
  const exe = await host.executable(found.pid, runtime.windows);
  const sameFile = exe !== null && (exe === runtime.binary || exe === `${runtime.binary} (deleted)`);
  if (exe !== null && !sameFile) return { state: 'foreign', ref, stale: false };
  // Without the executable (macOS) the version must match; with it, an older inode of our file is ours but stale.
  if (exe === null && runtime.version && version !== runtime.version) return { state: 'foreign', ref, stale: false };
  return { state: 'running', ref, stale: !!runtime.version && version !== runtime.version };
}

async function waitFor(runtime: OpenCodeServiceRuntime, want: (found: Probe) => boolean): Promise<Probe> {
  let last: Probe = { state: 'stopped' };
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    last = await probe(runtime);
    if (want(last)) return last;
    await host.sleep(READY_DELAY_MS);
  }
  return last;
}

/** Whether anything runs on the service: an app turn, or any session (a TUI's too). */
async function anythingRunning(ref: OpenCodeServiceRef): Promise<boolean> {
  if (busy()) return true;
  return (await ref.client.active().catch(() => ['unknown'])).length > 0;
}

async function command(runtime: OpenCodeServiceRuntime, action: OpenCodeServiceAction): Promise<void> {
  logInfo(`OpenCode: service ${action}`);
  try { await host.service(runtime, action, opencodeServiceEnvironment(runtime.windows)); }
  catch (error) { throw new Error(`OpenCode could not ${action} its background service`, { cause: error }); }
}

/** The running service, started (by the resolved binary) when none runs. */
export function ensureOpenCodeService(): Promise<OpenCodeServiceRef> {
  if (verified && Date.now() - verified.at < VERIFIED_MS && !restartPending) return Promise.resolve(verified.ref);
  starting ??= serial(async () => {
    const runtime = await host.runtime();
    let found = await probe(runtime);
    if (found.state === 'foreign') throw new Error(OPENCODE_SERVICE_FOREIGN);
    if (found.state === 'running') {
      if (found.stale || restartPending) {
        // An update replaced the binary: restart when nothing runs, else keep serving the old one.
        if (await anythingRunning(found.ref)) restartPending = true;
        else {
          restartPending = false;
          await command(runtime, 'restart');
          found = await waitFor(runtime, next => next.state !== 'stopped' && !(next.state === 'running' && next.stale));
        }
      }
    } else {
      await command(runtime, 'start');
      found = await waitFor(runtime, next => next.state !== 'stopped');
    }
    if (found.state === 'foreign') throw new Error(OPENCODE_SERVICE_FOREIGN);
    if (found.state !== 'running') throw new Error('The OpenCode background service did not start');
    verified = { ref: found.ref, at: Date.now() };
    return found.ref;
  }).finally(() => { starting = null; });
  return starting;
}

/** The app's own running service, without starting one (recovery); null when stopped or foreign. */
export async function runningOpenCodeService(): Promise<OpenCodeServiceRef | null> {
  const found = await probe(await host.runtime());
  return found.state === 'running' ? found.ref : null;
}

/** The service's state for Settings; never starts it. */
export async function openCodeServiceView(): Promise<OpenCodeServiceView> {
  try {
    const found = await probe(await host.runtime());
    if (found.state === 'stopped') return { state: 'stopped', port: null, version: null, restartPending };
    return { state: found.state, port: Number(new URL(found.ref.url).port) || null, version: found.ref.version || null, restartPending: restartPending || (found.state === 'running' && found.stale) };
  } catch {
    return { state: 'stopped', port: null, version: null, restartPending };
  }
}

/**
 * The module card's Start / Stop / Restart. Restart (and Start over a foreign service) replaces
 * whatever runs with the binary this app uses; it is the user's explicit choice, so it does not
 * wait for running sessions.
 */
export function openCodeServiceAction(action: OpenCodeServiceAction): Promise<OpenCodeServiceView> {
  return serial(async () => {
    const runtime = await host.runtime();
    const found = await probe(runtime);
    if (action === 'start') {
      if (found.state === 'running') return;
      await command(runtime, found.state === 'foreign' ? 'restart' : 'start');
      await waitFor(runtime, next => next.state === 'running');
    } else if (action === 'restart') {
      restartPending = false;
      await command(runtime, found.state === 'stopped' ? 'start' : 'restart');
      await waitFor(runtime, next => next.state === 'running' && !next.stale);
    } else {
      if (found.state === 'stopped') return;
      // `service stop` stops whatever is registered; a foreign service is not ours to stop.
      if (found.state === 'foreign') throw new Error(OPENCODE_SERVICE_FOREIGN);
      await command(runtime, 'stop');
      await waitFor(runtime, next => next.state === 'stopped');
    }
  }).then(() => openCodeServiceView());
}

/** Module Stop/Disable: the service stops only when it is the app's own. */
export async function stopOwnOpenCodeService(): Promise<void> {
  await serial(async () => {
    const runtime = await host.runtime().catch(() => null);
    if (!runtime) return;
    const found = await probe(runtime).catch(() => ({ state: 'stopped' }) as Probe);
    if (found.state === 'running') await command(runtime, 'stop');
  }).catch(error => logWarn(`OpenCode: service not stopped: ${(error as Error).message}`));
}

/**
 * After an update: with nothing running the service restarts at once on the new binary;
 * otherwise when the last turn ends or on the next use.
 */
export async function requestOpenCodeRestart(): Promise<void> {
  await serial(async () => {
    const runtime = await host.runtime();
    const found = await probe(runtime);
    if (found.state !== 'running') { restartPending = false; return; }
    if (await anythingRunning(found.ref)) { restartPending = true; return; }
    restartPending = false;
    await command(runtime, 'restart');
    await waitFor(runtime, next => next.state !== 'stopped');
  });
}

/** The engine calls this when a turn ends. */
export function openCodeTurnsSettled(): void {
  if (restartPending && !busy()) void requestOpenCodeRestart().catch(error => logWarn(`OpenCode: restart after update failed: ${(error as Error).message}`));
}

export const openCodeRestartPending = (): boolean => restartPending;

export function resetOpenCodeServiceForTests(): void {
  starting = null;
  restartPending = false;
  busy = () => false;
  operations = Promise.resolve();
  verified = null;
}
