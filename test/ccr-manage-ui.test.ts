import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { CcrStatus } from '../src/shared/ccr-module.js';
import { createCcrManageUi } from '../src/renderer/ccr-manage-ui.js';

const dom = new JSDOM('<!doctype html><div data-panel="modules"><div class="appearance-content"></div></div>', { url: 'http://localhost' });
const old = { document: globalThis.document, window: globalThis.window };

beforeEach(() => {
  dom.window.document.querySelector('.appearance-content')!.replaceChildren();
  Object.assign(globalThis, { document: dom.window.document, window: dom.window });
});
afterEach(() => { Object.assign(globalThis, old); });

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => dom.window.document.getElementById(id) as T;
const shown = (id: string): boolean => !$(id).hidden;

function status(over: Partial<CcrStatus> = {}): CcrStatus {
  return {
    managed: null, external: null, inUse: null, latest: '3.1.3', updateAvailable: false, latestUnsupported: false, support: null,
    installable: true, service: { state: 'stopped', host: '127.0.0.1', port: 3456, pid: null, from: null, ui: false, restartPending: false, routedTurns: false },
    configured: { claude: false, codex: false }, install: null, ...over
  };
}

function mount(first: CcrStatus) {
  let current = first;
  const api = {
    ccrStatus: vi.fn(async () => ({ ok: true as const, data: current })),
    ccrInstall: vi.fn(async () => ({ ok: true as const, data: current })),
    ccrService: vi.fn(async () => ({ ok: true as const, data: current })),
    ccrOpenUi: vi.fn(async () => ({ ok: true as const, data: current })),
    onCcrProgress: vi.fn()
  };
  const card = createCcrManageUi(api as never, dom.window.document.querySelector('.appearance-content')!);
  return { api, card, set: (next: CcrStatus) => { current = next; } };
}

it('a fresh machine: not installed, one confirmed Install of the npm release, no service buttons', async () => {
  const { api, card } = mount(status());
  await card.refresh();
  expect($('ccrModule').querySelector('h2')!.textContent).toBe('Claude Code Router');
  expect($('ccrModule').querySelector('.cm-glyph-ccr')).not.toBeNull();
  expect($('ccrState').textContent).toBe('Not installed');
  expect($('ccrInstalledVersion').textContent).toBe('Installed version: Not installed');
  expect($('ccrInstall').textContent).toBe('Install 3.1.3');
  expect([shown('ccrStart'), shown('ccrStop'), shown('ccrRestart'), shown('ccrOpenUi')]).toEqual([false, false, false, false]);
  dom.window.confirm = vi.fn(() => true);
  $('ccrInstall').click();
  await vi.waitFor(() => expect(api.ccrInstall).toHaveBeenCalledWith('install', '3.1.3'));
  expect(String((dom.window.confirm as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain('the npm registry');
});

it('a copy the user installed: "Using installed", update in place only when writable, and its own managed copy offered', async () => {
  const external = { kind: 'external' as const, version: '3.1.2', path: '~/.local/lib/node_modules/@musistudio/claude-code-router/dist/main/cli.js', writable: true };
  const { api, card, set } = mount(status({
    external, inUse: 'external', updateAvailable: true, support: 'ok', configured: { claude: true, codex: true },
    service: { state: 'running', host: '127.0.0.1', port: 3456, pid: 311913, from: 'external', ui: true, restartPending: false, routedTurns: false }
  }));
  await card.refresh();
  expect($('ccrInstalledVersion').textContent).toBe(`Using installed ${external.path} 3.1.2`);
  expect(shown('ccrUpdateBadge')).toBe(true);
  expect($('ccrInstall').textContent).toBe('Update installed copy to 3.1.3');
  expect(shown('ccrInstallOwn')).toBe(true);
  expect($('ccrService').textContent).toBe('Router running on 127.0.0.1:3456 · started from the installed copy');
  expect($('ccrConfigured').textContent).toBe('Configured for Claude Code, Codex. Their chats can use "Via Claude Code Router".');
  expect([shown('ccrStart'), shown('ccrStop'), shown('ccrRestart'), shown('ccrOpenUi')]).toEqual([false, true, true, true]);
  dom.window.confirm = vi.fn(() => false);
  $('ccrInstall').click();
  expect(api.ccrInstall).not.toHaveBeenCalled();
  dom.window.confirm = vi.fn(() => true);
  $('ccrInstall').click();
  await vi.waitFor(() => expect(api.ccrInstall).toHaveBeenCalledWith('update-external', '3.1.3'));
  $('ccrOpenUi').click();
  await vi.waitFor(() => expect(api.ccrOpenUi).toHaveBeenCalled());
  // Not writable: no in-place update, a note says why.
  set(status({ external: { ...external, writable: false }, inUse: 'external', updateAvailable: true }));
  await card.refresh();
  expect(shown('ccrInstall')).toBe(false);
  expect($('ccrNote').textContent).toContain('cannot be updated without administrator rights');
});

it('the managed copy: update badge, restart pending while routed chats answer, stop confirmed', async () => {
  const managed = { kind: 'managed' as const, version: '3.1.3', path: '~/.config/Chat Marks/modules/ccr/bin/ccr' };
  const { api, card } = mount(status({
    managed, inUse: 'managed', latest: '3.2.0', updateAvailable: true, support: 'ok',
    service: { state: 'running', host: '127.0.0.1', port: 3456, pid: 1, from: 'managed', ui: false, restartPending: true, routedTurns: true }
  }));
  await card.refresh();
  expect($('ccrInstalledVersion').textContent).toBe('Installed version: 3.1.3 (managed by Chat Marks)');
  expect($('ccrInstall').textContent).toBe('Update to 3.2.0');
  expect($('ccrService').textContent).toContain('Restarts with the new version when no routed chat is answering');
  expect(shown('ccrOpenUi')).toBe(false);
  expect($('ccrConfigured').textContent).toContain('Not configured for Claude Code or Codex yet');
  dom.window.confirm = vi.fn(() => true);
  $('ccrStop').click();
  await vi.waitFor(() => expect(api.ccrService).toHaveBeenCalledWith('stop'));
  expect(String((dom.window.confirm as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain('are interrupted');
});

it('says why it cannot install (no Node.js 22) and translates main\'s errors', async () => {
  const { card, api } = mount(status({ installable: false, installBlocked: 'node_too_old' }));
  await card.refresh();
  expect(shown('ccrInstall')).toBe(false);
  expect($('ccrNote').textContent).toBe('Claude Code Router needs Node.js 22 or newer.');
  api.ccrStatus.mockResolvedValueOnce({ ok: false, error: 'checksum_mismatch' } as never);
  await card.refresh();
  expect($('ccrProgress').textContent).toBe('The download did not match the published checksum, so nothing was installed.');
});
