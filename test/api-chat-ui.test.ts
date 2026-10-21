import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createApiChatUi } from '../src/renderer/api-chat-ui.js';
import { createCliModulesUi } from '../src/renderer/cli-modules-ui.js';

const dom = new JSDOM(`<!doctype html>
  <div class="app"><div id="sidebarPrimary"><button id="newChat" type="button">New chat</button></div>
  <details id="cliModuleChats"></details>
  <section class="panel" data-panel="chat"><section class="card is-session">
    <header class="chat-head"><span id="chatTitle">New chat</span><span id="chatProjectContext" hidden></span></header>
    <div class="subhead"><span id="chatState"></span></div>
    <div id="chatBody"><div class="view" data-view="timeline"></div></div>
    <form id="composer"><div id="composerImages" hidden></div><div id="skillPicker" hidden></div><textarea id="chatInput"></textarea>
      <div class="composer-toolbar"><details id="attachmentMenu"></details><details id="modelMenu"></details>
      <button id="chatSend" type="submit" data-action="send">Send</button></div></form>
    <div id="composerDock"></div>
  </section></section>
  <nav><button id="moduleCliNav"></button></nav>
  <div data-panel="modules"><div class="appearance-content"></div></div></div>`, { url: 'http://localhost' });
const bodyMarkup = dom.window.document.body.innerHTML;
const old = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver, CSS: globalThis.CSS, Event: globalThis.Event };

beforeEach(() => {
  dom.window.document.body.innerHTML = bodyMarkup;
  dom.window.matchMedia = (() => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof dom.window.matchMedia;
  dom.window.requestAnimationFrame = callback => dom.window.setTimeout(() => callback(Date.now()), 0);
  Object.assign(globalThis, {
    document: dom.window.document, window: dom.window, Event: dom.window.Event,
    ResizeObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (value: string) => value },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window)
  });
});

afterEach(() => { Object.assign(globalThis, old); });

const view = (over: Partial<{ model: string | null; effort: 'low' | 'medium' | 'high' | null; running: boolean }> = {}) =>
  ({ sessionId: 'session-api', conversationId: 'cosapi-1', model: 'gpt-5', effort: null, running: false, ...over });

function apiMock(over: Record<string, unknown> = {}) {
  return {
    apiChatStatus: vi.fn(async () => ({ ok: true as const, data: { endpoint: 'http://127.0.0.1:18081/v1', model: 'gpt-5', effort: null, favorites: [], recents: [], hasKey: true, detected: true, keyRequired: false } })),
    apiChatCreate: vi.fn(async () => ({ ok: true as const, data: view() })),
    apiChatSend: vi.fn(async () => ({ ok: true as const, data: { turnId: 'turn-1' } })),
    apiChatStop: vi.fn(async () => ({ ok: true as const, data: { stopped: true } })),
    apiChatChatSettings: vi.fn(async () => ({ ok: true as const, data: view() })),
    apiChatSetChatSettings: vi.fn(async (_id: string, settings: object) => ({ ok: true as const, data: { ...view(), ...settings } })),
    apiChatModels: vi.fn(async () => ({ ok: true as const, data: { total: 3, models: [
      { id: 'claude-sonnet', ownedBy: 'anthropic', modality: 'chat', favorite: true, recent: false, availability: null },
      { id: 'gpt-5', ownedBy: 'openai', modality: 'chat', favorite: false, recent: true, availability: null },
      { id: 'gpt-image-1', ownedBy: 'openai', modality: 'image', favorite: false, recent: false, availability: null }
    ] } })),
    onSessionChanged: vi.fn(() => () => undefined),
    ...over
  } as any;
}

const $ = <T extends HTMLElement>(id: string) => dom.window.document.getElementById(id) as T;
const submit = (submitter?: HTMLElement) => $('composer').dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter ?? null }));

