/**
 * Chat Marks API chat settings: a Marks-owned durable record, separate from the upstream config,
 * so community merges never meet it. The key lives in the encrypted secret store, not here.
 */
import { z } from 'zod';
import { readDurable, writeDurableNow } from '../durable.js';
import { getSecret, hasSecret, setSecret } from '../secrets.js';
import { resolveApiChatBaseUrl } from './client.js';
import { API_CHAT_EFFORTS, DEFAULT_API_CHAT_ENDPOINT, type ApiChatSettings, type ApiChatStatus } from '../../shared/api-chat.js';

export const API_CHAT_SETTINGS_STATE = 'marks-api-chat-settings';
export const API_CHAT_KEY = 'marks:cliproxyApiKey' as const;

const schema = z.object({
  endpoint: z.string().min(1).max(512),
  model: z.string().min(1).max(200).nullable(),
  effort: z.enum(API_CHAT_EFFORTS).nullable()
});
const patchSchema = schema.partial().strict();

const DEFAULTS: ApiChatSettings = { endpoint: DEFAULT_API_CHAT_ENDPOINT, model: null, effort: null };
let current: ApiChatSettings | null = null;

export async function apiChatSettings(): Promise<ApiChatSettings> {
  if (current) return current;
  const stored = schema.safeParse(await readDurable<unknown>(API_CHAT_SETTINGS_STATE));
  current = stored.success ? stored.data : { ...DEFAULTS };
  return current;
}

export async function updateApiChatSettings(patch: unknown): Promise<ApiChatSettings> {
  const changes = patchSchema.parse(patch);
  if (changes.endpoint !== undefined) changes.endpoint = resolveApiChatBaseUrl(changes.endpoint);
  const next = { ...(await apiChatSettings()), ...changes };
  await writeDurableNow(API_CHAT_SETTINGS_STATE, next);
  current = next;
  return next;
}

export async function apiChatStatus(): Promise<ApiChatStatus> {
  return { ...(await apiChatSettings()), hasKey: await hasSecret(API_CHAT_KEY) };
}

/** Stores the key, or removes it when empty. It is never returned to the renderer. */
export async function setApiChatKey(value: unknown): Promise<void> {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid API key');
  await setSecret(API_CHAT_KEY, value);
}

export function apiChatKey(): Promise<string | null> {
  return getSecret(API_CHAT_KEY);
}

export function resetApiChatSettingsForTests(): void {
  current = null;
}
