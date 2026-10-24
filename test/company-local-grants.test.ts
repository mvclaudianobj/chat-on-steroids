import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { companyLocalConsentCopy, initCompanyLocalGrants, localGrantDecision, readLocalCompanyGrants,
  recordLocalCompanyRequest, resetCompanyLocalGrantsForTests, revokeLocalCompanyGrant, verifyLocalCompanyGrant } from '../src/main/company-local-grants.js';

const worker = { kind: 'worker' as const, ownerId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222', workerId: 'worker-1', conversationId: 'synthetic-chat' };
const coo = { kind: 'coo' as const, principal: 'marks-coo' as const };
const req = '33333333-3333-4333-8333-333333333333';
let fake = '';
beforeEach(async () => {
  fake = await mkdtemp(path.join(os.tmpdir(), 'company-grants-'));
  initCompanyLocalGrants(fake);
});
afterEach(async () => { resetCompanyLocalGrantsForTests(); await rm(fake, { recursive: true, force: true }); });

it('rejects untrusted broker identity and explicit denial, including COO; never stores a grant', async () => {
  for (const attestation of [null, { local: false, verified: true, subject: worker }]) {
    const result = await localGrantDecision({ mode: 'agent', scope: 'company-local-review', subject: worker,
      attestation: attestation as never, consent: true, requestId: req });
    expect(result.authorized).toBe(false);
  }
  expect((await localGrantDecision({ mode: 'coo', scope: 'company-local-read', subject: coo,
    attestation: { local: true, verified: true, subject: coo }, consent: false, requestId: req })).authorized).toBe(false);
  expect((await readLocalCompanyGrants()).grants).toEqual([]);
});

it('authorizes one task without persistence, then durable exact-worker scope with idempotence and revocation', async () => {
  const proof = { local: true as const, verified: true as const, subject: worker };
  expect((await localGrantDecision({ mode: 'task', scope: 'company-local-read', subject: worker,
    attestation: proof, consent: true, requestId: req })).authorized).toBe(true);
  expect((await readLocalCompanyGrants()).grants).toHaveLength(0);
  const request = { mode: 'agent' as const, scope: 'company-local-read' as const, subject: worker,
    attestation: proof, consent: true, requestId: req };
  const first = await localGrantDecision(request);
  expect((await localGrantDecision(request)).epoch).toBe(first.epoch);
  expect(await verifyLocalCompanyGrant(proof, 'company-local-read')).toBe(true);
  expect(await verifyLocalCompanyGrant({ ...proof, subject: { ...worker, runId: '44444444-4444-4444-8444-444444444444' } },
    'company-local-read')).toBe(false);
  initCompanyLocalGrants(fake);
  expect(await verifyLocalCompanyGrant(proof, 'company-local-read')).toBe(true);
  expect(await revokeLocalCompanyGrant(first.id!)).toBe(true);
  expect(await revokeLocalCompanyGrant(first.id!)).toBe(false);
  expect(await verifyLocalCompanyGrant(proof, 'company-local-read')).toBe(false);
  expect((await readLocalCompanyGrants()).audit.map(event => event.action)).toEqual(['authorize', 'revoke']);
});

it('expands COO only through verified explicit consent, and never removes host approval text', async () => {
  const proof = { local: true as const, verified: true as const, subject: coo };
  const result = await localGrantDecision({ mode: 'coo', scope: 'company-local-read', subject: coo,
    attestation: proof, consent: true, requestId: req });
  expect(result.authorized).toBe(true);
  expect((await readLocalCompanyGrants()).grants).toHaveLength(3);
  expect(companyLocalConsentCopy('coo', 'company-local-read').detail).toMatch(/ChatGPT.*sistema operacional/);
  expect(companyLocalConsentCopy('agent', 'company-local-read').title).toMatch(/ESTE agente/);
});

it('offers broader authority after three equivalent requests without ever granting it', async () => {
  const identities = [
    '11111111-1111-4111-8111-111111111112',
    '11111111-1111-4111-8111-111111111113',
    '11111111-1111-4111-8111-111111111114'
  ];
  for (const [i, requestId] of identities.entries()) {
    const observation = await recordLocalCompanyRequest({ subject: worker, scope: 'company-local-read', requestId });
    expect(observation).toEqual({ equivalent: i + 1, suggestExpansion: i === 2 });
    expect((await recordLocalCompanyRequest({ subject: worker, scope: 'company-local-read', requestId })).equivalent).toBe(i + 1);
  }
  expect((await readLocalCompanyGrants()).grants).toHaveLength(0);
  initCompanyLocalGrants(fake);
  expect((await recordLocalCompanyRequest({ subject: worker, scope: 'company-local-read', requestId: identities[2]! }))
    .suggestExpansion).toBe(true);
});
