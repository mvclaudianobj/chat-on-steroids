import { beforeEach, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({ restart: vi.fn(), update: vi.fn(), uninstall: vi.fn(), authenticate: vi.fn(), cancelAuthentication: vi.fn() }));
const settings = vi.hoisted(() => ({ install: vi.fn(), configure: vi.fn() }));
const rearm = vi.hoisted(() => vi.fn(async () => true));
const onChanged = vi.hoisted(() => vi.fn());
const refreshPublication = vi.hoisted(() => vi.fn());
const vaultStatus = vi.hoisted(() => ({ readable: true, unreadable: false, snapshotSecret: false }));
const secretPresence = vi.hoisted(() => vi.fn(async () => { vaultStatus.unreadable = true; return false; }));
vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }));
vi.mock('../src/main/plugins/manager.js', () => ({ pluginManager: { ...actions, ...settings, snapshot: () => ({ plugins: vaultStatus.snapshotSecret ? [{ id: 'fake', credentialKeys: ['TOKEN'], fields: [], credentialPresence: undefined }] : [] }), onChanged } }));
vi.mock('../src/main/secrets.js', () => ({ secureStorageStatus: async () => ({ available: vaultStatus.readable }), storedSecretsUnreadable: () => vaultStatus.unreadable, hasSecret: secretPresence }));
vi.mock('../src/main/plugin-refresh.js', () => ({ rearmPluginRefresh: rearm }));
vi.mock('../src/main/connection.js', () => ({ refreshPluginPublication: refreshPublication }));
import { registerPluginIpc } from '../src/main/plugins-ipc.js';

let handlers: Map<string, (payload: unknown) => Promise<unknown>>;
let publishStateChange = vi.fn<() => void>();
let sendToRenderer = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vaultStatus.readable = true; vaultStatus.unreadable = false; vaultStatus.snapshotSecret = false;
  handlers = new Map();
  publishStateChange = vi.fn<() => void>();
  sendToRenderer = vi.fn();
  registerPluginIpc(
    (channel, handler) => { handlers.set(channel, handler); },
    () => ({ isDestroyed: () => false, webContents: { send: sendToRenderer } }) as any,
    publishStateChange
  );
});

it.each(Object.keys(actions) as (keyof typeof actions)[])('only explicit successful Restart rearms the connector (%s)', async action => {
  await handlers.get(`plugins:${action}`)!({ id: 'synthetic-plugin' });
  expect(actions[action]).toHaveBeenCalledExactlyOnceWith('synthetic-plugin');
  if (action === 'restart') {
    expect(rearm).toHaveBeenCalledExactlyOnceWith('plugins');
    expect(rearm.mock.invocationCallOrder[0]).toBeGreaterThan(actions.restart.mock.invocationCallOrder[0]!);
  } else expect(rearm).not.toHaveBeenCalled();
});

it('does not create browser retry authority when Restart fails', async () => {
  actions.restart.mockRejectedValueOnce(new Error('Plugin restart failed'));
  await expect(handlers.get('plugins:restart')!({ id: 'synthetic-plugin' })).rejects.toThrow('Plugin restart failed');
  expect(rearm).not.toHaveBeenCalled();
});

it('validates per-plugin Longest call boundaries and type for install and configure IPC', async () => {
  for (const invalid of [0, -1, 1801, 1.5, '300', null, NaN, Infinity]) {
    await expect(handlers.get('plugins:configure')!({ id: 'one', patch: { longestCallSeconds: invalid } })).rejects.toThrow();
    await expect(handlers.get('plugins:install')!({ catalogId: 'memory', longestCallSeconds: invalid })).rejects.toThrow();
  }
  expect(settings.configure).not.toHaveBeenCalled();
  expect(settings.install).not.toHaveBeenCalled();
  await handlers.get('plugins:configure')!({ id: 'one', patch: { longestCallSeconds: 1 } });
  await handlers.get('plugins:configure')!({ id: 'one', patch: { longestCallSeconds: 1800 } });
  await handlers.get('plugins:install')!({ catalogId: 'memory', longestCallSeconds: 120 });
  expect(settings.configure).toHaveBeenNthCalledWith(1, 'one', { longestCallSeconds: 1 });
  expect(settings.configure).toHaveBeenNthCalledWith(2, 'one', { longestCallSeconds: 1800 });
  expect(settings.install).toHaveBeenCalledExactlyOnceWith({ catalogId: 'memory', longestCallSeconds: 120 });
});

it('publishes fresh AppState after a plugin catalog change updates the connector schema', async () => {
  const changed = onChanged.mock.calls[0]?.[0] as (() => void) | undefined;
  expect(changed).toBeTypeOf('function');
  changed!();
  expect(refreshPublication).toHaveBeenCalledExactlyOnceWith('plugins');
  await vi.waitFor(() => expect(sendToRenderer).toHaveBeenCalledExactlyOnceWith('plugins:changed', { plugins: [] }));
  expect(publishStateChange).toHaveBeenCalledTimes(1);
  expect(sendToRenderer.mock.invocationCallOrder[0]).toBeGreaterThan(refreshPublication.mock.invocationCallOrder[0]!);
  // The AppState refresh is published synchronously; the verified credential snapshot
  // follows asynchronously after its OS-store presence checks.
  expect(publishStateChange.mock.invocationCallOrder[0]).toBeLessThan(sendToRenderer.mock.invocationCallOrder[0]!);
});


it('does not mark a credential absent when secure storage becomes unreadable during probing', async () => {
  vaultStatus.snapshotSecret = true;
  const state = await handlers.get('plugins:snapshot')!(undefined) as { plugins: Array<{ credentialPresence?: Record<string, boolean> }> };
  expect(secretPresence).toHaveBeenCalledExactlyOnceWith('plugin:fake:TOKEN');
  expect(vaultStatus.unreadable).toBe(true);
  expect(state.plugins[0]?.credentialPresence).toBeUndefined();
});
