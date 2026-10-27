/**
 * Chat Marks Brain: what `/remember` needs to know about the chat it is called in.
 *
 * - `brainChatOf` names the chat's kind, engine and project scope, so every chat-made memory carries
 *   `{ source: 'chat', sessionId, engine }` and `project:<id>` (global without a project).
 * - `brainChatTools` says whether that chat's model can call `memory_save` right now, and which
 *   switch is missing when it cannot; the renderer sends `/remember`'s instruction only when it can.
 * - `brainLatestAnswer` is the model-free fallback: the chat's newest finished answer, bounded.
 */
import { isApiConversationId } from '../../shared/api-chat.js';
import type { AgentEngineId } from '../../shared/agent-engine.js';
import { completedDilText } from '../../shared/dil-tables.js';
import { latestAnswer, messageAnswerEntries, turnAnswerEntries, completedTurnIds } from '../../shared/markdown-export.js';
import { providerEntitiesAsMarkdown } from '../../shared/content-reference.js';
import { getBrainSettings } from './settings.js';

export type BrainChatKind = 'chatgpt' | 'api' | 'engine';
export interface BrainChat { sessionId: string; kind: BrainChatKind; engine: 'chatgpt' | AgentEngineId; scope: string; title: string }
export type BrainChatToolsReason = 'chatgpt-off' | 'chatgpt-refresh' | 'api-off' | 'engines-off' | 'engine-unsupported' | 'read-only';
export type BrainChatTools = { available: true; kind: BrainChatKind; engine: string } | { available: false; kind: BrainChatKind; engine: string; reason: BrainChatToolsReason };

/** The longest answer `/remember`'s fallback keeps: the memory limit is 4,000 characters, and redaction markers can be longer than what they replace. */
export const LATEST_ANSWER_MAX = 3600;

export interface BrainChatDeps {
  session(sessionId: string): Promise<{ id: string; title?: string; conversationId?: string | null; projectId?: string } | null>;
  engine(sessionId: string): Promise<AgentEngineId | null>;
  /** Whether the Core/API registrar offers `memory_save` (edit capability, not read-only). */
  canWrite(): Promise<boolean>;
  /** Core plugin refresh state as ChatGPT last confirmed it (`current` when the tools are visible). */
  chatgptRefresh(): Promise<string>;
  platform: NodeJS.Platform;
}

const defaultDeps: BrainChatDeps = {
  session: async sessionId => (await import('../session/store.js')).getSession(sessionId),
  engine: async sessionId => (await (await import('../agent-engine/ledger.js')).storedChatRecord(sessionId))?.engine ?? null,
  canWrite: async () => {
    const { liveToolContext } = await import('../api-chat/tools.js');
    const ctx = liveToolContext();
    return !ctx.readOnly && ctx.caps.edit === true;
  },
  chatgptRefresh: async () => {
    try { return (await (await import('../plugin-refresh.js')).pluginRefreshStatuses()).core?.state ?? 'unpublished'; }
    catch { return 'unknown'; }
  },
  platform: process.platform
};
let deps: BrainChatDeps = defaultDeps;
/** Tests only. */
export function setBrainChatDeps(overrides: Partial<BrainChatDeps> | null): void { deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps; }

/** The memory scope of a chat: its local project, or global. */
export const brainProjectScope = (projectId: string | null | undefined): string =>
  projectId && /^[A-Za-z0-9-]{1,120}$/.test(projectId) ? `project:${projectId}` : 'global';

export async function brainChatOf(sessionId: string): Promise<BrainChat | null> {
  const session = await deps.session(sessionId).catch(() => null);
  if (!session) return null;
  const scope = brainProjectScope(session.projectId);
  const title = (session.title ?? '').slice(0, 160);
  if (!isApiConversationId(session.conversationId)) return { sessionId: session.id, kind: 'chatgpt', engine: 'chatgpt', scope, title };
  const engine = await deps.engine(session.id).catch(() => null) ?? 'cliproxy';
  return { sessionId: session.id, kind: engine === 'cliproxy' ? 'api' : 'engine', engine, scope, title };
}

/** Whether this chat's model has `memory_save` now; otherwise the switch to turn on. */
export async function brainChatTools(chat: BrainChat): Promise<BrainChatTools> {
  const settings = getBrainSettings();
  const base = { kind: chat.kind, engine: chat.engine };
  const missing = (reason: BrainChatToolsReason): BrainChatTools => ({ available: false, ...base, reason });
  if (chat.kind === 'engine') {
    // H1c wires Claude Code, Codex and OpenCode on Linux and macOS; Windows/WSL use another loopback.
    if (chat.engine === 'markscode' || deps.platform === 'win32') return missing('engine-unsupported');
    return settings.enginesEnabled ? { available: true, ...base } : missing('engines-off');
  }
  if (chat.kind === 'api' && !settings.apiChatTools) return missing('api-off');
  if (chat.kind === 'chatgpt' && !settings.chatgptTools) return missing('chatgpt-off');
  if (!await deps.canWrite()) return missing('read-only');
  if (chat.kind === 'chatgpt' && await deps.chatgptRefresh() !== 'current') return missing('chatgpt-refresh');
  return { available: true, ...base };
}

/** The chat's newest finished answer as Markdown, cut to the memory limit; null when there is none. */
export async function brainLatestAnswer(sessionId: string): Promise<string | null> {
  const { readEvents, readOverflowText } = await import('../session/store.js');
  const events = await readEvents(sessionId);
  const named = latestAnswer(events);
  if (!named) return null;
  if (!named.messageId && (!named.turnId || !completedTurnIds(events).has(named.turnId))) return null;
  const entries = named.messageId ? messageAnswerEntries(events, named.messageId) : turnAnswerEntries(events, named.turnId!);
  const parts: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (total > LATEST_ANSWER_MAX) break;
    const stored = entry.stored;
    const text = !stored.truncated || !stored.assetId ? stored.text : (await readOverflowText(sessionId, stored.assetId)) ?? stored.text;
    const markdown = providerEntitiesAsMarkdown(completedDilText(text, entry.html)).trim();
    if (markdown) { parts.push(markdown); total += markdown.length + 2; }
  }
  const answer = parts.join('\n\n').trim();
  if (!answer) return null;
  return answer.length > LATEST_ANSWER_MAX ? `${answer.slice(0, LATEST_ANSWER_MAX - 1).trimEnd()}…` : answer;
}
