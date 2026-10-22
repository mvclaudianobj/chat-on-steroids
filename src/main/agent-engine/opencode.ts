/**
 * The `opencode` agent engine: a Chat Marks API chat whose turns run in a session of the upstream
 * OpenCode server the app owns (opencode/server.ts), over the routes the OpenCode TUI itself uses
 * (opencode-client.ts). The same session opens live in the module's durable tmux terminal
 * (`opencode attach <url> --dir <cwd> -s <session>`), so the TUI and the chat show one conversation.
 *
 * - status: module enabled, command capability, binary (cli-modules resolution: the module's own
 *   install first, else PATH), and its `--version` (probed with a private HOME) inside the version
 *   gate (opencode/release.ts). The server is not needed: it starts lazily on first use.
 * - create: only in an approved local project. The backend session gets a ruleset that asks
 *   before `bash` and `edit`, and denies `question` (a turn must not block on it),
 *   `external_directory` and edits under `.markscode/` (another app's data).
 * - send: the event stream connects before the prompt (`prompt_async`, the chat's model and
 *   effort as `variant`); events go through the projector in order. Only parts of assistant
 *   messages answering this turn's question are projected; the first user message after the
 *   prompt is the question (`prompt_async` answers no id).
 * - Approvals: `permission.asked` becomes an ApprovalGate card bound to the sha256 of
 *   {sessionID, id, permission, patterns}. The answer is posted to that exact request after it is
 *   read back from `/permission` and still matches. "Always" is never sent upstream (it would
 *   allow the pattern for every chat in the folder, beating their deny rules): the request is
 *   answered `once`, the chat switches to Auto and its Auto ruleset is appended (deny rules last).
 *   A `permission.replied` this app did not send (the TUI answered) removes the card.
 * - Turn end: `session.status` idle after the prompt. `session.error` `MessageAbortedError` is a
 *   stop (the user's, or another client's: interrupted); any other error fails the turn.
 * - The stream is volatile: after every reconnect the turn is reconciled from the session's
 *   messages, pending permissions and `/session/status`.
 * - recover: the server dies with the app, so no turn survives it; the engine-neutral recovery
 *   closes open turns `interrupted` and the next send continues the same OpenCode session.
 * - terminal: live; opening it starts the server if needed and recreates a terminal older than
 *   the running server (its URL and password are read at start).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logInfo, logWarn } from '../logger.js';
import { notifyChanged } from '../session/recorder.js';
import { bindSessionProject, createSession, getSession } from '../session/store.js';
import { AGENT_ENGINE_LABELS } from '../../shared/agent-engine.js';
import {
  API_CHAT_APPROVAL_MODES, API_CONVERSATION_PREFIX, isApiConversationId,
  type ApiChatApprovalDecision, type ApiChatApprovalMode, type ApiChatEffort, type ApiChatModel, type ApiChatView
} from '../../shared/api-chat.js';
import type { TurnOutcome } from '../../shared/session.js';
import { MAX_API_CHAT_INPUT_CHARS } from '../api-chat/executor.js';
import { ApprovalGate, argsHash, openCodeApprovalDecision, type ApprovalOutcome } from './approval.js';
import { storedChatRecord, updateChatRecord, type ChatRecord } from './ledger.js';
import { storeProjectorSink, TurnProjector } from './projector.js';
import type { AgentEngine, EngineChatRef, EngineEvent, EngineFileChange, EngineModelQuery, EngineTerminal, EngineToolKind } from './types.js';
import {
  OpenCodeHttpError, type OpenCodeClient, type OpenCodeEvent, type OpenCodeMessage, type OpenCodePermission, type OpenCodeRule
} from './opencode-client.js';
import type { UpstreamSupport } from '../../shared/upstream-module.js';
import { opencodeSupport } from '../opencode/release.js';

const ENGINE = 'opencode' as const;
const LABEL = AGENT_ENGINE_LABELS.opencode;
const STOP_GRACE_MS = 5_000;
const CONNECT_WAIT_MS = 10_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];
/** An OpenCode session id (`ses_` + base62); never starts with `-`, so it cannot read as an option. */
export const OPENCODE_SESSION = /^ses_[A-Za-z0-9]{1,190}$/;
const modelId = z.string().min(1).max(200);
const DECLINED = 'The user declined this in Chat Marks.';

// ---------------------------------------------------------------- dependencies

export interface OpenCodeServerRef {
  client: OpenCodeClient;
  generation: number;
  startedAt: number;
  version: string;
}

export interface OpenCodeDeps {
  /** The module as cli-modules sees it (enabled, command capability, resolved binary, managed or from PATH). */
  moduleState(): Promise<{ enabled: boolean; command: boolean; binary: string | null; managed: boolean }>;
  /** The binary's version, probed with a private HOME (never the user's data). */
  version(binary: string): Promise<string | null>;
  support(version: string | null): UpstreamSupport | null;
  /** The folder the model list is read for (home; the WSL home on Windows). */
  modelsDirectory(): Promise<string>;
  /** The approved project's canonical folder as the server sees it (WSL path on Windows). */
  projectFolder(projectId: string): Promise<string>;
  /** The running server, started when none runs. */
  server(): Promise<OpenCodeServerRef>;
  /** The server running now, without starting one. */
  runningServer(): OpenCodeServerRef | null;
  /** Wires turn tracking to the server: restart waits for idle; an exit fails running turns. */
  bindServer(options: { busy(): boolean; onExit(generation: number, reason: string): void }): void;
  turnsSettled(): void;
  /** The chat's durable module terminal (cli-modules `cliEngineTerminal('opencode', …)`). */
  openTerminal(chat: { sessionId: string; projectId: string; args: string[]; title: string }): Promise<{ id: string }>;
  /** Registers the check every OpenCode engine terminal runs before it attaches (cli-modules open hook). */
  onTerminalOpen(check: (chatSessionId: string | undefined) => Promise<void>): void;
  /** Kills the chat's terminal when it is older than `sinceMs` (it holds a dead server's URL). */
  refreshTerminal(chatSessionId: string, sinceMs: number): Promise<void>;
  reconnectDelaysMs?: readonly number[];
  stopGraceMs?: number;
}

