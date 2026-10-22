import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createCliModulesUi } from '../src/renderer/cli-modules-ui.js';

const dom = new JSDOM(`<!doctype html>
  <div class="app"><div id="sidebarPrimary"><button id="newChat" type="button">New chat</button></div><details id="chatsSection"></details>
  <details id="cliModuleChats"><summary id="cliModuleChatsHeading">Terminals</summary><p id="cliModuleChatsEmpty">No terminal sessions yet.</p></details>
  <div id="chatBody"><div class="view" data-view="timeline"></div></div>
  <div id="composer"></div><div id="composerDock"></div><div class="subhead"></div>
  <nav><button id="moduleCliNav"></button></nav>
  <div data-panel="modules"><div class="appearance-content"></div></div>
  <div data-panel="modules"></div></div>`, { url: 'http://localhost' });
const bodyMarkup = dom.window.document.body.innerHTML;
const oldDocument = globalThis.document;
const oldWindow = globalThis.window;
const oldResizeObserver = globalThis.ResizeObserver;
const oldCss = globalThis.CSS;
const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');

beforeEach(() => {
  dom.window.document.body.innerHTML = bodyMarkup;
  dom.window.matchMedia = (() => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof dom.window.matchMedia;
  dom.window.requestAnimationFrame = callback => dom.window.setTimeout(() => callback(Date.now()), 0);
  Object.assign(dom.window, { getComputedStyle: dom.window.getComputedStyle.bind(dom.window) });
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    ResizeObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (value: string) => value },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window)
  });
});

afterEach(() => {
  Object.assign(globalThis, { document: oldDocument, window: oldWindow, ResizeObserver: oldResizeObserver, CSS: oldCss });
  randomUuid.mockClear();
});

