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
 * D4: the model may call the app's own Core tools (`tools.ts`) in a loop of at most
 * MAX_TOOL_STEPS completions per turn. Edits and commands follow the chat's approval mode
 * (`ask` by default): the turn pauses on a pending approval that only the app window can answer.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurable, writeDurableNow } from '../durable.js';
import { logInfo, logWarn } from '../logger.js';
import { currentCoreInstructions } from '../mcp/instructions.js';
import { getSessionProject, projectWorkspace } from '../projects.js';
import { strictChatAllowlistEnabled } from '../session/conversation-access.js';
import { setChatsTrusted } from '../session/trusted-chats.js';
import { notifyChanged } from '../session/recorder.js';
import {
  appendEvent, bindSessionProject, createSession, getSession, MAX_USER_MESSAGE_CHARS, readEvents, upsertMessageEvent,
  writeOverflowText
} from '../session/store.js';
import {
  API_CHAT_APPROVAL_MODES, API_CHAT_EFFORTS, API_CONVERSATION_PREFIX, isApiConversationId, type ApiChatApprovalDecision, type ApiChatApprovalMode,
  type ApiChatEffort, type ApiChatPendingApproval, type ApiChatView
} from '../../shared/api-chat.js';
import type { SessionEvent, StoredText, TurnOutcome } from '../../shared/session.js';
import { ApiChatHttpError, streamCompletion, type ApiChatMessage, type ApiCompletion, type ApiToolCall } from './client.js';
import { apiChatTools, approvalSummary, argsHash, needsApproval, parseToolCall, runApiChatTool, toolDefinitions } from './tools.js';
import { apiChatKey, apiChatSettings, noteKeyRequired, noteModelAvailability, noteRecentModel } from './settings.js';

export const API_CHAT_SESSIONS_STATE = 'marks-api-chat-sessions';
export const MAX_API_CHAT_INPUT_CHARS = 100_000;
const MAX_ASSISTANT_CHARS = 256_000;
const CONTEXT_MESSAGES = 60;
const CONTEXT_CHARS = 120_000;
const STREAM_WRITE_MS = 1_000;
const SYSTEM_PROMPT = 'You are chatting with the user through Chat Marks, a desktop app. Answer in plain text or Markdown.';
/** Completions per turn: each step may call tools; the turn ends with a notice at this cap. */
export const MAX_TOOL_STEPS = 40;
export const DECLINED_RESULT = 'The user declined this action. It was not run.';

const modelId = z.string().min(1).max(200);
const turnSchema = z.object({ turnId: z.string().min(1).max(100), startedAt: z.number() });
const chatSchema = z.object({
  model: modelId.nullable(), effort: z.enum(API_CHAT_EFFORTS).nullable(),
  /** Absent means `ask`, the default. */
  approval: z.enum(API_CHAT_APPROVAL_MODES).optional(),
  openTurn: turnSchema.optional()
});
const ledgerSchema = z.record(z.string().max(128), chatSchema);
type ChatRecord = z.infer<typeof chatSchema>;

interface PendingApproval { view: ApiChatPendingApproval; hash: string; resolve(decision: 'approve' | 'deny' | 'stop'): void }
interface RunningTurn {
  turnId: string;
  /** The turn's tool identity, `cosapi:<uuid>`: unforgeable over HTTP (see tools.ts). */
  requestId: string;
  abort: AbortController;
  stopped: boolean;
  /** Settles when Stop is pressed, so a turn never waits on a tool that keeps running. */
  stoppedSignal: Promise<void>;
  stop(): void;
  pending: PendingApproval | null;
  done: Promise<TurnOutcome>;
}

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

/** The record without its open turn; the chat's model, effort and approval mode stay. */
function withoutTurn(current: ChatRecord | undefined): ChatRecord | undefined {
  if (!current) return undefined;
  const { openTurn: _open, ...rest } = current;
  void _open;
  return rest;
}

