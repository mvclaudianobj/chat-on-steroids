import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  summary: {} as Record<string, unknown>,
  agent: null as Record<string, unknown> | null,
  waiting: [] as string[],
  inputs: [] as Array<Record<string, unknown>>,
  company: { demo: true, delegation: { binding: null as null | { conversationId: string } }, requests: [] as Array<Record<string, unknown>> },
  active: false,
  activityExpiresAt: null as number | null
}));

vi.mock('../src/main/agents.js', () => ({
  agentInfoForOwnedConversation: () => fixture.agent
}));
vi.mock('../src/main/approval-wait.js', () => ({
  approvalWaitingChats: () => fixture.waiting
}));
vi.mock('../src/main/company-store.js', () => ({
  getCompany: async () => fixture.company
}));
vi.mock('../src/main/bridge.js', () => ({
  sessionInputActivity: () => ({ possible: fixture.active }),
  sessionActivityExpiresAt: () => fixture.activityExpiresAt
}));
vi.mock('../src/main/session/input.js', () => ({
  listInputs: async () => fixture.inputs
}));
vi.mock('../src/main/session/store.js', () => ({
  setSessionArchived: async (_id: string, archived: boolean, guard: (s: Record<string, unknown>) => Promise<string | null>) => {
    if (archived) {
      const refusal = await guard(fixture.summary);
      if (refusal) throw new Error(refusal);
    }
    return { ...fixture.summary, archivedAt: archived ? 123 : undefined };
  }
}));

import { archiveSessionLocally } from '../src/main/session/local-archive.js';

beforeEach(() => {
  fixture.summary = { id: 'local-session', conversationId: 'normal-chat', activeTurnId: null, origin: null };
  fixture.agent = null;
  fixture.waiting = [];
  fixture.inputs = [];
  fixture.company.demo = true;
  fixture.company.delegation.binding = null;
  fixture.company.requests = [];
  fixture.active = false;
  fixture.activityExpiresAt = null;
});

describe('local archive permission boundary', () => {
  it('allows idle ordinary chats and reversible restoration', async () => {
    expect((await archiveSessionLocally('local-session', true)).archivedAt).toBe(123);
    expect((await archiveSessionLocally('local-session', false)).archivedAt).toBeUndefined();
  });
  it('rejects owners/COO and an active selected turn', async () => {
    fixture.agent = { role: 'prime' };
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('owner chat');
    fixture.agent = null;
    fixture.summary.activeTurnId = 'active-turn';
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('still active');
    fixture.summary.activeTurnId = null;
    fixture.active = true;
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('still active');
  });
  it('rejects a waiting host approval and unsent or unacknowledged input', async () => {
    fixture.waiting = ['normal-chat'];
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('approval');
    fixture.waiting = [];
    fixture.inputs = [{ id: 'pending', sessionId: 'local-session', state: 'queued' }];
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('pending messages');
    fixture.inputs = [{ id: 'pending', sessionId: 'local-session', state: 'sent' }];
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('pending messages');
  });
  it('rejects worker lacking a verified finished assignment or one with unacknowledged work', async () => {
    fixture.summary.origin = { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-1' };
    fixture.summary.lastFinishReportAt = 200;
    fixture.agent = { role: 'worker', state: 'running', activatedAt: 100, result: 'ok', pending: 0, awaitingAck: 0 };
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('verified completed');
    fixture.agent.state = 'sleeping';
    fixture.agent.pending = 1;
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('verified completed');
    fixture.agent.pending = 0;
    fixture.agent.awaitingAck = 1;
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('verified completed');
    fixture.agent.awaitingAck = 0;
    expect((await archiveSessionLocally('local-session', true)).archivedAt).toBe(123);
  });
  it('keeps a live Company-bound chat visible until the trusted binding is released', async () => {
    fixture.company.demo = false;
    fixture.company.delegation.binding = { conversationId: 'normal-chat' };
    await expect(archiveSessionLocally('local-session', true)).rejects.toThrow('Company owner');
    fixture.company.delegation.binding = { conversationId: 'different-chat' };
    expect((await archiveSessionLocally('local-session', true)).archivedAt).toBe(123);
  });
});
