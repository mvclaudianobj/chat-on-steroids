import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const xterm = vi.hoisted(() => {
  type KeyHandler = (event: KeyboardEvent) => boolean;
  class FakeTerminal {
    static last: FakeTerminal | null = null;
    options: Record<string, unknown>; cols = 80; rows = 24;
    selection = ''; selectionListeners: (() => void)[] = []; keyHandler: KeyHandler | null = null;
    pasted: string[] = []; provider: { provideLinks: (line: number, callback: (links: unknown[]) => void) => void } | null = null;
    constructor(options: Record<string, unknown>) { this.options = options; FakeTerminal.last = this; }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(): void {}
    writeln(): void {}
    dispose(): void {}
    onData(): void {}
    onSelectionChange(listener: () => void): void { this.selectionListeners.push(listener); }
    attachCustomKeyEventHandler(handler: KeyHandler): void { this.keyHandler = handler; }
    hasSelection(): boolean { return this.selection.length > 0; }
    getSelection(): string { return this.selection; }
    clearSelection(): void { this.select(''); }
    paste(value: string): void { this.pasted.push(value); }
    registerLinkProvider(provider: typeof this.provider): void { this.provider = provider; }
    buffer = { active: { getLine: () => ({ translateToString: () => 'Open https://example.org/login now' }) } };
    select(text: string): void { this.selection = text; for (const listener of this.selectionListeners) listener(); }
  }
  return { FakeTerminal };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { draftWithTerminalBlock, MAX_TERMINAL_CHARACTERS, sendTerminalSelection, terminalSelectionBlock } from '../src/renderer/terminal-selection.js';
import { createWorkspaceTerminal } from '../src/renderer/workspace-terminal.js';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.unstubAllGlobals(); });

it('fences the selected lines without the blank lines and trailing spaces around them', () => {
  expect(terminalSelectionBlock('\n\n$ npm test   \n  Error: boom\n    at run (file.js:1:1)  \n\n')).toBe(
    '```\n$ npm test\n  Error: boom\n    at run (file.js:1:1)\n```');
  expect(terminalSelectionBlock('\r\n  \r\n')).toBeNull();
});

it('opens the fence with more backticks than any run in the output', () => {
  expect(terminalSelectionBlock('echo ```\n````')).toBe('`````\necho ```\n````\n`````');
});

it('keeps the last 400 lines of a long selection and says how many were selected', () => {
  const lines = Array.from({ length: 5_000 }, (_, index) => `line ${index + 1}`);
  const block = terminalSelectionBlock(lines.join('\n'))!;
  expect(block.startsWith('Only the end of the selection is here: the last 400 of 5,000 lines.\n\n```\nline 4601\n')).toBe(true);
  expect(block.endsWith('line 5000\n```')).toBe(true);
});

it('keeps whole lines under the character cap, and the end of one line longer than the cap', () => {
  const lines = Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(300, '.'));
  const block = terminalSelectionBlock(lines.join('\n'))!;
  const kept = Math.floor((MAX_TERMINAL_CHARACTERS + 1) / 301);
  expect(block).toContain(`the last ${kept} of 100 lines.`);
  expect(block.split('\n').slice(3, -1)).toEqual(lines.slice(-kept));
  const long = terminalSelectionBlock(`${'a'.repeat(30_000)}tail`)!;
  expect(long.startsWith('Only the end of the selection is here: the last 20,000 characters.\n\n```\n')).toBe(true);
  expect(long.split('\n')[3]).toBe(`${'a'.repeat(MAX_TERMINAL_CHARACTERS - 4)}tail`);
});

it('puts the block after the typed draft with an empty line to write on', () => {
  expect(draftWithTerminalBlock('', '```\nx\n```')).toBe('```\nx\n```\n\n');
  expect(draftWithTerminalBlock('Why does this fail?\n\n', '```\nx\n```')).toBe('Why does this fail?\n\n```\nx\n```\n\n');
});

