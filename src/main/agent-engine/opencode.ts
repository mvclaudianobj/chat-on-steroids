/**
 * The `opencode` agent engine: a Chat Marks API chat whose turns run in a session of upstream
 * OpenCode 2.x's background service (`opencode service`, opencode/service.ts), over its `/api`
 * HTTP API (opencode-client.ts). The same session opens live in the module's durable tmux
 * terminal (`opencode -s <session> <folder>`, the TUI attached to the same service), so the TUI
 * and the chat show one conversation. Checked against the real 2.1.2.
 *
 * - status: module enabled, command capability, binary (cli-modules resolution: the module's own
 *   install first, else PATH), its `--version` (private HOME) inside the version gate
 *   (opencode/release.ts), and the service not run by another OpenCode program. A stopped
 *   service is fine: it starts on first use (create, send, models, terminal open).
 * - create: only in an approved local project. The session is created at that location with a
 *   ruleset that asks before `shell` and `edit`, and denies `question` (a turn must not block on
 *   a form), `external_directory`, absolute (outside the project) `edit`/`read` resources and
 *   edits under `.markscode/` (another app's data). Inside the project resources are relative.
 * - send: the event stream connects before the prompt is posted; events go through the projector
 *   in order. `permission.asked` becomes an ApprovalGate card bound to the sha256 of
 *   {sessionID, requestID, action, resources}; the answer is posted to that exact request after it
 *   is read back and still matches. "Always" is never sent upstream (2.x saves it for the whole
 *   project, beating every session's `ask`): it is answered `once` and the chat switches to Auto
 *   (its own ruleset, replaced). A `permission.replied` this app did not send (the TUI) removes
 *   the card. `session.execution.*` ends the turn.
 * - The stream is volatile: after every reconnect the turn is reconciled from pending
 *   permissions, `/api/session/active` and the session's messages.
 * - recover: the service outlives the app, so a turn left open by the previous process is
 *   re-attached while its session still runs; otherwise what finished is imported and the turn
 *   closes with the session's outcome.
 * - terminal: live; both the chat and the TUI are clients of the same service session, so the
 *   terminal may open while a turn runs. Every attach first makes sure the service runs.
 */
import { randomUUID } from 'node:crypto';
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
import type { OpenCodeServiceView, UpstreamSupport } from '../../shared/upstream-module.js';
import { MAX_API_CHAT_INPUT_CHARS } from '../api-chat/executor.js';
import { ApprovalGate, argsHash, openCodeApprovalDecision, type ApprovalOutcome } from './approval.js';
import { chatRecords, storedChatRecord, updateChatRecord, type ChatRecord } from './ledger.js';
import { claimTurnRecovery, closeInterruptedTurn } from './recovery.js';
import { storeProjectorSink, TurnProjector, type ProjectorSink } from './projector.js';
import { engineToolCallId } from './tool-row.js';
import { assistantMessageId } from './transcript.js';
import type { AgentEngine, EngineChatRef, EngineEvent, EngineFileChange, EngineModelQuery, EngineTerminal, EngineToolKind } from './types.js';
import {
  OpenCodeHttpError, type OpenCodeClient, type OpenCodeEvent, type OpenCodeModel, type OpenCodeModelRef,
  type OpenCodePermission, type OpenCodeRule
} from './opencode-client.js';
import { opencodeSupport } from '../opencode/release.js';
import { OPENCODE_SERVICE_FOREIGN as FOREIGN } from '../opencode/service.js';

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

export interface OpenCodeDeps {
  /** The module as cli-modules sees it (enabled, command capability, resolved binary, managed or from PATH). */
  moduleState(): Promise<{ enabled: boolean; command: boolean; binary: string | null; managed: boolean }>;
  /** The binary's version, probed with a private HOME (never the user's data). */
  version(binary: string): Promise<string | null>;
  support(version: string | null): UpstreamSupport | null;
  /** The approved project's canonical folder as the service sees it (WSL path on Windows). */
  projectFolder(projectId: string): Promise<string>;
  /** The running service, started (by the resolved binary) when none runs. */
  service(): Promise<{ client: OpenCodeClient }>;
  /** The service running now, without starting one (recovery); null when stopped or not the app's. */
  runningService(): Promise<{ client: OpenCodeClient } | null>;
  serviceView(): Promise<OpenCodeServiceView>;
  /** Wires turn tracking to the service: a restart after an update waits for no turn. */
  bindService(options: { busy(): boolean }): void;
  turnsSettled(): void;
  /** The chat's durable module terminal (cli-modules `cliEngineTerminal('opencode', …)`). */
  openTerminal(chat: { sessionId: string; projectId: string; args: string[]; title: string }): Promise<{ id: string }>;
  /** Registers the check every OpenCode terminal runs before it attaches (cli-modules open hook). */
  onTerminalOpen(check: () => Promise<void>): void;
  reconnectDelaysMs?: readonly number[];
  stopGraceMs?: number;
}

