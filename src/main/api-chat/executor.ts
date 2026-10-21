/**
 * Runs Chat Marks API chats: text turns of a local session whose model answers through the
 * OpenAI-compatible endpoint instead of a ChatGPT tab.
 *
 * The session store owns the history (messages and turn boundaries, written with the same
 * writers the recorder uses); this module owns only what the store has no place for, in the
 * Marks durable `marks-api-chat-sessions`: each chat's model and effort, and the turn it has
 * open. A turn open in that ledger at startup was cut by the restart and is closed
 * `interrupted`: nothing resumes a generation this process did not start.
 *
 * Text only: no tools are offered to the model yet.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurable, writeDurableNow } from '../durable.js';
import { logInfo, logWarn } from '../logger.js';
import { projectWorkspace } from '../projects.js';
import { notifyChanged } from '../session/recorder.js';
import {
  appendEvent, bindSessionProject, createSession, getSession, MAX_USER_MESSAGE_CHARS, readEvents, upsertMessageEvent,
  writeOverflowText
} from '../session/store.js';
import { API_CHAT_EFFORTS, API_CONVERSATION_PREFIX, isApiConversationId, type ApiChatEffort, type ApiChatView } from '../../shared/api-chat.js';
import type { SessionEvent, StoredText, TurnOutcome } from '../../shared/session.js';
import { ApiChatHttpError, streamCompletion, type ApiChatMessage } from './client.js';
import { apiChatKey, apiChatSettings, noteKeyRequired, noteModelAvailability, noteRecentModel } from './settings.js';

export const API_CHAT_SESSIONS_STATE = 'marks-api-chat-sessions';
export const MAX_API_CHAT_INPUT_CHARS = 100_000;
const MAX_ASSISTANT_CHARS = 256_000;
const CONTEXT_MESSAGES = 60;
const CONTEXT_CHARS = 120_000;
const STREAM_WRITE_MS = 1_000;
const SYSTEM_PROMPT = 'You are chatting with the user through Chat Marks, a desktop app. Answer in plain text or Markdown.';

const modelId = z.string().min(1).max(200);
const turnSchema = z.object({ turnId: z.string().min(1).max(100), startedAt: z.number() });
const chatSchema = z.object({ model: modelId.nullable(), effort: z.enum(API_CHAT_EFFORTS).nullable(), openTurn: turnSchema.optional() });
const ledgerSchema = z.record(z.string().max(128), chatSchema);
type ChatRecord = z.infer<typeof chatSchema>;

interface RunningTurn { turnId: string; abort: AbortController; stopped: boolean; done: Promise<TurnOutcome> }

let ledger: Record<string, ChatRecord> | null = null;
let ledgerWrites: Promise<void> = Promise.resolve();
let recovery: Promise<void> | null = null;
/** Process memory: the only proof a turn is generating right now. */
const running = new Map<string, RunningTurn>();

async function chats(): Promise<Record<string, ChatRecord>> {
  if (ledger) return ledger;
  const stored = ledgerSchema.safeParse(await readDurable<unknown>(API_CHAT_SESSIONS_STATE));
  ledger ??= stored.success ? stored.data : {};
  return ledger;
}

/** Serialized durable change of one chat's record; memory follows the write. */
function updateChat(sessionId: string, change: (record: ChatRecord | undefined) => ChatRecord | undefined): Promise<void> {
  const write = ledgerWrites.then(async () => {
    const next = { ...(await chats()) };
    const record = change(next[sessionId]);
    if (record) next[sessionId] = record;
    else delete next[sessionId];
    await writeDurableNow(API_CHAT_SESSIONS_STATE, next);
    ledger = next;
  });
  ledgerWrites = write.catch(() => undefined);
  return write;
}

const userMessageId = (turnId: string): string => `api-user:${turnId}`;
const assistantMessageId = (turnId: string): string => `api-assistant:${turnId}`;

