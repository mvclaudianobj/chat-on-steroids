import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { duplexPair } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeTempDir, removeTempDir } from './helpers.js';

vi.mock('../src/main/secrets.js', () => ({
  getSecret: async () => null, hasSecret: async () => false, setSecret: async () => undefined, secretsRevision: () => 1
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { flushDurable, initDurableStore, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const store = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const executor = await import('../src/main/api-chat/executor.js');
const ledger = await import('../src/main/agent-engine/ledger.js');
const protocol = await import('../src/main/agent-engine/codex-protocol.js');
const { createCodexEngine, CODEX_NOT_SIGNED_IN } = await import('../src/main/agent-engine/codex.js');
const { JsonRpcPeer, connectWebSocket } = await import('../src/main/agent-engine/jsonrpc.js');
const { acceptWebSocket } = createRequire(import.meta.url)('./fixtures/agent-engine/websocket-stdio.cjs') as { acceptWebSocket(stream: unknown, options?: { maxPayload?: number }): Promise<import('ws').WebSocket> };
const { recoversOwnTurns } = await import('../src/main/agent-engine/recovery.js');
import type { CodexEngine, CodexHost } from '../src/main/agent-engine/codex.js';

const FAKE = fileURLToPath(new URL('./fixtures/agent-engine/codex-fake-app-server.cjs', import.meta.url));
const SOCKET = '/tmp/chat-marks-codex-test.sock';
const ROUTER_SOCKET = '/tmp/chat-marks-codex-test-router.sock';
const run = promisify(execFile);

// ---------------------------------------------------------------- schema subset (checked in, from generate-json-schema)

type Schema = Record<string, unknown>;
const schemaFile = JSON.parse(readFileSync(new URL('./fixtures/agent-engine/codex-app-server-schema.json', import.meta.url), 'utf8')) as { codexVersion: string; definitions: Record<string, Schema> };
const defs = schemaFile.definitions;

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'array': return Array.isArray(value);
    case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
    default: return false;
  }
}

/** The JSON Schema keywords the generated subset uses (draft-07): enough to check our shapes. */
function violations(schema: Schema, value: unknown, at = '$'): string[] {
  if (typeof schema.$ref === 'string') return violations(defs[schema.$ref.replace('#/definitions/', '')]!, value, at);
  const errors: string[] = [];
  for (const part of (schema.allOf as Schema[] | undefined) ?? []) errors.push(...violations(part, value, at));
  if (schema.anyOf && !(schema.anyOf as Schema[]).some(part => !violations(part, value, at).length)) errors.push(`${at}: matches no anyOf`);
  if (schema.oneOf) {
    const matched = (schema.oneOf as Schema[]).filter(part => !violations(part, value, at).length).length;
    if (matched !== 1) errors.push(`${at}: matches ${matched} oneOf`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    if (!types.some(type => typeMatches(type, value))) return [...errors, `${at}: not ${types.join('|')}`];
  }
  if (schema.enum && !(schema.enum as unknown[]).some(option => JSON.stringify(option) === JSON.stringify(value))) errors.push(`${at}: not one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${at}: too short`);
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${at}: below minimum`);
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...violations(schema.items as Schema, item, `${at}[${index}]`)));
  if (typeMatches('object', value)) {
    const object = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in object)) errors.push(`${at}.${key}: required`);
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, item] of Object.entries(object)) {
      if (properties[key]) errors.push(...violations(properties[key]!, item, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...violations(schema.additionalProperties as Schema, item, `${at}.${key}`));
    }
  }
  return errors;
}
const conforms = (definition: string, value: unknown): void => { expect(violations({ $ref: `#/definitions/${definition}` }, value), definition).toEqual([]); };

// ---------------------------------------------------------------- fake app-server host

interface Logged { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string }; argv?: string[] }

let directory: string;
let cwd: string;
let counter = 0;
let engine: CodexEngine | null = null;

function fakeHost(options: { script?: Record<string, unknown>; version?: string; unavailable?: string; router?: boolean } = {}) {
  const id = ++counter;
  const logFile = path.join(directory, `fake-${id}.log`);
  const scriptFile = path.join(directory, `fake-${id}.json`);
  writeFileSync(scriptFile, JSON.stringify(options.script ?? {}));
  const env = { ...process.env, CODEX_FAKE_LOG: logFile, CODEX_FAKE_SCRIPT: scriptFile, CODEX_FAKE_VERSION: options.version ?? '0.163.0' };
  const opened: string[][] = [];
  const routing = options.router
    ? { detected: true, provider: 'claude-code-router', directOverrides: ['model_provider="openai"', 'model_catalog_json="/home/user/.codex/models_cache.json"'] }
    : { detected: false, provider: null, directOverrides: [] };
  const terminals: Array<{ sessionId: string; projectId: string | null; args: string[]; title: string }> = [];
  let terminalHook: ((chatSessionId: string | null) => Promise<void>) | null = null;
  const host: CodexHost = {
    runtime: async () => options.unavailable ? { ok: false, detail: options.unavailable } : { ok: true, runtime: { binary: FAKE, windows: false } },
    run: async (_runtime, args) => (await run(process.execPath, [FAKE, ...args], { env })).stdout.trim(),
    routing: () => routing,
    open: async (_runtime, route) => {
      const socket = route === 'router' ? ROUTER_SOCKET : SOCKET;
      const argv = protocol.codexServerArgv(socket, route === 'direct' ? routing.directOverrides : []);
      opened.push(argv);
      // The fake is server and proxy at once: its stdio is the socket's WebSocket, as with 0.163.
      const client = spawn(process.execPath, [FAKE, ...argv], { env: { ...env, CODEX_FAKE_ROUTE: route, ...(route === 'router' ? { CODEX_FAKE_LOG: `${logFile}.router` } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
      return { client, server: null, socket };
    },
    workspace: async () => cwd,
    appVersion: async () => '2.1.42',
    openTerminal: async chat => { terminals.push(chat); return { id: 'cli-codex-1' }; },
    onTerminalOpen: listener => { terminalHook = listener; }
  };
  const messages = (route: 'direct' | 'router' = 'direct'): Logged[] => {
    const file = route === 'router' ? `${logFile}.router` : logFile;
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Logged) : [];
  };
  return {
    host, messages, opened, terminals, terminalHook: () => terminalHook,
    requests: (method: string, route: 'direct' | 'router' = 'direct') => messages(route).filter(message => message.method === method)
  };
}

async function until<T>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false, what = 'condition'): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value) return value as T;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${what} not reached`);
}

function start(options: Parameters<typeof fakeHost>[0] = {}) {
  const fake = fakeHost(options);
  engine = createCodexEngine({ host: fake.host, streamWriteMs: 0 });
  return { fake, engine };
}

const transcript = async (sessionId: string): Promise<string[]> => (await store.readEvents(sessionId)).flatMap(event => {
  switch (event.kind) {
    case 'user_message': return [`user ${event.message.text}`];
    case 'assistant_message': return event.final ? [`assistant ${event.message.text}`] : [];
    case 'tool_call': return [`tool ${event.call.tool} ${event.call.outcome} ${event.call.summary.title}${event.call.summary.metric ? ` [${event.call.summary.metric}]` : ''}`];
    case 'chat_error': return [`error ${event.recoverable ? 'recoverable' : 'fatal'} ${event.message.text}`];
    case 'turn_start': return ['turn_start'];
    case 'turn_end': return [`turn_end ${event.outcome}${event.detail ? ` (${event.detail})` : ''}`];
    default: return [];
  }
});

// Recorded 0.163 shapes (ThreadItem variants), kept to the fields the adapter reads plus the required ones.
const commandItem = (status: string, extra: Record<string, unknown> = {}) => ({
  type: 'commandExecution', id: 'item-cmd-1', pluginId: null, scriptPath: null, command: 'npm test', cwd: '$CWD', processId: null, source: 'agent',
  status, commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, ...extra
});
const patchItem = (status: string) => ({
  type: 'fileChange', id: 'item-patch-1', status,
  changes: [{ path: 'src/sum.ts', kind: { type: 'update', move_path: null }, diff: '--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1 +1,2 @@\n-return a - b;\n+return a + b;\n+// fixed\n' }]
});
const mcpItem = (status: string) => ({
  type: 'mcpToolCall', id: 'item-mcp-1', server: 'docs', tool: 'search', status, arguments: { query: 'sum' }, appContext: null, mcpAppUi: null, pluginId: null,
  readOnlyHint: true, result: status === 'completed' ? { content: [{ type: 'text', text: '2 results' }], structuredContent: null, _meta: null } : null, error: null, durationMs: null
});
const message = (text: string, id = 'item-msg-1') => ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null, questions: null });
const item = (kind: 'started' | 'completed', value: unknown) => ({ notify: `item/${kind}`, params: { threadId: '$THREAD', turnId: '$TURN', item: value, [kind === 'started' ? 'startedAtMs' : 'completedAtMs']: 1 } });
const delta = (text: string, itemId = 'item-msg-1') => ({ notify: 'item/agentMessage/delta', params: { threadId: '$THREAD', turnId: '$TURN', itemId, delta: text } });
const completed = (status = 'completed', error: unknown = null) => ({ notify: 'turn/completed', params: { threadId: '$THREAD', turn: { id: '$TURN', rootTurnId: null, items: [], itemsView: 'full', status, error, startedAt: 1, completedAt: 2, durationMs: 1 } } });
const commandApproval = (id: number) => ({ request: 'item/commandExecution/requestApproval', id, params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'item-cmd-1', startedAtMs: 1, approvalId: `codex-approval-${id}`, environmentId: null, kind: 'command', command: 'npm test', cwd: '/work/app', reason: 'Runs the test suite' } });
const patchApproval = (id: number) => ({ request: 'item/fileChange/requestApproval', id, params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'item-patch-1', startedAtMs: 1, reason: null, grantRoot: null } });

const fixCwd = (steps: unknown[]): unknown[] => JSON.parse(JSON.stringify(steps).replaceAll('"$CWD"', JSON.stringify(cwd))) as unknown[];

beforeAll(async () => {
  directory = await makeTempDir('cos-codex-engine-');
  cwd = path.join(directory, 'project');
  initConfigPath(directory);
  initDurableStore(directory);
  store.initSessionStore(directory);
  await saveConfig(defaultConfig());
});
beforeEach(async () => {
  executor.resetApiChatExecutorForTests();
  resetRecorderForTests();
  store.resetSessionStoreForTests();
  await writeDurableNow(ledger.API_CHAT_SESSIONS_STATE, {});
});
afterEach(() => {
  engine?.shutdown();
  engine = null;
});
afterAll(async () => {
  executor.resetApiChatExecutorForTests();
  await flushDurable();
  resetRecorderForTests();
  store.resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

describe('Codex protocol (pure)', () => {
  it('starts every Codex process without a bypass flag, approvals and sandbox pinned', () => {
    const argvs = [protocol.codexServerArgv(SOCKET), protocol.codexProxyArgv(SOCKET), protocol.codexTerminalArgv('thread-1', SOCKET), protocol.codexVersionArgv()];
    expect(argvs).toEqual([
      ['app-server', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"', '-c', 'approvals_reviewer="user"', '--listen', `unix://${SOCKET}`],
      ['app-server', 'proxy', '--sock', SOCKET],
      ['resume', 'thread-1', '--remote', `unix://${SOCKET}`],
      ['--version']
    ]);
    for (const argv of argvs) for (const forbidden of protocol.CODEX_FORBIDDEN_ARGS) expect(argv).not.toContain(forbidden);
    expect(argvs.flat().join(' ')).not.toMatch(/danger|bypass|yolo|full-auto|"never"/);
  });

  it('gates the version: same major and the tested minor or newer only', () => {
    expect(protocol.checkCodexVersion('codex-cli 0.163.0')).toEqual({ ok: true, version: '0.163.0', warning: null });
    expect(protocol.checkCodexVersion('codex-cli 0.164.2')).toMatchObject({ ok: true, warning: 'Codex 0.164.2 is newer than the tested 0.163.0' });
    expect(protocol.checkCodexVersion('codex-cli 0.162.9')).toMatchObject({ ok: false, detail: 'Codex 0.162.9 is not supported; Chat Marks supports Codex 0.163.0' });
    expect(protocol.checkCodexVersion('codex-cli 1.0.0')).toMatchObject({ ok: false });
    expect(protocol.checkCodexVersion('garbage')).toMatchObject({ ok: false, version: null });
    expect(schemaFile.codexVersion).toBe(protocol.CODEX_TESTED_LABEL);
  });

  it('maps Codex models to engine rows with their own efforts', () => {
    expect(protocol.codexModelRow({ id: 'gpt-5.5-codex', model: 'gpt-5.5-codex', displayName: 'GPT-5.5 Codex', hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'xhigh', description: '' }] }))
      .toEqual({ id: 'gpt-5.5-codex', ownedBy: 'openai', modality: 'chat', favorite: false, recent: false, availability: null, label: 'GPT-5.5 Codex',
        efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium', isDefault: true });
    expect(protocol.codexModelRow({ id: 'x', model: 'x', hidden: true })).toBeNull();
    expect(protocol.codexEffort('high', { efforts: ['low', 'medium'] })).toBeNull();
    expect(protocol.codexEffort('medium', { efforts: ['low', 'medium'] })).toBe('medium');
  });
});

