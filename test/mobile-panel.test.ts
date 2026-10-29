import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startMobilePanel, type MobilePanelDeps, type MobilePanelInstance } from '../src/main/mobile-panel.js';

let root: string;
let instance: MobilePanelInstance | null = null;
const deps: MobilePanelDeps = {
  snapshot: vi.fn(async () => ({
    sessions: [{ id: 'synthetic-s1', title: 'Synthetic project', updatedAt: 5000, state: 'working', conversationId: 'test-convo-123' }],
    company: { name: 'Synthetic company', demo: false,
      seats: [{ seat: 'marks1', state: 'unverified', tickets: 1 }],
      requests: [{ title: 'synthetic request', status: 'assigned', seat: 'marks1' }] },
    approvals: [{ conversationId: 'test-convo-123', cardId: 'card-synth-123', title: 'Synthetic project', choiceEnabled: true, outcome: null }]
  })),
  answer: vi.fn(() => ({ ok: true as const }))
};
beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'marks-mobile-qa-')); vi.clearAllMocks(); });
afterEach(async () => { if (instance) await instance.stop(); instance = null; await fs.rm(root, { recursive: true, force: true }); });
const init = async () => { instance = await startMobilePanel({ userData: root, port: 0 }, deps); return instance.address; };
it('is loopback-only unless explicit TLS is configured for LAN', async () => {
  await expect(startMobilePanel({ userData:root, port:0, host:'0.0.0.0' },deps)).rejects.toThrow(/TLS/);
  await expect(startMobilePanel({ userData:root, port:0, host:'example.org' },deps)).rejects.toThrow(/listener/);
  const url = await init(); expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});
it('refuses cross-origin, wrong host and unauthenticated browser API, returns no secrets in HTML', async () => {
  const url = await init();
  const page = await fetch(url); expect(page.status).toBe(200);
  const html = await page.text(); expect(html).toContain('Chat Marks'); expect(html).not.toContain('Synthetic company');
  expect((await fetch(url+'/api/status')).status).toBe(401);
  const token = (await fs.readFile(path.join(root, 'mobile-panel','access.token'),'utf8')).trim();
  const opts = { headers: { Authorization:'Bearer '+token } };
  const response = await fetch(url+'/api/status', opts);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ company: { name:'Synthetic company' } });
  expect((await fetch(url+'/api/status', {headers:{...opts.headers,Origin:'https://malicious.invalid'}})).status).toBe(403);
  const hostSpoofStatus = await new Promise<number>((resolve,reject) => {
    const req = http.get(url+'/api/status', {headers:{...opts.headers,Host:'malicious.invalid'}}, res => {
      resolve(res.statusCode ?? 0); res.resume();
    }); req.on('error',reject);
  });
  expect(hostSpoofStatus).toBe(403);
  expect((await fetch(url+'/api/status?token='+token,opts)).status).toBe(400);
  expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
});
it('queues only an exact, intentionally initiated approval; never silently confirms it', async () => {
  const url = await init();
  const token = (await fs.readFile(path.join(root,'mobile-panel','access.token'),'utf8')).trim();
  const send = (payload: unknown, origin?:string) => fetch(url+'/api/approval', {
    method:'POST', headers: {Authorization:'Bearer '+token,'Content-Type':'application/json',...(origin?{Origin:origin}:{})},
    body:JSON.stringify(payload)
  });
  const payload = {conversationId:'test-convo-123',cardId:'card-synth-123',choice:'allow'};
  expect((await send(payload)).status).toBe(403);
  expect((await send(payload,'https://external.invalid')).status).toBe(403);
  expect((await send({...payload,choice:'permanent'},url)).status).toBe(400);
  expect((await send({...payload,cardId:'other-card-123'},url)).status).toBe(409);
  expect(deps.answer).not.toHaveBeenCalled();
  expect((await send(payload,url)).status).toBe(202);
  expect(deps.answer).toHaveBeenCalledWith('test-convo-123','card-synth-123','allow');
  expect((await send({...payload,choice:'deny'},url)).status).toBe(202);
  expect(deps.answer).toHaveBeenCalledTimes(2);
});
it('deletes its temporary token on stop and does not retain credentials between process starts', async () => {
  const url = await init();
  const file=path.join(root,'mobile-panel','access.token');
  const old = await fs.readFile(file,'utf8');
  await instance!.stop();instance=null;
  await expect(fs.readFile(file,'utf8')).rejects.toMatchObject({code:'ENOENT'});
  instance=await startMobilePanel({userData:root,port:0},deps);
  expect(await fs.readFile(file,'utf8')).not.toBe(old);
  expect((await fetch(instance.address+'/api/status',{headers:{Authorization:'Bearer '+old.trim()}})).status).toBe(401);
  expect(url).toContain('127.0.0.1');
});