/** Bounded inline text, complete in an overflow asset when longer, like the recorder's. */
async function storedText(sessionId: string, value: string, cap: number): Promise<StoredText> {
  if (value.length <= cap) return { text: value, truncated: false, chars: value.length };
  const assetId = await writeOverflowText(sessionId, value);
  return { text: `${value.slice(0, cap)}\n…[${value.length - cap} more characters${assetId ? ` stored in full as ${assetId}` : ' were too large to store and are lost'}]`,
    truncated: true, chars: value.length, ...(assetId ? { assetId } : {}) };
}

/** The session behind an API chat id; anything else is refused by its conversation id. */
async function apiSession(sessionId: string): Promise<{ id: string; conversationId: string }> {
  const session = await getSession(sessionId);
  if (!session || !isApiConversationId(session.conversationId)) throw new Error('This is not an API chat');
  return { id: session.id, conversationId: session.conversationId };
}

async function chatRecord(sessionId: string): Promise<ChatRecord> {
  const record = (await chats())[sessionId];
  if (record) return record;
  const settings = await apiChatSettings();
  return { model: settings.model, effort: settings.effort };
}

export async function createApiChat(options: { projectId?: string | null; model?: string } = {}): Promise<ApiChatView> {
  await recoverApiChats();
  if (options.projectId) await projectWorkspace(options.projectId);
  const settings = await apiChatSettings();
  const summary = await createSession({ title: 'New API chat', titleSource: 'fallback', conversationId: `${API_CONVERSATION_PREFIX}${randomUUID()}` });
  if (options.projectId) await bindSessionProject(summary.id, options.projectId);
  const record: ChatRecord = { model: options.model ?? settings.model, effort: settings.effort };
  await updateChat(summary.id, () => record);
  notifyChanged(summary.id);
  return { sessionId: summary.id, conversationId: summary.conversationId!, model: record.model, effort: record.effort, running: false };
}

export async function apiChatView(sessionId: string): Promise<ApiChatView> {
  const session = await apiSession(sessionId);
  const record = await chatRecord(session.id);
  return { sessionId: session.id, conversationId: session.conversationId, model: record.model, effort: record.effort, running: running.has(session.id) };
}

/** Model switch per chat: the next request uses it; a running one keeps its own. */
export async function setApiChatSettings(sessionId: string, patch: { model?: string; effort?: ApiChatEffort | null }): Promise<ApiChatView> {
  const session = await apiSession(sessionId);
  const base = await chatRecord(session.id);
  await updateChat(session.id, record => ({
    ...(record ?? base),
    ...(patch.model !== undefined ? { model: modelId.parse(patch.model) } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {})
  }));
  return apiChatView(session.id);
}

/**
 * The chat's own canonical history as model context: questions and settled answers only,
 * newest kept within the message and character bounds, in the order they were written.
 */
