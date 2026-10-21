/**
 * The `codex` engine: an API chat whose turns run in OpenAI Codex (`codex app-server`, codex-cli
 * 0.163, experimental protocol; see codex-protocol.ts for every argv and parameter).
 *
 * Process model: ONE app-server per app instance, started lazily and shared by every Codex chat:
 * `codex app-server -c <safe overrides> --listen unix://<userData>/codex/<hash>.sock` (0700 dir;
 * the hash is of userData, so a crashed instance's orphan is found again by its pidfile and
 * stopped). The app talks to it through `codex app-server proxy --sock <sock>`, a child that
 * relays its stdio to the socket byte for byte; codex-cli 0.163 serves the socket as WebSocket, so
 * the upgrade and one JSON-RPC message per text frame run over that stdio (jsonrpc.ts). The same
 * child works through `wsl.exe` on Windows, where the app cannot reach the WSL socket itself.
 * One shared server, not one per chat: threads are multiplexed by id, a chat costs no process,
 * and the chat's live terminal (`codex resume <thread> --remote unix://<sock>`) attaches to the very server and thread the chat runs on, so the TUI
 * and the chat see the same turn and the same approvals. Both children are killed when the app
 * quits, when the Codex module is stopped or disabled, or when either one exits.
 *
 * A chat is a `cosapi-` session plus its ledger record (`engine: 'codex'`, `backendSessionId` =
 * the Codex thread id, started at creation). Each send is one `turn/start` with the chat's
 * approval policy (Ask = `untrusted`, Auto = `on-request`), `workspace-write` sandbox rooted at the
 * chat's canonical project folder and `approvalsReviewer: "user"`. Notifications of that thread
 * and turn are translated into `EngineEvent`s and written by the shared TurnProjector. Approval
 * requests are bound in the ApprovalGate to their JSON-RPC id, thread, turn, item, Codex approval
 * id and the sha256 of the command/changes; only the gate's own approval id is answered. A request
 * answered in the TUI (`serverRequest/resolved`) removes the card. Turns started from the TUI are
 * not mirrored into the chat (their approvals are left for the TUI to answer).
 *
 * Windows: the binary is resolved inside WSL (cli-modules), every Codex process runs through
 * `wsl.exe --exec`, the socket lives under the WSL home and folders are `wslpath -a` mapped.
 * Untested here; see AGENTS.md.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { logInfo, logWarn } from '../logger.js';
import { redactCredentialText } from '../redaction.js';
import { notifyChanged } from '../session/recorder.js';
import { bindSessionProject, createSession, getSession, readEvents } from '../session/store.js';
import { AGENT_ENGINE_LABELS } from '../../shared/agent-engine.js';
import {
  API_CHAT_APPROVAL_MODES, API_CONVERSATION_PREFIX, isApiConversationId, type ApiChatApprovalDecision, type ApiChatModel, type ApiChatView
} from '../../shared/api-chat.js';
import type { TurnOutcome } from '../../shared/session.js';
import { ApprovalGate, codexApprovalDecision, type ApprovalOutcome } from './approval.js';
import {
  checkCodexVersion, CODEX_APPROVAL_METHODS, CODEX_LEGACY_APPROVAL_METHODS, CODEX_LEGACY_DENIAL, codexApprovalBinding,
  codexEffort, codexFileChanges, codexInitializeParams, codexItemCompleted, codexItemStarted, codexModelRow, codexProxyArgv,
  codexRequestKey, codexServerArgv, codexTerminalArgv, codexThreadResumeParams, codexThreadStartParams, codexTurnOutcome,
  codexTurnStartParams, type CodexApprovalBinding, type CodexApprovalMethod
} from './codex-protocol.js';
import { connectWebSocket, JsonRpcPeer, type JsonRpcId } from './jsonrpc.js';
import type { WebSocket } from 'ws';
import { engineOf, chatRecords, storedChatRecord, updateChatRecord, type ChatRecord } from './ledger.js';
import { TurnProjector, storeProjectorSink, type ProjectorSink } from './projector.js';
import { claimTurnRecovery, closeInterruptedTurn } from './recovery.js';
import type { AgentEngine, EngineEvent, EngineFileChange, EngineModelQuery, EngineTerminal } from './types.js';

const LABEL = AGENT_ENGINE_LABELS.codex;
const MAX_INPUT_CHARS = 100_000;
const STATUS_TTL_MS = 30_000;
const MODELS_TTL_MS = 5 * 60_000;
const STOP_CONFIRM_MS = 15_000;
const STDERR_TAIL_CHARS = 4_000;
const modelId = z.string().min(1).max(200);

export const CODEX_NOT_SIGNED_IN = 'Codex is not signed in. Run `codex login` in a terminal, then try again.';
export const CODEX_SERVER_STOPPED = 'The Codex app-server stopped unexpectedly';
const LOCAL_FOLDER_ONLY = 'Codex chats need a project folder on this computer';

// ---------------------------------------------------------------- host (processes and paths)

export type CodexRuntime = { binary: string; windows: boolean };

/** The started processes of one connection: our JSON-RPC client and, when we own it, the server. */
export interface CodexProcesses {
  client: ChildProcess;
  server: ChildProcess | null;
  socket: string;
}

