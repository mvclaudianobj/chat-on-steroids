/**
 * Chat Marks H1b: the Marks memory API (MarksCode fork cloud.ts / 1.1.3 memories-api.ts).
 * Routes: GET /health, POST /memories/human/recall { user_id, cue, limit },
 * POST /memories/human (save), POST /memories/{id}/delete. Auth: X-API-Key from the vault and/or
 * the Markspanel session bearer with x-org-id / x-customer-id. The API is plain HTTP today, so
 * nothing is sent until the provider's insecure-HTTP acknowledgement is on.
 */
import type { BrainMemory, BrainProviders } from '../../../shared/brain.js';
import { markspanelBrainSession } from '../../markspanel-auth.js';
import { boundedRequest, checkTransport, parseJson, ProviderError, vaultCredential, type RemoteHit } from './http.js';

type Config = BrainProviders['marksApi'];

async function authHeaders(config: Config, url: URL): Promise<{ headers: Record<string, string>; userId: string }> {
  const headers: Record<string, string> = {};
  let userId = config.userId.trim();
  if (config.auth !== 'markspanel') {
    const key = await vaultCredential(config.secret, url.origin);
    if (key) headers['X-API-Key'] = key;
  }
  if (config.auth !== 'apiKey') {
    const session = await markspanelBrainSession().catch(() => null);
    if (session) {
      headers.Authorization = `Bearer ${session.access}`;
      if (config.orgId) headers['x-org-id'] = config.orgId;
      if (config.customerId) headers['x-customer-id'] = config.customerId;
      if (!userId && session.id) userId = session.id;
    }
  }
  if (!Object.keys(headers).length) throw new ProviderError('needs-key', config.auth === 'markspanel' ? 'Sign in to Markspanel first' : `Add vault entry ${config.secret} for ${url.origin}`);
  return { headers, userId: userId || 'marks-local' };
}

async function call(config: Config, route: string, body?: unknown): Promise<any> {
  const url = checkTransport(config.url, config.insecureHttp);
  const { headers, userId } = await authHeaders(config, url);
  const payload = body && typeof body === 'object' ? { user_id: userId, ...body } : undefined;
  const reply = await boundedRequest(new URL(route, url), { method: 'POST', headers: { ...headers, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) }, config.timeoutMs);
  if (reply.status >= 400) throw new ProviderError('error', `HTTP ${reply.status}`);
  return parseJson(reply.text);
}

export async function marksApiHealth(config: Config): Promise<void> {
  const url = checkTransport(config.url, config.insecureHttp);
  const reply = await boundedRequest(new URL('/health', url), { method: 'GET', headers: { accept: 'application/json' } }, config.timeoutMs);
  if (reply.status !== 200) throw new ProviderError('error', `Health HTTP ${reply.status}`);
}

export async function marksApiRecall(config: Config, query: string, limit: number): Promise<RemoteHit[]> {
  const body = await call(config, '/memories/human/recall', { cue: query, limit });
  const scores: unknown[] = Array.isArray(body?.scores) ? body.scores : [];
  const rows: any[] = Array.isArray(body?.memories) ? body.memories : Array.isArray(body?.items) ? body.items : [];
  return rows.slice(0, limit).flatMap((entry, index) => {
    const item = entry?.item && typeof entry.item === 'object' ? entry.item : entry;
    const content = String(item?.content ?? item?.text ?? '').trim();
    if (!content) return [];
    const score = typeof entry?.score === 'number' ? entry.score : typeof scores[index] === 'number' ? scores[index] as number : undefined;
    return [{ remoteId: item?.id ? String(item.id).slice(0, 200) : undefined, content: content.slice(0, 4000),
      title: item?.title ? String(item.title).slice(0, 200) : undefined, score }];
  });
}

export async function marksApiSave(config: Config, memory: BrainMemory): Promise<string | undefined> {
  const body = await call(config, '/memories/human', {
    session_id: memory.provenance.sessionId ?? 'chat-marks', type: memory.type, memory_mode: memory.mode,
    title: memory.title, subject: memory.subject, content: memory.content, importance: memory.importance,
    tags: memory.tags, source_name: 'chat-marks', dedup: true
  });
  const id = body?.id ?? body?.memory?.id ?? body?.item?.id;
  return id ? String(id).slice(0, 200) : undefined;
}

export async function marksApiDelete(config: Config, remoteId: string): Promise<void> {
  await call(config, `/memories/${encodeURIComponent(remoteId)}/delete`, {});
}
