import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
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
const engine = await import('../src/main/agent-engine/opencode.js');
const { SseParser, basicAuth } = await import('../src/main/agent-engine/opencode-client.js');
const service = await import('../src/main/opencode/service.js');
const { TurnProjector, storeProjectorSink } = await import('../src/main/agent-engine/projector.js');
const { ApprovalGate } = await import('../src/main/agent-engine/approval.js');
const registry = await import('../src/main/agent-engine/registry.js');
const { getLog } = await import('../src/main/logger.js');
import type { SessionEvent } from '../src/shared/session.js';
import type { OpenCodeServiceAction } from '../src/shared/upstream-module.js';

const PASSWORD = 'pw-secret-do-not-log-7c1e';
const PROJECT = '00000000-0000-4000-8000-0000000000ab';
const BINARY = '/home/u/.config/chat-marks/modules/opencode/bin/opencode';
const PID = 4242;

interface Recorded { method: string; path: string; query: URLSearchParams; body: any; auth: string | undefined }
interface Permission { id: string; sessionID: string; action: string; resources: string[]; save?: string[]; metadata?: Record<string, unknown>; source?: { type: 'tool'; messageID: string; id: string } }
type ServiceState = { registration: string | null; exe: string | null; binaryVersion: string; actions: Array<{ action: OpenCodeServiceAction; env: Record<string, string | undefined> }> };

/** An OpenCode 2.1.2 background service in miniature: the `/api` routes and `/api/event` shapes the engine uses, as the real one sends them. */
class FakeOpenCode {
  server!: http.Server;
  url = '';
  version = '2.1.2';
  requests: Recorded[] = [];
  streams = new Set<http.ServerResponse>();
  active = new Set<string>();
  pending = new Map<string, Permission[]>();
  messages = new Map<string, any[]>();
  sessions = new Map<string, { id: string; outcome?: string; time: { created: number; updated: number; idle?: number }; permissions: any[] }>();
  onPrompt: (sessionId: string, text: string) => void = () => undefined;
  next = 0;

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.drop();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  registration(password = PASSWORD): string { return JSON.stringify({ id: 'svc', version: this.version, url: this.url, pid: PID, password }); }

  emit(type: string, data: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({ id: `evt_${++this.next}`, created: Date.now(), type, data })}\n\n`;
    for (const stream of this.streams) stream.write(frame);
  }

  drop(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  calls(method: string, path: string): Recorded[] { return this.requests.filter(item => item.method === method && item.path === path); }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.url);
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    this.requests.push({ method: request.method!, path: url.pathname, query: url.searchParams, body, auth: request.headers.authorization });
    const json = (status: number, value?: unknown): void => {
      response.writeHead(status, value === undefined ? {} : { 'content-type': 'application/json' });
      response.end(value === undefined ? '' : JSON.stringify(value));
    };
    if (request.headers.authorization !== basicAuth(PASSWORD)) { json(401, { _tag: 'UnauthorizedError', message: 'Unauthorized' }); return; }
    const parts = url.pathname.split('/').filter(Boolean);
    const [, , sessionId, sub, requestId, reply] = parts;
    if (url.pathname === '/api/info') return json(200, { version: this.version, pid: PID, urls: [this.url], paths: { tmp: '/tmp/opencode' } });
    if (url.pathname === '/api/model') return json(200, { location: { directory: url.searchParams.get('location[directory]') ?? '/home/u' }, data: [
      { id: 'minimax-m3.1-flash-free', modelID: 'minimax-m3.1-flash-free', providerID: 'opencode', name: 'MiniMax M3.1 Flash Free', enabled: true,
        variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
      { id: 'big-pickle', modelID: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', enabled: true, variants: [] },
      { id: 'old', modelID: 'old', providerID: 'openai', name: 'Old', enabled: false, variants: [] }
    ] });
    if (url.pathname === '/api/model/default') return json(200, { location: {}, data: { id: 'big-pickle', providerID: 'opencode', name: 'Big Pickle' } });
    if (url.pathname === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'evt_c', type: 'server.connected', data: {} })}\n\n`);
      response.write(': heartbeat\n\n');
      this.streams.add(response);
      response.on('close', () => this.streams.delete(response));
      return;
    }
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const id = `ses_000${this.sessions.size + 1}AbC`;
      this.sessions.set(id, { id, time: { created: Date.now(), updated: Date.now() }, permissions: body.permissions });
      this.messages.set(id, []);
      return json(200, { data: { id, projectID: 'p1', model: body.model, permissions: body.permissions, time: { created: Date.now(), updated: Date.now() } } });
    }
    if (url.pathname === '/api/session/active') return json(200, { data: Object.fromEntries([...this.active].map(id => [id, { type: 'running' }])) });
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return json(404, { _tag: 'SessionNotFoundError', sessionID: sessionId, message: `Session not found: ${sessionId}` });
    if (!sub && request.method === 'GET') return json(200, { data: session });
    // PATCH replaces the ruleset (real 2.1.2).
    if (!sub && request.method === 'PATCH') { if (body.permissions) session.permissions = body.permissions; return json(204); }
    if (sub === 'model') return json(204);
    if (sub === 'message') {
      const list = [...(this.messages.get(session.id) ?? [])];
      return json(200, { data: url.searchParams.get('order') === 'desc' ? list.reverse() : list });
    }
    if (sub === 'prompt') {
      const id = `msg_u${++this.next}`;
      this.messages.get(session.id)!.push({ id, type: 'user', text: body.text, time: { created: Date.now() } });
      this.active.add(session.id);
      json(200, { data: { id, sessionID: session.id, type: 'user', payload: { text: body.text }, delivery: 'steer', time: { created: Date.now() } } });
      setTimeout(() => this.onPrompt(session.id, body.text), 5);
      return;
    }
    if (sub === 'interrupt') {
      const was = this.active.delete(session.id);
      // The interrupt settles the run's pending requests itself (real 2.1.2: the list is empty afterwards).
      this.pending.set(session.id, []);
      json(200, { interrupted: was });
      if (was) setTimeout(() => this.finish(session.id, 'interrupted', { reason: 'user' }), 5);
      return;
    }
    if (sub === 'permission') {
      const list = this.pending.get(session.id) ?? [];
      if (!requestId) return json(200, { data: list });
      const found = list.find(item => item.id === requestId);
      if (!found) return json(404, { _tag: 'PermissionNotFoundError', message: 'Permission not found' });
      if (!reply) return json(200, { data: found });
      this.pending.set(session.id, list.filter(item => item !== found));
      json(204);
      this.emit('permission.replied', { sessionID: session.id, requestID: requestId, reply: body.decision });
      return;
    }
    json(404, { _tag: 'NotFound', message: 'Not found' });
  }

  ask(permission: Permission): void {
    this.pending.set(permission.sessionID, [...(this.pending.get(permission.sessionID) ?? []), permission]);
    this.emit('permission.asked', { ...permission });
  }

  finish(sessionId: string, outcome: 'succeeded' | 'failed' | 'interrupted', data: Record<string, unknown> = {}): void {
    this.active.delete(sessionId);
    const session = this.sessions.get(sessionId)!;
    session.outcome = outcome;
    session.time.idle = Date.now();
    this.emit(`session.execution.${outcome}`, { sessionID: sessionId, ...data });
  }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