/** Everything outside this module the engine needs; tests replace it with a fake app-server. */
export interface CodexHost {
  runtime(): Promise<{ ok: true; runtime: CodexRuntime } | { ok: false; detail: string }>;
  /** `codex <args>` output (the version check). */
  run(runtime: CodexRuntime, args: string[]): Promise<string>;
  /** Starts the shared app-server when needed and a connected JSON-RPC client process. */
  open(runtime: CodexRuntime): Promise<CodexProcesses>;
  /** The chat's working folder as Codex sees it: the canonical local project root, else home. */
  workspace(projectId: string | null, runtime: CodexRuntime): Promise<string>;
  appVersion(): Promise<string>;
  /** Called when the Codex module is stopped or disabled, and when the app quits. */
  onShutdown?(listener: () => void): void;
  /** The chat's durable module terminal (cli-modules `cliEngineTerminal('codex', …)`). */
  openTerminal?(chat: { sessionId: string; projectId: string | null; args: string[]; title: string }): Promise<{ id: string }>;
  /** Runs before a Codex chat terminal attaches (from the chat or the sidebar): the server must run. */
  onTerminalOpen?(listener: () => Promise<void>): void;
}

const run = promisify(execFile);

async function childEnvironment(): Promise<NodeJS.ProcessEnv> {
  const { normalizeEnvironment, deleteEnvValue } = await import('../env.js');
  const environment = normalizeEnvironment();
  deleteEnvValue(environment, 'ELECTRON_RUN_AS_NODE');
  return environment as NodeJS.ProcessEnv;
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The real host: cli-modules resolution, a private socket directory, Electron's quit. */
export function defaultCodexHost(): CodexHost {
  let socketPath: string | null = null;
  const electron = async () => (await import('electron')).app;
  const modules = () => import('../cli-modules.js');
  const exec = (runtime: CodexRuntime, args: string[]): [string, string[]] =>
    runtime.windows ? ['wsl.exe', ['--exec', runtime.binary, ...args]] : [runtime.binary, args];

  async function socketFor(runtime: CodexRuntime): Promise<string> {
    if (socketPath) return socketPath;
    const app = await electron();
    const hash = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16);
    if (runtime.windows) {
      const dir = `${await (await modules()).cliWslHome()}/.cache/chat-marks-codex`;
      await run('wsl.exe', ['--exec', '/bin/sh', '-c', 'mkdir -p -m 700 "$1" && chmod 700 "$1"', 'sh', dir], { timeout: 8_000 });
      socketPath = `${dir}/${hash}.sock`;
      return socketPath;
    }
    let dir = path.join(app.getPath('userData'), 'codex');
    // A unix socket path is limited to ~104 bytes; a long profile path falls back to a private tmp dir.
    if (Buffer.byteLength(path.join(dir, `${hash}.sock`)) > 100) dir = path.join(os.tmpdir(), `chat-marks-codex-${process.getuid?.() ?? 'user'}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('The Codex socket folder is not private');
    await fs.chmod(dir, 0o700);
    socketPath = path.join(dir, `${hash}.sock`);
    return socketPath;
  }

  /** A server left by a crashed instance of this profile: stopped only when it is ours. */
  async function stopOrphan(socket: string): Promise<void> {
    const pidFile = `${socket}.pid`;
    const pid = Number((await fs.readFile(pidFile, 'utf8').catch(() => '')).trim());
    if (Number.isInteger(pid) && pid > 1) {
      const command = await run('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 3_000 }).then(result => result.stdout, () => '');
      if (command.includes('app-server') && command.includes(socket)) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        await delay(300);
      }
    }
    await fs.rm(pidFile, { force: true });
    await fs.rm(socket, { force: true });
  }

  async function waitForSocket(runtime: CodexRuntime, socket: string, server: ChildProcess): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(CODEX_SERVER_STOPPED);
      const ready = runtime.windows
        ? await run('wsl.exe', ['--exec', 'test', '-S', socket], { timeout: 4_000 }).then(() => true, () => false)
        // codex-cli 0.163 makes the path a symlink to its own /tmp/codex-daemon-<uid>/ socket:
        // followed, it must still be a socket of this user.
        : await fs.stat(socket).then(stat => stat.isSocket() && (!process.getuid || stat.uid === process.getuid()), () => false);
      if (ready) return;
      await delay(100);
    }
    throw new Error('The Codex app-server did not start in time');
  }

  return {
    runtime: async () => {
      const resolved = await (await modules()).cliEngineRuntime('codex');
      return resolved.ok ? { ok: true, runtime: { binary: resolved.binary, windows: resolved.windows } } : resolved;
    },
    run: async (runtime, args) => {
      const [file, argv] = exec(runtime, args);
      const { stdout, stderr } = await run(file, argv, { timeout: 8_000, maxBuffer: 16_384, env: await childEnvironment() });
      return `${stdout || stderr}`.trim().slice(0, 200);
    },
    open: async runtime => {
      const socket = await socketFor(runtime);
      const env = await childEnvironment();
      const home = (await electron()).getPath('home');
      if (!runtime.windows) await stopOrphan(socket);
      else await run('wsl.exe', ['--exec', 'rm', '-f', socket], { timeout: 8_000 }).catch(() => undefined);
      const [serverFile, serverArgs] = exec(runtime, codexServerArgv(socket));
      const server = spawn(serverFile, serverArgs, { cwd: home, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      if (!runtime.windows && server.pid) await fs.writeFile(`${socket}.pid`, String(server.pid), { mode: 0o600 }).catch(() => undefined);
      try {
        await waitForSocket(runtime, socket, server);
      } catch (error) {
        server.kill('SIGTERM');
        throw error;
      }
      const [clientFile, clientArgs] = exec(runtime, codexProxyArgv(socket));
      const client = spawn(clientFile, clientArgs, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      return { client, server, socket };
    },
    workspace: async (projectId, runtime) => {
      let folder: string;
      if (projectId) {
        const { projectWorkspace, localProjectPath } = await import('../projects.js');
        const local = localProjectPath(await projectWorkspace(projectId));
        if (!local) throw new Error(LOCAL_FOLDER_ONLY);
        folder = local;
      } else {
        folder = (await electron()).getPath('home');
      }
      if (!runtime.windows) return folder;
      const mapped = (await (await modules()).cliWslPath(folder)).trim();
      if (!mapped.startsWith('/')) throw new Error('Workspace could not be mapped to WSL');
      return mapped;
    },
    appVersion: async () => {
      try { return (await electron()).getVersion(); } catch { return '0'; }
    },
    openTerminal: async chat => (await modules()).cliEngineTerminal('codex', chat),
    onTerminalOpen: listener => {
      void modules().then(({ registerCliEngineOpenHook }) => registerCliEngineOpenHook('codex', () => listener())).catch(() => undefined);
    },
    onShutdown: listener => {
      void electron().then(app => { app?.on?.('will-quit', listener); }).catch(() => undefined);
      void modules().then(({ registerCliModuleStopHook }) => registerCliModuleStopHook(id => { if (id === 'codex') listener(); })).catch(() => undefined);
    }
  };
}

// ---------------------------------------------------------------- connection

interface Connection {
  peer: JsonRpcPeer;
  processes: CodexProcesses;
  version: string;
  warning: string | null;
  /** Threads this server has loaded (started or resumed) since it started. */
  loaded: Set<string>;
}

interface CodexTurn {
  sessionId: string;
  threadId: string;
  appTurnId: string;
  codexTurnId: string | null;
  projector: TurnProjector;
  gate: ApprovalGate;
  bindings: Map<string, CodexApprovalBinding>;
  /** File changes each fileChange item announced, for its approval card. */
  files: Map<string, EngineFileChange[]>;
  stopping: boolean;
  stopTimer: NodeJS.Timeout | null;
  sawFatal: boolean;
  usageBase: number[] | null;
  done: Promise<TurnOutcome>;
  settle(outcome: TurnOutcome): void;
}

export interface CodexEngineOptions {
  host?: CodexHost;
  /** Where a turn is written; tests may record. Defaults to the session store. */
  sink?(sessionId: string): ProjectorSink;
  streamWriteMs?: number;
}

export interface CodexEngine extends AgentEngine {
  /** Kills the app-server and our client; running turns fail. */
  shutdown(): void;
  /** A running turn's settled outcome, for tests and callers that wait. */
  turnDone(sessionId: string): Promise<TurnOutcome> | null;
}

export function createCodexEngine(options: CodexEngineOptions = {}): CodexEngine {
  const host = options.host ?? defaultCodexHost();
  const sinkFor = options.sink ?? storeProjectorSink;
  let connecting: Promise<Connection> | null = null;
  let current: Connection | null = null;
  let statusCache: { at: number; value: { available: boolean; detail: string } } | null = null;
  let modelsCache: { at: number; rows: Array<ApiChatModel & { isDefault: boolean }> } | null = null;
  let recovery: Promise<void> | null = null;
  const running = new Map<string, CodexTurn>();
  const byThread = new Map<string, CodexTurn>();

  let shutdownHooked = false;
  let terminalHooked = false;
  let lastSocket: string | null = null;

  function shutdown(): void {
    const connection = current;
    current = null;
    connecting = null;
    statusCache = null;
    if (!connection) return;
    connection.peer.close(new Error(CODEX_SERVER_STOPPED));
    killProcesses(connection.processes);
  }

  function killProcesses(processes: CodexProcesses): void {
    for (const child of [processes.client, processes.server]) {
      if (!child || child.exitCode !== null || child.signalCode !== null) continue;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      const timer = setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* gone */ } }, 2_000);
      timer.unref?.();
    }
  }

  function lost(connection: Connection, reason: Error): void {
    if (current === connection) { current = null; connecting = null; statusCache = null; }
    killProcesses(connection.processes);
    if (reason.message !== CODEX_SERVER_STOPPED) logWarn(`Codex app-server connection closed: ${reason.message.slice(0, 200)}`);
    for (const turn of [...running.values()]) {
      void turn.projector.apply({ type: 'error', message: CODEX_SERVER_STOPPED, fatal: true });
      void finish(turn, 'failed');
    }
  }

  async function runtimeOrThrow(): Promise<CodexRuntime> {
    const resolved = await host.runtime();
    if (!resolved.ok) throw new Error(resolved.detail);
    return resolved.runtime;
  }

  function connection(): Promise<Connection> {
    if (current && !current.peer.closed) return Promise.resolve(current);
    connecting ??= (async () => {
      if (!shutdownHooked) { shutdownHooked = true; host.onShutdown?.(() => shutdown()); }
      const runtime = await runtimeOrThrow();
      const version = checkCodexVersion(await host.run(runtime, ['--version']).catch(() => null));
      if (!version.ok) throw new Error(version.detail);
      const processes = await host.open(runtime);
      let stderr = '';
      const peerHolder: { peer?: JsonRpcPeer } = {};
      const holder: { connection?: Connection } = {};
      for (const child of [processes.client, processes.server]) {
        child?.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS); });
        child?.on('exit', code => {
          logInfo(`Codex ${child === processes.server ? 'app-server' : 'client'} exited (${code ?? 'signal'})`);
          peerHolder.peer?.close(new Error(CODEX_SERVER_STOPPED));
        });
        child?.on('error', () => peerHolder.peer?.close(new Error(CODEX_SERVER_STOPPED)));
      }
      const failed = (error: unknown): Error => {
        const tail = redactCredentialText(stderr).trim().split('\n').pop()?.slice(0, 200);
        peerHolder.peer?.close(new Error(CODEX_SERVER_STOPPED));
        killProcesses(processes);
        return new Error(`Codex app-server did not start: ${(error as Error).message}${tail ? ` (${tail})` : ''}`);
      };
      let socket: WebSocket;
      try {
        // The socket speaks WebSocket (codex-cli 0.163); the proxy carries the upgrade and frames.
        socket = await connectWebSocket(processes.client.stdout!, processes.client.stdin!, { timeoutMs: 20_000 });
      } catch (error) {
        throw failed(error);
      }
      const peer = new JsonRpcPeer({
        socket,
        onNotification: (method, params) => onNotification(method, params),
        onRequest: (id, method, params) => onRequest(peer, id, method, params),
        onClose: reason => { if (holder.connection) lost(holder.connection, reason); else killProcesses(processes); }
      });
      peerHolder.peer = peer;
      const connection: Connection = { peer, processes, version: version.version, warning: version.warning, loaded: new Set() };
      holder.connection = connection;
      try {
        await peer.request('initialize', codexInitializeParams(await host.appVersion()), { timeoutMs: 20_000 });
        peer.notify('initialized');
      } catch (error) {
        throw failed(error);
      }
      current = connection;
      lastSocket = processes.socket;
      return connection;
    })().finally(() => { connecting = null; });
    return connecting;
  }

  // ---------------------------------------------------------------- server messages

  function turnFor(params: unknown): CodexTurn | null {
    const value = params as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
    const turn = typeof value?.threadId === 'string' ? byThread.get(value.threadId) : undefined;
    if (!turn) return null;
    const turnId = typeof value.turnId === 'string' ? value.turnId : typeof value.turn?.id === 'string' ? value.turn.id : null;
    // A turn of the same thread started elsewhere (the TUI) is not this chat's.
    if (turnId && turn.codexTurnId && turnId !== turn.codexTurnId) return null;
    return turn;
  }

  function apply(turn: CodexTurn, events: EngineEvent[]): void {
    for (const event of events) void turn.projector.apply(event).catch(error => logWarn(`Codex chat ${turn.sessionId}: ${(error as Error).message}`));
  }

  function onNotification(method: string, params: unknown): void {
    const turn = turnFor(params);
    if (!turn) return;
    const value = params as Record<string, unknown>;
    switch (method) {
      case 'turn/started': {
        const id = (value.turn as { id?: unknown })?.id;
        if (!turn.codexTurnId && typeof id === 'string') { turn.codexTurnId = id; if (turn.stopping) interrupt(turn); }
        return;
      }
      case 'item/started': {
        const item = value.item as Record<string, unknown>;
        if (item?.type === 'fileChange' && typeof item.id === 'string') turn.files.set(item.id, codexFileChanges(item.changes));
        apply(turn, item ? codexItemStarted(item) : []);
        return;
      }
      case 'item/fileChange/patchUpdated':
        if (typeof value.itemId === 'string') turn.files.set(value.itemId, codexFileChanges(value.changes));
        return;
      case 'item/completed': {
        const item = value.item as Record<string, unknown>;
        apply(turn, item ? codexItemCompleted(item) : []);
        return;
      }
      case 'item/agentMessage/delta':
        if (typeof value.delta === 'string') apply(turn, [{ type: 'text_delta', delta: value.delta }]);
        return;
      case 'item/commandExecution/outputDelta':
        if (typeof value.itemId === 'string' && typeof value.delta === 'string') apply(turn, [{ type: 'tool_output', toolId: value.itemId, chunk: value.delta }]);
        return;
      case 'thread/tokenUsage/updated': {
        const usage = value.tokenUsage as { total?: Record<string, unknown>; last?: Record<string, unknown> } | undefined;
        const pick = (row: Record<string, unknown> | undefined): number[] =>
          ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'].map(key => Number(row?.[key]) || 0);
        const total = pick(usage?.total), last = pick(usage?.last);
        // The thread's totals before this turn: the first update's total minus its own request.
        turn.usageBase ??= total.map((value, index) => Math.max(0, value - last[index]!));
        const [input, output, cached, reasoning] = total.map((value, index) => Math.max(0, value - turn.usageBase![index]!));
        apply(turn, [{ type: 'usage', inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningTokens: reasoning }]);
        return;
      }
      case 'error': {
        const error = value.error as { message?: unknown } | undefined;
        const message = typeof error?.message === 'string' ? error.message.slice(0, 2_000) : 'Codex reported an error';
        if (value.willRetry === true) apply(turn, [{ type: 'error', message: `Codex is retrying: ${message}` }]);
        else { turn.sawFatal = true; apply(turn, [{ type: 'error', message, fatal: true }]); }
        return;
      }
      case 'serverRequest/resolved': {
        const id = value.requestId;
        if (typeof id !== 'string' && typeof id !== 'number') return;
        const key = codexRequestKey(id);
        // Answered elsewhere (the TUI) or withdrawn: the card goes and nothing is sent.
        if (turn.bindings.delete(key)) apply(turn, [{ type: 'approval_resolved', requestId: key }]);
        return;
      }
      case 'turn/completed': {
        const done = value.turn as { status?: unknown; error?: { message?: unknown } | null } | undefined;
        const message = typeof done?.error?.message === 'string' ? done.error.message.slice(0, 2_000) : null;
        if (message && !turn.sawFatal) apply(turn, [{ type: 'error', message, fatal: true }]);
        void finish(turn, codexTurnOutcome(done?.status, turn.stopping), message ?? undefined);
        return;
      }
      default:
    }
  }

  function onRequest(peer: JsonRpcPeer, id: JsonRpcId, method: string, params: unknown): void {
    if ((CODEX_LEGACY_APPROVAL_METHODS as readonly string[]).includes(method)) { safe(() => peer.respond(id, CODEX_LEGACY_DENIAL)); return; }
    if (!(CODEX_APPROVAL_METHODS as readonly string[]).includes(method)) {
      safe(() => peer.respondError(id, -32601, `Chat Marks does not handle ${method.slice(0, 100)}`));
      return;
    }
    const turn = turnFor(params);
    // An approval for a turn this app did not start (one typed in the TUI) is left to the TUI.
    if (!turn) return;
    const itemId = (params as { itemId?: unknown })?.itemId;
    const binding = codexApprovalBinding(id, method as CodexApprovalMethod, params, typeof itemId === 'string' ? turn.files.get(itemId) : undefined);
    if (!binding) { safe(() => peer.respond(id, { decision: 'decline' })); return; }
    if (turn.stopping) { safe(() => peer.respond(id, { decision: 'cancel' })); return; }
    const key = codexRequestKey(id);
    turn.bindings.set(key, binding);
    apply(turn, [{
      type: 'approval_requested', requestId: key, toolId: binding.itemId, kind: binding.kind, tool: binding.tool,
      summary: binding.summary, files: binding.files, action: binding.action
    }]);
  }

  /** The gate's answer for one bound request: exactly that JSON-RPC id, once. */
  function answer(turn: CodexTurn, key: string, outcome: ApprovalOutcome): void {
    const binding = turn.bindings.get(key);
    if (!binding) return;
    const decision = codexApprovalDecision(outcome);
    if (!decision) return;
    turn.bindings.delete(key);
    const peer = current?.peer;
    if (peer && !peer.closed) safe(() => peer.respond(binding.rpcId, { decision }));
  }

  function interrupt(turn: CodexTurn): void {
    const peer = current?.peer;
    if (!peer || !turn.codexTurnId) return;
    void peer.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.codexTurnId }, { timeoutMs: 10_000 })
      .catch(error => logWarn(`Codex chat ${turn.sessionId}: interrupt failed: ${(error as Error).message}`));
  }

  async function finish(turn: CodexTurn, outcome: TurnOutcome, detail?: string): Promise<void> {
    if (running.get(turn.sessionId) === turn) running.delete(turn.sessionId);
    if (byThread.get(turn.threadId) === turn) byThread.delete(turn.threadId);
    if (turn.stopTimer) clearTimeout(turn.stopTimer);
    const ended = await turn.projector.finish(outcome, detail).catch(error => {
      logWarn(`Codex chat ${turn.sessionId}: turn not closed: ${(error as Error).message}`);
      return outcome;
    });
    turn.settle(ended);
  }

  // ---------------------------------------------------------------- chats

  async function codexSession(sessionId: string): Promise<{ id: string; conversationId: string; projectId: string | null; record: ChatRecord }> {
    const session = await getSession(sessionId);
    if (!session || !isApiConversationId(session.conversationId)) throw new Error('This is not an API chat');
    const record = await storedChatRecord(session.id);
    if (!record || engineOf(record) !== 'codex') throw new Error('This chat runs on another engine');
    return { id: session.id, conversationId: session.conversationId, projectId: session.projectId ?? null, record };
  }

  async function view(sessionId: string): Promise<ApiChatView> {
    const session = await codexSession(sessionId);
    const turn = running.get(session.id);
    return {
      sessionId: session.id, conversationId: session.conversationId, engine: 'codex', model: session.record.model,
      effort: session.record.effort, running: !!turn, approval: session.record.approval ?? 'ask', pending: turn?.gate.view() ?? null
    };
  }

  async function startThread(connection: Connection, input: { model: string | null; cwd: string; approval: ChatRecord['approval'] }): Promise<string> {
    const started = await connection.peer.request<{ thread?: { id?: unknown } }>('thread/start',
      codexThreadStartParams({ model: input.model, cwd: input.cwd, approval: input.approval ?? 'ask' }), { timeoutMs: 30_000 });
    const threadId = started?.thread?.id;
    if (typeof threadId !== 'string' || !threadId || threadId.length > 200) throw new Error('Codex did not start a thread');
    connection.loaded.add(threadId);
    return threadId;
  }

  async function models(query: EngineModelQuery): Promise<{ models: ApiChatModel[]; total: number }> {
    if (query.refresh || !modelsCache || Date.now() - modelsCache.at > MODELS_TTL_MS) {
      const connection = await connection_();
      const rows: Array<ApiChatModel & { isDefault: boolean }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const listed: { data?: unknown; nextCursor?: unknown } = await connection.peer.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, { timeoutMs: 20_000 });
        for (const entry of Array.isArray(listed?.data) ? listed.data : []) {
          const row = codexModelRow(entry);
          if (row && !rows.some(existing => existing.id === row.id)) rows.push(row);
        }
        cursor = typeof listed?.nextCursor === 'string' && listed.nextCursor ? listed.nextCursor : null;
        if (!cursor) break;
      }
      modelsCache = { at: Date.now(), rows };
    }
    if (query.modality && query.modality !== 'chat') return { models: [], total: 0 };
    const needle = query.query?.trim().toLowerCase() ?? '';
    const matched = modelsCache.rows.filter(row => !needle || row.id.toLowerCase().includes(needle) || row.label?.toLowerCase().includes(needle));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return { models: matched.slice(offset, offset + limit).map(({ isDefault: _default, ...row }) => { void _default; return { ...row, efforts: [...(row.efforts ?? [])] }; }), total: matched.length };
  }
  const connection_ = connection;

  async function status(): Promise<{ available: boolean; detail: string }> {
    if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
    const value = await (async () => {
      const resolved = await host.runtime();
      if (!resolved.ok) return { available: false, detail: resolved.detail };
      const version = checkCodexVersion(await host.run(resolved.runtime, ['--version']).catch(() => null));
      if (!version.ok) return { available: false, detail: version.detail };
      try {
        const connection = await connection_();
        const account = await connection.peer.request<{ account?: { type?: unknown } | null; requiresOpenaiAuth?: unknown }>('account/read', { refreshToken: false }, { timeoutMs: 15_000 });
        if (!account?.account && account?.requiresOpenaiAuth !== false) return { available: false, detail: CODEX_NOT_SIGNED_IN };
        const kind = typeof account.account?.type === 'string' ? account.account.type : 'provider';
        return { available: true, detail: `Codex ${version.version} · ${kind}${version.warning ? ` · ${version.warning}` : ''}` };
      } catch (error) {
        return { available: false, detail: (error as Error).message.slice(0, 200) };
      }
    })();
    statusCache = { at: Date.now(), value };
    return value;
  }

  async function create(input: { projectId: string | null; model?: string }): Promise<ApiChatView> {
    await recover();
    const runtime = await runtimeOrThrow();
    const cwd = await host.workspace(input.projectId, runtime);
    const connection = await connection_();
    let model = input.model ? modelId.parse(input.model) : null;
    if (!model) model = (await models({ limit: 200 }).then(() => modelsCache?.rows.find(row => row.isDefault)?.id ?? null).catch(() => null));
    const threadId = await startThread(connection, { model, cwd, approval: 'ask' });
    const summary = await createSession({ title: `New ${LABEL} chat`, titleSource: 'fallback', conversationId: `${API_CONVERSATION_PREFIX}${randomUUID()}` });
    if (input.projectId) await bindSessionProject(summary.id, input.projectId);
    await updateChatRecord(summary.id, () => ({ engine: 'codex', backendSessionId: threadId, model, effort: null, approval: 'ask' }));
    notifyChanged(summary.id);
    return view(summary.id);
  }

  /** The chat's thread, loaded in this server: resumed after a restart, started when it never ran. */
  async function threadOf(connection: Connection, session: Awaited<ReturnType<typeof codexSession>>, cwd: string): Promise<string> {
    const approval = session.record.approval ?? 'ask';
    const known = session.record.backendSessionId;
    if (known && connection.loaded.has(known)) return known;
    if (known) {
      try {
        await connection.peer.request('thread/resume', codexThreadResumeParams({ threadId: known, cwd, approval }), { timeoutMs: 30_000 });
        connection.loaded.add(known);
        return known;
      } catch (error) {
        // Codex writes a thread to disk with its first turn: a chat that never ran starts a new one.
        const ran = (await readEvents(session.id, { kinds: ['turn_start'] })).length > 0;
        if (ran) throw new Error(`The Codex thread of this chat could not be resumed: ${(error as Error).message}`);
      }
    }
    const threadId = await startThread(connection, { model: session.record.model, cwd, approval });
    await updateChatRecord(session.id, current => current ? { ...current, backendSessionId: threadId } : current);
    return threadId;
  }

  async function send(sessionId: string, text: string): Promise<{ turnId: string }> {
    await recover();
    if (!text.trim() || text.length > MAX_INPUT_CHARS) throw new Error('Write a message of up to 100,000 characters');
    const session = await codexSession(sessionId);
    if (running.has(session.id)) throw new Error('This chat is still answering');
    const appTurnId = `api-${randomUUID()}`;
    let settle!: (outcome: TurnOutcome) => void;
    const done = new Promise<TurnOutcome>(resolve => { settle = resolve; });
    const gate = new ApprovalGate(() => notifyChanged(session.id));
    const holder: { turn?: CodexTurn } = {};
    const projector = new TurnProjector({
      engine: 'codex', conversationId: session.conversationId, turnId: appTurnId, sink: sinkFor(session.id),
      approvals: { gate, answer: (key, outcome) => { if (holder.turn) answer(holder.turn, key, outcome); } },
      ...(options.streamWriteMs !== undefined ? { streamWriteMs: options.streamWriteMs } : {})
    });
    const placeholder: CodexTurn = {
      sessionId: session.id, threadId: '', appTurnId, codexTurnId: null, projector, gate, bindings: new Map(), files: new Map(),
      stopping: false, stopTimer: null, sawFatal: false, usageBase: null, done, settle
    };
    holder.turn = placeholder;
    // Claimed with no await before it: one turn per chat.
    running.set(session.id, placeholder);
    let started = false;
    try {
      const runtime = await runtimeOrThrow();
      const cwd = await host.workspace(session.projectId, runtime);
      const connection = await connection_();
      const threadId = await threadOf(connection, session, cwd);
      placeholder.threadId = threadId;
      if (byThread.has(threadId)) throw new Error('This chat is still answering');
      byThread.set(threadId, placeholder);
      const record = (await storedChatRecord(session.id)) ?? session.record;
      const model = record.model;
      const row = modelsCache?.rows.find(candidate => candidate.id === model);
      await projector.start(text);
      started = true;
      if (placeholder.stopping) { await finish(placeholder, 'stopped'); return { turnId: appTurnId }; }
      const params = codexTurnStartParams({ threadId, text, model, effort: codexEffort(record.effort, row), cwd, approval: record.approval ?? 'ask' });
      void connection.peer.request<{ turn?: { id?: unknown } }>('turn/start', params, { timeoutMs: 60_000 }).then(response => {
        const id = response?.turn?.id;
        if (!placeholder.codexTurnId && typeof id === 'string') {
          placeholder.codexTurnId = id;
          if (placeholder.stopping) interrupt(placeholder);
        }
      }, async (error: Error) => {
        if (projector.ended) return;
        placeholder.sawFatal = true;
        await projector.apply({ type: 'error', message: `Codex did not start the turn: ${error.message.slice(0, 500)}`, fatal: true });
        await finish(placeholder, 'failed');
      });
      return { turnId: appTurnId };
    } catch (error) {
      if (started) {
        await projector.apply({ type: 'error', message: (error as Error).message.slice(0, 500), fatal: true }).catch(() => undefined);
        await finish(placeholder, 'failed');
      } else {
        if (running.get(session.id) === placeholder) running.delete(session.id);
        if (byThread.get(placeholder.threadId) === placeholder) byThread.delete(placeholder.threadId);
        settle('failed');
      }
      throw error;
    }
  }

  async function stop(sessionId: string): Promise<boolean> {
    const turn = running.get(sessionId);
    if (!turn) { await codexSession(sessionId); return false; }
    if (turn.stopping) return true;
    turn.stopping = true;
    // Every pending approval answers `cancel`; a later request is cancelled as it arrives.
    turn.gate.stop();
    interrupt(turn);
    turn.stopTimer = setTimeout(() => { void finish(turn, 'stopped', 'Codex did not confirm the stop in time'); }, STOP_CONFIRM_MS);
    turn.stopTimer.unref?.();
    notifyChanged(sessionId);
    return true;
  }

  async function setChatSettings(sessionId: string, patch: { model?: string; effort?: ChatRecord['effort']; approval?: ChatRecord['approval'] }): Promise<ApiChatView> {
    const session = await codexSession(sessionId);
    await updateChatRecord(session.id, record => ({
      ...(record ?? session.record),
      ...(patch.model !== undefined ? { model: modelId.parse(patch.model) } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      ...(patch.approval !== undefined ? { approval: z.enum(API_CHAT_APPROVAL_MODES).parse(patch.approval) } : {})
    }));
    return view(session.id);
  }

  async function approve(sessionId: string, approvalId: string, decision: ApiChatApprovalDecision): Promise<ApiChatView> {
    const session = await codexSession(sessionId);
    const gate = (): ApprovalGate | null => {
      const approvals = running.get(session.id)?.gate;
      return approvals?.has(approvalId) ? approvals : null;
    };
    if (!gate()) throw new Error('This approval is no longer pending');
    // As in CLIProxy chats: Always also switches the chat to Auto (`on-request`) from the next turn.
    if (decision === 'always') await setChatSettings(session.id, { approval: 'auto' });
    if (!gate()?.answer(approvalId, decision)) throw new Error('This approval is no longer pending');
    return view(session.id);
  }

  /**
   * Startup: a turn the previous process left open is resumed in Codex first (`thread/resume`,
   * and `turn/interrupt` when Codex still reports it in progress), so the thread keeps its history
   * and accepts the next turn; then the chat's turn is closed `interrupted`.
   */
  function recover(): Promise<void> {
    hookTerminals();
    recovery ??= (async () => {
      for (const [sessionId, record] of Object.entries(await chatRecords())) {
        const open = record.openTurn;
        if (engineOf(record) !== 'codex' || !open || running.has(sessionId)) continue;
        let resumed = false;
        try {
          const threadId = record.backendSessionId;
          if (threadId) {
            const session = await getSession(sessionId);
            const runtime = await runtimeOrThrow();
            const cwd = await host.workspace(session?.projectId ?? null, runtime);
            const connection = await connection_();
            const result = await connection.peer.request<{ thread?: { turns?: Array<{ id?: unknown; status?: unknown }> } }>('thread/resume',
              codexThreadResumeParams({ threadId, cwd, approval: record.approval ?? 'ask' }), { timeoutMs: 30_000 });
            connection.loaded.add(threadId);
            resumed = true;
            const last = result?.thread?.turns?.at(-1);
            if (last?.status === 'inProgress' && typeof last.id === 'string') {
              await connection.peer.request('turn/interrupt', { threadId, turnId: last.id }, { timeoutMs: 10_000 }).catch(() => undefined);
            }
          }
        } catch (error) {
          logWarn(`Codex chat ${sessionId}: thread not resumed: ${(error as Error).message.slice(0, 200)}`);
        }
        try {
          await closeInterruptedTurn(sessionId, open.turnId, resumed
            ? 'Chat Marks closed before Codex finished this turn; the Codex thread was resumed and keeps its history'
            : 'Chat Marks closed before Codex finished this turn');
        } catch (error) {
          logWarn(`Codex chat ${sessionId}: open turn not recovered: ${(error as Error).message}`);
        }
      }
    })();
    return recovery;
  }

  /** The live terminal's argv once the server's socket is known (it is fixed per profile). */
  function terminal(chat: { backendSessionId: string | null }): EngineTerminal | null {
    const socket = current?.processes.socket ?? lastSocket;
    return chat.backendSessionId && socket ? { argv: codexTerminalArgv(chat.backendSessionId, socket), mode: 'live' } : null;
  }

  function hookTerminals(): void {
    if (terminalHooked) return;
    terminalHooked = true;
    host.onTerminalOpen?.(async () => { await connection_(); });
  }

  /**
   * Live: the chat's Codex TUI attaches to the server and thread the chat runs on, so it may open
   * while a turn runs; approvals answered there clear the chat's card (serverRequest/resolved).
   */
  async function openTerminal(sessionId: string): Promise<{ cliSessionId: string }> {
    hookTerminals();
    const session = await codexSession(sessionId);
    if (!host.openTerminal) throw new Error('Terminals are not available');
    const threadId = session.record.backendSessionId;
    if (!threadId) throw new Error('This chat has no engine session yet');
    const connection = await connection_();
    const chat = await getSession(session.id);
    const opened = await host.openTerminal({
      sessionId: session.id, projectId: session.projectId, args: codexTerminalArgv(threadId, connection.processes.socket),
      title: `${LABEL} · ${(chat?.title ?? '').slice(0, 80)}`.trim()
    });
    return { cliSessionId: opened.id };
  }

  return {
    id: 'codex', label: LABEL, terminalMode: 'live',
    status, models, create, view, send, stop, approve, setChatSettings, recover, terminal, openTerminal, shutdown,
    turnDone: sessionId => running.get(sessionId)?.done ?? null
  };
}

let singleton: CodexEngine | null = null;
/** The app's Codex engine (one shared app-server per app instance). */
export function codexEngine(): CodexEngine {
  singleton ??= createCodexEngine();
  return singleton;
}

function safe(write: () => void): void {
  try { write(); } catch (error) { logWarn(`Codex reply not sent: ${(error as Error).message}`); }
}

// Codex resumes its own threads on startup; the CLIProxy recovery leaves Codex records alone.
claimTurnRecovery('codex');