const userMessageId = (turnId: string): string => `api-user:${turnId}`;
/** Step 0 keeps the D2 id; each later completion of the same turn has its own message. */
const assistantMessageId = (turnId: string, step = 0): string => step ? `api-assistant:${turnId}:${step}` : `api-assistant:${turnId}`;

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
  // A chat explicitly started from New chat is trusted like a composer opening, once its
  // session is durable and only while strict mode is on. A failed write leaves it untrusted:
  // its tools are then refused by the kernel's strict check, never run.
  if (strictChatAllowlistEnabled()) {
    await setChatsTrusted([summary.conversationId!], true).catch(error =>
      logWarn(`API chat ${summary.id}: not trusted: ${(error as Error).message}`));
  }
  notifyChanged(summary.id);
  return apiChatView(summary.id);
}

export async function apiChatView(sessionId: string): Promise<ApiChatView> {
  const session = await apiSession(sessionId);
  const record = await chatRecord(session.id);
  const turn = running.get(session.id);
  return {
    sessionId: session.id, conversationId: session.conversationId, model: record.model, effort: record.effort, running: !!turn,
    approval: record.approval ?? 'ask', pending: turn?.pending ? { ...turn.pending.view, files: [...turn.pending.view.files] } : null
  };
}

/** Model switch per chat: the next request uses it; a running one keeps its own. */
export async function setApiChatSettings(
  sessionId: string,
  patch: { model?: string; effort?: ApiChatEffort | null; approval?: ApiChatApprovalMode }
): Promise<ApiChatView> {
  const session = await apiSession(sessionId);
  const base = await chatRecord(session.id);
  await updateChat(session.id, record => ({
    ...(record ?? base),
    ...(patch.model !== undefined ? { model: modelId.parse(patch.model) } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.approval !== undefined ? { approval: z.enum(API_CHAT_APPROVAL_MODES).parse(patch.approval) } : {})
  }));
  return apiChatView(session.id);
}

/**
 * Answers the one pending approval of a chat's running turn. Only that exact id is accepted:
 * a stale, answered or different id is refused. `always` also switches the chat to `auto`.
 */
export async function approveApiChat(sessionId: string, approvalId: string, decision: ApiChatApprovalDecision): Promise<ApiChatView> {
  const session = await apiSession(sessionId);
  const pendingNow = (): PendingApproval | null => {
    const pending = running.get(session.id)?.pending ?? null;
    return pending?.view.approvalId === approvalId ? pending : null;
  };
  if (!pendingNow()) throw new Error('This approval is no longer pending');
  if (decision === 'always') await setApiChatSettings(session.id, { approval: 'auto' });
  // The settings write awaited: Stop may have answered it meanwhile.
  const pending = pendingNow();
  if (!pending) throw new Error('This approval is no longer pending');
  pending.resolve(decision === 'deny' ? 'deny' : 'approve');
  return apiChatView(session.id);
}

/**
 * The chat's own canonical history as model context: questions and settled answers only,
 * newest kept within the message and character bounds, in the order they were written. Tool
 * traffic is not replayed; a turn's several answer steps are joined into one assistant message.
 */
