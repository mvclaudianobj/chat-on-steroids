/**
 * The one upstream OpenCode server the app runs for its `opencode` chats (Chat Marks).
 *
 * - `opencode serve --hostname 127.0.0.1 --port 0 --no-mdns`, started lazily (first chat action or
 *   terminal open), in the home folder. Command-line values override the user's own
 *   `server.*` config. Ready when stdout says `opencode server listening on http://<host>:<port>`
 *   (20 s), then `GET /global/health` must answer the probed version.
 * - Auth: a new random password per start, given only through `OPENCODE_SERVER_PASSWORD` (never
 *   in argv). `OPENCODE_DISABLE_AUTOUPDATE=1` keeps OpenCode from replacing itself past the
 *   app's version gate. `ELECTRON_RUN_AS_NODE` and inherited `OPENCODE_SERVER_*` are removed.
 *   Nothing else is changed: no XDG, `OPENCODE_DB` or `OPENCODE_CONFIG_DIR`, so the server uses
 *   upstream's own folders (`~/.local/share/opencode`, …), never MarksCode's.
 * - The registration file (0600, line 1 the URL, line 2 the password) is what an attached
 *   terminal reads at start (cli-modules' fixed launcher), so neither tmux's argv nor its
 *   environment keeps them. A pidfile lets the next start stop an orphan of this profile, after
 *   checking `/proc/<pid>/cmdline` is `opencode … serve`.
 * - Lifetime: until app quit, module Stop/Disable, or a restart after an update (`requestRestart`:
 *   at once while no turn runs, else when the last one ends). An exit fails the running turns.
 * - Windows: the same argv through `wsl.exe --cd ~ --exec`, the password carried by `WSLENV`
 *   (untested); the registration file lives in the WSL home.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deleteEnvValue, envKey, normalizeEnvironment, setEnvValue, type MutableEnvironment } from '../env.js';
import { logInfo, logWarn } from '../logger.js';
import { OpenCodeClient } from '../agent-engine/opencode-client.js';
import type { OpenCodeServerView } from '../../shared/upstream-module.js';

export const OPENCODE_SERVER_STOPPED = 'The OpenCode server stopped';
const READY_MS = 20_000;
/** A path into MarksCode's data or install folders (`~/.local/share/markscode`, `~/.markscode/bin`, …). */
export const MARKSCODE_PATH = /(^|[\\/:;])\.?markscode([\\/:;]|$)/i;
const LISTENING = /opencode server listening on (http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5}))\b/;

export interface OpenCodeServerHost {
  /** The binary and whether it runs inside WSL. */
  runtime(): Promise<{ binary: string; windows: boolean }>;
  /** `<userData>/opencode` (Linux/macOS): pidfile and registration file. */
  stateDir(): Promise<string>;
  home(): Promise<string>;
  /** Windows: the registration file in the WSL home, written there. */
  writeWslRegistration?(text: string): Promise<string>;
  spawn(file: string, args: string[], options: { cwd: string; env: MutableEnvironment }): ChildProcess;
  fetch: typeof fetch;
  /** Reads a process's command line (Linux `/proc/<pid>/cmdline`); null when unknown. */
  commandLine(pid: number): Promise<string | null>;
  kill(pid: number): void;
}

export interface RunningServer {
  url: string;
  port: number;
  password: string;
  version: string;
  startedAt: number;
  /** Increases on every start: a turn of an older generation belongs to a server that is gone. */
  generation: number;
  registration: string;
  client: OpenCodeClient;
}

/** The exact argv after the binary. */
export const opencodeServeArgs = (): string[] => ['serve', '--hostname', '127.0.0.1', '--port', '0', '--no-mdns'];

/** The child's environment: the app's, minus Electron's node mode and inherited server auth, plus ours. */
export function opencodeServerEnvironment(password: string, windows: boolean, source: NodeJS.ProcessEnv = process.env): MutableEnvironment {
  const env = normalizeEnvironment(source);
  deleteEnvValue(env, 'ELECTRON_RUN_AS_NODE');
  for (const name of Object.keys(env)) if (/^OPENCODE_SERVER_/i.test(name)) deleteEnvValue(env, name);
  // MarksCode's folders and binaries are never handed to OpenCode: no inherited variable points
  // there and PATH loses its MarksCode entries (upstream uses its own default folders).
  for (const [name, value] of Object.entries(env)) {
    if (/^PATH$/i.test(name) || value === undefined) continue;
    if (/^MARKSCODE_/i.test(name) || MARKSCODE_PATH.test(value)) deleteEnvValue(env, name);
  }
  const pathKey = envKey(env, 'PATH');
  if (pathKey && env[pathKey]) setEnvValue(env, 'PATH', env[pathKey]!.split(windows ? ';' : ':').filter(entry => !MARKSCODE_PATH.test(entry)).join(windows ? ';' : ':'));
  setEnvValue(env, 'OPENCODE_SERVER_PASSWORD', password);
  setEnvValue(env, 'OPENCODE_DISABLE_AUTOUPDATE', '1');
  if (windows) {
    const key = envKey(env, 'WSLENV');
    const current = key ? env[key] ?? '' : '';
    setEnvValue(env, 'WSLENV', [current, 'OPENCODE_SERVER_PASSWORD/u', 'OPENCODE_DISABLE_AUTOUPDATE/u'].filter(Boolean).join(':'));
  }
  return env;
}

