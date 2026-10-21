/**
 * Closing a turn the previous process left open, shared by every engine's `recover()`: each
 * answer step still `streaming` is settled `final`, then the turn ends `interrupted` with the
 * engine's own detail, and the ledger's open turn is cleared. Nothing resumes a generation here;
 * an engine whose backend can (Codex `thread/resume`) does that before calling this.
 *
 * An engine that recovers its own turns claims them here, so the engine-neutral CLIProxy
 * recovery (`recoverApiChats`) leaves its records alone instead of closing them first.
 */
import { appendEvent, getSession, readEvents, upsertMessageEvent } from '../session/store.js';
import { notifyChanged } from '../session/recorder.js';
import type { AgentEngineId } from '../../shared/agent-engine.js';
import { updateChatRecord, withoutTurn } from './ledger.js';
import { assistantMessageId } from './transcript.js';

const selfRecovering = new Set<AgentEngineId>();

export function claimTurnRecovery(engine: AgentEngineId): void {
  selfRecovering.add(engine);
}

export const recoversOwnTurns = (engine: AgentEngineId): boolean => selfRecovering.has(engine);

/** Whether a turn was closed (false when it had already ended or the session is gone). */
export async function closeInterruptedTurn(sessionId: string, turnId: string, detail: string): Promise<boolean> {
  let closed = false;
  if (await getSession(sessionId)) {
    const events = await readEvents(sessionId, { kinds: ['turn_start', 'turn_end', 'assistant_message'] });
    const ofTurn = events.filter(event => event.turnId === turnId);
    if (ofTurn.some(event => event.kind === 'turn_start') && !ofTurn.some(event => event.kind === 'turn_end')) {
      // Every step of the turn has its own answer message; settle each one left streaming.
      for (const answer of ofTurn) {
        if (answer.kind !== 'assistant_message' || answer.final || !answer.messageId?.startsWith(assistantMessageId(turnId))) continue;
        await upsertMessageEvent(sessionId, { time: answer.time, source: 'app', kind: 'assistant_message', turnId,
          messageId: answer.messageId, message: answer.message, state: 'final', final: true });
      }
      await appendEvent(sessionId, { time: Date.now(), source: 'app', kind: 'turn_end', turnId, outcome: 'interrupted', detail });
      closed = true;
    }
  }
  await updateChatRecord(sessionId, current => current?.openTurn?.turnId === turnId ? withoutTurn(current) : current);
  notifyChanged(sessionId);
  return closed;
}
