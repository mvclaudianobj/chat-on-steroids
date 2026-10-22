/**
 * Chat Marks H1b: combined recall (TypeScript rewrite of the fork's hybrid.ts) and remote sync.
 * Local memories always; enabled remote providers only while "remote recall" is on, because the
 * query text then leaves the machine. Results are merged, de-duplicated by remote id or content
 * hash, budgeted and labelled with their source. Each provider has its own timeout and error.
 */
import { createHash } from 'node:crypto';
import { BRAIN_PROVIDER_IDS, type BrainMemory, type BrainProviderId, type BrainProviderStatus, type BrainRecallItem, type BrainRecallResult, type BrainSettings } from '../../shared/brain.js';
import { logInfo, logWarn } from '../logger.js';
import { redactSecretText } from '../redaction.js';
import { redactVaultText } from '../marks-vault-redaction.js';
import { brainSearch, brainSetRemote, brainStatus } from './store.js';
import { getBrainSettings } from './settings.js';
import { errorText, ProviderError, vaultCredential, checkTransport, type RemoteHit } from './providers/http.js';
import { aiMemoryRecall, aiMemorySave, aiMemoryStatus } from './providers/ai-memory.js';
import { OPENVIKING_START_HINT, openVikingRecall, openVikingStatus } from './providers/openviking.js';
import { marksApiDelete, marksApiHealth, marksApiRecall, marksApiSave } from './providers/marks-remote.js';

export const PROVIDER_LABELS: Record<BrainProviderId | 'local', string> = { local: 'Local', aiMemory: 'ai-memory', openviking: 'OpenViking', marksApi: 'Marks API' };
const clean = (text: string) => redactVaultText(redactSecretText(text));
const hash = (content: string) => createHash('sha256').update(content.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()).digest('hex');

const recallers: Record<BrainProviderId, (settings: BrainSettings, query: string, limit: number) => Promise<RemoteHit[]>> = {
  aiMemory: (s, q, l) => aiMemoryRecall(s.providers.aiMemory, q, l),
  openviking: (s, q, l) => openVikingRecall(s.providers.openviking, q, l),
  marksApi: (s, q, l) => marksApiRecall(s.providers.marksApi, q, l)
};

export function enabledProviders(settings: BrainSettings = getBrainSettings()): BrainProviderId[] {
  return BRAIN_PROVIDER_IDS.filter(id => settings.providers[id].enabled);
}

/** Local + (optionally) remote, merged and bounded. `maxChars` budgets the returned content. */
export async function combinedRecall(query: string, options: { limit?: number; maxChars?: number; remote?: boolean } = {}): Promise<BrainRecallResult> {
  const settings = getBrainSettings();
  const limit = Math.max(1, Math.min(options.limit ?? 6, 12));
  const maxChars = Math.max(500, Math.min(options.maxChars ?? 12000, 12000));
  const remote = (options.remote ?? settings.remoteRecall) && enabledProviders(settings).length > 0;
  // The query is redacted before it can leave the machine.
  const cue = clean(query).slice(0, 1000);
  const local = brainSearch(query, limit).then(rows => rows.map(localItem)).catch(() => [] as BrainRecallItem[]);
  const errors: BrainRecallResult['errors'] = [];
  const remotes = remote ? enabledProviders(settings).map(async id => {
    try {
      const hits = await recallers[id](settings, cue, limit);
      logInfo(`brain: recall from ${id} returned ${hits.length} result(s)`);
      return hits.map(hit => remoteItem(id, hit));
    } catch (error) {
      const { detail } = errorText(error);
      errors.push({ source: id, error: detail });
      logWarn(`brain: provider ${id} recall failed: ${detail}`);
      return [] as BrainRecallItem[];
    }
  }) : [];
  const groups = await Promise.all([local, ...remotes]);
  const items = mergeRecall(groups, limit, maxChars);
  logInfo(`brain: recall (${query.length} chars) -> ${items.length} result(s)${remote ? `, providers ${enabledProviders(settings).join('+')}` : ', local only'}`);
  return { items, errors, remote };
}

function localItem(memory: BrainMemory): BrainRecallItem {
  return { source: 'local', id: memory.remote?.remoteId ? `${memory.remote.provider}:${memory.remote.remoteId}` : memory.id, content: memory.content, ...(memory.title ? { title: memory.title } : {}), contentHash: memory.contentHash };
}
function remoteItem(source: BrainProviderId, hit: RemoteHit): BrainRecallItem {
  const content = clean(hit.content);
  const contentHash = hash(content);
  return { source, id: hit.remoteId ? `${source}:${hit.remoteId}` : `${source}:${contentHash.slice(0, 16)}`, content,
    ...(hit.title ? { title: clean(hit.title) } : {}), ...(typeof hit.score === 'number' ? { score: hit.score } : {}), contentHash };
}