const defaultHost = (): OpenCodeServerHost => ({
  async runtime() {
    const { cliEngineRuntime } = await import('../cli-modules.js');
    const resolved = await cliEngineRuntime('opencode');
    if (!resolved.ok) throw new Error(resolved.detail);
    return { binary: resolved.binary, windows: resolved.windows };
  },
  async stateDir() {
    const { app } = await import('electron');
    return path.join(app.getPath('userData'), 'opencode');
  },
  async home() {
    const { app } = await import('electron');
    return app.getPath('home');
  },
  async writeWslRegistration(text) {
    const { app } = await import('electron');
    const { cliWslHome } = await import('../cli-modules.js');
    const hash = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16);
    const file = `${await cliWslHome()}/.local/state/chat-marks/opencode-${hash}.server`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('wsl.exe', ['--exec', '/bin/sh', '-c', 'umask 077; mkdir -p -m 700 "${1%/*}" && cat > "$1"', 'marks-reg', file], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('The OpenCode registration could not be written in WSL')));
      child.stdin.end(text);
    });
    return file;
  },
  spawn: (file, args, options) => spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  fetch: (...args) => fetch(...args),
  async commandLine(pid) {
    if (process.platform !== 'linux') return null;
    return fs.readFile(`/proc/${pid}/cmdline`, 'utf8').then(text => text.split('\u0000').join(' '), () => null);
  },
  kill: pid => { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
});

let host: OpenCodeServerHost = defaultHost();
let current: { server: RunningServer; child: ChildProcess } | null = null;
let starting: Promise<RunningServer> | null = null;
let generation = 0;
let restartPending = false;
let busy: () => boolean = () => false;
const exitListeners = new Set<(server: RunningServer, reason: string) => void>();
let quitHooked = false;
/** The last exit's file cleanup: a stop resolves only after the registration file is gone. */
let cleaned: Promise<void> = Promise.resolve();

export function setOpenCodeServerHostForTests(next: Partial<OpenCodeServerHost> | null): void {
  host = next ? { ...defaultHost(), ...next } : defaultHost();
}

/** The engine tells whether a turn runs (a restart waits for none) and hears an unplanned exit. */
export function bindOpenCodeServer(options: { busy(): boolean; onExit(server: RunningServer, reason: string): void }): void {
  busy = options.busy;
  exitListeners.add(options.onExit);
}

export function openCodeServerView(): OpenCodeServerView {
  return { running: !!current, port: current?.server.port ?? null, version: current?.server.version ?? null, restartPending };
}

export const runningOpenCodeServer = (): RunningServer | null => current?.server ?? null;

async function stopOrphan(dir: string): Promise<void> {
  const pidFile = path.join(dir, 'server.pid');
  const pid = Number((await fs.readFile(pidFile, 'utf8').catch(() => '')).trim());
  if (Number.isInteger(pid) && pid > 1) {
    const command = await host.commandLine(pid);
    if (command && /(^|\/)opencode(\s|$)/.test(command.split(' ')[0] ?? '') && command.split(' ').includes('serve')) {
      logInfo(`OpenCode: stopping the server a previous run left behind (pid ${pid})`);
      host.kill(pid);
    }
  }
  await fs.rm(pidFile, { force: true });
}

async function privateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('The OpenCode state folder is not private');
  await fs.chmod(dir, 0o700);
}

