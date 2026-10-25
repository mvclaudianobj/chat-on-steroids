import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createCompanyRpgWorld, companyRpgRoom } from '../src/renderer/company-rpg-world.js';

const doms: JSDOM[] = [];
afterEach(() => { for (const dom of doms) dom.window.close(); doms.length = 0; vi.unstubAllGlobals(); });
function host(): HTMLElement {
  const dom = new JSDOM('<section id="world"></section>', { url: 'http://localhost/' });
  doms.push(dom);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  return dom.window.document.getElementById('world')!;
}
it('maps only attested observation statuses to activity rooms; unknown is never working', () => {
  expect(companyRpgRoom('working')).toBe('desks');
  expect(companyRpgRoom('shell-wait')).toBe('desks');
  expect(companyRpgRoom('meeting-present')).toBe('meeting');
  expect(companyRpgRoom('available-confirmed')).toBe('rest');
  expect(companyRpgRoom('needs-ceo')).toBe('attention');
  expect(companyRpgRoom('disconnected')).toBe('offline');
  expect(companyRpgRoom('unverified')).toBe('offline');
});
it('keeps six distinct worker actors and moves the SAME node through broker-confirmed status changes', () => {
  const scene = host();
  const animate = vi.fn();
  const actor = createCompanyRpgWorld(scene, s => s, () => false, animate);
  const seats = Array.from({ length: 6 }, (_, i) => 'marks' + (i + 1));
  actor.update(seats, [], false);
  expect(scene.querySelectorAll('.company-rpg-actor')).toHaveLength(6);
  const mark = scene.querySelector<HTMLElement>('[data-seat="marks1"]')!;
  expect(mark.closest('.company-rpg-offline')).not.toBeNull();
  actor.update(seats, [{ seat: 'marks1', state: 'working', source: 'broker', error: false }], false);
  expect(scene.querySelector('[data-seat="marks1"]')).toBe(mark);
  expect(mark.closest('.company-rpg-desks')).not.toBeNull();
  actor.update(seats, [{ seat: 'marks1', state: 'meeting-present', source: 'meeting', error: false }], false);
  expect(mark.closest('.company-rpg-meeting')).not.toBeNull();
  actor.update(seats, [{ seat: 'marks1', state: 'available-confirmed', source: 'company', error: false }], false);
  expect(mark.closest('.company-rpg-rest')).not.toBeNull();
  actor.update(seats, [{ seat: 'marks1', state: 'working', source: 'error', error: true }], false);
  expect(mark.closest('.company-rpg-offline')).not.toBeNull();
  expect(mark.dataset.state).toBe('unverified');
});
it('retains actor identity for 30 observations and does not animate an unchanged state', () => {
  const scene = host();
  const animate = vi.fn();
  const actor = createCompanyRpgWorld(scene, s => s, () => false, animate);
  const seats = ['marks1'];
  actor.update(seats, [], false);
  const original = scene.querySelector('[data-seat="marks1"]');
  for (let i = 0; i < 30; i++) actor.update(seats,
    [{ seat: 'marks1', state: i % 2 ? 'available-confirmed' : 'working', source: i % 2 ? 'company' : 'broker', error: false }], false);
  expect(scene.querySelector('[data-seat="marks1"]')).toBe(original);
  expect(scene.querySelectorAll('[data-seat="marks1"]')).toHaveLength(1);
  expect(scene.querySelectorAll('.company-rpg-actor')).toHaveLength(1);
  expect(animate).toHaveBeenCalled();
});
