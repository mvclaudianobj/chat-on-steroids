import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';

const secrets = new Map<string, string>();
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  hasSecret: async (key: string) => secrets.has(key),
  setSecret: async (key: string, value: string) => { if (value.trim()) secrets.set(key, value.trim()); else secrets.delete(key); },
  secretsRevision: () => 1
}));
// Local calls must not count as "ChatGPT used this connector".
const connectorUse = vi.hoisted(() => vi.fn());
const servedRequest = vi.hoisted(() => vi.fn());
vi.mock('../src/main/connector-proof.js', async original => ({ ...await original<object>(), noteConnectorUse: connectorUse }));
vi.mock('../src/main/connector-identity.js', async original => ({ ...await original<object>(), noteServedRequest: servedRequest }));

const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { flushDurable, initDurableStore, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const store = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { requestCorrelation, resetCorrelationRegistryForTests } = await import('../src/main/session/correlation.js');
const { requestIdFromHeader } = await import('../src/main/mcp/inbound.js');
const { lastToolCallAt } = await import('../src/main/mcp/kernel.js');
const executor = await import('../src/main/api-chat/executor.js');
const settings = await import('../src/main/api-chat/settings.js');
const tools = await import('../src/main/api-chat/tools.js');

const encoder = new TextEncoder();
const record = (value: unknown) => encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
const sse = (records: unknown[]): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) { for (const value of [...records, '[DONE]']) controller.enqueue(record(value)); controller.close(); }
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const text = (content: string) => sse([{ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] }]);
const calls = (list: Array<{ id: string; name: string; args: string }>, content = '') => sse([
  ...(content ? [{ choices: [{ index: 0, delta: { content }, finish_reason: null }] }] : []),
  { choices: [{ index: 0, delta: { tool_calls: list.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } })) }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
]);

type Body = { messages: Array<{ role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] }>; tools?: Array<{ function: { name: string } }> };
/** Answers each request with the next scripted response and keeps every request body. */
function scripted(responses: Array<Response | (() => Response)>) {
  const bodies: Body[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as Body);
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    return typeof next === 'function' ? next() : next;
  });
  return { bodies, fetchImpl: fetchImpl as unknown as typeof fetch, mock: fetchImpl };
}
const toolMessages = (body: Body) => body.messages.filter(message => message.role === 'tool');

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached');
}

let directory: string;
let root: string;
async function configure(over: { readOnly?: boolean; command?: boolean } = {}): Promise<void> {
  const base = defaultConfig();
  await saveConfig({
    ...base,
    roots: [{ name: 'work', path: root }],
    readOnly: over.readOnly ?? false,
    capabilities: { ...base.capabilities, command: over.command ?? true }
  });
}

