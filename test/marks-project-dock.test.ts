import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalProject } from '../src/shared/projects.js';
import { showMarksProjectDockPicker } from '../src/renderer/marks-project-dock.js';
import { createWorkspaceDocks } from '../src/renderer/workspace-docks.js';
import { setLanguage } from '../src/renderer/i18n.js';

const alpha: LocalProject = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Chat Marks', path: '/approved/marks', createdAt: 1
};
const removed: LocalProject = {
  id: '22222222-2222-4222-8222-222222222222', name: 'Removed', path: '/approved/removed', createdAt: 2, ungrouped: true
};
let dom: JSDOM;
const setup = () => {
  dom = new JSDOM('<div class="app"><div class="app-topbar"></div><main data-panel="chat"></main></div>', { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document, window: dom.window });
  setLanguage('en');
  return createWorkspaceDocks(document.querySelector<HTMLElement>('main')!);
};
afterEach(() => { setLanguage('en'); dom?.window.close(); });

it('makes Files and Review discoverable without a project and requires an explicit project choice', () => {
  const docks = setup();
  let selected: string | null = null;
  let owner = 'unassigned-chat';
  const session = owner;
  const shown = vi.fn();
  const show = (kind: 'files' | 'review') => (mount: HTMLElement) => {
    mount.querySelector('.marks-project-dock-picker')?.remove();
    if (selected) { shown(kind, selected); return; }
    const capturedOwner = owner;
    showMarksProjectDockPicker(mount, [alpha, removed], id => {
      if (owner !== capturedOwner) return;
      selected = id;
      docks.activate(kind);
    });
  };
  docks.register('review', 'Review', 'i-git-diff', show('review'), vi.fn(), () => true);
  docks.register('files', 'Files', 'i-folder', show('files'), vi.fn(), () => true);
  const menu = document.querySelector<HTMLButtonElement>('#workDockRight [data-view=files].work-dock-quick')!;
  const review = document.querySelector<HTMLButtonElement>('#workDockRight [data-view=review].work-dock-quick')!;
  expect(menu.disabled).toBe(false);
  expect(review.disabled).toBe(false);
  menu.click();
  expect(document.querySelector('#workDockRight .marks-project-dock-picker')?.textContent).toContain('Chat Marks');
  expect(document.querySelector('#workDockRight .marks-project-dock-picker')?.textContent).not.toContain('Removed');
  expect(shown).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('.marks-project-dock-choice')!.click();
  expect(shown).toHaveBeenCalledWith('files', alpha.id);
  expect(session).toBe('unassigned-chat'); // Choosing a dock workspace did not reassign the chat.
  expect(document.querySelector('#workDockRight .marks-project-dock-picker')).toBeNull();
  owner = 'different-chat'; selected = null;
  docks.refreshActive();
  expect(document.querySelector('#workDockRight .marks-project-dock-picker')).not.toBeNull();
  expect(shown).toHaveBeenCalledTimes(1);
  review.click();
  expect(document.querySelector('#workDockRight [role=tab][aria-selected=true]')?.textContent).toContain('Review');
  expect(document.querySelector('#workDockRight .marks-project-dock-picker')).not.toBeNull();
});

it('offers the existing add-project flow when no local projects exist', () => {
  const docks = setup();
  const add = vi.fn();
  const picker = showMarksProjectDockPicker(docks.body, [], vi.fn(), add);
  expect(picker.textContent).toContain('No projects yet.');
  picker.querySelector<HTMLButtonElement>('button')!.click();
  expect(add).toHaveBeenCalledOnce();
});

it('renders project names as text and retains translated instructions', () => {
  const docks = setup();
  const picker = showMarksProjectDockPicker(docks.body, [{ ...alpha, name: '<img src=x onerror=alert(1)>' }], vi.fn());
  expect(picker.querySelector('img')).toBeNull();
  expect(picker.textContent).toContain('<img');
  setLanguage('pt-BR');
  expect(picker.textContent).toContain('Escolha um projeto local para este painel');
});
