/**
 * The Codex app-server protocol as Chat Marks uses it (codex-cli 0.163, an experimental API):
 * the exact argv of every Codex process, the version gate, the thread/turn parameters, and the
 * translation of server notifications and approval requests into engine-neutral `EngineEvent`s.
 * Pure functions only, so the shapes are tested without a Codex binary.
 *
 * Safety: no argv or parameter here ever asks for a bypass. The approval policy is `untrusted`
 * (Ask) or `on-request` (Auto), never `never`; the sandbox is `workspace-write` rooted at the
 * chat's canonical project folder, never `danger-full-access`; approvals go to the user
 * (`approvalsReviewer: "user"`), never to Codex's own auto reviewer. The server is also started
 * with safe `-c` overrides, so a user `config.toml` (or profile) that sets
 * `approval_policy = "never"`, a dangerous `sandbox_mode` or an automatic reviewer cannot apply to
 * anything this app runs, even a request that would fall back to the config defaults. Codex
 * 0.163 refuses `approval_policy = "untrusted"` as configuration ("no longer supported") and
 * exits, while each thread and turn still accepts and keeps `approvalPolicy: "untrusted"`; the
 * server's fallback is therefore `on-request`, the strictest value it still starts with.
 */
import type { ApiChatApprovalMode, ApiChatEffort, ApiChatModel } from '../../shared/api-chat.js';
import type { TurnOutcome } from '../../shared/session.js';
import type { EngineEvent, EngineFileChange, EngineToolKind } from './types.js';

/** The Codex release this adapter was written and tested against. */
export const CODEX_TESTED_VERSION = { major: 0, minor: 163, patch: 0 } as const;
export const CODEX_TESTED_LABEL = `${CODEX_TESTED_VERSION.major}.${CODEX_TESTED_VERSION.minor}.${CODEX_TESTED_VERSION.patch}`;

/** Flags and values that must never reach a Codex process started by Chat Marks. */
export const CODEX_FORBIDDEN_ARGS = [
  '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', 'danger-full-access', 'never',
  '--ask-for-approval', '-a', '--sandbox', '-s'
] as const;

/** The `-c` overrides the app-server starts with; every thread and turn sets its own policy. */
export const CODEX_SAFE_OVERRIDES = [
  'approval_policy="on-request"',
  'sandbox_mode="workspace-write"',
  'approvals_reviewer="user"'
] as const;

/**
 * `routeOverrides` (router.ts `codexRouteOverrides`): the direct route's `-c` values when a Claude
 * Code Router is detected (`model_provider="openai"`, Codex's own model catalog), else none.
 * `extra`: Chat Marks' own `-c` pairs (the Brain MCP server, H1c), after the safe overrides.
 */
