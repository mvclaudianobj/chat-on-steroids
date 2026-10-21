import { beforeEach, describe, expect, it, vi } from 'vitest';

const durable = new Map<string, unknown>();
vi.mock('../src/main/durable.js', () => ({
  readDurable: async (name: string) => structuredClone(durable.get(name) ?? null),
  writeDurableNow: async (name: string, value: unknown) => { durable.set(name, structuredClone(value)); }
}));
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async () => null, hasSecret: async () => false, setSecret: async () => undefined, secretsRevision: () => 1
}));

const ledger = await import('../src/main/agent-engine/ledger.js');
const registry = await import('../src/main/agent-engine/registry.js');
const { chatAction, parseApiChatRequest } = await import('../src/main/api-chat/ipc.js');
const settings = await import('../src/main/api-chat/settings.js');
import type { AgentEngine } from '../src/main/agent-engine/types.js';
import type { AgentEngineId } from '../src/shared/agent-engine.js';

const SESSION = 'session-0001';

/** An engine that records each call, as a CLI engine PR will register its own. */
function fakeEngine(id: AgentEngineId, available = true) {
  const view = (sessionId: string) => ({ sessionId, conversationId: 'cosapi-x', engine: id, model: `${id}-model`, effort: null, running: false, approval: 'ask' as const, pending: null });
  const engine = {
    id, label: id, terminalMode: null,
    status: vi.fn(async () => ({ available, detail: available ? 'ready' : 'off' })),
    models: vi.fn(async () => ({ models: [], total: 0 })),
    create: vi.fn(async () => view('session-new')),
    view: vi.fn(async (sessionId: string) => view(sessionId)),
    send: vi.fn(async () => ({ turnId: `${id}-turn` })),
    stop: vi.fn(async () => true),
    approve: vi.fn(async (sessionId: string) => view(sessionId)),
    setChatSettings: vi.fn(async (sessionId: string) => view(sessionId)),
    recover: vi.fn(async () => undefined)
  } satisfies AgentEngine;
  return engine;
}

const request = (payload: Record<string, unknown>) => chatAction(parseApiChatRequest(payload));

beforeEach(() => {
  durable.clear();
  ledger.resetChatLedgerForTests();
  registry.resetAgentEnginesForTests();
  settings.resetApiChatSettingsForTests();
});

