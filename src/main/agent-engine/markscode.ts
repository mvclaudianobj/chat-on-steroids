/**
 * The `markscode` agent engine: a Chat Marks API chat whose turns run in a session of the
 * MarksCode shared background service (`markscode service start`, `serve --service`), over its
 * HTTP API (markscode-client.ts). The same session can be opened live in the module's durable
 * tmux terminal (`markscode -s <session> .`), so the TUI and the chat show one conversation.
 *
 * - status: module enabled, command capability, binary (cli-modules resolution), the service's
 *   registration readable and `/api/info` answering with the registered pid. The service is only
 *   started by `startMarksCodeService()`, an explicit user action; status never starts it.
 * - create: only in an approved project (canonical folder; WSL path on Windows). The backend
 *   session is created at that location with a ruleset that asks before `shell` and `edit`, and
 *   denies `external_directory` and absolute (outside the project) `edit`/`read` resources.
 * - send: the event stream connects before the prompt is posted; events go through the E0
 *   projector in order. `permission.asked` becomes an ApprovalGate card bound to the sha256 of
 *   {sessionID, requestID, action, resources}; the answer is posted to that exact request after
 *   the live request is read back and still matches. `permission.replied` that this app did not
 *   send (the TUI answered) removes the card. `session.execution.*` ends the turn.
 * - The stream is volatile: after every reconnect the turn is reconciled from pending
 *   permissions, `/api/session/active` and the session's messages.
 * - recover: a turn left open by the previous process is re-attached while its session still
 *   runs; otherwise what finished is imported and the turn closes.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { logInfo, logWarn } from '../logger.js';
import { notifyChanged } from '../session/recorder.js';
import { bindSessionProject, createSession, getSession, readEvents, upsertMessageEvent } from '../session/store.js';
import { AGENT_ENGINE_LABELS } from '../../shared/agent-engine.js';
import {
  API_CHAT_APPROVAL_MODES, API_CONVERSATION_PREFIX, isApiConversationId,
  type ApiChatApprovalDecision, type ApiChatApprovalMode, type ApiChatEffort, type ApiChatModel, type ApiChatView
} from '../../shared/api-chat.js';
import type { TurnOutcome } from '../../shared/session.js';
import { closeTurnInterrupted, MAX_API_CHAT_INPUT_CHARS } from '../api-chat/executor.js';
import { ApprovalGate, argsHash, marksCodeApprovalDecision, type ApprovalOutcome } from './approval.js';
import { chatRecords, storedChatRecord, updateChatRecord, type ChatRecord } from './ledger.js';
import { storeProjectorSink, TurnProjector, type ProjectorSink } from './projector.js';
import { engineToolCallId } from './tool-row.js';
import { assistantMessageId } from './transcript.js';
import type { AgentEngine, EngineChatRef, EngineEvent, EngineFileChange, EngineModelQuery, EngineTerminal, EngineToolKind } from './types.js';
import {
  MarksCodeClient, MarksCodeHttpError, type MarksCodeEndpoint, type MarksCodeEvent, type MarksCodeModel, type MarksCodeModelRef,
  type MarksCodePermission, type MarksCodeRule
} from './markscode-client.js';

const ENGINE = 'markscode' as const;
const LABEL = AGENT_ENGINE_LABELS.markscode;
const MAX_REGISTRATION_BYTES = 64 * 1024;
const STOP_GRACE_MS = 5_000;
const CONNECT_WAIT_MS = 10_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];
const BACKEND_ID = /^[A-Za-z0-9_-]{1,200}$/;
const modelId = z.string().min(1).max(200);

export const SERVICE_STOPPED = 'The MarksCode service is stopped. Start it from Settings > Modules.';

// ---------------------------------------------------------------- dependencies

export interface MarksCodeDeps {
  /** The module as cli-modules sees it (enabled, command capability, resolved binary). */
  moduleState(): Promise<{ enabled: boolean; command: boolean; binary: string | null }>;
  /** An approved project's canonical folder: `native` for this app, `backend` as MarksCode sees it (WSL on Windows). */
  projectFolder(projectId: string): Promise<{ native: string; backend: string }>;
  /** The service registration file's text (`{ url, pid, password, version }`), or null when there is none. */
  registration(): Promise<string | null>;
  /** `markscode service start`: only ever called by `startMarksCodeService()`. */
  startService(binary: string): Promise<void>;
  fetch: typeof fetch;
  reconnectDelaysMs?: readonly number[];
  stopGraceMs?: number;
}

const run = promisify(execFile);

/** `<XDG_STATE_HOME>/markscode/service.json` (MarksCode `util/src/global-roots.ts`, `service-config.ts` `filename`). */
export function registrationPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'markscode', 'service.json');
}

const defaultDeps: MarksCodeDeps = {
  moduleState: async () => (await import('../cli-modules.js')).cliModuleState('markscode'),
  async projectFolder(projectId) {
    const { projectWorkspace, serverRootOf } = await import('../projects.js');
    const workspace = await projectWorkspace(projectId);
    if (serverRootOf(workspace.virtual)) throw new Error('MarksCode chats need a project folder on this computer');
    const { cliChatRuntime } = await import('../cli-modules.js');
    const runtime = await cliChatRuntime('markscode', projectId);
    // On Windows the runtime runs inside WSL: `--cd <wslpath>` is its folder there.
    const backend = process.platform === 'win32' ? runtime.argsPrefix[1] : runtime.cwd;
    if (!backend || !backend.startsWith('/') || runtime.cwd !== workspace.real) throw new Error('Project folder changed or is unavailable');
    return { native: runtime.cwd, backend };
  },
  async registration() {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await run('wsl.exe', ['--exec', 'sh', '-c', 'cat -- "${XDG_STATE_HOME:-$HOME/.local/state}/markscode/service.json"'],
          { timeout: 8_000, maxBuffer: MAX_REGISTRATION_BYTES });
        return stdout;
      }
      const text = await readFile(registrationPath(), 'utf8');
      return text.length > MAX_REGISTRATION_BYTES ? null : text;
    } catch { return null; }
  },
  async startService(binary) {
    await run(process.platform === 'win32' ? 'wsl.exe' : binary, [...(process.platform === 'win32' ? ['--exec', binary] : []), 'service', 'start'],
      { timeout: 60_000, maxBuffer: 65_536 });
  },
  fetch: (...args) => fetch(...args)
};

