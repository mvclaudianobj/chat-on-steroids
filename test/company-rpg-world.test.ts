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
  expect(companyRpgRoom('approval-wait')).toBe('attention');
  expect(companyRpgRoom('disconnected')).toBe('offline');
  expect(companyRpgRoom('unverified')).toBe('offline');
});
it('keeps six distinct worker actors and moves the SAME node through broker-confirmed status changes', () => {
  const scene = host();
  const animate = vi.fn();
  const actor = createCompanyRpgWorld(scene, s => s, () => false, animate);
  const seats = Array.from({ length: 6 }, (_, i) => 'marks' + (i + 1));
  const layout={projects:[{id:'website',title:'Website'}],assignments:{marks1:'website'},areas:[{role:'marks-cto',name:'Engineering'}],seatRoles:{marks1:'marks-cto'}};
  actor.setVisible(true);
  actor.update(seats, [], false,layout);
  expect(scene.querySelectorAll('.company-rpg-actor')).toHaveLength(6);
  const mark = scene.querySelector<HTMLElement>('[data-seat="marks1"]')!;
  expect(mark.closest('.company-rpg-offline')).not.toBeNull();
  actor.update(seats, [{ seat: 'marks1', state: 'working', source: 'broker', error: false, taskTitle:'Review the product roadmap' }], false,layout);
  expect(scene.querySelector('[data-seat="marks1"]')).toBe(mark);
  expect(mark.closest('[data-room-key="project:website"]')).not.toBeNull();
  expect(mark.querySelector('.company-rpg-task')?.textContent).toBe('Review the product roadmap');
  expect(mark.querySelector('button')?.getAttribute('aria-label')).toContain('Review the product roadmap');
  actor.update(seats, [{ seat: 'marks1', state: 'meeting-present', source: 'meeting', error: false }], false,layout);
  expect(mark.closest('.company-rpg-meeting')).not.toBeNull();
  expect(mark.querySelector('.company-rpg-task')?.textContent).toBe('');
  actor.update(seats, [{ seat: 'marks1', state: 'available-confirmed', source: 'company', error: false }], false,layout);
  expect(mark.closest('.company-rpg-rest')).not.toBeNull();
  actor.update(seats, [{ seat: 'marks1', state: 'working', source: 'error', error: true }], false,layout);
  expect(mark.closest('.company-rpg-offline')).not.toBeNull();
  expect(mark.dataset.state).toBe('unverified');
  actor.update(seats,[{seat:'marks1',state:'working',source:'error',error:true,taskTitle:'Invented task'}],false,layout);
  expect(mark.querySelector('.company-rpg-task')?.textContent).toBe('');
  actor.update(seats,[{seat:'marks1',state:'approval-wait',source:'broker',error:false}],false,layout);
  expect(mark.closest('.company-rpg-attention')).not.toBeNull();
  actor.update(seats, [], false,{...layout,projects:[],assignments:{}});
  expect(scene.querySelector('[data-room-key="project:website"]')).toBeNull();
  expect(scene.querySelector('[data-room-key="common:garden"]')).not.toBeNull();
  expect(scene.querySelector('[data-seat="marks1"]')).toBe(mark);
});
it('retains actor identity for 30 observations and does not animate an unchanged state', () => {
  const scene = host();
  const animate = vi.fn();
  const actor = createCompanyRpgWorld(scene, s => s, () => false, animate);
  const seats = ['marks1'];
  actor.setVisible(true);
  actor.update(seats, [], false);
  const original = scene.querySelector('[data-seat="marks1"]');
  for (let i = 0; i < 30; i++) actor.update(seats,
    [{ seat: 'marks1', state: i % 2 ? 'available-confirmed' : 'working', source: i % 2 ? 'company' : 'broker', error: false }], false);
  expect(scene.querySelector('[data-seat="marks1"]')).toBe(original);
  expect(scene.querySelectorAll('[data-seat="marks1"]')).toHaveLength(1);
  expect(scene.querySelectorAll('.company-rpg-actor')).toHaveLength(1);
  expect(animate).toHaveBeenCalled();
});
it('renders project rooms and department managers independently of worker presence, with keyboard buttons and pause', () => {
  const scene=host();
  const inspector=vi.fn(), manager=vi.fn();
  const world=createCompanyRpgWorld(scene,s=>s,()=>false,()=>undefined,inspector,manager);
  const layout={projects:[{id:'p1',title:'Project One'},{id:'p2',title:'Project Two'}],
    assignments:{marks1:'p1',marks2:'p2'},areas:[{role:'marks-coo',name:'Operations'}],seatRoles:{marks1:'marks-coo'}};
  world.update(['marks1','marks2'],[],false,layout);
  expect(scene.querySelectorAll('.company-rpg-project')).toHaveLength(2);
  expect(scene.querySelectorAll('.company-rpg-department')).toHaveLength(1);
  expect(scene.querySelectorAll('.company-pixel-floor')).toHaveLength(8);
  const button=scene.querySelector<HTMLButtonElement>('.company-pixel-manager')!;
  button.click();expect(manager).toHaveBeenCalledWith('marks-coo');
  scene.querySelector<HTMLButtonElement>('[data-seat="marks1"] button')!.click();
  expect(inspector).toHaveBeenCalledWith('marks1');
  world.setVisible(false);expect(scene.dataset.paused).toBe('true');
  world.setVisible(true);expect(scene.dataset.paused).toBe('false');
  world.update(['marks1','marks2'],[],true,layout);
  expect(scene.querySelector('[data-seat="marks1"]')?.getAttribute('data-state')).toBe('unverified');
  expect(scene.querySelectorAll('[data-seat="marks1"]')).toHaveLength(1);
});