const outline = (events: SessionEvent[]): string[] => events.flatMap(event => {
  switch (event.kind) {
    case 'user_message': return [`user ${event.message.text}`];
    case 'assistant_message': return [`assistant ${event.state} ${event.message.text}`];
    case 'tool_call': return [`tool ${event.call.tool} ${event.call.outcome} ${event.call.summary.title}${event.call.summary.metric && !event.call.summary.metric.startsWith('✓') ? ` [${event.call.summary.metric}]` : ''}`];
    case 'chat_error': return [`error ${event.message.text}`];
    case 'turn_start': return ['turn_start'];
    case 'turn_end': return [`turn_end ${event.outcome}`];
    default: return [];
  }
});

/** The service host: the fake service's registration, `service <action>` recorded, the process's executable. */
function serviceHost(fake: FakeOpenCode, state: ServiceState): void {
  service.setOpenCodeServiceHostForTests({
    runtime: async () => ({ binary: BINARY, version: state.binaryVersion, windows: false }),
    registration: async () => state.registration,
    service: async (_runtime, action, env) => {
      state.actions.push({ action, env: { ...env } });
      if (action === 'stop') state.registration = null;
      else { fake.version = state.binaryVersion; state.registration = fake.registration(); state.exe = BINARY; }
    },
    executable: async () => state.exe,
    fetch: (...args) => fetch(...args),
    sleep: async () => undefined
  });
}

