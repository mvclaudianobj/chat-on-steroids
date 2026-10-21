import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { z } from 'zod';
import { projectWorkspace } from './projects.js';
import { getConfig, effectiveCapabilities } from './config.js';
import { readDurable, writeDurableNow } from './durable.js';
import { normalizeEnvironment, deleteEnvValue } from './env.js';
import { installFork, installPublishedCli } from './cli-source-install.js';
import { markspanelAccessBlocked } from './markspanel-auth.js';

export const CLI_IDS = ['markscode', 'codex', 'claude', 'marksclaw'] as const;
export type CliId = typeof CLI_IDS[number];
const manifest: Record<CliId, { name: string; bin: string; homepage: string; package?: string }> = {
  markscode: { name: 'MarksCode', bin: 'markscode', homepage: 'https://github.com/mvclaudianobj/markscode' },
  codex: { name: 'Codex', bin: 'codex', package: '@openai/codex', homepage: 'https://github.com/openai/codex' },
  claude: { name: 'Claude', bin: 'claude', package: '@anthropic-ai/claude-code', homepage: 'https://code.claude.com/docs/en/overview' },
  marksclaw: { name: 'MarksClaw', bin: 'marksclaw', homepage: 'https://github.com/mvclaudianobj/marksclaw' }
};
type Status = { id: CliId; name: string; installed: boolean; enabled: boolean; running: boolean; version: string | null; supported: boolean; detail: string };
export type CliSession = {
  id: string;
  module: CliId;
  projectId: string | null;
  cwd: string;
  title: string;
  tmuxSession: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Chat Marks agent engines: the API chat this terminal opens and the exact arguments after the
   * binary — Claude Code hands over (`--resume <uuid>` / `--session-id <uuid>`), Codex attaches
   * live (`resume <thread> --remote unix://<sock>`), MarksCode attaches live to its service
   * session (`-s <session> .`). Absent for an ordinary module terminal,
   * which starts the bare binary.
   */
  engineChat?: string;
  args?: string[];
};
type StoredState = { enabled: CliId[]; sessions: CliSession[] };
type Entry = { cli: CliId; projectId: string | null; nativeCwd: string; cwd: string; tmuxSession: string; pty: IPty; unacked: number; paused: boolean };
const run = promisify(execFile);
const STATE = 'marks-cli-modules';
const installedRoot = () => path.join(app.getPath('userData'), 'modules');
let enabled = new Set<CliId>();
let sessions: CliSession[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const attachments = new Map<string, Entry>();
const openingAttachments = new Set<string>();
const installations = new Set<CliId>();
let emit: ((id: string, event: { data?: string; exitCode?: number }) => void) | null = null;
const stopListeners = new Set<(id: CliId) => void>();
/**
 * Runs before an engine-bound terminal attaches, per module. A hand-over engine (Claude Code)
 * stops its host or throws to refuse (a turn runs); a live engine makes sure the server the
 * terminal attaches to is running (Codex starts its app-server, MarksCode refuses while its
 * background service is stopped).
 */
const engineOpenHooks = new Map<EngineTerminalModule, (session: Readonly<CliSession>) => Promise<void>>();
export function registerCliEngineOpenHook(module: EngineTerminalModule, hook: ((session: Readonly<CliSession>) => Promise<void>) | null): void {
  if (hook) engineOpenHooks.set(module, hook); else engineOpenHooks.delete(module);
}
export type EngineTerminalModule = 'markscode' | 'codex' | 'claude';
/** Engines whose terminal takes the session over: their open hook is required. */
const HANDOVER_MODULES: ReadonlySet<CliId> = new Set(['claude']);
const ENGINE_TERMINAL_ARGS = /^--(resume|session-id)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_THREAD = /^[0-9a-z][0-9a-z-]{0,199}$/i;
const CODEX_REMOTE = /^unix:\/\/\/[^\s\u0000]{1,900}\.sock$/;
/** A MarksCode service session id (`ses_…`); never starts with `-`, so it cannot read as an option. */
const MARKSCODE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
/** The only argument shapes an engine terminal may carry, per module. */
const validEngineArgs = (module: CliId, args: unknown): args is string[] => {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) return false;
  if (module === 'claude') return args.length === 2 && ENGINE_TERMINAL_ARGS.test(args[0]!) && UUID.test(args[1]!);
  if (module === 'markscode') return args.length === 3 && args[0] === '-s' && MARKSCODE_SESSION.test(args[1]!) && args[2] === '.';
  if (module === 'codex') return args.length === 4 && args[0] === 'resume' && CODEX_THREAD.test(args[1]!) && args[2] === '--remote' && CODEX_REMOTE.test(args[3]!);
  return false;
};
export function registerCliModuleStopHook(listener: (id: CliId) => void): () => void {
  stopListeners.add(listener);
  return () => { stopListeners.delete(listener); };
}
const sessionName = (id: CliId, sessionId: string) =>
  `marks_${id}_${createHash('sha256').update(sessionId).digest('hex').slice(0, 18)}`;
