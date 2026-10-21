/**
 * The `claude` engine: Claude Code runs an API chat's turns. One long-lived headless process per
 * chat (`claude -p` with stream-json in and out, the control protocol on the same pipes), started
 * on the chat's first send in the chat's canonical project folder and kept between turns:
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *     --include-partial-messages --permission-prompt-tool stdio --permission-mode <default|manual>
 *     --settings <hardening> [--model=M] [--effort L] (--session-id=<uuid> | --resume=<uuid>)
 *
 * Never a bypass flag or mode: every permission prompt reaches the app as a `can_use_tool`
 * control request, the shared `ApprovalGate` shows it, and the answer passes back exactly the
 * input that was shown. Stop sends an `interrupt` control request. The stream is translated into
 * engine-neutral events and written by the `TurnProjector` (projector.ts) in the API chat shapes.
 *
 * Sessions: `create` mints the Claude session uuid (`backendSessionId`); the first turn starts it
 * with `--session-id`, every later process resumes it with `--resume`. No process survives the
 * app: the engine-neutral recovery closes a turn left open as `interrupted`, and the next send
 * starts a new process with `--resume`.
 *
 * Terminal (hand-over): the interactive TUI cannot share the live `-p` session, so opening the
 * terminal stops this chat's host (refused while a turn runs) and runs `claude --resume <id>` in
 * the Claude module's tmux mechanism. The next send ends that tmux session when no terminal view
 * is attached to it, and is refused while one is (the user closes the view first); the host then
 * restarts with `--resume`. The two never run at once.
 */
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AGENT_ENGINE_LABELS } from '../../shared/agent-engine.js';
import {
  API_CHAT_APPROVAL_MODES, API_CHAT_EFFORTS, API_CONVERSATION_PREFIX, isApiConversationId,
  type ApiChatEffort, type ApiChatModel, type ApiChatView
} from '../../shared/api-chat.js';
import type { TurnOutcome } from '../../shared/session.js';
import { recoverApiChats } from '../api-chat/executor.js';
import { normalizeEnvironment } from '../env.js';
import { logInfo, logWarn } from '../logger.js';
import { redactSecretText } from '../redaction.js';
import { notifyChanged } from '../session/recorder.js';
import { bindSessionProject, createSession, getSession, readEvents } from '../session/store.js';
import { ApprovalGate, argsHash, claudeApprovalDecision, type ApprovalOutcome } from './approval.js';
import { engineOf, storedChatRecord, updateChatRecord, type ChatRecord } from './ledger.js';
import { storeProjectorSink, TurnProjector, type ProjectorSink } from './projector.js';
import type { AgentEngine, EngineChatRef, EngineEvent, EngineFileChange, EngineModelQuery, EngineTerminal, EngineToolKind } from './types.js';

const LABEL = AGENT_ENGINE_LABELS.claude;
export const MAX_CLAUDE_INPUT_CHARS = 100_000;
const MAX_LINE_CHARS = 8_000_000;
const STDERR_TAIL_CHARS = 4_000;
const STATUS_CACHE_MS = 60_000;

/**
 * Flag settings: the highest-priority settings layer. User, project and local settings still
 * load (the user's auth helper, env, MCP servers and their own deny/ask rules keep working, and
 * the hand-over terminal resumes the same session with the same settings), but this layer keeps
 * the session from ever entering bypass mode and keeps the CLI's own permission default.
 */
export const CLAUDE_FLAG_SETTINGS = JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } });
/**
 * A chat turn ends at its `result`: nothing re-invokes this session afterwards. Live 2026-10-21, a
 * Claude Code chat launched a background agent and a 20-minute `ScheduleWakeup`, ended its turn on
 * "I will report back", and its findings never reached the chat. Background work runs in the
 * foreground here, and the tools that only finish on a later wake-up are not offered.
 */
export const CLAUDE_DEFERRED_TOOLS = ['ScheduleWakeup', 'Monitor', 'CronCreate', 'CronDelete', 'CronList'] as const;
export const CLAUDE_CHAT_ENV = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_DISABLE_CRON: '1' } as const;

/** Aliases Claude Code resolves to its current models (`--model` help); the CLI's reported ids join them. */
export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
const modelId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][\w.\-[\]:@/]*$/, 'Not a Claude model id');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeRuntime {
  /** The program to start (`wsl.exe` on Windows) and the arguments before Claude's own. */
  bin: string;
  argsPrefix: string[];
  /** The canonical native folder the process runs in. */
  cwd: string;
}

export interface ClaudeTerminalDeps {
  state(chatSessionId: string): Promise<'none' | 'detached' | 'attached'>;
  end(chatSessionId: string): Promise<void>;
  open(chat: { sessionId: string; projectId: string | null; args: string[]; title: string }): Promise<{ id: string }>;
}