function setup(loginTerminal = false) {
  dom = new JSDOM('<div class="app"><div id="dock"></div><form id="composer"><textarea id="chatInput"></textarea></form></div>', { pretendToBeVisual: true });
  const { window } = dom;
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal('navigator', { platform: 'Win32' });
  let eventListener: ((event: { id: string; data?: string }) => void) | null = null;
  Object.assign(window, { api: {
    terminalCreate: vi.fn(async () => ({ ok: true, data: { shell: 'bash', cwd: '/home/you' } })),
    terminalResize: vi.fn(), terminalClose: vi.fn(), terminalWrite: vi.fn(), terminalAck: vi.fn(),
    writeClipboard: vi.fn(), readClipboard: vi.fn(async () => ({ ok: true, data: 'Pasted code' })),
    openLink: vi.fn(), onTerminalEvent: (listener: typeof eventListener) => { eventListener = listener; return () => {}; }
  } });
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  const submitted = vi.fn(); document.getElementById('composer')!.addEventListener('submit', submitted);
  const terminal = createWorkspaceTerminal(() => {}, document.getElementById('dock')!,
    { onSendSelection: text => sendTerminalSelection(input, text), loginTerminal });
  terminal.newTab();
  return { input, submitted, term: xterm.FakeTerminal.last!, send: document.querySelector<HTMLButtonElement>('.terminal-send')!,
    emit: (event: { id: string; data?: string }) => eventListener?.(event), tabId: () => terminal.tabs()[0]!.id };
}

it('shows Send to chat while the shell has a selection and adds it to the draft without sending', () => {
  const { input, submitted, term, send } = setup();
  expect(send.hidden).toBe(true);
  input.value = 'Why does this fail?';
  term.select('$ make\nmake: *** [all] Error 2');
  expect(send.hidden).toBe(false);
  expect(send.title).toBe('Send to chat (Ctrl+Shift+Enter)');
  send.click();
  expect(input.value).toBe('Why does this fail?\n\n```\n$ make\nmake: *** [all] Error 2\n```\n\n');
  expect(input.selectionStart).toBe(input.value.length);
  expect(document.activeElement).toBe(input);
  expect(term.selection).toBe('');
  expect(send.hidden).toBe(true);
  expect(submitted).not.toHaveBeenCalled();
});

it('sends the selection with Ctrl+Shift+Enter, and leaves the key to the shell without one', () => {
  const { input, term } = setup();
  const press = () => new dom!.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, cancelable: true });
  const empty = press();
  expect(term.keyHandler!(empty)).toBe(true);
  expect(empty.defaultPrevented).toBe(false);
  expect(input.value).toBe('');
  term.select('Error: placeholder');
  const event = press();
  expect(term.keyHandler!(event)).toBe(false);
  expect(event.defaultPrevented).toBe(true);
  expect(input.value).toBe('```\nError: placeholder\n```\n\n');
});

it('leaves Ctrl+Shift+Enter to an input method that is still composing', () => {
  const { input, term } = setup();
  term.select('Error: placeholder');
  const event = new dom!.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, isComposing: true, cancelable: true });
  expect(term.keyHandler!(event)).toBe(true);
  expect(event.defaultPrevented).toBe(false);
  expect(input.value).toBe('');
  expect(term.selection).toBe('Error: placeholder');
});

it('sends a selection from a shell started out of a previous-session tab, and shows no button while the tab is inert', async () => {
  dom = new JSDOM('<div class="app"><div id="dock"></div><textarea id="chatInput"></textarea></div>', { url: 'https://local.test', pretendToBeVisual: true });
  const { window } = dom;
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal('navigator', { platform: 'Win32' });
  const create = vi.fn(async () => ({ ok: true, data: { shell: 'bash', cwd: '/home/you' } }));
  Object.assign(window, { api: {
    terminalCreate: create, terminalResize: vi.fn(), terminalClose: vi.fn(), terminalWrite: vi.fn(), terminalAck: vi.fn(),
    writeClipboard: vi.fn(), onTerminalEvent: () => () => {}
  } });
  window.localStorage.setItem('chat-on-steroids.terminal-tabs.workspaceTerminal',
    JSON.stringify([{ projectId: null, title: 'bash', cwd: '/home/you' }]));
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  const terminal = createWorkspaceTerminal(() => {}, document.getElementById('dock')!,
    { onSendSelection: text => sendTerminalSelection(input, text) });
  const term = xterm.FakeTerminal.last!, send = document.querySelector<HTMLButtonElement>('.terminal-send')!;
  expect(terminal.tabs().map(tab => tab.previous)).toEqual([true]);
  terminal.selectTab(terminal.tabs()[0]!.id);
  expect(send.hidden).toBe(true);
  document.querySelector<HTMLButtonElement>('.terminal-previous .btn')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(create).toHaveBeenCalledOnce();
  term.select('Error: boom');
  expect(send.hidden).toBe(false);
  send.click();
  expect(input.value).toBe('```\nError: boom\n```\n\n');
});