export async function apiChatContext(sessionId: string): Promise<ApiChatMessage[]> {
  const events = await readEvents(sessionId, { kinds: ['user_message', 'assistant_message'] });
  const order = (event: SessionEvent): number => ('origin' in event ? event.origin : undefined) ?? event.seq;
  const rows = events
    .filter(event => event.kind === 'user_message' || (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')))
    .sort((left, right) => order(left) - order(right));
  const kept: ApiChatMessage[] = [];
  let chars = 0;
  for (let index = rows.length - 1; index >= 0 && kept.length < CONTEXT_MESSAGES; index--) {
    const event = rows[index]!;
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message') continue;
    const text = event.message.text;
    if (!text.trim()) continue;
    if (chars + text.length > CONTEXT_CHARS) break;
    chars += text.length;
    kept.unshift(event.kind === 'user_message' ? { role: 'user', content: text } : { role: 'assistant', content: text });
  }
  return kept;
}

/** Starts one turn. Resolves once the question is recorded; `done` settles with the turn. */
export async function sendApiChat(sessionId: string, text: string, fetchImpl?: typeof fetch): Promise<{ turnId: string; done: Promise<TurnOutcome> }> {
  await recoverApiChats();
  if (!text.trim() || text.length > MAX_API_CHAT_INPUT_CHARS) throw new Error('Write a message of up to 100,000 characters');
  const session = await apiSession(sessionId);
  // Check and claim with no await between: one turn per chat.
  if (running.has(session.id)) throw new Error('This chat is still answering');
  const turnId = `api-${randomUUID()}`;
  const turn: RunningTurn = { turnId, abort: new AbortController(), stopped: false, done: Promise.resolve('failed') };
  running.set(session.id, turn);
  let started = false;
  try {
    const record = await chatRecord(session.id);
    const settings = await apiChatSettings();
    const model = record.model ?? settings.model;
    if (!model) throw new Error('Choose a model for this chat first');
    const messages: ApiChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...await apiChatContext(session.id), { role: 'user', content: text }];
    const startedAt = Date.now();
    // Open in the ledger before the boundary exists, so a crash after it is always closed.
    await updateChat(session.id, current => ({ ...(current ?? record), openTurn: { turnId, startedAt } }));
    await upsertMessageEvent(session.id, {
      time: startedAt, source: 'app', kind: 'user_message', messageId: userMessageId(turnId),
      message: await storedText(session.id, text, MAX_USER_MESSAGE_CHARS)
    });
    await appendEvent(session.id, { time: Date.now(), source: 'app', kind: 'turn_start', turnId });
    started = true;
    notifyChanged(session.id);
    turn.done = streamTurn(session.id, turn, { endpoint: settings.endpoint, model, effort: record.effort, messages }, fetchImpl);
    return { turnId, done: turn.done };
  } catch (error) {
    if (started) await endTurn(session.id, turnId, 'failed').catch(() => undefined);
    else await updateChat(session.id, current => current && { model: current.model, effort: current.effort }).catch(() => undefined);
    running.delete(session.id);
    throw error;
  }
}

/** Stop is local and exact: it aborts this process's own request for that chat. */
export function stopApiChat(sessionId: string): boolean {
  const turn = running.get(sessionId);
  if (!turn) return false;
  turn.stopped = true;
  turn.abort.abort();
  return true;
}

async function writeAnswer(sessionId: string, turnId: string, text: string, final: boolean): Promise<void> {
  await upsertMessageEvent(sessionId, {
    time: Date.now(), source: 'app', kind: 'assistant_message', turnId, messageId: assistantMessageId(turnId),
    message: await storedText(sessionId, text, MAX_ASSISTANT_CHARS), state: final ? 'final' : 'streaming', final
  });
  notifyChanged(sessionId);
}

async function streamTurn(
  sessionId: string,
  turn: RunningTurn,
  request: { endpoint: string; model: string; effort: ApiChatEffort | null; messages: ApiChatMessage[] },
  fetchImpl?: typeof fetch
): Promise<TurnOutcome> {
  let latest = '';
  let written = '';
  let timer: NodeJS.Timeout | null = null;
  let writes: Promise<void> = Promise.resolve();
  const flush = (): void => {
    timer = null;
    if (latest === written) return;
    const text = latest;
    written = text;
    writes = writes.then(() => writeAnswer(sessionId, turn.turnId, text, false)).catch(error =>
      logWarn(`API chat ${sessionId}: streaming text not stored: ${(error as Error).message}`));
  };
  let outcome: TurnOutcome = 'completed';
  let failure: string | null = null;
  const key = await apiChatKey().catch(() => null);
  try {
    const completion = await streamCompletion({
      baseUrl: request.endpoint,
      key,
      request: { model: request.model, messages: request.messages, reasoningEffort: request.effort },
      signal: turn.abort.signal,
      onText: text => {
        latest = text;
        timer ??= setTimeout(flush, STREAM_WRITE_MS);
      },
      fetchImpl
    });
    latest = completion.text;
    await noteModelAvailability(request.endpoint, request.model, { ok: true }).catch(() => undefined);
    await noteRecentModel(request.model).catch(() => undefined);
  } catch (error) {
    if (turn.stopped) outcome = 'stopped';
    else {
      outcome = 'failed';
      failure = error instanceof Error ? error.message : String(error);
      if (!key && error instanceof ApiChatHttpError && error.status === 401) noteKeyRequired(request.endpoint);
      await noteModelAvailability(request.endpoint, request.model, { ok: false, error: failure }).catch(() => undefined);
    }
  }
  if (timer) clearTimeout(timer);
  await writes;
  try {
    // Whatever the model wrote stays, settled: a stopped or failed turn keeps its partial text.
    if (latest) await writeAnswer(sessionId, turn.turnId, latest, true);
    if (failure) {
      await appendEvent(sessionId, {
        time: Date.now(), source: 'app', kind: 'chat_error', turnId: turn.turnId, recoverable: false,
        message: await storedText(sessionId, `The API chat request failed: ${failure}`, 2000)
      });
    }
  } catch (error) {
    logWarn(`API chat ${sessionId}: answer not stored: ${(error as Error).message}`);
  }
  await endTurn(sessionId, turn.turnId, outcome).catch(error =>
    logWarn(`API chat ${sessionId}: turn end not stored: ${(error as Error).message}`));
  if (running.get(sessionId) === turn) running.delete(sessionId);
  notifyChanged(sessionId);
  return outcome;
}

async function endTurn(sessionId: string, turnId: string, outcome: TurnOutcome, detail?: string): Promise<void> {
  await appendEvent(sessionId, { time: Date.now(), source: 'app', kind: 'turn_end', turnId, outcome, ...(detail ? { detail } : {}) });
  await updateChat(sessionId, current => current && { model: current.model, effort: current.effort });
  notifyChanged(sessionId);
}

/** Closes every turn the previous process left open. Once per process; sends wait for it. */
export function recoverApiChats(): Promise<void> {
  recovery ??= (async () => {
    for (const [sessionId, record] of Object.entries(await chats())) {
      const open = record.openTurn;
      if (!open || running.has(sessionId)) continue;
      try {
        if (await getSession(sessionId)) {
          const events = await readEvents(sessionId, { kinds: ['turn_start', 'turn_end', 'assistant_message'] });
          const ofTurn = events.filter(event => event.turnId === open.turnId);
          if (ofTurn.some(event => event.kind === 'turn_start') && !ofTurn.some(event => event.kind === 'turn_end')) {
            const answer = ofTurn.find(event => event.kind === 'assistant_message' && event.messageId === assistantMessageId(open.turnId));
            if (answer?.kind === 'assistant_message' && !answer.final) {
              await upsertMessageEvent(sessionId, { time: answer.time, source: 'app', kind: 'assistant_message', turnId: open.turnId,
                messageId: answer.messageId, message: answer.message, state: 'final', final: true });
            }
            await appendEvent(sessionId, { time: Date.now(), source: 'app', kind: 'turn_end', turnId: open.turnId, outcome: 'interrupted',
              detail: 'Chat Marks closed before the API answer finished' });
            logInfo(`API chat ${sessionId}: closed turn ${open.turnId} left open by the previous run as interrupted`);
          }
        }
        await updateChat(sessionId, current => current && { model: current.model, effort: current.effort });
        notifyChanged(sessionId);
      } catch (error) {
        logWarn(`API chat ${sessionId}: open turn not recovered: ${(error as Error).message}`);
      }
    }
  })();
  return recovery;
}

export function resetApiChatExecutorForTests(): void {
  for (const turn of running.values()) turn.abort.abort();
  running.clear();
  ledger = null;
  ledgerWrites = Promise.resolve();
  recovery = null;
}
