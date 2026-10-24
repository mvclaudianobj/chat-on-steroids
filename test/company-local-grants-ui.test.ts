import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { mountCompanyLocalGrants } from '../src/renderer/company-local-grants-ui.js';

const doms: JSDOM[] = [];
afterEach(() => { for (const dom of doms) dom.window.close(); doms.length = 0; vi.unstubAllGlobals(); });
const mockWindow = () => {
  const dom = new JSDOM('<main id="host"></main>', { url: 'https://local.test/' });
  doms.push(dom);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  return dom.window.document.getElementById('host')!;
};
const worker = { kind: 'worker' as const, ownerId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222', workerId: 'worker-1', conversationId: 'synthetic-chat' };
const grant = { id: '33333333-3333-4333-8333-333333333333', subject: worker,
  scope: 'company-local-read' as const, epoch: 4, at: 100 };
const view = (verified = false) => ({
  version: 1 as const, epoch: 4, grants: [grant], audit: [{
    id: '44444444-4444-4444-8444-444444444444', at: 101,
    action: 'authorize' as const, subject: worker, scope: grant.scope, epoch: 4, reason: 'fixture'
  }], requests: [], authority: { verified, subject: verified ? worker : null, reason: 'External broker not attested' }
});
it.each(['de','es','fr','ja','ko','pt-BR','pt-PT','ru','tr','vi','zh-CN','zh-TW'])('provides all local-grant controls and audit labels in %s', locale => {
  const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string,string>;
  for (const key of ['Local Company permissions', 'Active local grants', 'Revoke local grant',
    'Local authorization unavailable', 'Authorize this task',
    'Always authorize THIS agent for selected local scope', 'Always authorize COO for all LOCAL scopes',
    'Local grant audit', 'Three equivalent requests detected. You may request broader consent; nothing is approved automatically.']) {
    expect(typeof catalog[key]).toBe('string');
    expect(catalog[key]?.trim().length).toBeGreaterThan(4);
  }
});
async function tick(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }

it('shows scope/identity/audit and allows revoke even while broker grants are disabled', async () => {
  const host = mockWindow();
  const revoke = vi.fn(async () => ({ ok: true as const, data: true }));
  const get = vi.fn(async () => ({ ok: true as const, data: view(false) }));
  mountCompanyLocalGrants(host, { companyLocalGrants: get,
    revokeCompanyLocalGrant: revoke, requestCompanyLocalGrant: vi.fn() as never });
  await tick();
  expect(host.textContent).toContain(worker.workerId);
  expect(host.textContent).toContain(grant.scope);
  expect(host.textContent).toContain('Epoch: 4');
  expect(host.querySelectorAll('ol li')).toHaveLength(1);
  expect(host.querySelectorAll('button:disabled')).toHaveLength(3);
  expect(host.querySelector('#companyLocalGrantBlockedReason')).not.toBeNull();
  const button = host.querySelector<HTMLButtonElement>('li button')!;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-label')).toContain(grant.scope);
  button.click(); await tick();
  expect(revoke).toHaveBeenCalledWith(grant.id);
});

it('displays grant options only for attested matching worker; COO choice stays disabled', async () => {
  const host = mockWindow();
  mountCompanyLocalGrants(host, {
    companyLocalGrants: async () => ({ ok: true, data: view(true) }),
    revokeCompanyLocalGrant: vi.fn() as never, requestCompanyLocalGrant: vi.fn() as never
  });
  await tick();
  expect(host.querySelectorAll('div[aria-label] button')).toHaveLength(3);
  expect(host.querySelectorAll('div[aria-label] button:disabled')).toHaveLength(1);
});
