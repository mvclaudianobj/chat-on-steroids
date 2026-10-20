import { beforeEach, describe, expect, it, vi } from 'vitest';

const durable = new Map<string, unknown>();
const secrets = new Map<string, string>();
let revision = 1;
vi.mock('../src/main/durable.js', () => ({
  readDurable: async (name: string) => durable.get(name) ?? null,
  writeDurableNow: async (name: string, value: unknown) => { durable.set(name, structuredClone(value)); }
}));
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  hasSecret: async (key: string) => secrets.has(key),
  setSecret: async (key: string, value: string) => { revision++; if (value.trim()) secrets.set(key, value.trim()); else secrets.delete(key); },
  secretsRevision: () => revision
}));

const { listApiChatModels, parseModelList, resetApiChatCatalogForTests } = await import('../src/main/api-chat/catalog');
const { apiChatStatus, resetApiChatSettingsForTests, setApiChatKey, updateApiChatSettings, API_CHAT_SETTINGS_STATE } = await import('../src/main/api-chat/settings');

const listing = { object: 'list', data: [
  { id: 'gpt-6-sol', owned_by: 'openai' },
  { id: 'gpt-image-2', owned_by: 'openai' },
  { id: 'claude-opus-5-5', owned_by: 'anthropic' },
  { id: 'claude-opus-5-5', owned_by: 'anthropic' },
  { id: 'claude-haiku-5-5', owned_by: 'anthropic' },
  { id: 42 }
] };

beforeEach(() => {
  durable.clear();
  secrets.clear();
  resetApiChatCatalogForTests();
  resetApiChatSettingsForTests();
});

describe('API chat catalogue and settings', () => {
  it('lists chat models once each, without image models, grouped by owner', () => {
    expect(parseModelList(listing).map(model => model.id)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'gpt-6-sol']);
    expect(() => parseModelList({ models: [] })).toThrow('could not read');
  });

  it('searches, pages and caches per endpoint and stored key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(listing)));
    expect(await listApiChatModels({ query: 'opus' }, fetchImpl)).toEqual({ models: [{ id: 'claude-opus-5-5', ownedBy: 'anthropic' }], total: 1 });
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
    expect(await apiChatStatus()).toEqual({ endpoint: 'http://127.0.0.1:18081/v1', model: null, effort: null, hasKey: false });
    await setApiChatKey('sk-secret');
    const status = await apiChatStatus();
    expect(status.hasKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sk-secret');
    await setApiChatKey('');
    expect((await apiChatStatus()).hasKey).toBe(false);
  });

  it('saves a checked endpoint, model and effort, and refuses unsafe or unknown values', async () => {
    await updateApiChatSettings({ endpoint: 'http://localhost:8317/v1/', model: 'claude-opus-5-5', effort: 'high' });
    expect(durable.get(API_CHAT_SETTINGS_STATE)).toEqual({ endpoint: 'http://localhost:8317/v1', model: 'claude-opus-5-5', effort: 'high' });
    await expect(updateApiChatSettings({ endpoint: 'http://10.0.0.2:8317/v1' })).rejects.toThrow('https, or http on this computer');
    await expect(updateApiChatSettings({ effort: 'max' })).rejects.toThrow();
    await expect(updateApiChatSettings({ key: 'sk' })).rejects.toThrow();
    expect((await apiChatStatus()).endpoint).toBe('http://localhost:8317/v1');
  });
});