export async function apiChatContext(sessionId: string): Promise<ApiChatMessage[]> {
  const events = await readEvents(sessionId, { kinds: ['user_message', 'assistant_message'] });
  const order = (event: SessionEvent): number => ('origin' in event ? event.origin : undefined) ?? event.seq;
  const rows = events
    .filter(event => event.kind === 'user_message' || (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')))
    .sort((left, right) => order(left) - order(right));
  const kept: ApiChatMessage[] = [];
  let chars = 0;
  let joinedTurn: string | undefined;
  for (let index = rows.length - 1; index >= 0 && kept.length < CONTEXT_MESSAGES; index--) {
    const event = rows[index]!;
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message') continue;
    const text = event.message.text;
    if (!text.trim()) continue;
    if (chars + text.length > CONTEXT_CHARS) break;
    chars += text.length;
    const first = kept[0];
    if (event.kind === 'assistant_message' && first?.role === 'assistant' && event.turnId && event.turnId === joinedTurn) {
      first.content = `${text}\n\n${first.content ?? ''}`;
      continue;
    }
    joinedTurn = event.kind === 'assistant_message' ? event.turnId : undefined;
    kept.unshift(event.kind === 'user_message' ? { role: 'user', content: text } : { role: 'assistant', content: text });
  }
  return kept;
}

/**
 * The turn's system message: the short Chat Marks line, then (when tools are offered) the Core
 * instructions and the chat's project folder in the virtual form the tools take.
 */
async function systemPrompt(sessionId: string): Promise<string> {
  const names = [...apiChatTools().keys()];
  if (!names.length) return SYSTEM_PROMPT;
  const project = await getSessionProject(sessionId);
  const core = await currentCoreInstructions().catch(error => {
    logWarn(`API chat ${sessionId}: Core instructions unavailable: ${(error as Error).message}`);
    return '';
  });
  return [
    `${SYSTEM_PROMPT} You can use this computer's local tools through function calls: ${names.join(', ')}. ` +
      'Other tools the instructions below may name are not available in this chat. Call tools one step at a time and keep going until the task is done; ' +
      'edits and commands may wait for the user\'s approval, and a declined action was not run.',
    core,
    project
      ? `Selected project directory: ${project.virtual}\nStart there and use this directory as your default working directory (the tools take paths in this form). ` +
        'Before working on a task, read the AGENTS.md at its root if there is one, and follow it. ' +
        'This project association grants no additional filesystem permissions.'
      : ''
  ].filter(Boolean).join('\n\n');
}

/** Starts one turn. Resolves once the question is recorded; `done` settles with the turn. */
export async function sendApiChat(sessionId: string, text: string, fetchImpl?: typeof fetch): Promise<{ turnId: string; done: Promise<TurnOutcome> }> {
  await recoverApiChats();
  if (!text.trim() || text.length > MAX_API_CHAT_INPUT_CHARS) throw new Error('Write a message of up to 100,000 characters');
  const session = await apiSession(sessionId);
  // Check and claim with no await between: one turn per chat.
  if (running.has(session.id)) throw new Error('This chat is still answering');
  const turnId = `api-${randomUUID()}`;
  let stop!: () => void;
  const stoppedSignal = new Promise<void>(resolve => { stop = resolve; });
  const turn: RunningTurn = {
    turnId, requestId: `cosapi:${randomUUID()}`, abort: new AbortController(), stopped: false, stoppedSignal, stop, pending: null,
    done: Promise.resolve('failed')
  };
  running.set(session.id, turn);
  let started = false;
  try {
    const record = await chatRecord(session.id);
    const settings = await apiChatSettings();
    const model = record.model ?? settings.model;
    if (!model) throw new Error('Choose a model for this chat first');
    const messages: ApiChatMessage[] = [{ role: 'system', content: await systemPrompt(session.id) }, ...await apiChatContext(session.id), { role: 'user', content: text }];
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
    turn.done = runTurn(session, turn, { endpoint: settings.endpoint, model, effort: record.effort, messages }, fetchImpl);
    return { turnId, done: turn.done };
  } catch (error) {
    if (started) await endTurn(session.id, turnId, 'failed').catch(() => undefined);
    else await updateChat(session.id, current => withoutTurn(current)).catch(() => undefined);
    running.delete(session.id);
    throw error;
  }
}

/**
 * Stop is local and exact: it aborts this process's own request for that chat and answers a
 * pending approval as stopped. A tool already running is not killed: it finishes under the
 * kernel's own custody (an exec child keeps its session ownership) and records its row.
 */
export function stopApiChat(sessionId: string): boolean {
  const turn = running.get(sessionId);
  if (!turn) return false;
  turn.stopped = true;
  turn.abort.abort();
  turn.pending?.resolve('stop');
  turn.stop();
  return true;
}

async function writeAnswer(sessionId: string, turnId: string, step: number, text: string, final: boolean): Promise<void> {
  await upsertMessageEvent(sessionId, {
    time: Date.now(), source: 'app', kind: 'assistant_message', turnId, messageId: assistantMessageId(turnId, step),
    message: await storedText(sessionId, text, MAX_ASSISTANT_CHARS), state: final ? 'final' : 'streaming', final
  });
  notifyChanged(sessionId);
}

interface TurnRequest { endpoint: string; model: string; effort: ApiChatEffort | null; messages: ApiChatMessage[] }

/** One completion of the turn, streamed into its own message; partial text stays, settled. */
async function streamStep(sessionId: string, turn: RunningTurn, step: number, request: TurnRequest, key: string | null, fetchImpl?: typeof fetch): Promise<ApiCompletion> {
  let latest = '';
  let written = '';
  let timer: NodeJS.Timeout | null = null;
  let writes: Promise<void> = Promise.resolve();
  const flush = (): void => {
    timer = null;
    if (latest === written) return;
    const text = latest;
    written = text;
    writes = writes.then(() => writeAnswer(sessionId, turn.turnId, step, text, false)).catch(error =>
      logWarn(`API chat ${sessionId}: streaming text not stored: ${(error as Error).message}`));
  };
  try {
    const tools = toolDefinitions(apiChatTools());
    const completion = await streamCompletion({
      baseUrl: request.endpoint,
      key,
      request: { model: request.model, messages: request.messages, reasoningEffort: request.effort, ...(tools.length ? { tools } : {}) },
      signal: turn.abort.signal,
      onText: text => {
        latest = text;
        timer ??= setTimeout(flush, STREAM_WRITE_MS);
      },
      fetchImpl
    });
    latest = completion.text;
    return completion;
  } finally {
    if (timer) clearTimeout(timer);
    await writes;
    try {
      if (latest) await writeAnswer(sessionId, turn.turnId, step, latest, true);
    } catch (error) {
      logWarn(`API chat ${sessionId}: answer not stored: ${(error as Error).message}`);
    }
  }
}

/** Waits for the user's answer to one call; Stop answers `stop`. */
function askApproval(sessionId: string, turn: RunningTurn, call: ApiToolCall, name: string, args: Record<string, unknown>): Promise<'approve' | 'deny' | 'stop'> {
  if (turn.stopped) return Promise.resolve('stop');
  const { summary, files } = approvalSummary(name, args);
  return new Promise(resolve => {
    const pending: PendingApproval = {
      view: { approvalId: randomUUID(), turnId: turn.turnId, toolCallId: call.id, tool: name, summary, files, requestedAt: Date.now() },
      hash: argsHash(name, args),
      resolve: decision => {
        if (turn.pending !== pending) return;
        turn.pending = null;
        notifyChanged(sessionId);
        resolve(decision);
      }
    };
    turn.pending = pending;
    notifyChanged(sessionId);
  });
}

/** One tool call to its result text for the model, or null when Stop ended the turn. */
async function executeCall(session: { id: string; conversationId: string }, turn: RunningTurn, call: ApiToolCall): Promise<string | null> {
  const tools = apiChatTools();
  const parsed = await parseToolCall(call, tools);
  const caller = { requestId: turn.requestId, conversationId: session.conversationId, sessionId: session.id, messageId: assistantMessageId(turn.turnId) };
  if (!parsed.ok) return parsed.error;
  if (needsApproval(parsed.tool.name, parsed.args) && ((await chats())[session.id]?.approval ?? 'ask') !== 'auto') {
    const approvedHash = argsHash(parsed.tool.name, parsed.args);
    const decision = await askApproval(session.id, turn, call, parsed.tool.name, parsed.args);
    if (decision === 'stop' || turn.stopped) return null;
    if (decision === 'deny') return DECLINED_RESULT;
    // An approval covers exactly the arguments it showed.
    if (approvedHash !== argsHash(parsed.tool.name, parsed.args)) return 'APPROVAL_MISMATCH: the action changed after approval and was not run.';
  }
  if (turn.stopped) return null;
  const work = runApiChatTool(caller, parsed);
  const settled = await Promise.race([work, turn.stoppedSignal.then(() => null)]);
  return settled ? settled.text : null;
}

async function runTurn(session: { id: string; conversationId: string }, turn: RunningTurn, request: TurnRequest, fetchImpl?: typeof fetch): Promise<TurnOutcome> {
  const sessionId = session.id;
  const messages = [...request.messages];
  let outcome: TurnOutcome = 'completed';
  let failure: string | null = null;
  let capped = false;
  let noted = false;
  const key = await apiChatKey().catch(() => null);
  try {
    for (let step = 0; ; step++) {
      if (step >= MAX_TOOL_STEPS) { capped = true; break; }
      const completion = await streamStep(sessionId, turn, step, { ...request, messages }, key, fetchImpl);
      if (!noted) {
        noted = true;
        await noteModelAvailability(request.endpoint, request.model, { ok: true }).catch(() => undefined);
        await noteRecentModel(request.model).catch(() => undefined);
      }
      if (!completion.toolCalls.length || turn.stopped) break;
      messages.push({ role: 'assistant', content: completion.text || null, tool_calls: completion.toolCalls });
      for (const call of completion.toolCalls) {
        const content = await executeCall(session, turn, call);
        if (content === null) break;
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
      if (turn.stopped) break;
    }
    if (turn.stopped) outcome = 'stopped';
  } catch (error) {
    if (turn.stopped) outcome = 'stopped';
    else {
      outcome = 'failed';
      failure = error instanceof Error ? error.message : String(error);
      if (!key && error instanceof ApiChatHttpError && error.status === 401) noteKeyRequired(request.endpoint);
      await noteModelAvailability(request.endpoint, request.model, { ok: false, error: failure }).catch(() => undefined);
    }
  }
  try {
    if (failure) {
      await appendEvent(sessionId, {
        time: Date.now(), source: 'app', kind: 'chat_error', turnId: turn.turnId, recoverable: false,
        message: await storedText(sessionId, `The API chat request failed: ${failure}`, 2000)
      });
    }
    // The cap ends the turn cleanly (completed): nothing failed, the model just has not finished.
    if (capped) {
      await appendEvent(sessionId, {
        time: Date.now(), source: 'app', kind: 'note', turnId: turn.turnId,
        message: await storedText(sessionId, `The model used ${MAX_TOOL_STEPS} tool steps in this turn without finishing. Send a message to let it continue.`, 2000)
      });
    }
  } catch (error) {
    logWarn(`API chat ${sessionId}: turn notice not stored: ${(error as Error).message}`);
  }
  turn.pending = null;
  await endTurn(sessionId, turn.turnId, outcome).catch(error =>
    logWarn(`API chat ${sessionId}: turn end not stored: ${(error as Error).message}`));
  if (running.get(sessionId) === turn) running.delete(sessionId);
  notifyChanged(sessionId);
  return outcome;
}

async function endTurn(sessionId: string, turnId: string, outcome: TurnOutcome, detail?: string): Promise<void> {
  await appendEvent(sessionId, { time: Date.now(), source: 'app', kind: 'turn_end', turnId, outcome, ...(detail ? { detail } : {}) });
  await updateChat(sessionId, current => withoutTurn(current));
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
            // Every step of the turn has its own answer message; settle each one left streaming.
            for (const answer of ofTurn) {
              if (answer.kind !== 'assistant_message' || answer.final || !answer.messageId?.startsWith(assistantMessageId(open.turnId))) continue;
              await upsertMessageEvent(sessionId, { time: answer.time, source: 'app', kind: 'assistant_message', turnId: open.turnId,
                messageId: answer.messageId, message: answer.message, state: 'final', final: true });
            }
            await appendEvent(sessionId, { time: Date.now(), source: 'app', kind: 'turn_end', turnId: open.turnId, outcome: 'interrupted',
              detail: 'Chat Marks closed before the API answer finished' });
            logInfo(`API chat ${sessionId}: closed turn ${open.turnId} left open by the previous run as interrupted`);
          }
        }
        await updateChat(sessionId, current => withoutTurn(current));
        notifyChanged(sessionId);
      } catch (error) {
        logWarn(`API chat ${sessionId}: open turn not recovered: ${(error as Error).message}`);
      }
    }
  })();
  return recovery;
}

export function resetApiChatExecutorForTests(): void {
  for (const turn of running.values()) { turn.stopped = true; turn.abort.abort(); turn.pending?.resolve('stop'); turn.stop(); }
  running.clear();
  ledger = null;
  ledgerWrites = Promise.resolve();
  recovery = null;
}
