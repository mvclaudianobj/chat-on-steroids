/**
 * CLIProxyAPI management API client (Chat Marks). The management password is the encrypted
 * secret `marks:cliproxyManagementKey`, independent of the MarksPanel login and of the chat key;
 * neither it nor any API key is ever returned to the renderer or logged.
 *
 * Endpoints (CLIProxyAPI internal/api/server_management.go, handlers in
 * internal/api/handlers/management/config_lists.go):
 *   GET    /v0/management/config                 → 200 with a valid key, 401 otherwise
 *   GET    /v0/management/api-keys               → {"api-keys": [string]}
 *   PATCH  /v0/management/api-keys {old,new}     → replaces `old`, or appends `new` when absent
 *   DELETE /v0/management/api-keys?index=<n>     → removes exactly that entry
 * Every request without a valid key counts toward the server's five-failure, 30-minute ban of
 * the client address, so a key the server rejected is not retried until it is replaced.
 */
import { createHash, randomBytes } from 'node:crypto';
import { getSecret, setSecret } from '../secrets.js';
import { apiChatKey, setApiChatKey } from '../api-chat/settings.js';
import type { CliProxyKeyView } from '../../shared/cliproxy.js';

export const MANAGEMENT_KEY = 'marks:cliproxyManagementKey' as const;
const LIMIT = 1024 * 1024;

/** Last answer for the stored password: never retried automatically after a 401. */
let rejected = false;

export function managementKey(): Promise<string | null> {
  return getSecret(MANAGEMENT_KEY);
}

export function managementKeyRejected(): boolean {
  return rejected;
}

/** A stable, non-reversible id for a key: the first 16 hex characters of its SHA-256. */
export function keyId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function maskKeys(keys: readonly string[], chatKey: string | null): CliProxyKeyView[] {
  return keys.map(key => ({ id: keyId(key), last4: key.length > 8 ? key.slice(-4) : '', chat: chatKey !== null && key === chatKey }));
}

/** `sk-marks-` and 32 random bytes in base64url: safe in YAML, headers and URLs. */
export function generateApiKey(): string {
  return `sk-marks-${randomBytes(32).toString('base64url')}`;
}

/** Only loopback management bases built by the module adapter. */
function checkedBase(base: string): string {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.username || !url.port) {
    throw new Error('management_unreachable');
  }
  return url.origin;
}

export async function managementRequest(base: string, key: string, method: 'GET' | 'PATCH' | 'DELETE', path: string,
  body?: unknown, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${checkedBase(base)}/v0/management${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    throw new Error('management_unreachable');
  }
  const text = await readText(response);
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const error = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' ? (json as { error: string }).error : '';
  if (response.status === 401) { rejected = true; throw new Error('management_key_invalid'); }
  if (response.status === 403) throw new Error(/banned/i.test(error) ? 'management_banned' : 'management_disabled');
  if (response.status === 404) throw new Error('management_disabled');
  if (response.status === 500 && /failed to save config/i.test(error)) throw new Error('management_save_failed');
  if (!response.ok) throw new Error('management_unreachable');
  rejected = false;
  return json;
}

async function readText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > LIMIT) throw new Error('management_unreachable');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/** True for 200, false for 401; anything else (down, disabled, banned) throws its code. */
export async function validateManagementKey(base: string, key: string, fetchImpl?: typeof fetch): Promise<boolean> {
  try {
    await managementRequest(base, key, 'GET', '/config', undefined, fetchImpl);
    return true;
  } catch (error) {
    if ((error as Error).message === 'management_key_invalid') return false;
    throw error;
  }
}

/** Saves the password only after the running service accepted it; empty removes it. */
export async function setManagementKey(base: string | null, value: string, fetchImpl?: typeof fetch): Promise<void> {
  const key = value.trim();
  if (key.length > 4096) throw new Error('management_key_invalid');
  if (!key) { await setSecret(MANAGEMENT_KEY, ''); rejected = false; return; }
  if (!base) throw new Error('management_unreachable');
  const before = rejected;
  // A candidate the server refused says nothing about the stored password.
  if (!await validateManagementKey(base, key, fetchImpl)) { rejected = before; throw new Error('management_key_invalid'); }
  await setSecret(MANAGEMENT_KEY, key);
  rejected = false;
}

async function storedKey(): Promise<string> {
  const key = await managementKey();
  if (!key) throw new Error('management_key_missing');
  if (rejected) throw new Error('management_key_invalid');
  return key;
}

async function rawKeys(base: string, key: string, fetchImpl?: typeof fetch): Promise<string[]> {
  const reply = await managementRequest(base, key, 'GET', '/api-keys', undefined, fetchImpl) as { 'api-keys'?: unknown } | null;
  const list = reply?.['api-keys'];
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('management_unreachable');
  return list.filter((item): item is string => typeof item === 'string');
}

export async function listApiKeys(base: string, fetchImpl?: typeof fetch): Promise<CliProxyKeyView[]> {
  const keys = await rawKeys(base, await storedKey(), fetchImpl);
  return maskKeys(keys, await apiChatKey());
}

/**
 * Adds a new key through the management API and makes it the CLIProxy chat key, so the chat
 * works immediately. PATCH with `old` = `new` appends without replacing the list, so a key
 * added meanwhile by someone else is kept.
 */
export async function createApiKey(base: string, fetchImpl?: typeof fetch): Promise<CliProxyKeyView[]> {
  const management = await storedKey();
  const created = generateApiKey();
  await managementRequest(base, management, 'PATCH', '/api-keys', { old: created, new: created }, fetchImpl);
  await setApiChatKey(created);
  return maskKeys(await rawKeys(base, management, fetchImpl), created);
}

/** Removes the one listed key with this id; the chat stops using it when it was the chat key. */
export async function revokeApiKey(base: string, id: string, fetchImpl?: typeof fetch): Promise<CliProxyKeyView[]> {
  const management = await storedKey();
  const keys = await rawKeys(base, management, fetchImpl);
  const index = keys.findIndex(key => keyId(key) === id);
  if (index < 0) throw new Error('key_not_found');
  const revoked = keys[index]!;
  await managementRequest(base, management, 'DELETE', `/api-keys?index=${index}`, undefined, fetchImpl);
  const chat = await apiChatKey();
  if (chat === revoked) await setApiChatKey('');
  return maskKeys(await rawKeys(base, management, fetchImpl), chat === revoked ? null : chat);
}

export function resetManagementForTests(): void { rejected = false; }
