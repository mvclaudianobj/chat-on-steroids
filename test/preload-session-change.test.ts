import { expect, it, vi } from 'vitest';

const { on, removeListener, expose } = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn(), expose: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke: vi.fn(), on, removeListener },
  webUtils: { getPathForFile: vi.fn() }
}));

it('forwards exact session-change ownership to the renderer and keeps catalog-only pushes payload-less', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const listener = vi.fn();
  const stop = api.onSessionChanged(listener);
  const [channel, wrapped] = on.mock.calls.find(([name]) => name === 'session:changed')!;
  expect(channel).toBe('session:changed');
  wrapped({}, { sessionIds: ['2026-09-30-aaaaaaaa'] });
  wrapped({}, { allTranscripts: true });
  wrapped({});
  expect(listener.mock.calls).toEqual([[{ sessionIds: ['2026-09-30-aaaaaaaa'] }], [{ allTranscripts: true }], [undefined]]);
  stop();
  expect(removeListener).toHaveBeenCalledWith('session:changed', wrapped);
});

it('exposes only validated archive and paged listing actions through the Electron preload', async () => {
  await import('../src/preload/index.js');
  const { ipcRenderer } = await import('electron');
  const invoke = vi.mocked(ipcRenderer.invoke);
  invoke.mockResolvedValue({ ok: true, data: true });
  const api = expose.mock.calls.at(-1)![1];
  const archive = await api.archiveSession('aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee', true);
  expect(archive).toEqual({ ok: true, data: true });
  expect(invoke).toHaveBeenCalledWith('sessions:archive', {
    id: 'aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee', archived: true
  });
  await api.listSessions({ archived: true, search: 'worker', limit: 2, cursor: { updatedAt: 5, id: 'abc12345' } });
  expect(invoke).toHaveBeenCalledWith('sessions:list', {
    archived: true, search: 'worker', limit: 2, cursor: { updatedAt: 5, id: 'abc12345' }
  });
});
