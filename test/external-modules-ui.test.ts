import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createExternalModulesUi } from '../src/renderer/external-modules-ui.js';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const doms: JSDOM[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(globalThis, { window: originalWindow, document: originalDocument });
  for (const dom of doms.splice(0)) dom.window.close();
});

function mount(api: any) {
  const dom = new JSDOM('<main id="modules"></main>', { url: 'http://localhost' });
  doms.push(dom);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  const parent = dom.window.document.getElementById('modules')!;
  const ui = createExternalModulesUi(api, parent);
  const badges = () => [...parent.querySelectorAll<HTMLElement>('.modules-status')];
  return { dom, ui, badges, parent };
}

describe('external modules state boundary', () => {
  it('treats a successful but malformed status reply as unavailable rather than throwing', async () => {
    const { ui, badges } = mount({ modulesStatus: vi.fn(async () => ({ ok: true, data: null })) });
    await expect(ui.refresh()).resolves.toBeUndefined();
    expect(badges().map(badge => badge.dataset.state)).toEqual(['unknown', 'unknown']);
    expect(badges().every(badge => badge.textContent === 'Status unavailable')).toBe(true);
  });

  it('keeps unavailable status on a rejected refresh, without an unhandled promise rejection', async () => {
    const { ui, badges } = mount({ modulesStatus: vi.fn(async () => { throw new Error('IPC unavailable'); }) });
    await expect(ui.refresh()).resolves.toBeUndefined();
    expect(badges().map(badge => badge.dataset.state)).toEqual(['unknown', 'unknown']);
  });

  it('does not replace valid status with malformed results of an action', async () => {
    const ready = { id: 'twindesk', installed: true, supported: true, detail: 'Available' };
    const { ui, parent, badges } = mount({
      modulesStatus: vi.fn(async () => ({ ok: true, data: [ready] })),
      moduleAction: vi.fn(async () => ({ ok: true, data: null }))
    });
    await ui.refresh();
    parent.querySelector<HTMLButtonElement>('[data-module="twindesk"] [data-action="install"]')!.click();
    await vi.waitFor(() => expect(parent.querySelector<HTMLElement>('[data-module="twindesk"] [role="alert"]')?.hidden).toBe(false));
    expect(badges()[1]?.dataset.state).toBe('stopped');
    expect(parent.querySelector<HTMLElement>('[data-module="twindesk"] [role="alert"]')?.textContent).toMatch(/unavailable/i);
  });
});
