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
  const open = async () => ({ ok: true as const, data: { id: 'module', cwd: '/approved', session: 'marks_markscode' } });
  const api = {
    cliStatus: async () => ({ ok: true as const, data: [{ id: 'markscode', name: 'MarksCode', installed: true, enabled: true, running: true, supported: true, version: '1', detail: 'ready' }] }),
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
  expect(dom.window.document.querySelector('#sidebarPrimary .cli-module-chat')?.textContent).toContain('Novo MarksCode');
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
  await vi.waitFor(() => expect(dom.window.document.querySelector<HTMLButtonElement>('.cli-module-chat:not([hidden])')).toBeTruthy());
  const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.cli-module-chat')]
    .find(item => item.textContent?.includes('Novo Codex'))!;
  button.click();
  await vi.waitFor(() => expect(createSession).toHaveBeenCalledWith('codex', 'project-1'));
  await vi.waitFor(() => expect(openChatView).toHaveBeenCalledWith('cli-module'));
  expect(dom.window.document.querySelector<HTMLElement>('[data-view="cli-module"]')?.hidden).toBe(false);
});
