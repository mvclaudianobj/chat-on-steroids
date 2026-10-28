import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeTempDir, removeTempDir } from './helpers.js';

const secrets = new Map<string, string>();
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  hasSecret: async (key: string) => secrets.has(key),
  setSecret: async (key: string, value: string) => { if (value.trim()) secrets.set(key, value.trim()); else secrets.delete(key); },
  secureStorageStatus: async () => ({ available: true, detail: null }),
  storedSecretsUnreadable: () => false,
  secretsRevision: () => 1
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { flushDurable, initDurableStore, readDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const store = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const executor = await import('../src/main/api-chat/executor.js');
const settings = await import('../src/main/api-chat/settings.js');
const { enqueueInput } = await import('../src/main/session/input.js');
const { setGoalObjectiveNow, setGoalSwitchNow } = await import('../src/main/goal.js');

const encoder = new TextEncoder();
const delta = (content: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const record = (value: unknown) => encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
const sse = (records: unknown[]): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) { for (const value of [...records, '[DONE]']) controller.enqueue(record(value)); controller.close(); }
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** A stream the test feeds by hand; aborting the request errors it like a real fetch body. */
function liveStream(init: RequestInit) {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } }), { status: 200 });
  init.signal?.addEventListener('abort', () => feed.error(new DOMException('The operation was aborted.', 'AbortError')));
  return { response, send: (value: unknown) => feed.enqueue(record(value)), end: () => { feed.enqueue(record('[DONE]')); feed.close(); } };
}

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(((fetchImpl.mock.calls[call] as unknown as [string, RequestInit])[1].body as string)) as { model: string; messages: Array<{ role: string; content: string }>; tools?: unknown; reasoning_effort?: string };
const transcript = async (sessionId: string) => (await store.readEvents(sessionId))
  .filter(event => ['user_message', 'assistant_message', 'turn_start', 'turn_end', 'chat_error'].includes(event.kind));

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('condition not reached');
}