describe('JSON-RPC peer', () => {
  /** Our client and a Codex-like server on the two ends of an in-memory byte pipe. */
  async function pair(maxMessageBytes?: number) {
    const [near, far] = duplexPair();
    const accepted = acceptWebSocket(far, maxMessageBytes ? { maxPayload: 1 << 20 } : {});
    const socket = await connectWebSocket(near, near, maxMessageBytes ? { maxMessageBytes } : {});
    return { socket, server: await accepted, far };
  }

  it('speaks one JSON message per WebSocket frame, answers requests, and closes on an oversized frame', async () => {
    const { socket, server } = await pair(64);
    const frames: unknown[] = [];
    server.on('message', data => frames.push(JSON.parse(String(data))));
    const notes: string[] = [];
    let closed: Error | null = null;
    const peer = new JsonRpcPeer({ socket, onNotification: method => notes.push(method), onClose: reason => { closed = reason; } });
    const answer = peer.request('model/list', {});
    await until(() => frames.length === 1, 'request frame');
    expect(frames).toEqual([{ id: 1, method: 'model/list', params: {} }]);
    server.send('{"method":"a"}');
    server.send('not json');
    server.send(Buffer.from('{"method":"binary"}'), { binary: true });
    server.send('{"id":1,"result":{"ok":true}}');
    await expect(answer).resolves.toEqual({ ok: true });
    expect(notes).toEqual(['a']);
    const pending = peer.request('x');
    server.send(JSON.stringify({ method: 'big', params: 'x'.repeat(80) }));
    await expect(pending).rejects.toThrow('too large');
    expect(closed).not.toBeNull();
  });

  it('times a request out and closes when the other side does', async () => {
    const { socket, far } = await pair();
    let closed: Error | null = null;
    const peer = new JsonRpcPeer({ socket, onClose: reason => { closed = reason; } });
    await expect(peer.request('slow', undefined, { timeoutMs: 20 })).rejects.toThrow('slow timed out');
    const pending = peer.request('never');
    far.end(); // the proxy's stdout ended (it exited)
    await expect(pending).rejects.toThrow('The connection closed');
    expect(closed).not.toBeNull();
  });

  it('gives up on a server that never answers the upgrade', async () => {
    const [near] = duplexPair();
    await expect(connectWebSocket(near, near, { timeoutMs: 50 })).rejects.toThrow('handshake timed out');
  });
});