it('shows enabled modules in the terminal details section without a backend selector', async () => {
  const open = async () => ({ ok: true as const, data: { id: 'module', cwd: '/approved', session: 'marks_opencode' } });
  const api = {
    cliStatus: async () => ({ ok: true as const, data: [{ id: 'opencode', name: 'OpenCode', installed: true, enabled: true, running: true, supported: true, version: '1', detail: 'ready' }] }),
    cliSessions: async () => ({ ok: true as const, data: [] }),
    cliOpen: open,
    cliWrite: async () => ({ ok: true as const, data: undefined }),
    cliResize: async () => ({ ok: true as const, data: undefined }),
    cliDetach: async () => ({ ok: true as const, data: undefined }),
    cliAck: async () => ({ ok: true as const, data: undefined }),
    onCliEvent: () => () => undefined,
    listProjects: async () => ({ ok: true as const, data: [] }),
    cliAction: async () => ({ ok: true as const, data: undefined })
  } as any;
  createCliModulesUi(api, { showTab: () => undefined, openChatView: () => undefined, workspace: () => null });
  await new Promise(resolve => setTimeout(resolve, 10));
  const section = dom.window.document.querySelector('#cliModuleChats')!;
  expect(section.matches('details')).toBe(true);
  expect(dom.window.document.querySelector('#chatsSection')!.compareDocumentPosition(section)
    & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(section.querySelector('#cliModuleChatsHeading')?.textContent).toContain('Terminals');
  // The module is offered from New chat's menu, not as a separate sidebar button.
  expect(dom.window.document.querySelector('#sidebarPrimary .cli-module-chat')).toBeNull();
  expect(dom.window.document.getElementById('newChat')?.getAttribute('aria-haspopup')).toBe('menu');
  expect(section.querySelector('#cliModuleChatsEmpty')?.textContent).toContain('No terminal sessions yet.');
  expect(dom.window.document.querySelector('#cliChatBackend')).toBeNull();
});

it('opens the selected CLI module in the central terminal view', async () => {
  const openChatView = vi.fn();
  const createSession = vi.fn(async () => ({ ok: true as const, data: {
    id: '22222222-2222-4222-8222-222222222222', module: 'codex', projectId: 'project-1', cwd: '/approved', title: 'Codex 1',
    tmuxSession: 'marks_codex_1234567890abcdef12', createdAt: 1, updatedAt: 1
  } }));
  const api = {
    cliStatus: async () => ({ ok: true as const, data: [{ id: 'codex', name: 'Codex', installed: true, enabled: true, running: true, supported: true, version: '1', detail: 'ready' }] }),
    cliSessions: async () => ({ ok: true as const, data: [] }),
    cliCreateSession: createSession,
    cliOpen: async () => ({ ok: true as const, data: { id: 'module', cwd: '/approved', session: 'marks_codex' } }),
    cliWrite: async () => ({ ok: true as const, data: undefined }),
    cliResize: async () => ({ ok: true as const, data: undefined }),
    cliDetach: async () => ({ ok: true as const, data: undefined }),
    cliAck: async () => ({ ok: true as const, data: undefined }),
    onCliEvent: () => () => undefined,
    listProjects: async () => ({ ok: true as const, data: [{ id: 'project-1', name: 'Project One', path: '/approved', createdAt: 1 }] }),
    cliAction: async () => ({ ok: true as const, data: undefined })
  } as any;
  createCliModulesUi(api, { showTab: () => undefined, openChatView, workspace: () => 'project-1' });
  await vi.waitFor(() => expect(dom.window.document.getElementById('newChat')?.getAttribute('aria-haspopup')).toBe('menu'));
  dom.window.document.getElementById('newChat')!.click();
  const item = await vi.waitFor(() => {
    const found = dom.window.document.querySelector<HTMLButtonElement>('[data-row-action="new-terminal-codex"]');
    expect(found).toBeTruthy();
    return found!;
  });
  item.click();
  await vi.waitFor(() => expect(createSession).toHaveBeenCalledWith('codex', 'project-1'));
  await vi.waitFor(() => expect(openChatView).toHaveBeenCalledWith('cli-module'));
  expect(dom.window.document.querySelector<HTMLElement>('[data-view="cli-module"]')?.hidden).toBe(false);
});

const statusOf = (enabled: boolean) => ({
  cliStatus: async () => ({ ok: true as const, data: [{ id: 'claude', name: 'Claude', installed: true, enabled, running: true, supported: true, version: '1', detail: 'ready' }] }),
  cliSessions: async () => ({ ok: true as const, data: [] }),
  listProjects: async () => ({ ok: true as const, data: [] }),
  cliAction: async () => ({ ok: true as const, data: undefined })
}) as any;

it('opens one New chat menu whose ChatGPT item keeps the app\'s own new chat', async () => {
  const chatgpt = vi.fn();
  dom.window.document.getElementById('newChat')!.addEventListener('click', chatgpt);
  createCliModulesUi(statusOf(true), { showTab: () => undefined, openChatView: () => undefined, workspace: () => null });
  await vi.waitFor(() => expect(dom.window.document.getElementById('newChat')?.getAttribute('aria-haspopup')).toBe('menu'));
  dom.window.document.getElementById('newChat')!.click();
  expect(chatgpt).not.toHaveBeenCalled();
  const items = await vi.waitFor(() => {
    const found = [...dom.window.document.querySelectorAll<HTMLElement>('.row-menu-item')];
    expect(found.length).toBe(2);
    return found;
  });
  expect(items.map(item => item.dataset.rowAction)).toEqual(['new-chat-chatgpt', 'new-terminal-claude']);
  items[0]!.click();
  await vi.waitFor(() => expect(chatgpt).toHaveBeenCalledTimes(1));
});

it('keeps New chat a plain ChatGPT button while no CLI module is enabled', async () => {
  const chatgpt = vi.fn();
  dom.window.document.getElementById('newChat')!.addEventListener('click', chatgpt);
  createCliModulesUi(statusOf(false), { showTab: () => undefined, openChatView: () => undefined, workspace: () => null });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(dom.window.document.getElementById('newChat')?.hasAttribute('aria-haspopup')).toBe(false);
  dom.window.document.getElementById('newChat')!.click();
  expect(chatgpt).toHaveBeenCalledTimes(1);
  expect(dom.window.document.querySelector('.row-menu')).toBeNull();
});

it('opens the same New chat menu from the Inbox layout\'s compose button', async () => {
  // The Inbox layout draws its own compose button inside the chat list and repaints it.
  const list = dom.window.document.createElement('div');
  list.innerHTML = '<button type="button" data-inbox-control="compose">New chat</button>';
  dom.window.document.querySelector('.app')!.append(list);
  const compose = vi.fn();
  list.querySelector('button')!.addEventListener('click', compose);
  createCliModulesUi(statusOf(true), { showTab: () => undefined, openChatView: () => undefined, workspace: () => null });
  await vi.waitFor(() => expect(dom.window.document.getElementById('newChat')?.getAttribute('aria-haspopup')).toBe('menu'));
  list.querySelector('button')!.click();
  expect(compose).not.toHaveBeenCalled();
  const item = await vi.waitFor(() => {
    const found = dom.window.document.querySelector<HTMLElement>('[data-row-action="new-chat-chatgpt"]');
    expect(found).toBeTruthy();
    return found!;
  });
  expect(dom.window.document.querySelector('[data-row-action="new-terminal-claude"]')).toBeTruthy();
  // ChatGPT keeps the Inbox's own new chat (it starts in the project the Inbox shows).
  item.click();
  await vi.waitFor(() => expect(compose).toHaveBeenCalledTimes(1));
});

it('keeps the Claude terminal module and the Claude Code engine apart when both are enabled', async () => {
  // 2.1.43.3: both items used to be `new-chat-claude`, so one could trigger the other.
  const createSession = vi.fn(async () => ({ ok: false as const, error: 'not in this test' }));
  const engineChat = vi.fn();
  const api = { ...statusOf(true), cliCreateSession: createSession } as any;
  createCliModulesUi(api, {
    showTab: () => undefined, openChatView: () => undefined, workspace: () => 'project-1',
    newChatItems: () => [{ action: 'new-chat-engine-claude', label: () => 'Claude Code', run: engineChat }]
  });
  await vi.waitFor(() => expect(dom.window.document.getElementById('newChat')?.getAttribute('aria-haspopup')).toBe('menu'));
  const open = async (): Promise<HTMLElement[]> => {
    dom.window.document.getElementById('newChat')!.click();
    return vi.waitFor(() => {
      const found = [...dom.window.document.querySelectorAll<HTMLElement>('.row-menu-item')];
      expect(found.length).toBe(3);
      return found;
    });
  };
  const items = await open();
  expect(items.map(item => item.dataset.rowAction)).toEqual(['new-chat-chatgpt', 'new-chat-engine-claude', 'new-terminal-claude']);
  expect(new Set(items.map(item => item.dataset.rowAction)).size).toBe(3);
  items[1]!.click();
  expect(engineChat).toHaveBeenCalledTimes(1);
  expect(createSession).not.toHaveBeenCalled();
  (await open())[2]!.click();
  await vi.waitFor(() => expect(createSession).toHaveBeenCalledWith('claude', 'project-1'));
  expect(engineChat).toHaveBeenCalledTimes(1);
});

it('shows each module\'s own icon in its Settings sub-nav item, its Modules card and its page heading', async () => {
  const modules = ['opencode', 'codex', 'claude', 'zeroclaw'];
  const api = {
    cliStatus: async () => ({ ok: true as const, data: modules.map(id => ({ id, name: id, installed: true, enabled: true, running: false, supported: true, version: '1', detail: 'ready' })) }),
    cliSessions: async () => ({ ok: true as const, data: [] }),
    listProjects: async () => ({ ok: true as const, data: [] }),
    cliAction: async () => ({ ok: true as const, data: undefined })
  } as any;
  createCliModulesUi(api, { showTab: () => undefined, openChatView: () => undefined, workspace: () => null });
  const doc = dom.window.document;
  await vi.waitFor(() => expect(doc.querySelector<HTMLElement>('[data-module-page="module-opencode"]')?.hidden).toBe(false));
  const expected: Record<string, string> = { opencode: 'cm-glyph-opencode', codex: 'cm-glyph-codex', claude: 'cm-glyph-spark', zeroclaw: 'cm-glyph-claw' };
  for (const id of modules) {
    const nav = doc.querySelector<HTMLElement>(`[data-module-page="module-${id}"]`)!;
    const mark = nav.querySelector<HTMLElement>('.module-mark')!;
    expect(mark.dataset.module, id).toBe(id);
    expect(mark.classList.contains(expected[id]!), id).toBe(true);
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(nav.getAttribute('aria-label')).toBe({ opencode: 'OpenCode', codex: 'Codex', claude: 'Claude', zeroclaw: 'ZeroClaw' }[id]);
    expect(doc.querySelector(`[data-cli-module="${id}"] h2 .module-mark.${expected[id]}`), id).not.toBeNull();
    expect(doc.querySelector(`[data-panel="module-${id}"] h1 .module-mark.${expected[id]}`), id).not.toBeNull();
  }
});

it('keeps ZeroClaw out of New chat, the project New terminal list and the sidebar Terminals; its setup and settings live on its own page', async () => {
  const status = (id: string, name: string) => ({ id, name, installed: true, enabled: true, running: false, supported: true, version: '0.8.6', detail: 'ready', upstream: id === 'zeroclaw' });
  const showTab = vi.fn();
  const created = vi.fn(async () => ({ ok: true as const, data: { id: 'zc-setup', module: 'zeroclaw', title: 'ZeroClaw quickstart', projectId: null, args: ['quickstart'], updatedAt: 3, createdAt: 3, cwd: '/home/u', tmuxSession: 'marks_zeroclaw_x' } }));
  const facts = vi.fn(async () => ({ ok: true as const, data: {
    configured: true, agents: [{ alias: 'helper', provider: 'anthropic.default', memory: 'sqlite', enabled: true }], runtime: 'native', gateway: '127.0.0.1:42617', dailyLimitUsd: 10, monthlyLimitUsd: 100
  } }));
  const api = {
    cliStatus: async () => ({ ok: true as const, data: [status('claude', 'Claude'), status('zeroclaw', 'ZeroClaw')] }),
    cliSessions: async () => ({ ok: true as const, data: [
      { id: 'zc-old', module: 'zeroclaw', title: 'ZeroClaw 1', projectId: null, updatedAt: 2 },
      { id: 'cl-1', module: 'claude', title: 'Claude shell', projectId: null, updatedAt: 1 }
    ] }),
    cliCreateSession: created,
    cliOpen: async () => ({ ok: true as const, data: { id: 'a', cwd: '/home/u', session: 'marks_zeroclaw_x' } }),
    cliWrite: async () => ({ ok: true as const, data: undefined }), cliResize: async () => ({ ok: true as const, data: undefined }),
    cliDetach: async () => ({ ok: true as const, data: undefined }), cliAck: async () => ({ ok: true as const, data: undefined }), onCliEvent: () => () => undefined,
    listProjects: async () => ({ ok: true as const, data: [] }),
    cliAction: async () => ({ ok: true as const, data: undefined }),
    upstreamZeroClawFacts: facts
  } as any;
  const ui = createCliModulesUi(api, { showTab, openChatView: () => undefined, workspace: () => null });
  const doc = dom.window.document;
  await vi.waitFor(() => expect(doc.querySelector('#cliModuleChats .cli-module-chat')).not.toBeNull());
  // Sidebar Terminals: only the Claude terminal.
  expect([...doc.querySelectorAll('#cliModuleChats .cli-module-chat-title')].map(node => node.textContent)).toEqual(['Claude shell']);
  // The project's New terminal submenu is built from cliModules(): no ZeroClaw.
  expect(ui.cliModules().map(module => module.id)).toEqual(['claude']);
  // New chat: no ZeroClaw terminal item.
  doc.getElementById('newChat')!.click();
  const items = await vi.waitFor(() => {
    const found = [...doc.querySelectorAll<HTMLElement>('.row-menu-item')].map(item => item.dataset.rowAction);
    expect(found.length).toBeGreaterThan(1);
    return found;
  });
  expect(items).toEqual(['new-chat-chatgpt', 'new-terminal-claude']);
  // Its page: Configure agent opens the quickstart terminal there; settings are read-only facts.
  const page = doc.querySelector<HTMLElement>('[data-panel="module-zeroclaw"]')!;
  expect(page.querySelector('h1 .module-mark.cm-glyph-claw')).not.toBeNull();
  ui.onTabShown('module-zeroclaw');
  await vi.waitFor(() => expect(page.querySelector('#zeroclawFacts')!.textContent).toContain('helper'));
  expect(page.querySelector('#zeroclawFacts')!.textContent).toContain('127.0.0.1:42617');
  expect(page.querySelector('#zeroclawFacts')!.textContent).toContain('$10.00');
  (page.querySelector('#zeroclawConfigure') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(created).toHaveBeenCalledWith('zeroclaw', null, 'quickstart'));
  await vi.waitFor(() => expect((page.querySelector('#zeroclawSetupTerminal') as HTMLElement).hidden).toBe(false));
  expect(page.querySelector('#zeroclawSetupTerminal .marks-cli-terminal')).not.toBeNull();
  expect([...doc.querySelectorAll('#cliModuleChats .cli-module-chat-title')].map(node => node.textContent)).toEqual(['Claude shell']);
  // Opening a ZeroClaw session from anywhere goes to its page, never the terminal view.
  await ui.openSession('zc-old');
  expect(showTab).toHaveBeenLastCalledWith('module-zeroclaw');
  expect(showTab).not.toHaveBeenCalledWith('chat');
});