let directory: string;
beforeAll(async () => {
  directory = await makeTempDir('cos-api-chat-');
  initConfigPath(directory);
  initDurableStore(directory);
  store.initSessionStore(directory);
  await saveConfig(defaultConfig());
});
beforeEach(async () => {
  secrets.clear();
  executor.resetApiChatExecutorForTests();
  settings.resetApiChatSettingsForTests();
  resetRecorderForTests();
  store.resetSessionStoreForTests();
  await writeDurableNow(executor.API_CHAT_SESSIONS_STATE, {});
  await writeDurableNow(settings.API_CHAT_AVAILABILITY_STATE, {});
  await writeDurableNow(settings.API_CHAT_SETTINGS_STATE, {});
  await settings.updateApiChatSettings({ model: 'claude-opus-5-5', effort: 'medium', endpoint: 'http://127.0.0.1:18081/v1' });
});
afterAll(async () => {
  executor.resetApiChatExecutorForTests();
  await flushDurable();
  resetRecorderForTests();
  store.resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

describe('API chat executor', () => {
  it('creates a real session in the cosapi namespace with the default model', async () => {
    const chat = await executor.createApiChat();
    expect(chat.conversationId).toMatch(/^cosapi-[0-9a-f-]{36}$/);
    expect(chat).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', running: false });
    const session = await store.getSession(chat.sessionId);
    expect(session?.conversationId).toBe(chat.conversationId);
    expect(session?.origin ?? null).toBeNull();
    expect(await readDurable(executor.API_CHAT_SESSIONS_STATE)).toEqual({ [chat.sessionId]: { model: 'claude-opus-5-5', effort: 'medium' } });
    await expect(executor.createApiChat({ projectId: randomUUID() })).rejects.toThrow('Project not found');
  });

  it('records the question, the streamed answer and a completed turn', async () => {
    const chat = await executor.createApiChat();
    let stream!: ReturnType<typeof liveStream>;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => (stream = liveStream(init)).response);
    const { turnId, done } = await executor.sendApiChat(chat.sessionId, 'Hello there', fetchImpl as unknown as typeof fetch);
    expect((await executor.apiChatView(chat.sessionId)).running).toBe(true);
    await until(async () => fetchImpl.mock.calls.length === 1);
    stream.send(delta('Hi, '));
    // The throttled writer stores the partial answer as streaming before the end arrives.
    await until(async () => (await transcript(chat.sessionId)).some(event => event.kind === 'assistant_message' && event.state === 'streaming'));
    stream.send(delta('how can I help?'));
    stream.end();
    expect(await done).toBe('completed');
    const events = await transcript(chat.sessionId);
    expect(events.map(event => event.kind)).toEqual(['user_message', 'turn_start', 'assistant_message', 'turn_end']);
    expect(events[0]).toMatchObject({ source: 'app', message: { text: 'Hello there' } });
    expect(events[1]).toMatchObject({ turnId });
    expect(events[2]).toMatchObject({ turnId, state: 'final', final: true, message: { text: 'Hi, how can I help?' } });
    expect(events[3]).toMatchObject({ turnId, outcome: 'completed' });
    const body = bodyOf(fetchImpl);
    // D4: the live Core tools are offered (only the allowlisted ones), with tool_choice auto.
    const offered = (body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name);
    expect(offered.every(name => ['read', 'find', 'apply_patch', 'exec_command', 'write_stdin', 'update_plan'].includes(name))).toBe(true);
    expect(body).toMatchObject({ model: 'claude-opus-5-5', reasoning_effort: 'medium', tool_choice: 'auto' });
    expect(body.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect((await executor.apiChatView(chat.sessionId)).running).toBe(false);
    expect((await store.getSession(chat.sessionId))?.title).toBe('Hello there');
    expect((await settings.apiChatStatus()).recents[0]).toBe('claude-opus-5-5');
    expect((await settings.modelAvailability('http://127.0.0.1:18081/v1')).get('claude-opus-5-5')).toMatchObject({ ok: true });
    expect(await readDurable(executor.API_CHAT_SESSIONS_STATE)).toEqual({ [chat.sessionId]: { model: 'claude-opus-5-5', effort: 'medium' } });
  });

  it('adds Brain context to the system message each turn only while auto-inject is on (H1c)', async () => {
    const brain = await import('../src/main/brain/store.js');
    const brainSettings = await import('../src/main/brain/settings.js');
    const { default: nodePath } = await import('node:path');
    brain.configureBrainForTests(nodePath.join(directory, `brain-${randomUUID()}.sqlite`));
    await brain.brainSave({ content: 'The billing service is written in Go', title: 'billing' });
    const chat = await executor.createApiChat();
    const fetchImpl = vi.fn(async () => sse([delta('ok')]));
    try {
      await (await executor.sendApiChat(chat.sessionId, 'tell me about billing', fetchImpl as unknown as typeof fetch)).done;
      expect(bodyOf(fetchImpl, 0).messages[0]!.content).not.toContain('<memory-context>');
      await brainSettings.setBrainSettings({ autoInject: true });
      await (await executor.sendApiChat(chat.sessionId, 'and billing again', fetchImpl as unknown as typeof fetch)).done;
      const system = bodyOf(fetchImpl, 1).messages[0]!;
      expect(system.role).toBe('system');
      expect(system.content).toContain('<memory-context>');
      expect(system.content).toContain('billing: The billing service is written in Go');
    } finally { await brainSettings.setBrainSettings({ autoInject: false }); }
  });

  it('sends prior turns as context and uses a model switched for this chat', async () => {
    const chat = await executor.createApiChat();
    const fetchImpl = vi.fn(async () => sse([delta('first answer')]));
    await (await executor.sendApiChat(chat.sessionId, 'first question', fetchImpl as unknown as typeof fetch)).done;
    await executor.setApiChatSettings(chat.sessionId, { model: 'gpt-6-sol', effort: null });
    expect(await executor.apiChatView(chat.sessionId)).toMatchObject({ model: 'gpt-6-sol', effort: null });
    await (await executor.sendApiChat(chat.sessionId, 'second question', fetchImpl as unknown as typeof fetch)).done;
    const body = bodyOf(fetchImpl, 1);
    expect(body.model).toBe('gpt-6-sol');
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.messages.slice(1)).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' }
    ]);
    // The global default is untouched by a chat's own switch.
    expect((await settings.apiChatSettings()).model).toBe('claude-opus-5-5');
  });

  it('bounds the context, keeping the newest messages', async () => {
    const chat = await executor.createApiChat();
    for (let index = 0; index < 70; index++) {
      await store.upsertMessageEvent(chat.sessionId, { time: index + 1, source: 'app', kind: 'user_message', messageId: `old-${index}`,
        message: { text: `question ${index}`, truncated: false, chars: 11 } });
    }
    const context = await executor.apiChatContext(chat.sessionId);
    expect(context).toHaveLength(60);
    expect(context.at(-1)).toEqual({ role: 'user', content: 'question 69' });
    const big = 'x'.repeat(70_000);
    await store.upsertMessageEvent(chat.sessionId, { time: 200, source: 'app', kind: 'user_message', messageId: 'big-1', message: { text: big, truncated: false, chars: big.length } });
    await store.upsertMessageEvent(chat.sessionId, { time: 201, source: 'app', kind: 'user_message', messageId: 'big-2', message: { text: big, truncated: false, chars: big.length } });
    expect(await executor.apiChatContext(chat.sessionId)).toEqual([{ role: 'user', content: big }]);
  });

  it('refuses a second send while a turn runs, and Stop keeps the partial answer', async () => {
    const chat = await executor.createApiChat();
    let stream!: ReturnType<typeof liveStream>;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => (stream = liveStream(init)).response);
    const { done } = await executor.sendApiChat(chat.sessionId, 'Write a lot', fetchImpl as unknown as typeof fetch);
    await expect(executor.sendApiChat(chat.sessionId, 'Again', fetchImpl as unknown as typeof fetch)).rejects.toThrow('still answering');
    await until(async () => fetchImpl.mock.calls.length === 1);
    stream.send(delta('Half of it'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(executor.stopApiChat(chat.sessionId)).toBe(true);
    expect(await done).toBe('stopped');
    const events = await transcript(chat.sessionId);
    expect(events.find(event => event.kind === 'assistant_message')).toMatchObject({ state: 'final', message: { text: 'Half of it' } });
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'stopped' });
    expect(events.some(event => event.kind === 'chat_error')).toBe(false);
    expect(executor.stopApiChat(chat.sessionId)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails a 401 without a stored key, asks for the key and records the model unavailable', async () => {
    const chat = await executor.createApiChat();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Missing API key' } }), { status: 401 }));
    expect(await (await executor.sendApiChat(chat.sessionId, 'Hi', fetchImpl as unknown as typeof fetch)).done).toBe('failed');
    const events = await transcript(chat.sessionId);
    expect(events.map(event => event.kind)).toEqual(['user_message', 'turn_start', 'chat_error', 'turn_end']);
    expect(events[2]).toMatchObject({ kind: 'chat_error', message: { text: expect.stringContaining('HTTP 401: Missing API key') } });
    expect(events[3]).toMatchObject({ outcome: 'failed' });
    expect((await settings.apiChatStatus()).keyRequired).toBe(true);
    expect((await settings.modelAvailability('http://127.0.0.1:18081/v1')).get('claude-opus-5-5')).toMatchObject({ ok: false, error: 'HTTP 401: Missing API key' });
    expect((await settings.apiChatStatus()).recents).toEqual([]);
  });

  it('fails on an error inside the stream, keeping what was written', async () => {
    const chat = await executor.createApiChat();
    const fetchImpl = vi.fn(async () => sse([delta('Partial'), { error: { message: 'upstream overloaded' } }]));
    expect(await (await executor.sendApiChat(chat.sessionId, 'Hi', fetchImpl as unknown as typeof fetch)).done).toBe('failed');
    const events = await transcript(chat.sessionId);
    expect(events.find(event => event.kind === 'assistant_message')).toMatchObject({ state: 'final', message: { text: 'Partial' } });
    expect(events.find(event => event.kind === 'chat_error')).toMatchObject({ message: { text: expect.stringContaining('upstream overloaded') } });
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'failed' });
    expect((await executor.apiChatView(chat.sessionId)).running).toBe(false);
  });

  it('refuses sessions that are not API chats and chats without a model', async () => {
    const plain = await store.createSession({ title: 'ChatGPT', conversationId: 'abcdef12-3456-7890-abcd-ef1234567890' });
    await expect(executor.sendApiChat(plain.id, 'Hi')).rejects.toThrow('not an API chat');
    await expect(executor.apiChatView(plain.id)).rejects.toThrow('not an API chat');
    await settings.updateApiChatSettings({ model: null });
    const chat = await executor.createApiChat();
    await expect(executor.sendApiChat(chat.sessionId, 'Hi')).rejects.toThrow('Choose a model');
    expect((await executor.apiChatView(chat.sessionId)).running).toBe(false);
    expect(await transcript(chat.sessionId)).toEqual([]);
  });

  it('closes a turn the previous run left open as interrupted, settling its partial answer', async () => {
    const chat = await executor.createApiChat();
    const turnId = 'api-left-open';
    await writeDurableNow(executor.API_CHAT_SESSIONS_STATE, { [chat.sessionId]: { model: 'claude-opus-5-5', effort: null, openTurn: { turnId, startedAt: 1 } } });
    await store.upsertMessageEvent(chat.sessionId, { time: 1, source: 'app', kind: 'user_message', messageId: `api-user:${turnId}`, message: { text: 'Q', truncated: false, chars: 1 } });
    await store.appendEvent(chat.sessionId, { time: 2, source: 'app', kind: 'turn_start', turnId });
    await store.upsertMessageEvent(chat.sessionId, { time: 3, source: 'app', kind: 'assistant_message', turnId, messageId: `api-assistant:${turnId}`,
      message: { text: 'Partly', truncated: false, chars: 6 }, state: 'streaming', final: false });
    await store.flushSessions();
    executor.resetApiChatExecutorForTests();
    store.resetSessionStoreForTests();
    await executor.recoverApiChats();
    const events = await transcript(chat.sessionId);
    expect(events.find(event => event.kind === 'assistant_message')).toMatchObject({ state: 'final', message: { text: 'Partly' } });
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', turnId, outcome: 'interrupted' });
    expect((await store.getSession(chat.sessionId))?.activeTurnId).toBeNull();
    expect(await readDurable(executor.API_CHAT_SESSIONS_STATE)).toEqual({ [chat.sessionId]: { model: 'claude-opus-5-5', effort: null } });
    // A second recovery in the same run is the same promise: nothing is closed twice.
    await executor.recoverApiChats();
    expect((await transcript(chat.sessionId)).filter(event => event.kind === 'turn_end')).toHaveLength(1);
  });
});

