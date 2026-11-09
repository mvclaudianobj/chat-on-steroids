import { beforeEach, describe, expect, it, vi } from 'vitest';

const durable = new Map<string, unknown>();
const secrets = new Map<string, string>();
let revision = 1;
let storageAvailable = true;
let unreadable = false;
vi.mock('../src/main/durable.js', () => ({
  readDurable: async (name: string) => durable.get(name) ?? null,
  writeDurableNow: async (name: string, value: unknown) => { durable.set(name, structuredClone(value)); }
}));
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  hasSecret: async (key: string) => secrets.has(key),
  secureStorageStatus: async () => ({ available: storageAvailable, detail: storageAvailable ? null : 'unavailable' }),
  storedSecretsUnreadable: () => unreadable,
  setSecret: async (key: string, value: string) => { revision++; if (value.trim()) secrets.set(key, value.trim()); else secrets.delete(key); },
  secretsRevision: () => revision
}));

const { listApiChatModels, parseModelList, resetApiChatCatalogForTests } = await import('../src/main/api-chat/catalog');
const { testApiChat } = await import('../src/main/api-chat/ipc');
const { apiChatStatus, resetApiChatSettingsForTests, setApiChatKey, toggleFavoriteModel, noteRecentModel, updateApiChatSettings, API_CHAT_SETTINGS_STATE } = await import('../src/main/api-chat/settings');

const listing = { object: 'list', data: [
  { id: 'gpt-6-sol', owned_by: 'openai' },
  { id: 'gpt-image-2', owned_by: 'openai' },
  { id: 'claude-opus-5-5', owned_by: 'anthropic' },
  { id: 'claude-opus-5-5', owned_by: 'anthropic' },
  { id: 'claude-haiku-5-5', owned_by: 'anthropic' },
  { id: 42 }
] };

beforeEach(() => {
  storageAvailable = true;
  unreadable = false;
  durable.clear();
  secrets.clear();
  resetApiChatCatalogForTests();
  resetApiChatSettingsForTests();
});

