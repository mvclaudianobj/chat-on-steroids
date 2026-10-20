/**
 * The models an API endpoint lists (`GET /models`), each classified by modality and annotated
 * with favorites, recents and its last real availability. Ids are kept exactly as listed.
 * Cached per endpoint and stored-key revision, like the Goal catalogue in goal.ts.
 */
import { secretsRevision } from '../secrets.js';
import { resolveApiChatBaseUrl } from './client.js';
import { apiChatKey, apiChatSettings, modelAvailability, noteEndpointDetected } from './settings.js';
import { modelModality, type ApiChatModel, type ApiModelModality } from '../../shared/api-chat.js';

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4_000_000;
const MAX_MODELS = 2_000;

export type ListedModel = Pick<ApiChatModel, 'id' | 'ownedBy' | 'modality'>;
let cache: { scope: string; at: number; models: ListedModel[] } | null = null;

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

export function parseModelList(parsed: unknown): ListedModel[] {
  const data = parsed && typeof parsed === 'object' ? (parsed as { data?: unknown }).data : null;
  if (!Array.isArray(data)) throw new Error('The API returned a model list this app could not read');
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const entry of data) {
    if (models.length >= MAX_MODELS) break;
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null;
    if (typeof id !== 'string' || !id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = (entry as { owned_by?: unknown }).owned_by;
    models.push({ id, ownedBy: typeof ownedBy === 'string' && ownedBy.length <= 80 ? ownedBy : null, modality: modelModality(id) });
  }
  return models.sort((a, b) => (a.ownedBy ?? '').localeCompare(b.ownedBy ?? '') || a.id.localeCompare(b.id));
}

export async function allApiModels(options: { refresh?: boolean; fetchImpl?: typeof fetch } = {}): Promise<ListedModel[]> {
  const { endpoint } = await apiChatSettings();
  const baseUrl = resolveApiChatBaseUrl(endpoint);
  // Read the revision before the key: replacing the key changes the scope at once.
  const revision = secretsRevision();
  const key = await apiChatKey();
  const scope = `${baseUrl}:${key ? `key@${revision}` : 'public'}`;
  if (!options.refresh && cache && cache.scope === scope && Date.now() - cache.at < CACHE_MS) return cache.models;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(`${baseUrl}/models`, {
        redirect: 'error',
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: abort.signal
      });
    } catch {
      noteEndpointDetected(endpoint, false);
      throw new Error(abort.signal.aborted ? `${baseUrl} did not answer in time` : `Nothing answered at ${baseUrl}`);
    }
    if (!response.ok) {
      noteEndpointDetected(endpoint, false);
      throw new Error(`The API would not list its models (HTTP ${response.status})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await boundedText(response));
    } catch (error) {
      noteEndpointDetected(endpoint, false);
      throw error instanceof Error && /larger/.test(error.message) ? error : new Error('The API returned a model list this app could not read');
    }
    const models = parseModelList(parsed);
    noteEndpointDetected(endpoint, true);
    cache = { scope, at: Date.now(), models };
    return models;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One page of models of a modality (chat by default): favorites first, then recents, then by
 * provider and id. Each row carries whether it is a favorite or recent and its last real
 * availability.
 */
export async function listApiChatModels(
  input: { query?: string; offset?: number; limit?: number; modality?: ApiModelModality; refresh?: boolean } = {},
  fetchImpl?: typeof fetch
): Promise<{ models: ApiChatModel[]; total: number }> {
  const listed = await allApiModels({ refresh: input.refresh, fetchImpl });
  const settings = await apiChatSettings();
  const seen = await modelAvailability(settings.endpoint);
  const favorite = new Map(settings.favorites.map((id, index) => [id, index]));
  const recent = new Map(settings.recents.map((id, index) => [id, index]));
  const modality = input.modality ?? 'chat';
  const needle = (input.query ?? '').trim().toLowerCase().slice(0, 100);
  const rank = (id: string): number => favorite.has(id) ? favorite.get(id)! : recent.has(id) ? 1_000 + recent.get(id)! : 10_000;
  const visible = listed
    .filter(model => model.modality === modality)
    .filter(model => !needle || model.id.toLowerCase().includes(needle) || (model.ownedBy ?? '').toLowerCase().includes(needle))
    .map((model, order) => ({ model, order }))
    .sort((a, b) => rank(a.model.id) - rank(b.model.id) || a.order - b.order)
    .map(({ model }): ApiChatModel => ({
      ...model,
      favorite: favorite.has(model.id),
      recent: recent.has(model.id),
      availability: seen.get(model.id) ?? null
    }));
  const from = Math.max(0, Math.floor(input.offset ?? 0));
  const count = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  return { models: visible.slice(from, from + count), total: visible.length };
}

export function resetApiChatCatalogForTests(): void {
  cache = null;
}