describe('OpenCode 2.x agent engine (fake HTTP+SSE service)', () => {
  let directory = '';
  const fake = new FakeOpenCode();
  const state: ServiceState = { registration: null, exe: BINARY, binaryVersion: '2.1.2', actions: [] };
  let module = { enabled: true, command: true, binary: BINARY as string | null, managed: true };
  let version: string | null = '2.1.2';
  const openTerminal = vi.fn(async (_chat: { sessionId: string; projectId: string; args: string[]; title: string }) => ({ id: 'cli-opencode-1' }));
  let terminalCheck: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    directory = await makeTempDir('cos-opencode-');
    initConfigPath(directory);
    initDurableStore(directory);
    store.initSessionStore(directory);
    await saveConfig(defaultConfig());
    await fake.start();
  });
  beforeEach(async () => {
    executor.resetApiChatExecutorForTests();
    engine.resetOpenCodeEngineForTests();
    service.resetOpenCodeServiceForTests();
    resetRecorderForTests();
    store.resetSessionStoreForTests();
    await writeDurableNow(ledger.API_CHAT_SESSIONS_STATE, {});
    fake.requests.length = 0;
    fake.active.clear();
    fake.pending.clear();
    fake.sessions.clear();
    fake.messages.clear();
    fake.version = '2.1.2';
    fake.onPrompt = () => undefined;
    Object.assign(state, { registration: fake.registration(), exe: BINARY, binaryVersion: '2.1.2', actions: [] });
    serviceHost(fake, state);
    module = { enabled: true, command: true, binary: BINARY, managed: true };
    version = '2.1.2';
    openTerminal.mockClear();
    terminalCheck = null;
    engine.setOpenCodeDepsForTests({
      openTerminal,
      onTerminalOpen: check => { terminalCheck = check; },
      moduleState: async () => ({ ...module }),
      version: async () => version,
      projectFolder: async projectId => {
        if (projectId !== PROJECT) throw new Error('Project not found');
        return directory;
      },
      reconnectDelaysMs: [20, 40, 80],
      stopGraceMs: 300
    });
  });
  afterEach(() => { engine.resetOpenCodeEngineForTests(); fake.drop(); });
  afterAll(async () => {
    engine.setOpenCodeDepsForTests(null);
    engine.resetOpenCodeEngineForTests();
    service.setOpenCodeServiceHostForTests(null);
    await fake.stop();
    await flushDurable();
    resetRecorderForTests();
    store.resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(directory);
  });

  const create = () => engine.openCodeEngine.create({ projectId: PROJECT });
  const events = (sessionId: string) => store.readEvents(sessionId);

  it('reports why it is unavailable: module, binary, the 2.x version gate and a service run by another OpenCode', async () => {
    module.binary = null;
    expect(await engine.openCodeStatus()).toEqual({ available: false, detail: 'Install OpenCode in Settings > Modules' });
    module = { enabled: false, command: true, binary: BINARY, managed: true };
    expect((await engine.openCodeStatus()).detail).toBe('Enable the OpenCode module in Settings > Modules');
    module.enabled = true;
    for (const old of ['1.19.3', '2.0.25', '3.0.0']) {
      version = old;
      expect(await engine.openCodeStatus()).toEqual({ available: false, detail: `OpenCode ${old} is not supported by this version of Chat Marks (OpenCode 2.1 or a newer 2.x is needed; install it in Settings > Modules)` });
    }
    version = '2.2.0';
    expect(await engine.openCodeStatus()).toEqual({ available: true, detail: 'OpenCode 2.2.0 (newer than tested)' });
    version = '2.1.2';
    expect(await engine.openCodeStatus()).toEqual({ available: true, detail: 'OpenCode 2.1.2' });
    // A stopped service is fine: it starts on first use. Status never starts it.
    state.registration = null;
    expect(await engine.openCodeStatus()).toEqual({ available: true, detail: 'OpenCode 2.1.2 (the background service starts on first use)' });
    module.managed = false;
    expect((await engine.openCodeStatus()).detail).toBe('OpenCode 2.1.2 (not installed by Chat Marks, the background service starts on first use)');
    expect(state.actions).toEqual([]);
    // Another OpenCode program runs the service: refused, never talked to for chats.
    state.registration = fake.registration();
    state.exe = '/usr/local/bin/opencode';
    expect(await engine.openCodeStatus()).toEqual({ available: false, detail: service.OPENCODE_SERVICE_FOREIGN });
    await expect(engine.openCodeEngine.models({})).rejects.toThrow(service.OPENCODE_SERVICE_FOREIGN);
    expect(fake.requests.filter(item => item.path !== '/api/info')).toEqual([]);
    expect((await registry.listAgentEngines()).find(item => item.id === 'opencode')).toMatchObject({ available: false, terminal: 'live' });
  });

  it('starts the service on first use with the resolved binary, an environment without Electron node mode, server auth or MarksCode, and self-update off', async () => {
    state.registration = null;
    const saved = { ...process.env };
    Object.assign(process.env, {
      ELECTRON_RUN_AS_NODE: '1', OPENCODE_SERVER_PASSWORD: 'inherited', OPENCODE_PASSWORD: 'inherited', MARKSCODE_HOME: '/home/u/.markscode',
      SOME_DIR: '/home/u/.local/share/markscode', PATH: `/home/u/.markscode/bin:${saved.PATH}`
    });
    try {
      await create();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    expect(state.actions.map(item => item.action)).toEqual(['start']);
    const env = state.actions[0]!.env;
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    for (const name of ['ELECTRON_RUN_AS_NODE', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_PASSWORD', 'MARKSCODE_HOME', 'SOME_DIR']) expect(env[name]).toBeUndefined();
    for (const name of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'OPENCODE_CONFIG_DIR']) expect(env[name]).toBe(saved[name]);
    expect(JSON.stringify(env).toLowerCase()).not.toContain('markscode');
    // Already running: the next use does not start it again.
    await engine.openCodeEngine.models({});
    expect(state.actions.map(item => item.action)).toEqual(['start']);
  });

  it('creates the session at the project folder with a ruleset that asks for shell/edit and denies question, the outside and .markscode', async () => {
    await expect(engine.openCodeEngine.create({ projectId: null })).rejects.toThrow('Choose a project for an OpenCode chat first');
    const view = await create();
    const [call] = fake.calls('POST', '/api/session');
    expect(call!.body).toEqual({
      title: 'Chat Marks', location: { directory }, model: { providerID: 'opencode', id: 'big-pickle' },
      permissions: [
        { action: 'shell', resource: '*', effect: 'ask' },
        { action: 'edit', resource: '*', effect: 'ask' },
        { action: 'question', resource: '*', effect: 'deny' },
        { action: 'edit', resource: '/*', effect: 'deny' },
        { action: 'read', resource: '/*', effect: 'deny' },
        { action: 'external_directory', resource: '*', effect: 'deny' },
        { action: 'edit', resource: '.markscode/*', effect: 'deny' },
        { action: 'edit', resource: '*/.markscode/*', effect: 'deny' }
      ]
    });
    // OpenCode's own evaluation: the last matching wildcard rule wins, `*` matches `/`.
    const match = (input: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's').test(input);
    const evaluate = (action: string, resource: string) => call!.body.permissions.findLast((rule: any) => match(action, rule.action) && match(resource, rule.resource))?.effect ?? 'ask';
    expect(evaluate('edit', 'src/sum.ts')).toBe('ask');
    expect(evaluate('edit', '/etc/passwd')).toBe('deny');
    expect(evaluate('edit', '.markscode/a.txt')).toBe('deny');
    expect(evaluate('edit', 'sub/.markscode/b.txt')).toBe('deny');
    expect(evaluate('read', '/home/user/.ssh/id_rsa')).toBe('deny');
    expect(evaluate('external_directory', '/tmp/*')).toBe('deny');
    expect(evaluate('question', 'Which file?')).toBe('deny');
    expect(evaluate('shell', 'rm -rf build')).toBe('ask');
    expect(view).toMatchObject({ engine: 'opencode', model: 'opencode/big-pickle', running: false, approval: 'ask', pending: null });
    expect(await ledger.storedChatRecord(view.sessionId)).toEqual({ engine: 'opencode', backendSessionId: 'ses_0001AbC', model: 'opencode/big-pickle', effort: null });
    expect((await store.getSession(view.sessionId))?.projectId).toBe(PROJECT);
    expect(engine.openCodeEngine.terminal!({ sessionId: view.sessionId, conversationId: view.conversationId, backendSessionId: 'ses_0001AbC', cwd: directory }))
      .toEqual({ argv: ['-s', 'ses_0001AbC', directory], mode: 'live' });
    expect(engine.openCodeEngine.terminal!({ sessionId: view.sessionId, conversationId: view.conversationId, backendSessionId: '-rf', cwd: directory })).toBeNull();
    // Models: the enabled ones, the service's default first, with their variants as efforts.
    const models = await engine.openCodeEngine.models({});
    expect(models.models.map(item => [item.id, item.label, item.efforts ?? null])).toEqual([
      ['opencode/big-pickle', 'Big Pickle', null], ['opencode/minimax-m3.1-flash-free', 'MiniMax M3.1 Flash Free', ['low', 'medium', 'high']]
    ]);
    await engine.openCodeEngine.setChatSettings(view.sessionId, { model: 'opencode/minimax-m3.1-flash-free', effort: 'high', approval: 'auto' });
    expect(fake.calls('POST', '/api/session/ses_0001AbC/model').at(-1)!.body).toEqual({ model: { providerID: 'opencode', id: 'minimax-m3.1-flash-free', variant: 'high' } });
    const auto = fake.calls('PATCH', '/api/session/ses_0001AbC').at(-1)!.body.permissions;
    expect(auto.slice(0, 2).map((rule: any) => rule.effect)).toEqual(['allow', 'allow']);
    expect(auto.slice(2).every((rule: any) => rule.effect === 'deny')).toBe(true);
  });

  it('streams a full turn: answer text, a shell row and a write row with the diff its permission showed; usage is summed per step', async () => {
    const view = await create();
    const sessionID = 'ses_0001AbC';
    fake.onPrompt = () => {
      const m = 'msg_a1';
      fake.emit('session.execution.started', { sessionID });
      fake.emit('session.step.started', { sessionID, agent: 'build', assistantMessageID: m });
      fake.emit('session.text.delta', { sessionID, assistantMessageID: m, ordinal: 0, delta: "I'll run " });
      fake.emit('session.text.delta', { sessionID, assistantMessageID: m, ordinal: 0, delta: 'the tests.' });
      fake.emit('session.text.ended', { sessionID, assistantMessageID: m, ordinal: 0, text: "I'll run the tests." });
      fake.emit('session.tool.input.started', { sessionID, assistantMessageID: m, id: 'call_1', name: 'shell' });
      fake.emit('session.tool.called', { sessionID, assistantMessageID: m, id: 'call_1', input: { command: 'npm test' }, executed: false });
      fake.emit('session.tool.success', { sessionID, assistantMessageID: m, id: 'call_1', content: [{ type: 'text', text: 'ok 3 tests' }], metadata: { status: 'completed', exit: 0, truncated: false }, executed: false });
      fake.emit('session.step.ended', { sessionID, assistantMessageID: m, finish: 'tool-calls', tokens: { input: 1000, output: 50, reasoning: 5, cache: { read: 600, write: 0 } } });
      // The session's running total, not this turn's: not used.
      fake.emit('session.usage.updated', { sessionID, tokens: { input: 99_999, output: 99_999, reasoning: 0, cache: { read: 0, write: 0 } } });
      const m2 = 'msg_a2';
      fake.emit('session.tool.input.started', { sessionID, assistantMessageID: m2, id: 'call_2', name: 'write' });
      fake.emit('session.tool.called', { sessionID, assistantMessageID: m2, id: 'call_2', input: { path: `${directory}/src/sum.ts`, content: 'a + b\n' }, executed: false });
      fake.ask({ id: 'per_w', sessionID, action: 'edit', resources: ['src/sum.ts'], save: ['*'], source: { type: 'tool', messageID: m2, id: 'call_2' },
        metadata: { files: [{ file: 'src/sum.ts', patch: '--- src/sum.ts\n+++ src/sum.ts\n@@ -1,1 +1,1 @@\n-a - b\n+a + b\n', status: 'modified', additions: 1, deletions: 1 }] } });
    };
    const { turnId } = await engine.openCodeEngine.send(view.sessionId, 'Fix the bug');
    expect(fake.calls('POST', `/api/session/${sessionID}/prompt`)[0]!.body).toEqual({ text: 'Fix the bug' });
    await until(async () => !!(await engine.openCodeEngine.view(view.sessionId)).pending);
    await engine.openCodeEngine.approve(view.sessionId, (await engine.openCodeEngine.view(view.sessionId)).pending!.approvalId, 'approve');
    fake.emit('session.tool.success', { sessionID, assistantMessageID: 'msg_a2', id: 'call_2', content: [{ type: 'text', text: 'Created file successfully: src/sum.ts' }], metadata: { truncated: false }, executed: false });
    fake.emit('session.text.ended', { sessionID, assistantMessageID: 'msg_a2', ordinal: 0, text: 'Fixed the sign.' });
    fake.emit('session.step.ended', { sessionID, assistantMessageID: 'msg_a2', finish: 'stop', tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 400, write: 0 } } });
    await until(() => engine.openCodeTurnUsage(view.sessionId)?.outputTokens === 70);
    expect(engine.openCodeTurnUsage(view.sessionId)).toEqual({ inputTokens: 2100, outputTokens: 70, cachedInputTokens: 1000, reasoningTokens: 5 });
    fake.finish(sessionID, 'succeeded');
    await engine.openCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId))).toEqual([
      'user Fix the bug', 'turn_start', "assistant final I'll run the tests.",
      'tool exec_command ok Ran npm test', 'tool apply_patch ok Edited sum.ts [+1 −1]',
      'assistant final Fixed the sign.', 'turn_end completed'
    ]);
    const all = await events(view.sessionId);
    const patch = all.find(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch');
    expect(patch?.kind === 'tool_call' && patch.call).toMatchObject({ engine: 'opencode', attribution: 'engine', changes: [{ path: 'src/sum.ts', added: 1, removed: 1 }] });
    expect(all.filter(event => event.kind === 'tool_call').every(event => event.turnId === turnId)).toBe(true);
    expect((await ledger.storedChatRecord(view.sessionId))?.openTurn).toBeUndefined();
  });

  it('answers the exact request: once; always as once + the chat switched to Auto (never upstream `always`); stale and changed requests refused; deny as reject', async () => {
    const view = await create();
    const sessionID = 'ses_0001AbC';
    const ask = (id: string, command: string, tool: string) => fake.ask({ id, sessionID, action: 'shell', resources: [command], save: ['npm *'], source: { type: 'tool', messageID: 'msg_a', id: tool } });
    fake.onPrompt = () => { fake.emit('session.execution.started', { sessionID }); ask('per_1', 'npm run build', 'call_1'); };
    await engine.openCodeEngine.send(view.sessionId, 'Build it');
    const pending = async () => (await engine.openCodeEngine.view(view.sessionId)).pending;
    await until(async () => !!(await pending()));
    const first = (await pending())!;
    expect(first).toMatchObject({ tool: 'shell', summary: 'npm run build', toolCallId: 'call_1' });
    expect(JSON.stringify(first)).not.toContain('per_1');
    await engine.openCodeEngine.approve(view.sessionId, first.approvalId, 'approve');
    expect(fake.calls('POST', `/api/session/${sessionID}/permission/per_1/reply`)[0]!.body).toEqual({ decision: 'once' });
    await expect(engine.openCodeEngine.approve(view.sessionId, first.approvalId, 'approve')).rejects.toThrow('no longer pending');

    ask('per_2', 'npm test', 'call_2');
    await until(async () => (await pending())?.toolCallId === 'call_2');
    await engine.openCodeEngine.approve(view.sessionId, (await pending())!.approvalId, 'always');
    expect(fake.calls('POST', `/api/session/${sessionID}/permission/per_2/reply`)[0]!.body).toEqual({ decision: 'once' });
    expect(fake.requests.some(item => item.body?.decision === 'always')).toBe(false);
    expect(fake.sessions.get(sessionID)!.permissions.slice(0, 2).map((rule: any) => rule.effect)).toEqual(['allow', 'allow']);
    expect((await engine.openCodeEngine.view(view.sessionId)).approval).toBe('auto');

    ask('per_3', 'ls', 'call_3');
    await until(async () => (await pending())?.toolCallId === 'call_3');
    fake.pending.get(sessionID)![0]!.resources = ['rm -rf /'];
    await expect(engine.openCodeEngine.approve(view.sessionId, (await pending())!.approvalId, 'approve')).rejects.toThrow('changed after it was shown');
    expect(fake.calls('POST', `/api/session/${sessionID}/permission/per_3/reply`)).toHaveLength(0);
    await engine.openCodeEngine.approve(view.sessionId, (await pending())!.approvalId, 'deny');
    expect(fake.calls('POST', `/api/session/${sessionID}/permission/per_3/reply`)[0]!.body).toEqual({ decision: 'reject', message: 'The user declined this in Chat Marks.' });
    fake.emit('session.tool.input.started', { sessionID, assistantMessageID: 'msg_a', id: 'call_3', name: 'shell' });
    fake.emit('session.tool.called', { sessionID, assistantMessageID: 'msg_a', id: 'call_3', input: { command: 'rm -rf /' }, executed: false });
    fake.emit('session.tool.failed', { sessionID, assistantMessageID: 'msg_a', id: 'call_3', error: { type: 'permission.rejected', message: 'The user declined this in Chat Marks.' }, executed: false });
    fake.finish(sessionID, 'succeeded');
    await engine.openCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId))).toContain('tool exec_command tool_rejected Declined: Ran rm -rf / [declined]');
  });

  it('removes the card when the TUI answered the request (permission.replied it did not send)', async () => {
    const view = await create();
    const sessionID = 'ses_0001AbC';
    fake.onPrompt = () => fake.ask({ id: 'per_9', sessionID, action: 'edit', resources: ['src/a.ts'] });
    await engine.openCodeEngine.send(view.sessionId, 'Edit a');
    await until(async () => !!(await engine.openCodeEngine.view(view.sessionId)).pending);
    expect((await engine.openCodeEngine.view(view.sessionId)).pending).toMatchObject({ tool: 'edit', summary: 'Edit src/a.ts', files: ['src/a.ts'] });
    fake.pending.set(sessionID, []);
    fake.emit('permission.replied', { sessionID, requestID: 'per_9', reply: 'once' });
    await until(async () => !(await engine.openCodeEngine.view(view.sessionId)).pending);
    expect(fake.requests.some(item => item.path.endsWith('/reply'))).toBe(false);
    fake.finish(sessionID, 'succeeded');
    await engine.openCodeTurnDone(view.sessionId);
  });

  it('interrupts on Stop (the interrupt settles a pending request, nothing is answered) and ends stopped; a TUI interrupt is interrupted; a failure fails', async () => {
    const view = await create();
    const sessionID = 'ses_0001AbC';
    fake.onPrompt = () => {
      fake.emit('session.execution.started', { sessionID });
      fake.emit('session.text.delta', { sessionID, assistantMessageID: 'msg_s', ordinal: 0, delta: 'Working on it' });
      fake.ask({ id: 'per_s', sessionID, action: 'shell', resources: ['sleep 20'], source: { type: 'tool', messageID: 'msg_s', id: 'call_s' } });
    };
    await engine.openCodeEngine.send(view.sessionId, 'Long task');
    await until(async () => !!(await engine.openCodeEngine.view(view.sessionId)).pending);
    expect(await engine.openCodeEngine.stop(view.sessionId)).toBe(true);
    expect(fake.calls('POST', `/api/session/${sessionID}/interrupt`)).toHaveLength(1);
    await engine.openCodeTurnDone(view.sessionId);
    expect(fake.requests.some(item => item.path.endsWith('/reply'))).toBe(false);
    expect(outline(await events(view.sessionId)).slice(-2)).toEqual(['assistant final Working on it', 'turn_end stopped']);
    expect(await engine.openCodeEngine.stop(view.sessionId)).toBe(false);

    fake.onPrompt = () => {
      fake.emit('session.execution.started', { sessionID });
      setTimeout(() => fake.finish(sessionID, 'interrupted', { reason: 'user' }), 20);
    };
    await engine.openCodeEngine.send(view.sessionId, 'Again');
    await engine.openCodeTurnDone(view.sessionId);
    expect((await events(view.sessionId)).filter(event => event.kind === 'turn_end').at(-1)).toMatchObject({ outcome: 'interrupted', detail: 'The OpenCode run was stopped in its terminal' });

    fake.onPrompt = () => {
      fake.sessions.get(sessionID)!.outcome = 'failed';
      fake.active.delete(sessionID);
      fake.emit('session.execution.failed', { sessionID, error: { type: 'provider', message: 'Missing API key' } });
    };
    await engine.openCodeEngine.send(view.sessionId, 'Third');
    await engine.openCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId)).slice(-2)).toEqual(['error OpenCode failed: Missing API key', 'turn_end failed']);
  });

  it('refuses to send while the TUI runs the same session', async () => {
    const view = await create();
    fake.active.add('ses_0001AbC');
    await expect(engine.openCodeEngine.send(view.sessionId, 'Hi')).rejects.toThrow('still working in this session');
    expect((await engine.openCodeEngine.view(view.sessionId)).running).toBe(false);
  });

  it('reconnects after the event stream drops and reconciles messages and pending permissions', async () => {
    const view = await create();
    const sessionID = 'ses_0001AbC';
    fake.onPrompt = () => {
      fake.emit('session.execution.started', { sessionID });
      fake.emit('session.text.delta', { sessionID, assistantMessageID: 'msg_r', ordinal: 0, delta: 'Let me ' });
      setTimeout(() => {
        fake.drop();
        fake.messages.get(sessionID)!.push({ id: 'msg_r', type: 'assistant', time: { created: Date.now() }, content: [
          { type: 'text', text: 'Let me check the files.' },
          { type: 'tool', id: 'call_r1', name: 'read', state: { status: 'completed', input: { path: `${directory}/src/main.ts` }, content: [{ type: 'text', text: '1: export {}' }] }, time: { created: Date.now() } },
          { type: 'tool', id: 'call_r2', name: 'shell', state: { status: 'running', input: { command: 'make' }, metadata: {} }, time: { created: Date.now() } }
        ] });
        fake.pending.set(sessionID, [{ id: 'per_r', sessionID, action: 'shell', resources: ['make'], source: { type: 'tool', messageID: 'msg_r', id: 'call_r2' } }]);
      }, 30);
    };
    await engine.openCodeEngine.send(view.sessionId, 'Check');
    await until(async () => (await engine.openCodeEngine.view(view.sessionId)).pending?.toolCallId === 'call_r2');
    expect(fake.calls('GET', '/api/event').length).toBeGreaterThanOrEqual(2);
    await engine.openCodeEngine.approve(view.sessionId, (await engine.openCodeEngine.view(view.sessionId)).pending!.approvalId, 'approve');
    fake.emit('session.tool.success', { sessionID, assistantMessageID: 'msg_r', id: 'call_r2', content: [{ type: 'text', text: 'built' }], metadata: { exit: 0 }, executed: false });
    fake.emit('session.text.ended', { sessionID, assistantMessageID: 'msg_r', ordinal: 1, text: 'Done.' });
    fake.finish(sessionID, 'succeeded');
    await engine.openCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId))).toEqual([
      'user Check', 'turn_start', 'assistant final Let me check the files.', 'tool read ok Read main.ts', 'tool exec_command ok Ran make', 'assistant final Done.', 'turn_end completed'
    ]);
  });

  it('re-attaches after an app restart to a session that still runs (the service outlived the app)', async () => {
    const view = await create();
    const sessionID = 'ses_0001AbC';
    const previous = new TurnProjector({ engine: 'opencode', conversationId: view.conversationId, turnId: 'api-prev', sink: storeProjectorSink(view.sessionId),
      approvals: { gate: new ApprovalGate(), answer: () => undefined }, streamWriteMs: 0 });
    await previous.start('Refactor');
    await previous.apply({ type: 'text_delta', delta: 'Refacto' });
    fake.messages.get(sessionID)!.push({ id: 'msg_u0', type: 'user', text: 'Refactor', time: { created: Date.now() } });
    fake.messages.get(sessionID)!.push({ id: 'msg_p', type: 'assistant', time: { created: Date.now() }, content: [
      { type: 'text', text: 'Refactoring now.' },
      { type: 'tool', id: 'call_p', name: 'shell', state: { status: 'completed', input: { command: 'git status' }, content: [{ type: 'text', text: 'clean' }], metadata: { exit: 0 } }, time: { created: Date.now() } }
    ] });
    fake.active.add(sessionID);
    engine.resetOpenCodeEngineForTests();
    executor.resetApiChatExecutorForTests();
    store.resetSessionStoreForTests();
    // The engine-neutral recovery leaves OpenCode's open turn to its own recovery.
    await executor.recoverApiChats();
    expect((await ledger.storedChatRecord(view.sessionId))?.openTurn?.turnId).toBe('api-prev');
    await registry.recoverAgentEngines();
    expect((await engine.openCodeEngine.view(view.sessionId)).running).toBe(true);
    await until(async () => outline(await events(view.sessionId)).includes('tool exec_command ok Ran git status'));
    fake.emit('session.text.ended', { sessionID, assistantMessageID: 'msg_p', ordinal: 1, text: 'All done.' });
    fake.finish(sessionID, 'succeeded');
    await engine.openCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId))).toEqual([
      'user Refactor', 'turn_start', 'assistant final Refactoring now.', 'tool exec_command ok Ran git status', 'assistant final All done.', 'turn_end completed'
    ]);
  });

  it('closes a restarted turn interrupted when the session no longer runs, or the service is stopped (never starting it)', async () => {
    const view = await create();
    for (const turnId of ['api-gone', 'api-stopped']) {
      const previous = new TurnProjector({ engine: 'opencode', conversationId: view.conversationId, turnId, sink: storeProjectorSink(view.sessionId),
        approvals: { gate: new ApprovalGate(), answer: () => undefined } });
      await previous.start('Gone');
      if (turnId === 'api-stopped') state.registration = null;
      engine.resetOpenCodeEngineForTests();
      service.resetOpenCodeServiceForTests();
      store.resetSessionStoreForTests();
      await engine.recoverOpenCodeChats();
      expect(outline(await events(view.sessionId)).at(-1)).toBe('turn_end interrupted');
      expect((await ledger.storedChatRecord(view.sessionId))?.openTurn).toBeUndefined();
    }
    expect(fake.calls('GET', '/api/event')).toHaveLength(0);
    expect(state.actions).toEqual([]);
  });

  it('opens its live terminal with `-s <session> <folder>`; every attach first makes sure the service runs', async () => {
    const view = await create();
    expect(await engine.openCodeEngine.openTerminal!(view.sessionId)).toEqual({ cliSessionId: 'cli-opencode-1' });
    expect(openTerminal).toHaveBeenCalledWith({ sessionId: view.sessionId, projectId: PROJECT, args: ['-s', 'ses_0001AbC', directory], title: 'OpenCode · New OpenCode chat' });
    expect(terminalCheck).not.toBeNull();
    state.registration = null;
    service.resetOpenCodeServiceForTests();
    await terminalCheck!();
    expect(state.actions.map(item => item.action)).toEqual(['start']);
    module = { ...module, enabled: false };
    await expect(terminalCheck!()).rejects.toThrow('Enable the OpenCode module');
    module.enabled = true;
    const { chatAction } = await import('../src/main/api-chat/ipc.js');
    expect(await chatAction({ action: 'terminal', sessionId: view.sessionId })).toEqual({ cliSessionId: 'cli-opencode-1' });
  });

  it('sends Basic auth on every request and never logs the password', async () => {
    const view = await create();
    fake.onPrompt = sessionID => fake.finish(sessionID, 'succeeded');
    await engine.openCodeEngine.send(view.sessionId, 'Hello');
    await engine.openCodeTurnDone(view.sessionId);
    expect(fake.requests.length).toBeGreaterThan(4);
    expect(fake.requests.every(item => item.auth === basicAuth(PASSWORD))).toBe(true);
    const logged = JSON.stringify(getLog());
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(basicAuth(PASSWORD).slice(6));
  });
});