it('copies a selection and pastes the clipboard with Ctrl+Shift shortcuts and the mouse', async () => {
  const { term } = setup();
  await new Promise(resolve => setTimeout(resolve, 0));
  const api = (window as any).api;
  term.select('selected output');
  const key = (code: string) => new dom!.window.KeyboardEvent('keydown', { code, ctrlKey: true, shiftKey: true, cancelable: true });
  expect(term.keyHandler!(key('KeyC'))).toBe(false);
  expect(api.writeClipboard).toHaveBeenCalledWith('selected output');
  expect(term.keyHandler!(key('KeyV'))).toBe(false);
  await vi.waitFor(() => expect(term.pasted).toContain('Pasted code'));
  const screen = document.querySelector('.terminal-screen')!;
  screen.dispatchEvent(new dom!.window.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(api.readClipboard).toHaveBeenCalledWith(true));
  screen.dispatchEvent(new dom!.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(api.writeClipboard).toHaveBeenCalledWith('selected output');
  let links: any[] = [];
  term.provider!.provideLinks(1, found => { links = found; });
  expect(links[0].text).toBe('https://example.org/login');
  links[0].activate(new dom!.window.MouseEvent('click'), links[0].text);
  expect(api.openLink).toHaveBeenCalledWith('https://example.org/login', { external: true });
});

it('shows URL and device code from fake login output, copies both and pastes a code without saving it', async () => {
  const { term, emit, tabId } = setup(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  const api = (window as any).api;
  emit({ id: tabId(), data: 'Open https://example.org/dev' });
  emit({ id: tabId(), data: 'ice\nDevice code: ABCD-EFGH\n' });
  const card = document.querySelector<HTMLElement>('.terminal-login-card')!;
  expect(card.hidden).toBe(false);
  expect(card.querySelector('a')?.textContent).toBe('https://example.org/device');
  const buttons = [...card.querySelectorAll('button')];
  buttons[0]!.click();
  expect(api.writeClipboard).toHaveBeenCalledWith('https://example.org/device');
  buttons[1]!.click();
  expect(api.writeClipboard).toHaveBeenCalledWith('ABCD-EFGH');
  const field = card.querySelector('input')!;
  field.value = 'pasted-secret';
  buttons[2]!.click();
  expect(term.pasted).toContain('pasted-secret');
  expect(field.value).toBe('');
  expect(card.textContent).not.toContain('pasted-secret');
});

// CodeRabbit on #2052: the read-only Agent tab needs the app to offer agent output.
it('opens no Agent tab without agent output, and a rejected open says so in its tab', async () => {
  setup();
  const terminal = createWorkspaceTerminal(() => {}, document.getElementById('dock')!, {});
  const agent = { sessionId: 'session-one', processId: 4001, incarnation: 1, command: 'npm run build' };
  expect(terminal.openAgentOutput(agent)).toBeNull();
  const lines: string[] = [];
  (vi.spyOn(xterm.FakeTerminal.prototype, 'writeln') as unknown as { mockImplementation(fn: (line: string) => void): void }).mockImplementation(line => { lines.push(line); });
  Object.assign((window as any).api, {
    agentOutputOpen: vi.fn(async () => { throw new Error('channel closed'); }),
    agentOutputClose: vi.fn(async () => { throw new Error('channel closed'); })
  });
  const id = terminal.openAgentOutput(agent);
  expect(id).not.toBeNull();
  await vi.waitFor(() => expect(lines).toContain('The window is unavailable'), { timeout: 5_000 });
  // Closing it with a failing close call does not throw.
  expect(() => terminal.closeTab(id!)).not.toThrow();
});