it('offers CLIProxy after ChatGPT in New chat and opens the created API chat in the chat view', async () => {
  const api = { ...apiMock(),
    cliStatus: async () => ({ ok: true as const, data: [] }), cliSessions: async () => ({ ok: true as const, data: [] }),
    listProjects: async () => ({ ok: true as const, data: [] }) } as any;
  let selected: string | null = null;
  const selectChat = vi.fn((id: string) => { selected = id; });
  const showTab = vi.fn();
  let repaint = (): void => undefined;
  const chats = createApiChatUi(api, { showTab, workspace: () => 'project-1', selectChat, selectedChat: () => selected ? { id: selected, conversationId: null } : null }, () => repaint());
  const cli = createCliModulesUi(api, { showTab, openChatView: () => undefined, workspace: () => 'project-1', newChatItems: chats.newChatItems });
  repaint = cli.repaintNewChat;
  await vi.waitFor(() => expect($('newChat').getAttribute('aria-haspopup')).toBe('menu'));
  $('newChat').click();
  const items = await vi.waitFor(() => {
    const found = [...dom.window.document.querySelectorAll<HTMLElement>('[data-row-action^="new-chat-"]')];
    expect(found.length).toBe(2);
    return found;
  });
  expect(items.map(item => item.dataset.rowAction)).toEqual(['new-chat-chatgpt', 'new-chat-cliproxy']);
  expect(items[1]!.textContent).toContain('CLIProxy');
  items[1]!.click();
  await vi.waitFor(() => expect(selectChat).toHaveBeenCalledWith('session-api'));
  expect(api.apiChatCreate).toHaveBeenCalledWith({ projectId: 'project-1' });
  expect(showTab).toHaveBeenCalledWith('chat');
  // The new chat is known as an API chat before the chat list carries its summary.
  chats.sync();
  expect(dom.window.document.querySelector('[data-panel="chat"]')!.classList.contains('is-api-chat')).toBe(true);
  expect($('apiChatLabel').textContent).toBe('CLIProxy · gpt-5');
});

it('opens Modules instead of creating a chat while no default model is set', async () => {
  const api = apiMock({ apiChatStatus: vi.fn(async () => ({ ok: true as const, data: { endpoint: 'http://x/v1', model: null, effort: null, favorites: [], recents: [], hasKey: false, detected: null, keyRequired: false } })) });
  const showTab = vi.fn();
  const chats = createApiChatUi(api, { showTab, workspace: () => null });
  await chats.create();
  expect(api.apiChatCreate).not.toHaveBeenCalled();
  expect(showTab).toHaveBeenCalledWith('modules');
  expect(dom.window.document.querySelector('.toast')?.textContent).toContain('default CLIProxy model');
});

it('sends an API chat through apiChatSend and clears the composer; other chats keep the normal path', async () => {
  const api = apiMock();
  let selected = { id: 'session-api', conversationId: 'cosapi-1' };
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => selected });
  chats.sync();
  const normal = vi.fn((event: Event) => event.preventDefault());
  $('composer').addEventListener('submit', normal);
  $<HTMLTextAreaElement>('chatInput').value = '  hello there ';
  submit();
  await vi.waitFor(() => expect(api.apiChatSend).toHaveBeenCalledWith('session-api', 'hello there'));
  await vi.waitFor(() => expect($<HTMLTextAreaElement>('chatInput').value).toBe(''));
  expect(normal).not.toHaveBeenCalled();

  selected = { id: 'session-chatgpt', conversationId: '11111111-1111-4111-8111-111111111111' };
  chats.sync();
  expect(dom.window.document.querySelector('[data-panel="chat"]')!.classList.contains('is-api-chat')).toBe(false);
  $<HTMLTextAreaElement>('chatInput').value = 'to ChatGPT';
  submit();
  expect(normal).toHaveBeenCalledTimes(1);
  expect(api.apiChatSend).toHaveBeenCalledTimes(1);
});