export interface ClaudeEngineDeps {
  /** Binary, prefix and canonical cwd: cli-modules' resolution (module enabled, Command on, WSL on Windows). */
  runtime(projectId: string | null): Promise<ClaudeRuntime>;
  spawn?: (bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  /** Runs a short read-only command (`--version`, `--help`, `auth status --json`). */
  probe?: (runtime: ClaudeRuntime, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  terminal?: ClaudeTerminalDeps;
  /** Registers the open/stop hooks with the module terminals once; optional in tests. */
  attachModuleHooks?(engine: ClaudeEngine): void;
  sink?(sessionId: string): ProjectorSink;
  env?(): NodeJS.ProcessEnv;
  initializeTimeoutMs?: number;
  interruptGraceMs?: number;
  idleMs?: number;
}

/** What the renderer's model list shows for Claude: aliases first, then what the CLI reported. */
export function claudeModelRows(reported: Iterable<string>, query: EngineModelQuery): { models: ApiChatModel[]; total: number } {
  if (query.modality && query.modality !== 'chat') return { models: [], total: 0 };
  const ids = [...new Set([...CLAUDE_MODEL_ALIASES, ...reported])];
  const needle = query.query?.trim().toLowerCase() ?? '';
  const matched = ids.filter(id => !needle || id.toLowerCase().includes(needle));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  return {
    total: matched.length,
    models: matched.slice(offset, offset + limit).map(id => ({ id, ownedBy: 'anthropic', modality: 'chat', favorite: false, recent: false, availability: null }))
  };
}

/** The exact argv after the binary. `mode` decides between starting and resuming the session. */
export function claudeArgs(options: {
  sessionId: string; mode: 'start' | 'resume'; permissionMode: 'default' | 'manual'; model?: string | null; effort?: ApiChatEffort | null;
}): string[] {
  if (!UUID.test(options.sessionId)) throw new Error('Invalid Claude session id');
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', options.permissionMode, '--settings', CLAUDE_FLAG_SETTINGS,
    '--disallowedTools', CLAUDE_DEFERRED_TOOLS.join(','),
    ...(options.model ? [`--model=${modelId.parse(options.model)}`] : []),
    ...(options.effort ? ['--effort', z.enum(API_CHAT_EFFORTS).parse(options.effort)] : []),
    options.mode === 'resume' ? `--resume=${options.sessionId}` : `--session-id=${options.sessionId}`
  ];
}

/** `--permission-mode` is `default` up to 2.1.x and `manual` in versions whose help lists it without `default`. */
export function permissionModeFromHelp(help: string): 'default' | 'manual' {
  const line = help.split(/\r?\n/).findIndex(text => text.includes('--permission-mode'));
  const block = line >= 0 ? help.split(/\r?\n/).slice(line, line + 4).join(' ') : '';
  return /"manual"/.test(block) && !/"default"/.test(block) ? 'manual' : 'default';
}

// ------------------------------------------------------------------ stream translation helpers

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max)}…` : value;

export function claudeToolKind(name: string): EngineToolKind {
  if (name === 'Bash' || name === 'PowerShell') return 'command';
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return 'patch';
  if (name === 'Read' || name === 'Grep' || name === 'Glob' || name === 'LS' || name === 'NotebookRead') return 'read';
  return name.startsWith('mcp__') ? 'mcp' : 'other';
}

/** `mcp__server__tool` as `server/tool`; any other name as it is. */
export const claudeToolName = (name: string): string => {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${match[1]}/${match[2]}` : name;
};

