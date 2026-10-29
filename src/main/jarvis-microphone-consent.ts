/** A single, revocable app-wide microphone grant. Never controls recording itself. */
import { readDurable, writeDurableNow } from './durable.js';

const STATE = 'jarvis-microphone-consent';
let permitted = false;
let sequence = 0;
let pending: Promise<void> = Promise.resolve();

export async function restoreJarvisMicrophoneConsent(): Promise<void> {
  // Unknown or corrupt state is not a grant.
  const epoch = ++sequence;
  permitted = false;
  let saved: unknown = null;
  try { saved = await readDurable<unknown>(STATE, { strict: true }); }
  catch { /* Corrupt or unreadable state cannot authorize the microphone. */ }
  if (epoch === sequence) permitted = saved === true;
}

export function jarvisMicrophoneConsented(): boolean { return permitted; }

export async function setJarvisMicrophoneConsent(enabled: boolean): Promise<boolean> {
  const epoch = ++sequence;
  // Revocation takes effect before any disk I/O or pending capture check.
  if (!enabled) permitted = false;
  const write = pending.then(async () => {
    await writeDurableNow(STATE, enabled);
    if (epoch === sequence) permitted = enabled;
  });
  pending = write.catch(() => undefined);
  await write;
  return permitted;
}
