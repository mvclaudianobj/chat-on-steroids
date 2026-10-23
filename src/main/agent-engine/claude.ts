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
import { currentMarksSystemPrompt } from '../marks-system-prompt.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AGENT_ENGINE_LABELS, AGENT_ENGINE_ROUTES, DEFAULT_AGENT_ENGINE_ROUTE, ENGINE_TERMINAL_OPEN_ELSEWHERE, ENGINE_TERMINAL_OPEN_IN_APP, type AgentEngineRoute
} from '../../shared/agent-engine.js';
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
import { claudeBrainMcpArgs } from '../brain/engine-mcp.js';
import { engineOf, routeOf, storedChatRecord, updateChatRecord, type ChatRecord } from './ledger.js';
import {
  chatRoutes, CLAUDE_DIRECT_SETTINGS, CLAUDE_FLAG_SETTINGS, claudeRouteSettings, detectClaudeRouter, refreshRouterAvailability, registerRoutedTurnProbe,
  ROUTER_LABEL, ROUTER_UNAVAILABLE_TEXT, routerUsable, type ClaudeRouterDetection
} from './router.js';
import { storeProjectorSink, TurnProjector, type ProjectorSink } from './projector.js';
import type { AgentEngine, EngineChatRef, EngineCreateOptions, EngineEvent, EngineFileChange, EngineModelQuery, EngineTerminal, EngineToolKind } from './types.js';

const LABEL = AGENT_ENGINE_LABELS.claude;
export const MAX_CLAUDE_INPUT_CHARS = 100_000;
const MAX_LINE_CHARS = 8_000_000;
const STDERR_TAIL_CHARS = 4_000;
const STATUS_CACHE_MS = 60_000;
const CATALOG_CACHE_MS = 5 * 60_000;

/**
 * Flag settings (router.ts): the highest-priority settings layer. User, project and local settings
 * still load (the user's auth helper, env, MCP servers and their own deny/ask rules keep working,
 * and the hand-over terminal resumes the same session with the same settings), but this layer
 * keeps the session from ever entering bypass mode and keeps the CLI's own permission default.
 * A direct chat with a Claude Code Router detected gets `CLAUDE_DIRECT_SETTINGS` instead, which
 * also unsets the router's variables and key helper for this process only.
 */
export { CLAUDE_DIRECT_SETTINGS, CLAUDE_FLAG_SETTINGS };
const FLAG_SETTINGS: ReadonlySet<string> = new Set([CLAUDE_FLAG_SETTINGS, CLAUDE_DIRECT_SETTINGS]);
export const CLAUDE_DIRECT_NOT_SIGNED_IN = 'Claude Code has no account of its own for direct chats. Run "claude auth login" in a terminal, or choose Via Claude Code Router.';
export const CLAUDE_ROUTE_WHILE_RUNNING = 'Wait for the answer to finish before changing the route.';
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
  /** `attached`: only the app's own terminal view; `external`: a tmux client outside the app too. */
  state(chatSessionId: string): Promise<'none' | 'detached' | 'attached' | 'external'>;
  /** Detaches the app's views and ends the terminal's tmux session (the TUI with it). */
  end(chatSessionId: string): Promise<void>;
  open(chat: { sessionId: string; projectId: string | null; args: string[]; title: string }): Promise<{ id: string }>;
}

/** One model of the CLI's own catalog, as its `initialize` answer lists it (2.1.306). */
export interface ClaudeCatalogModel {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportedEffortLevels?: string[];
}

/** What a process's `initialize` answer says without any model request: its catalog and its account. */
export interface ClaudeInitInfo {
  models: ClaudeCatalogModel[];
  /** `tokenSource` / `apiKeySource` `none` (or absent) means the process has no credential. */
  signedIn: boolean | null;
}