const lines = (value: string): string[] => value === '' ? [] : value.replace(/\r?\n$/, '').split(/\r?\n/);
function syntheticDiff(path: string, before: string | null, after: string): string {
  return [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`,
    ...(before === null ? [] : lines(before).map(line => `-${line}`)), ...lines(after).map(line => `+${line}`)].join('\n');
}

/** The files an edit tool touches, with a unified diff of its own input (the CLI keeps no snapshot for us). */
export function claudeToolFiles(name: string, input: Record<string, unknown>, result?: Record<string, unknown> | null): EngineFileChange[] {
  const path = text(input.file_path) ?? text(input.notebook_path);
  if (!path) return [];
  const patch = Array.isArray(result?.structuredPatch) ? result.structuredPatch as unknown[] : null;
  if (patch?.length) {
    const body = patch.flatMap(hunk => Array.isArray(record(hunk)?.lines) ? (record(hunk)!.lines as unknown[]).filter((line): line is string => typeof line === 'string') : []);
    return [{ path, kind: result?.type === 'create' ? 'add' : 'update', diff: [`--- a/${path}`, `+++ b/${path}`, ...body].join('\n') }];
  }
  if (name === 'Write') {
    const content = text(input.content) ?? '';
    return [{ path, kind: result?.type === 'update' ? 'update' : 'add', diff: syntheticDiff(path, null, content) }];
  }
  if (name === 'Edit') return [{ path, kind: 'update', diff: syntheticDiff(path, text(input.old_string) ?? '', text(input.new_string) ?? '') }];
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const diff = input.edits.map(record).filter(Boolean).map(edit => syntheticDiff(path, text(edit!.old_string) ?? '', text(edit!.new_string) ?? '').split('\n').slice(2).join('\n'));
    return [{ path, kind: 'update', diff: [`--- a/${path}`, `+++ b/${path}`, ...diff].join('\n') }];
  }
  return [{ path, kind: 'update' }];
}

/** The approval card's readable text for one tool input. */
export function claudeApprovalSummary(name: string, input: Record<string, unknown>): { summary: string; files: string[] } {
  const kind = claudeToolKind(name);
  if (kind === 'command') {
    const description = text(input.description);
    return { summary: `${text(input.command) ?? ''}${description ? `\n# ${description}` : ''}`, files: [] };
  }
  if (kind === 'patch') {
    const files = claudeToolFiles(name, input).map(file => file.path);
    return { summary: `${name} ${files.join(', ')}`.trim(), files };
  }
  const path = text(input.file_path) ?? text(input.path) ?? text(input.pattern) ?? text(input.url);
  return { summary: path ? `${claudeToolName(name)} ${path}` : `${claudeToolName(name)} ${clip(JSON.stringify(input), 500)}`, files: [] };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(record).map(block => block?.type === 'text' ? text(block.text) ?? '' : block?.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
}

/** Session-scoped permission updates from the CLI's own suggestions; never a mode change. */
export function sessionPermissionUpdates(suggestions: unknown): Record<string, unknown>[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.map(record).filter((item): item is Record<string, unknown> =>
    !!item && (item.type === 'addRules' && item.behavior === 'allow' || item.type === 'addDirectories'))
    .map(item => ({ ...structuredClone(item), destination: 'session' }));
}

/** One line of stderr's tail, with credentials redacted, for a failure the user can read. */
const stderrSummary = (tail: string): string => {
  const kept = tail.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-3).join(' · ');
  return clip(redactSecretText(kept), 400);
};

const AUTH_FAILURE = /not logged in|please run \/login|invalid api key|authentication_error|oauth token (?:has )?expired|credit balance is too low/i;

// ------------------------------------------------------------------ process and turn state

interface PendingRequest {
  toolUseId: string;
  tool: string;
  /** Exactly what the card showed; answered back unchanged. */
  input: Record<string, unknown>;
  hash: string;
  suggestions: unknown;
}

interface ClaudeTurn {
  sessionId: string;
  turnId: string;
  projector: TurnProjector;
  gate: ApprovalGate;
  requests: Map<string, PendingRequest>;
  /** tool_use ids the user denied: their error result is a declined row. */
  declined: Set<string>;
  /** Tool names by tool_use id, for the result's files. */
  tools: Map<string, { name: string; input: Record<string, unknown> }>;
  seen: Set<string>;
  /** Requests the CLI withdrew before the card was shown. */
  cancelled: Set<string>;
  host: ClaudeHost | null;
  stopped: boolean;
  done: Promise<TurnOutcome>;
}

interface Launch { cwd: string; backendId: string; model: string | null; effort: ApiChatEffort | null }

class ClaudeHost {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  alive = true;
  sawStdout = false;
  stderr = '';
  exitCode: number | null = null;
  turn: ClaudeTurn | null = null;
  /** After an interrupt: the stopped turn's own `result` is still to come and belongs to nobody. */
  draining: { resolve(): void; promise: Promise<void> } | null = null;
  idleTimer: NodeJS.Timeout | null = null;
  private buffer = '';
  private nextId = 0;
  private readonly waiters = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();

  constructor(readonly launch: Launch, child: ChildProcessWithoutNullStreams, private readonly onMessage: (host: ClaudeHost, message: Record<string, unknown>) => void) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS); });
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    this.exited = new Promise(resolve => {
      const done = (code: number | null): void => {
        if (!this.alive) return;
        this.alive = false;
        this.exitCode = code;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        for (const waiter of this.waiters.values()) waiter.reject(new Error('Claude Code exited'));
        this.waiters.clear();
        this.draining?.resolve();
        resolve();
      };
      // `close`: stdout and stderr are drained, so the failure text is complete.
      child.on('close', code => done(code));
      child.on('error', error => { this.stderr = `${this.stderr}\n${error.message}`.slice(-STDERR_TAIL_CHARS); done(null); });
    });
  }

  private read(chunk: string): void {
    this.sawStdout = true;
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_CHARS) { this.buffer = ''; logWarn('Claude Code chat: an over-long stream line was dropped'); }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const message = record(parsed);
      if (!message) continue;
      if (message.type === 'control_response') { this.settle(message); continue; }
      this.onMessage(this, message);
    }
  }

  private settle(message: Record<string, unknown>): void {
    const response = record(message.response);
    const id = text(response?.request_id);
    const waiter = id ? this.waiters.get(id) : undefined;
    if (!waiter || !id) return;
    this.waiters.delete(id);
    if (response?.subtype === 'error') waiter.reject(new Error(text(response.error) ?? 'Claude Code refused the request'));
    else waiter.resolve(record(response?.response) ?? {});
  }

  write(message: unknown): void {
    if (!this.alive || this.child.stdin.destroyed) throw new Error('Claude Code is not running');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** A host → CLI control request; resolves with its success body, rejects with its error or exit. */
  control(request: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const id = `marks-${++this.nextId}-${randomUUID().slice(0, 8)}`;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      this.waiters.set(id, {
        resolve: value => { if (timer) clearTimeout(timer); resolve(value); },
        reject: error => { if (timer) clearTimeout(timer); reject(error); }
      });
      if (timeoutMs) timer = setTimeout(() => { this.waiters.delete(id); reject(new Error('timeout')); }, timeoutMs);
      try { this.write({ type: 'control_request', request_id: id, request }); }
      catch (error) { this.waiters.delete(id); if (timer) clearTimeout(timer); reject(error as Error); }
    });
  }

  respond(requestId: string, body: Record<string, unknown>): void {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: body } });
  }

  respondError(requestId: string, error: string): void {
    this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
  }

  async kill(): Promise<void> {
    if (!this.alive) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => { if (this.alive) this.child.kill('SIGKILL'); }, 3_000);
    await this.exited;
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ the engine

export class ClaudeEngine implements AgentEngine {
  readonly id = 'claude' as const;
  readonly label = LABEL;
  readonly terminalMode = 'handover' as const;
  private readonly hosts = new Map<string, ClaudeHost>();
  private readonly turns = new Map<string, ClaudeTurn>();
  /** Chats whose send is between its checks and its recorded question. */
  private readonly starting = new Set<string>();
  private readonly reportedModels = new Set<string>();
  private statusCache: { at: number; value: { available: boolean; detail: string }; permissionMode: 'default' | 'manual' } | null = null;
  private hooked = false;

  constructor(private readonly deps: ClaudeEngineDeps) {}

  private hook(): void {
    if (this.hooked) return;
    this.hooked = true;
    this.deps.attachModuleHooks?.(this);
  }

  private async probe(runtime: ClaudeRuntime, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    if (this.deps.probe) return this.deps.probe(runtime, args);
    return new Promise(resolve => {
      const child = this.spawnChild(runtime, args);
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(0, 65_536); });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 65_536); });
      child.stdin.end();
      child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  private spawnChild(runtime: ClaudeRuntime, args: string[]): ChildProcessWithoutNullStreams {
    const env: NodeJS.ProcessEnv = { ...(this.deps.env?.() ?? process.env), ...CLAUDE_CHAT_ENV };
    // A Claude Code session that launched the app must not make this one think it is nested.
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;
    const spawn = this.deps.spawn ?? ((bin, argv, options) => spawnProcess(bin, argv, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    return spawn(runtime.bin, [...runtime.argsPrefix, ...args], { cwd: runtime.cwd, env });
  }

  async status(): Promise<{ available: boolean; detail: string }> {
    this.hook();
    if (this.statusCache && Date.now() - this.statusCache.at < STATUS_CACHE_MS) return this.statusCache.value;
    try {
      let runtime: ClaudeRuntime;
      try { runtime = await this.deps.runtime(null); }
      catch (error) {
        const message = (error as Error).message;
        return { available: false, detail: /disabled/i.test(message) && !/Command/.test(message) ? 'Activate the Claude module in Settings > Modules' : message.slice(0, 200) };
      }
      const version = await this.probe(runtime, ['--version']);
      if (version.code !== 0) return { available: false, detail: `${LABEL} did not answer its version check${version.stderr ? `: ${stderrSummary(version.stderr)}` : ''}` };
      const versionText = (version.stdout.trim().split(/\r?\n/)[0] ?? '').slice(0, 80);
      const help = await this.probe(runtime, ['--help']);
      const permissionMode = permissionModeFromHelp(help.stdout);
      const auth = await this.probe(runtime, ['auth', 'status', '--json']);
      let value: { available: boolean; detail: string };
      let loggedIn: boolean | null = null;
      try { const parsed = record(JSON.parse(auth.stdout)); if (typeof parsed?.loggedIn === 'boolean') loggedIn = parsed.loggedIn; } catch { /* older CLI: not checked */ }
      if (loggedIn === false) value = { available: false, detail: `${LABEL} is not signed in. Run "claude auth login" in a terminal.` };
      else value = { available: true, detail: `${versionText || LABEL}${loggedIn ? ' · signed in' : ''}` };
      this.statusCache = { at: Date.now(), value, permissionMode };
      return value;
    } catch (error) {
      return { available: false, detail: clip((error as Error).message || 'Status unavailable', 200) };
    }
  }

  async models(query: EngineModelQuery): Promise<{ models: ApiChatModel[]; total: number }> {
    return claudeModelRows(this.reportedModels, query);
  }

  private async chat(sessionId: string): Promise<{ id: string; conversationId: string; projectId: string | null; title: string; record: ChatRecord }> {
    const session = await getSession(sessionId);
    if (!session || !isApiConversationId(session.conversationId)) throw new Error('This is not an API chat');
    const stored = await storedChatRecord(session.id);
    if (engineOf(stored) !== 'claude' || !stored) throw new Error('This chat runs on another engine');
    if (!stored.backendSessionId || !UUID.test(stored.backendSessionId)) throw new Error('This chat has no Claude Code session');
    return { id: session.id, conversationId: session.conversationId, projectId: session.projectId ?? null, title: session.title, record: stored };
  }

  async create(options: { projectId: string | null; model?: string }): Promise<ApiChatView> {
    this.hook();
    await this.recover();
    if (options.model !== undefined) modelId.parse(options.model);
    // The project must resolve to its canonical folder now; the process starts there.
    if (options.projectId) await this.deps.runtime(options.projectId);
    const summary = await createSession({ title: `New ${LABEL} chat`, titleSource: 'fallback', conversationId: `${API_CONVERSATION_PREFIX}${randomUUID()}` });
    if (options.projectId) await bindSessionProject(summary.id, options.projectId);
    await updateChatRecord(summary.id, () => ({ engine: 'claude', backendSessionId: randomUUID(), model: options.model ?? null, effort: null }));
    notifyChanged(summary.id);
    return this.view(summary.id);
  }

  async view(sessionId: string): Promise<ApiChatView> {
    const chat = await this.chat(sessionId);
    const turn = this.turns.get(chat.id);
    return {
      sessionId: chat.id, conversationId: chat.conversationId, engine: 'claude', model: chat.record.model, effort: chat.record.effort,
      running: !!turn || this.starting.has(chat.id), approval: chat.record.approval ?? 'ask', pending: turn?.gate.view() ?? null
    };
  }

  async setChatSettings(sessionId: string, patch: { model?: string; effort?: ApiChatEffort | null; approval?: 'ask' | 'auto' }): Promise<ApiChatView> {
    const chat = await this.chat(sessionId);
    await updateChatRecord(chat.id, current => ({
      ...(current ?? chat.record),
      ...(patch.model !== undefined ? { model: modelId.parse(patch.model) } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort === null ? null : z.enum(API_CHAT_EFFORTS).parse(patch.effort) } : {}),
      ...(patch.approval !== undefined ? { approval: z.enum(API_CHAT_APPROVAL_MODES).parse(patch.approval) } : {})
    }));
    // A running process keeps its model and effort; the next send restarts it with --resume.
    return this.view(chat.id);
  }

  async send(sessionId: string, question: string): Promise<{ turnId: string }> {
    this.hook();
    await this.recover();
    if (!question.trim() || question.length > MAX_CLAUDE_INPUT_CHARS) throw new Error('Write a message of up to 100,000 characters');
    const chat = await this.chat(sessionId);
    // Check and claim with no await between: one turn per chat.
    if (this.turns.has(chat.id) || this.starting.has(chat.id)) throw new Error('This chat is still answering');
    this.starting.add(chat.id);
    let turn: ClaudeTurn | null = null;
    try {
      const terminal = await this.deps.terminal?.state(chat.id) ?? 'none';
      if (terminal === 'attached') throw new Error('This chat is open in a Claude Code terminal. Disconnect that terminal view, then send again.');
      if (terminal === 'detached') {
        await this.deps.terminal!.end(chat.id);
        logInfo(`Claude Code chat ${chat.id}: ended its hand-over terminal before resuming in the app`);
      }
      const runtime = await this.deps.runtime(chat.projectId);
      const resume = (await readEvents(chat.id, { kinds: ['turn_start'] })).length > 0;
      const turnId = `api-${randomUUID()}`;
      const gate = new ApprovalGate(() => notifyChanged(chat.id));
      const created: ClaudeTurn = {
        sessionId: chat.id, turnId, gate, requests: new Map(), declined: new Set(), tools: new Map(), seen: new Set(), cancelled: new Set(), host: null, stopped: false,
        done: Promise.resolve('failed'),
        projector: new TurnProjector({
          engine: 'claude', conversationId: chat.conversationId, turnId, sink: (this.deps.sink ?? storeProjectorSink)(chat.id),
          approvals: { gate, answer: (requestId, outcome) => this.answerRequest(created, requestId, outcome) }
        })
      };
      turn = created;
      await created.projector.start(question);
      this.turns.set(chat.id, created);
      this.starting.delete(chat.id);
      created.done = this.run(created, chat, runtime, question, resume);
      return { turnId };
    } catch (error) {
      if (turn && this.turns.get(chat.id) !== turn) await turn.projector.finish('failed').catch(() => undefined);
      throw error;
    } finally {
      this.starting.delete(chat.id);
    }
  }

  /** Starts (or reuses) the chat's process and hands it the question; the turn ends on its `result`. */
  private async run(turn: ClaudeTurn, chat: { id: string; record: ChatRecord }, runtime: ClaudeRuntime, question: string, resume: boolean): Promise<TurnOutcome> {
    try {
      const host = await this.ensureHost(chat.id, chat.record, runtime, resume);
      if (turn.stopped) { this.scheduleIdle(chat.id, host); return await this.endTurn(turn, 'stopped'); }
      if (host.idleTimer) { clearTimeout(host.idleTimer); host.idleTimer = null; }
      host.turn = turn;
      turn.host = host;
      host.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: question }] }, parent_tool_use_id: null });
      return await new Promise<TurnOutcome>(resolve => { this.turnWaiters.set(turn, resolve); });
    } catch (error) {
      if (turn.stopped) return this.endTurn(turn, 'stopped');
      await turn.projector.apply({ type: 'error', message: `${LABEL} could not start: ${clip((error as Error).message, 600)}`, fatal: true });
      return this.endTurn(turn, 'failed');
    }
  }

  private readonly turnWaiters = new Map<ClaudeTurn, (outcome: TurnOutcome) => void>();

  private async endTurn(turn: ClaudeTurn, outcome: TurnOutcome, detail?: string): Promise<TurnOutcome> {
    const ended = await turn.projector.finish(outcome, detail).catch(error => {
      logWarn(`Claude Code chat ${turn.sessionId}: turn end not stored: ${(error as Error).message}`);
      return outcome;
    });
    turn.requests.clear();
    const host = turn.host;
    if (host?.turn === turn) {
      host.turn = null;
      if (host.alive && !host.draining) this.scheduleIdle(turn.sessionId, host);
    }
    if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId);
    notifyChanged(turn.sessionId);
    const waiter = this.turnWaiters.get(turn);
    this.turnWaiters.delete(turn);
    waiter?.(ended);
    return ended;
  }

  private scheduleIdle(sessionId: string, host: ClaudeHost): void {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = setTimeout(() => {
      if (this.hosts.get(sessionId) === host && !host.turn) void this.stopHost(sessionId);
    }, this.deps.idleMs ?? 10 * 60_000);
    host.idleTimer.unref?.();
  }

  private async permissionMode(runtime: ClaudeRuntime): Promise<'default' | 'manual'> {
    if (this.statusCache) return this.statusCache.permissionMode;
    const help = await this.probe(runtime, ['--help']).catch(() => ({ stdout: '' }));
    return permissionModeFromHelp(help.stdout);
  }

  private async ensureHost(sessionId: string, chat: ChatRecord, runtime: ClaudeRuntime, resume: boolean): Promise<ClaudeHost> {
    const launch: Launch = { cwd: runtime.cwd, backendId: chat.backendSessionId!, model: chat.model, effort: chat.effort };
    let host = this.hosts.get(sessionId);
    if (host?.alive && host.draining) {
      // The stopped turn's own result is still to come: wait for it briefly, else start over.
      const grace = new Promise<void>(resolve => setTimeout(resolve, this.deps.interruptGraceMs ?? 5_000));
      await Promise.race([host.draining.promise, grace]);
      if (host.draining) await this.stopHost(sessionId);
    }
    host = this.hosts.get(sessionId);
    if (host?.alive && JSON.stringify(host.launch) === JSON.stringify(launch)) return host;
    if (host) await this.stopHost(sessionId);
    const permissionMode = await this.permissionMode(runtime);
    // The store's history says whether Claude has this session; a mismatch (a first turn that
    // never reached the CLI, or a session the terminal started) is corrected once from stderr.
    let mode: 'start' | 'resume' = resume ? 'resume' : 'start';
    for (let attempt = 0; ; attempt++) {
      const started = await this.startHost(sessionId, runtime, launch, claudeArgs({ sessionId: launch.backendId, mode, permissionMode, model: launch.model, effort: launch.effort }));
      if (started.alive) return started;
      const reason = started.stderr;
      if (attempt === 0 && !started.sawStdout) {
        if (mode === 'resume' && /no conversation found/i.test(reason)) { mode = 'start'; continue; }
        if (mode === 'start' && /already in use/i.test(reason)) { mode = 'resume'; continue; }
      }
      this.noteAuthFailure(reason);
      throw new Error(`exited${started.exitCode !== null ? ` with code ${started.exitCode}` : ''}${reason ? `: ${stderrSummary(reason)}` : ''}`);
    }
  }

  /** Spawns the process and completes the SDK's `initialize` handshake (or sees it exit). */
  private async startHost(sessionId: string, runtime: ClaudeRuntime, launch: Launch, args: string[]): Promise<ClaudeHost> {
    const host = new ClaudeHost(launch, this.spawnChild(runtime, args), (from, message) => this.onMessage(sessionId, from, message));
    this.hosts.set(sessionId, host);
    void host.exited.then(() => this.onExit(sessionId, host));
    // The SDK opens every streaming session with `initialize`; a CLI that does not know it
    // answers an error, which is fine. Exiting first means the session could not start.
    await Promise.race([
      host.control({ subtype: 'initialize', hooks: null }, this.deps.initializeTimeoutMs ?? 20_000).catch(() => undefined),
      host.exited
    ]);
    return host;
  }

  private async stopHost(sessionId: string): Promise<void> {
    const host = this.hosts.get(sessionId);
    if (!host) return;
    await host.kill();
    if (this.hosts.get(sessionId) === host) this.hosts.delete(sessionId);
  }

  private onExit(sessionId: string, host: ClaudeHost): void {
    if (this.hosts.get(sessionId) === host) this.hosts.delete(sessionId);
    const turn = host.turn;
    host.turn = null;
    if (!turn || turn.projector.ended) return;
    this.noteAuthFailure(host.stderr);
    void (async () => {
      if (turn.stopped) { await this.endTurn(turn, 'stopped'); return; }
      const reason = stderrSummary(host.stderr);
      await turn.projector.apply({ type: 'error', fatal: true,
        message: `${LABEL} exited during the turn${host.exitCode !== null ? ` (code ${host.exitCode})` : ''}${reason ? `: ${reason}` : ''}` });
      await this.endTurn(turn, 'failed');
    })();
  }

  private noteAuthFailure(reason: string): void {
    if (AUTH_FAILURE.test(reason)) this.statusCache = null;
  }

  // ------------------------------------------------------------ CLI → app

  private onMessage(sessionId: string, host: ClaudeHost, message: Record<string, unknown>): void {
    if (message.type === 'control_request') { this.onControlRequest(host, message); return; }
    if (message.type === 'control_cancel_request') {
      const requestId = text(message.request_id);
      const turn = host.turn;
      if (!requestId || !turn) return;
      if (turn.requests.delete(requestId)) void turn.projector.apply({ type: 'approval_resolved', requestId });
      else turn.cancelled.add(requestId);
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') { void this.onInit(sessionId, host, message); return; }
    if (host.draining) {
      if (message.type === 'result') { const draining = host.draining; host.draining = null; draining.resolve(); if (!host.turn) this.scheduleIdle(sessionId, host); }
      return;
    }
    const turn = host.turn;
    if (!turn || turn.projector.ended) return;
    // A sub-agent's own traffic stays inside its Task row.
    if (message.parent_tool_use_id) return;
    for (const event of this.translate(turn, message)) void turn.projector.apply(event);
    if (message.type === 'result') {
      const failed = message.is_error === true || (message.subtype !== undefined && message.subtype !== 'success');
      if (failed) this.noteAuthFailure(`${text(message.result) ?? ''} ${Array.isArray(message.errors) ? message.errors.join(' ') : ''}`);
      void this.endTurn(turn, failed ? 'failed' : 'completed');
    }
  }

  private async onInit(sessionId: string, host: ClaudeHost, message: Record<string, unknown>): Promise<void> {
    const model = text(message.model);
    if (model && modelId.safeParse(model).success) this.reportedModels.add(model);
    if (message.permissionMode === 'bypassPermissions') {
      // Never run a chat whose permission checks are off, however the CLI got there.
      logWarn(`Claude Code chat ${sessionId}: the CLI reported bypassPermissions; stopping it`);
      const turn = host.turn;
      if (turn) await turn.projector.apply({ type: 'error', fatal: true, message: `${LABEL} started with permission checks bypassed, so Chat Marks stopped it.` });
      await host.kill();
      return;
    }
    const reported = text(message.session_id);
    if (reported && UUID.test(reported) && reported !== host.launch.backendId) {
      // A CLI that resumed under a new id: the chat follows the session it now has.
      await updateChatRecord(sessionId, current => current ? { ...current, backendSessionId: reported } : current).catch(() => undefined);
    }
  }

  private onControlRequest(host: ClaudeHost, message: Record<string, unknown>): void {
    const requestId = text(message.request_id);
    const request = record(message.request);
    if (!requestId) return;
    if (request?.subtype !== 'can_use_tool') { host.respondError(requestId, `Unsupported control request: ${String(request?.subtype)}`); return; }
    const turn = host.turn;
    const tool = text(request.tool_name) ?? '';
    const input = record(request.input) ?? {};
    const toolUseId = text(request.tool_use_id) ?? requestId;
    if (!turn || turn.projector.ended || host.draining) {
      host.respond(requestId, { behavior: 'deny', message: 'No turn of this chat is running.' });
      return;
    }
    void (async () => {
      const shown = structuredClone(input);
      const mode = (await storedChatRecord(turn.sessionId))?.approval ?? 'ask';
      if (turn.cancelled.has(requestId) || !host.alive) return;
      try {
        if (turn.projector.ended) { host.respond(requestId, { behavior: 'deny', message: 'The user stopped this turn.' }); return; }
        // The chat's own mode, chosen by the user: run edits and commands without asking.
        if (mode === 'auto') { host.respond(requestId, { behavior: 'allow', updatedInput: shown }); return; }
      } catch { return; }
      const kind = claudeToolKind(tool);
      const { summary, files } = claudeApprovalSummary(tool, shown);
      const action = { tool_use_id: toolUseId, input: shown };
      turn.requests.set(requestId, { toolUseId, tool, input: shown, hash: argsHash(tool, action), suggestions: request.permission_suggestions });
      await turn.projector.apply({ type: 'approval_requested', requestId, toolId: toolUseId, kind, tool: claudeToolName(tool), summary, files, action });
    })();
  }

  /** The user's answer (or the turn's end) back to the exact CLI request; nothing for a request the CLI withdrew. */
  private answerRequest(turn: ClaudeTurn, requestId: string, outcome: ApprovalOutcome): void {
    const pending = turn.requests.get(requestId);
    if (!pending) return;
    turn.requests.delete(requestId);
    const host = turn.host;
    const body = claudeApprovalDecision(outcome, pending.input);
    if (!body || !host?.alive) return;
    if (argsHash(pending.tool, { tool_use_id: pending.toolUseId, input: pending.input }) !== pending.hash) {
      host.respond(requestId, { behavior: 'deny', message: 'The action changed after it was shown and was not run.' });
      return;
    }
    if (body.behavior === 'deny') turn.declined.add(pending.toolUseId);
    const updates = outcome === 'always' ? sessionPermissionUpdates(pending.suggestions) : [];
    try { host.respond(requestId, updates.length ? { ...body, updatedPermissions: updates } : body); }
    catch (error) { logWarn(`Claude Code chat ${turn.sessionId}: approval not delivered: ${(error as Error).message}`); }
  }

  /** One stream-json message as engine events. */
  private translate(turn: ClaudeTurn, message: Record<string, unknown>): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (message.type === 'stream_event') {
      const event = record(message.event);
      const delta = record(event?.delta);
      if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') events.push({ type: 'text_delta', delta: delta.text });
      return events;
    }
    if (message.type === 'assistant') {
      const body = record(message.message);
      const content = Array.isArray(body?.content) ? body.content : [];
      const messageId = text(body?.id) ?? '';
      content.forEach((raw, index) => {
        const block = record(raw);
        if (!block) return;
        if (block.type === 'text' && typeof block.text === 'string') {
          const key = `text|${messageId}|${index}|${block.text}`;
          if (turn.seen.has(key)) return;
          turn.seen.add(key);
          events.push({ type: 'text_final', text: block.text });
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          if (turn.seen.has(`tool|${block.id}`)) return;
          turn.seen.add(`tool|${block.id}`);
          const name = text(block.name) ?? 'tool';
          const input = record(block.input) ?? {};
          turn.tools.set(block.id, { name, input });
          const kind = claudeToolKind(name);
          events.push({
            type: 'tool_started', toolId: block.id, kind, name: claudeToolName(name), input,
            ...(kind === 'command' && typeof input.command === 'string' ? { command: input.command } : {}),
            ...(kind === 'read' ? { path: text(input.file_path) ?? text(input.path) ?? text(input.pattern) ?? name } : {}),
            ...(kind === 'patch' ? { files: claudeToolFiles(name, input) } : {})
          });
        }
      });
      return events;
    }
    if (message.type === 'user') {
      const body = record(message.message);
      const content = Array.isArray(body?.content) ? body.content : [];
      const result = record(message.tool_use_result);
      for (const raw of content) {
        const block = record(raw);
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const toolId = block.tool_use_id;
        const output = toolResultText(block.content);
        const declined = turn.declined.has(toolId);
        const status = declined ? 'declined' : block.is_error === true ? 'failed' : 'ok';
        const tool = turn.tools.get(toolId);
        const files = tool && claudeToolKind(tool.name) === 'patch' ? claudeToolFiles(tool.name, tool.input, result) : undefined;
        events.push({
          type: 'tool_finished', toolId, status, output: declined ? '' : output,
          ...(files ? { files } : {}),
          ...(status === 'failed' ? { error: clip(output.split('\n', 1)[0] ?? '', 300) } : {})
        });
      }
      return events;
    }
    if (message.type === 'result') {
      const usage = record(message.usage);
      if (usage) {
        const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
        events.push({
          type: 'usage', inputTokens: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
          outputTokens: count(usage.output_tokens), cachedInputTokens: count(usage.cache_read_input_tokens)
        });
      }
      const failed = message.is_error === true || (message.subtype !== undefined && message.subtype !== 'success');
      if (failed) {
        const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === 'string') : [];
        const reason = clip(redactSecretText((text(message.result) || errors.join(' · ') || String(message.subtype ?? 'error')).trim()), 600);
        events.push({ type: 'error', fatal: true, message: `${LABEL} reported a failed turn: ${reason}` });
      }
    }
    return events;
  }

  // ------------------------------------------------------------ user actions

  async stop(sessionId: string): Promise<boolean> {
    const chat = await this.chat(sessionId);
    const turn = this.turns.get(chat.id);
    if (!turn) return false;
    turn.stopped = true;
    const host = turn.host;
    if (host?.alive && host.turn === turn) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      host.draining = { resolve, promise };
      host.control({ subtype: 'interrupt' }).catch(() => undefined);
      // A CLI that does not settle the interrupted turn in time is ended; the next send resumes.
      const timer = setTimeout(() => { if (host.draining?.promise === promise) void this.stopHost(chat.id); }, this.deps.interruptGraceMs ?? 5_000);
      timer.unref?.();
      void promise.then(() => clearTimeout(timer));
    }
    // Pending approvals answer `stop` (a deny the CLI may already have withdrawn) and the turn ends now.
    await this.endTurn(turn, 'stopped');
    return true;
  }

  async approve(sessionId: string, approvalId: string, decision: 'approve' | 'deny' | 'always'): Promise<ApiChatView> {
    const chat = await this.chat(sessionId);
    const turn = this.turns.get(chat.id);
    if (!turn?.gate.has(approvalId) || !turn.gate.answer(approvalId, decision)) throw new Error('This approval is no longer pending');
    return this.view(chat.id);
  }

  /** Startup: no process survives the app; the engine-neutral recovery closes open turns `interrupted`. */
  async recover(): Promise<void> {
    this.hook();
    await recoverApiChats();
  }

  terminal(chat: EngineChatRef): EngineTerminal | null {
    return chat.backendSessionId && UUID.test(chat.backendSessionId) ? { argv: ['--resume', chat.backendSessionId], mode: 'handover' } : null;
  }

  /**
   * Hand-over: stops this chat's host (refused while a turn runs) and opens `claude --resume <id>`
   * (or `--session-id` before the first turn) in the Claude module's tmux terminal for this chat.
   */
  async openTerminal(sessionId: string): Promise<{ cliSessionId: string }> {
    this.hook();
    const chat = await this.chat(sessionId);
    if (!this.deps.terminal) throw new Error('Terminals are not available');
    await this.handOver(chat.id);
    const started = (await readEvents(chat.id, { kinds: ['turn_start'] })).length > 0;
    const args = [started ? '--resume' : '--session-id', chat.record.backendSessionId!];
    const session = await this.deps.terminal.open({ sessionId: chat.id, projectId: chat.projectId, args, title: `${LABEL} · ${clip(chat.title, 80)}` });
    return { cliSessionId: session.id };
  }

  /** Before a terminal resumes the chat's session: the app's host must be idle, and then it ends. */
  async handOver(sessionId: string): Promise<void> {
    if (this.turns.has(sessionId) || this.starting.has(sessionId)) {
      throw new Error('Claude Code is still answering in this chat. Stop it or wait, then open the terminal.');
    }
    await this.stopHost(sessionId);
  }

  /** The Claude module was stopped or disabled: every host ends, and a running turn with it. */
  async stopAll(): Promise<void> {
    for (const turn of [...this.turns.values()]) turn.stopped = true;
    await Promise.all([...this.hosts.keys()].map(id => this.stopHost(id)));
    for (const turn of [...this.turns.values()]) await this.endTurn(turn, 'stopped');
  }

  /** Tests: the running turn's completion. */
  turnDone(sessionId: string): Promise<TurnOutcome> | null {
    return this.turns.get(sessionId)?.done ?? null;
  }

  async resetForTests(): Promise<void> {
    await this.stopAll();
    this.reportedModels.clear();
    this.statusCache = null;
  }
}

/** The production wiring: cli-modules' binary resolution, its tmux terminals and its Stop hook. */
async function cliModules(): Promise<typeof import('../cli-modules.js')> {
  return import('../cli-modules.js');
}

export function createClaudeEngine(deps: Partial<ClaudeEngineDeps> = {}): ClaudeEngine {
  return new ClaudeEngine({
    runtime: async projectId => (await cliModules()).cliChatRuntime('claude', projectId),
    terminal: {
      state: async chat => (await cliModules()).cliEngineTerminalState(chat),
      end: async chat => (await cliModules()).cliEndEngineTerminal(chat),
      open: async chat => (await cliModules()).cliEngineTerminal('claude', chat)
    },
    attachModuleHooks: engine => {
      void cliModules().then(modules => {
        modules.registerCliEngineOpenHook('claude', async session => { if (session.engineChat) await engine.handOver(session.engineChat); });
        modules.registerCliModuleStopHook(id => { if (id === 'claude') void engine.stopAll(); });
      }).catch(error => logWarn(`Claude Code chats: module hooks not registered: ${(error as Error).message}`));
    },
    // PATH normalized for a GUI-launched app, like the module terminals.
    env: () => normalizeEnvironment() as NodeJS.ProcessEnv,
    ...deps
  });
}

export const claudeEngine = createClaudeEngine();
