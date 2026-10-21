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

const engineList = (available: string[] = ['cliproxy']) => (['cliproxy', 'markscode', 'codex', 'claude'] as const).map(id => ({
  id, label: { cliproxy: 'CLIProxy', markscode: 'MarksCode', codex: 'Codex', claude: 'Claude Code' }[id], available: available.includes(id), detail: '',
  terminal: id === 'cliproxy' ? null : id === 'claude' ? 'handover' : 'live'
}));

function apiMock(over: Record<string, unknown> = {}) {
  return {
    apiChatStatus: vi.fn(async () => ({ ok: true as const, data: { endpoint: 'http://127.0.0.1:18081/v1', model: 'gpt-5', effort: null, favorites: [], recents: [], hasKey: true, detected: true, keyRequired: false } })),
    // Main's engine registry: only CLIProxy is available; the reserved engines are listed unavailable.
    apiChatEngines: vi.fn(async () => ({ ok: true as const, data: engineList() })),
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

it("offers a CLIProxy chat in a project's menu that belongs to that project, not the selected one", async () => {
  const api = apiMock();
  const selectChat = vi.fn();
  const chats = createApiChatUi(api, { showTab: vi.fn(), workspace: () => 'selected-project', selectChat, selectedChat: () => null });
  const items = await vi.waitFor(() => {
    const found = chats.projectChatItems('menu-project');
    expect(found).toHaveLength(1);
    return found;
  });
  expect(items[0]!.action).toBe('new-chat-cliproxy');
  expect(items[0]!.label()).toBe('New CLIProxy chat in this project');
  items[0]!.run!();
  await vi.waitFor(() => expect(api.apiChatCreate).toHaveBeenCalledWith({ projectId: 'menu-project' }));
  await vi.waitFor(() => expect(selectChat).toHaveBeenCalledWith('session-api'));
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

it('shows a pending edit or command, answers exactly that approval and switches the approval mode', async () => {
  const pending = { approvalId: '0f1e2d3c-aaaa-4bbb-8ccc-0123456789ab', turnId: 'api-1', toolCallId: 'call_1', tool: 'apply_patch',
    summary: '4 patch lines', files: ['add /work/made.txt'], requestedAt: 1 };
  let current: any = { ...view({ running: true }), approval: 'ask', pending };
  const api = apiMock({
    apiChatChatSettings: vi.fn(async () => ({ ok: true as const, data: current })),
    apiChatApprove: vi.fn(async () => { current = { ...current, pending: null }; return { ok: true as const, data: current }; }),
    apiChatSetChatSettings: vi.fn(async (_id: string, settings: object) => { current = { ...current, ...settings }; return { ok: true as const, data: current }; })
  });
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => ({ id: 'session-api', conversationId: 'cosapi-1' }) });
  chats.sync();
  const card = $('apiChatApproval');
  await vi.waitFor(() => expect(card.hidden).toBe(false));
  expect(card.textContent).toContain('apply_patch');
  expect(card.textContent).toContain('add /work/made.txt');
  expect([...card.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Approve', 'Deny', "Approve and don't ask again in this chat"]);
  card.querySelector<HTMLButtonElement>('[data-decision="deny"]')!.click();
  await vi.waitFor(() => expect(api.apiChatApprove).toHaveBeenCalledWith('session-api', pending.approvalId, 'deny'));
  await vi.waitFor(() => expect(card.hidden).toBe(true));
  const mode = $<HTMLSelectElement>('apiChatComposerApproval');
  expect(mode.value).toBe('ask');
  mode.value = 'auto';
  mode.dispatchEvent(new dom.window.Event('change'));
  await vi.waitFor(() => expect(api.apiChatSetChatSettings).toHaveBeenCalledWith('session-api', { approval: 'auto' }));
  await vi.waitFor(() => expect(mode.value).toBe('auto'));
});

it('offers only the engines main reports available, in New chat and in a project menu', async () => {
  const api = apiMock({ apiChatEngines: vi.fn(async () => ({ ok: true as const, data: engineList(['cliproxy', 'codex']) })) });
  const chats = createApiChatUi(api, { showTab: vi.fn(), workspace: () => 'project-1', selectChat: vi.fn(), selectedChat: () => null });
  await vi.waitFor(() => expect(chats.newChatItems()).toHaveLength(2));
  expect(chats.newChatItems().map(item => `${item.action}=${item.label()}`)).toEqual(['new-chat-cliproxy=CLIProxy', 'new-chat-codex=Codex']);
  expect(chats.newChatItems()[1]!.title!()).toBe('Chat with Codex');
  expect(chats.projectChatItems('menu-project').map(item => item.label())).toEqual(['New CLIProxy chat in this project', 'New Codex chat in this project']);
  // A CLI engine needs no CLIProxy setup: the chat is created on that engine, in that project.
  chats.projectChatItems('menu-project')[1]!.run!();
  await vi.waitFor(() => expect(api.apiChatCreate).toHaveBeenCalledWith({ projectId: 'menu-project', engine: 'codex' }));
  expect(api.apiChatStatus).toHaveBeenCalledTimes(0);
});

it('offers nothing before the registry answers or when it fails', async () => {
  const api = apiMock({ apiChatEngines: vi.fn(async () => ({ ok: false as const, error: 'Window not authorized' })) });
  const chats = createApiChatUi(api, { showTab: vi.fn(), workspace: () => null });
  expect(chats.newChatItems()).toEqual([]);
  await vi.waitFor(() => expect(api.apiChatEngines).toHaveBeenCalled());
  await chats.refresh();
  expect(chats.newChatItems()).toEqual([]);
  expect(chats.projectChatItems('p')).toEqual([]);
});

it("names the chat's engine in the header and loads that engine's models", async () => {
  const api = apiMock({
    apiChatChatSettings: vi.fn(async () => ({ ok: true as const, data: { ...view({ model: 'gpt-6-codex' }), engine: 'codex', approval: 'ask', pending: null } })),
    apiChatModels: vi.fn(async () => ({ ok: true as const, data: { total: 1, models: [{ id: 'gpt-6-codex', ownedBy: 'openai', modality: 'chat', favorite: false, recent: false, availability: null }] } }))
  });
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => ({ id: 'session-api', conversationId: 'cosapi-1' }) });
  chats.sync();
  await vi.waitFor(() => expect($('apiChatLabel').textContent).toBe('Codex · gpt-6-codex'));
  await vi.waitFor(() => expect(api.apiChatModels).toHaveBeenCalledWith('', 0, 200, false, 'codex'));
  await vi.waitFor(() => expect([...$<HTMLSelectElement>('apiChatComposerModel').options].map(option => option.value)).toEqual(['gpt-6-codex']));
});

it("opens a Codex chat's live terminal even while it answers, and limits efforts to the model's own", async () => {
  const api = apiMock({
    apiChatChatSettings: vi.fn(async () => ({ ok: true as const, data: { ...view({ model: 'gpt-6-codex' }), engine: 'codex', approval: 'ask', pending: null, running: true } })),
    apiChatModels: vi.fn(async () => ({ ok: true as const, data: { total: 1, models: [{ id: 'gpt-6-codex', ownedBy: 'openai', modality: 'chat', favorite: false, recent: false, availability: null, efforts: ['low', 'medium'] }] } })),
    apiChatTerminal: vi.fn(async () => ({ ok: true as const, data: { cliSessionId: 'cli-codex-1' } }))
  });
  const openCliSession = vi.fn();
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => ({ id: 'session-api', conversationId: 'cosapi-1' }), openCliSession });
  chats.sync();
  await vi.waitFor(() => expect($('apiChatTerminal').hidden).toBe(false));
  expect($<HTMLButtonElement>('apiChatTerminal').disabled).toBe(false);
  expect($('apiChatTerminal').title).toBe("Open this chat's Codex session in a terminal");
  await vi.waitFor(() => expect([...$<HTMLSelectElement>('apiChatComposerEffort').options].filter(option => option.disabled).map(option => option.value)).toEqual(['high']));
  $('apiChatTerminal').click();
  await vi.waitFor(() => expect(openCliSession).toHaveBeenCalledWith('cli-codex-1'));
  expect(api.apiChatTerminal).toHaveBeenCalledWith('session-api');
});