const tmuxSocket = () => `chat-marks-${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)}`;
const moduleOperations = new Map<CliId, Promise<void>>();
let enabledOperations: Promise<void> = Promise.resolve();

function onModule<T>(id: CliId, operation: () => Promise<T>): Promise<T> {
  const result = (moduleOperations.get(id) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  moduleOperations.set(id, tail);
  void tail.then(() => { if (moduleOperations.get(id) === tail) moduleOperations.delete(id); });
  return result;
}

export async function loadCliModules(): Promise<void> {
  if (loaded) return;
  loading ??= (async () => {
    const saved = await readDurable<unknown>(STATE);
    if (Array.isArray(saved)) {
      enabled = new Set(saved.filter((s): s is CliId => typeof s === 'string' && CLI_IDS.includes(s as CliId)));
      sessions = [];
    } else if (saved && typeof saved === 'object') {
      const state = saved as Partial<StoredState>;
      enabled = new Set(Array.isArray(state.enabled) ? state.enabled.filter((s): s is CliId => typeof s === 'string' && CLI_IDS.includes(s as CliId)) : []);
      sessions = Array.isArray(state.sessions) ? state.sessions.filter(validSession) : [];
    } else {
      enabled = new Set();
      sessions = [];
    }
    loaded = true;
  })().finally(() => { loading = null; });
  await loading;
}

function validSession(value: unknown): value is CliSession {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CliSession>;
  return typeof row.id === 'string' && /^[0-9a-f-]{36}$/.test(row.id)
    && typeof row.module === 'string' && CLI_IDS.includes(row.module as CliId)
    && (row.projectId === null || typeof row.projectId === 'string')
    && typeof row.cwd === 'string' && typeof row.title === 'string'
    && typeof row.tmuxSession === 'string' && /^marks_(markscode|codex|claude|marksclaw)_[0-9a-f]{18}$/.test(row.tmuxSession)
    && typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
    && typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)
    && (row.engineChat === undefined || (typeof row.engineChat === 'string' && /^[0-9a-z-]{8,64}$/i.test(row.engineChat) && validEngineArgs(row.module as CliId, row.args)))
    && (row.args === undefined || row.engineChat !== undefined);
}

async function saveCliModules(nextEnabled: Set<CliId>, nextSessions: CliSession[]): Promise<void> {
  await writeDurableNow(STATE, { enabled: [...nextEnabled], sessions: nextSessions } satisfies StoredState);
}

