/**
 * Chat Marks H1b: OpenViking HTTP recall (routes verified against @openviking/opencode-plugin
 * 2026.9.25-2: GET /api/v1/system/status, POST /api/v1/search/find with
 * { query, target_uri, limit, score_threshold }, envelope { status, result: { memories: [...] } }).
 * Authentication is `Authorization: Bearer <api_key>` when a vault entry exists; trusted local
 * servers need none. Plain HTTP is allowed only on loopback.
 */
import type { BrainProviders } from '../../../shared/brain.js';
import { boundedRequest, checkTransport, parseJson, ProviderError, vaultCredential, type RemoteHit } from './http.js';

type Config = BrainProviders['openviking'];
export const OPENVIKING_START_HINT = 'Start it with: openviking-server --config ~/.openviking/ov.conf';

async function request(config: Config, route: string, body?: unknown): Promise<any> {
  const url = checkTransport(config.url);
  const key = await vaultCredential(config.secret, url.origin);
  const headers: Record<string, string> = { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) };
  let reply;
  try { reply = await boundedRequest(new URL(route, url), { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }, config.timeoutMs); }
  catch (error) {
    if (error instanceof ProviderError && error.state === 'stopped') throw new ProviderError('stopped', `OpenViking is not running at ${url.origin}. ${OPENVIKING_START_HINT}`);
    throw error;
  }
  if (reply.status >= 400) throw new ProviderError('error', `HTTP ${reply.status}`);
  const parsed = parseJson(reply.text) as any;
  if (parsed?.status && parsed.status !== 'ok' && parsed.error) throw new ProviderError('error', 'OpenViking reported an error');
  return parsed?.result ?? parsed;
}

export async function openVikingStatus(config: Config): Promise<{ user?: string }> {
  const result = await request(config, '/api/v1/system/status');
  return typeof result?.user === 'string' ? { user: result.user } : {};
}

export async function openVikingRecall(config: Config, query: string, limit: number): Promise<RemoteHit[]> {
  const result = await request(config, '/api/v1/search/find', { query, target_uri: config.targetUri, limit, score_threshold: 0 });
  const items: any[] = Array.isArray(result?.memories) ? result.memories : Array.isArray(result?.resources) ? result.resources : [];
  return items.slice(0, limit).flatMap(item => {
    const content = String(item?.abstract ?? item?.overview ?? item?.content ?? '').trim();
    if (!content) return [];
    return [{ remoteId: item?.uri ? String(item.uri).slice(0, 200) : undefined, content: content.slice(0, 4000),
      title: item?.uri ? String(item.uri).split('/').filter(Boolean).pop()?.slice(0, 200) : undefined,
      score: typeof item?.score === 'number' ? item.score : undefined }];
  });
}
