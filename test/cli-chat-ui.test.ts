import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createCliModulesUi } from '../src/renderer/cli-modules-ui.js';

const dom = new JSDOM(`<!doctype html>
  <div class="app"><div id="sidebarPrimary"><button id="newChat" type="button">New chat</button><button id="sidebarPets" data-sidebar-page="pets" type="button">Pets</button></div><details id="chatsSection"></details>
  <details id="cliModuleChats"><summary id="cliModuleChatsHeading">Terminals</summary><p id="cliModuleChatsEmpty">No terminal sessions yet.</p></details>
  <div id="chatBody"><div class="view" data-view="timeline"></div></div>
  <div id="composer"></div><div id="composerDock"></div><div class="subhead"></div>
  <nav><button id="moduleCliNav"></button></nav>
  <div data-panel="modules"><div class="appearance-content"></div></div>
  <div data-panel="modules"></div><main id="libraryPanels"><section data-panel="pets"></section></main></div>`, { url: 'http://localhost' });
const bodyMarkup = dom.window.document.body.innerHTML;
const oldDocument = globalThis.document;
const oldWindow = globalThis.window;
const oldResizeObserver = globalThis.ResizeObserver;
const oldCss = globalThis.CSS;
const oldRaf = globalThis.requestAnimationFrame;
const oldCancelRaf = globalThis.cancelAnimationFrame;
const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');

beforeEach(() => {
  dom.window.document.body.innerHTML = bodyMarkup;
  dom.window.matchMedia = (() => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof dom.window.matchMedia;
  dom.window.requestAnimationFrame = callback => dom.window.setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = handle => dom.window.clearTimeout(handle);
  Object.assign(dom.window, { getComputedStyle: dom.window.getComputedStyle.bind(dom.window) });
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    ResizeObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window)
  });
});

afterEach(() => {
  Object.assign(globalThis, { document: oldDocument, window: oldWindow, ResizeObserver: oldResizeObserver, CSS: oldCss,
    requestAnimationFrame: oldRaf, cancelAnimationFrame: oldCancelRaf });
  randomUuid.mockClear();
});

