/**
 * The transcript shape every API chat writes into the session store, whatever its engine:
 * the question is an app `user_message` (`api-user:<turn>`), each answer step an
 * `assistant_message` (`api-assistant:<turn>` for step 0, `:<step>` after it), between the
 * turn's `turn_start`/`turn_end`. Recovery, context replay and the renderer rely on these ids.
 */
import { writeOverflowText } from '../session/store.js';
import type { StoredText } from '../../shared/session.js';

export const MAX_ASSISTANT_CHARS = 256_000;

export const userMessageId = (turnId: string): string => `api-user:${turnId}`;
/** Step 0 keeps the D2 id; each later answer step of the same turn has its own message. */
export const assistantMessageId = (turnId: string, step = 0): string => step ? `api-assistant:${turnId}:${step}` : `api-assistant:${turnId}`;

/** Bounded inline text, complete in an overflow asset when longer, like the recorder's. */
export async function storedText(sessionId: string, value: string, cap: number): Promise<StoredText> {
  if (value.length <= cap) return { text: value, truncated: false, chars: value.length };
  const assetId = await writeOverflowText(sessionId, value);
  return { text: `${value.slice(0, cap)}\n…[${value.length - cap} more characters${assetId ? ` stored in full as ${assetId}` : ' were too large to store and are lost'}]`,
    truncated: true, chars: value.length, ...(assetId ? { assetId } : {}) };
}