describe('ChatGPT-only owners refuse API chats', () => {
  it('keeps the desktop outbox and Goal/Loop off an API chat', async () => {
    const chat = await executor.createApiChat();
    await expect(enqueueInput({ id: randomUUID(), sessionId: chat.sessionId, text: 'Hi', mode: 'auto', dueAt: Date.now(),
      model: null, reasoningEffort: null, automation: 'off' })).rejects.toThrow('API chats send through their own composer');
    await expect(setGoalSwitchNow(chat.conversationId, 'goal', true)).rejects.toThrow('api_chat_session');
    await expect(setGoalObjectiveNow(chat.conversationId, 'Ship it')).rejects.toThrow('api_chat_session');
  });

  it('never attaches browser observations or request proof to an API chat', async () => {
    const chat = await executor.createApiChat();
    const { recordRequestEvidence, sessionForConversation } = await import('../src/main/session/recorder.js');
    const { requestCorrelation } = await import('../src/main/session/correlation.js');
    expect(await sessionForConversation(chat.conversationId, 'Page title')).toBeNull();
    const requestId = `req-${randomUUID()}`;
    expect(await recordRequestEvidence(chat.conversationId, [
      { kind: 'tool_evidence', calls: [{ requestId, tool: 'read' }] } as never
    ])).toBeNull();
    expect(requestCorrelation(requestId)).toBeNull();
  });
});