describe('API chat catalogue and settings', () => {
  it('keeps every listed model once, with its exact id, classified by modality', () => {
    expect(parseModelList(listing).map(model => `${model.id}:${model.modality}`)).toEqual(['claude-haiku-5-5:chat', 'claude-opus-5-5:chat', 'gpt-6-sol:chat', 'gpt-image-2:image']);
    expect(() => parseModelList({ models: [] })).toThrow('could not read');
  });

  it('searches, pages and caches per endpoint and stored key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(listing)));
    expect(await listApiChatModels({ query: 'opus' }, fetchImpl)).toEqual({ models: [{ id: 'claude-opus-5-5', ownedBy: 'anthropic', modality: 'chat', favorite: false, recent: false, availability: null }], total: 1 });
    expect((await listApiChatModels({ modality: 'image' }, fetchImpl)).models.map(model => model.id)).toEqual(['gpt-image-2']);
    expect((await listApiChatModels({}, fetchImpl)).models.some(model => model.modality !== 'chat')).toBe(false);
    expect((await listApiChatModels({ offset: 1, limit: 1 }, fetchImpl)).models.map(model => model.id)).toEqual(['claude-opus-5-5']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:18081/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    // A new key is a new scope: the listing is fetched again, now with the key.
    await setApiChatKey('sk-new');
    await listApiChatModels({}, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe('Bearer sk-new');
  });

  it('reports whether a key is stored without ever returning it', async () => {
    expect(await apiChatStatus()).toEqual({ endpoint: 'http://127.0.0.1:18081/v1', model: null, effort: null, favorites: [], recents: [], hasKey: false, keyPresence: 'absent', detected: null, keyRequired: false });
    await setApiChatKey('sk-secret');
    const status = await apiChatStatus();
    expect(status.hasKey).toBe(true);
    expect(status.keyPresence).toBe('saved');
    expect(JSON.stringify(status)).not.toContain('sk-secret');
    await setApiChatKey('');
    expect((await apiChatStatus()).hasKey).toBe(false);
    expect((await apiChatStatus()).keyPresence).toBe('absent');
  });

  it('never mistakes locked or unreadable secure storage for an absent API key', async () => {
    await setApiChatKey('synthetic-token');
    storageAvailable = false;
    expect(await apiChatStatus()).toMatchObject({ hasKey: false, keyPresence: 'unavailable', keyRequired: false });
    storageAvailable = true;
    unreadable = true;
    expect(await apiChatStatus()).toMatchObject({ hasKey: false, keyPresence: 'unavailable' });
    unreadable = false;
    expect(await apiChatStatus()).toMatchObject({ hasKey: true, keyPresence: 'saved' });
  });

  it('saves a checked endpoint, model and effort, and refuses unsafe or unknown values', async () => {
    await updateApiChatSettings({ endpoint: 'http://localhost:8317/v1/', model: 'claude-opus-5-5', effort: 'high' });
    expect(durable.get(API_CHAT_SETTINGS_STATE)).toEqual({ endpoint: 'http://localhost:8317/v1', model: 'claude-opus-5-5', effort: 'high', favorites: [], recents: [] });
    await expect(updateApiChatSettings({ endpoint: 'http://10.0.0.2:8317/v1' })).rejects.toThrow('https, or http on this computer');
    await expect(updateApiChatSettings({ effort: 'max' })).rejects.toThrow();
    await expect(updateApiChatSettings({ key: 'sk' })).rejects.toThrow();
    expect((await apiChatStatus()).endpoint).toBe('http://localhost:8317/v1');
  });
});

describe('API chat favorites, recents, detection and availability', () => {
  const fetchList = vi.fn(async () => new Response(JSON.stringify(listing)));

  it('puts favorites first, then recents, then providers', async () => {
    await toggleFavoriteModel('gpt-6-sol');
    await noteRecentModel('claude-opus-5-5');
    const { models } = await listApiChatModels({}, fetchList);
    expect(models.map(model => [model.id, model.favorite, model.recent])).toEqual([
      ['gpt-6-sol', true, false], ['claude-opus-5-5', false, true], ['claude-haiku-5-5', false, false]
    ]);
    await toggleFavoriteModel('gpt-6-sol');
    expect((await apiChatStatus()).favorites).toEqual([]);
  });

  it('learns detection from the model list and an unanswered endpoint', async () => {
    await listApiChatModels({}, fetchList);
    expect((await apiChatStatus()).detected).toBe(true);
    resetApiChatCatalogForTests();
    await expect(listApiChatModels({}, async () => { throw new TypeError('connect ECONNREFUSED'); })).rejects.toThrow('Nothing answered at http://127.0.0.1:18081/v1');
    expect((await apiChatStatus()).detected).toBe(false);
  });

  it('records a model as available only after a real request, and asks for a key when refused without one', async () => {
    await updateApiChatSettings({ model: 'claude-opus-5-5' });
    const refused = async () => new Response(JSON.stringify({ error: { message: 'Missing API key' } }), { status: 401 });
    await expect(testApiChat(undefined, refused)).rejects.toThrow('HTTP 401: Missing API key');
    expect((await apiChatStatus()).keyRequired).toBe(true);
    let row = (await listApiChatModels({ query: 'opus' }, fetchList)).models[0]!;
    expect(row.availability).toMatchObject({ ok: false, error: 'HTTP 401: Missing API key' });
    await setApiChatKey('sk-ok');
    expect((await apiChatStatus()).keyRequired).toBe(false);
    const answered = async () => new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    expect(await testApiChat(undefined, answered)).toEqual({ model: 'claude-opus-5-5' });
    row = (await listApiChatModels({ query: 'opus', refresh: true }, fetchList)).models[0]!;
    expect(row.availability).toMatchObject({ ok: true });
  });
});