async function executable(name: string): Promise<string | null> {
  const module = CLI_IDS.find(id => manifest[id].bin === name);
  if (module) {
    const compiled = path.join(installedRoot(), module, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
    try { const { access } = await import('node:fs/promises'); await access(compiled); return compiled; } catch {}
    const local = path.join(installedRoot(), module, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
    try { const { access } = await import('node:fs/promises'); await access(local); return local; } catch {}
  }
  const locate = process.platform === 'win32' ? 'where.exe' : '/usr/bin/env';
  const args = process.platform === 'win32' ? [name] : ['which', name];
  try { const { stdout } = await run(locate, args, { timeout: 5_000 }); return stdout.split(/\r?\n/)[0]?.trim() || null; } catch { return null; }
}

async function wslCommand(program: string, args: string[] = []): Promise<string> {
  const { stdout } = await run('wsl.exe', ['--exec', program, ...args], { timeout: 8_000, maxBuffer: 65_536 });
  return stdout.trim();
}
async function wslHome(): Promise<string> {
  const home = await wslCommand('/usr/bin/env', ['printenv', 'HOME']);
  if (!/^\/(?:home\/[^/\s]+|root)$/.test(home)) throw new Error('WSL home directory could not be verified');
  return home;
}
async function wslModulePrefix(id: CliId): Promise<string> {
  return `${await wslHome()}/.local/share/chat-marks-modules/${id}`;
}
async function runtimeBinary(id: CliId): Promise<string | null> {
  if (process.platform !== 'win32') return executable(manifest[id].bin);
  try {
    const candidate = `${await wslModulePrefix(id)}/bin/${manifest[id].bin}`;
    const checked = await wslCommand('test', ['-x', candidate]).then(() => candidate, () => null);
    if (checked) return checked;
    const npmCandidate = `${await wslModulePrefix(id)}/node_modules/.bin/${manifest[id].bin}`;
    const npmChecked = await wslCommand('test', ['-x', npmCandidate]).then(() => npmCandidate, () => null);
    if (npmChecked) return npmChecked;
    const located = (await wslCommand('/usr/bin/env', ['which', manifest[id].bin])).split(/\r?\n/)[0]?.trim();
    return located?.startsWith('/') && !located.includes('\u0000') ? located : null;
  } catch { return null; }
}
async function tmuxAvailable(): Promise<boolean> {
  try {
    if (process.platform === 'win32') return (await wslCommand('tmux', ['-V'])).startsWith('tmux ');
    return !!(await executable('tmux'));
  } catch { return false; }
}

async function version(id: CliId): Promise<string | null> {
  const bin = await runtimeBinary(id);
  if (!bin) return null;
  try {
    const { stdout, stderr } = await run(process.platform === 'win32' ? 'wsl.exe' : bin,
      process.platform === 'win32' ? ['--exec', bin, '--version'] : ['--version'], { timeout: 6_000, maxBuffer: 4096 });
    return (stdout || stderr).trim().split(/\r?\n/)[0]?.slice(0, 100) || 'installed';
  } catch { return 'Version unavailable'; }
}

export async function cliChatRuntime(id: 'markscode' | 'codex' | 'claude', projectId: string | null):
  Promise<{ bin: string; cwd: string; argsPrefix: string[] }> {
  await loadCliModules();
  if (!effectiveCapabilities(getConfig()).command) throw new Error('Command execution is disabled');
  if (!enabled.has(id)) throw new Error('This module has been disabled');
  const binary = await runtimeBinary(id);
  if (!binary) throw new Error(`${manifest[id].name} is not installed`);
  const cwd = projectId ? (await projectWorkspace(projectId)).real : app.getPath('home');
  const argsPrefix = process.platform === 'win32'
    ? ['--cd', await wslCommand('wslpath', ['-a', cwd]), '--exec', binary] : [];
  if (projectId && (await projectWorkspace(projectId)).real !== cwd) throw new Error('Workspace changed');
  if (!effectiveCapabilities(getConfig()).command || !enabled.has(id)) throw new Error('This module has been disabled');
  return { bin: process.platform === 'win32' ? 'wsl.exe' : binary, cwd, argsPrefix };
}

/**
 * Whether a module can run here now, without throwing: enabled, the command capability, and
 * the binary the module terminals use (userData/modules/<id>/bin, its node_modules/.bin, PATH;
 * inside WSL on Windows). Agent engines read their status from it.
 */
export async function cliModuleState(id: CliId): Promise<{ enabled: boolean; command: boolean; binary: string | null }> {
  await loadCliModules();
  const command = effectiveCapabilities(getConfig()).command;
  if (!enabled.has(id) || !command) return { enabled: enabled.has(id), command, binary: null };
  return { enabled: true, command, binary: await runtimeBinary(id) };
}

/**
 * Chat Marks agent engines: the CLI an engine runs, behind the same gates as a module terminal
 * (command execution allowed, the module enabled, the binary resolved the same way). On Windows
 * the binary is a WSL path and runs through `wsl.exe --exec`.
 */
export async function cliEngineRuntime(id: 'markscode' | 'codex' | 'claude'):
  Promise<{ ok: true; binary: string; windows: boolean } | { ok: false; detail: string }> {
  await loadCliModules();
  if (!effectiveCapabilities(getConfig()).command) return { ok: false, detail: 'Command execution is disabled' };
  if (!enabled.has(id)) return { ok: false, detail: `Enable the ${manifest[id].name} module in Settings > Modules first` };
  const binary = await runtimeBinary(id);
  if (!binary) return { ok: false, detail: `${manifest[id].name} is not installed` };
  return { ok: true, binary, windows: process.platform === 'win32' };
}

/** A native folder as WSL sees it (Windows only). */
export const cliWslPath = (native: string): Promise<string> => wslCommand('wslpath', ['-a', native]);
export const cliWslHome = (): Promise<string> => wslHome();

export async function cliStatus(): Promise<Status[]> {
  await loadCliModules();
  const sessionOutput = await listSessions();
  const runningSessions = sessionOutput.split(/\r?\n/).filter(s => /^marks_(markscode|codex|claude|marksclaw)_[0-9a-f]{18}$/.test(s));
  const supported = await tmuxAvailable();
  return Promise.all(CLI_IDS.map(async id => {
    const v = await version(id);
    return { id, name: manifest[id].name, installed: v !== null, enabled: enabled.has(id), running: runningSessions.some(s => s.startsWith(`marks_${id}_`)), version: v, supported,
      detail: !supported ? 'Persistent terminal requires tmux on Linux/macOS or WSL with tmux on Windows.'
        : v === 'Version unavailable' ? 'CLI found, but its version check failed; check the executable before opening.'
          : v ? 'Ready for a persistent workspace terminal.' : 'Install the CLI from its trusted publisher.' };
  }));
}

async function listSessions(): Promise<string> {
  try { return await tmux(['list-sessions', '-F', '#{session_name}']); }
  catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if ((Number(failure.code) === 1 && /no server running|error connecting to|failed to connect to server|no sessions/i.test(String(failure.stderr ?? failure.message))) || failure.code === 'ENOENT') return '';
    throw error;
  }
}

async function killModuleSessions(id: CliId): Promise<void> {
  const existing = await listSessions();
  for (const name of existing.split('\n')) {
    if (/^marks_(markscode|codex|claude|marksclaw)_[0-9a-f]{18}$/.test(name) && name.startsWith(`marks_${id}_`)) {
      try { await tmux(['kill-session', '-t', `=${name}`]); }
      catch (error) {
        const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
        if (Number(failure.code) !== 1 || !/can't find session|no server running|error connecting to/i.test(String(failure.stderr ?? failure.message))) throw error;
      }
    }
  }
}

function detachModule(id: CliId): void {
  for (const listener of stopListeners) {
    try { listener(id); } catch {}
  }
  for (const [attachmentId, entry] of attachments) {
    if (entry.cli !== id) continue;
    emit?.(attachmentId, { exitCode: 0 });
    cliDetach(attachmentId);
  }
}

async function changeEnabled(id: CliId, turnOn: boolean): Promise<void> {
  const operation = enabledOperations.then(async () => {
    const next = new Set(enabled);
    if (turnOn) next.add(id); else next.delete(id);
    await saveCliModules(next, sessions);
    enabled = next;
  });
  enabledOperations = operation.then(() => undefined, () => undefined);
  await operation;
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await run(process.platform === 'win32' ? 'wsl.exe' : 'tmux',
    [...(process.platform === 'win32' ? ['--exec', 'tmux'] : []), '-L', tmuxSocket(), ...args], { timeout: 8_000, maxBuffer: 65_536 });
  return stdout;
}

export async function cliAction(id: CliId, action: 'enable' | 'disable' | 'install' | 'update' | 'stop'): Promise<Status[]> {
  await loadCliModules();
  if (!effectiveCapabilities(getConfig()).command) throw new Error('Command execution is disabled');
  await onModule(id, async () => {
    if (!effectiveCapabilities(getConfig()).command) throw new Error('Command execution is disabled');
    if (action === 'enable' || action === 'disable') {
      await changeEnabled(id, action === 'enable');
      if (action === 'disable') {
        try { await killModuleSessions(id); } finally { detachModule(id); }
      }
    } else if (action === 'stop') {
      try { await killModuleSessions(id); } finally { detachModule(id); }
    } else {
    if (installations.has(id)) throw new Error('This module is already being installed or updated');
    installations.add(id);
    const source = manifest[id];
    try {
      if (source.package) await installPublishedCli(id as 'codex' | 'claude', source.package);
      else await installFork(id as 'markscode' | 'marksclaw');
    } finally { installations.delete(id); }
    }
  });
  return cliStatus();
}

export async function cliSessions(): Promise<CliSession[]> {
  await loadCliModules();
  return sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(session => ({ ...session }));
}

export async function cliCreateSession(id: CliId, projectId: string | null): Promise<CliSession> {
  return createSessionRecord(id, projectId, null);
}

/**
 * Chat Marks agent engines: the terminal of one API chat (Claude Code hand-over, Codex and
 * MarksCode live attach). One per chat: an existing one is reused with the new arguments; it starts
 * `<binary> <args>` in the chat's project folder through the same tmux mechanism as every
 * module terminal.
 */
export async function cliEngineTerminal(id: EngineTerminalModule, chat: { sessionId: string; projectId: string | null; args: string[]; title: string }): Promise<CliSession> {
  if (!validEngineArgs(id, chat.args) || !/^[0-9a-z-]{8,64}$/i.test(chat.sessionId)) throw new Error('Invalid terminal arguments');
  await loadCliModules();
  const existing = sessions.find(session => session.module === id && session.engineChat === chat.sessionId);
  if (!existing) return createSessionRecord(id, chat.projectId, { engineChat: chat.sessionId, args: [...chat.args], title: chat.title.slice(0, 120) });
  return onModule(id, async () => {
    const operation = enabledOperations.then(async () => {
      const index = sessions.findIndex(session => session.id === existing.id);
      if (index < 0) throw new Error('CLI session not found');
      const nextSessions = sessions.slice();
      nextSessions[index] = { ...sessions[index]!, args: [...chat.args], updatedAt: Date.now() };
      await saveCliModules(enabled, nextSessions);
      sessions = nextSessions;
    });
    enabledOperations = operation.then(() => undefined, () => undefined);
    await operation;
    return { ...sessions.find(session => session.id === existing.id)! };
  });
}

/**
 * Whether a chat's handover terminal runs, and who looks at it now: `attached` only the app's own
 * terminal view(s), `external` also a tmux client outside the app (each app view is one client).
 */
export async function cliEngineTerminalState(chatSessionId: string): Promise<'none' | 'detached' | 'attached' | 'external'> {
  await loadCliModules();
  const session = sessions.find(candidate => candidate.engineChat === chatSessionId);
  if (!session) return 'none';
  try { await tmux(['has-session', '-t', `=${session.tmuxSession}`]); } catch { return 'none'; }
  const views = [...attachments.values()].filter(entry => entry.tmuxSession === session.tmuxSession).length;
  const clients = (await tmux(['list-clients', '-t', `=${session.tmuxSession}`, '-F', '#{client_name}']).catch(() => ''))
    .split('\n').filter(line => line.trim()).length;
  if (clients > views) return 'external';
  return views ? 'attached' : 'detached';
}

/**
 * Ends a chat's handover terminal: the app's own views of it are told it exited and detached, then
 * its tmux session (and the TUI in it, any outside client with it) is killed. The sidebar entry
 * stays for the next hand-over. Only the chat's explicit take-back or a detached terminal leads here.
 */
export async function cliEndEngineTerminal(chatSessionId: string): Promise<void> {
  await loadCliModules();
  const session = sessions.find(candidate => candidate.engineChat === chatSessionId);
  if (!session) return;
  for (const [attachmentId, entry] of attachments) {
    if (entry.tmuxSession !== session.tmuxSession) continue;
    emit?.(attachmentId, { exitCode: 0 });
    cliDetach(attachmentId);
  }
  await tmux(['kill-session', '-t', `=${session.tmuxSession}`]).catch(() => undefined);
}

async function createSessionRecord(id: CliId, projectId: string | null, engine: { engineChat: string; args: string[]; title: string } | null): Promise<CliSession> {
  await loadCliModules();
  return onModule(id, async () => {
    if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
    if (!effectiveCapabilities(getConfig()).command) throw new Error('Command execution is disabled');
    if (!enabled.has(id)) throw new Error('This module has been disabled');
    if (!(await tmuxAvailable())) throw new Error('Install tmux (in WSL on Windows) first');
    if (!(await runtimeBinary(id))) throw new Error(`${manifest[id].name} is not installed`);
    const nativeCwd = projectId ? (await projectWorkspace(projectId)).real : app.getPath('home');
    const cwd = process.platform === 'win32' ? await wslCommand('wslpath', ['-a', nativeCwd]) : nativeCwd;
    if (!cwd || !cwd.startsWith('/')) throw new Error('Workspace could not be mapped to WSL');
    if (projectId && (await projectWorkspace(projectId)).real !== nativeCwd) throw new Error('Workspace changed while creating terminal');
    if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
    if (!effectiveCapabilities(getConfig()).command || !enabled.has(id)) throw new Error('This module has been disabled');
    const sessionId = randomUUID();
    const now = Date.now();
    const sequence = sessions.filter(session => session.module === id).length + 1;
    const created: CliSession = {
      id: sessionId,
      module: id,
      projectId,
      cwd,
      title: engine?.title || `${manifest[id].name} ${sequence}`,
      tmuxSession: sessionName(id, sessionId),
      createdAt: now,
      updatedAt: now,
      ...(engine ? { engineChat: engine.engineChat, args: engine.args } : {})
    };
    const operation = enabledOperations.then(async () => {
      if (!effectiveCapabilities(getConfig()).command || !enabled.has(id)) throw new Error('This module has been disabled');
      const nextSessions = [...sessions, created];
      await saveCliModules(enabled, nextSessions);
      sessions = nextSessions;
    });
    enabledOperations = operation.then(() => undefined, () => undefined);
    await operation;
    return { ...created };
  });
}

export async function cliRenameSession(sessionId: string, title: string): Promise<void> {
  await loadCliModules();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx < 0) throw new Error('Session not found');
  const trimmed = title.trim().slice(0, 120);
  if (!trimmed) throw new Error('Title must not be empty');
  const updated: CliSession = { ...sessions[idx]!, title: trimmed, updatedAt: Date.now() };
  const nextSessions = [...sessions];
  nextSessions[idx] = updated;
  await saveCliModules(enabled, nextSessions);
  sessions = nextSessions;
}

export async function cliDeleteSession(sessionId: string): Promise<void> {
  await loadCliModules();
  const nextSessions = sessions.filter(s => s.id !== sessionId);
  await saveCliModules(enabled, nextSessions);
  sessions = nextSessions;
}

export async function cliOpen(sessionId: string, cols: number, rows: number, attachmentId: string,
  cancelled: () => boolean = () => false): Promise<{ id: string; cwd: string; session: string }> {
  await loadCliModules();
  const selected = sessions.find(session => session.id === sessionId);
  if (!selected) throw new Error('CLI session not found');
  const id = selected.module;
  const checkAccess = (): void => {
    if (cancelled()) throw new Error('Terminal opening was cancelled');
    if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
    if (!effectiveCapabilities(getConfig()).command) throw new Error('Command execution is disabled');
    if (!enabled.has(id)) throw new Error('This module has been disabled');
  };
  if (openingAttachments.has(attachmentId) || attachments.has(attachmentId)) throw new Error('Terminal already attached');
  if (attachments.size + openingAttachments.size >= 8) throw new Error('Maximum eight attached module terminals');
  openingAttachments.add(attachmentId);
  try { return await onModule(id, async () => {
  checkAccess();
  if (!(await tmuxAvailable())) throw new Error('Install tmux (in WSL on Windows) first');
  const bin = await runtimeBinary(id);
  if (!bin) throw new Error(`${manifest[id].name} is not installed`);
  const currentSession = sessions.find(session => session.id === sessionId && session.module === id);
  if (!currentSession) throw new Error('CLI session not found');
  const projectId = currentSession.projectId;
  const nativeCwd = projectId ? (await projectWorkspace(projectId)).real : app.getPath('home');
  const cwd = process.platform === 'win32' ? await wslCommand('wslpath', ['-a', nativeCwd]) : nativeCwd;
  if (!cwd || !cwd.startsWith('/')) throw new Error('Workspace could not be mapped to WSL');
  if (cwd !== currentSession.cwd) throw new Error('Workspace changed while opening terminal');
  checkAccess();
  if (projectId && (await projectWorkspace(projectId)).real !== nativeCwd) throw new Error('Workspace changed while opening terminal');
  if (attachments.has(attachmentId)) throw new Error('Terminal already attached');
  const session = currentSession.tmuxSession;
  // An engine's terminal: a hand-over engine's host stops first (or the open is refused); a live
  // engine starts the server the terminal attaches to.
  if (currentSession.engineChat) {
    const hook = engineOpenHooks.get(id as EngineTerminalModule);
    if (!hook && HANDOVER_MODULES.has(id)) throw new Error('This terminal belongs to a chat engine that is not available');
    if (hook) await hook(currentSession);
    checkAccess();
  }
  const args = currentSession.engineChat && validEngineArgs(id, currentSession.args) ? currentSession.args : [];
  let created = false;
  try { await tmux(['has-session', '-t', `=${session}`]); }
  catch {
    checkAccess();
    await tmux(['new-session', '-d', '-s', session, '-c', cwd, 'sh', '-c', 'exec "$@"', 'marks-cli', bin, ...args]);
    created = true;
  }
  try { checkAccess(); }
  catch (error) {
    if (created) await tmux(['kill-session', '-t', `=${session}`]).catch(() => undefined);
    throw error;
  }
  const touched = { ...currentSession, updatedAt: Date.now() };
  const persistence = enabledOperations.then(async () => {
    checkAccess();
    const index = sessions.findIndex(candidate => candidate.id === sessionId && candidate.module === id);
    if (index < 0) throw new Error('CLI session not found');
    const nextSessions = sessions.slice();
    nextSessions[index] = touched;
    await saveCliModules(enabled, nextSessions);
    sessions = nextSessions;
  });
  enabledOperations = persistence.then(() => undefined, () => undefined);
  try { await persistence; }
  catch (error) {
    if (created) await tmux(['kill-session', '-t', `=${session}`]).catch(() => undefined);
    throw error;
  }
  const environment = normalizeEnvironment(); deleteEnvValue(environment, 'ELECTRON_RUN_AS_NODE');
  let pty: IPty;
  try { pty = spawnPty(process.platform === 'win32' ? 'wsl.exe' : 'tmux',
    [...(process.platform === 'win32' ? ['--exec', 'tmux'] : []), '-L', tmuxSocket(), 'attach-session', '-t', `=${session}`], {
    name: 'xterm-256color', cwd: nativeCwd, env: environment, cols, rows, useConpty: true
  }); } catch (error) {
    if (created) await tmux(['kill-session', '-t', `=${session}`]).catch(() => undefined);
    throw error;
  }
  try { checkAccess(); }
  catch (error) { pty.kill(); if (created) await tmux(['kill-session', '-t', `=${session}`]).catch(() => undefined); throw error; }
  const entry: Entry = { cli: id, projectId, nativeCwd, cwd, tmuxSession: session, pty, unacked: 0, paused: false };
  attachments.set(attachmentId, entry);
  pty.onData(data => {
    if (attachments.get(attachmentId) !== entry) return;
    for (let i = 0; i < data.length; i += 16_384) {
      const chunk = data.slice(i, i + 16_384);
      entry.unacked += chunk.length;
      emit?.(attachmentId, { data: chunk });
    }
    if (entry.unacked >= 262_144 && !entry.paused) { entry.paused = true; pty.pause(); }
  });
  pty.onExit(({ exitCode }) => { if (attachments.get(attachmentId) === entry) { attachments.delete(attachmentId); emit?.(attachmentId, { exitCode }); } });
  return { id: attachmentId, cwd, session };
  }); } finally { openingAttachments.delete(attachmentId); }
}

function cliDetach(id: string): void {
  const entry = attachments.get(id);
  if (!entry) return;
  attachments.delete(id);
  try { entry.pty.kill(); } catch {}
}

export function registerCliModuleIpc(getWindow: () => BrowserWindow | null): void {
  let owner: WebContents | null = null;
  const detachAll = (): void => { for (const id of attachments.keys()) cliDetach(id); };
  const id = z.enum(CLI_IDS);
  const request = z.discriminatedUnion('action', [
    z.object({ action: z.literal('status') }).strict(),
    z.object({ action: z.literal('sessions') }).strict(),
    z.object({ action: z.literal('create'), module: id, projectId: z.string().uuid().nullable() }).strict(),
    z.object({ action: z.enum(['enable', 'disable', 'install', 'update', 'stop']), module: id }).strict(),
    z.object({ action: z.literal('open'), sessionId: z.string().uuid(), attachmentId: z.string().uuid(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }).strict(),
    z.object({ action: z.literal('write'), attachmentId: z.string().uuid(), data: z.string().max(16_384) }).strict(),
    z.object({ action: z.literal('resize'), attachmentId: z.string().uuid(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }).strict(),
    z.object({ action: z.literal('ack'), attachmentId: z.string().uuid(), count: z.number().int().min(0).max(65_536) }).strict(),
    z.object({ action: z.literal('detach'), attachmentId: z.string().uuid() }).strict(),
    z.object({ action: z.literal('rename'), sessionId: z.string().uuid(), title: z.string().min(1).max(120) }).strict(),
    z.object({ action: z.literal('delete'), sessionId: z.string().uuid() }).strict()
  ]);
  const send = (attachmentId: string, event: { data?: string; exitCode?: number }): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('marksCli:event', { id: attachmentId, ...event });
  };
  emit = send;
  ipcMain.handle('marksCli:request', async (event, payload: unknown) => {
    try {
      if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('Window not authorized');
      if (event.sender !== ownerContents()) {
        detachAll();
        registerOwner(event.sender);
      }
      const input = request.parse(payload);
      const data = input.action === 'status' ? await cliStatus()
        : input.action === 'sessions' ? await cliSessions()
          : input.action === 'create' ? await cliCreateSession(input.module, input.projectId)
        : ['enable', 'disable', 'install', 'update', 'stop'].includes(input.action) ? await cliAction((input as { module: CliId }).module, input.action as 'enable' | 'disable' | 'install' | 'update' | 'stop')
          : input.action === 'open' ? await cliOpen(input.sessionId, input.cols, input.rows, input.attachmentId,
            () => owner !== event.sender || event.sender.isDestroyed())
            : input.action === 'write' ? await (async () => {
              if (!effectiveCapabilities(getConfig()).command) throw new Error('Command execution is disabled');
              const entry = attachments.get(input.attachmentId);
              if (!entry || !enabled.has(entry.cli)) throw new Error('Terminal disconnected or disabled');
              if (entry.projectId && (await projectWorkspace(entry.projectId)).real !== entry.nativeCwd) throw new Error('Workspace changed');
              if (attachments.get(input.attachmentId) !== entry || !enabled.has(entry.cli) || !effectiveCapabilities(getConfig()).command) throw new Error('Terminal disconnected or disabled');
              entry.pty.write(input.data); return null;
            })()
              : input.action === 'resize' ? (attachments.get(input.attachmentId)?.pty.resize(input.cols, input.rows), null)
                : input.action === 'ack' ? (function acknowledge() {
                  const entry = attachments.get(input.attachmentId);
                  if (!entry) return null;
                  entry.unacked = Math.max(0, entry.unacked - input.count);
                  if (entry.paused && entry.unacked < 65_536) { entry.paused = false; entry.pty.resume(); }
                  return null;
                })()
                : input.action === 'detach' ? (cliDetach(input.attachmentId), null)
                  : input.action === 'rename' ? (await cliRenameSession(input.sessionId, input.title), null)
                    : input.action === 'delete' ? (await cliDeleteSession(input.sessionId), null) : null;
      return { ok: true, data };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  function ownerContents(): WebContents | null { return owner; }
  function registerOwner(contents: WebContents): void {
    owner = contents;
    const cleanup = (): void => { if (owner === contents) { detachAll(); owner = null; } };
    contents.once('destroyed', cleanup);
    contents.once('did-start-loading', cleanup);
  }
  app.on('before-quit', detachAll);
}
