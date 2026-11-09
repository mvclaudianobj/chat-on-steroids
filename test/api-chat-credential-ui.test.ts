import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createApiChatSettingsUi } from '../src/renderer/api-chat-settings-ui.js';
import { createCliProxyManageUi } from '../src/renderer/cliproxy-manage-ui.js';

const dom = new JSDOM('<div id="after"></div><div id="card"><div class="modules-service-overview"></div><div class="modules-console"></div></div>', { url: 'http://localhost' });
const original = { document: globalThis.document, window: globalThis.window, Event: globalThis.Event };
const $ = <T extends HTMLElement>(id: string): T => dom.window.document.getElementById(id) as T;
const settle = async (): Promise<void> => { await vi.waitFor(() => undefined); await new Promise(resolve => setTimeout(resolve, 0)); };
beforeEach(() => {
  dom.window.document.body.innerHTML = '<div id="after"></div><div id="card"><div class="modules-service-overview"></div><div class="modules-console"></div></div>';
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, Event: dom.window.Event });
  dom.window.confirm = vi.fn(() => true);
});
afterEach(() => { Object.assign(globalThis, original); vi.restoreAllMocks(); });

it('API chat shows only a saved-state placeholder, never a secret value, and removal is confirmed separately', async () => {
  let presence: 'saved' | 'absent' | 'unavailable' = 'saved';
  const status = () => ({ endpoint: 'http://localhost:8317/v1', model: null, effort: null, favorites: [], recents: [], hasKey: presence === 'saved', keyPresence: presence, detected: null, keyRequired: false });
  const api = {
    apiChatStatus: vi.fn(async () => ({ ok: true as const, data: status() })),
    apiChatModels: vi.fn(async () => ({ ok: true as const, data: { models: [], total: 0 } })),
    apiChatSetKey: vi.fn(async (value: string) => { presence = value ? 'saved' : 'absent'; return { ok: true as const, data: status() }; })
  } as any;
  const ui = createApiChatSettingsUi(api, $('after'));
  await ui.refresh();
  const key = $<HTMLInputElement>('apiChatKey');
  expect(key.value).toBe('');
  expect(key.placeholder).toBe('••••••••');
  expect(key.getAttribute('aria-describedby')).toBe('apiChatKeyState');
  $('apiChatSaveKey').click();
  await settle();
  expect(api.apiChatSetKey).not.toHaveBeenCalled();
  expect($('apiChatRemoveKey')).not.toBeNull();
  $('apiChatRemoveKey').click();
  await vi.waitFor(() => expect(api.apiChatSetKey).toHaveBeenCalledWith(''));
  expect(dom.window.confirm).toHaveBeenCalledOnce();
  expect(key.value).toBe('');
  expect(key.placeholder).toBe('');
  presence = 'unavailable';
  await ui.refresh();
  expect(key.placeholder).toBe('');
  expect($('apiChatKeyState').textContent).not.toContain('No key saved');
});

it('CLIProxy management never deletes on blank Save and separates confirmed removal from replacing the password', async () => {
  let saved = true;
  const status = () => ({ versions: { installed: '8.0.36', installedOfficial: true, latest: '8.0.36', updateAvailable: false, installable: true },
    hasManagementKey: saved, managementKeyValid: null, keys: [], install: null, configRepair: false });
  const api = {
    cliProxyStatus: vi.fn(async () => ({ ok: true as const, data: status() })),
    cliProxySetManagementKey: vi.fn(async (value: string) => { saved = !!value; return { ok: true as const, data: status() }; })
  } as any;
  const ui = createCliProxyManageUi(api, $('card'), () => ({ supported: true, installed: true, running: true, consoleAvailable: true }) as any, async () => undefined, () => ui.paint());
  await ui.refresh();
  const password = $<HTMLInputElement>('cliProxyManagementKey');
  expect(password.value).toBe('');
  expect(password.placeholder).toBe('••••••••');
  expect(password.getAttribute('aria-describedby')).toBe('cliProxyManagementKeyState');
  $('cliProxySaveManagementKey').click();
  await settle();
  expect(api.cliProxySetManagementKey).not.toHaveBeenCalled();
  $('cliProxyRemoveManagementKey').click();
  await vi.waitFor(() => expect(api.cliProxySetManagementKey).toHaveBeenCalledWith(''));
  expect(dom.window.confirm).toHaveBeenCalledOnce();
  expect(password.placeholder).toBe('');
});