const defaultDeps: OpenCodeDeps = {
  async moduleState() {
    const { cliModuleState } = await import('../cli-modules.js');
    return cliModuleState('opencode');
  },
  async version(binary) {
    const { cliUpstreamVersion } = await import('../cli-modules.js');
    return cliUpstreamVersion('opencode', binary);
  },
  support: version => opencodeSupport(version),
  async modelsDirectory() {
    const { app } = await import('electron');
    if (process.platform !== 'win32') return app.getPath('home');
    const { cliWslHome } = await import('../cli-modules.js');
    return cliWslHome();
  },
  async projectFolder(projectId) {
    const { projectWorkspace, localProjectPath } = await import('../projects.js');
    const local = localProjectPath(await projectWorkspace(projectId));
    if (!local) throw new Error('OpenCode chats need a project folder on this computer');
    if (process.platform !== 'win32') return local;
    const { cliWslPath } = await import('../cli-modules.js');
    const mapped = (await cliWslPath(local)).trim();
    if (!mapped.startsWith('/')) throw new Error('Workspace could not be mapped to WSL');
    return mapped;
  },
  server: async () => (await import('../opencode/server.js')).ensureOpenCodeServer(),
  runningServer: () => serverModule?.runningOpenCodeServer() ?? null,
  bindServer: options => {
    void import('../opencode/server.js').then(module => {
      serverModule = module;
      module.bindOpenCodeServer({ busy: options.busy, onExit: (server, reason) => options.onExit(server.generation, reason) });
    });
  },
  turnsSettled: () => serverModule?.openCodeTurnsSettled(),
  openTerminal: async chat => (await import('../cli-modules.js')).cliEngineTerminal('opencode', chat),
  onTerminalOpen: check => {
    void import('../cli-modules.js').then(({ registerCliEngineOpenHook, registerCliEngineRegistration }) => {
      registerCliEngineOpenHook('opencode', session => check(session.engineChat));
      // The attach launcher reads the running server's URL and password from this file.
      registerCliEngineRegistration('opencode', async () => (await import('../opencode/server.js')).ensureOpenCodeServer().then(server => server.registration));
    })
      .catch(error => logWarn(`OpenCode chats: terminal hook not registered: ${(error as Error).message}`));
  },
  refreshTerminal: async (chatSessionId, sinceMs) => (await import('../cli-modules.js')).cliEngineTerminalRefresh(chatSessionId, sinceMs)
};

let serverModule: typeof import('../opencode/server.js') | null = null;

let deps: OpenCodeDeps = defaultDeps;
let bound = false;

/** Tests replace the server, module and project lookups; null restores the real ones. */
export function setOpenCodeDepsForTests(next: Partial<OpenCodeDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  terminalHooked = false;
  bound = false;
}

function bind(): void {
  if (bound) return;
  bound = true;
  deps.bindServer({
    busy: () => [...running.values()].some(turn => !turn.ended),
    onExit: (generation, reason) => {
      for (const turn of [...running.values()]) {
        if (turn.generation !== generation || turn.ended) continue;
        void enqueue(turn, async () => {
          await turn.projector.apply({ type: 'error', message: `${reason}. The OpenCode session keeps what it finished; send again to continue.`, fatal: true });
          await end(turn, 'failed');
        });
      }
    }
  });
}

// ---------------------------------------------------------------- status

export interface OpenCodeStatus { available: boolean; detail: string }

export async function openCodeStatus(): Promise<OpenCodeStatus> {
  let state: Awaited<ReturnType<OpenCodeDeps['moduleState']>>;
  try {
    state = await deps.moduleState();
  } catch {
    return { available: false, detail: 'The OpenCode module status is unavailable' };
  }
  if (!state.command) return { available: false, detail: 'Command execution is disabled' };
  if (!state.enabled) return { available: false, detail: 'Enable the OpenCode module in Settings > Modules' };
  if (!state.binary) return { available: false, detail: 'Install OpenCode in Settings > Modules' };
  const version = await deps.version(state.binary).catch(() => null);
  const support = deps.support(version);
  if (!version || !support) return { available: false, detail: 'OpenCode did not report its version' };
  if (support === 'unsupported') return { available: false, detail: `OpenCode ${version} is not supported by this version of Chat Marks (1.19 or a newer 1.x is needed)` };
  const notes = [
    support === 'newer' ? 'newer than tested' : '',
    state.managed ? '' : 'not installed by Chat Marks'
  ].filter(Boolean);
  return { available: true, detail: `OpenCode ${version}${notes.length ? ` (${notes.join(', ')})` : ''}` };
}

// ---------------------------------------------------------------- rules, models, mapping

/**
 * The chat's ruleset, appended after the agent's defaults. The last matching rule wins, so the
 * deny rules come last; `edit *` is never denied (a fully denied tool is removed).
 */