/** Round-robin across sources (local first) so one provider cannot crowd out the others. */
export function mergeRecall(groups: BrainRecallItem[][], limit: number, maxChars: number): BrainRecallItem[] {
  const seenIds = new Set<string>(), seenHashes = new Set<string>();
  const out: BrainRecallItem[] = [];
  let used = 0;
  const queues = groups.map(group => [...group]);
  while (out.length < limit && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      const item = queue.shift();
      if (!item || out.length >= limit) continue;
      if (seenIds.has(item.id) || seenHashes.has(item.contentHash)) continue;
      seenIds.add(item.id); seenHashes.add(item.contentHash);
      const room = maxChars - used;
      if (room <= 40) return out;
      const content = item.content.length > room ? `${item.content.slice(0, room - 1)}…` : item.content;
      used += content.length;
      out.push({ ...item, content });
    }
  }
  return out;
}

/** The model-facing / draft block: data, never instructions, with each item's source. */
export function formatRecall(items: BrainRecallItem[]): string {
  const body = items.map(item => `[${PROVIDER_LABELS[item.source]}] ${item.title ? `${item.title}: ` : ''}${item.content}`).join('\n\n');
  return `<memory-context>\n${body.replaceAll('</memory-context>', '&lt;/memory-context&gt;')}\n</memory-context>`;
}

/** Remote sync after a local save. Never throws; never runs unless the user enabled it. */
export async function syncSavedMemory(memory: BrainMemory): Promise<Array<{ source: BrainProviderId; ok: boolean; error?: string }>> {
  const settings = getBrainSettings();
  if (!settings.remoteSync || memory.provenance.source === 'import') return [];
  const results: Array<{ source: BrainProviderId; ok: boolean; error?: string }> = [];
  for (const id of enabledProviders(settings)) {
    try {
      let remoteId: string | undefined;
      if (id === 'aiMemory') remoteId = await aiMemorySave(settings.providers.aiMemory, memory);
      else if (id === 'marksApi') remoteId = await marksApiSave(settings.providers.marksApi, memory);
      else continue; // OpenViking captures through its own sessions; Brain does not write there.
      if (remoteId) await brainSetRemote(memory.id, { provider: id, remoteId, syncedAt: Date.now() }).catch(() => undefined);
      logInfo(`brain: synced memory to ${id}`);
      results.push({ source: id, ok: true });
    } catch (error) {
      const { detail } = errorText(error);
      logWarn(`brain: provider ${id} sync failed: ${detail}`);
      results.push({ source: id, ok: false, error: detail });
    }
  }
  return results;
}

/** Removes the remote copy of a synced memory when remote sync is still on. */
export async function deleteRemoteCopy(memory: BrainMemory | null): Promise<void> {
  const settings = getBrainSettings();
  if (!memory?.remote || !settings.remoteSync || memory.remote.provider !== 'marksApi' || !settings.providers.marksApi.enabled) return;
  try { await marksApiDelete(settings.providers.marksApi, memory.remote.remoteId); logInfo('brain: deleted remote copy on marksApi'); }
  catch (error) { logWarn(`brain: provider marksApi delete failed: ${errorText(error).detail}`); }
}

/** Status for Doctor/Sources; probes only enabled providers, read-only. */
export async function providerStatuses(probe = true): Promise<BrainProviderStatus[]> {
  const settings = getBrainSettings();
  const local = await brainStatus();
  const rows: BrainProviderStatus[] = [{ id: 'local', label: PROVIDER_LABELS.local, enabled: true, state: local.available ? 'ok' : 'error', count: local.count, ...(local.available ? {} : { detail: 'Local database unavailable' }) }];
  for (const id of BRAIN_PROVIDER_IDS) {
    const config = settings.providers[id];
    const base: BrainProviderStatus = { id, label: PROVIDER_LABELS[id], enabled: config.enabled, state: 'disabled', url: config.url };
    try {
      const url = checkTransport(config.url, id === 'marksApi' ? settings.providers.marksApi.insecureHttp : false);
      base.hasKey = !!(await vaultCredential(config.secret, url.origin).catch(() => null));
    } catch { base.hasKey = false; }
    if (!config.enabled || !probe) { rows.push(base); continue; }
    try {
      if (id === 'aiMemory') {
        const status = await aiMemoryStatus(settings.providers.aiMemory);
        base.detail = `${status.tools.length} tools; search ${status.search ?? 'missing'}, save ${status.save ?? 'missing'}`;
      } else if (id === 'openviking') {
        const status = await openVikingStatus(settings.providers.openviking);
        base.detail = status.user ? `user ${status.user}` : 'running';
      } else {
        await marksApiHealth(settings.providers.marksApi);
        base.detail = settings.providers.marksApi.url.startsWith('http:') ? 'health OK over insecure HTTP' : 'health OK';
      }
      base.state = 'ok';
    } catch (error) {
      const { state, detail } = errorText(error);
      base.state = state; base.detail = id === 'openviking' && state === 'stopped' && !detail.includes('openviking-server') ? `${detail}. ${OPENVIKING_START_HINT}` : detail;
      logWarn(`brain: provider ${id} status ${state}: ${base.detail}`);
    }
    rows.push(base);
  }
  return rows;
}
export { ProviderError };
