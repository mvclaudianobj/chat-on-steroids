/**
 * A CLI engine's own tool activity as a timeline row. These tools ran inside the CLI, not
 * through the MCP kernel, so nothing here dispatches, correlates or records through the
 * recorder: the row is one `tool_call` event appended by `appendEvent` with `source: 'app'`,
 * the turn's `turnId`, `attribution`/`attributionMethod: 'engine'` and `engine` naming who
 * ran it. It reuses the renderer's existing tool row (icon by summary kind, the shell/diff tag
 * by tool name, args and result panels, edit cards from `changes`).
 *
 * Request-id placement (chronology `requestOwner`, store request turns) only reads
 * `source: 'mcp'` rows, so an engine row is placed by its turnId alone. It is written once,
 * when the tool finishes (or when the turn ends without its finish), so it never needs a
 * revision and the session's tool count stays exact.
 */
import { createHash } from 'node:crypto';
import { redactCredentialText } from '../redaction.js';
import type { AgentEngineId } from '../../shared/agent-engine.js';
import type { ActivitySummary, FileChange, NewSessionEvent, StoredText, ToolCallRecord, ToolOutcome } from '../../shared/session.js';
import { canonicalJson } from './approval.js';
import type { EngineFileChange, EngineToolKind } from './types.js';

export const MAX_ENGINE_TOOL_ARGS_CHARS = 8_000;
export const MAX_ENGINE_TOOL_RESULT_CHARS = 8_000;

export interface EngineToolActivity {
  engine: AgentEngineId;
  conversationId: string;
  turnId: string;
  toolId: string;
  kind: EngineToolKind;
  name: string;
  input?: unknown;
  command?: string;
  cwd?: string;
  path?: string;
  files: EngineFileChange[];
  status: 'ok' | 'failed' | 'declined' | 'unfinished';
  exitCode?: number | null;
  output: string;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

/** The tool names the renderer already knows for each kind; MCP and other tools keep the engine's name. */
export function engineToolName(kind: EngineToolKind, name: string): string {
  if (kind === 'command') return 'exec_command';
  if (kind === 'patch') return 'apply_patch';
  if (kind === 'read') return 'read';
  return kind === 'mcp' ? `mcp:${name}`.slice(0, 120) : name.slice(0, 120) || 'tool';
}

/** Stable per session, chat turn and engine tool id: a replayed finish cannot add a second row. */
export function engineToolCallId(engine: AgentEngineId, turnId: string, toolId: string): string {
  return `engine-${createHash('sha256').update(`${engine}\n${turnId}\n${toolId}`).digest('hex').slice(0, 32)}`;
}

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}…` : text;
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Added and removed lines of a unified diff; null when there is none to count. */
export function diffLineCounts(diff: string | undefined): { added: number; removed: number } | null {
  if (!diff) return null;
  let added = 0, removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

function fileChanges(files: readonly EngineFileChange[]): FileChange[] {
  return files.slice(0, 64).map(file => {
    const counts = diffLineCounts(file.diff);
    // The CLI applied the change itself: there is no before/after snapshot to review.
    return { path: file.movePath ?? file.path, added: counts?.added ?? 0, removed: counts?.removed ?? 0, approximate: !counts, reviewUnavailable: 'not-kept' as const };
  });
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)}s`;
}

function outcomeOf(activity: EngineToolActivity): ToolOutcome {
  if (activity.status === 'declined') return 'tool_rejected';
  if (activity.status === 'unfinished') return 'tool_execution_error';
  if (activity.kind === 'command' && typeof activity.exitCode === 'number' && activity.exitCode !== 0) return 'process_exit_nonzero';
  return activity.status === 'failed' ? 'tool_execution_error' : 'ok';
}

