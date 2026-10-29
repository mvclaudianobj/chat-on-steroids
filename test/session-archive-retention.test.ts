import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/main/agents.js', () => ({ agentInfoForOwnedConversation: () => null }));
vi.mock('../src/main/approval-wait.js', () => ({ approvalWaitingChats: () => [] }));
vi.mock('../src/main/bridge.js', () => ({ sessionInputActivity: () => ({ possible: false }), sessionActivityExpiresAt: () => null }));
vi.mock('../src/main/company-store.js', () => ({ getCompany: async () => ({ demo: true, delegation: { binding: null }, requests: [] }) }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: {} }) }));
vi.mock('../src/main/session/input.js', () => ({ listInputs: async () => [] }));
vi.mock('../src/main/session/store.js', () => ({ indexedSessions: async () => [], getSession: async () => null }));
import { eligibleArchivedSession, sweepArchivedSessions } from '../src/main/session/archive-retention.js';
import type { SessionSummary } from '../src/shared/session.js';

const DAY = 86_400_000;
const now = 100 * DAY;
function chat(id: string, override: Partial<SessionSummary> = {}): SessionSummary {
  return { id, archivedAt: now - 40 * DAY, updatedAt: now - 40 * DAY,
    conversationId: id, origin: { kind: 'desktop' }, activeTurnId: null,
    ...override } as SessionSummary;
}

describe('archived session retention', () => {
  it('requires both archive age and inactivity, and never targets workers, active turns or owners', () => {
    expect(eligibleArchivedSession(chat('old'), now, 30)).toBe(true);
    expect(eligibleArchivedSession(chat('recent', { updatedAt: now - DAY }), now, 30)).toBe(false);
    expect(eligibleArchivedSession(chat('new', { archivedAt: now - DAY }), now, 30)).toBe(false);
    expect(eligibleArchivedSession(chat('visible', { archivedAt: undefined }), now, 30)).toBe(false);
    expect(eligibleArchivedSession(chat('working', { activeTurnId: 'turn' }), now, 30)).toBe(false);
    expect(eligibleArchivedSession(chat('worker', { origin: { kind: 'worker', fromSessionId: 'owner', agentId: 'w', task: '' } }), now, 30)).toBe(false);
    expect(eligibleArchivedSession(chat('old'), now, 0)).toBe(false);
  });
  it('fails closed while pin state is unknown, excludes pinned and company conversations, and uses supplied safe deletion', async () => {
    const deleted: string[] = [];
    const logger = vi.fn();
    const sessions = [chat('pinned'), chat('company'), chat('old')];
    const execute = (pinnedReady: boolean) => sweepArchivedSessions({
      now, retentionDays: 30, pinnedReady, pinnedIds: ['pinned'],
      sessions: async () => sessions,
      protectedConversation: async id => id === 'company',
      isBusy: async () => false,
      deleteSafely: async id => { deleted.push(id); },
      log: logger
    });
    expect(await execute(false)).toBe(0);
    expect(await execute(true)).toBe(1);
    expect(deleted).toEqual(['old']);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('old'));
  });
  it('rechecks session and activity before deletion', async () => {
    let reads = 0;
    const deleted = vi.fn();
    const count = await sweepArchivedSessions({
      now, retentionDays: 30, pinnedReady: true, pinnedIds: [],
      sessions: async () => [chat('raced')],
      readSession: async () => (++reads === 1 ? chat('raced', { updatedAt: now }) : null),
      protectedConversation: async () => false,
      isBusy: async () => false,
      deleteSafely: deleted, log: vi.fn()
    });
    expect(count).toBe(0);
    expect(deleted).not.toHaveBeenCalled();
  });
});