describe('agent engine registry', () => {
  it('lists every engine in order; only CLIProxy is available in this version', async () => {
    const engines = await request({ action: 'engines' }) as Array<{ id: string; available: boolean; terminal: string | null }>;
    expect(engines.map(engine => `${engine.id}:${engine.available}:${engine.terminal}`)).toEqual([
      'cliproxy:true:null', 'markscode:false:live', 'codex:false:live', 'claude:false:handover'
    ]);
  });

  it('routes every chat action by the chat ledger record, and a record without engine to CLIProxy', async () => {
    const cliproxy = fakeEngine('cliproxy');
    const codex = fakeEngine('codex');
    registry.registerAgentEngine(cliproxy);
    registry.registerAgentEngine(codex);
    durable.set(ledger.API_CHAT_SESSIONS_STATE, {
      [SESSION]: { engine: 'codex', backendSessionId: 'thread-1', model: 'gpt-6-codex', effort: null },
      'session-0002': { model: 'claude-opus-5-5', effort: 'medium' }
    });
    expect(await request({ action: 'send', sessionId: SESSION, text: 'hello' })).toEqual({ turnId: 'codex-turn' });
    expect(codex.send).toHaveBeenCalledWith(SESSION, 'hello');
    expect(await request({ action: 'stop', sessionId: SESSION })).toEqual({ stopped: true });
    expect(await request({ action: 'chatSettings', sessionId: SESSION })).toMatchObject({ engine: 'codex' });
    await request({ action: 'setChatSettings', sessionId: SESSION, effort: 'high' });
    expect(codex.setChatSettings).toHaveBeenCalledWith(SESSION, { effort: 'high' });
    await request({ action: 'approve', sessionId: SESSION, approvalId: '0f1e2d3c-aaaa-4bbb-8ccc-0123456789ab', decision: 'always' });
    expect(codex.approve).toHaveBeenCalledWith(SESSION, '0f1e2d3c-aaaa-4bbb-8ccc-0123456789ab', 'always');
    // An older chat, and a session with no record at all, are CLIProxy chats.
    await request({ action: 'send', sessionId: 'session-0002', text: 'hi' });
    await request({ action: 'chatSettings', sessionId: 'session-0003' });
    expect(cliproxy.send).toHaveBeenCalledWith('session-0002', 'hi');
    expect(cliproxy.view).toHaveBeenCalledWith('session-0003');
    expect(codex.send).toHaveBeenCalledTimes(1);
  });

  it('creates on the named engine (CLIProxy by default) and refuses an unavailable one', async () => {
    const cliproxy = fakeEngine('cliproxy');
    registry.registerAgentEngine(cliproxy);
    registry.registerAgentEngine(fakeEngine('claude', false));
    await request({ action: 'createChat', projectId: null });
    expect(cliproxy.create).toHaveBeenCalledWith({ projectId: null });
    await expect(request({ action: 'createChat', engine: 'claude' })).rejects.toThrow('off');
    await expect(request({ action: 'createChat', engine: 'codex' })).rejects.toThrow('Codex chats are not available in this version');
    expect(() => parseApiChatRequest({ action: 'createChat', engine: 'gemini' })).toThrow();
  });

  it("loads the named engine's models, CLIProxy's catalog when none is named", async () => {
    const cliproxy = fakeEngine('cliproxy');
    const markscode = fakeEngine('markscode');
    registry.registerAgentEngine(cliproxy);
    registry.registerAgentEngine(markscode);
    await request({ action: 'models', query: 'opus', limit: 20 });
    await request({ action: 'models', engine: 'markscode', refresh: true });
    expect(cliproxy.models).toHaveBeenCalledWith({ query: 'opus', limit: 20 });
    expect(markscode.models).toHaveBeenCalledWith({ refresh: true });
  });

  it('refuses a chat whose record this version cannot read, and keeps that record untouched', async () => {
    const stored = { engine: 'gemini', model: 'g', effort: null };
    durable.set(ledger.API_CHAT_SESSIONS_STATE, { [SESSION]: stored, 'session-0002': { model: 'm', effort: null } });
    await expect(request({ action: 'send', sessionId: SESSION, text: 'hi' })).rejects.toThrow('newer version');
    await ledger.updateChatRecord('session-0002', current => current && { ...current, effort: 'low' });
    expect(durable.get(ledger.API_CHAT_SESSIONS_STATE)).toEqual({ [SESSION]: stored, 'session-0002': { model: 'm', effort: 'low' } });
  });
});

describe('API chat ledger migration', () => {
  it('reads a record written before engines as a CLIProxy chat with no backend session', async () => {
    durable.set(ledger.API_CHAT_SESSIONS_STATE, { [SESSION]: { model: 'claude-opus-5-5', effort: 'medium', approval: 'auto' } });
    const record = await ledger.storedChatRecord(SESSION);
    expect(record).toEqual({ model: 'claude-opus-5-5', effort: 'medium', approval: 'auto' });
    expect(ledger.engineOf(record)).toBe('cliproxy');
    expect(await ledger.chatEngine(SESSION)).toBe('cliproxy');
    // Rewriting it keeps the old shape: a CLIProxy record never gains an engine field.
    await ledger.updateChatRecord(SESSION, current => current && { ...current, openTurn: { turnId: 'api-1', startedAt: 1 } });
    await ledger.updateChatRecord(SESSION, ledger.withoutTurn);
    expect(durable.get(ledger.API_CHAT_SESSIONS_STATE)).toEqual({ [SESSION]: { model: 'claude-opus-5-5', effort: 'medium', approval: 'auto' } });
  });

  it('keeps an engine and its backend session id', async () => {
    await ledger.updateChatRecord(SESSION, () => ({ engine: 'claude', backendSessionId: '7b1d2c3e-4f50-4a61-8b72-9c83d4e5f601', model: null, effort: null }));
    ledger.resetChatLedgerForTests();
    expect(await ledger.chatEngine(SESSION)).toBe('claude');
    expect((await ledger.storedChatRecord(SESSION))?.backendSessionId).toBe('7b1d2c3e-4f50-4a61-8b72-9c83d4e5f601');
  });
});