export function codexServerArgv(socket: string, routeOverrides: readonly string[] = [], extra: readonly string[] = []): string[] {
  for (const value of routeOverrides) {
    if (!/^(model_provider="openai"|model_catalog_json="[^"\u0000-\u001f]{1,1000}")$/.test(value)) throw new Error('Invalid Codex route override');
  }
  return ['app-server', ...[...CODEX_SAFE_OVERRIDES, ...routeOverrides].flatMap(value => ['-c', value]), ...extra, '--listen', `unix://${socket}`];
}

/** Our own JSON-RPC client: `proxy` carries stdio lines to the server's control socket. */
export function codexProxyArgv(socket: string): string[] {
  return ['app-server', 'proxy', '--sock', socket];
}

/** The live terminal: Codex's own TUI attached to the same server and thread. */
export function codexTerminalArgv(threadId: string, socket: string): string[] {
  return ['resume', threadId, '--remote', `unix://${socket}`];
}

export function codexVersionArgv(): string[] {
  return ['--version'];
}

export type CodexVersionCheck =
  | { ok: true; version: string; warning: string | null }
  | { ok: false; version: string | null; detail: string };

/**
 * `codex --version` → whether this adapter may drive it. Another major, or an older minor than the
 * tested one, is refused (the protocol is experimental and older servers lack fields we send); a
 * newer minor runs with a warning in the engine's status line.
 */
export function checkCodexVersion(output: string | null): CodexVersionCheck {
  const match = output?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { ok: false, version: null, detail: 'Codex did not report its version' };
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  if (major !== CODEX_TESTED_VERSION.major || minor < CODEX_TESTED_VERSION.minor) {
    return { ok: false, version, detail: `Codex ${version} is not supported; Chat Marks supports Codex ${CODEX_TESTED_LABEL}` };
  }
  return {
    ok: true, version,
    warning: minor > CODEX_TESTED_VERSION.minor ? `Codex ${version} is newer than the tested ${CODEX_TESTED_LABEL}` : null
  };
}

export const codexApprovalPolicy = (mode: ApiChatApprovalMode): 'untrusted' | 'on-request' => mode === 'auto' ? 'on-request' : 'untrusted';

export const CODEX_CLIENT_INFO = { name: 'chat_marks', title: 'Chat Marks', version: '1' } as const;

export function codexInitializeParams(version: string): Record<string, unknown> {
  return { clientInfo: { ...CODEX_CLIENT_INFO, version }, capabilities: { experimentalApi: false, requestAttestation: false } };
}

export function codexThreadStartParams(input: { model: string | null; cwd: string; approval: ApiChatApprovalMode }): Record<string, unknown> {
  return {
    ...(input.model ? { model: input.model } : {}),
    cwd: input.cwd,
    approvalPolicy: codexApprovalPolicy(input.approval),
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    ephemeral: false
  };
}

export function codexThreadResumeParams(input: { threadId: string; cwd: string; approval: ApiChatApprovalMode }): Record<string, unknown> {
  return {
    threadId: input.threadId, cwd: input.cwd, approvalPolicy: codexApprovalPolicy(input.approval),
    approvalsReviewer: 'user', sandbox: 'workspace-write'
  };
}

export function codexSandboxPolicy(cwd: string): Record<string, unknown> {
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export function codexTurnStartParams(input: {
  threadId: string; text: string; model: string | null; effort: string | null; cwd: string; approval: ApiChatApprovalMode;
}): Record<string, unknown> {
  return {
    threadId: input.threadId,
    input: [{ type: 'text', text: input.text, text_elements: [] }],
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    cwd: input.cwd,
    approvalPolicy: codexApprovalPolicy(input.approval),
    approvalsReviewer: 'user',
    sandboxPolicy: codexSandboxPolicy(input.cwd)
  };
}

/** The chat's effort when that model lists it; otherwise Codex keeps the model's default. */
export function codexEffort(effort: ApiChatEffort | null, model: Pick<ApiChatModel, 'efforts'> | undefined): string | null {
  if (!effort) return null;
  return !model?.efforts || model.efforts.includes(effort) ? effort : null;
}

interface CodexModel { id?: unknown; model?: unknown; displayName?: unknown; hidden?: unknown; isDefault?: unknown; supportedReasoningEfforts?: unknown; defaultReasoningEffort?: unknown }

/** One `model/list` entry as the chat's model row; Codex's own reasoning efforts are kept as listed. */
export function codexModelRow(value: unknown): (ApiChatModel & { isDefault: boolean }) | null {
  const model = value as CodexModel;
  const slug = typeof model?.model === 'string' && model.model ? model.model : typeof model?.id === 'string' ? model.id : '';
  if (!slug || slug.length > 200 || model.hidden === true) return null;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map(option => (option as { reasoningEffort?: unknown })?.reasoningEffort)
      .filter((effort): effort is string => typeof effort === 'string' && effort.length <= 40).slice(0, 12)
    : [];
  return {
    id: slug, ownedBy: 'openai', modality: 'chat', favorite: false, recent: false, availability: null,
    ...(typeof model.displayName === 'string' && model.displayName ? { label: model.displayName.slice(0, 120) } : {}),
    efforts,
    ...(typeof model.defaultReasoningEffort === 'string' ? { defaultEffort: model.defaultReasoningEffort.slice(0, 40) } : {}),
    isDefault: model.isDefault === true
  };
}

// ---------------------------------------------------------------- items → events

interface FileUpdate { path?: unknown; kind?: { type?: unknown; move_path?: unknown }; diff?: unknown }

export function codexFileChanges(changes: unknown): EngineFileChange[] {
  if (!Array.isArray(changes)) return [];
  return changes.slice(0, 200).flatMap((change: FileUpdate): EngineFileChange[] => {
    if (typeof change?.path !== 'string') return [];
    const type = change.kind?.type;
    const movePath = typeof change.kind?.move_path === 'string' ? change.kind.move_path : undefined;
    const kind: EngineFileChange['kind'] = type === 'add' ? 'add' : type === 'delete' ? 'delete' : movePath ? 'move' : 'update';
    return [{ path: change.path, kind, ...(typeof change.diff === 'string' && change.diff ? { diff: change.diff } : {}), ...(movePath ? { movePath } : {}) }];
  });
}

const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/** What an item is as a tool row; null for items that are not tools (messages, reasoning, plans). */
export function codexToolKind(item: { type?: unknown }): { kind: EngineToolKind; name: string } | null {
  const value = item as Record<string, unknown>;
  switch (item?.type) {
    case 'commandExecution': return { kind: 'command', name: 'commandExecution' };
    case 'fileChange': return { kind: 'patch', name: 'fileChange' };
    case 'mcpToolCall': return { kind: 'mcp', name: `${str(value.server) ?? 'mcp'}/${str(value.tool) ?? 'tool'}` };
    case 'dynamicToolCall': return { kind: 'other', name: str(value.tool) ?? 'tool' };
    case 'webSearch': return { kind: 'other', name: 'web_search' };
    case 'imageView': return { kind: 'read', name: 'imageView' };
    default: return null;
  }
}

/** `item/started`: the tool opens (text items open nothing). */
export function codexItemStarted(item: Record<string, unknown>): EngineEvent[] {
  const tool = codexToolKind(item);
  const id = str(item.id);
  if (!tool || !id) return [];
  switch (item.type) {
    case 'commandExecution':
      return [{ type: 'tool_started', toolId: id, kind: 'command', name: tool.name, command: str(item.command) ?? '', ...(str(item.cwd) ? { cwd: str(item.cwd)! } : {}) }];
    case 'fileChange':
      return [{ type: 'tool_started', toolId: id, kind: 'patch', name: tool.name, files: codexFileChanges(item.changes) }];
    case 'mcpToolCall':
      return [{ type: 'tool_started', toolId: id, kind: 'mcp', name: tool.name, input: item.arguments ?? null }];
    case 'webSearch':
      return [{ type: 'tool_started', toolId: id, kind: 'other', name: tool.name, input: { query: str(item.query) ?? '' } }];
    case 'imageView':
      return [{ type: 'tool_started', toolId: id, kind: 'read', name: tool.name, ...(str(item.path) ? { path: str(item.path)! } : {}) }];
    default:
      return [{ type: 'tool_started', toolId: id, kind: tool.kind, name: tool.name, input: item.arguments ?? null }];
  }
}

const toolStatus = (status: unknown): 'ok' | 'failed' | 'declined' =>
  status === 'completed' ? 'ok' : status === 'declined' ? 'declined' : 'failed';

function mcpOutput(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : JSON.stringify(part)).join('\n').slice(0, 200_000);
}

/** `item/completed`: the tool finishes, or the answer step settles with its whole text. */
export function codexItemCompleted(item: Record<string, unknown>): EngineEvent[] {
  const id = str(item.id);
  if (!id) return [];
  switch (item.type) {
    case 'agentMessage':
      return [{ type: 'text_final', ...(typeof item.text === 'string' ? { text: item.text } : {}) }];
    case 'commandExecution':
      return [{
        type: 'tool_finished', toolId: id, status: toolStatus(item.status),
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
        ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {})
      }];
    case 'fileChange':
      return [{ type: 'tool_finished', toolId: id, status: toolStatus(item.status), files: codexFileChanges(item.changes) }];
    case 'mcpToolCall': {
      const error = str((item.error as { message?: unknown } | null)?.message);
      return [{ type: 'tool_finished', toolId: id, status: toolStatus(item.status), output: mcpOutput(item.result), ...(error ? { error } : {}) }];
    }
    case 'dynamicToolCall':
      return [{ type: 'tool_finished', toolId: id, status: item.success === false ? 'failed' : toolStatus(item.status) }];
    case 'webSearch': case 'imageView':
      return [{ type: 'tool_finished', toolId: id, status: 'ok' }];
    default:
      return [];
  }
}