it('keeps the text and says why when an API send fails or carries attachments', async () => {
  const api = apiMock({ apiChatSend: vi.fn(async () => ({ ok: false as const, error: 'This chat is still answering' })) });
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => ({ id: 'session-api', conversationId: 'cosapi-1' }) });
  chats.sync();
  $<HTMLTextAreaElement>('chatInput').value = 'again';
  submit();
  await vi.waitFor(() => expect(dom.window.document.querySelector('.toast')?.textContent).toBe('This chat is still answering'));
  expect($<HTMLTextAreaElement>('chatInput').value).toBe('again');
  $('composerImages').append(dom.window.document.createElement('div'));
  submit();
  expect(api.apiChatSend).toHaveBeenCalledTimes(1);
  expect(dom.window.document.querySelector('.toast')?.textContent).toContain('Attachments are not available');
});

it('stops the running API turn from the Stop button', async () => {
  const api = apiMock();
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => ({ id: 'session-api', conversationId: 'cosapi-1' }) });
  chats.sync();
  $('chatSend').dataset.action = 'stop';
  submit($('chatSend'));
  await vi.waitFor(() => expect(api.apiChatStop).toHaveBeenCalledWith('session-api'));
  expect(api.apiChatSend).not.toHaveBeenCalled();
});

it('lists chat models with favorites first and saves model and effort for the chat', async () => {
  const api = apiMock();
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => ({ id: 'session-api', conversationId: 'cosapi-1' }) });
  chats.sync();
  const model = $<HTMLSelectElement>('apiChatComposerModel');
  await vi.waitFor(() => expect([...model.options].map(option => option.value)).toEqual(['claude-sonnet', 'gpt-5']));
  await vi.waitFor(() => expect(model.disabled).toBe(false));
  expect(model.value).toBe('gpt-5');
  expect(model.options[0]!.textContent).toBe('★ claude-sonnet');
  model.value = 'claude-sonnet';
  model.dispatchEvent(new dom.window.Event('change'));
  await vi.waitFor(() => expect(api.apiChatSetChatSettings).toHaveBeenCalledWith('session-api', { model: 'claude-sonnet' }));
  await vi.waitFor(() => expect($('apiChatLabel').textContent).toBe('CLIProxy · claude-sonnet'));
  const effort = $<HTMLSelectElement>('apiChatComposerEffort');
  await vi.waitFor(() => expect(effort.disabled).toBe(false));
  effort.value = 'high';
  effort.dispatchEvent(new dom.window.Event('change'));
  await vi.waitFor(() => expect(api.apiChatSetChatSettings).toHaveBeenCalledWith('session-api', { effort: 'high' }));
  effort.value = '';
  effort.dispatchEvent(new dom.window.Event('change'));
  await vi.waitFor(() => expect(api.apiChatSetChatSettings).toHaveBeenCalledWith('session-api', { effort: null }));
});

it('hides the ChatGPT-only composer controls for API chats only', () => {
  const api = apiMock();
  let selected: { id: string; conversationId: string } | null = { id: 'session-api', conversationId: 'cosapi-1' };
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => selected });
  const style = dom.window.document.createElement('style');
  style.textContent = [...readFileSync('src/renderer/settings.css', 'utf8').matchAll(/^\.is-api-chat :is\([^]*?\}/gm)].map(match => match[0]).join('\n');
  dom.window.document.head.append(style);
  chats.sync();
  const panel = dom.window.document.querySelector('[data-panel="chat"]')!;
  expect(panel.classList.contains('is-api-chat')).toBe(true);
  expect($('apiChatControls').hidden).toBe(false);
  for (const id of ['attachmentMenu', 'modelMenu']) expect(dom.window.getComputedStyle($(id)).display).toBe('none');
  const css = readFileSync('src/renderer/settings.css', 'utf8');
  for (const id of ['#composerSettings', '#createPlan', '#contextMeter', '#sendOptions', '#activeGoalRow', '#skillPicker']) expect(css).toMatch(new RegExp(`\\.is-api-chat :is\\([^)]*${id}`));
  selected = null;
  chats.sync();
  expect(panel.classList.contains('is-api-chat')).toBe(false);
  expect($('apiChatControls').hidden).toBe(true);
  expect(dom.window.getComputedStyle($('modelMenu')).display).not.toBe('none');
});
