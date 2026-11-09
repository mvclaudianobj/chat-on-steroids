import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';

// Chat Marks live test: `/remember` memorizes the chat it is called in. Main resolves that chat,
// says whether its model has memory tools, and saves with the chat's provenance and project scope.
const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => { electron.handlers.set(channel, handler); } }
}));
const store = vi.hoisted(() => ({ getSession: vi.fn(), readEvents: vi.fn(), readOverflowText: vi.fn() }));
vi.mock('../src/main/session/store.js', () => store);
const ledger = vi.hoisted(() => ({ storedChatRecord: vi.fn() }));
vi.mock('../src/main/agent-engine/ledger.js', () => ledger);
const settings = vi.hoisted(() => ({ value: { chatgptTools: false, apiChatTools: false, enginesEnabled: false, askBeforeSaving: true } }));
vi.mock('../src/main/brain/settings.js', () => ({ getBrainSettings: () => settings.value, setBrainSettings: vi.fn() }));
const brain = vi.hoisted(() => ({ saved: [] as unknown[] }));
vi.mock('../src/main/brain/store.js', () => ({
  brainSave: vi.fn(async (input: Record<string, unknown>) => { brain.saved.push(input); return { id: '00000000-0000-4000-8000-000000000001', ...input }; }),
  brainDelete: vi.fn(), brainDoctor: vi.fn(), brainGet: vi.fn(), brainList: vi.fn(), brainSearch: vi.fn(), brainStatus: vi.fn(), brainUpdate: vi.fn()
}));
vi.mock('../src/main/brain/recall.js', () => ({ combinedRecall: vi.fn(), deleteRemoteCopy: vi.fn(), providerStatuses: vi.fn(), syncSavedMemory: vi.fn(async () => []) }));
vi.mock('../src/main/brain/provider-keys.js', () => ({ importMarksCodeCredential: vi.fn(), storeProviderKey: vi.fn() }));
vi.mock('../src/main/brain/approval.js', () => ({ brainPendingApprovals: vi.fn(), decideBrainSaveApproval: vi.fn(), onBrainApprovalsChanged: vi.fn() }));
vi.mock('../src/main/brain/import/ipc.js', () => ({ isBrainImportAction: () => false, runBrainImport: vi.fn() }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

const { registerBrainIpc } = await import('../src/main/brain/ipc.js');
const { brainChatOf, brainChatTools, brainProjectScope, setBrainChatDeps, LATEST_ANSWER_MAX } = await import('../src/main/brain/chat-memory.js');

const PROJECT = '6f1c2a34-1b2c-4d5e-8f90-123456789abc';
const sessions: Record<string, { id: string; title: string; conversationId: string | null; projectId?: string }> = {
  native: { id: 'native', title: 'Plano do release', conversationId: '68a0c0de-0000-4000-8000-000000000001', projectId: PROJECT },
  api: { id: 'api', title: 'CLIProxy', conversationId: 'cosapi-1' },
  claude: { id: 'claude', title: 'Claude', conversationId: 'cosapi-2', projectId: PROJECT },
  retired: { id: 'retired', title: 'Old', conversationId: 'cosapi-3' }
};
const engines: Record<string, string> = { claude: 'claude', retired: 'markscode' };

const window = { isDestroyed: () => false, webContents: { mainFrame: {}, send: vi.fn() } };
const call = (action: string, payload: unknown) => electron.handlers.get('marksBrain:request')!(
  { sender: window.webContents, senderFrame: window.webContents.mainFrame }, { action, payload }) as Promise<{ ok: boolean; data?: any; error?: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  brain.saved.length = 0;
  settings.value = { chatgptTools: false, apiChatTools: false, enginesEnabled: false, askBeforeSaving: true };
  store.getSession.mockImplementation(async (id: string) => sessions[id] ?? null);
  ledger.storedChatRecord.mockImplementation(async (id: string) => engines[id] ? { engine: engines[id] } : id === 'api' ? {} : undefined);
  setBrainChatDeps({ canWrite: async () => true, chatgptRefresh: async () => 'current', platform: 'linux' });
  if (!electron.handlers.size) registerBrainIpc(() => window as never);
});

describe('the chat /remember is called in', () => {
  it('names its kind, engine and project scope (global without a project)', async () => {
    await expect(brainChatOf('native')).resolves.toMatchObject({ kind: 'chatgpt', engine: 'chatgpt', scope: `project:${PROJECT}` });
    await expect(brainChatOf('api')).resolves.toMatchObject({ kind: 'api', engine: 'cliproxy', scope: 'global' });
    await expect(brainChatOf('claude')).resolves.toMatchObject({ kind: 'engine', engine: 'claude', scope: `project:${PROJECT}` });
    await expect(brainChatOf('missing')).resolves.toBeNull();
    expect(brainProjectScope('../etc')).toBe('global');
    expect(brainProjectScope(null)).toBe('global');
  });

  it('says which switch is off instead of claiming the tools are there', async () => {
    const reason = async (id: string) => { const result = await brainChatTools((await brainChatOf(id))!); return result.available ? 'available' : result.reason; };
    expect(await reason('native')).toBe('chatgpt-off');
    expect(await reason('api')).toBe('api-off');
    expect(await reason('claude')).toBe('engines-off');
    expect(await reason('retired')).toBe('engine-unsupported');
    settings.value = { ...settings.value, chatgptTools: true, apiChatTools: true, enginesEnabled: true };
    expect(await reason('native')).toBe('available');
    expect(await reason('api')).toBe('available');
    expect(await reason('claude')).toBe('available');
    setBrainChatDeps({ canWrite: async () => true, chatgptRefresh: async () => 'pending', platform: 'linux' });
    expect(await reason('native')).toBe('chatgpt-refresh');
    setBrainChatDeps({ canWrite: async () => false, chatgptRefresh: async () => 'current', platform: 'win32' });
    expect(await reason('api')).toBe('read-only');
    expect(await reason('claude')).toBe('engine-unsupported');
  });
});

describe('Brain IPC for /remember', () => {
  it('answers chat.tools for the chat the renderer names', async () => {
    await expect(call('chat.tools', { sessionId: 'native' })).resolves.toEqual({ ok: true, data: { available: false, kind: 'chatgpt', engine: 'chatgpt', reason: 'chatgpt-off' } });
    await expect(call('chat.tools', { sessionId: 'missing' })).resolves.toMatchObject({ ok: false });
  });

  it('saves /remember <text> with chat provenance and the chat project scope; the renderer cannot choose either', async () => {
    await expect(call('chat.save', { sessionId: 'claude', content: 'O projeto usa pnpm' })).resolves.toMatchObject({ ok: true });
    expect(brain.saved).toEqual([expect.objectContaining({ content: 'O projeto usa pnpm', scope: `project:${PROJECT}`, provenance: { source: 'chat', sessionId: 'claude', engine: 'claude' } })]);
    await expect(call('chat.save', { sessionId: 'claude', content: 'x', scope: 'global' })).resolves.toMatchObject({ ok: false });
    await expect(call('chat.save', { sessionId: 'claude', content: 'x', provenance: { source: 'user' } })).resolves.toMatchObject({ ok: false });
    expect(brain.saved).toHaveLength(1);
  });

  it('saves the latest finished answer, bounded, as one chat memory; nothing when there is none', async () => {
    const long = 'Decidimos usar pnpm. '.repeat(400);
    store.readEvents.mockResolvedValue([
      { seq: 1, time: 1, source: 'extension', kind: 'user_message', turnId: 't1', messageId: 'u1', message: { text: 'Qual gerenciador?', truncated: false, chars: 17 } },
      { seq: 2, time: 2, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'a1', final: true, state: 'final', message: { text: long, truncated: false, chars: long.length } },
      { seq: 3, time: 3, source: 'extension', kind: 'turn_end', turnId: 't1', outcome: 'completed' }
    ] as SessionEvent[]);
    await expect(call('chat.saveLatestAnswer', { sessionId: 'native' })).resolves.toMatchObject({ ok: true });
    const saved = brain.saved[0] as { content: string; title: string; scope: string; provenance: unknown };
    expect(saved.content.length).toBeLessThanOrEqual(LATEST_ANSWER_MAX);
    expect(saved.content.startsWith('Decidimos usar pnpm.')).toBe(true);
    expect(saved).toMatchObject({ title: 'Plano do release', scope: `project:${PROJECT}`, provenance: { source: 'chat', sessionId: 'native', engine: 'chatgpt' } });
    store.readEvents.mockResolvedValue([]);
    await expect(call('chat.saveLatestAnswer', { sessionId: 'api' })).resolves.toEqual({ ok: true, data: null });
    expect(brain.saved).toHaveLength(1);
  });

  it('keeps memories.save a plain user save', async () => {
    await expect(call('memories.save', { content: 'Prefiro respostas curtas' })).resolves.toMatchObject({ ok: true });
    expect(brain.saved).toEqual([expect.objectContaining({ content: 'Prefiro respostas curtas', scope: 'global', provenance: { source: 'user' } })]);
  });
});