export function codexTurnOutcome(status: unknown, stopped: boolean): TurnOutcome {
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return stopped ? 'stopped' : 'interrupted';
  return 'failed';
}

// ---------------------------------------------------------------- approvals

export const CODEX_APPROVAL_METHODS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'] as const;
export type CodexApprovalMethod = typeof CODEX_APPROVAL_METHODS[number];
/** Pre-v2 approval requests: answered with an explicit denial, never approved. */
export const CODEX_LEGACY_APPROVAL_METHODS = ['execCommandApproval', 'applyPatchApproval'] as const;
export const CODEX_LEGACY_DENIAL = { decision: { denied: { rejection: 'Chat Marks answers only item/*/requestApproval requests; this legacy request was declined.' } } } as const;

export interface CodexApprovalBinding {
  /** The JSON-RPC id of the server's request, exactly as sent. */
  rpcId: string | number;
  method: CodexApprovalMethod;
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId: string | null;
  /** The action shown, hashed by the ApprovalGate into the approval the user answers. */
  action: Record<string, unknown>;
  tool: string;
  kind: EngineToolKind;
  summary: string;
  files: string[];
}

/** The key the engine and the gate share for one server request (string and number ids differ). */
export const codexRequestKey = (id: string | number): string => `${typeof id === 'number' ? 'n' : 's'}:${id}`;