describe('Codex engine (fake app-server)', () => {
  it('is available when installed, supported and signed in; otherwise it says why', async () => {
    expect(await start().engine.status()).toEqual({ available: true, detail: 'Codex 0.163.0 · chatgpt', router: false });
    engine!.shutdown();
    expect(await start({ script: { account: { account: null, requiresOpenaiAuth: true } } }).engine.status()).toEqual({ available: false, detail: CODEX_NOT_SIGNED_IN, router: false });
    engine!.shutdown();
    const old = start({ version: '0.150.0' });
    expect(await old.engine.status()).toEqual({ available: false, detail: 'Codex 0.150.0 is not supported; Chat Marks supports Codex 0.163.0', router: false });
    expect(old.fake.opened).toEqual([]);
    engine!.shutdown();
    expect(await start({ unavailable: 'Codex is not installed' }).engine.status()).toEqual({ available: false, detail: 'Codex is not installed', router: false });
    expect(recoversOwnTurns('codex')).toBe(true);
  });

  it('starts the thread with the safe policies and runs a whole turn: text, command, patch and MCP rows', async () => {
    const steps = fixCwd([
      delta('I will run '), delta('the tests.'), item('completed', message('I will run the tests.')),
      item('started', commandItem('inProgress')),
      { notify: 'item/commandExecution/outputDelta', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'item-cmd-1', delta: '1 failing\n' } },
      item('completed', commandItem('failed', { exitCode: 1, aggregatedOutput: '> test\n1 failing\n' })),
      item('started', patchItem('inProgress')), item('completed', patchItem('completed')),
      item('started', mcpItem('inProgress')), item('completed', mcpItem('completed')),
      delta('Fixed.', 'item-msg-2'), item('completed', message('Fixed.', 'item-msg-2')),
      { notify: 'thread/tokenUsage/updated', params: { threadId: '$THREAD', turnId: '$TURN', tokenUsage: {
        total: { totalTokens: 0, inputTokens: 1500, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 90, reasoningOutputTokens: 40 },
        last: { totalTokens: 0, inputTokens: 1200, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 80, reasoningOutputTokens: 40 }, modelContextWindow: null } } },
      completed()
    ]);
    const { fake, engine } = start({ script: { turns: [steps], models: [{ id: 'gpt-5.5-codex', model: 'gpt-5.5-codex', displayName: 'GPT-5.5 Codex', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], defaultReasoningEffort: 'medium' }] } });
    const chat = await engine.create({ projectId: null });
    expect(chat).toMatchObject({ engine: 'codex', model: 'gpt-5.5-codex', approval: 'ask', running: false });
    expect((await ledger.storedChatRecord(chat.sessionId))).toMatchObject({ engine: 'codex', backendSessionId: 'thread-1' });
    await engine.setChatSettings(chat.sessionId, { effort: 'medium' });
    await engine.send(chat.sessionId, 'Fix the failing test');
    await until(async () => (await transcript(chat.sessionId)).some(row => row.startsWith('turn_end')), 'turn end');

    const [initialize] = fake.requests('initialize');
    conforms('InitializeParams', initialize!.params);
    expect(initialize!.params).toEqual({ clientInfo: { name: 'chat_marks', title: 'Chat Marks', version: '2.1.42' }, capabilities: { experimentalApi: false, requestAttestation: false } });
    expect(fake.messages().some(message => message.method === 'initialized' && message.id === undefined)).toBe(true);
    const [threadStart] = fake.requests('thread/start');
    conforms('ThreadStartParams', threadStart!.params);
    expect(threadStart!.params).toEqual({ model: 'gpt-5.5-codex', cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: false });
    const [turnStart] = fake.requests('turn/start');
    conforms('TurnStartParams', turnStart!.params);
    expect(turnStart!.params).toEqual({
      threadId: 'thread-1', input: [{ type: 'text', text: 'Fix the failing test', text_elements: [] }], model: 'gpt-5.5-codex', effort: 'medium', cwd,
      approvalPolicy: 'untrusted', approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    });
    for (const method of ['account/read', 'model/list']) for (const request of fake.requests(method)) conforms(method === 'model/list' ? 'ModelListParams' : 'GetAccountParams', request.params);
    // The fake records its argv: the server was started with the pinned overrides only.
    const argv = fake.messages()[0]?.argv;
    expect(argv).toEqual(protocol.codexServerArgv(SOCKET));

    expect(await transcript(chat.sessionId)).toEqual([
      'user Fix the failing test',
      'turn_start',
      'assistant I will run the tests.',
      'tool exec_command process_exit_nonzero Ran npm test [✕ exit 1]',
      'tool apply_patch ok Edited sum.ts [+2 −1]',
      'tool mcp:docs/search ok Called docs/search',
      'assistant Fixed.',
      'turn_end completed'
    ]);
    const tools = (await store.readEvents(chat.sessionId)).filter(event => event.kind === 'tool_call');
    expect(tools[0]).toMatchObject({ call: { engine: 'codex', attribution: 'engine', requestId: null, result: { text: '> test\n1 failing\n' } } });
    expect(tools[1]).toMatchObject({ call: { changes: [{ path: 'src/sum.ts', added: 2, removed: 1 }] } });
    expect((await ledger.storedChatRecord(chat.sessionId))?.openTurn).toBeUndefined();
    expect((await engine.view(chat.sessionId)).running).toBe(false);
    expect(engine.terminal!({ sessionId: chat.sessionId, conversationId: chat.conversationId, backendSessionId: 'thread-1', cwd: null }))
      .toEqual({ argv: ['resume', 'thread-1', '--remote', `unix://${SOCKET}`], mode: 'live' });
    // The unified seam: a live attach opens the chat's module terminal on the same server and thread.
    expect(await engine.openTerminal!(chat.sessionId)).toEqual({ cliSessionId: 'cli-codex-1' });
    expect(fake.terminals).toEqual([{ sessionId: chat.sessionId, projectId: null, args: ['resume', 'thread-1', '--remote', `unix://${SOCKET}`], title: 'Codex · Fix the failing test' }]);
    expect(fake.terminalHook()).not.toBeNull();
  });

  it('asks Codex for on-request approvals in Auto mode', async () => {
    const { fake, engine } = start({ script: { turns: [[completed()]] } });
    const chat = await engine.create({ projectId: null, model: 'gpt-5.5-codex' });
    await engine.setChatSettings(chat.sessionId, { approval: 'auto' });
    await engine.send(chat.sessionId, 'hi');
    await until(() => fake.requests('turn/start').length > 0 && fake.requests('turn/start')[0]);
    expect(fake.requests('turn/start')[0]!.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } });
    expect(fake.requests('turn/start')[0]!.params).not.toHaveProperty('effort');
  });

  it('answers command and file approvals with the exact decisions, refuses stale ids, and declines legacy requests', async () => {
    const steps = fixCwd([
      { request: 'execCommandApproval', id: 'legacy-1', params: { conversationId: '$THREAD', callId: 'c', approvalId: null, command: ['rm', '-rf', '/'], cwd: '/', reason: null, parsedCmd: [] } },
      { request: 'applyPatchApproval', id: 'legacy-2', params: { conversationId: '$THREAD', callId: 'c', fileChanges: {}, reason: null, grantRoot: null } },
      { request: 'item/tool/requestUserInput', id: 'input-1', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'x', questions: [] } },
      item('started', commandItem('inProgress')), commandApproval(11), { waitForResponse: 11 },
      item('completed', commandItem('completed', { exitCode: 0, aggregatedOutput: 'ok\n' })),
      item('started', patchItem('inProgress')), patchApproval(12), { waitForResponse: 12 },
      item('completed', patchItem('completed')),
      item('started', { ...commandItem('inProgress'), id: 'item-cmd-2', command: 'curl example.com' }),
      { ...commandApproval(13), params: { ...commandApproval(13).params, itemId: 'item-cmd-2', command: 'curl example.com' } }, { waitForResponse: 13 },
      item('completed', { ...commandItem('declined'), id: 'item-cmd-2', command: 'curl example.com' }),
      completed()
    ]);
    const { fake, engine } = start({ script: { turns: [steps] } });
    const chat = await engine.create({ projectId: null, model: 'gpt-5.5-codex' });
    await engine.send(chat.sessionId, 'go');

    const first = await until(async () => (await engine.view(chat.sessionId)).pending, 'command card');
    expect(first).toMatchObject({ tool: 'exec_command', toolCallId: 'item-cmd-1', summary: 'npm test\nin /work/app\nRuns the test suite' });
    await engine.approve(chat.sessionId, first.approvalId, 'approve');
    await expect(engine.approve(chat.sessionId, first.approvalId, 'approve')).rejects.toThrow('This approval is no longer pending');
    const second = await until(async () => { const pending = (await engine.view(chat.sessionId)).pending; return pending?.approvalId !== first.approvalId && pending; }, 'patch card');
    expect(second).toMatchObject({ tool: 'apply_patch', toolCallId: 'item-patch-1', summary: 'Edit 1 file', files: ['update src/sum.ts'] });
    expect((await engine.approve(chat.sessionId, second.approvalId, 'always')).approval).toBe('auto');
    const third = await until(async () => { const pending = (await engine.view(chat.sessionId)).pending; return pending && pending.toolCallId === 'item-cmd-2' && pending; }, 'third card');
    await engine.approve(chat.sessionId, third.approvalId, 'deny');
    await until(async () => (await transcript(chat.sessionId)).some(row => row.startsWith('turn_end')), 'turn end');

    const replies = (id: number | string) => fake.messages().filter(message => message.id === id && !message.method);
    expect(replies(11)).toEqual([{ id: 11, result: { decision: 'accept' } }]);
    expect(replies(12)).toEqual([{ id: 12, result: { decision: 'acceptForSession' } }]);
    expect(replies(13)).toEqual([{ id: 13, result: { decision: 'decline' } }]);
    conforms('CommandExecutionRequestApprovalResponse', replies(11)[0]!.result);
    conforms('FileChangeRequestApprovalResponse', replies(12)[0]!.result);
    conforms('CommandExecutionRequestApprovalResponse', replies(13)[0]!.result);
    conforms('CommandExecutionRequestApprovalParams', JSON.parse(JSON.stringify(commandApproval(11).params).replaceAll('$THREAD', 'thread-1').replaceAll('$TURN', 'turn-1')));
    conforms('FileChangeRequestApprovalParams', JSON.parse(JSON.stringify(patchApproval(12).params).replaceAll('$THREAD', 'thread-1').replaceAll('$TURN', 'turn-1')));
    expect(replies('legacy-1')).toEqual([{ id: 'legacy-1', result: protocol.CODEX_LEGACY_DENIAL }]);
    expect(replies('legacy-2')).toEqual([{ id: 'legacy-2', result: protocol.CODEX_LEGACY_DENIAL }]);
    conforms('ExecCommandApprovalResponse', replies('legacy-1')[0]!.result);
    conforms('ApplyPatchApprovalResponse', replies('legacy-2')[0]!.result);
    expect(replies('input-1')).toEqual([{ id: 'input-1', error: { code: -32601, message: 'Chat Marks does not handle item/tool/requestUserInput' } }]);
    const rows = await transcript(chat.sessionId);
    expect(rows[2]).toMatch(/^tool exec_command ok Ran npm test \[✓ /);
    expect([...rows.slice(0, 2), ...rows.slice(3)]).toEqual([
      'user go', 'turn_start',
      'tool apply_patch ok Edited sum.ts [+2 −1]',
      'tool exec_command tool_rejected Declined: Ran curl example.com [declined]',
      'turn_end completed'
    ]);
  });

  it('clears the card when the TUI answers it (serverRequest/resolved) and sends nothing for it', async () => {
    const steps = fixCwd([
      item('started', commandItem('inProgress')), commandApproval(21), { waitMs: 400 },
      { notify: 'serverRequest/resolved', params: { threadId: '$THREAD', requestId: 21 } }, { waitMs: 200 },
      item('completed', commandItem('completed', { exitCode: 0, aggregatedOutput: '' })), completed()
    ]);
    const { fake, engine } = start({ script: { turns: [steps] } });
    const chat = await engine.create({ projectId: null, model: 'gpt-5.5-codex' });
    await engine.send(chat.sessionId, 'go');
    const card = await until(async () => (await engine.view(chat.sessionId)).pending, 'card');
    conforms('ServerRequestResolvedNotification', { threadId: 'thread-1', requestId: 21 });
    await until(async () => !(await engine.view(chat.sessionId)).pending, 'card cleared');
    await expect(engine.approve(chat.sessionId, card.approvalId, 'approve')).rejects.toThrow('This approval is no longer pending');
    await until(async () => (await transcript(chat.sessionId)).some(row => row.startsWith('turn_end')), 'turn end');
    expect(fake.messages().filter(message => message.id === 21 && !message.method)).toEqual([]);
  });

  it('Stop interrupts the Codex turn and cancels its pending approval', async () => {
    const steps = fixCwd([item('started', commandItem('inProgress')), commandApproval(31), { waitForResponse: 31 }]);
    const { fake, engine } = start({ script: { turns: [steps] } });
    const chat = await engine.create({ projectId: null, model: 'gpt-5.5-codex' });
    await engine.send(chat.sessionId, 'go');
    await until(async () => (await engine.view(chat.sessionId)).pending, 'card');
    // Live: the terminal may open while the turn runs (no hand-over).
    expect(await engine.openTerminal!(chat.sessionId)).toEqual({ cliSessionId: 'cli-codex-1' });
    const done = engine.turnDone(chat.sessionId)!;
    expect(await engine.stop(chat.sessionId)).toBe(true);
    expect(await done).toBe('stopped');
    expect(fake.messages().filter(message => message.id === 31 && !message.method)).toEqual([{ id: 31, result: { decision: 'cancel' } }]);
    const [interrupt] = fake.requests('turn/interrupt');
    expect(interrupt!.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    conforms('TurnInterruptParams', interrupt!.params);
    expect((await transcript(chat.sessionId)).slice(-2)).toEqual(['tool exec_command tool_execution_error Ran npm test [did not finish]', 'turn_end stopped']);
    expect(await engine.stop(chat.sessionId)).toBe(false);
  });

  it('keeps a retried error recoverable and fails the turn on a final one', async () => {
    const error = (message: string, willRetry: boolean) => ({ notify: 'error', params: { error: { message, codexErrorInfo: null, additionalDetails: null }, willRetry, threadId: '$THREAD', turnId: '$TURN' } });
    const { engine } = start({ script: { turns: [[error('stream disconnected', true), error('usage limit reached', false), completed('failed', { message: 'usage limit reached', codexErrorInfo: null, additionalDetails: null })]] } });
    conforms('ErrorNotification', { error: { message: 'x', codexErrorInfo: null, additionalDetails: null }, willRetry: true, threadId: 't', turnId: 'u' });
    const chat = await engine.create({ projectId: null, model: 'gpt-5.5-codex' });
    await engine.send(chat.sessionId, 'go');
    expect(await engine.turnDone(chat.sessionId)).toBe('failed');
    expect(await transcript(chat.sessionId)).toEqual([
      'user go', 'turn_start', 'error recoverable Codex is retrying: stream disconnected', 'error fatal usage limit reached', 'turn_end failed (usage limit reached)'
    ]);
  });

  it('recovers a turn left open by resuming its thread (and interrupting it) before closing it interrupted', async () => {
    const first = start();
    const chat = await first.engine.create({ projectId: null, model: 'gpt-5.5-codex' });
    first.engine.shutdown();
    // What a crash leaves: the ledger's open turn and its turn_start, no turn_end.
    await ledger.updateChatRecord(chat.sessionId, record => ({ ...record!, openTurn: { turnId: 'api-crashed', startedAt: 1 } }));
    await store.appendEvent(chat.sessionId, { time: 1, source: 'app', kind: 'turn_start', turnId: 'api-crashed' });
    await executor.recoverApiChats();
    expect((await ledger.storedChatRecord(chat.sessionId))?.openTurn).toBeDefined();

    const { fake, engine } = start({ script: { resumeTurns: [{ id: 'turn-9', rootTurnId: null, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null }] } });
    await engine.recover();
    const [resume] = fake.requests('thread/resume');
    conforms('ThreadResumeParams', resume!.params);
    expect(resume!.params).toEqual({ threadId: 'thread-1', cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write' });
    expect(fake.requests('turn/interrupt')[0]!.params).toEqual({ threadId: 'thread-1', turnId: 'turn-9' });
    expect(await transcript(chat.sessionId)).toEqual(['turn_start', 'turn_end interrupted (Chat Marks closed before Codex finished this turn; the Codex thread was resumed and keeps its history)']);
    expect((await ledger.storedChatRecord(chat.sessionId))?.openTurn).toBeUndefined();
  });

  it('resumes the thread before the first turn after a restart', async () => {
    const first = start();
    const chat = await first.engine.create({ projectId: null, model: 'gpt-5.5-codex' });
    first.engine.shutdown();
    const { fake, engine } = start({ script: { turns: [[completed()]] } });
    await engine.send(chat.sessionId, 'again');
    expect(await engine.turnDone(chat.sessionId)).toBe('completed');
    expect(fake.messages().filter(message => message.method === 'thread/resume' || message.method === 'turn/start').map(message => message.method)).toEqual(['thread/resume', 'turn/start']);
  });
});

describe('Codex engine: routes (one app-server per route)', () => {
  const codexModel = (id: string, displayName: string, isDefault = false) => ({ id, model: id, displayName, hidden: false, isDefault, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium' });
  // As codex-cli 0.163 lists them on the user's machine: the account's catalog direct, the router's one model otherwise.
  const routed = (extra: Record<string, unknown> = {}) => ({
    router: true,
    script: {
      routes: {
        direct: { models: [codexModel('gpt-6.1-sol', 'GPT-6.1-Sol', true), codexModel('gpt-6-luna', 'GPT-6-Luna')] },
        router: { account: { account: null, requiresOpenaiAuth: false }, models: [codexModel('Local/router-model', 'Local/router-model', true)] }
      },
      ...extra
    }
  });

  it('starts the direct server with the overrides that neutralize the router, and the router server as configured', () => {
    expect(protocol.codexServerArgv(SOCKET, ['model_provider="openai"', 'model_catalog_json="/home/user/.codex/models_cache.json"'])).toEqual([
      'app-server', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"', '-c', 'approvals_reviewer="user"',
      '-c', 'model_provider="openai"', '-c', 'model_catalog_json="/home/user/.codex/models_cache.json"', '--listen', `unix://${SOCKET}`
    ]);
    expect(() => protocol.codexServerArgv(SOCKET, ['approval_policy="never"'])).toThrow('Invalid Codex route override');
    expect(() => protocol.codexServerArgv(SOCKET, ['model_provider="evil"'])).toThrow();
  });

  it('reports the direct account and the detected router, and lists each route\'s own models', async () => {
    const { fake, engine } = start(routed());
    expect(await engine.status()).toEqual({ available: true, router: true, detail: 'Codex 0.163.0 · direct: chatgpt · Claude Code Router detected' });
    // Status asks the direct server only.
    expect(fake.opened.map(argv => argv.at(-1))).toEqual([`unix://${SOCKET}`]);
    expect(fake.opened[0]).toContain('model_provider="openai"');
    expect((await engine.models({ route: 'direct' })).models.map(model => [model.id, model.label])).toEqual([['gpt-6.1-sol', 'GPT-6.1-Sol'], ['gpt-6-luna', 'GPT-6-Luna']]);
    expect((await engine.models({ route: 'router' })).models.map(model => model.id)).toEqual(['Local/router-model']);
    expect(fake.opened.map(argv => argv.at(-1))).toEqual([`unix://${SOCKET}`, `unix://${ROUTER_SOCKET}`]);
    expect(fake.opened[1]).not.toContain('model_provider="openai"');
  });

  it('stays available through the router when the direct route has no account', async () => {
    const { engine } = start({ router: true, script: { account: { account: null, requiresOpenaiAuth: true } } });
    expect(await engine.status()).toEqual({ available: true, router: true, detail: 'Codex 0.163.0 · direct: not signed in · Claude Code Router detected' });
  });

  it('creates direct chats on the direct server; a route change starts a new thread on the other server with its default model', async () => {
    const { fake, engine } = start(routed({ turns: [[completed()]], routes: {
      direct: { models: [codexModel('gpt-6.1-sol', 'GPT-6.1-Sol', true)] },
      router: { account: { account: null, requiresOpenaiAuth: false }, models: [codexModel('Local/router-model', 'Local/router-model', true)], turns: [[completed()]] }
    } }));
    const chat = await engine.create({ projectId: null });
    expect(chat).toMatchObject({ route: 'direct', routes: ['direct', 'router'], model: 'gpt-6.1-sol' });
    expect(await ledger.storedChatRecord(chat.sessionId)).toMatchObject({ route: 'direct', backendSessionId: 'thread-1' });
    await engine.send(chat.sessionId, 'hi');
    await engine.turnDone(chat.sessionId);
    expect(fake.requests('turn/start').map(message => message.params?.threadId)).toEqual(['thread-1']);

    // To the router: Codex threads keep their provider, so the chat forgets its thread and takes the router's model.
    expect(await engine.setChatSettings(chat.sessionId, { route: 'router' })).toMatchObject({ route: 'router', model: 'Local/router-model' });
    expect((await ledger.storedChatRecord(chat.sessionId))?.backendSessionId).toBeUndefined();
    await engine.send(chat.sessionId, 'again');
    await engine.turnDone(chat.sessionId);
    expect(fake.requests('thread/resume', 'router')).toEqual([]);
    expect(fake.requests('turn/start', 'router').map(message => [message.params?.threadId, message.params?.model])).toEqual([['router-thread-1', 'Local/router-model']]);
    expect(fake.requests('turn/start')).toHaveLength(1);
    expect((await ledger.storedChatRecord(chat.sessionId))?.backendSessionId).toBe('router-thread-1');
    // The live terminal attaches to the server of the chat's route.
    expect(await engine.openTerminal!(chat.sessionId)).toEqual({ cliSessionId: 'cli-codex-1' });
    expect(fake.terminals.at(-1)?.args).toEqual(['resume', 'router-thread-1', '--remote', `unix://${ROUTER_SOCKET}`]);
    await fake.terminalHook()!(chat.sessionId);
  });

  it('refuses a route change while a turn runs', async () => {
    const { engine } = start(routed({ turns: [[{ waitMs: 2_000 }, completed()]] }));
    const chat = await engine.create({ projectId: null });
    await engine.send(chat.sessionId, 'hi');
    await expect(engine.setChatSettings(chat.sessionId, { route: 'router' })).rejects.toThrow('Wait for the answer to finish before changing the route.');
    await engine.stop(chat.sessionId);
  });

  it('keeps one server and the thread without a detected router', async () => {
    const { fake, engine } = start({ script: { models: [codexModel('gpt-6.1-sol', 'GPT-6.1-Sol', true)] } });
    const chat = await engine.create({ projectId: null });
    expect(chat).toMatchObject({ route: 'direct', routes: [] });
    await engine.setChatSettings(chat.sessionId, { route: 'router' });
    expect((await ledger.storedChatRecord(chat.sessionId))?.backendSessionId).toBe('thread-1');
    await engine.models({ route: 'router' });
    expect(fake.opened.map(argv => argv.at(-1))).toEqual([`unix://${SOCKET}`]);
    expect(fake.opened[0]).not.toContain('model_provider="openai"');
  });
});