export function openCodeRuleset(mode: ApiChatApprovalMode): OpenCodeRule[] {
  const action = mode === 'auto' ? 'allow' : 'ask';
  return [
    { permission: 'bash', pattern: '*', action },
    { permission: 'edit', pattern: '*', action },
    { permission: 'question', pattern: '*', action: 'deny' },
    { permission: 'external_directory', pattern: '*', action: 'deny' },
    // MarksCode's per-project data is not OpenCode's to change (paths are worktree-relative).
    { permission: 'edit', pattern: '.markscode/*', action: 'deny' },
    { permission: 'edit', pattern: '*/.markscode/*', action: 'deny' }
  ];
}

/** `provider/model` as the chat stores it. */
export const modelRowId = (model: { id: string; providerID: string }): string => `${model.providerID}/${model.id}`;

export function modelRef(id: string): { providerID: string; modelID: string } {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) throw new Error('Choose an OpenCode model (provider/model)');
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

/** What the user is asked about and its hash input: the exact request, nothing the renderer sent. */
export function boundAction(request: Pick<OpenCodePermission, 'id' | 'sessionID' | 'permission' | 'patterns'>): Record<string, unknown> {
  return { sessionID: request.sessionID, id: request.id, permission: request.permission, patterns: [...request.patterns] };
}

export function toolKind(name: string): EngineToolKind {
  if (name === 'bash') return 'command';
  if (name === 'edit' || name === 'write' || name === 'apply_patch' || name === 'patch' || name === 'multiedit') return 'patch';
  if (name === 'read' || name === 'glob' || name === 'grep' || name === 'list') return 'read';
  return 'other';
}

const permissionKind = (permission: string): EngineToolKind =>
  permission === 'bash' ? 'command' : permission === 'edit' ? 'patch' : permission === 'read' ? 'read' : 'other';