describe('the OpenCode background service', () => {
  const fake = new FakeOpenCode();
  const state: ServiceState = { registration: null, exe: BINARY, binaryVersion: '2.1.2', actions: [] };
  beforeAll(async () => { await fake.start(); });
  beforeEach(() => {
    service.resetOpenCodeServiceForTests();
    fake.active.clear();
    fake.version = '2.1.2';
    Object.assign(state, { registration: null, exe: BINARY, binaryVersion: '2.1.2', actions: [] });
    serviceHost(fake, state);
  });
  afterAll(async () => { service.setOpenCodeServiceHostForTests(null); await fake.stop(); });

  it('trusts only a loopback registration whose pid answers', async () => {
    expect(service.parseRegistration(JSON.stringify({ url: 'http://example.com:49374', pid: 5, password: 'x' }))).toBeNull();
    expect(service.parseRegistration(JSON.stringify({ url: 'http://127.0.0.1:49374', pid: 5, password: 'x', version: '2.1.2' })))
      .toEqual({ url: 'http://127.0.0.1:49374', pid: 5, password: 'x', version: '2.1.2' });
    expect(service.parseRegistration('not json')).toBeNull();
    expect(service.registrationPath({ XDG_STATE_HOME: '/x/state' }, '/home/u')).toBe(path.join('/x/state', 'opencode', 'service.json'));
    expect(service.registrationPath({}, '/home/u')).toBe(path.join('/home/u', '.local', 'state', 'opencode', 'service.json'));
    // A registration left by a service that died (another pid answers) is a stopped service.
    state.registration = JSON.stringify({ url: fake.url, pid: 99, password: PASSWORD });
    expect(await service.openCodeServiceView()).toMatchObject({ state: 'stopped' });
  });

  it('Start/Stop/Restart from the card; Stop refuses a foreign service; a foreign service is replaced only by Restart', async () => {
    expect(await service.openCodeServiceView()).toEqual({ state: 'stopped', port: null, version: null, restartPending: false });
    expect(await service.openCodeServiceAction('start')).toMatchObject({ state: 'running', version: '2.1.2', port: Number(new URL(fake.url).port) });
    expect(await service.openCodeServiceAction('stop')).toMatchObject({ state: 'stopped' });
    state.registration = fake.registration();
    state.exe = '/usr/bin/opencode';
    expect(await service.openCodeServiceView()).toMatchObject({ state: 'foreign' });
    await expect(service.openCodeServiceAction('stop')).rejects.toThrow(service.OPENCODE_SERVICE_FOREIGN);
    await service.stopOwnOpenCodeService();
    expect(state.actions.map(item => item.action)).toEqual(['start', 'stop']);
    expect(await service.openCodeServiceAction('restart')).toMatchObject({ state: 'running' });
    expect(state.actions.map(item => item.action)).toEqual(['start', 'stop', 'restart']);
    await service.stopOwnOpenCodeService();
    expect(state.actions.at(-1)!.action).toBe('stop');
  });

  it('after an update restarts at once when nothing runs, else waits for the turn and any TUI session (no downtime)', async () => {
    await service.openCodeServiceAction('start');
    let busy = true;
    service.bindOpenCodeService({ busy: () => busy });
    // The module folder's file was replaced: the running process shows the old inode.
    state.binaryVersion = '2.1.3';
    state.exe = `${BINARY} (deleted)`;
    await service.requestOpenCodeRestart();
    expect(service.openCodeRestartPending()).toBe(true);
    expect(await service.openCodeServiceView()).toMatchObject({ state: 'running', version: '2.1.2', restartPending: true });
    busy = false;
    fake.active.add('ses_tui');
    await service.requestOpenCodeRestart();
    expect(state.actions.map(item => item.action)).toEqual(['start']);
    fake.active.clear();
    service.openCodeTurnsSettled();
    await until(() => state.actions.length === 2);
    expect(state.actions.map(item => item.action)).toEqual(['start', 'restart']);
    expect(await service.openCodeServiceView()).toMatchObject({ state: 'running', version: '2.1.3', restartPending: false });
  });

  it('on next use restarts a stale own service that nothing uses, and serves it as is while a session runs', async () => {
    state.registration = fake.registration();
    state.binaryVersion = '2.1.3';
    state.exe = `${BINARY} (deleted)`;
    fake.active.add('ses_x');
    expect((await service.ensureOpenCodeService()).version).toBe('2.1.2');
    expect(state.actions).toEqual([]);
    fake.active.clear();
    service.resetOpenCodeServiceForTests();
    serviceHost(fake, state);
    expect((await service.ensureOpenCodeService()).version).toBe('2.1.3');
    expect(state.actions.map(item => item.action)).toEqual(['restart']);
  });

  it('builds the environment without Electron node mode, server auth or MarksCode, with self-update off', () => {
    const env = service.opencodeServiceEnvironment(false, {
      PATH: '/home/u/.markscode/bin:/usr/bin', ELECTRON_RUN_AS_NODE: '1', OPENCODE_SERVER_USERNAME: 'x', MARKSCODE_DIR: '/a', DATA: '/home/u/.local/share/markscode', HOME: '/home/u'
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', OPENCODE_DISABLE_AUTOUPDATE: '1' });
  });
});

describe('OpenCode SSE parsing', () => {
  it('joins data lines, skips comments, handles split chunks and CRLF, and drops oversized records', () => {
    const dropped = vi.fn();
    const parser = new SseParser(dropped);
    expect(parser.push(': heartbeat\n\ndata: {"a"')).toEqual([]);
    expect(parser.push(':1}\r\n\r\ndata: x\ndata: y\n\n')).toEqual(['{"a":1}', 'x\ny']);
    expect(parser.push(`data: ${'z'.repeat(1024 * 1024 + 10)}\n\ndata: ok\n\n`)).toEqual(['ok']);
    expect(dropped).toHaveBeenCalledTimes(1);
  });
});

describe('the retired MarksCode engine', () => {
  let directory = '';
  beforeAll(async () => {
    directory = await makeTempDir('cos-retired-');
    initConfigPath(directory);
    initDurableStore(directory);
    store.initSessionStore(directory);
  });
  afterAll(async () => {
    await flushDurable();
    store.resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(directory);
  });

  it('keeps its chats readable, offers no new chat, runs nothing and claims no recovery (OpenCode recovers its own)', async () => {
    registry.resetAgentEnginesForTests();
    const summary = await store.createSession({ title: 'Old MarksCode chat', titleSource: 'fallback', conversationId: 'cosapi-00000000-0000-4000-8000-00000000c0de' });
    await ledger.updateChatRecord(summary.id, () => ({ engine: 'markscode', backendSessionId: 'ses_old', model: 'anthropic/sonnet-5', effort: null }));
    const retired = registry.agentEngine('markscode');
    expect(await retired.view(summary.id)).toMatchObject({ engine: 'markscode', model: 'anthropic/sonnet-5', running: false, pending: null });
    await expect(retired.send(summary.id, 'hi')).rejects.toThrow('read-only');
    await expect(registry.createAgentChat('markscode', { projectId: null })).rejects.toThrow('read-only');
    expect(retired.terminalMode).toBeNull();
    expect((await registry.listAgentEngines()).find(item => item.id === 'markscode')).toMatchObject({ available: false, terminal: null });
    const { recoversOwnTurns } = await import('../src/main/agent-engine/recovery.js');
    expect(recoversOwnTurns('markscode')).toBe(false);
    expect(recoversOwnTurns('opencode')).toBe(true);
  });
});