it('routes standalone Codex to managed copy and npm Claude to explicit external update', async () => {
  const actions = vi.fn(async () => ({ ok: true, data: [] }));
  const states = [
    { id: 'codex', name: 'Codex', version: '1.0.0', latest: '1.2.3', installed: true, enabled: true, running: false,
      supported: true, detail: 'ready', external: true, externalNpmWritable: false, updateAvailable: true },
    { id: 'claude', name: 'Claude', version: '1.0.0', latest: '1.2.3', installed: true, enabled: true, running: false,
      supported: true, detail: 'ready', external: true, externalNpmWritable: true, updateAvailable: true }
  ];
  const api = {
    cliStatus: async () => ({ ok: true, data: states }),
    cliSessions: async () => ({ ok: true, data: [] }),
    listProjects: async () => ({ ok: true, data: [] }),
    cliAction: actions
  } as any;
  const confirm = vi.spyOn(dom.window, 'confirm').mockReturnValue(true);
  try {
    createCliModulesUi(api, { showTab: () => undefined, openChatView: () => undefined, workspace: () => null });
    await vi.waitFor(() => expect(dom.window.document.getElementById('codexInstall')?.hasAttribute('hidden')).toBe(false));
    const codex = dom.window.document.getElementById('codexInstall') as HTMLButtonElement;
    expect(codex.textContent).toContain('Chat Marks');
    codex.click();
    await vi.waitFor(() => expect(actions).toHaveBeenCalledWith('codex', 'update', '1.2.3'));
    const claude = dom.window.document.getElementById('claudeInstall') as HTMLButtonElement;
    claude.click();
    await vi.waitFor(() => expect(actions).toHaveBeenCalledWith('claude', 'update-external', '1.2.3'));
    expect(confirm).toHaveBeenCalledTimes(2);
  } finally { confirm.mockRestore(); }
});
it('offers explicit reinstall at the latest version for Codex and Claude', async () => {
  const actions = vi.fn(async () => ({ok:true,data:[]}));
  const states = ['codex','claude'].map(id=>({
    id,name:id,version:'1.2.3',latest:'1.2.3',installed:true,enabled:true,running:true,
    supported:true,detail:'ready',managed:true,external:false,updateAvailable:false
  }));
  const confirm = vi.spyOn(dom.window,'confirm').mockReturnValue(true);
  try {
    createCliModulesUi({
      cliStatus:async()=>({ok:true,data:states}),cliSessions:async()=>({ok:true,data:[]}),
      listProjects:async()=>({ok:true,data:[]}),cliAction:actions
    } as any,{showTab:()=>{},openChatView:()=>{},workspace:()=>null});
    await vi.waitFor(()=>expect(dom.window.document.getElementById('codexInstall')?.hasAttribute('hidden')).toBe(false));
    for(const id of ['codex','claude']) {
      const button=dom.window.document.getElementById(id+'Install') as HTMLButtonElement;
      expect(button.textContent).toContain('1.2.3');
      button.click();
    }
    await vi.waitFor(()=>expect(actions).toHaveBeenCalledWith('codex','update','1.2.3'));
    await vi.waitFor(()=>expect(actions).toHaveBeenCalledWith('claude','update','1.2.3'));
  } finally {confirm.mockRestore();}
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

it('shows each module\'s own icon in its Settings sub-nav item (ZeroClaw: its sidebar item), its Modules card and its page heading', async () => {
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
  // ZeroClaw has no Settings sub-page: its page is a main view opened from the sidebar.
  expect(doc.querySelector('[data-module-page="module-zeroclaw"]')).toBeNull();
  expect(doc.querySelector('[data-panel="module-zeroclaw"]')).toBeNull();
  for (const id of modules) {
    if (id === 'zeroclaw') {
      const item = doc.getElementById('sidebarZeroClaw')!;
      expect(item.querySelector('.module-mark')?.classList.contains(expected[id]!)).toBe(true);
      expect(doc.querySelector(`[data-cli-module="zeroclaw"] h2 .module-mark.${expected[id]}`)).not.toBeNull();
      expect(doc.querySelector(`[data-panel="zeroclaw"] h1 .module-mark.${expected[id]}`)).not.toBeNull();
      continue;
    }
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
  let emitCli: ((event: { id: string; data?: string; exitCode?: number }) => void) | null = null;
  const opened = vi.fn(async (_session: string, attachment: string, cols: number, rows: number) => ({ ok: true as const, data: { id: attachment, cwd: '/home/u', session: `marks_zeroclaw_x:${cols}x${rows}` } }));
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
    cliOpen: opened,
    cliWrite: async () => ({ ok: true as const, data: undefined }), cliResize: async () => ({ ok: true as const, data: undefined }),
    cliDetach: async () => ({ ok: true as const, data: undefined }), cliAck: async () => ({ ok: true as const, data: undefined }),
    onCliEvent: (listener: typeof emitCli) => { emitCli = listener; return () => undefined; },
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
  // Its sidebar item sits right below Pets, shown while the module is enabled, and opens its page.
  const item = doc.getElementById('sidebarZeroClaw')!;
  expect(doc.getElementById('sidebarPets')!.nextElementSibling).toBe(item);
  expect(item.hidden).toBe(false);
  expect(item.dataset.sidebarPage).toBe('zeroclaw');
  expect(item.querySelector('.module-mark.cm-glyph-claw')).not.toBeNull();
  item.click();
  expect(showTab).toHaveBeenLastCalledWith('zeroclaw');
  // The page is a main view beside Pets; the old Settings sub-page name leads to it.
  const page = doc.querySelector<HTMLElement>('[data-panel="zeroclaw"]')!;
  expect(page.parentElement!.id).toBe('libraryPanels');
  expect(page.classList.contains('plugins-panel')).toBe(true);
  expect(page.querySelector('h1 .module-mark.cm-glyph-claw')).not.toBeNull();
  expect(ui.normalizeTab('module-zeroclaw')).toBe('zeroclaw');
  expect(ui.normalizeTab('zeroclaw')).toBe('zeroclaw');
  // The Modules card keeps install and update and links to the page.
  (doc.querySelector('[data-cli-module="zeroclaw"] #zeroclawOpenPage') as HTMLButtonElement).click();
  expect(showTab).toHaveBeenLastCalledWith('zeroclaw');
  (page.querySelector('#zeroclawManageModule') as HTMLButtonElement).click();
  expect(showTab).toHaveBeenLastCalledWith('modules');
  ui.onTabShown('zeroclaw');
  await vi.waitFor(() => expect(page.querySelector('#zeroclawFacts')!.textContent).toContain('helper'));
  expect(page.querySelector('#zeroclawFacts')!.textContent).toContain('127.0.0.1:42617');
  expect(page.querySelector('#zeroclawFacts')!.textContent).toContain('$10.00');
  (page.querySelector('#zeroclawConfigure') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(created).toHaveBeenCalledWith('zeroclaw', null, 'quickstart'));
  await vi.waitFor(() => expect((page.querySelector('#zeroclawSetupTerminal') as HTMLElement).hidden).toBe(false));
  expect(page.querySelector('#zeroclawSetupTerminal .marks-cli-terminal')).not.toBeNull();
  // Main accepts 2-500 columns and 2-200 rows: a pane without height yet must not ask for 1 row.
  await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
  const [, attachment, cols, rows] = opened.mock.calls[0]!;
  expect(cols).toBeGreaterThanOrEqual(2);
  expect(rows).toBeGreaterThanOrEqual(2);
  // ZeroClaw exits: the page says so, the terminal keeps its output, and Configure agent starts it again.
  emitCli!({ id: attachment, data: '[zeroclaw exited with status 1. Press Enter to close.]' });
  emitCli!({ id: attachment, exitCode: 1 });
  await vi.waitFor(() => expect(page.querySelector('#zeroclawConfigureStatus')!.textContent).toContain('Setup ended'));
  (page.querySelector('#zeroclawConfigure') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(2));
  expect(page.querySelector('#zeroclawConfigureStatus')!.textContent).toBe('');
  expect([...doc.querySelectorAll('#cliModuleChats .cli-module-chat-title')].map(node => node.textContent)).toEqual(['Claude shell']);
  // Opening a ZeroClaw session from anywhere goes to its page, never the terminal view.
  await ui.openSession('zc-old');
  expect(showTab).toHaveBeenLastCalledWith('zeroclaw');
  expect(showTab).not.toHaveBeenCalledWith('chat');
});

it('hides the ZeroClaw sidebar item while its module is disabled and sends its page to Settings > Modules', async () => {
  const api = {
    cliStatus: async () => ({ ok: true as const, data: [{ id: 'zeroclaw', name: 'ZeroClaw', installed: true, enabled: false, running: false, supported: true, version: '0.8.6', detail: 'ready', upstream: true }] }),
    cliSessions: async () => ({ ok: true as const, data: [] }),
    listProjects: async () => ({ ok: true as const, data: [] }),
    cliAction: async () => ({ ok: true as const, data: undefined })
  } as any;
  const ui = createCliModulesUi(api, { showTab: () => undefined, openChatView: () => undefined, workspace: () => null });
  const doc = dom.window.document;
  await vi.waitFor(() => expect(doc.querySelector<HTMLInputElement>('[data-cli-module="zeroclaw"] input[type="checkbox"]')!.checked).toBe(false));
  expect(doc.getElementById('sidebarZeroClaw')!.hidden).toBe(true);
  expect(doc.getElementById('zeroclawOpenPage')!.hidden).toBe(true);
  expect(ui.normalizeTab('zeroclaw')).toBe('modules');
  expect(ui.normalizeTab('module-zeroclaw')).toBe('modules');
});

it('lays the ZeroClaw setup terminal out so it has a height (it was 0 px and fitted one row)', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('src/renderer/settings.css', 'utf8');
  const rule = css.match(/\.zeroclaw-setup-terminal > \.marks-cli-terminal \{([^}]*)\}/)?.[1] ?? '';
  expect(rule).toContain('display: flex');
  expect(rule).toContain('flex: 1');
});