it('waits for a running Claude Code turn before its hand-over terminal', async () => {
  const api = apiMock({
    apiChatChatSettings: vi.fn(async () => ({ ok: true as const, data: { ...view({ model: 'opus' }), engine: 'claude', approval: 'ask', pending: null, running: true } }))
  });
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => ({ id: 'session-api', conversationId: 'cosapi-1' }), openCliSession: vi.fn() });
  chats.sync();
  await vi.waitFor(() => expect($('apiChatTerminal').hidden).toBe(false));
  expect($<HTMLButtonElement>('apiChatTerminal').disabled).toBe(true);
  expect($('apiChatTerminal').title).toBe('Continue this chat in a terminal. The app stops its own session first; your next message here resumes it.');
});

it('offers Claude Code once main reports it available, and opens a Claude chat in its hand-over terminal', async () => {
  const api = apiMock({
    apiChatEngines: vi.fn(async () => ({ ok: true as const, data: engineList(['cliproxy', 'claude']) })),
    apiChatChatSettings: vi.fn(async () => ({ ok: true as const, data: { ...view({ model: 'opus' }), engine: 'claude', approval: 'ask', pending: null } })),
    apiChatTerminal: vi.fn(async () => ({ ok: true as const, data: { cliSessionId: 'cli-claude-1' } }))
  });
  const openCliSession = vi.fn();
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, openCliSession, selectedChat: () => ({ id: 'session-api', conversationId: 'cosapi-1' }) });
  await vi.waitFor(() => expect(chats.newChatItems().map(item => item.action)).toEqual(['new-chat-cliproxy', 'new-chat-claude']));
  expect(chats.newChatItems()[1]!.label()).toBe('Claude Code');
  expect(chats.projectChatItems('p')[1]!.label()).toBe('New Claude Code chat in this project');
  chats.sync();
  await vi.waitFor(() => expect($('apiChatLabel').textContent).toBe('Claude Code · opus'));
  await vi.waitFor(() => expect($('apiChatTerminal').hidden).toBe(false));
  $('apiChatTerminal').click();
  await vi.waitFor(() => expect(openCliSession).toHaveBeenCalledWith('cli-claude-1'));
  expect(api.apiChatTerminal).toHaveBeenCalledWith('session-api');
});

it('keeps the terminal button hidden for a CLIProxy chat', async () => {
  const api = apiMock({ apiChatChatSettings: vi.fn(async () => ({ ok: true as const, data: { ...view(), engine: 'cliproxy', approval: 'ask', pending: null } })) });
  const chats = createApiChatUi(api, { showTab: () => undefined, workspace: () => null, selectedChat: () => ({ id: 'session-api', conversationId: 'cosapi-1' }) });
  chats.sync();
  await vi.waitFor(() => expect($('apiChatLabel').textContent).toBe('CLIProxy · gpt-5'));
  expect($('apiChatTerminal').hidden).toBe(true);
});