/**
 * An approval request → its exact binding: JSON-RPC id, thread, turn, item, Codex's approval id
 * and the command (with cwd) or the file changes the item announced. Null when it is malformed.
 */
export function codexApprovalBinding(
  rpcId: string | number, method: CodexApprovalMethod, params: unknown, knownChanges: EngineFileChange[] | undefined
): CodexApprovalBinding | null {
  const value = params as Record<string, unknown>;
  const threadId = str(value?.threadId), turnId = str(value?.turnId), itemId = str(value?.itemId);
  if (!threadId || !turnId || !itemId) return null;
  const approvalId = str(value.approvalId) ?? null;
  const reason = str(value.reason)?.slice(0, 300);
  if (method === 'item/commandExecution/requestApproval') {
    const command = str(value.command) ?? '';
    const cwd = str(value.cwd) ?? '';
    const action = { method, rpcId, threadId, turnId, itemId, approvalId, kind: str(value.kind) ?? 'command', command, cwd };
    return {
      rpcId, method, threadId, turnId, itemId, approvalId, action, tool: 'exec_command', kind: 'command',
      summary: `${command || 'Run a command'}${cwd ? `\nin ${cwd}` : ''}${reason ? `\n${reason}` : ''}`, files: []
    };
  }
  const changes = (knownChanges ?? []).map(change => ({ path: change.path, kind: change.kind, movePath: change.movePath ?? null, diff: change.diff ?? null }));
  const grantRoot = str(value.grantRoot) ?? null;
  const action = { method, rpcId, threadId, turnId, itemId, approvalId, grantRoot, changes };
  const files = changes.map(change => `${change.kind} ${change.movePath ?? change.path}`);
  return {
    rpcId, method, threadId, turnId, itemId, approvalId, action, tool: 'apply_patch', kind: 'patch',
    summary: `${files.length === 0 ? 'Apply file changes' : files.length === 1 ? 'Edit 1 file' : `Edit ${files.length} files`}${grantRoot ? `\nand allow writes under ${grantRoot}` : ''}${reason ? `\n${reason}` : ''}`,
    files
  };
}
