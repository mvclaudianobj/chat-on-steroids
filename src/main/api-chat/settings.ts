/**
 * Chat Marks API chat settings: a Marks-owned durable record, separate from the upstream config,
 * so community merges never meet it. The key lives in the encrypted secret store, not here, and
 * is independent of the MarksPanel login.
 */
import { z } from 'zod';
import { readDurable, writeDurableNow } from '../durable.js';
import { getSecret, hasSecret, setSecret, secureStorageStatus, storedSecretsUnreadable } from '../secrets.js';
import { resolveApiChatBaseUrl } from './client.js';
import {
  API_CHAT_EFFORTS, DEFAULT_API_CHAT_ENDPOINT, MAX_FAVORITE_MODELS, MAX_RECENT_MODELS,
  type ApiChatSettings, type ApiChatStatus, type ApiModelAvailability
} from '../../shared/api-chat.js';

export const API_CHAT_SETTINGS_STATE = 'marks-api-chat-settings';
export const API_CHAT_AVAILABILITY_STATE = 'marks-api-chat-availability';
export const API_CHAT_KEY = 'marks:cliproxyApiKey' as const;

const modelId = z.string().min(1).max(200);
const schema = z.object({
  endpoint: z.string().min(1).max(512),
  model: modelId.nullable(),
  effort: z.enum(API_CHAT_EFFORTS).nullable(),
  favorites: z.array(modelId).max(MAX_FAVORITE_MODELS).default([]),
  recents: z.array(modelId).max(MAX_RECENT_MODELS).default([])
});
const patchSchema = z.object({
  endpoint: z.string().min(1).max(512),
  model: modelId.nullable(),
  effort: z.enum(API_CHAT_EFFORTS).nullable()
}).partial().strict();
const availabilitySchema = z.record(z.string().max(800), z.object({ ok: z.boolean(), at: z.number(), error: z.string().max(300).optional() }));

const DEFAULTS: ApiChatSettings = { endpoint: DEFAULT_API_CHAT_ENDPOINT, model: null, effort: null, favorites: [], recents: [] };
let current: ApiChatSettings | null = null;
let availability: Record<string, ApiModelAvailability> | null = null;
/** Learned per endpoint from the endpoint's own answers; nothing is guessed up front. */
const detected = new Map<string, boolean>();
const keyRequired = new Set<string>();

export async function apiChatSettings(): Promise<ApiChatSettings> {
  if (current) return current;
  const stored = schema.safeParse(await readDurable<unknown>(API_CHAT_SETTINGS_STATE));
  current = stored.success ? stored.data : { ...DEFAULTS };
  return current;
}

async function save(next: ApiChatSettings): Promise<ApiChatSettings> {
  await writeDurableNow(API_CHAT_SETTINGS_STATE, next);
  current = next;
  return next;
}

export async function updateApiChatSettings(patch: unknown): Promise<ApiChatSettings> {
  const changes = patchSchema.parse(patch);
  if (changes.endpoint !== undefined) changes.endpoint = resolveApiChatBaseUrl(changes.endpoint);
  return save({ ...(await apiChatSettings()), ...changes });
}

export async function toggleFavoriteModel(id: unknown): Promise<ApiChatSettings> {
  const model = modelId.parse(id);
  const settings = await apiChatSettings();
  const favorites = settings.favorites.includes(model)
    ? settings.favorites.filter(item => item !== model)
    : [model, ...settings.favorites].slice(0, MAX_FAVORITE_MODELS);
  return save({ ...settings, favorites });
}

/** A model a chat actually used moves to the front of the recents. */
export async function noteRecentModel(id: string): Promise<void> {
  const settings = await apiChatSettings();
  if (settings.recents[0] === id) return;
  await save({ ...settings, recents: [id, ...settings.recents.filter(item => item !== id)].slice(0, MAX_RECENT_MODELS) });
}

const availabilityKey = (endpoint: string, model: string): string => `${endpoint}\n${model}`;

async function availabilityRecord(): Promise<Record<string, ApiModelAvailability>> {
  if (availability) return availability;
  const stored = availabilitySchema.safeParse(await readDurable<unknown>(API_CHAT_AVAILABILITY_STATE));
  availability = stored.success ? stored.data : {};
  return availability;
}

export async function modelAvailability(endpoint: string): Promise<Map<string, ApiModelAvailability>> {
  const prefix = `${endpoint}\n`;
  return new Map(Object.entries(await availabilityRecord()).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
}

/** Records the outcome of a real request; only requests prove a model answers. */
export async function noteModelAvailability(endpoint: string, model: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void> {
  const record = { ...(await availabilityRecord()) };
  record[availabilityKey(endpoint, model)] = outcome.ok ? { ok: true, at: Date.now() } : { ok: false, at: Date.now(), error: outcome.error.slice(0, 300) };
  await writeDurableNow(API_CHAT_AVAILABILITY_STATE, record);
  availability = record;
}

export function noteEndpointDetected(endpoint: string, answered: boolean): void {
  detected.set(endpoint, answered);
}

export function noteKeyRequired(endpoint: string): void {
  keyRequired.add(endpoint);
}

export async function apiChatStatus(): Promise<ApiChatStatus> {
  const settings = await apiChatSettings();
  const before = await secureStorageStatus();
  const hasKey = before.available && !storedSecretsUnreadable() && await hasSecret(API_CHAT_KEY);
  const after = await secureStorageStatus();
  const keyPresence = !before.available || !after.available || storedSecretsUnreadable() ? 'unavailable' : hasKey ? 'saved' : 'absent';
  return {
    ...settings,
    hasKey: keyPresence === 'saved',
    keyPresence,
    detected: detected.get(settings.endpoint) ?? null,
    keyRequired: keyPresence === 'absent' && keyRequired.has(settings.endpoint)
  };
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
  availability = null;
  detected.clear();
  keyRequired.clear();
}