const service = () => import('../opencode/service.js');

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
  service: async () => (await service()).ensureOpenCodeService(),
  runningService: async () => (await service()).runningOpenCodeService(),
  serviceView: async () => (await service()).openCodeServiceView(),
  bindService: options => { void service().then(module => module.bindOpenCodeService(options)); },
  turnsSettled: () => { void service().then(module => module.openCodeTurnsSettled()); },
  openTerminal: async chat => (await import('../cli-modules.js')).cliEngineTerminal('opencode', chat),
  onTerminalOpen: check => {
    void import('../cli-modules.js').then(({ registerCliEngineOpenHook }) => registerCliEngineOpenHook('opencode', () => check()))
      .catch(error => logWarn(`OpenCode chats: terminal hook not registered: ${(error as Error).message}`));
  }
};

let deps: OpenCodeDeps = defaultDeps;
let bound = false;

/** Tests replace the service, module and project lookups; null restores the real ones. */
export function setOpenCodeDepsForTests(next: Partial<OpenCodeDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  terminalHooked = false;
  bound = false;
}

function bind(): void {
  if (bound) return;
  bound = true;
  deps.bindService({ busy: () => [...running.values()].some(turn => !turn.ended) });
}

async function connect(): Promise<OpenCodeClient> {
  bind();
  return (await deps.service()).client;
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
  if (support === 'unsupported') {
    return { available: false, detail: `OpenCode ${version} is not supported by this version of Chat Marks (OpenCode 2.1 or a newer 2.x is needed; install it in Settings > Modules)` };
  }
  const view = await deps.serviceView().catch(() => null);
  if (view?.state === 'foreign') return { available: false, detail: FOREIGN };
  const notes = [
    support === 'newer' ? 'newer than tested' : '',
    state.managed ? '' : 'not installed by Chat Marks',
    view?.state === 'running' ? '' : 'the background service starts on first use'
  ].filter(Boolean);
  return { available: true, detail: `OpenCode ${version}${notes.length ? ` (${notes.join(', ')})` : ''}` };
}

// ---------------------------------------------------------------- rules, models, mapping

/**
 * The session's permissions (`Permission.Ruleset`; the last matching rule wins). Inside the
 * project resources are project-relative (`notes.txt`, `sub/x`); outside it they are absolute and
 * gated by `external_directory`. `*` matches `/` (`*\/.markscode/*` covers nested folders).
 */
export function openCodeRuleset(mode: ApiChatApprovalMode): OpenCodeRule[] {
  const effect = mode === 'auto' ? 'allow' : 'ask';
  return [
    { action: 'shell', resource: '*', effect },
    { action: 'edit', resource: '*', effect },
    { action: 'question', resource: '*', effect: 'deny' },
    { action: 'edit', resource: '/*', effect: 'deny' },
    { action: 'read', resource: '/*', effect: 'deny' },
    { action: 'external_directory', resource: '*', effect: 'deny' },
    // MarksCode's per-project data is not OpenCode's to change.
    { action: 'edit', resource: '.markscode/*', effect: 'deny' },
    { action: 'edit', resource: '*/.markscode/*', effect: 'deny' }
  ];
}

/** `provider/model` as the chat stores it, the `Model.Ref` string form without its variant. */
export const modelRowId = (model: Pick<OpenCodeModel, 'id' | 'providerID'>): string => `${model.providerID}/${model.id}`;

export function modelRef(id: string, variant: string | null): OpenCodeModelRef {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) throw new Error('Choose an OpenCode model (provider/model)');
  return { providerID: id.slice(0, slash), id: id.slice(slash + 1), ...(variant ? { variant } : {}) };
}

/** What the user is asked about and its hash input: the exact request, nothing the renderer sent. */
export function boundAction(request: Pick<OpenCodePermission, 'id' | 'sessionID' | 'action' | 'resources'>): Record<string, unknown> {
  return { sessionID: request.sessionID, requestID: request.id, action: request.action, resources: [...request.resources] };
}

export function permissionKind(action: string): EngineToolKind {
  return action === 'shell' ? 'command' : action === 'edit' ? 'patch' : action === 'read' ? 'read' : 'other';
}

