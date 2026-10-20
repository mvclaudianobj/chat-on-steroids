/**
 * The chat models an API endpoint lists (`GET /models`), without image, audio or embedding
 * models. Cached per endpoint and stored-key revision, like the Goal catalogue in goal.ts.
 */
import { secretsRevision } from '../secrets.js';
import { resolveApiChatBaseUrl } from './client.js';
import { apiChatKey, apiChatSettings } from './settings.js';
import { isChatModelId, type ApiChatModel } from '../../shared/api-chat.js';

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4_000_000;
const MAX_MODELS = 2_000;

let cache: { scope: string; at: number; models: ApiChatModel[] } | null = null;

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error('The model list is larger than this app accepts');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

export function parseModelList(parsed: unknown): ApiChatModel[] {
  const data = parsed && typeof parsed === 'object' ? (parsed as { data?: unknown }).data : null;
  if (!Array.isArray(data)) throw new Error('The API returned a model list this app could not read');
  const seen = new Set<string>();
  const models: ApiChatModel[] = [];
  for (const entry of data) {
    if (models.length >= MAX_MODELS) break;
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null;
    if (typeof id !== 'string' || !id || id.length > 200 || seen.has(id) || !isChatModelId(id)) continue;
    seen.add(id);
    const ownedBy = (entry as { owned_by?: unknown }).owned_by;
    models.push({ id, ownedBy: typeof ownedBy === 'string' && ownedBy.length <= 80 ? ownedBy : null });
  }
  return models.sort((a, b) => (a.ownedBy ?? '').localeCompare(b.ownedBy ?? '') || a.id.localeCompare(b.id));
}

export async function allApiChatModels(fetchImpl: typeof fetch = fetch): Promise<ApiChatModel[]> {
  const { endpoint } = await apiChatSettings();
  const baseUrl = resolveApiChatBaseUrl(endpoint);
  // Read the revision before the key: replacing the key changes the scope at once.
  const revision = secretsRevision();
  const key = await apiChatKey();
  const scope = `${baseUrl}:${key ? `key@${revision}` : 'public'}`;
  if (cache && cache.scope === scope && Date.now() - cache.at < CACHE_MS) return cache.models;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      redirect: 'error',
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: abort.signal
    });
    if (!response.ok) throw new Error(`The API would not list its models (HTTP ${response.status})`);
    const raw = await boundedText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('The API returned a model list this app could not read');
    }
    const models = parseModelList(parsed);
    cache = { scope, at: Date.now(), models };
    return models;
  } catch (error) {
    if (abort.signal.aborted) throw new Error('The API did not list its models in time');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function listApiChatModels(input: { query?: string; offset?: number; limit?: number } = {}, fetchImpl?: typeof fetch): Promise<{ models: ApiChatModel[]; total: number }> {
  const models = await allApiChatModels(fetchImpl);
  const needle = (input.query ?? '').trim().toLowerCase().slice(0, 100);
  const visible = needle ? models.filter(model => model.id.toLowerCase().includes(needle) || (model.ownedBy ?? '').toLowerCase().includes(needle)) : models;
  const from = Math.max(0, Math.floor(input.offset ?? 0));
  const count = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  return { models: visible.slice(from, from + count), total: visible.length };
}

export function resetApiChatCatalogForTests(): void {
  cache = null;
}