async function start(): Promise<RunningServer> {
  const runtime = await host.runtime();
  const password = randomBytes(32).toString('base64url');
  const env = opencodeServerEnvironment(password, runtime.windows);
  const home = await host.home();
  const dir = runtime.windows ? null : await host.stateDir();
  if (dir) { await privateDir(dir); await stopOrphan(dir); }
  const [file, args] = runtime.windows ? ['wsl.exe', ['--cd', '~', '--exec', runtime.binary, ...opencodeServeArgs()]] : [runtime.binary, opencodeServeArgs()];
  const child = host.spawn(file, args, { cwd: home, env });
  if (dir && child.pid) await fs.writeFile(path.join(dir, 'server.pid'), String(child.pid), { mode: 0o600 }).catch(() => undefined);
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
  const listening = await new Promise<{ url: string; port: number }>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error('The OpenCode server did not start in time')), READY_MS);
    const onData = (chunk: Buffer | string): void => {
      out = (out + String(chunk)).slice(-8192);
      const match = LISTENING.exec(out);
      if (!match) return;
      cleanup();
      resolve({ url: match[1]!.replace('localhost', '127.0.0.1'), port: Number(match[2]) });
    };
    const onExit = (): void => fail(new Error(`${OPENCODE_SERVER_STOPPED} before it was ready${stderr.trim() ? `: ${redact(stderr, password).split('\n').filter(Boolean).pop()!.slice(0, 160)}` : ''}`));
    const onError = (error: Error): void => fail(new Error(`The OpenCode server could not start: ${error.message}`));
    function cleanup(): void { clearTimeout(timer); child.stdout?.off('data', onData); child.off('exit', onExit); child.off('error', onError); }
    function fail(error: Error): void { cleanup(); reject(error); }
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  }).catch(error => { try { child.kill('SIGTERM'); } catch { /* gone */ } throw error; });
  child.stdout?.resume();
  const client = new OpenCodeClient({ url: listening.url, password }, host.fetch);
  let version: string;
  try {
    const health = await client.health(5_000);
    if (health?.healthy !== true || typeof health.version !== 'string') throw new Error('The OpenCode server did not report its health');
    version = health.version.slice(0, 40);
  } catch (error) {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    throw error;
  }
  const text = `${listening.url}\n${password}\n`;
  let registration: string;
  if (dir) {
    registration = path.join(dir, 'server');
    await fs.writeFile(`${registration}.tmp`, text, { mode: 0o600 });
    await fs.rename(`${registration}.tmp`, registration);
  } else {
    registration = await host.writeWslRegistration!(text);
  }
  const server: RunningServer = { url: listening.url, port: listening.port, password, version, startedAt: Date.now(), generation: ++generation, registration, client };
  current = { server, child };
  child.once('exit', (code, signal) => {
    if (current?.child !== child) return;
    current = null;
    cleaned = cleanupFiles(dir, registration);
    const reason = `${OPENCODE_SERVER_STOPPED} (${signal ?? `exit ${code ?? '?'}`})`;
    logWarn(`OpenCode: ${reason}`);
    for (const listener of exitListeners) { try { listener(server, reason); } catch { /* listener */ } }
  });
  hookQuit();
  logInfo(`OpenCode: server ${version} listening on 127.0.0.1:${listening.port}`);
  return server;
}

const redact = (text: string, password: string): string => text.split(password).join('[redacted]');

async function cleanupFiles(dir: string | null, registration: string): Promise<void> {
  if (!dir) return;
  await fs.rm(path.join(dir, 'server.pid'), { force: true }).catch(() => undefined);
  await fs.rm(registration, { force: true }).catch(() => undefined);
}

function hookQuit(): void {
  if (quitHooked) return;
  quitHooked = true;
  void import('electron').then(({ app }) => { app?.on?.('will-quit', () => { void stopOpenCodeServer('quit'); }); }).catch(() => undefined);
  void import('../cli-modules.js').then(({ registerCliModuleStopHook }) => registerCliModuleStopHook(id => { if (id === 'opencode') void stopOpenCodeServer('module'); }))
    .catch(() => undefined);
}

/** The running server, started when none runs. */
export function ensureOpenCodeServer(): Promise<RunningServer> {
  if (current) return Promise.resolve(current.server);
  starting ??= start().finally(() => { starting = null; });
  return starting;
}

/** Stops the server (quit, module Stop/Disable, restart); its exit listeners fail the running turns. */
export async function stopOpenCodeServer(why: 'quit' | 'module' | 'restart'): Promise<void> {
  const running = current;
  if (!running) return;
  logInfo(`OpenCode: stopping the server (${why})`);
  const exited = new Promise<void>(resolve => {
    if (running.child.exitCode !== null || running.child.signalCode !== null) resolve();
    else running.child.once('exit', () => resolve());
  });
  try { running.child.kill('SIGTERM'); } catch { /* gone */ }
  const timer = setTimeout(() => { try { if (running.child.exitCode === null) running.child.kill('SIGKILL'); } catch { /* gone */ } }, 3_000);
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
  clearTimeout(timer);
  await cleaned;
}

/**
 * After an update: the new binary is used from the next start. With no turn running the server
 * restarts at once (it is started again lazily); otherwise when the last turn ends.
 */
export async function requestOpenCodeRestart(): Promise<void> {
  if (!current) { restartPending = false; return; }
  if (busy()) { restartPending = true; return; }
  restartPending = false;
  await stopOpenCodeServer('restart');
}

/** The engine calls this when a turn ends. */
export function openCodeTurnsSettled(): void {
  if (restartPending && !busy()) void requestOpenCodeRestart();
}

export function resetOpenCodeServerForTests(): void {
  if (current) { try { current.child.kill('SIGKILL'); } catch { /* gone */ } }
  current = null;
  starting = null;
  restartPending = false;
  busy = () => false;
  exitListeners.clear();
}