let deps: MarksCodeDeps = defaultDeps;

/** Tests replace the service, module and project lookups; null restores the real ones. */
export function setMarksCodeDepsForTests(next: Partial<MarksCodeDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

// ---------------------------------------------------------------- endpoint and status

/** The registration's URL and password; only a loopback http URL is trusted with the password. */
export function parseRegistration(text: string | null): MarksCodeEndpoint | null {
  if (!text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const info = parsed as { url?: unknown; password?: unknown; pid?: unknown };
  if (typeof info?.url !== 'string') return null;
  let url: URL;
  try { url = new URL(info.url); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  return {
    url: url.origin,
    password: typeof info.password === 'string' && info.password ? info.password : null,
    ...(typeof info.pid === 'number' && Number.isInteger(info.pid) && info.pid > 0 ? { pid: info.pid } : {})
  };
}

async function endpoint(): Promise<MarksCodeEndpoint | null> {
  return parseRegistration(await deps.registration());
}

/** A client for the running service; refused with a readable reason when it is not running. */
async function connect(): Promise<MarksCodeClient> {
  const found = await endpoint();
  if (!found) throw new Error(SERVICE_STOPPED);
  return new MarksCodeClient(found, deps.fetch);
}

export interface MarksCodeStatus {
  available: boolean;
  detail: string;
  /** What a user action could fix: `start` means the service is stopped and can be started. */
  fix: 'enable' | 'install' | 'start' | null;
}

export async function marksCodeStatus(): Promise<MarksCodeStatus> {
  let state: Awaited<ReturnType<MarksCodeDeps['moduleState']>>;
  try {
    state = await deps.moduleState();
  } catch {
    return { available: false, detail: 'The MarksCode module status is unavailable', fix: null };
  }
  try {
    if (!state.command) return { available: false, detail: 'Command execution is disabled', fix: null };
    if (!state.enabled) return { available: false, detail: 'Enable the MarksCode module in Settings > Modules', fix: 'enable' };
    if (!state.binary) return { available: false, detail: 'MarksCode is not installed', fix: 'install' };
    const found = await endpoint();
    if (!found) return { available: false, detail: SERVICE_STOPPED, fix: 'start' };
    const info = await new MarksCodeClient(found, deps.fetch).info();
    // A registration left by a server that died names a pid nobody answers for.
    if (found.pid !== undefined && info?.pid !== found.pid) return { available: false, detail: SERVICE_STOPPED, fix: 'start' };
    return { available: true, detail: `MarksCode${info?.version ? ` ${String(info.version).slice(0, 40)}` : ''} · ${found.url}`, fix: null };
  } catch (error) {
    if (error instanceof MarksCodeHttpError && error.status === 401) return { available: false, detail: error.message, fix: null };
    if (error instanceof MarksCodeHttpError) return { available: false, detail: error.message.slice(0, 200), fix: null };
    return { available: false, detail: SERVICE_STOPPED, fix: 'start' };
  }
}

let starting: Promise<MarksCodeStatus> | null = null;

/** The explicit "Start the MarksCode service" action: `markscode service start`, then the status. */
export function startMarksCodeService(): Promise<MarksCodeStatus> {
  starting ??= (async () => {
    const before = await marksCodeStatus();
    if (before.available || before.fix !== 'start') return before;
    const state = await deps.moduleState();
    if (!state.binary || !state.enabled || !state.command) return marksCodeStatus();
    logInfo('MarksCode: starting the background service at the user\'s request');
    await deps.startService(state.binary);
    for (let attempt = 0; attempt < 20; attempt++) {
      const after = await marksCodeStatus();
      if (after.available) return after;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return marksCodeStatus();
  })().finally(() => { starting = null; });
  return starting;
}

// ---------------------------------------------------------------- rules, models, mapping

/**
 * The session's permissions (`Permission.Ruleset`; MarksCode evaluates the last matching rule,
 * and a session `deny` wins over saved "always" rules). Inside the project, resources are
 * project-relative; outside it they are absolute and gated by `external_directory`.
 */
export function marksCodeRuleset(mode: ApiChatApprovalMode): MarksCodeRule[] {
  const effect = mode === 'auto' ? 'allow' : 'ask';
  return [
    { action: 'shell', resource: '*', effect },
    { action: 'edit', resource: '*', effect },
    { action: 'edit', resource: '/*', effect: 'deny' },
    { action: 'read', resource: '/*', effect: 'deny' },
    { action: 'external_directory', resource: '*', effect: 'deny' }
  ];
}

/** `provider/model` as the chat stores it, the `Model.Ref` string form without its variant. */
export const modelRowId = (model: Pick<MarksCodeModel, 'id' | 'providerID'>): string => `${model.providerID}/${model.id}`;

export function modelRef(id: string, variant: string | null): MarksCodeModelRef {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) throw new Error('Choose a MarksCode model (provider/model)');
  return { providerID: id.slice(0, slash), id: id.slice(slash + 1), ...(variant ? { variant } : {}) };
}

/** What the user is asked about and its hash input: the exact request, nothing the renderer sent. */
export function boundAction(request: Pick<MarksCodePermission, 'id' | 'sessionID' | 'action' | 'resources'>): Record<string, unknown> {
  return { sessionID: request.sessionID, requestID: request.id, action: request.action, resources: [...request.resources] };
}

export function permissionKind(action: string): EngineToolKind {
  return action === 'shell' ? 'command' : action === 'edit' ? 'patch' : action === 'read' ? 'read' : 'other';
}

function permissionSummary(request: MarksCodePermission): { summary: string; files: string[] } {
  const resources = request.resources.slice(0, 50);
  const files = request.action === 'edit' || request.action === 'read' ? resources : [];
  const summary = request.action === 'shell' ? resources.join('\n')
    : request.action === 'edit' ? `Edit ${resources.join(', ')}`
      : request.action === 'external_directory' ? `Access outside the project: ${resources.join(', ')}`
        : `${request.action}: ${resources.join(', ')}`;
  return { summary: [summary, request.message].filter(Boolean).join('\n'), files };
}

export function toolKind(name: string): EngineToolKind {
  return name === 'shell' ? 'command' : name === 'edit' || name === 'write' || name === 'patch' ? 'patch' : name === 'read' ? 'read' : 'other';
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/** Files a `patch` tool's text names (`*** Add File:` / `*** Update File:` / `*** Delete File:`). */
function patchFiles(patchText: string): EngineFileChange[] {
  const files: EngineFileChange[] = [];
  for (const match of patchText.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    files.push({ path: match[2]!.trim(), kind: match[1] === 'Add' ? 'add' : match[1] === 'Delete' ? 'delete' : 'update' });
  }
  return files.slice(0, 64);
}

/** `FileDiff.Info[]` from a tool's metadata, as file changes with their unified diffs. */
function diffFiles(metadata: unknown): EngineFileChange[] | undefined {
  const files = record(metadata).files;
  if (!Array.isArray(files)) return undefined;
  return files.slice(0, 64).flatMap((item): EngineFileChange[] => {
    const diff = record(item);
    const file = text(diff.file);
    if (!file) return [];
    return [{ path: file, kind: diff.status === 'added' ? 'add' : diff.status === 'deleted' ? 'delete' : 'update', ...(text(diff.patch) ? { diff: text(diff.patch) } : {}) }];
  });
}

/** The started row of one MarksCode tool call. */
export function toolStarted(toolId: string, name: string, inputValue: unknown, cwd: string | null): EngineEvent {
  const input = record(inputValue);
  const kind = toolKind(name);
  const base = { type: 'tool_started' as const, toolId, kind, name, input };
  if (kind === 'command') return { ...base, command: text(input.command) ?? '', ...(text(input.workdir) ?? cwd ? { cwd: text(input.workdir) ?? cwd! } : {}) };
  if (kind === 'patch') {
    const files = name === 'patch' ? patchFiles(text(input.patchText) ?? '') : text(input.path) ? [{ path: text(input.path)!, kind: 'update' as const }] : [];
    return { ...base, ...(text(input.path) ? { path: text(input.path) } : {}), files };
  }
  if (kind === 'read') return { ...base, ...(text(input.path) ? { path: text(input.path) } : {}) };
  return base;
}

/** The finished row: `content` text is the output, `metadata.exit` the exit code, `metadata.files` the diffs. */
export function toolFinished(toolId: string, result: { content?: unknown; metadata?: unknown; error?: unknown }, declined: boolean): EngineEvent {
  const output = Array.isArray(result.content)
    ? result.content.map(item => record(item)).filter(item => item.type === 'text').map(item => text(item.text) ?? '').join('\n') : '';
  const metadata = record(result.metadata);
  const files = diffFiles(metadata);
  const exit = typeof metadata.exit === 'number' ? metadata.exit : undefined;
  const error = result.error === undefined ? undefined : text(record(result.error).message) ?? 'The tool failed';
  return {
    type: 'tool_finished', toolId, status: error !== undefined ? (declined ? 'declined' : 'failed') : 'ok', output,
    ...(exit !== undefined ? { exitCode: exit } : {}), ...(files?.length ? { files } : {}), ...(error !== undefined ? { error } : {})
  };
}

// ---------------------------------------------------------------- running turns

interface Deferred { promise: Promise<void>; resolve(): void; reject(error: unknown): void }
function deferred(): Deferred {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

interface Turn {
  sessionId: string;
  backendId: string;
  turnId: string;
  question: string;
  cwd: string | null;
  projector: TurnProjector;
  gate: ApprovalGate;
  abort: AbortController;
  queue: Promise<void>;
  /** Set right before the prompt is posted: execution events from then on are this turn's. */
  promptSent: boolean;
  promptAt: number;
  promptMessageId: string | null;
  stopped: boolean;
  ended: boolean;
  quitting: boolean;
  connectedOnce: boolean;
  /** Reconcile on the first connection too (a turn re-attached after a restart). */
  reconcileFirst: boolean;
  connected: Deferred;
  failures: number;
  toolNames: Map<string, string>;
  started: Set<string>;
  finished: Set<string>;
  /** Tool rows already stored (re-attached turn): never written twice. */
  storedCalls: Set<string>;
  /** Answer texts already shown, as a multiset: a reconcile does not repeat them. */
  texts: string[];
  /** Permission requests shown as cards, by MarksCode request id. */
  asked: Map<string, MarksCodePermission>;
  /** Requests this app answered: their `permission.replied` is ours, not the TUI's. */
  answered: Set<string>;
  replies: Map<string, Deferred>;
  /** Tool ids whose permission the user rejected: their failure is a decline. */
  rejected: Set<string>;
  stopTimer: NodeJS.Timeout | null;
  done: Deferred;
}

const running = new Map<string, Turn>();
let recovery: Promise<void> | null = null;

function enqueue(turn: Turn, work: () => Promise<void>): Promise<void> {
  const next = turn.queue.then(work);
  turn.queue = next.catch(error => logWarn(`MarksCode chat ${turn.sessionId}: ${(error as Error).message}`));
  return turn.queue;
}

async function marksChat(sessionId: string): Promise<{ session: { id: string; conversationId: string; projectId: string | null }; record: ChatRecord }> {
  const session = await getSession(sessionId);
  if (!session || !isApiConversationId(session.conversationId)) throw new Error('This is not an API chat');
  const stored = await storedChatRecord(session.id);
  if (stored?.engine !== ENGINE) throw new Error('This chat runs on another engine');
  if (!stored.backendSessionId || !BACKEND_ID.test(stored.backendSessionId)) throw new Error('This MarksCode chat has no MarksCode session');
  return { session: { id: session.id, conversationId: session.conversationId, projectId: session.projectId ?? null }, record: stored };
}

function newTurn(options: {
  sessionId: string; conversationId: string; backendId: string; turnId: string; question: string; cwd: string | null;
  firstStep?: number; sink?: ProjectorSink;
}): Turn {
  const gate = new ApprovalGate(() => notifyChanged(options.sessionId));
  const turn: Turn = {
    sessionId: options.sessionId, backendId: options.backendId, turnId: options.turnId, question: options.question, cwd: options.cwd,
    gate, abort: new AbortController(), queue: Promise.resolve(), promptSent: false, promptAt: 0, promptMessageId: null,
    stopped: false, ended: false, quitting: false, connectedOnce: false, reconcileFirst: false, connected: deferred(), failures: 0,
    toolNames: new Map(), started: new Set(), finished: new Set(), storedCalls: new Set(), texts: [], asked: new Map(), answered: new Set(),
    replies: new Map(), rejected: new Set(), stopTimer: null, done: deferred(),
    projector: null as unknown as TurnProjector
  };
  turn.projector = new TurnProjector({
    engine: ENGINE, conversationId: options.conversationId, turnId: options.turnId, sink: options.sink ?? storeProjectorSink(options.sessionId),
    approvals: { gate, answer: (requestId, outcome) => answerRequest(turn, requestId, outcome) },
    ...(options.firstStep ? { firstStep: options.firstStep } : {})
  });
  return turn;
}

/** The gate settled a card: post the user's decision to exactly that MarksCode request. */
function answerRequest(turn: Turn, requestId: string, outcome: ApprovalOutcome): void {
  const reply = turn.replies.get(requestId);
  turn.replies.delete(requestId);
  const request = turn.asked.get(requestId);
  turn.asked.delete(requestId);
  const decision = marksCodeApprovalDecision(outcome);
  // Stop interrupts the execution, which settles its own requests; a TUI answer needs none.
  if (!decision || outcome === 'stop' || outcome === 'resolved') { reply?.resolve(); return; }
  turn.answered.add(requestId);
  if (decision === 'reject' && request?.source?.id) turn.rejected.add(request.source.id);
  void connect()
    .then(client => client.reply(turn.backendId, requestId, decision, decision === 'reject' ? 'The user declined this in Chat Marks.' : undefined))
    .then(() => reply?.resolve(), error => {
      turn.answered.delete(requestId);
      logWarn(`MarksCode chat ${turn.sessionId}: permission answer not delivered: ${(error as Error).message}`);
      reply?.reject(error);
    });
}

async function raiseApproval(turn: Turn, request: MarksCodePermission): Promise<void> {
  if (request.sessionID !== turn.backendId || turn.asked.has(request.id) || turn.answered.has(request.id)) return;
  if (typeof request.id !== 'string' || typeof request.action !== 'string' || !Array.isArray(request.resources)) return;
  const shown: MarksCodePermission = { ...request, resources: request.resources.filter((item): item is string => typeof item === 'string') };
  turn.asked.set(shown.id, shown);
  const { summary, files } = permissionSummary(shown);
  await turn.projector.apply({
    type: 'approval_requested', requestId: shown.id, ...(shown.source?.id ? { toolId: shown.source.id } : {}), kind: permissionKind(shown.action),
    tool: shown.action, summary, files, action: boundAction(shown)
  });
}

async function startTool(turn: Turn, toolId: string, name: string, input: unknown): Promise<void> {
  if (turn.started.has(toolId) || turn.finished.has(toolId)) return;
  turn.started.add(toolId);
  await turn.projector.apply(toolStarted(toolId, name, input, turn.cwd));
}

async function finishTool(turn: Turn, toolId: string, event: EngineEvent): Promise<void> {
  if (turn.finished.has(toolId)) return;
  turn.finished.add(toolId);
  if (turn.storedCalls.has(engineToolCallId(ENGINE, turn.turnId, toolId))) return;
  await turn.projector.apply(event);
}

async function showText(turn: Turn, value: string): Promise<void> {
  turn.texts.push(value);
  await turn.projector.apply({ type: 'text_final', text: value });
}

async function handle(turn: Turn, event: MarksCodeEvent): Promise<void> {
  if (turn.ended) return;
  if (event.type === 'server.connected') {
    turn.failures = 0;
    const again = turn.connectedOnce || turn.reconcileFirst;
    turn.connectedOnce = true;
    turn.connected.resolve();
    if (again) await reconcile(turn);
    return;
  }
  const data = event.data;
  if (data.sessionID !== turn.backendId) return;
  const toolId = text(data.id) ?? '';
  switch (event.type) {
    case 'session.text.delta':
      if (typeof data.delta === 'string') await turn.projector.apply({ type: 'text_delta', delta: data.delta });
      return;
    case 'session.text.ended':
      if (typeof data.text === 'string') await showText(turn, data.text);
      return;
    case 'session.tool.input.started':
      if (toolId && typeof data.name === 'string') turn.toolNames.set(toolId, data.name);
      return;
    case 'session.tool.called':
      if (toolId) await startTool(turn, toolId, turn.toolNames.get(toolId) ?? 'tool', data.input);
      return;
    case 'session.tool.success':
    case 'session.tool.failed':
      if (!toolId) return;
      if (!turn.started.has(toolId)) await startTool(turn, toolId, turn.toolNames.get(toolId) ?? 'tool', undefined);
      await finishTool(turn, toolId, toolFinished(toolId, { content: data.content, metadata: data.metadata,
        ...(event.type === 'session.tool.failed' ? { error: data.error ?? {} } : {}) }, turn.rejected.has(toolId)));
      return;
    case 'session.shell.started': {
      const shell = record(data.shell);
      const id = text(shell.id);
      if (!id) return;
      await startTool(turn, `shell:${id}`, 'shell', { command: text(shell.command) ?? '', ...(text(shell.cwd) ? { workdir: text(shell.cwd) } : {}) });
      return;
    }
    case 'session.shell.ended': {
      const shell = record(data.shell);
      const id = text(shell.id);
      if (!id) return;
      if (!turn.started.has(`shell:${id}`)) await startTool(turn, `shell:${id}`, 'shell', { command: text(shell.command) ?? '' });
      await finishTool(turn, `shell:${id}`, { type: 'tool_finished', toolId: `shell:${id}`, status: 'ok', output: text(record(data.output).output) ?? '',
        ...(typeof shell.exit === 'number' ? { exitCode: shell.exit } : {}) });
      return;
    }
    case 'session.usage.updated': {
      const tokens = record(data.tokens);
      const num = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined;
      await turn.projector.apply({ type: 'usage', inputTokens: num(tokens.input), outputTokens: num(tokens.output),
        reasoningTokens: num(tokens.reasoning), cachedInputTokens: num(record(tokens.cache).read) });
      return;
    }
    case 'permission.asked':
      await raiseApproval(turn, data as unknown as MarksCodePermission);
      return;
    case 'permission.replied': {
      const requestId = text(data.requestID);
      if (!requestId) return;
      // This app's own answer comes back too; only another client's (the TUI's) removes the card here.
      if (turn.answered.has(requestId)) return;
      if (turn.asked.has(requestId)) {
        turn.asked.delete(requestId);
        await turn.projector.apply({ type: 'approval_resolved', requestId });
      }
      return;
    }
    case 'session.execution.succeeded':
      if (turn.promptSent) await end(turn, 'completed');
      return;
    case 'session.execution.failed':
      if (!turn.promptSent) return;
      await turn.projector.apply({ type: 'error', message: `MarksCode failed: ${text(record(data.error).message) ?? 'unknown error'}`, fatal: true });
      await end(turn, 'failed');
      return;
    case 'session.execution.interrupted':
      if (turn.promptSent) await end(turn, turn.stopped || data.reason === 'user' ? 'stopped' : 'interrupted',
        turn.stopped || data.reason === 'user' ? undefined : `MarksCode interrupted the run (${text(data.reason) ?? 'unknown'})`);
      return;
    default:
  }
}

/** The text of a user message in `/api/session/:id/message`. */
const isOurQuestion = (turn: Turn, message: Record<string, unknown>): boolean =>
  message.type === 'user' && (turn.promptMessageId ? message.id === turn.promptMessageId : message.text === turn.question);

/**
 * Imports what the event stream may have missed: finished tools and settled answer texts after
 * this turn's question. While the session still runs, its last content part may be streaming
 * and is left to the live events.
 */
async function importMessages(turn: Turn, messages: Array<Record<string, unknown>>, complete: boolean): Promise<void> {
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index--) if (isOurQuestion(turn, messages[index]!)) { start = index; break; }
  if (start < 0) return;
  const after = messages.slice(start + 1).filter(message => message.type === 'assistant' || message.type === 'shell');
  const shown = [...turn.texts];
  for (const [messageIndex, message] of after.entries()) {
    if (message.type === 'shell') {
      const id = `shell:${text(message.shellID) ?? ''}`;
      if (id === 'shell:' || turn.finished.has(id)) continue;
      await startTool(turn, id, 'shell', { command: text(message.command) ?? '' });
      if (message.status === 'running' && !complete) continue;
      await finishTool(turn, id, { type: 'tool_finished', toolId: id, status: 'ok', output: text(record(message.output).output) ?? '',
        ...(typeof message.exit === 'number' ? { exitCode: message.exit } : {}) });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content.map(record) : [];
    for (const [partIndex, part] of content.entries()) {
      const streaming = !complete && messageIndex === after.length - 1 && partIndex === content.length - 1;
      if (part.type === 'text') {
        const value = text(part.text) ?? '';
        const seen = shown.indexOf(value);
        if (seen >= 0) { shown.splice(seen, 1); continue; }
        if (!value.trim() || streaming) continue;
        await showText(turn, value);
      } else if (part.type === 'tool') {
        const id = text(part.id);
        if (!id || turn.finished.has(id)) continue;
        const state = record(part.state);
        const name = text(part.name) ?? 'tool';
        turn.toolNames.set(id, name);
        if (state.status === 'streaming') continue;
        await startTool(turn, id, name, state.input);
        if (state.status === 'completed' || state.status === 'error') {
          await finishTool(turn, id, toolFinished(id, { content: state.content, metadata: state.metadata,
            ...(state.status === 'error' ? { error: state.error ?? {} } : {}) }, turn.rejected.has(id)));
        }
      }
    }
  }
}

/** After a (re)connect: messages, then pending permissions, then whether the run is over. */
async function reconcile(turn: Turn): Promise<void> {
  if (turn.ended) return;
  const client = await connect();
  // Messages first: a card closes the answer step, which must already hold the settled text.
  const live = await client.running(turn.backendId);
  await importMessages(turn, await client.messages(turn.backendId), !live);
  const pending = await client.permissions(turn.backendId);
  for (const request of pending) await raiseApproval(turn, request);
  for (const requestId of [...turn.asked.keys()]) {
    if (pending.some(request => request.id === requestId) || turn.replies.has(requestId)) continue;
    turn.asked.delete(requestId);
    await turn.projector.apply({ type: 'approval_resolved', requestId });
  }
  if (live || !turn.promptSent) return;
  const info = await client.session(turn.backendId);
  const idle = typeof info.time?.idle === 'number' ? info.time.idle : null;
  // Not running and not yet idle since the prompt: the execution has not started yet.
  if (idle === null || idle < turn.promptAt) return;
  if (info.outcome === 'failed') await turn.projector.apply({ type: 'error', message: 'MarksCode failed while Chat Marks was disconnected', fatal: true });
  await end(turn, info.outcome === 'succeeded' ? 'completed' : info.outcome === 'failed' ? 'failed' : turn.stopped ? 'stopped' : 'interrupted',
    info.outcome === 'interrupted' && !turn.stopped ? 'MarksCode interrupted the run' : undefined);
}

async function end(turn: Turn, outcome: TurnOutcome, detail?: string): Promise<void> {
  if (turn.ended) return;
  turn.ended = true;
  if (turn.stopTimer) clearTimeout(turn.stopTimer);
  turn.abort.abort();
  const final = await turn.projector.finish(outcome, detail).catch(error => {
    logWarn(`MarksCode chat ${turn.sessionId}: turn end not stored: ${(error as Error).message}`);
    return outcome;
  });
  for (const reply of turn.replies.values()) reply.resolve();
  turn.replies.clear();
  if (running.get(turn.sessionId) === turn) running.delete(turn.sessionId);
  notifyChanged(turn.sessionId);
  turn.done.resolve();
  logInfo(`MarksCode chat ${turn.sessionId}: turn ${turn.turnId} ${final}`);
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

/** The turn's event stream: reconnects with backoff until the turn ends, Stop, or app quit. */
async function pump(turn: Turn): Promise<void> {
  const delays = deps.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  while (!turn.ended && !turn.abort.signal.aborted) {
    try {
      const client = await connect();
      await client.events(turn.abort.signal, event => enqueue(turn, () => handle(turn, event)),
        () => logWarn(`MarksCode chat ${turn.sessionId}: an oversized event was dropped`));
    } catch (error) {
      if (turn.abort.signal.aborted) break;
      logWarn(`MarksCode chat ${turn.sessionId}: event stream lost: ${(error as Error).message}`);
    }
    if (turn.ended || turn.abort.signal.aborted) break;
    if (turn.failures >= delays.length) {
      await enqueue(turn, async () => {
        await turn.projector.apply({ type: 'error', message: 'Chat Marks lost the connection to the MarksCode service. The session may still be running in its terminal.', fatal: false });
        await end(turn, 'interrupted', 'The MarksCode event stream could not be reconnected');
      });
      break;
    }
    await sleep(delays[turn.failures++]!, turn.abort.signal);
  }
  turn.connected.resolve();
}

function waitConnected(turn: Turn): Promise<void> {
  return Promise.race([turn.connected.promise, new Promise<void>((_resolve, reject) =>
    setTimeout(() => reject(new Error('The MarksCode event stream did not connect')), CONNECT_WAIT_MS).unref?.())]);
}

// ---------------------------------------------------------------- recovery

/** The step number of an `api-assistant:<turn>[:<step>]` message id. */
function stepOf(messageId: string, turnId: string): number | null {
  const base = assistantMessageId(turnId);
  if (messageId === base) return 0;
  if (!messageId.startsWith(`${base}:`)) return null;
  const step = Number(messageId.slice(base.length + 1));
  return Number.isInteger(step) && step >= 0 ? step : null;
}

async function recoverChat(sessionId: string, chat: ChatRecord): Promise<void> {
  const open = chat.openTurn!;
  const closed = (detail: string): Promise<void> => closeTurnInterrupted(sessionId, open, detail);
  const session = await getSession(sessionId);
  if (!session || !chat.backendSessionId || !BACKEND_ID.test(chat.backendSessionId)) return closed('Chat Marks closed before MarksCode finished');
  const events = (await readEvents(sessionId)).filter(event => event.turnId === open.turnId || (event.kind === 'user_message' && event.messageId === `api-user:${open.turnId}`));
  if (!events.some(event => event.kind === 'turn_start') || events.some(event => event.kind === 'turn_end')) return closed('Chat Marks closed before MarksCode finished');
  let client: MarksCodeClient;
  let live: boolean;
  try {
    client = await connect();
    live = await client.running(chat.backendSessionId);
  } catch (error) {
    logWarn(`MarksCode chat ${sessionId}: not re-attached: ${(error as Error).message}`);
    return closed('The MarksCode service was not reachable when Chat Marks started');
  }
  const question = events.find(event => event.kind === 'user_message');
  let lastStep = -1;
  let streaming = false;
  const texts: string[] = [];
  const calls = new Set<string>();
  for (const event of events) {
    if (event.kind === 'tool_call') calls.add(event.call.callId);
    if (event.kind !== 'assistant_message' || !event.messageId) continue;
    const step = stepOf(event.messageId, open.turnId);
    if (step === null) continue;
    const final = event.final === true || event.state === 'final';
    if (step >= lastStep) { lastStep = step; streaming = !final; }
    if (final) texts.push(event.message.text);
    // A step the previous process left streaming is settled now; the first new answer text replaces it.
    else await upsertMessageEvent(sessionId, { time: event.time, source: 'app', kind: 'assistant_message', turnId: open.turnId,
      messageId: event.messageId, message: event.message, state: 'final', final: true });
  }
  let cwd: string | null = null;
  if (session.projectId) cwd = (await deps.projectFolder(session.projectId).catch(() => null))?.backend ?? null;
  const turn = newTurn({
    sessionId, conversationId: session.conversationId!, backendId: chat.backendSessionId, turnId: open.turnId,
    question: question?.kind === 'user_message' ? question.message.text : '', cwd, firstStep: streaming ? lastStep : lastStep + 1
  });
  turn.promptSent = true;
  turn.promptAt = open.startedAt;
  turn.texts.push(...texts);
  for (const call of calls) turn.storedCalls.add(call);
  running.set(sessionId, turn);
  if (live) {
    // Still running: follow it again; the first connection reconciles what happened meanwhile.
    turn.reconcileFirst = true;
    logInfo(`MarksCode chat ${sessionId}: re-attached to running session for turn ${open.turnId}`);
    void pump(turn);
    return;
  }
  // No longer running: import what it finished, then close the turn with its outcome.
  await enqueue(turn, async () => {
    await importMessages(turn, await client.messages(turn.backendId), true);
    const info = await client.session(turn.backendId).catch(() => null);
    const idle = typeof info?.time?.idle === 'number' ? info.time.idle : null;
    const finishedSince = idle !== null && idle >= open.startedAt;
    if (finishedSince && info?.outcome === 'succeeded') await end(turn, 'completed');
    else if (finishedSince && info?.outcome === 'failed') {
      await turn.projector.apply({ type: 'error', message: 'MarksCode failed while Chat Marks was closed', fatal: true });
      await end(turn, 'failed');
    } else await end(turn, 'interrupted', 'Chat Marks closed before MarksCode finished');
  });
  if (!turn.ended) await end(turn, 'interrupted', 'Chat Marks closed before MarksCode finished');
}

export function recoverMarksCodeChats(): Promise<void> {
  recovery ??= (async () => {
    for (const [sessionId, chat] of Object.entries(await chatRecords())) {
      if (chat.engine !== ENGINE || !chat.openTurn || running.has(sessionId)) continue;
      try {
        await recoverChat(sessionId, chat);
      } catch (error) {
        logWarn(`MarksCode chat ${sessionId}: open turn not recovered: ${(error as Error).message}`);
        running.delete(sessionId);
        await closeTurnInterrupted(sessionId, chat.openTurn).catch(() => undefined);
      }
    }
  })();
  return recovery;
}

// ---------------------------------------------------------------- engine

async function view(sessionId: string): Promise<ApiChatView> {
  const { session, record: chat } = await marksChat(sessionId);
  const turn = running.get(session.id);
  return {
    sessionId: session.id, conversationId: session.conversationId, engine: ENGINE, model: chat.model, effort: chat.effort,
    running: !!turn, approval: chat.approval ?? 'ask', pending: turn?.gate.view() ?? null
  };
}

async function listModels(client: MarksCodeClient, directory?: string): Promise<{ list: MarksCodeModel[]; fallback: string | null }> {
  const [list, fallback] = await Promise.all([client.models(directory), client.defaultModel(directory).catch(() => null)]);
  return { list: list.filter(model => typeof model?.id === 'string' && typeof model.providerID === 'string' && model.enabled !== false), fallback: fallback ? modelRowId(fallback) : null };
}

/** The `Model.Ref` for a chat's model and effort; an effort is a variant only when the model has one by that name. */
async function chatModelRef(client: MarksCodeClient, model: string, effort: ApiChatEffort | null): Promise<MarksCodeModelRef> {
  if (!effort) return modelRef(model, null);
  const { list } = await listModels(client);
  const found = list.find(item => modelRowId(item) === model);
  return modelRef(model, found?.variants?.some(variant => variant.id === effort) ? effort : null);
}

export const marksCodeEngine: AgentEngine = {
  id: ENGINE,
  label: LABEL,
  terminalMode: 'live',

  async status() {
    const { available, detail } = await marksCodeStatus();
    return { available, detail };
  },

  async models(query: EngineModelQuery) {
    const client = await connect();
    const { list, fallback } = await listModels(client);
    const needle = query.query?.trim().toLowerCase() ?? '';
    const rows: ApiChatModel[] = list
      .map(model => ({ id: modelRowId(model), ownedBy: model.providerID, modality: 'chat' as const, favorite: false, recent: false, availability: null }))
      .filter(row => !needle || row.id.toLowerCase().includes(needle))
      .sort((left, right) => Number(right.id === fallback) - Number(left.id === fallback));
    if (query.modality && query.modality !== 'chat') return { models: [], total: 0 };
    const offset = query.offset ?? 0;
    return { models: rows.slice(offset, offset + (query.limit ?? 50)), total: rows.length };
  },

  async create(options) {
    await recoverMarksCodeChats();
    if (!options.projectId) throw new Error('Choose a project for a MarksCode chat first');
    const folder = await deps.projectFolder(options.projectId);
    const client = await connect();
    const fallback = options.model ? null : await client.defaultModel(folder.backend).catch(() => null);
    const model = options.model ? modelId.parse(options.model) : fallback ? modelRowId(fallback) : null;
    const backend = await client.createSession({
      title: 'Chat Marks', location: { directory: folder.backend }, permissions: marksCodeRuleset('ask'), ...(model ? { model: modelRef(model, null) } : {})
    });
    if (!BACKEND_ID.test(backend.id)) throw new Error('MarksCode returned an unexpected session id');
    const summary = await createSession({ title: 'New MarksCode chat', titleSource: 'fallback', conversationId: `${API_CONVERSATION_PREFIX}${randomUUID()}` });
    await bindSessionProject(summary.id, options.projectId);
    await updateChatRecord(summary.id, () => ({ engine: ENGINE, backendSessionId: backend.id, model, effort: null }));
    notifyChanged(summary.id);
    return view(summary.id);
  },

  view,

  async send(sessionId, question) {
    await recoverMarksCodeChats();
    if (!question.trim() || question.length > MAX_API_CHAT_INPUT_CHARS) throw new Error('Write a message of up to 100,000 characters');
    const { session, record: chat } = await marksChat(sessionId);
    if (!session.projectId) throw new Error('This MarksCode chat has no project');
    const folder = await deps.projectFolder(session.projectId);
    // Check and claim with no await between: one turn per chat.
    if (running.has(session.id)) throw new Error('This chat is still answering');
    const turn = newTurn({
      sessionId: session.id, conversationId: session.conversationId, backendId: chat.backendSessionId!, turnId: `api-${randomUUID()}`,
      question, cwd: folder.backend
    });
    running.set(session.id, turn);
    let started = false;
    try {
      const client = await connect();
      if (await client.running(turn.backendId)) throw new Error('MarksCode is still working in this session (its terminal). Send again when it finishes.');
      await turn.projector.start(question);
      started = true;
      void pump(turn);
      await waitConnected(turn);
      if (turn.ended) throw new Error('The MarksCode event stream could not be opened');
      turn.promptAt = Date.now();
      turn.promptSent = true;
      turn.promptMessageId = (await client.prompt(turn.backendId, question)).id;
      return { turnId: turn.turnId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (started) {
        await enqueue(turn, async () => {
          await turn.projector.apply({ type: 'error', message: `The MarksCode request failed: ${message}`, fatal: true });
          await end(turn, 'failed');
        });
      } else {
        turn.ended = true;
        turn.abort.abort();
        if (running.get(session.id) === turn) running.delete(session.id);
      }
      throw error;
    }
  },

  async stop(sessionId) {
    await marksChat(sessionId);
    const turn = running.get(sessionId);
    if (!turn || turn.ended) return false;
    turn.stopped = true;
    try {
      await (await connect()).interrupt(turn.backendId);
    } catch (error) {
      logWarn(`MarksCode chat ${sessionId}: interrupt not delivered: ${(error as Error).message}`);
    }
    // `session.execution.interrupted` normally ends it; without one the turn still ends here.
    turn.stopTimer ??= setTimeout(() => void enqueue(turn, () => end(turn, 'stopped')), deps.stopGraceMs ?? STOP_GRACE_MS);
    turn.stopTimer.unref?.();
    return true;
  },

  async approve(sessionId, approvalId, decision: ApiChatApprovalDecision) {
    await marksChat(sessionId);
    const turn = running.get(sessionId);
    const requestId = turn?.gate.has(approvalId) ? turn.gate.engineRequestOf(approvalId) : null;
    const bound = turn?.gate.hashOf(approvalId) ?? null;
    if (!turn || !requestId || !bound) throw new Error('This approval is no longer pending');
    // The answer goes to exactly the request the card showed, read back from MarksCode now.
    const live = await (await connect()).permission(turn.backendId, requestId);
    if (!live || live.sessionID !== turn.backendId) {
      await enqueue(turn, async () => {
        turn.asked.delete(requestId);
        await turn.projector.apply({ type: 'approval_resolved', requestId });
      });
      throw new Error('This approval is no longer pending');
    }
    if (decision !== 'deny' && argsHash(live.action, boundAction(live)) !== bound) throw new Error('This MarksCode request changed after it was shown; it was not approved');
    const reply = deferred();
    turn.replies.set(requestId, reply);
    if (!turn.gate.answer(approvalId, decision)) {
      turn.replies.delete(requestId);
      throw new Error('This approval is no longer pending');
    }
    await reply.promise;
    return view(sessionId);
  },

  async setChatSettings(sessionId, patch) {
    const { session, record: chat } = await marksChat(sessionId);
    if (running.has(session.id) && (patch.model !== undefined || patch.effort !== undefined)) throw new Error('Wait for this answer to finish first');
    const model = patch.model !== undefined ? modelId.parse(patch.model) : chat.model;
    const effort = patch.effort !== undefined ? patch.effort : chat.effort;
    const approval = patch.approval !== undefined ? z.enum(API_CHAT_APPROVAL_MODES).parse(patch.approval) : undefined;
    const client = await connect();
    if ((patch.model !== undefined || patch.effort !== undefined) && model) await client.switchModel(chat.backendSessionId!, await chatModelRef(client, model, effort));
    if (approval !== undefined) await client.setPermissions(chat.backendSessionId!, marksCodeRuleset(approval));
    await updateChatRecord(session.id, current => ({
      ...(current ?? chat), model, effort, ...(approval !== undefined ? { approval } : {})
    }));
    notifyChanged(session.id);
    return view(session.id);
  },

  recover: () => recoverMarksCodeChats(),

  /** `markscode -s <session> .` in the project folder: the TUI attached to the same live session. */
  terminal(chat: EngineChatRef): EngineTerminal | null {
    if (!chat.backendSessionId || !BACKEND_ID.test(chat.backendSessionId)) return null;
    return { argv: ['markscode', '-s', chat.backendSessionId, '.'], mode: 'live' };
  }
};

/** App quit: close every event stream without ending its turn; the next start re-attaches. */
export function shutdownMarksCodeEngine(): void {
  for (const turn of running.values()) {
    turn.quitting = true;
    turn.abort.abort();
    if (turn.stopTimer) clearTimeout(turn.stopTimer);
  }
}

/** Test hook: the turn's settled promise, to await a turn's end. */
export function marksCodeTurnDone(sessionId: string): Promise<void> | null {
  return running.get(sessionId)?.done.promise ?? null;
}

export function resetMarksCodeEngineForTests(): void {
  shutdownMarksCodeEngine();
  running.clear();
  recovery = null;
  starting = null;
}
