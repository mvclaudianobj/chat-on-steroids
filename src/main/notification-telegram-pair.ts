/** Telegram one-time /start pairing. Token remains in Vault K's main-process callback. */
import { randomBytes } from 'node:crypto';
import { notificationSettings, saveNotificationSettings } from './notification-center.js';
import { withNotificationCredential } from './notification-credentials.js';

let pairing: { code: string; expires: number; generation: number; offset: number } | null = null;
let serial = 0;
const BASE = 'https://api.telegram.org';
function endpoint(token: string, method: string): string { return `${BASE}/bot${encodeURIComponent(token)}/${method}`; }
async function telegram<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 12000);
  try {
    const response = await fetch(endpoint(token, method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: abort.signal });
    if (!response.ok) throw new Error('Telegram API request failed');
    const result = await response.json() as { ok?: boolean; result?: T };
    if (!result.ok || result.result === undefined) throw new Error('Telegram API request failed');
    return result.result;
  } finally { clearTimeout(timeout); }
}
export async function startTelegramPairing(): Promise<{ url: string; expires: number }> {
  // Resolve bot identity and verify the credential without sending it to the renderer.
  const username = await withNotificationCredential('telegram', token => telegram<{ username: string }>(token, 'getMe'));
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username.username)) throw new Error('Invalid Telegram bot');
  const code = randomBytes(18).toString('base64url');
  pairing = { code, expires: Date.now() + 180000, generation: ++serial, offset: 0 };
  return { url: `https://t.me/${username.username}?start=${code}`, expires: pairing.expires };
}
export async function checkTelegramPairing(): Promise<{ state: 'pending' | 'paired' | 'expired'; chatId?: string }> {
  const current = pairing;
  if (!current || current.expires < Date.now()) { pairing = null; return { state: 'expired' }; }
  type Update = { update_id: number; message?: { text?: string; chat?: { id?: number; type?: string } } };
  const updates = await withNotificationCredential('telegram', token => telegram<Update[]>(token, 'getUpdates', { offset: current.offset, limit: 100, timeout: 0, allowed_updates: ['message'] }));
  if (pairing !== current) return { state: 'expired' };
  current.offset = Math.max(current.offset, ...updates.map(u => u.update_id + 1));
  const match = updates.find(u => u.message?.text?.trim() === `/start ${current.code}` && u.message.chat?.type === 'private' && Number.isSafeInteger(u.message.chat.id));
  if (!match?.message?.chat?.id) return { state: 'pending' };
  pairing = null;
  const chatId = String(match.message.chat.id);
  const settings = structuredClone(await notificationSettings());
  settings.channels.telegram.destinations = [...new Set([...settings.channels.telegram.destinations, chatId])];
  await saveNotificationSettings(settings);
  return { state: 'paired', chatId };
}
export function cancelTelegramPairing(): void { pairing = null; ++serial; }