function permissionSummary(request: OpenCodePermission): { summary: string; files: string[] } {
  const patterns = request.patterns.slice(0, 50);
  const metadata = record(request.metadata);
  const filepath = text(metadata.filepath);
  const files = request.permission === 'edit' ? (filepath ? [filepath] : patterns) : [];
  const summary = request.permission === 'bash' ? (text(metadata.command) ?? patterns.join('\n'))
    : request.permission === 'edit' ? `Edit ${files.join(', ')}`
      : request.permission === 'external_directory' ? `Access outside the project: ${patterns.join(', ')}`
        : `${request.permission}: ${patterns.join(', ')}`;
  return { summary, files };
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/** The file a tool's input names (`filePath`), when it has one. */
const inputFile = (input: Record<string, unknown>): string | undefined => text(input.filePath) ?? text(input.path);

/** `metadata.filediff` / `metadata.diff` of `edit`/`write`, or `apply_patch`'s files. */
function diffFiles(name: string, input: Record<string, unknown>, metadata: Record<string, unknown>): EngineFileChange[] | undefined {
  const filediff = record(metadata.filediff);
  const file = text(filediff.file) ?? text(metadata.filepath) ?? inputFile(input);
  const diff = text(filediff.patch) ?? text(metadata.diff);
  if (file) return [{ path: file, kind: name === 'write' && metadata.exists === false ? 'add' : 'update', ...(diff ? { diff } : {}) }];
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const changes = files.slice(0, 64).flatMap((item): EngineFileChange[] => {
    const entry = record(item);
    const path = text(entry.filePath) ?? text(entry.file) ?? text(entry.relativePath);
    if (!path) return [];
    const kind = entry.type === 'add' ? 'add' : entry.type === 'delete' ? 'delete' : entry.type === 'move' ? 'move' : 'update';
    return [{ path, kind, ...(text(entry.diff) ?? text(entry.patch) ? { diff: text(entry.diff) ?? text(entry.patch) } : {}) }];
  });
  return changes.length ? changes : undefined;
}

/** The started row of one OpenCode tool call (a `ToolPart` in state running). */
export function toolStarted(toolId: string, name: string, inputValue: unknown, cwd: string | null): EngineEvent {
  const input = record(inputValue);
  const kind = toolKind(name);
  const base = { type: 'tool_started' as const, toolId, kind, name, input };
  if (kind === 'command') return { ...base, command: text(input.command) ?? '', ...(text(input.workdir) ?? cwd ? { cwd: text(input.workdir) ?? cwd! } : {}) };
  const file = inputFile(input);
  if (kind === 'patch') return { ...base, ...(file ? { path: file, files: [{ path: file, kind: 'update' as const }] } : { files: [] }) };
  if (kind === 'read') return { ...base, ...(file ? { path: file } : {}) };
  return base;
}

/** The finished row from a `ToolPart` in state completed/error. */
export function toolFinished(toolId: string, name: string, state: Record<string, unknown>, declined: boolean): EngineEvent {
  const metadata = record(state.metadata);
  const input = record(state.input);
  const files = toolKind(name) === 'patch' ? diffFiles(name, input, metadata) : undefined;
  const exit = typeof metadata.exit === 'number' ? metadata.exit : undefined;
  if (state.status === 'error') {
    const error = text(state.error) ?? 'The tool failed';
    const rejected = declined || /rejected permission|declined this in Chat Marks/i.test(error);
    return { type: 'tool_finished', toolId, status: rejected ? 'declined' : 'failed', output: text(metadata.output) ?? '', error: error.slice(0, 2_000),
      ...(exit !== undefined ? { exitCode: exit } : {}) };
  }
  return {
    type: 'tool_finished', toolId, status: 'ok', output: text(state.output) ?? text(metadata.output) ?? '',
    ...(exit !== undefined ? { exitCode: exit } : {}), ...(files?.length ? { files } : {})
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
  directory: string;
  turnId: string;
  question: string;
  generation: number;
  client: OpenCodeClient;
  projector: TurnProjector;
  gate: ApprovalGate;
  abort: AbortController;
  queue: Promise<void>;
  promptSent: boolean;
  promptAt: number;
  /** The user message this turn posted, once seen (the first new user message after the prompt). */
  questionId: string | null;
  /** Messages known before the prompt: never this turn's question. */
  before: Set<string>;
  roles: Map<string, { role: string; parentID?: string }>;
  /** Part ids by type, for deltas (`reasoning` deltas are not shown). */
  partTypes: Map<string, string>;
  /** Text parts already shown as final. */
  shownTexts: Set<string>;
  sawBusy: boolean;
  stopped: boolean;
  ended: boolean;
  connectedOnce: boolean;
  connected: Deferred;
  failures: number;
  started: Set<string>;
  finished: Set<string>;
  /** Steps counted for usage, by step-finish part id. */
  steps: Map<string, { input: number; output: number; reasoning: number; cached: number }>;
  error: string | null;
  aborted: boolean;
  asked: Map<string, OpenCodePermission>;
  answered: Set<string>;
  replies: Map<string, Deferred>;
  rejected: Set<string>;
  stopTimer: NodeJS.Timeout | null;
  done: Deferred;
}

const running = new Map<string, Turn>();

function enqueue(turn: Turn, work: () => Promise<void>): Promise<void> {
  const next = turn.queue.then(work);
  turn.queue = next.catch(error => logWarn(`OpenCode chat ${turn.sessionId}: ${(error as Error).message}`));
  return turn.queue;
}

async function openCodeChat(sessionId: string): Promise<{ session: { id: string; conversationId: string; projectId: string | null }; record: ChatRecord }> {
  const session = await getSession(sessionId);
  if (!session || !isApiConversationId(session.conversationId)) throw new Error('This is not an API chat');
  const stored = await storedChatRecord(session.id);
  if (stored?.engine !== ENGINE) throw new Error('This chat runs on another engine');
  if (!stored.backendSessionId || !OPENCODE_SESSION.test(stored.backendSessionId)) throw new Error('This OpenCode chat has no OpenCode session');
  return { session: { id: session.id, conversationId: session.conversationId, projectId: session.projectId ?? null }, record: stored };
}

function newTurn(options: { sessionId: string; conversationId: string; backendId: string; directory: string; turnId: string; question: string; server: OpenCodeServerRef }): Turn {
  const gate = new ApprovalGate(() => notifyChanged(options.sessionId));
  const turn: Turn = {
    sessionId: options.sessionId, backendId: options.backendId, directory: options.directory, turnId: options.turnId, question: options.question,
    generation: options.server.generation, client: options.server.client,
    gate, abort: new AbortController(), queue: Promise.resolve(), promptSent: false, promptAt: 0, questionId: null, before: new Set(),
    roles: new Map(), partTypes: new Map(), shownTexts: new Set(), sawBusy: false, stopped: false, ended: false, connectedOnce: false,
    connected: deferred(), failures: 0, started: new Set(), finished: new Set(), steps: new Map(), error: null, aborted: false,
    asked: new Map(), answered: new Set(), replies: new Map(), rejected: new Set(), stopTimer: null, done: deferred(),
    projector: null as unknown as TurnProjector
  };
  turn.projector = new TurnProjector({
    engine: ENGINE, conversationId: options.conversationId, turnId: options.turnId, sink: storeProjectorSink(options.sessionId),
    approvals: { gate, answer: (requestId, outcome) => answerRequest(turn, requestId, outcome) }
  });
  return turn;
}

/** The gate settled a card: post the user's decision to exactly that OpenCode request. */
function answerRequest(turn: Turn, requestId: string, outcome: ApprovalOutcome): void {
  const reply = turn.replies.get(requestId);
  turn.replies.delete(requestId);
  const request = turn.asked.get(requestId);
  turn.asked.delete(requestId);
  const decision = openCodeApprovalDecision(outcome);
  // A TUI answer needs none. Stop: the abort leaves the request pending upstream; reject clears it.
  if (!decision || outcome === 'resolved') { reply?.resolve(); return; }
  turn.answered.add(requestId);
  if (decision === 'reject' && request?.tool?.callID) turn.rejected.add(request.tool.callID);
  void (async () => {
    await turn.client.reply(turn.directory, requestId, decision, decision === 'reject' ? DECLINED : undefined);
    // "Always": the chat runs edits and commands automatically from now on (its own rules, appended).
    if (outcome === 'always') await setApproval(turn.sessionId, turn.client, turn.backendId, turn.directory, 'auto');
  })().then(() => reply?.resolve(), error => {
    turn.answered.delete(requestId);
    if (outcome !== 'stop') logWarn(`OpenCode chat ${turn.sessionId}: permission answer not delivered: ${(error as Error).message}`);
    reply?.reject(error);
  });
}

async function setApproval(sessionId: string, client: OpenCodeClient, backendId: string, directory: string, approval: ApiChatApprovalMode): Promise<void> {
  await client.appendPermissions(directory, backendId, openCodeRuleset(approval));
  await updateChatRecord(sessionId, current => current ? { ...current, approval } : current);
  notifyChanged(sessionId);
}

async function raiseApproval(turn: Turn, request: OpenCodePermission): Promise<void> {
  if (request.sessionID !== turn.backendId || turn.asked.has(request.id) || turn.answered.has(request.id)) return;
  if (typeof request.id !== 'string' || typeof request.permission !== 'string' || !Array.isArray(request.patterns)) return;
  const shown: OpenCodePermission = { ...request, patterns: request.patterns.filter((item): item is string => typeof item === 'string') };
  turn.asked.set(shown.id, shown);
  const { summary, files } = permissionSummary(shown);
  await turn.projector.apply({
    type: 'approval_requested', requestId: shown.id, ...(shown.tool?.callID ? { toolId: shown.tool.callID } : {}), kind: permissionKind(shown.permission),
    tool: shown.permission, summary, files, action: boundAction(shown)
  });
}

/** Whether a message answers this turn's question. */
function ofTurn(turn: Turn, messageId: string): boolean {
  const info = turn.roles.get(messageId);
  return !!info && info.role === 'assistant' && !!turn.questionId && info.parentID === turn.questionId;
}

function noteMessage(turn: Turn, info: Record<string, unknown>): void {
  const id = text(info.id);
  const role = text(info.role);
  if (!id || !role) return;
  turn.roles.set(id, { role, ...(text(info.parentID) ? { parentID: text(info.parentID) } : {}) });
  if (role === 'user' && turn.promptSent && !turn.questionId && !turn.before.has(id)) turn.questionId = id;
}

/** One assistant part: text (final once `time.end` is set), tool rows, step usage. */
async function applyPart(turn: Turn, part: Record<string, unknown>, live: boolean): Promise<void> {
  const id = text(part.id);
  const type = text(part.type);
  if (!id || !type) return;
  turn.partTypes.set(id, type);
  if (type === 'text') {
    const value = text(part.text) ?? '';
    if (record(part.time).end === undefined || turn.shownTexts.has(id) || part.synthetic === true) return;
    turn.shownTexts.add(id);
    if (value.trim()) await turn.projector.apply({ type: 'text_final', text: value });
    return;
  }
  if (type === 'tool') {
    const callId = text(part.callID) ?? id;
    const name = text(part.tool) ?? 'tool';
    const state = record(part.state);
    if (turn.finished.has(callId)) return;
    if (state.status === 'pending') return;
    if (!turn.started.has(callId)) {
      turn.started.add(callId);
      await turn.projector.apply(toolStarted(callId, name, state.input, turn.directory));
    }
    if (state.status === 'completed' || state.status === 'error') {
      turn.finished.add(callId);
      await turn.projector.apply(toolFinished(callId, name, state, turn.rejected.has(callId)));
    } else if (!live) {
      // A reconcile only adds rows; a tool still running is left to the live events.
    }
    return;
  }
  if (type === 'step-finish') {
    const tokens = record(part.tokens);
    const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    turn.steps.set(id, { input: num(tokens.input), output: num(tokens.output), reasoning: num(tokens.reasoning), cached: num(record(tokens.cache).read) });
    const total = [...turn.steps.values()].reduce((sum, step) => ({
      input: sum.input + step.input + step.cached, output: sum.output + step.output, reasoning: sum.reasoning + step.reasoning, cached: sum.cached + step.cached
    }), { input: 0, output: 0, reasoning: 0, cached: 0 });
    await turn.projector.apply({ type: 'usage', inputTokens: total.input, outputTokens: total.output, reasoningTokens: total.reasoning, cachedInputTokens: total.cached });
  }
}

async function handle(turn: Turn, event: OpenCodeEvent): Promise<void> {
  if (turn.ended) return;
  if (event.type === 'server.connected') {
    turn.failures = 0;
    const again = turn.connectedOnce;
    turn.connectedOnce = true;
    turn.connected.resolve();
    if (again) await reconcile(turn);
    return;
  }
  const data = event.properties;
  if (data.sessionID !== turn.backendId) return;
  switch (event.type) {
    case 'message.updated': {
      const info = record(data.info);
      noteMessage(turn, info);
      if (info.role === 'assistant' && ofTurn(turn, text(info.id) ?? '')) {
        const error = record(info.error);
        if (error.name === 'MessageAbortedError') turn.aborted = true;
      }
      return;
    }
    case 'message.part.updated': {
      const part = record(data.part);
      if (!ofTurn(turn, text(part.messageID) ?? '')) return;
      await applyPart(turn, part, true);
      return;
    }
    case 'message.part.delta':
      if (data.field !== 'text' || typeof data.delta !== 'string' || !ofTurn(turn, text(data.messageID) ?? '')) return;
      if (turn.partTypes.get(text(data.partID) ?? '') !== 'text') return;
      await turn.projector.apply({ type: 'text_delta', delta: data.delta });
      return;
    case 'permission.asked':
      if (turn.promptSent) await raiseApproval(turn, data as unknown as OpenCodePermission);
      return;
    case 'permission.replied': {
      const requestId = text(data.requestID);
      if (!requestId || turn.answered.has(requestId)) return;
      // Another client (the TUI) answered: the card goes, nothing is sent.
      const asked = turn.asked.get(requestId);
      if (asked) {
        turn.asked.delete(requestId);
        if (data.reply === 'reject' && asked.tool?.callID) turn.rejected.add(asked.tool.callID);
        await turn.projector.apply({ type: 'approval_resolved', requestId });
      }
      return;
    }
    case 'session.error': {
      if (!turn.promptSent) return;
      const error = record(data.error);
      if (error.name === 'MessageAbortedError') { turn.aborted = true; return; }
      turn.error = text(record(error.data).message) ?? text(error.name) ?? 'unknown error';
      return;
    }
    case 'session.status': {
      const type = text(record(data.status).type);
      if (!turn.promptSent) return;
      if (type === 'busy' || type === 'retry') { turn.sawBusy = true; return; }
      if (type === 'idle' && (turn.sawBusy || turn.questionId)) await settle(turn);
      return;
    }
    default:
  }
}

/** The run is over (idle): its outcome from what was seen. */
async function settle(turn: Turn): Promise<void> {
  if (turn.error) {
    await turn.projector.apply({ type: 'error', message: `OpenCode failed: ${turn.error.slice(0, 500)}`, fatal: true });
    await end(turn, 'failed');
  } else if (turn.aborted || turn.stopped) {
    await end(turn, turn.stopped ? 'stopped' : 'interrupted', turn.stopped ? undefined : 'The OpenCode run was stopped in its terminal');
  } else {
    await end(turn, 'completed');
  }
}

/** Adds what the stream may have missed: settled texts and finished tools of this turn's answers. */
async function importMessages(turn: Turn, messages: OpenCodeMessage[]): Promise<void> {
  for (const message of messages) noteMessage(turn, message.info);
  if (!turn.questionId) {
    // The question's `message.updated` was missed: it is the user message after the prompt with this text.
    const question = messages.find(message => message.info.role === 'user' && !turn.before.has(message.info.id)
      && message.parts.some(part => part.type === 'text' && part.text === turn.question));
    if (question) turn.questionId = question.info.id;
  }
  for (const message of messages) {
    if (!ofTurn(turn, message.info.id)) continue;
    const error = record(message.info.error);
    if (error.name === 'MessageAbortedError') turn.aborted = true;
    else if (error.name && !turn.error) turn.error = text(record(error.data).message) ?? text(error.name) ?? 'unknown error';
    for (const part of message.parts) await applyPart(turn, part, false);
  }
}

/** After a reconnect: messages, pending permissions, then whether the run is over. */
async function reconcile(turn: Turn): Promise<void> {
  if (turn.ended) return;
  const busy = await turn.client.busy(turn.directory, turn.backendId);
  await importMessages(turn, await turn.client.messages(turn.directory, turn.backendId));
  const pending = await turn.client.permissions(turn.directory, turn.backendId);
  for (const request of pending) await raiseApproval(turn, request);
  for (const requestId of [...turn.asked.keys()]) {
    if (pending.some(request => request.id === requestId) || turn.replies.has(requestId)) continue;
    turn.asked.delete(requestId);
    await turn.projector.apply({ type: 'approval_resolved', requestId });
  }
  if (!busy && turn.promptSent && turn.questionId) await settle(turn);
}

async function end(turn: Turn, outcome: TurnOutcome, detail?: string): Promise<void> {
  if (turn.ended) return;
  turn.ended = true;
  if (turn.stopTimer) clearTimeout(turn.stopTimer);
  turn.abort.abort();
  const final = await turn.projector.finish(outcome, detail).catch(error => {
    logWarn(`OpenCode chat ${turn.sessionId}: turn end not stored: ${(error as Error).message}`);
    return outcome;
  });
  for (const reply of turn.replies.values()) reply.resolve();
  turn.replies.clear();
  if (running.get(turn.sessionId) === turn) running.delete(turn.sessionId);
  notifyChanged(turn.sessionId);
  turn.done.resolve();
  logInfo(`OpenCode chat ${turn.sessionId}: turn ${turn.turnId} ${final}`);
  deps.turnsSettled();
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

/** The turn's event stream: reconnects with backoff until the turn ends, Stop, or the server goes. */
async function pump(turn: Turn): Promise<void> {
  const delays = deps.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  while (!turn.ended && !turn.abort.signal.aborted) {
    try {
      await turn.client.events(turn.abort.signal, event => enqueue(turn, () => handle(turn, event)),
        () => logWarn(`OpenCode chat ${turn.sessionId}: an oversized event was dropped`));
    } catch (error) {
      if (turn.abort.signal.aborted) break;
      logWarn(`OpenCode chat ${turn.sessionId}: event stream lost: ${(error as Error).message}`);
    }
    if (turn.ended || turn.abort.signal.aborted) break;
    if (turn.failures >= delays.length) {
      await enqueue(turn, async () => {
        await turn.projector.apply({ type: 'error', message: 'Chat Marks lost the connection to the OpenCode server. The session may still be running in its terminal.', fatal: false });
        await end(turn, 'interrupted', 'The OpenCode event stream could not be reconnected');
      });
      break;
    }
    await sleep(delays[turn.failures++]!, turn.abort.signal);
  }
  turn.connected.resolve();
}

function waitConnected(turn: Turn): Promise<void> {
  return Promise.race([turn.connected.promise, new Promise<void>((_resolve, reject) =>
    setTimeout(() => reject(new Error('The OpenCode event stream did not connect')), CONNECT_WAIT_MS).unref?.())]);
}

// ---------------------------------------------------------------- terminal

let terminalHooked = false;

/** Every attach: the server runs, and a terminal started against an older server is recreated. */
async function terminalReady(chatSessionId: string | undefined): Promise<void> {
  const status = await openCodeStatus();
  if (!status.available) throw new Error(status.detail);
  const server = await deps.server();
  if (chatSessionId) await deps.refreshTerminal(chatSessionId, server.startedAt);
}

function hookTerminals(): void {
  if (terminalHooked) return;
  terminalHooked = true;
  deps.onTerminalOpen(terminalReady);
}

function terminalOf(backendSessionId: string | null, cwd: string | null): EngineTerminal | null {
  if (!backendSessionId || !OPENCODE_SESSION.test(backendSessionId) || !cwd || !cwd.startsWith('/')) return null;
  return { argv: ['--dir', cwd, '-s', backendSessionId], mode: 'live' };
}

/** Live: `opencode attach <url> --dir <cwd> -s <session>` in the chat's terminal, on the server the chat uses. */
async function openTerminal(sessionId: string): Promise<{ cliSessionId: string }> {
  hookTerminals();
  const { session, record: chat } = await openCodeChat(sessionId);
  if (!session.projectId) throw new Error('This OpenCode chat has no project');
  const directory = await deps.projectFolder(session.projectId);
  const terminal = terminalOf(chat.backendSessionId ?? null, directory);
  if (!terminal) throw new Error('This chat has no engine session yet');
  await terminalReady(undefined);
  const title = (await getSession(session.id))?.title ?? '';
  const opened = await deps.openTerminal({ sessionId: session.id, projectId: session.projectId, args: terminal.argv, title: `${LABEL} · ${title.slice(0, 80)}`.trim() });
  return { cliSessionId: opened.id };
}

// ---------------------------------------------------------------- engine

async function view(sessionId: string): Promise<ApiChatView> {
  const { session, record: chat } = await openCodeChat(sessionId);
  const turn = running.get(session.id);
  return {
    sessionId: session.id, conversationId: session.conversationId, engine: ENGINE, model: chat.model, effort: chat.effort,
    running: !!turn, approval: chat.approval ?? 'ask', pending: turn?.gate.view() ?? null
  };
}

interface ModelRow { id: string; providerID: string; name: string; variants: string[] }

async function listModels(client: OpenCodeClient, directory: string): Promise<{ list: ModelRow[]; defaults: Set<string> }> {
  const reply = await client.providers(directory);
  const list = reply.providers.flatMap(provider => Object.values(provider.models).flatMap((model): ModelRow[] => {
    if (typeof model?.id !== 'string' || model.status === 'deprecated') return [];
    return [{ id: model.id, providerID: typeof model.providerID === 'string' ? model.providerID : provider.id, name: typeof model.name === 'string' ? model.name : model.id,
      variants: model.variants && typeof model.variants === 'object' ? Object.keys(model.variants) : [] }];
  }));
  const defaults = new Set(Object.entries(reply.default).map(([provider, model]) => `${provider}/${model}`));
  return { list, defaults };
}

export const openCodeEngine: AgentEngine = {
  id: ENGINE,
  label: LABEL,
  terminalMode: 'live',

  async status() {
    return openCodeStatus();
  },

  async models(query: EngineModelQuery) {
    if (query.modality && query.modality !== 'chat') return { models: [], total: 0 };
    const server = await deps.server();
    const { list, defaults } = await listModels(server.client, await deps.modelsDirectory());
    const needle = query.query?.trim().toLowerCase() ?? '';
    const rows: ApiChatModel[] = list
      .map(model => ({
        id: modelRowId(model), ownedBy: model.providerID, modality: 'chat' as const, favorite: false, recent: false, availability: null,
        label: model.name, ...(model.variants.length ? { efforts: model.variants } : {})
      }))
      .filter(row => !needle || row.id.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle))
      .sort((left, right) => Number(defaults.has(right.id)) - Number(defaults.has(left.id)));
    const offset = query.offset ?? 0;
    return { models: rows.slice(offset, offset + (query.limit ?? 50)), total: rows.length };
  },

  async create(options) {
    bind();
    if (!options.projectId) throw new Error('Choose a project for an OpenCode chat first');
    const directory = await deps.projectFolder(options.projectId);
    const server = await deps.server();
    let model = options.model ? modelId.parse(options.model) : null;
    if (!model) {
      const { defaults } = await listModels(server.client, directory).catch(() => ({ defaults: new Set<string>() }));
      model = [...defaults][0] ?? null;
    }
    const backend = await server.client.createSession(directory, { title: 'Chat Marks', permission: openCodeRuleset('ask') });
    if (!OPENCODE_SESSION.test(backend.id)) throw new Error('OpenCode returned an unexpected session id');
    const summary = await createSession({ title: 'New OpenCode chat', titleSource: 'fallback', conversationId: `${API_CONVERSATION_PREFIX}${randomUUID()}` });
    await bindSessionProject(summary.id, options.projectId);
    await updateChatRecord(summary.id, () => ({ engine: ENGINE, backendSessionId: backend.id, model, effort: null }));
    notifyChanged(summary.id);
    return view(summary.id);
  },

  view,

  async send(sessionId, question) {
    bind();
    if (!question.trim() || question.length > MAX_API_CHAT_INPUT_CHARS) throw new Error('Write a message of up to 100,000 characters');
    const { session, record: chat } = await openCodeChat(sessionId);
    if (!session.projectId) throw new Error('This OpenCode chat has no project');
    const directory = await deps.projectFolder(session.projectId);
    if (!chat.model) throw new Error('Choose an OpenCode model for this chat first');
    const ref = modelRef(chat.model);
    // Check and claim with no await between: one turn per chat.
    if (running.has(session.id)) throw new Error('This chat is still answering');
    const placeholder = { sessionId: session.id } as Turn;
    running.set(session.id, placeholder);
    let turn: Turn | null = null;
    let started = false;
    try {
      const server = await deps.server();
      turn = newTurn({ sessionId: session.id, conversationId: session.conversationId, backendId: chat.backendSessionId!, directory,
        turnId: `api-${randomUUID()}`, question, server });
      running.set(session.id, turn);
      const client = server.client;
      if (await client.busy(directory, turn.backendId)) throw new Error('OpenCode is still working in this session (its terminal). Send again when it finishes.');
      for (const message of await client.messages(directory, turn.backendId, 20).catch(() => [])) turn.before.add(message.info.id);
      // The effort is a variant only when the model lists one by that name.
      let variant: string | undefined;
      if (chat.effort) {
        const { list } = await listModels(client, directory).catch(() => ({ list: [] as ModelRow[] }));
        const found = list.find(item => modelRowId(item) === chat.model);
        if (found?.variants.includes(chat.effort)) variant = chat.effort;
      }
      await turn.projector.start(question);
      started = true;
      void pump(turn);
      await waitConnected(turn);
      if (turn.ended) throw new Error('The OpenCode event stream could not be opened');
      turn.promptAt = Date.now();
      turn.promptSent = true;
      await client.prompt(directory, turn.backendId, { text: question, model: ref, ...(variant ? { variant } : {}) });
      return { turnId: turn.turnId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (turn && started) {
        const failing = turn;
        await enqueue(failing, async () => {
          await failing.projector.apply({ type: 'error', message: `The OpenCode request failed: ${message}`, fatal: true });
          await end(failing, 'failed');
        });
      } else {
        if (turn) { turn.ended = true; turn.abort.abort(); }
        const current = running.get(session.id);
        if (current === turn || current === placeholder) running.delete(session.id);
      }
      throw error;
    }
  },

  async stop(sessionId) {
    await openCodeChat(sessionId);
    const turn = running.get(sessionId);
    if (!turn || turn.ended || !turn.client) return false;
    turn.stopped = true;
    try {
      await turn.client.abort(turn.directory, turn.backendId);
    } catch (error) {
      logWarn(`OpenCode chat ${sessionId}: abort not delivered: ${(error as Error).message}`);
    }
    // Idle after the abort normally ends it; without one the turn still ends here.
    turn.stopTimer ??= setTimeout(() => void enqueue(turn, () => end(turn, 'stopped')), deps.stopGraceMs ?? STOP_GRACE_MS);
    turn.stopTimer.unref?.();
    return true;
  },

  async approve(sessionId, approvalId, decision: ApiChatApprovalDecision) {
    await openCodeChat(sessionId);
    const turn = running.get(sessionId);
    const requestId = turn?.gate?.has(approvalId) ? turn.gate.engineRequestOf(approvalId) : null;
    const bound = turn?.gate?.hashOf(approvalId) ?? null;
    if (!turn || !requestId || !bound) throw new Error('This approval is no longer pending');
    // The answer goes to exactly the request the card showed, read back from OpenCode now.
    const live = (await turn.client.permissions(turn.directory, turn.backendId)).find(request => request.id === requestId);
    if (!live) {
      await enqueue(turn, async () => {
        turn.asked.delete(requestId);
        await turn.projector.apply({ type: 'approval_resolved', requestId });
      });
      throw new Error('This approval is no longer pending');
    }
    if (decision !== 'deny' && argsHash(live.permission, boundAction(live)) !== bound) throw new Error('This OpenCode request changed after it was shown; it was not approved');
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
    const { session, record: chat } = await openCodeChat(sessionId);
    if (running.has(session.id) && (patch.model !== undefined || patch.effort !== undefined)) throw new Error('Wait for this answer to finish first');
    const model = patch.model !== undefined ? modelId.parse(patch.model) : chat.model;
    if (model) modelRef(model);
    const effort: ApiChatEffort | null = patch.effort !== undefined ? patch.effort : chat.effort;
    const approval = patch.approval !== undefined ? z.enum(API_CHAT_APPROVAL_MODES).parse(patch.approval) : undefined;
    if (approval !== undefined && approval !== (chat.approval ?? 'ask')) {
      if (!session.projectId) throw new Error('This OpenCode chat has no project');
      const server = await deps.server();
      await server.client.appendPermissions(await deps.projectFolder(session.projectId), chat.backendSessionId!, openCodeRuleset(approval));
    }
    // The model and effort travel with every prompt: nothing to switch upstream.
    await updateChatRecord(session.id, current => ({
      ...(current ?? chat), model, effort, ...(approval !== undefined ? { approval } : {})
    }));
    notifyChanged(session.id);
    return view(session.id);
  },

  /** Nothing survives the app's server: `recoverApiChats` closes open turns as interrupted. */
  recover: async () => { hookTerminals(); },

  /** The arguments after `opencode attach <url>`: `--dir <cwd> -s <session>`. */
  terminal: (chat: EngineChatRef): EngineTerminal | null => terminalOf(chat.backendSessionId, chat.cwd),

  openTerminal
};

/** App quit: close every event stream; the server stops with the app. */
export function shutdownOpenCodeEngine(): void {
  for (const turn of running.values()) {
    turn.abort?.abort();
    if (turn.stopTimer) clearTimeout(turn.stopTimer);
  }
}

/** Test hook: the turn's settled promise, to await a turn's end. */
export function openCodeTurnDone(sessionId: string): Promise<void> | null {
  return running.get(sessionId)?.done?.promise ?? null;
}

export function resetOpenCodeEngineForTests(): void {
  shutdownOpenCodeEngine();
  running.clear();
}

export { OpenCodeHttpError };
