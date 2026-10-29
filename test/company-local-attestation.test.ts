import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ company: null as any, agent: null as any }));
vi.mock('../src/main/company-store.js', () => ({ getCompany: async () => state.company }));
vi.mock('../src/main/agents.js', () => ({ agentInfoForOwnedConversation: () => state.agent }));

import { attestCompanyLocalSubject } from '../src/main/company-local-attestation.js';
const subject = { kind: 'worker' as const, ownerId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222', workerId: 'worker-1', conversationId: 'provider-chat-id' };

beforeEach(() => {
  state.company = { demo: false, requests: [{ id: subject.ownerId, seat: 'marks2', status: 'working',
    execution: { mode: 'live', phase: 'running', ...subject } }] };
  state.agent = { role: 'worker', id: subject.workerId, runId: subject.runId,
    conversationId: subject.conversationId, label: `marks2:${subject.ownerId}`, state: 'active' };
});

it('attests only an exact main-owned ticket plus matching live broker worker identity', async () => {
  expect(await attestCompanyLocalSubject(subject)).toEqual({ local: true, verified: true, subject });
  expect(await attestCompanyLocalSubject({ ...subject, workerId: 'worker-2' })).toBeNull();
  expect(await attestCompanyLocalSubject({ ...subject, runId: '33333333-3333-4333-8333-333333333333' })).toBeNull();
  expect(await attestCompanyLocalSubject({ ...subject, conversationId: 'another-chat' })).toBeNull();
  state.agent = { ...state.agent, label: 'marks3:another-ticket' };
  expect(await attestCompanyLocalSubject(subject)).toBeNull();
});

it('refuses sample Companies, duplicate tickets, retired workers and unbound role claims', async () => {
  state.company.demo = true;
  expect(await attestCompanyLocalSubject(subject)).toBeNull();
  state.company.demo = false;
  state.company.requests.push({ ...state.company.requests[0] });
  expect(await attestCompanyLocalSubject(subject)).toBeNull();
  state.company.requests.pop();
  state.agent.state = 'finished';
  expect(await attestCompanyLocalSubject(subject)).toBeNull();
  expect(await attestCompanyLocalSubject({ kind: 'coo', principal: 'marks-coo' })).toBeNull();
});