beforeAll(async () => {
  directory = await makeTempDir('cos-api-tools-');
  root = path.join(directory, 'work');
  await mkdir(root);
  initConfigPath(directory);
  initDurableStore(directory);
  store.initSessionStore(directory);
});
beforeEach(async () => {
  await writeFile(path.join(root, 'hello.txt'), 'alpha line\nbeta line\n');
  await configure();
  secrets.clear();
  connectorUse.mockClear();
  servedRequest.mockClear();
  executor.resetApiChatExecutorForTests();
  settings.resetApiChatSettingsForTests();
  resetRecorderForTests();
  resetCorrelationRegistryForTests();
  store.resetSessionStoreForTests();
  await writeDurableNow(executor.API_CHAT_SESSIONS_STATE, {});
  await writeDurableNow(settings.API_CHAT_AVAILABILITY_STATE, {});
  await writeDurableNow(settings.API_CHAT_SETTINGS_STATE, {});
  await settings.updateApiChatSettings({ model: 'gpt-5', effort: null, endpoint: 'http://127.0.0.1:18081/v1' });
});
afterAll(async () => {
  executor.resetApiChatExecutorForTests();
  await flushDurable();
  resetRecorderForTests();
  store.resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

const toolRows = async (sessionId: string) => (await store.readEvents(sessionId)).filter(event => event.kind === 'tool_call');

describe('API chat tools', () => {
  it('offers only allowlisted Core tools under the live capabilities', async () => {
    const names = () => [...tools.apiChatTools(tools.liveToolContext()).keys()].sort();
    expect(names()).toEqual(['apply_patch', 'exec_command', 'read', 'update_plan', 'write_stdin']);
    await configure({ command: false });
    expect(names()).toEqual(['apply_patch', 'find', 'read', 'update_plan']);
    await configure({ readOnly: true });
    expect(names()).not.toContain('apply_patch');
    expect(names()).not.toContain('exec_command');
    expect(names()).toContain('read');
    const definitions = tools.toolDefinitions(tools.apiChatTools());
    for (const definition of definitions) {
      expect(definition.function.parameters).toMatchObject({ type: 'object' });
      expect(definition.function.parameters).not.toHaveProperty('$schema');
    }
  });

  it('HTTP ingress can never carry an API chat request id', () => {
    expect(requestIdFromHeader('cosapi:0f1e2d3c-aaaa-bbbb-cccc-0123456789ab')).toBeNull();
    expect(requestIdFromHeader('wfr_123/abc')).toBe('wfr_123');
  });

  it('runs read through the kernel, returns its exact result and continues to a final answer', async () => {
    const chat = await executor.createApiChat();
    const { bodies, fetchImpl } = scripted([
      calls([{ id: 'call_read', name: 'read', args: JSON.stringify({ paths: ['/work/hello.txt'] }) }], 'Let me look.'),
      text('The file has two lines.')
    ]);
    const { turnId, done } = await executor.sendApiChat(chat.sessionId, 'What is in hello.txt?', fetchImpl);
    expect(await done).toBe('completed');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.messages[0]!.content).toContain('read');
    const [toolMessage] = toolMessages(bodies[1]!);
    expect(toolMessage).toMatchObject({ tool_call_id: 'call_read' });
    expect(toolMessage!.content).toContain('alpha line');
    expect(bodies[1]!.messages.find(message => message.role === 'assistant')).toMatchObject({ content: 'Let me look.', tool_calls: [{ id: 'call_read' }] });
    // The kernel recorded the row, under the exact unforgeable request id, with the delivered text.
    const rows = await toolRows(chat.sessionId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    if (row.kind !== 'tool_call') throw new Error('not a tool row');
    expect(row.call).toMatchObject({ tool: 'read', attribution: 'request_id', conversationId: chat.conversationId, outcome: 'ok' });
    expect(row.call.requestId).toMatch(/^cosapi:/);
    expect(row.call.result.text).toBe(toolMessage!.content);
    expect(requestCorrelation(row.call.requestId)).toMatchObject({ conversationId: chat.conversationId, sessionId: chat.sessionId, tool: 'api-chat' });
    const answers = (await store.readEvents(chat.sessionId)).filter(event => event.kind === 'assistant_message');
    expect(answers.map(event => event.kind === 'assistant_message' && [event.messageId, event.message.text, event.final])).toEqual([
      [`api-assistant:${turnId}`, 'Let me look.', true], [`api-assistant:${turnId}:1`, 'The file has two lines.', true]
    ]);
    // Replayed context joins a turn's answer steps and never replays tool traffic.
    const context = await executor.apiChatContext(chat.sessionId);
    expect(context).toEqual([
      { role: 'user', content: 'What is in hello.txt?' },
      { role: 'assistant', content: 'Let me look.\n\nThe file has two lines.' }
    ]);
    // A local call proves no connector use.
    expect(connectorUse).not.toHaveBeenCalled();
    expect(servedRequest).not.toHaveBeenCalled();
    expect(lastToolCallAt('core')).toBeNull();
  });

  it('returns error results for unknown tools, malformed JSON and invalid arguments', async () => {
    const chat = await executor.createApiChat();
    const { bodies, fetchImpl } = scripted([
      calls([
        { id: 'a', name: 'agents', args: '{}' },
        { id: 'b', name: 'read', args: '{"paths": [' },
        { id: 'c', name: 'read', args: JSON.stringify({ paths: 'nope' }) }
      ]),
      text('Sorry.')
    ]);
    const { done } = await executor.sendApiChat(chat.sessionId, 'Try things', fetchImpl);
    expect(await done).toBe('completed');
    const results = toolMessages(bodies[1]!);
    expect(results.map(message => message.tool_call_id)).toEqual(['a', 'b', 'c']);
    expect(results[0]!.content).toMatch(/^UNKNOWN_TOOL/);
    expect(results[1]!.content).toMatch(/^INVALID_ARGUMENTS: the arguments are not valid JSON/);
    expect(results[2]!.content).toMatch(/^INVALID_ARGUMENTS: paths/);
    expect(await toolRows(chat.sessionId)).toHaveLength(0);
  });

  it('ends the turn with a notice at the step cap', async () => {
    const chat = await executor.createApiChat();
    const loop = () => calls([{ id: `call_${randomUUID()}`, name: 'read', args: JSON.stringify({ paths: ['/work/hello.txt'] }) }]);
    const { mock, fetchImpl } = scripted(Array.from({ length: executor.MAX_TOOL_STEPS + 1 }, () => loop));
    const { done } = await executor.sendApiChat(chat.sessionId, 'Loop forever', fetchImpl);
    expect(await done).toBe('completed');
    expect(mock).toHaveBeenCalledTimes(executor.MAX_TOOL_STEPS);
    const notes = (await store.readEvents(chat.sessionId)).filter(event => event.kind === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind === 'note' && notes[0]!.message.text).toContain(`${executor.MAX_TOOL_STEPS} tool steps`);
  }, 60_000);

  it('asks before a command: approve runs it, deny declines it, stale ids are refused', async () => {
    const chat = await executor.createApiChat();
    const exec = (id: string, cmd: string) => calls([{ id, name: 'exec_command', args: JSON.stringify({ cmd, workdir: '/work' }) }]);
    const { bodies, fetchImpl } = scripted([exec('one', 'echo approved-run'), exec('two', 'echo denied-run > denied.txt'), text('Done.')]);
    const { done } = await executor.sendApiChat(chat.sessionId, 'Run things', fetchImpl);
    await until(async () => (await executor.apiChatView(chat.sessionId)).pending?.toolCallId === 'one');
    const first = (await executor.apiChatView(chat.sessionId)).pending!;
    expect(first).toMatchObject({ tool: 'exec_command', summary: 'echo approved-run\n(in /work)', files: [] });
    await expect(executor.approveApiChat(chat.sessionId, randomUUID(), 'approve')).rejects.toThrow('no longer pending');
    await executor.approveApiChat(chat.sessionId, first.approvalId, 'approve');
    await expect(executor.approveApiChat(chat.sessionId, first.approvalId, 'approve')).rejects.toThrow('no longer pending');
    await until(async () => (await executor.apiChatView(chat.sessionId)).pending?.toolCallId === 'two');
    const second = (await executor.apiChatView(chat.sessionId)).pending!;
    await executor.approveApiChat(chat.sessionId, second.approvalId, 'deny');
    expect(await done).toBe('completed');
    expect(toolMessages(bodies[1]!)[0]!.content).toContain('approved-run');
    expect(toolMessages(bodies[2]!).at(-1)!.content).toBe(executor.DECLINED_RESULT);
    await expect(readFile(path.join(root, 'denied.txt'))).rejects.toThrow();
    expect((await toolRows(chat.sessionId)).map(row => row.kind === 'tool_call' && row.call.tool)).toEqual(['exec_command']);
    expect((await executor.apiChatView(chat.sessionId)).approval).toBe('ask');
  });

  it('"always" approves and switches the chat to automatic runs', async () => {
    const chat = await executor.createApiChat();
    const patch = '*** Begin Patch\n*** Add File: /work/made.txt\n+made\n*** End Patch';
    const { bodies, fetchImpl } = scripted([
      calls([{ id: 'p1', name: 'apply_patch', args: JSON.stringify({ patch }) }]),
      calls([{ id: 'p2', name: 'exec_command', args: JSON.stringify({ cmd: 'echo auto-run', workdir: '/work' }) }]),
      text('Both done.')
    ]);
    const { done } = await executor.sendApiChat(chat.sessionId, 'Make a file', fetchImpl);
    await until(async () => !!(await executor.apiChatView(chat.sessionId)).pending);
    const pending = (await executor.apiChatView(chat.sessionId)).pending!;
    expect(pending.files).toEqual(['add /work/made.txt']);
    const view = await executor.approveApiChat(chat.sessionId, pending.approvalId, 'always');
    expect(view.approval).toBe('auto');
    expect(await done).toBe('completed');
    expect(await readFile(path.join(root, 'made.txt'), 'utf8')).toBe('made\n');
    expect(toolMessages(bodies[2]!).at(-1)!.content).toContain('auto-run');
    expect((await executor.setApiChatSettings(chat.sessionId, { approval: 'ask' })).approval).toBe('ask');
  });

  it('Stop during a pending approval ends the turn stopped without running it', async () => {
    const chat = await executor.createApiChat();
    const { fetchImpl, mock } = scripted([calls([{ id: 'x', name: 'exec_command', args: JSON.stringify({ cmd: 'echo never > never.txt', workdir: '/work' }) }])]);
    const { done } = await executor.sendApiChat(chat.sessionId, 'Run', fetchImpl);
    await until(async () => !!(await executor.apiChatView(chat.sessionId)).pending);
    const pending = (await executor.apiChatView(chat.sessionId)).pending!;
    expect(executor.stopApiChat(chat.sessionId)).toBe(true);
    expect(await done).toBe('stopped');
    expect(mock).toHaveBeenCalledTimes(1);
    await expect(executor.approveApiChat(chat.sessionId, pending.approvalId, 'approve')).rejects.toThrow('no longer pending');
    await expect(readFile(path.join(root, 'never.txt'))).rejects.toThrow();
    expect(await toolRows(chat.sessionId)).toHaveLength(0);
    expect((await executor.apiChatView(chat.sessionId))).toMatchObject({ running: false, pending: null });
  });

  it('trusts a new API chat only when strict mode is on, and the kernel admits it', async () => {
    const { isChatTrusted } = await import('../src/main/session/trusted-chats.js');
    const plain = await executor.createApiChat();
    expect(isChatTrusted(plain.conversationId)).toBe(false);
    await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, strictChatAllowlist: true } });
    const strict = await executor.createApiChat();
    expect(isChatTrusted(strict.conversationId)).toBe(true);
    const run = async (sessionId: string) => {
      const { bodies, fetchImpl } = scripted([calls([{ id: 'r', name: 'read', args: JSON.stringify({ paths: ['/work/hello.txt'] }) }]), text('ok')]);
      const { done } = await executor.sendApiChat(sessionId, 'Read it', fetchImpl);
      expect(await done).toBe('completed');
      return toolMessages(bodies[1]!)[0]!.content ?? '';
    };
    expect(await run(strict.sessionId)).toContain('alpha line');
    expect(await run(plain.sessionId)).not.toContain('alpha line');
  });
});