export function engineToolSummary(activity: EngineToolActivity): ActivitySummary {
  const duration = activity.finishedAt - activity.startedAt;
  const files = activity.files;
  let summary: ActivitySummary;
  if (activity.kind === 'command') {
    const command = clip((activity.command ?? activity.name).replace(/\s+/g, ' ').trim(), 120);
    summary = { kind: 'run', title: `Ran ${command}`, tone: 'neutral', ...(activity.cwd ? { detail: `in ${clip(activity.cwd, 120)}` } : {}) };
    if (typeof activity.exitCode === 'number' && activity.exitCode !== 0) Object.assign(summary, { metric: `✕ exit ${activity.exitCode}`, tone: 'bad' });
    else if (activity.status === 'ok') Object.assign(summary, { metric: `✓ ${seconds(duration)}`, tone: 'good' });
  } else if (activity.kind === 'patch') {
    const only = files.length === 1 ? files[0]! : null;
    const verb = only?.kind === 'add' ? 'Created' : only?.kind === 'delete' ? 'Deleted' : only?.kind === 'move' ? 'Moved' : 'Edited';
    const kind: ActivitySummary['kind'] = only?.kind === 'add' ? 'create' : only?.kind === 'delete' ? 'delete' : only?.kind === 'move' ? 'move' : 'edit';
    const named = only ? baseName(only.path) : files.length ? `${files.length} files` : 'files';
    const counts = fileChanges(files).reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 });
    summary = { kind, title: `${verb} ${clip(named, 120)}`, tone: 'neutral', ...(files.some(file => file.diff) ? { metric: `+${counts.added} −${counts.removed}` } : {}) };
  } else if (activity.kind === 'read') {
    summary = { kind: 'read', title: `Read ${clip(baseName(activity.path ?? activity.name), 120)}`, tone: 'neutral' };
  } else if (activity.kind === 'mcp') {
    summary = { kind: 'other', title: `Called ${clip(activity.name, 120)}`, tone: 'neutral' };
  } else {
    summary = { kind: 'other', title: clip(activity.name || 'Tool', 120), tone: 'neutral' };
  }
  if (activity.status === 'declined') return { ...summary, title: `Declined: ${summary.title}`, metric: 'declined', tone: 'warn' };
  if (activity.status === 'unfinished') return { ...summary, metric: 'did not finish', tone: 'warn' };
  if (activity.status === 'failed' && summary.tone !== 'bad') {
    return { ...summary, metric: '✕ failed', tone: 'bad', ...(activity.error && !summary.detail ? { detail: clip(activity.error.split('\n', 1)[0] ?? '', 120) } : {}) };
  }
  return summary;
}

/** The exact input the engine reported, as the row's arguments (credentials redacted). */
export function engineToolArgs(activity: EngineToolActivity): string {
  const shown = activity.input !== undefined ? activity.input
    : { ...(activity.command !== undefined ? { command: activity.command } : {}), ...(activity.cwd ? { cwd: activity.cwd } : {}),
        ...(activity.path ? { path: activity.path } : {}), ...(activity.files.length ? { files: activity.files.map(file => ({ path: file.path, kind: file.kind })) } : {}) };
  return redactCredentialText(canonicalJson(shown));
}

export function engineToolResult(activity: EngineToolActivity): string {
  const diffs = activity.kind === 'patch' ? activity.files.map(file => file.diff).filter((diff): diff is string => !!diff) : [];
  const parts = [activity.output, ...diffs, activity.error ? `Error: ${activity.error}` : ''].filter(Boolean);
  if (activity.status === 'unfinished') parts.push('The turn ended before this tool reported its result.');
  if (activity.status === 'declined' && !parts.length) parts.push('The user declined this action. It was not run.');
  return redactCredentialText(parts.join('\n') || (activity.status === 'ok' ? 'Done.' : 'The tool failed without a message.'));
}

/** The `tool_call` event for one engine tool; `stored` bounds text the way the recorder does. */
export async function engineToolEvent(
  activity: EngineToolActivity,
  stored: (text: string, cap: number) => Promise<StoredText>
): Promise<NewSessionEvent> {
  const changes = activity.kind === 'patch' && activity.status === 'ok' ? fileChanges(activity.files) : [];
  const call: ToolCallRecord = {
    callId: engineToolCallId(activity.engine, activity.turnId, activity.toolId),
    tool: engineToolName(activity.kind, activity.name),
    engine: activity.engine,
    attribution: 'engine',
    attributionMethod: 'engine',
    requestId: null,
    conversationId: activity.conversationId,
    args: await stored(engineToolArgs(activity), MAX_ENGINE_TOOL_ARGS_CHARS),
    result: await stored(engineToolResult(activity), MAX_ENGINE_TOOL_RESULT_CHARS),
    outcome: outcomeOf(activity),
    durationMs: Math.max(0, activity.finishedAt - activity.startedAt),
    summary: engineToolSummary(activity),
    ...(changes.length ? { changes } : {})
  };
  return { time: activity.startedAt, source: 'app', kind: 'tool_call', turnId: activity.turnId, call };
}