export interface ClaudeEngineDeps {
  /** Binary, prefix and canonical cwd: cli-modules' resolution (module enabled, Command on, WSL on Windows). */
  runtime(projectId: string | null): Promise<ClaudeRuntime>;
  spawn?: (bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  /** Runs a short read-only command (`--version`, `--help`, `auth status --json`). */
  probe?: (runtime: ClaudeRuntime, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  terminal?: ClaudeTerminalDeps;
  /** Which Claude Code Router setup the user's files have (router.ts); read on every use. */
  routing?(): ClaudeRouterDetection;
  /** The `initialize` answer of a process with these flag settings (no prompt is sent). */
  initInfo?(runtime: ClaudeRuntime, settings: string): Promise<ClaudeInitInfo | null>;
  /** Registers the open/stop hooks with the module terminals once; optional in tests. */
  attachModuleHooks?(engine: ClaudeEngine): void;
  sink?(sessionId: string): ProjectorSink;
  env?(): NodeJS.ProcessEnv;
  initializeTimeoutMs?: number;
  interruptGraceMs?: number;
  idleMs?: number;
}

const CLAUDE_EFFORTS: ReadonlySet<string> = new Set(API_CHAT_EFFORTS);

/** `opus (claude-opus-5-5)`: the alias with the concrete model it resolves to now. */
export function claudeModelLabel(model: ClaudeCatalogModel): string | undefined {
  const resolved = model.resolvedModel?.trim();
  if (resolved && resolved !== model.value) return `${model.value} (${resolved})`.slice(0, 200);
  const shown = model.displayName?.trim();
  return shown && shown !== model.value ? shown.slice(0, 200) : undefined;
}

/**
 * What the renderer's model list shows for Claude: the CLI's own catalog of the chat's route, each
 * alias with the model it resolves to (`opus (claude-opus-5-5)`), then models a `system/init`
 * reported that it lacks. Without a catalog (the probe failed), the bare aliases.
 */
export function claudeModelRows(catalog: readonly ClaudeCatalogModel[] | null, reported: Iterable<string>, query: EngineModelQuery): { models: ApiChatModel[]; total: number } {
  if (query.modality && query.modality !== 'chat') return { models: [], total: 0 };
  const rows: ApiChatModel[] = [];
  const row = (id: string, label?: string, efforts?: string[]): ApiChatModel => ({
    id, ownedBy: 'anthropic', modality: 'chat', favorite: false, recent: false, availability: null,
    ...(label ? { label } : {}), ...(efforts?.length ? { efforts } : {})
  });
  const known = new Set<string>();
  // `default` is the chat without a model of its own; it is not a choice of the list.
  for (const model of catalog ?? CLAUDE_MODEL_ALIASES.map((value): ClaudeCatalogModel => ({ value }))) {
    if (model.value === 'default' || !modelId.safeParse(model.value).success || known.has(model.value)) continue;
    known.add(model.value);
    if (model.resolvedModel) known.add(model.resolvedModel);
    rows.push(row(model.value, claudeModelLabel(model), model.supportedEffortLevels?.filter(level => CLAUDE_EFFORTS.has(level))));
  }
  for (const id of reported) if (!known.has(id)) { known.add(id); rows.push(row(id)); }
  const needle = query.query?.trim().toLowerCase() ?? '';
  const matched = rows.filter(item => !needle || item.id.toLowerCase().includes(needle) || !!item.label?.toLowerCase().includes(needle));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  return { total: matched.length, models: matched.slice(offset, offset + limit) };
}

/** The catalog and account of an `initialize` answer; anything malformed is left out. */
export function claudeInitInfo(response: unknown): ClaudeInitInfo {
  const body = record(response);
  const models: ClaudeCatalogModel[] = [];
  for (const item of Array.isArray(body?.models) ? body.models.slice(0, 100) : []) {
    const entry = record(item);
    const value = typeof entry?.value === 'string' ? entry.value : null;
    if (!entry || !value || value.length > 200) continue;
    const str = (key: string): string | undefined => typeof entry[key] === 'string' ? (entry[key] as string).slice(0, 300) : undefined;
    const levels = Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter((level): level is string => typeof level === 'string') : undefined;
    models.push({
      value, ...(str('resolvedModel') ? { resolvedModel: str('resolvedModel') } : {}), ...(str('displayName') ? { displayName: str('displayName') } : {}),
      ...(str('description') ? { description: str('description') } : {}), ...(levels ? { supportedEffortLevels: levels } : {})
    });
  }
  const account = record(body?.account);
  const source = (key: string): string | null => typeof account?.[key] === 'string' ? account[key] as string : null;
  const signedIn = !account ? null : [source('tokenSource'), source('apiKeySource')].some(value => !!value && value !== 'none');
  return { models, signedIn };
}

/** The exact argv after the binary. `mode` decides between starting and resuming the session. */
export function claudeArgs(options: {
  sessionId: string; mode: 'start' | 'resume'; permissionMode: 'default' | 'manual'; model?: string | null; effort?: ApiChatEffort | null;
  /** The route's flag settings (router.ts `claudeRouteSettings`); default the hardening alone. */
  settings?: string;
  systemPrompt?: string;
}): string[] {
  if (!UUID.test(options.sessionId)) throw new Error('Invalid Claude session id');
  const settings = options.settings ?? CLAUDE_FLAG_SETTINGS;
  if (!FLAG_SETTINGS.has(settings)) throw new Error('Invalid Claude flag settings');
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', options.permissionMode, '--settings', settings,
    '--disallowedTools', CLAUDE_DEFERRED_TOOLS.join(','),
    ...(options.mode === 'start' && options.systemPrompt ? ['--append-system-prompt', options.systemPrompt] : []),
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

/** Claude Code's sub-agent tool: `Agent`, named `Task` by earlier releases. */
const isClaudeAgentTool = (name: string | undefined): boolean => name === 'Agent' || name === 'Task';

/**
 * The report a sub-agent handed back, as its Agent tool row shows it. Claude Code frames the
 * report for its own model: a "[Subagent hand-back] ... The report follows:" preamble, every report
 * line indented, then the sub-agent's `agentId: ...` line and a `<usage>...</usage>` block. The
 * row shows the report alone, de-indented. Display only: the CLI already holds its own tool result,
 * and nothing here is sent back to it. Text without that frame is returned as it is.
 */
export function claudeAgentReport(output: string): string {
  const lines = output.replace(/\r\n?/g, '\n').split('\n');
  let changed = false;
  // The trailer, from the end: blank lines, the usage block and the sub-agent's id line.
  for (;;) {
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    const last = lines.at(-1)?.trim() ?? '';
    if (last.endsWith('</usage>')) {
      const start = lines.findLastIndex(line => line.trimStart().startsWith('<usage>'));
      if (start < 0) break;
      lines.splice(start);
    } else if (/^agentId: \S+/.test(last)) lines.pop();
    else break;
    changed = true;
  }
  // The preamble: its first line opens the text, and it ends at "The report follows:".
  const first = lines.findIndex(line => line.trim());
  if (first >= 0 && lines[first]!.trimStart().startsWith('[Subagent hand-back]')) {
    const end = lines.findIndex((line, index) => index >= first && line.includes('The report follows:'));
    if (end >= 0 && end - first < 20) {
      const rest = lines[end]!.slice(lines[end]!.indexOf('The report follows:') + 'The report follows:'.length).trim();
      lines.splice(0, end + 1, ...(rest ? [rest] : []));
      // The frame indents every report line; the report's own indentation stays.
      const indent = Math.min(...lines.filter(line => line.trim()).map(line => /^[ \t]*/.exec(line)![0].length));
      if (Number.isFinite(indent) && indent > 0) for (let i = 0; i < lines.length; i++) lines[i] = lines[i]!.slice(Math.min(indent, /^[ \t]*/.exec(lines[i]!)![0].length));
      changed = true;
    }
  }
  if (!changed) return output;
  while (lines.length && !lines[0]!.trim()) lines.shift();
  return lines.join('\n');
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
  /** The turn runs through Claude Code Router (the CCR module restarts the router only when none does). */
  routed: boolean;
}

interface Launch { cwd: string; backendId: string; model: string | null; effort: ApiChatEffort | null; settings: string; brain?: true }

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
  private statusCache: { at: number; value: { available: boolean; detail: string; router?: boolean }; permissionMode: 'default' | 'manual'; unavailable: string | null } | null = null;
  /** `initialize` answers by flag settings (one per route). */
  private readonly catalogs = new Map<string, { at: number; info: ClaudeInitInfo | null }>();
  private hooked = false;

  constructor(private readonly deps: ClaudeEngineDeps) {
    registerRoutedTurnProbe(() => [...this.turns.values()].some(turn => turn.routed));
  }

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

  private routing(): ClaudeRouterDetection {
    try { return (this.deps.routing ?? detectClaudeRouter)(); } catch { return { detected: false, model: null }; }
  }

  /** The flag settings of a chat on that route, as the user's files are now. */
  private settingsFor(route: AgentEngineRoute, routing = this.routing()): string {
    return claudeRouteSettings(route, routing);
  }

  /** A process's `initialize` answer: no prompt, no session file, no MCP server; killed once it answers. */
  private async initInfo(runtime: ClaudeRuntime, settings: string, refresh = false): Promise<ClaudeInitInfo | null> {
    const cached = this.catalogs.get(settings);
    if (!refresh && cached && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.info;
    const info = await (this.deps.initInfo ? this.deps.initInfo(runtime, settings) : this.probeInit(runtime, settings)).catch(() => null);
    this.catalogs.set(settings, { at: Date.now(), info });
    return info;
  }

  private probeInit(runtime: ClaudeRuntime, settings: string): Promise<ClaudeInitInfo | null> {
    return new Promise(resolve => {
      const child = this.spawnChild(runtime, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--strict-mcp-config', '--settings', settings]);
      let buffer = '';
      let settled = false;
      const done = (info: ClaudeInitInfo | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.stdin.end(); } catch { /* gone */ }
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        resolve(info);
      };
      const timer = setTimeout(() => done(null), 20_000);
      child.stdin.on('error', () => undefined);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffer = (buffer + chunk).slice(-MAX_LINE_CHARS);
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          let message: Record<string, unknown> | null = null;
          try { message = record(JSON.parse(line)); } catch { continue; }
          const response = record(message?.response);
          if (message?.type !== 'control_response' || response?.request_id !== 'marks-catalog') continue;
          done(response.subtype === 'success' ? claudeInitInfo(response.response) : null);
        }
      });
      child.stderr.on('data', () => undefined);
      child.on('error', () => done(null));
      child.on('close', () => done(null));
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'marks-catalog', request: { subtype: 'initialize', hooks: null } })}\n`);
    });
  }

  async status(): Promise<{ available: boolean; detail: string; router?: boolean }> {
    this.hook();
    await refreshRouterAvailability();
    const unavailable = this.routing().unavailable ?? null;
    if (this.statusCache && Date.now() - this.statusCache.at < STATUS_CACHE_MS && this.statusCache.unavailable === unavailable) return this.statusCache.value;
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
      let value: { available: boolean; detail: string; router?: boolean };
      let loggedIn: boolean | null = null;
      try { const parsed = record(JSON.parse(auth.stdout)); if (typeof parsed?.loggedIn === 'boolean') loggedIn = parsed.loggedIn; } catch { /* older CLI: not checked */ }
      const routing = this.routing();
      // Configured but not installed or not answering: router chats run on the CLI account meanwhile.
      const routerNote = routing.detected && routing.unavailable ? ` · ${ROUTER_UNAVAILABLE_TEXT[routing.unavailable]}` : '';
      if (routing.detected) {
        // `auth status` reads the user's settings, so it answers for the router route; the
        // direct route's own account is what a process with the direct settings reports.
        const direct = await this.initInfo(runtime, CLAUDE_DIRECT_SETTINGS);
        const directSignedIn = direct?.signedIn ?? null;
        const usable = routerUsable(routing);
        const available = directSignedIn !== false || (usable && loggedIn !== false);
        value = {
          available, router: usable,
          detail: available
            ? `${versionText || LABEL} · direct: ${directSignedIn === false ? 'not signed in' : directSignedIn ? 'signed in' : 'not checked'} · ${usable ? `${ROUTER_LABEL} detected` : routerNote.slice(3)}`
            : `${LABEL} is not signed in. Run "claude auth login" in a terminal.${routerNote}`
        };
      } else if (loggedIn === false) value = { available: false, detail: `${LABEL} is not signed in. Run "claude auth login" in a terminal.`, router: false };
      else value = { available: true, detail: `${versionText || LABEL}${loggedIn ? ' · signed in' : ''}`, router: false };
      this.statusCache = { at: Date.now(), value, permissionMode, unavailable };
      return value;
    } catch (error) {
      return { available: false, detail: clip((error as Error).message || 'Status unavailable', 200) };
    }
  }

  /** The CLI's own catalog of that route (its `initialize` answer), with each alias's concrete model. */
  async models(query: EngineModelQuery): Promise<{ models: ApiChatModel[]; total: number }> {
    this.hook();
    if (query.modality && query.modality !== 'chat') return { models: [], total: 0 };
    let catalog: ClaudeCatalogModel[] | null = null;
    try {
      const runtime = await this.deps.runtime(null);
      catalog = (await this.initInfo(runtime, this.settingsFor(query.route ?? DEFAULT_AGENT_ENGINE_ROUTE), query.refresh === true))?.models ?? null;
    } catch { /* module off: the aliases alone */ }
    return claudeModelRows(catalog?.length ? catalog : null, this.reportedModels, query);
  }

  private async chat(sessionId: string): Promise<{ id: string; conversationId: string; projectId: string | null; title: string; record: ChatRecord }> {
    const session = await getSession(sessionId);
    if (!session || !isApiConversationId(session.conversationId)) throw new Error('This is not an API chat');
    const stored = await storedChatRecord(session.id);
    if (engineOf(stored) !== 'claude' || !stored) throw new Error('This chat runs on another engine');
    if (!stored.backendSessionId || !UUID.test(stored.backendSessionId)) throw new Error('This chat has no Claude Code session');
    return { id: session.id, conversationId: session.conversationId, projectId: session.projectId ?? null, title: session.title, record: stored };
  }

  async create(options: EngineCreateOptions): Promise<ApiChatView> {
    this.hook();
    await this.recover();
    if (options.model !== undefined) modelId.parse(options.model);
    if (options.route === 'router') this.refuseUnavailableRouter(await this.freshRouting());
    // The project must resolve to its canonical folder now; the process starts there.
    if (options.projectId) await this.deps.runtime(options.projectId);
    const summary = await createSession({ title: `New ${LABEL} chat`, titleSource: 'fallback', conversationId: `${API_CONVERSATION_PREFIX}${randomUUID()}` });
    if (options.projectId) await bindSessionProject(summary.id, options.projectId);
    const route = z.enum(AGENT_ENGINE_ROUTES).parse(options.route ?? DEFAULT_AGENT_ENGINE_ROUTE);
    await updateChatRecord(summary.id, () => ({ engine: 'claude', backendSessionId: randomUUID(), model: options.model ?? null, effort: null, route }));
    notifyChanged(summary.id);
    return this.view(summary.id);
  }

  /** The routing as the user's files and the router program are now. */
  private async freshRouting(): Promise<ClaudeRouterDetection> {
    await refreshRouterAvailability();
    return this.routing();
  }

  /** Choosing the router route (a new chat, a route change) needs a router that answers. */
  private refuseUnavailableRouter(routing: ClaudeRouterDetection): void {
    if (routing.detected && routing.unavailable) throw new Error(ROUTER_UNAVAILABLE_TEXT[routing.unavailable]);
  }

  async view(sessionId: string): Promise<ApiChatView> {
    const routing = await this.freshRouting();
    const chat = await this.chat(sessionId);
    const turn = this.turns.get(chat.id);
    return {
      sessionId: chat.id, conversationId: chat.conversationId, engine: 'claude', model: chat.record.model, effort: chat.record.effort,
      running: !!turn || this.starting.has(chat.id), approval: chat.record.approval ?? 'ask', pending: turn?.gate.view() ?? null,
      route: routeOf(chat.record), ...chatRoutes(routeOf(chat.record), routing)
    };
  }

  async setChatSettings(sessionId: string, patch: { model?: string; effort?: ApiChatEffort | null; approval?: 'ask' | 'auto'; route?: AgentEngineRoute }): Promise<ApiChatView> {
    const chat = await this.chat(sessionId);
    const route = patch.route === undefined ? undefined : z.enum(AGENT_ENGINE_ROUTES).parse(patch.route);
    // The session itself moves with the chat (the same session file, resumed with the other
    // route's settings by the next send); only a running answer must finish first.
    if (route !== undefined && route !== routeOf(chat.record) && (this.turns.has(chat.id) || this.starting.has(chat.id))) throw new Error(CLAUDE_ROUTE_WHILE_RUNNING);
    if (route === 'router' && route !== routeOf(chat.record)) this.refuseUnavailableRouter(await this.freshRouting());
    // The other route lists other models: a model it lacks gives way to the CLI's default.
    let model: null | undefined;
    if (route !== undefined && patch.model === undefined && chat.record.model && this.settingsFor(route) !== this.settingsFor(routeOf(chat.record))) {
      const listed = await this.models({ route, limit: 200 }).catch(() => null);
      if (listed && !listed.models.some(row => row.id === chat.record.model)) model = null;
    }
    await updateChatRecord(chat.id, current => ({
      ...(current ?? chat.record),
      ...(patch.model !== undefined ? { model: modelId.parse(patch.model) } : model !== undefined ? { model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort === null ? null : z.enum(API_CHAT_EFFORTS).parse(patch.effort) } : {}),
      ...(patch.approval !== undefined ? { approval: z.enum(API_CHAT_APPROVAL_MODES).parse(patch.approval) } : {}),
      ...(route !== undefined ? { route } : {})
    }));
    // A running process keeps its model, effort and route; the next send restarts it with --resume.
    return this.view(chat.id);
  }

  /**
   * With the hand-over terminal attached, a send is refused with ENGINE_TERMINAL_OPEN_IN_APP (or
   * _ELSEWHERE) unless `takeBackTerminal`: the user's explicit "Close the terminal and continue
   * here". Then that terminal ends (Claude Code saved the session) and the host resumes it.
   */
  async send(sessionId: string, question: string, options: { takeBackTerminal?: boolean } = {}): Promise<{ turnId: string }> {
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
      if ((terminal === 'attached' || terminal === 'external') && !options.takeBackTerminal) {
        throw new Error(terminal === 'external' ? ENGINE_TERMINAL_OPEN_ELSEWHERE : ENGINE_TERMINAL_OPEN_IN_APP);
      }
      if (terminal !== 'none') {
        await this.deps.terminal!.end(chat.id);
        logInfo(`Claude Code chat ${chat.id}: ended its ${terminal} hand-over terminal before resuming in the app`);
      }
      const runtime = await this.deps.runtime(chat.projectId);
      // A router chat whose router is configured but not installed or not answering falls back
      // to the CLI's own account (the same session resumes there); its view says why.
      const routing = await this.freshRouting();
      const settings = this.settingsFor(routeOf(chat.record), routing);
      const routed = routeOf(chat.record) === 'router' && routerUsable(routing);
      // A direct chat with a router detected runs on the CLI's own login: none, no turn.
      if (settings === CLAUDE_DIRECT_SETTINGS && (await this.initInfo(runtime, settings))?.signedIn === false
        // A login since the cached answer counts: asked again before refusing.
        && (await this.initInfo(runtime, settings, true))?.signedIn === false) {
        throw new Error(routeOf(chat.record) === 'router' && routing.unavailable ? `${ROUTER_UNAVAILABLE_TEXT[routing.unavailable]} ${CLAUDE_DIRECT_NOT_SIGNED_IN}` : CLAUDE_DIRECT_NOT_SIGNED_IN);
      }
      const resume = (await readEvents(chat.id, { kinds: ['turn_start'] })).length > 0;
      const turnId = `api-${randomUUID()}`;
      const gate = new ApprovalGate(() => notifyChanged(chat.id));
      const created: ClaudeTurn = {
        sessionId: chat.id, turnId, gate, requests: new Map(), declined: new Set(), tools: new Map(), seen: new Set(), cancelled: new Set(), host: null, stopped: false, routed,
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
    // Chat Marks: Brain memory tools (H1c); turning the switch on or off restarts an idle host.
    const brainArgs = await claudeBrainMcpArgs(sessionId, runtime);
    const launch: Launch = { cwd: runtime.cwd, backendId: chat.backendSessionId!, model: chat.model, effort: chat.effort, settings: this.settingsFor(routeOf(chat)), ...(brainArgs.length ? { brain: true as const } : {}) };
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
      const started = await this.startHost(sessionId, runtime, launch, [...claudeArgs({ sessionId: launch.backendId, mode, permissionMode, model: launch.model, effort: launch.effort, settings: launch.settings, systemPrompt: currentMarksSystemPrompt('claude') }), ...brainArgs]);
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
    if (AUTH_FAILURE.test(reason)) { this.statusCache = null; this.catalogs.clear(); }
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
        const tool = turn.tools.get(toolId);
        const shown = toolResultText(block.content);
        // The row shows a sub-agent's report without Claude Code's framing (display only).
        const output = isClaudeAgentTool(tool?.name) ? claudeAgentReport(shown) : shown;
        const declined = turn.declined.has(toolId);
        const status = declined ? 'declined' : block.is_error === true ? 'failed' : 'ok';
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
    if (!chat.backendSessionId || !UUID.test(chat.backendSessionId)) return null;
    return { argv: [...this.terminalSettings(chat.route ?? 'router'), '--resume', chat.backendSessionId], mode: 'handover' };
  }

  /** The hand-over TUI runs on the chat's route too: a direct chat's terminal gets the direct settings. */
  private terminalSettings(route: AgentEngineRoute): string[] {
    const settings = this.settingsFor(route);
    return settings === CLAUDE_DIRECT_SETTINGS ? ['--settings', settings] : [];
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
    const args = [...this.terminalSettings(routeOf(chat.record)), started ? '--resume' : '--session-id', chat.record.backendSessionId!];
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
  /** Only idle CLI hosts may be replaced after a module update. */
  hasActiveTurns(): boolean { return this.turns.size > 0 || this.starting.size > 0; }
  async restartIdleHosts(): Promise<boolean> {
    if (this.hasActiveTurns()) return false;
    await Promise.all([...this.hosts.keys()].map(id => this.stopHost(id)));
    return true;
  }

  /** Tests: the running turn's completion. */
  turnDone(sessionId: string): Promise<TurnOutcome> | null {
    return this.turns.get(sessionId)?.done ?? null;
  }

  async resetForTests(): Promise<void> {
    await this.stopAll();
    this.reportedModels.clear();
    this.statusCache = null;
    this.catalogs.clear();
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
