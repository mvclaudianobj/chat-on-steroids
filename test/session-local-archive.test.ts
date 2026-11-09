import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, createSession, getSession, initSessionStore, listSessionPage, resetSessionStoreForTests, setSessionArchived } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir = '';
beforeEach(async () => {
  dir = await makeTempDir('marks-local-archive-');
  vi.stubEnv('HOME', dir);
  vi.stubEnv('XDG_CONFIG_HOME', `${dir}/config`);
  vi.stubEnv('XDG_DATA_HOME', `${dir}/data`);
  initSessionStore(dir);
});
afterEach(async () => {
  resetSessionStoreForTests();
  vi.unstubAllEnvs();
  await removeTempDir(dir);
});

describe('durable local session archive', () => {
  it('separates ordinary and worker rows with independent totals and preserves transcript, project and identity', async () => {
    const ordinary = await createSession({ title: 'My ordinary chat', conversationId: 'ordinary-chat' });
    const worker = await createSession({ title: 'My worker', conversationId: 'worker-chat', origin: {
      kind: 'worker', fromSessionId: ordinary.id, agentId: 'worker-1', task: 'Deliver work'
    } });
    await appendEvent(worker.id, { time: Date.now(), source: 'app', kind: 'note', message: { text: 'Unique history', chars: 14, truncated: false } });
    const original = await getSession(worker.id);
    await setSessionArchived(worker.id, true);
    expect((await listSessionPage({ limit: 10 })).sessions.map(row => row.id)).toEqual([ordinary.id]);
    expect((await listSessionPage({ limit: 10 })).total).toBe(1);
    const archived = await listSessionPage({ archived: true, limit: 10 });
    expect(archived.total).toBe(1);
    expect(archived.sessions[0]).toMatchObject({ id: worker.id, events: original!.events, origin: original!.origin });
    resetSessionStoreForTests();
    expect((await listSessionPage({ archived: true, limit: 10 })).sessions[0]?.id).toBe(worker.id);
    await setSessionArchived(worker.id, false);
    expect((await listSessionPage({ archived: true, limit: 10 })).total).toBe(0);
    expect((await listSessionPage({ limit: 10 })).total).toBe(2);
    expect((await getSession(worker.id))?.events).toBe(original!.events);
  });

  it('is idempotent, rejects guarded actions and paginates archived results by cursor', async () => {
    const first = await createSession({ title: 'Alpha' });
    const second = await createSession({ title: 'Beta' });
    await expect(setSessionArchived(first.id, true, async () => 'Pending approval')).rejects.toThrow('Pending approval');
    expect((await getSession(first.id))?.archivedAt).toBeUndefined();
    await setSessionArchived(first.id, true);
    const before = (await getSession(first.id))!.archivedAt;
    await setSessionArchived(first.id, true);
    expect((await getSession(first.id))!.archivedAt).toBe(before);
    await setSessionArchived(second.id, true);
    const page = await listSessionPage({ archived: true, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBeTruthy();
    const next = await listSessionPage({ archived: true, limit: 1, cursor: page.nextCursor! });
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0]!.id).not.toBe(page.sessions[0]!.id);
    expect((await listSessionPage({ archived: true, search: 'alpha', limit: 5 })).sessions.map(s => s.id)).toEqual([first.id]);
  });
});