function permissionSummary(request: OpenCodePermission): { summary: string; files: string[] } {
  const resources = request.resources.slice(0, 50);
  const files = request.action === 'edit' || request.action === 'read' ? resources : [];
  const summary = request.action === 'shell' ? resources.join('\n')
    : request.action === 'edit' ? `Edit ${resources.join(', ')}`
      : request.action === 'external_directory' ? `Access outside the project: ${resources.join(', ')}`
        : `${request.action}: ${resources.join(', ')}`;
  return { summary: [summary, request.message].filter(Boolean).join('\n'), files };
}

/** OpenCode 2.x tool names: `shell`, `write`/`edit`/`patch`, `read`/`glob`/`grep`/`list`, … */
export function toolKind(name: string): EngineToolKind {
  if (name === 'shell') return 'command';
  if (name === 'edit' || name === 'write' || name === 'patch' || name === 'apply_patch' || name === 'multiedit') return 'patch';
  if (name === 'read' || name === 'glob' || name === 'grep' || name === 'list') return 'read';
  return 'other';
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const inputFile = (input: Record<string, unknown>): string | undefined => text(input.path) ?? text(input.filePath);

/** Files a `patch` tool's text names (`*** Add File:` / `*** Update File:` / `*** Delete File:`). */
function patchFiles(patchText: string): EngineFileChange[] {
  const files: EngineFileChange[] = [];
  for (const match of patchText.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    files.push({ path: match[2]!.trim(), kind: match[1] === 'Add' ? 'add' : match[1] === 'Delete' ? 'delete' : 'update' });
  }
  return files.slice(0, 64);
}

/** `FileDiff.Info[]` (`{ file, patch, status }`) from a tool's or a permission's metadata. */
export function diffFiles(metadata: unknown): EngineFileChange[] | undefined {
  const files = record(metadata).files;
  if (!Array.isArray(files)) return undefined;
  return files.slice(0, 64).flatMap((item): EngineFileChange[] => {
    const diff = record(item);
    const file = text(diff.file);
    if (!file) return [];
    return [{ path: file, kind: diff.status === 'added' ? 'add' : diff.status === 'deleted' ? 'delete' : 'update', ...(text(diff.patch) ? { diff: text(diff.patch) } : {}) }];
  });
}

/** The started row of one OpenCode tool call. */
export function toolStarted(toolId: string, name: string, inputValue: unknown, cwd: string | null): EngineEvent {
  const input = record(inputValue);
  const kind = toolKind(name);
  const base = { type: 'tool_started' as const, toolId, kind, name, input };
  if (kind === 'command') return { ...base, command: text(input.command) ?? '', ...(text(input.workdir) ?? cwd ? { cwd: text(input.workdir) ?? cwd! } : {}) };
  const file = inputFile(input);
  if (kind === 'patch') {
    const files = name === 'patch' || name === 'apply_patch' ? patchFiles(text(input.patchText) ?? '') : file ? [{ path: file, kind: 'update' as const }] : [];
    return { ...base, ...(file ? { path: file } : {}), files };
  }
  if (kind === 'read') return { ...base, ...(file ? { path: file } : {}) };
  return base;
}

/**
 * The finished row: `content` text is the output, `metadata.exit` the exit code, `metadata.files`
 * (or the files the permission request showed) the diffs. A `permission.rejected` error is a decline.
 */
export function toolFinished(toolId: string, result: { content?: unknown; metadata?: unknown; error?: unknown }, declined: boolean,
  shownFiles?: EngineFileChange[]): EngineEvent {
  const output = Array.isArray(result.content)
    ? result.content.map(item => record(item)).filter(item => item.type === 'text').map(item => text(item.text) ?? '').join('\n') : '';
  const metadata = record(result.metadata);
  const files = diffFiles(metadata) ?? shownFiles;
  const exit = typeof metadata.exit === 'number' ? metadata.exit : undefined;
  const failure = result.error === undefined ? undefined : record(result.error);
  const error = failure ? text(failure.message) ?? 'The tool failed' : undefined;
  const rejected = declined || failure?.type === 'permission.rejected';
  return {
    type: 'tool_finished', toolId, status: error !== undefined ? (rejected ? 'declined' : 'failed') : 'ok', output,
    ...(exit !== undefined ? { exitCode: exit } : {}), ...(files?.length && error === undefined ? { files } : {}), ...(error !== undefined ? { error: error.slice(0, 2_000) } : {})
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

type Tokens = { input: number; output: number; reasoning: number; cached: number };

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
  /** Token use per assistant message (one per step) of this turn, summed into `usage`. */
  steps: Map<string, Tokens>;
  /** Permission requests shown as cards, by request id. */
  asked: Map<string, OpenCodePermission>;
  /** The diffs a permission request showed, by tool call id (2.x `write` reports none itself). */
  shownFiles: Map<string, EngineFileChange[]>;
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

function newTurn(options: {
  sessionId: string; conversationId: string; backendId: string; turnId: string; question: string; cwd: string | null;
  firstStep?: number; sink?: ProjectorSink;
}): Turn {
  const gate = new ApprovalGate(() => notifyChanged(options.sessionId));
  const turn: Turn = {
    sessionId: options.sessionId, backendId: options.backendId, turnId: options.turnId, question: options.question, cwd: options.cwd,
    gate, abort: new AbortController(), queue: Promise.resolve(), promptSent: false, promptAt: 0, promptMessageId: null,
    stopped: false, ended: false, connectedOnce: false, reconcileFirst: false, connected: deferred(), failures: 0,
    toolNames: new Map(), started: new Set(), finished: new Set(), storedCalls: new Set(), texts: [], steps: new Map(), asked: new Map(),
    shownFiles: new Map(), answered: new Set(), replies: new Map(), rejected: new Set(), stopTimer: null, done: deferred(),
    projector: null as unknown as TurnProjector
  };
  turn.projector = new TurnProjector({
    engine: ENGINE, conversationId: options.conversationId, turnId: options.turnId, sink: options.sink ?? storeProjectorSink(options.sessionId),
    approvals: { gate, answer: (requestId, outcome) => answerRequest(turn, requestId, outcome) },
    ...(options.firstStep ? { firstStep: options.firstStep } : {})
  });
  return turn;
}

/** Replaces the session's ruleset with the chat's approval mode and stores it. */
async function setApproval(sessionId: string, client: OpenCodeClient, backendId: string, approval: ApiChatApprovalMode): Promise<void> {
  await client.setPermissions(backendId, openCodeRuleset(approval));
  await updateChatRecord(sessionId, current => current ? { ...current, approval } : current);
  notifyChanged(sessionId);
}

/** The gate settled a card: post the user's decision to exactly that OpenCode request. */
function answerRequest(turn: Turn, requestId: string, outcome: ApprovalOutcome): void {
  const reply = turn.replies.get(requestId);
  turn.replies.delete(requestId);
  const request = turn.asked.get(requestId);
  turn.asked.delete(requestId);
  const decision = openCodeApprovalDecision(outcome);
  // Stop interrupts the execution, which settles its own requests; a TUI answer needs none.
  if (!decision || outcome === 'stop' || outcome === 'resolved') { reply?.resolve(); return; }
  turn.answered.add(requestId);
  if (decision === 'reject' && request?.source?.id) turn.rejected.add(request.source.id);
  void (async () => {
    const client = await connect();
    // "Always": this chat runs edits and commands automatically from now on (its own rules, not a project-wide save).
    if (outcome === 'always') await setApproval(turn.sessionId, client, turn.backendId, 'auto');
    await client.reply(turn.backendId, requestId, decision, decision === 'reject' ? DECLINED : undefined);
  })().then(() => reply?.resolve(), error => {
    turn.answered.delete(requestId);
    logWarn(`OpenCode chat ${turn.sessionId}: permission answer not delivered: ${(error as Error).message}`);
    reply?.reject(error);
  });
}

async function raiseApproval(turn: Turn, request: OpenCodePermission): Promise<void> {
  if (request.sessionID !== turn.backendId || turn.asked.has(request.id) || turn.answered.has(request.id)) return;
  if (typeof request.id !== 'string' || typeof request.action !== 'string' || !Array.isArray(request.resources)) return;
  const shown: OpenCodePermission = { ...request, resources: request.resources.filter((item): item is string => typeof item === 'string') };
  turn.asked.set(shown.id, shown);
  const shownDiffs = diffFiles(shown.metadata);
  if (shown.source?.id && shownDiffs?.length) turn.shownFiles.set(shown.source.id, shownDiffs);
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

/** One step's tokens (`session.step.ended`, or an assistant message's `tokens`), summed for the turn. */
async function countStep(turn: Turn, stepId: string, tokensValue: unknown): Promise<void> {
  const tokens = record(tokensValue);
  const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  turn.steps.set(stepId, { input: num(tokens.input), output: num(tokens.output), reasoning: num(tokens.reasoning), cached: num(record(tokens.cache).read) });
  const total = [...turn.steps.values()].reduce((sum, step) => ({
    input: sum.input + step.input + step.cached, output: sum.output + step.output, reasoning: sum.reasoning + step.reasoning, cached: sum.cached + step.cached
  }), { input: 0, output: 0, reasoning: 0, cached: 0 });
  await turn.projector.apply({ type: 'usage', inputTokens: total.input, outputTokens: total.output, reasoningTokens: total.reasoning, cachedInputTokens: total.cached });
}

async function handle(turn: Turn, event: OpenCodeEvent): Promise<void> {
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
      if (turn.promptSent && typeof data.delta === 'string') await turn.projector.apply({ type: 'text_delta', delta: data.delta });
      return;
    case 'session.text.ended':
      if (turn.promptSent && typeof data.text === 'string') await showText(turn, data.text);
      return;
    case 'session.tool.input.started':
      if (toolId && typeof data.name === 'string') turn.toolNames.set(toolId, data.name);
      return;
    case 'session.tool.called':
      if (turn.promptSent && toolId) await startTool(turn, toolId, turn.toolNames.get(toolId) ?? 'tool', data.input);
      return;
    case 'session.tool.success':
    case 'session.tool.failed':
      if (!turn.promptSent || !toolId) return;
      if (!turn.started.has(toolId)) await startTool(turn, toolId, turn.toolNames.get(toolId) ?? 'tool', undefined);
      await finishTool(turn, toolId, toolFinished(toolId, { content: data.content, metadata: data.metadata,
        ...(event.type === 'session.tool.failed' ? { error: data.error ?? {} } : {}) }, turn.rejected.has(toolId), turn.shownFiles.get(toolId)));
      return;
    case 'session.shell.started': {
      const shell = record(data.shell);
      const id = text(shell.id);
      if (!id || !turn.promptSent) return;
      await startTool(turn, `shell:${id}`, 'shell', { command: text(shell.command) ?? '', ...(text(shell.cwd) ? { workdir: text(shell.cwd) } : {}) });
      return;
    }
    case 'session.shell.ended': {
      const shell = record(data.shell);
      const id = text(shell.id);
      if (!id || !turn.promptSent) return;
      if (!turn.started.has(`shell:${id}`)) await startTool(turn, `shell:${id}`, 'shell', { command: text(shell.command) ?? '' });
      await finishTool(turn, `shell:${id}`, { type: 'tool_finished', toolId: `shell:${id}`, status: 'ok', output: text(record(data.output).output) ?? '',
        ...(typeof shell.exit === 'number' ? { exitCode: shell.exit } : {}) });
      return;
    }
    case 'session.step.ended':
    case 'session.step.failed': {
      const stepId = text(data.assistantMessageID);
      if (turn.promptSent && stepId && data.tokens) await countStep(turn, stepId, data.tokens);
      return;
    }
    case 'permission.asked':
      if (turn.promptSent) await raiseApproval(turn, data as unknown as OpenCodePermission);
      return;
    case 'permission.replied': {
      const requestId = text(data.requestID);
      if (!requestId) return;
      // This app's own answer comes back too; only another client's (the TUI's) removes the card here.
      if (turn.answered.has(requestId)) return;
      const asked = turn.asked.get(requestId);
      if (asked) {
        turn.asked.delete(requestId);
        if (data.reply === 'reject' && asked.source?.id) turn.rejected.add(asked.source.id);
        await turn.projector.apply({ type: 'approval_resolved', requestId });
      }
      return;
    }
    case 'session.execution.succeeded':
      if (turn.promptSent) await end(turn, 'completed');
      return;
    case 'session.execution.failed':
      if (!turn.promptSent) return;
      await turn.projector.apply({ type: 'error', message: `OpenCode failed: ${(text(record(data.error).message) ?? 'unknown error').slice(0, 500)}`, fatal: true });
      await end(turn, 'failed');
      return;
    case 'session.execution.interrupted':
      if (turn.promptSent) await end(turn, turn.stopped ? 'stopped' : 'interrupted',
        turn.stopped ? undefined : data.reason === 'user' ? 'The OpenCode run was stopped in its terminal' : `OpenCode interrupted the run (${text(data.reason) ?? 'unknown'})`);
      return;
    default:
  }
}

/** This turn's question in `/api/session/:id/message`: the prompt's own message id, else its text. */
const isOurQuestion = (turn: Turn, message: Record<string, unknown>): boolean =>
  message.type === 'user' && (turn.promptMessageId ? message.id === turn.promptMessageId : message.text === turn.question);

/**
 * Imports what the event stream may have missed: finished tools, settled answer texts and step
 * tokens after this turn's question. While the session still runs, its last content part may be
 * streaming and is left to the live events.
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
    const messageId = text(message.id);
    if (messageId && message.tokens && record(message.time).completed !== undefined && !turn.steps.has(messageId)) await countStep(turn, messageId, message.tokens);
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
        if (state.status === 'streaming' || state.status === 'pending') continue;
        await startTool(turn, id, name, state.input);
        if (state.status === 'completed' || state.status === 'error') {
          await finishTool(turn, id, toolFinished(id, { content: state.content, metadata: state.metadata,
            ...(state.status === 'error' ? { error: state.error ?? {} } : {}) }, turn.rejected.has(id), turn.shownFiles.get(id)));
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
  if (info.outcome === 'failed') await turn.projector.apply({ type: 'error', message: 'OpenCode failed while Chat Marks was disconnected', fatal: true });
  await end(turn, info.outcome === 'succeeded' ? 'completed' : info.outcome === 'failed' ? 'failed' : turn.stopped ? 'stopped' : 'interrupted',
    info.outcome === 'interrupted' && !turn.stopped ? 'OpenCode interrupted the run' : undefined);
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

/** The turn's event stream: reconnects with backoff until the turn ends, Stop, or app quit. */
async function pump(turn: Turn): Promise<void> {
  const delays = deps.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  while (!turn.ended && !turn.abort.signal.aborted) {
    try {
      const client = await connect();
      await client.events(turn.abort.signal, event => enqueue(turn, () => handle(turn, event)),
        () => logWarn(`OpenCode chat ${turn.sessionId}: an oversized event was dropped`));
    } catch (error) {
      if (turn.abort.signal.aborted) break;
      logWarn(`OpenCode chat ${turn.sessionId}: event stream lost: ${(error as Error).message}`);
    }
    if (turn.ended || turn.abort.signal.aborted) break;
    if (turn.failures >= delays.length) {
      await enqueue(turn, async () => {
        await turn.projector.apply({ type: 'error', message: 'Chat Marks lost the connection to the OpenCode service. The session may still be running in its terminal.', fatal: false });
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
  const closed = async (detail: string): Promise<void> => { await closeInterruptedTurn(sessionId, open.turnId, detail); };
  const session = await getSession(sessionId);
  if (!session || !chat.backendSessionId || !OPENCODE_SESSION.test(chat.backendSessionId)) return closed('Chat Marks closed before OpenCode finished');
  const events = (await readEvents(sessionId)).filter(event => event.turnId === open.turnId || (event.kind === 'user_message' && event.messageId === `api-user:${open.turnId}`));
  if (!events.some(event => event.kind === 'turn_start') || events.some(event => event.kind === 'turn_end')) return closed('Chat Marks closed before OpenCode finished');
  let client: OpenCodeClient;
  let live: boolean;
  try {
    // Recovery never starts the service: a stopped one has nothing of this turn left running.
    const found = await deps.runningService();
    if (!found) return closed('The OpenCode service was not running when Chat Marks started');
    client = found.client;
    live = await client.running(chat.backendSessionId);
  } catch (error) {
    logWarn(`OpenCode chat ${sessionId}: not re-attached: ${(error as Error).message}`);
    return closed('The OpenCode service was not reachable when Chat Marks started');
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
  if (session.projectId) cwd = await deps.projectFolder(session.projectId).catch(() => null);
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
    logInfo(`OpenCode chat ${sessionId}: re-attached to running session for turn ${open.turnId}`);
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
      await turn.projector.apply({ type: 'error', message: 'OpenCode failed while Chat Marks was closed', fatal: true });
      await end(turn, 'failed');
    } else await end(turn, 'interrupted', 'Chat Marks closed before OpenCode finished');
  });
  if (!turn.ended) await end(turn, 'interrupted', 'Chat Marks closed before OpenCode finished');
}

export function recoverOpenCodeChats(): Promise<void> {
  hookTerminals();
  bind();
  recovery ??= (async () => {
    for (const [sessionId, chat] of Object.entries(await chatRecords())) {
      if (chat.engine !== ENGINE || !chat.openTurn || running.has(sessionId)) continue;
      try {
        await recoverChat(sessionId, chat);
      } catch (error) {
        logWarn(`OpenCode chat ${sessionId}: open turn not recovered: ${(error as Error).message}`);
        running.delete(sessionId);
        await closeInterruptedTurn(sessionId, chat.openTurn.turnId, 'Chat Marks closed before OpenCode finished').catch(() => undefined);
      }
    }
  })();
  return recovery;
}

// ---------------------------------------------------------------- terminal

let terminalHooked = false;

/** Every attach (also a plain OpenCode terminal): usable, and the service runs, so the TUI joins it instead of starting its own. */
async function terminalReady(): Promise<void> {
  const status = await openCodeStatus();
  if (!status.available) throw new Error(status.detail);
  await deps.service();
}

function hookTerminals(): void {
  if (terminalHooked) return;
  terminalHooked = true;
  deps.onTerminalOpen(terminalReady);
}

function terminalOf(backendSessionId: string | null, cwd: string | null): EngineTerminal | null {
  if (!backendSessionId || !OPENCODE_SESSION.test(backendSessionId) || !cwd || !cwd.startsWith('/')) return null;
  return { argv: ['-s', backendSessionId, cwd], mode: 'live' };
}

/** Live: `opencode -s <session> <folder>` in the chat's terminal, attached to the service session the chat uses. */
async function openTerminal(sessionId: string): Promise<{ cliSessionId: string }> {
  hookTerminals();
  const { session, record: chat } = await openCodeChat(sessionId);
  if (!session.projectId) throw new Error('This OpenCode chat has no project');
  const directory = await deps.projectFolder(session.projectId);
  const terminal = terminalOf(chat.backendSessionId ?? null, directory);
  if (!terminal) throw new Error('This chat has no engine session yet');
  await terminalReady();
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

async function listModels(client: OpenCodeClient, directory?: string): Promise<{ list: OpenCodeModel[]; fallback: string | null }> {
  const [list, fallback] = await Promise.all([client.models(directory), client.defaultModel(directory).catch(() => null)]);
  return { list: list.filter(model => typeof model?.id === 'string' && typeof model.providerID === 'string' && model.enabled !== false), fallback: fallback ? modelRowId(fallback) : null };
}

/** The `Model.Ref` for a chat's model and effort; an effort is a variant only when the model has one by that name. */
async function chatModelRef(client: OpenCodeClient, model: string, effort: ApiChatEffort | null): Promise<OpenCodeModelRef> {
  if (!effort) return modelRef(model, null);
  const { list } = await listModels(client);
  const found = list.find(item => modelRowId(item) === model);
  return modelRef(model, found?.variants?.some(variant => variant.id === effort) ? effort : null);
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
    const { list, fallback } = await listModels(await connect());
    const needle = query.query?.trim().toLowerCase() ?? '';
    const rows: ApiChatModel[] = list
      .map(model => ({
        id: modelRowId(model), ownedBy: model.providerID, modality: 'chat' as const, favorite: false, recent: false, availability: null,
        label: typeof model.name === 'string' ? model.name : model.id,
        ...(model.variants?.length ? { efforts: model.variants.map(variant => variant.id).filter((id): id is string => typeof id === 'string') } : {})
      }))
      .filter(row => !needle || row.id.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle))
      .sort((left, right) => Number(right.id === fallback) - Number(left.id === fallback));
    const offset = query.offset ?? 0;
    return { models: rows.slice(offset, offset + (query.limit ?? 50)), total: rows.length };
  },

  async create(options) {
    await recoverOpenCodeChats();
    if (!options.projectId) throw new Error('Choose a project for an OpenCode chat first');
    const directory = await deps.projectFolder(options.projectId);
    const client = await connect();
    const fallback = options.model ? null : await client.defaultModel(directory).catch(() => null);
    const model = options.model ? modelId.parse(options.model) : fallback ? modelRowId(fallback) : null;
    const backend = await client.createSession({
      title: 'Chat Marks', location: { directory }, permissions: openCodeRuleset('ask'), ...(model ? { model: modelRef(model, null) } : {})
    });
    if (!OPENCODE_SESSION.test(backend.id)) throw new Error('OpenCode returned an unexpected session id');
    const summary = await createSession({ title: 'New OpenCode chat', titleSource: 'fallback', conversationId: `${API_CONVERSATION_PREFIX}${randomUUID()}` });
    await bindSessionProject(summary.id, options.projectId);
    await updateChatRecord(summary.id, () => ({ engine: ENGINE, backendSessionId: backend.id, model, effort: null }));
    notifyChanged(summary.id);
    return view(summary.id);
  },

  view,

  async send(sessionId, question) {
    await recoverOpenCodeChats();
    if (!question.trim() || question.length > MAX_API_CHAT_INPUT_CHARS) throw new Error('Write a message of up to 100,000 characters');
    const { session, record: chat } = await openCodeChat(sessionId);
    if (!session.projectId) throw new Error('This OpenCode chat has no project');
    const directory = await deps.projectFolder(session.projectId);
    // Check and claim with no await between: one turn per chat.
    if (running.has(session.id)) throw new Error('This chat is still answering');
    const turn = newTurn({
      sessionId: session.id, conversationId: session.conversationId, backendId: chat.backendSessionId!, turnId: `api-${randomUUID()}`,
      question, cwd: directory
    });
    running.set(session.id, turn);
    let started = false;
    try {
      const client = await connect();
      if (await client.running(turn.backendId)) throw new Error('OpenCode is still working in this session (its terminal). Send again when it finishes.');
      await turn.projector.start(question);
      started = true;
      void pump(turn);
      await waitConnected(turn);
      if (turn.ended) throw new Error('The OpenCode event stream could not be opened');
      turn.promptAt = Date.now();
      turn.promptSent = true;
      turn.promptMessageId = (await client.prompt(turn.backendId, question)).id;
      return { turnId: turn.turnId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (started) {
        await enqueue(turn, async () => {
          await turn.projector.apply({ type: 'error', message: `The OpenCode request failed: ${message}`, fatal: true });
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
    await openCodeChat(sessionId);
    const turn = running.get(sessionId);
    if (!turn || turn.ended) return false;
    turn.stopped = true;
    try {
      await (await connect()).interrupt(turn.backendId);
    } catch (error) {
      logWarn(`OpenCode chat ${sessionId}: interrupt not delivered: ${(error as Error).message}`);
    }
    // `session.execution.interrupted` normally ends it; without one the turn still ends here.
    turn.stopTimer ??= setTimeout(() => void enqueue(turn, () => end(turn, 'stopped')), deps.stopGraceMs ?? STOP_GRACE_MS);
    turn.stopTimer.unref?.();
    return true;
  },

  async approve(sessionId, approvalId, decision: ApiChatApprovalDecision) {
    await openCodeChat(sessionId);
    const turn = running.get(sessionId);
    const requestId = turn?.gate.has(approvalId) ? turn.gate.engineRequestOf(approvalId) : null;
    const bound = turn?.gate.hashOf(approvalId) ?? null;
    if (!turn || !requestId || !bound) throw new Error('This approval is no longer pending');
    // The answer goes to exactly the request the card showed, read back from OpenCode now.
    const live = await (await connect()).permission(turn.backendId, requestId);
    if (!live || live.sessionID !== turn.backendId) {
      await enqueue(turn, async () => {
        turn.asked.delete(requestId);
        await turn.projector.apply({ type: 'approval_resolved', requestId });
      });
      throw new Error('This approval is no longer pending');
    }
    if (decision !== 'deny' && argsHash(live.action, boundAction(live)) !== bound) throw new Error('This OpenCode request changed after it was shown; it was not approved');
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
    if (model) modelRef(model, null);
    const effort: ApiChatEffort | null = patch.effort !== undefined ? patch.effort : chat.effort;
    const approval = patch.approval !== undefined ? z.enum(API_CHAT_APPROVAL_MODES).parse(patch.approval) : undefined;
    const client = await connect();
    // The session keeps its model upstream (`session.switchModel`); the effort is its variant.
    if ((patch.model !== undefined || patch.effort !== undefined) && model) await client.switchModel(chat.backendSessionId!, await chatModelRef(client, model, effort));
    if (approval !== undefined) await client.setPermissions(chat.backendSessionId!, openCodeRuleset(approval));
    await updateChatRecord(session.id, current => ({
      ...(current ?? chat), model, effort, ...(approval !== undefined ? { approval } : {})
    }));
    notifyChanged(session.id);
    return view(session.id);
  },

  recover: () => recoverOpenCodeChats(),

  /** The arguments after the binary: `-s <session> <folder>`, the TUI attached to the same service session. */
  terminal: (chat: EngineChatRef): EngineTerminal | null => terminalOf(chat.backendSessionId, chat.cwd),

  openTerminal
};

// OpenCode re-attaches its own open turns on startup; the CLIProxy recovery leaves its records alone.
claimTurnRecovery(ENGINE);

/** App quit: close every event stream without ending its turn; the service keeps running and the next start re-attaches. */
export function shutdownOpenCodeEngine(): void {
  for (const turn of running.values()) {
    turn.abort.abort();
    if (turn.stopTimer) clearTimeout(turn.stopTimer);
  }
}

/** Test hook: the turn's settled promise, to await a turn's end. */
export function openCodeTurnDone(sessionId: string): Promise<void> | null {
  return running.get(sessionId)?.done.promise ?? null;
}

/** Test hook: the running turn's usage so far. */
export function openCodeTurnUsage(sessionId: string): TurnProjector['usage'] {
  return running.get(sessionId)?.projector.usage ?? null;
}

export function resetOpenCodeEngineForTests(): void {
  shutdownOpenCodeEngine();
  running.clear();
  recovery = null;
}

export { OpenCodeHttpError };
