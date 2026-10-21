/**
 * The Marks durable `marks-api-chat-sessions`: one record per API chat with what the session
 * store has no place for (engine, backend session id, model, effort, approval mode and the turn
 * it has open). It belongs to no single engine: the registry reads a chat's engine here.
 *
 * Compatibility: a record without `engine` is a `cliproxy` chat (every chat created before
 * engines existed), and `cliproxy` records are still written without it. A record this version
 * cannot read (an engine added later, a field out of range) is kept exactly as stored and
 * written back untouched; its chat is refused instead of being reset to defaults.
 */
import { z } from 'zod';
import { readDurable, writeDurableNow } from '../durable.js';
import { API_CHAT_APPROVAL_MODES, API_CHAT_EFFORTS, isApiConversationId } from '../../shared/api-chat.js';
import { AGENT_ENGINE_IDS, DEFAULT_AGENT_ENGINE, type AgentEngineId } from '../../shared/agent-engine.js';

export const API_CHAT_SESSIONS_STATE = 'marks-api-chat-sessions';

const modelId = z.string().min(1).max(200);
const turnSchema = z.object({ turnId: z.string().min(1).max(100), startedAt: z.number() });
export const chatRecordSchema = z.object({
  /** Absent means `cliproxy`. */
  engine: z.enum(AGENT_ENGINE_IDS).optional(),
  /** The engine's own session/thread id once it has one (Codex thread, Claude session, MarksCode session). */
  backendSessionId: z.string().min(1).max(200).optional(),
  model: modelId.nullable(),
  effort: z.enum(API_CHAT_EFFORTS).nullable(),
  /** Absent means `ask`, the default. */
  approval: z.enum(API_CHAT_APPROVAL_MODES).optional(),
  openTurn: turnSchema.optional()
});
export type ChatRecord = z.infer<typeof chatRecordSchema>;

interface Ledger {
  records: Record<string, ChatRecord>;
  /** Entries this version could not read, kept verbatim. */
  foreign: Record<string, unknown>;
}

let ledger: Ledger | null = null;
let writes: Promise<void> = Promise.resolve();

function parseLedger(stored: unknown): Ledger {
  const parsed: Ledger = { records: {}, foreign: {} };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return parsed;
  for (const [sessionId, value] of Object.entries(stored)) {
    if (sessionId.length > 128) continue;
    const record = chatRecordSchema.safeParse(value);
    if (record.success) parsed.records[sessionId] = record.data;
    else parsed.foreign[sessionId] = value;
  }
  return parsed;
}

async function loaded(): Promise<Ledger> {
  if (ledger) return ledger;
  const stored = parseLedger(await readDurable<unknown>(API_CHAT_SESSIONS_STATE));
  ledger ??= stored;
  return ledger;
}

/** Every readable record, by session id. */
export async function chatRecords(): Promise<Readonly<Record<string, ChatRecord>>> {
  return (await loaded()).records;
}

export async function storedChatRecord(sessionId: string): Promise<ChatRecord | undefined> {
  return (await loaded()).records[sessionId];
}

export const engineOf = (record: ChatRecord | undefined): AgentEngineId => record?.engine ?? DEFAULT_AGENT_ENGINE;

/**
 * The engine a chat runs on: its record's, `cliproxy` without a record (the executor then
 * refuses what is not an API chat), or null when the record is one this version cannot read.
 */
export async function chatEngine(sessionId: string): Promise<AgentEngineId | null> {
  const current = await loaded();
  if (Object.hasOwn(current.foreign, sessionId)) return null;
  return engineOf(current.records[sessionId]);
}

/**
 * The session list's API chats with the engine each runs on, so the sidebar can show the chat's
 * type icon. A read-time projection for the renderer: nothing writes it back, and this ledger
 * stays the engine's only owner. A record this version cannot read names no engine.
 */
export async function withChatEngines<T extends { id: string; conversationId: string | null }>(summaries: readonly T[]): Promise<Array<T & { engine?: AgentEngineId }>> {
  if (!summaries.some(summary => isApiConversationId(summary.conversationId))) return [...summaries];
  const current = await loaded();
  return summaries.map(summary => !isApiConversationId(summary.conversationId) || Object.hasOwn(current.foreign, summary.id)
    ? summary : { ...summary, engine: engineOf(current.records[summary.id]) });
}

/** Serialized durable change of one chat's record; memory follows the write. */
export function updateChatRecord(sessionId: string, change: (record: ChatRecord | undefined) => ChatRecord | undefined): Promise<void> {
  const write = writes.then(async () => {
    const current = await loaded();
    const records = { ...current.records };
    const foreign = { ...current.foreign };
    const record = change(records[sessionId]);
    // A chat written by this version replaces whatever unreadable entry it had.
    delete foreign[sessionId];
    if (record) records[sessionId] = chatRecordSchema.parse(record);
    else delete records[sessionId];
    await writeDurableNow(API_CHAT_SESSIONS_STATE, { ...foreign, ...records });
    ledger = { records, foreign };
  });
  writes = write.catch(() => undefined);
  return write;
}

/** The record without its open turn; everything else stays. */
export function withoutTurn(current: ChatRecord | undefined): ChatRecord | undefined {
  if (!current) return undefined;
  const { openTurn: _open, ...rest } = current;
  void _open;
  return rest;
}

export function resetChatLedgerForTests(): void {
  ledger = null;
  writes = Promise.resolve();
}
