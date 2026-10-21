import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
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
const engine = await import('../src/main/agent-engine/markscode.js');
const { SseParser, basicAuth } = await import('../src/main/agent-engine/markscode-client.js');
const { TurnProjector, storeProjectorSink } = await import('../src/main/agent-engine/projector.js');
const { ApprovalGate } = await import('../src/main/agent-engine/approval.js');
const registry = await import('../src/main/agent-engine/registry.js');
const { getLog } = await import('../src/main/logger.js');
import type { SessionEvent } from '../src/shared/session.js';

const PASSWORD = 'pw-secret-do-not-log-9f2c';
const PROJECT = '00000000-0000-4000-8000-0000000000aa';

interface Recorded { method: string; path: string; query: URLSearchParams; body: any; auth: string | undefined }
interface Permission { id: string; sessionID: string; action: string; resources: string[]; source?: { type: 'tool'; messageID: string; id: string } }

/** A MarksCode 2.0.25 service in miniature: the endpoints and event shapes the engine uses. */
class FakeMarksCode {
  server!: http.Server;
  url = '';
  requests: Recorded[] = [];
  streams = new Set<http.ServerResponse>();
  active = new Set<string>();
  pending = new Map<string, Permission[]>();
  messages = new Map<string, any[]>();
  sessions = new Map<string, { id: string; outcome?: string; time: { idle?: number } }>();
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

  registration(): string { return JSON.stringify({ id: 'svc', version: '2.0.25', url: this.url, pid: 4242, password: PASSWORD }); }

  emit(type: string, data: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({ id: `evt_${++this.next}`, created: Date.now(), type, data })}\n\n`;
    for (const stream of this.streams) stream.write(frame);
  }

  /** The event stream fails: every connected client loses it. */
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
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(value === undefined ? '' : JSON.stringify(value));
    };
    if (request.headers.authorization !== basicAuth(PASSWORD)) { json(401, { message: 'Unauthorized' }); return; }
    const parts = url.pathname.split('/').filter(Boolean);
    const [, , sessionId, sub, requestId, reply] = parts;
    if (url.pathname === '/api/info') return json(200, { version: '2.0.25', pid: 4242 });
    if (url.pathname === '/api/model') return json(200, { location: {}, data: [
      { id: 'gpt-6', modelID: 'gpt-6', providerID: 'openai', name: 'GPT-6', enabled: true, variants: [{ id: 'high' }] },
      { id: 'sonnet-5', modelID: 'sonnet-5', providerID: 'anthropic', name: 'Sonnet', enabled: true, variants: [] },
      { id: 'old', modelID: 'old', providerID: 'openai', name: 'Old', enabled: false, variants: [] }
    ] });
    if (url.pathname === '/api/model/default') return json(200, { location: {}, data: { id: 'sonnet-5', providerID: 'anthropic', name: 'Sonnet' } });
    if (url.pathname === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'evt_c', type: 'server.connected', data: {} })}\n\n`);
      response.write(': heartbeat\n\n');
      this.streams.add(response);
      response.on('close', () => this.streams.delete(response));
      return;
    }
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const id = `ses_${this.sessions.size + 1}`;
      this.sessions.set(id, { id, time: {} });
      this.messages.set(id, []);
      return json(200, { data: { id, location: body.location, permissions: body.permissions } });
    }
    if (url.pathname === '/api/session/active') return json(200, { data: Object.fromEntries([...this.active].map(id => [id, { type: 'running' }])) });
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return json(404, { message: 'Session not found' });
    if (!sub && request.method === 'GET') return json(200, { data: session });
    if (!sub && request.method === 'PATCH') return json(204);
    if (sub === 'model') return json(204);
    if (sub === 'message') {
      const list = [...(this.messages.get(session.id) ?? [])];
      return json(200, { data: url.searchParams.get('order') === 'desc' ? list.reverse() : list, cursor: {} });
    }
    if (sub === 'prompt') {
      const id = `msg_u${++this.next}`;
      this.messages.get(session.id)!.push({ id, type: 'user', text: body.text, time: { created: Date.now() } });
      this.active.add(session.id);
      json(200, { data: { id, sessionID: session.id, text: body.text, time: { created: Date.now() } } });
      setTimeout(() => this.onPrompt(session.id, body.text), 5);
      return;
    }
    if (sub === 'interrupt') {
      const was = this.active.delete(session.id);
      json(200, { interrupted: was });
      if (was) setTimeout(() => this.finish(session.id, 'interrupted', { reason: 'user' }), 5);
      return;
    }
    if (sub === 'permission') {
      const list = this.pending.get(session.id) ?? [];
      if (!requestId) return json(200, { data: list });
      const found = list.find(item => item.id === requestId);
      if (!found) return json(404, { message: 'Permission not found' });
      if (!reply) return json(200, { data: found });
      this.pending.set(session.id, list.filter(item => item !== found));
      json(204);
      this.emit('permission.replied', { sessionID: session.id, requestID: requestId, reply: body.decision });
      return;
    }
    json(404, { message: 'Not found' });
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

describe('MarksCode agent engine (fake HTTP+SSE service)', () => {
  let directory = '';
  const fake = new FakeMarksCode();
  let registration: string | null = null;
  let module = { enabled: true, command: true, binary: '/usr/local/bin/markscode' as string | null };
  const startService = vi.fn(async () => { registration = fake.registration(); });

  beforeAll(async () => {
    directory = await makeTempDir('cos-markscode-');
    initConfigPath(directory);
    initDurableStore(directory);
    store.initSessionStore(directory);
    await saveConfig(defaultConfig());
    await fake.start();
  });
  beforeEach(async () => {
    executor.resetApiChatExecutorForTests();
    engine.resetMarksCodeEngineForTests();
    resetRecorderForTests();
    store.resetSessionStoreForTests();
    await writeDurableNow(ledger.API_CHAT_SESSIONS_STATE, {});
    fake.requests.length = 0;
    fake.active.clear();
    fake.pending.clear();
    fake.sessions.clear();
    fake.messages.clear();
    fake.onPrompt = () => undefined;
    registration = fake.registration();
    module = { enabled: true, command: true, binary: '/usr/local/bin/markscode' };
    startService.mockClear();
    engine.setMarksCodeDepsForTests({
      moduleState: async () => ({ ...module }),
      projectFolder: async projectId => {
        if (projectId !== PROJECT) throw new Error('Project not found');
        return { native: directory, backend: directory };
      },
      registration: async () => registration,
      startService,
      fetch: (...args) => fetch(...args),
      reconnectDelaysMs: [20, 40, 80],
      stopGraceMs: 300
    });
  });
  afterEach(() => { engine.resetMarksCodeEngineForTests(); fake.drop(); });
  afterAll(async () => {
    engine.setMarksCodeDepsForTests(null);
    engine.resetMarksCodeEngineForTests();
    await fake.stop();
    await flushDurable();
    resetRecorderForTests();
    store.resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(directory);
  });

  const create = () => engine.marksCodeEngine.create({ projectId: PROJECT });
  const events = (sessionId: string) => store.readEvents(sessionId);

  it('reports why it is unavailable, and starts the service only through the explicit action', async () => {
    module.binary = null;
    expect(await engine.marksCodeStatus()).toEqual({ available: false, detail: 'MarksCode is not installed', fix: 'install' });
    module = { enabled: false, command: true, binary: '/usr/local/bin/markscode' };
    expect((await engine.marksCodeStatus()).fix).toBe('enable');
    module.enabled = true;
    registration = null;
    expect(await engine.marksCodeStatus()).toEqual({ available: false, detail: engine.SERVICE_STOPPED, fix: 'start' });
    // A registration a dead server left behind (nothing listens there) is a stopped service too.
    registration = JSON.stringify({ url: 'http://127.0.0.1:9', pid: 1, password: PASSWORD });
    expect((await engine.marksCodeStatus()).fix).toBe('start');
    // A non-loopback URL is never sent the password.
    registration = JSON.stringify({ url: 'http://example.com:4096', pid: 4242, password: PASSWORD });
    expect((await engine.marksCodeStatus()).fix).toBe('start');
    expect(startService).not.toHaveBeenCalled();
    expect((await registry.listAgentEngines()).find(item => item.id === 'markscode')).toMatchObject({ available: false, terminal: 'live' });
    registration = null;
    const started = await engine.startMarksCodeService();
    expect(startService).toHaveBeenCalledWith('/usr/local/bin/markscode');
    expect(started).toMatchObject({ available: true, fix: null });
    expect(started.detail).toContain('MarksCode 2.0.25');
    expect((await registry.listAgentEngines()).find(item => item.id === 'markscode')).toMatchObject({ available: true });
    // Wrong password: refused, with a reason, never the password.
    registration = JSON.stringify({ url: fake.url, pid: 4242, password: 'wrong' });
    expect(await engine.marksCodeStatus()).toEqual({ available: false, detail: 'The MarksCode service refused its saved password', fix: null });
  });

  it('creates the session at the project folder with a ruleset that asks for shell/edit and denies the outside', async () => {
    await expect(engine.marksCodeEngine.create({ projectId: null })).rejects.toThrow('Choose a project for a MarksCode chat first');
    const view = await create();
    const [call] = fake.calls('POST', '/api/session');
    expect(call!.body).toEqual({
      title: 'Chat Marks', location: { directory }, model: { providerID: 'anthropic', id: 'sonnet-5' },
      permissions: [
        { action: 'shell', resource: '*', effect: 'ask' },
        { action: 'edit', resource: '*', effect: 'ask' },
        { action: 'edit', resource: '/*', effect: 'deny' },
        { action: 'read', resource: '/*', effect: 'deny' },
        { action: 'external_directory', resource: '*', effect: 'deny' }
      ]
    });
    // MarksCode's own evaluation (core/src/permission.ts): last matching wildcard rule wins.
    const match = (input: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's').test(input);
    const evaluate = (action: string, resource: string) => call!.body.permissions.findLast((rule: any) => match(action, rule.action) && match(resource, rule.resource))?.effect ?? 'ask';
    expect(evaluate('edit', 'src/sum.ts')).toBe('ask');
    expect(evaluate('edit', '/etc/passwd')).toBe('deny');
    expect(evaluate('read', '/home/user/.ssh/id_rsa')).toBe('deny');
    expect(evaluate('external_directory', '/tmp/*')).toBe('deny');
    expect(evaluate('shell', 'rm -rf build')).toBe('ask');
    expect(view).toMatchObject({ engine: 'markscode', model: 'anthropic/sonnet-5', running: false, approval: 'ask', pending: null });
    expect(view.conversationId.startsWith('cosapi-')).toBe(true);
    expect(await ledger.storedChatRecord(view.sessionId)).toEqual({ engine: 'markscode', backendSessionId: 'ses_1', model: 'anthropic/sonnet-5', effort: null });
    expect((await store.getSession(view.sessionId))?.projectId).toBe(PROJECT);
    expect(engine.marksCodeEngine.terminal!({ sessionId: view.sessionId, conversationId: view.conversationId, backendSessionId: 'ses_1', cwd: directory }))
      .toEqual({ argv: ['markscode', '-s', 'ses_1', '.'], mode: 'live' });
    // Models: the service's enabled models, its default first; effort becomes a variant only where one exists.
    const models = await engine.marksCodeEngine.models({});
    expect(models.models.map(item => item.id)).toEqual(['anthropic/sonnet-5', 'openai/gpt-6']);
    await engine.marksCodeEngine.setChatSettings(view.sessionId, { model: 'openai/gpt-6', effort: 'high', approval: 'auto' });
    expect(fake.calls('POST', '/api/session/ses_1/model').at(-1)!.body).toEqual({ model: { providerID: 'openai', id: 'gpt-6', variant: 'high' } });
    expect(fake.calls('PATCH', '/api/session/ses_1').at(-1)!.body.permissions.slice(0, 2).map((rule: any) => rule.effect)).toEqual(['allow', 'allow']);
    expect(fake.calls('PATCH', '/api/session/ses_1').at(-1)!.body.permissions.at(-1)).toEqual({ action: 'external_directory', resource: '*', effect: 'deny' });
  });

  it('streams a full turn: answer text, a shell row and an edit row with its diff', async () => {
    const view = await create();
    fake.onPrompt = sessionID => {
      const m = 'msg_a1';
      fake.emit('session.execution.started', { sessionID });
      fake.emit('session.text.started', { sessionID, assistantMessageID: m, ordinal: 0 });
      fake.emit('session.text.delta', { sessionID, assistantMessageID: m, ordinal: 0, delta: "I'll run " });
      fake.emit('session.text.delta', { sessionID, assistantMessageID: m, ordinal: 0, delta: 'the tests.' });
      fake.emit('session.text.ended', { sessionID, assistantMessageID: m, ordinal: 0, text: "I'll run the tests." });
      fake.emit('session.tool.input.started', { sessionID, assistantMessageID: m, id: 'call_1', name: 'shell' });
      fake.emit('session.tool.called', { sessionID, assistantMessageID: m, id: 'call_1', input: { command: 'npm test' }, executed: true });
      fake.emit('session.tool.success', { sessionID, assistantMessageID: m, id: 'call_1', content: [{ type: 'text', text: 'ok 3 tests' }], metadata: { exit: 0, truncated: false }, executed: true });
      fake.emit('session.tool.input.started', { sessionID, assistantMessageID: m, id: 'call_2', name: 'edit' });
      fake.emit('session.tool.called', { sessionID, assistantMessageID: m, id: 'call_2', input: { path: 'src/sum.ts', oldString: 'a - b', newString: 'a + b' }, executed: true });
      fake.emit('session.tool.success', { sessionID, assistantMessageID: m, id: 'call_2', content: [{ type: 'text', text: 'Edited src/sum.ts' }],
        metadata: { files: [{ file: 'src/sum.ts', patch: '--- a/src/sum.ts\n+++ b/src/sum.ts\n-  return a - b\n+  return a + b\n', additions: 1, deletions: 1, status: 'modified' }] }, executed: true });
      fake.emit('session.text.delta', { sessionID, assistantMessageID: m, ordinal: 1, delta: 'Fixed the sign.' });
      fake.emit('session.text.ended', { sessionID, assistantMessageID: m, ordinal: 1, text: 'Fixed the sign.' });
      fake.emit('session.usage.updated', { sessionID, cost: 0, tokens: { input: 1200, output: 80, reasoning: 10, cache: { read: 900, write: 0 } } });
      fake.finish(sessionID, 'succeeded');
    };
    const { turnId } = await engine.marksCodeEngine.send(view.sessionId, 'Fix the bug');
    expect(fake.calls('POST', '/api/session/ses_1/prompt')[0]!.body).toEqual({ text: 'Fix the bug' });
    await engine.marksCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId))).toEqual([
      'user Fix the bug', 'turn_start', "assistant final I'll run the tests.",
      'tool exec_command ok Ran npm test', 'tool apply_patch ok Edited sum.ts [+1 −1]',
      'assistant final Fixed the sign.', 'turn_end completed'
    ]);
    const patch = (await events(view.sessionId)).find(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch');
    expect(patch?.kind === 'tool_call' && patch.call).toMatchObject({ engine: 'markscode', attribution: 'engine', changes: [{ path: 'src/sum.ts', added: 1, removed: 1 }] });
    expect((await events(view.sessionId)).filter(event => event.kind === 'tool_call').every(event => event.turnId === turnId)).toBe(true);
    expect((await ledger.storedChatRecord(view.sessionId))?.openTurn).toBeUndefined();
    expect((await engine.marksCodeEngine.view(view.sessionId)).running).toBe(false);
  });

  it('turns permission.asked into cards and answers the exact request: once, always, reject; stale and changed requests are refused', async () => {
    const view = await create();
    const sessionID = 'ses_1';
    const ask = (id: string, command: string, tool: string) => fake.ask({ id, sessionID, action: 'shell', resources: [command], source: { type: 'tool', messageID: 'msg_a', id: tool } });
    fake.onPrompt = () => { fake.emit('session.execution.started', { sessionID }); ask('per_1', 'npm run build', 'call_1'); };
    await engine.marksCodeEngine.send(view.sessionId, 'Build it');
    const pending = async () => (await engine.marksCodeEngine.view(view.sessionId)).pending;
    await until(async () => !!(await pending()));
    const first = (await pending())!;
    expect(first).toMatchObject({ tool: 'shell', summary: 'npm run build', toolCallId: 'call_1' });
    expect(JSON.stringify(first)).not.toContain('per_1');
    await engine.marksCodeEngine.approve(view.sessionId, first.approvalId, 'approve');
    expect(fake.calls('POST', '/api/session/ses_1/permission/per_1/reply')[0]!.body).toEqual({ decision: 'once' });
    // The answered id is stale now.
    await expect(engine.marksCodeEngine.approve(view.sessionId, first.approvalId, 'approve')).rejects.toThrow('no longer pending');

    ask('per_2', 'npm test', 'call_2');
    await until(async () => (await pending())?.toolCallId === 'call_2');
    await engine.marksCodeEngine.approve(view.sessionId, (await pending())!.approvalId, 'always');
    expect(fake.calls('POST', '/api/session/ses_1/permission/per_2/reply')[0]!.body).toEqual({ decision: 'always' });

    // The request changed in MarksCode after it was shown: approving is refused, nothing is sent.
    ask('per_3', 'ls', 'call_3');
    await until(async () => (await pending())?.toolCallId === 'call_3');
    fake.pending.get(sessionID)![0]!.resources = ['rm -rf /'];
    await expect(engine.marksCodeEngine.approve(view.sessionId, (await pending())!.approvalId, 'approve')).rejects.toThrow('changed after it was shown');
    expect(fake.calls('POST', '/api/session/ses_1/permission/per_3/reply')).toHaveLength(0);
    // Deny is still answered, as reject, to that exact request.
    await engine.marksCodeEngine.approve(view.sessionId, (await pending())!.approvalId, 'deny');
    expect(fake.calls('POST', '/api/session/ses_1/permission/per_3/reply')[0]!.body).toMatchObject({ decision: 'reject' });
    fake.emit('session.tool.input.started', { sessionID, assistantMessageID: 'msg_a', id: 'call_3', name: 'shell' });
    fake.emit('session.tool.called', { sessionID, assistantMessageID: 'msg_a', id: 'call_3', input: { command: 'rm -rf /' }, executed: false });
    fake.emit('session.tool.failed', { sessionID, assistantMessageID: 'msg_a', id: 'call_3', error: { type: 'permission', message: 'The user rejected permission' }, executed: false });
    fake.finish(sessionID, 'succeeded');
    await engine.marksCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId))).toContain('tool exec_command tool_rejected Declined: Ran rm -rf / [declined]');
  });

  it('removes the card when the TUI answered the request (permission.replied it did not send)', async () => {
    const view = await create();
    const sessionID = 'ses_1';
    fake.onPrompt = () => fake.ask({ id: 'per_9', sessionID, action: 'edit', resources: ['src/a.ts'] });
    await engine.marksCodeEngine.send(view.sessionId, 'Edit a');
    await until(async () => !!(await engine.marksCodeEngine.view(view.sessionId)).pending);
    expect((await engine.marksCodeEngine.view(view.sessionId)).pending).toMatchObject({ tool: 'edit', summary: 'Edit src/a.ts', files: ['src/a.ts'] });
    fake.pending.set(sessionID, []);
    fake.emit('permission.replied', { sessionID, requestID: 'per_9', reply: 'once' });
    await until(async () => !(await engine.marksCodeEngine.view(view.sessionId)).pending);
    expect(fake.requests.some(item => item.path.endsWith('/reply'))).toBe(false);
    fake.finish(sessionID, 'succeeded');
    await engine.marksCodeTurnDone(view.sessionId);
  });

  it('interrupts on Stop and ends the turn stopped', async () => {
    const view = await create();
    fake.onPrompt = sessionID => {
      fake.emit('session.execution.started', { sessionID });
      fake.emit('session.text.delta', { sessionID, assistantMessageID: 'msg_s', ordinal: 0, delta: 'Working on it' });
    };
    await engine.marksCodeEngine.send(view.sessionId, 'Long task');
    await until(() => fake.active.has('ses_1') && fake.requests.some(item => item.path.endsWith('/prompt')));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await engine.marksCodeEngine.stop(view.sessionId)).toBe(true);
    expect(fake.calls('POST', '/api/session/ses_1/interrupt')).toHaveLength(1);
    await engine.marksCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId)).slice(-2)).toEqual(['assistant final Working on it', 'turn_end stopped']);
    expect(await engine.marksCodeEngine.stop(view.sessionId)).toBe(false);
  });

  it('reconnects after the event stream drops and reconciles messages and pending permissions', async () => {
    const view = await create();
    const sessionID = 'ses_1';
    fake.onPrompt = () => {
      fake.emit('session.execution.started', { sessionID });
      fake.emit('session.text.delta', { sessionID, assistantMessageID: 'msg_r', ordinal: 0, delta: 'Let me ' });
      setTimeout(() => {
        // While disconnected: the text and a tool finish, and a permission is asked.
        fake.drop();
        fake.messages.get(sessionID)!.push({ id: 'msg_r', type: 'assistant', time: { created: Date.now() }, content: [
          { type: 'text', text: 'Let me check the files.' },
          { type: 'tool', id: 'call_r1', name: 'read', state: { status: 'completed', input: { path: 'src/main.ts' }, content: [{ type: 'text', text: '1: export {}' }] }, time: { created: Date.now() } },
          { type: 'tool', id: 'call_r2', name: 'shell', state: { status: 'running', input: { command: 'make' }, metadata: {} }, time: { created: Date.now() } }
        ] });
        fake.pending.set(sessionID, [{ id: 'per_r', sessionID, action: 'shell', resources: ['make'], source: { type: 'tool', messageID: 'msg_r', id: 'call_r2' } }]);
      }, 30);
    };
    await engine.marksCodeEngine.send(view.sessionId, 'Check');
    await until(async () => (await engine.marksCodeEngine.view(view.sessionId)).pending?.toolCallId === 'call_r2');
    expect(fake.calls('GET', '/api/event').length).toBeGreaterThanOrEqual(2);
    expect(fake.calls('GET', '/api/session/ses_1/permission').length).toBeGreaterThanOrEqual(1);
    await engine.marksCodeEngine.approve(view.sessionId, (await engine.marksCodeEngine.view(view.sessionId)).pending!.approvalId, 'approve');
    fake.emit('session.tool.success', { sessionID, assistantMessageID: 'msg_r', id: 'call_r2', content: [{ type: 'text', text: 'built' }], metadata: { exit: 0 }, executed: true });
    fake.emit('session.text.ended', { sessionID, assistantMessageID: 'msg_r', ordinal: 1, text: 'Done.' });
    fake.finish(sessionID, 'succeeded');
    await engine.marksCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId))).toEqual([
      'user Check', 'turn_start', 'assistant final Let me check the files.', 'tool read ok Read main.ts', 'tool exec_command ok Ran make', 'assistant final Done.', 'turn_end completed'
    ]);
  });

  it('re-attaches after a restart to a session that still runs, instead of closing it interrupted', async () => {
    const view = await create();
    const sessionID = 'ses_1';
    // The previous process: the turn opened, the question was posted, some text streamed.
    const previous = new TurnProjector({ engine: 'markscode', conversationId: view.conversationId, turnId: 'api-prev', sink: storeProjectorSink(view.sessionId),
      approvals: { gate: new ApprovalGate(), answer: () => undefined }, streamWriteMs: 0 });
    await previous.start('Refactor');
    await previous.apply({ type: 'text_delta', delta: 'Refacto' });
    fake.messages.get(sessionID)!.push({ id: 'msg_u0', type: 'user', text: 'Refactor', time: { created: Date.now() } });
    fake.messages.get(sessionID)!.push({ id: 'msg_p', type: 'assistant', time: { created: Date.now() }, content: [
      { type: 'text', text: 'Refactoring now.' },
      { type: 'tool', id: 'call_p', name: 'shell', state: { status: 'completed', input: { command: 'git status' }, content: [{ type: 'text', text: 'clean' }], metadata: { exit: 0 } }, time: { created: Date.now() } }
    ] });
    fake.active.add(sessionID);
    // Restart: no process memory, the ledger still has the open turn.
    engine.resetMarksCodeEngineForTests();
    executor.resetApiChatExecutorForTests();
    store.resetSessionStoreForTests();
    // The engine-neutral recovery leaves MarksCode's open turn to its own recovery.
    await executor.recoverApiChats();
    expect((await ledger.storedChatRecord(view.sessionId))?.openTurn?.turnId).toBe('api-prev');
    await registry.recoverAgentEngines();
    expect((await engine.marksCodeEngine.view(view.sessionId)).running).toBe(true);
    await until(() => (fake.calls('GET', '/api/session/ses_1/message').length > 0));
    await until(async () => outline(await events(view.sessionId)).includes('tool exec_command ok Ran git status'));
    fake.emit('session.text.ended', { sessionID, assistantMessageID: 'msg_p', ordinal: 1, text: 'All done.' });
    fake.finish(sessionID, 'succeeded');
    await engine.marksCodeTurnDone(view.sessionId);
    expect(outline(await events(view.sessionId))).toEqual([
      'user Refactor', 'turn_start', 'assistant final Refactoring now.', 'tool exec_command ok Ran git status', 'assistant final All done.', 'turn_end completed'
    ]);
    expect((await ledger.storedChatRecord(view.sessionId))?.openTurn).toBeUndefined();
  });

  it('closes a restarted turn interrupted only when the session no longer runs', async () => {
    const view = await create();
    const previous = new TurnProjector({ engine: 'markscode', conversationId: view.conversationId, turnId: 'api-gone', sink: storeProjectorSink(view.sessionId),
      approvals: { gate: new ApprovalGate(), answer: () => undefined } });
    await previous.start('Gone');
    engine.resetMarksCodeEngineForTests();
    store.resetSessionStoreForTests();
    await engine.recoverMarksCodeChats();
    expect(outline(await events(view.sessionId)).at(-1)).toBe('turn_end interrupted');
    expect((await ledger.storedChatRecord(view.sessionId))?.openTurn).toBeUndefined();
    expect(fake.calls('GET', '/api/event')).toHaveLength(0);
  });

  it('sends the Basic auth header on every request and never logs the password or the header', async () => {
    const view = await create();
    fake.onPrompt = sessionID => fake.finish(sessionID, 'succeeded');
    await engine.marksCodeEngine.send(view.sessionId, 'Hello');
    await engine.marksCodeTurnDone(view.sessionId);
    expect(fake.requests.length).toBeGreaterThan(4);
    expect(fake.requests.every(item => item.auth === `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`)).toBe(true);
    const logged = JSON.stringify(getLog());
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(Buffer.from(`opencode:${PASSWORD}`).toString('base64'));
    // An error names the method, path and status, never the credentials.
    registration = JSON.stringify({ url: fake.url, pid: 4242, password: 'wrong-password' });
    const failure = await engine.marksCodeEngine.models({}).catch((error: Error) => error);
    expect(String((failure as Error).message)).toBe('The MarksCode service refused its saved password');
  });
});

describe('MarksCode SSE parsing', () => {
  it('joins data lines, skips comments, handles split chunks and CRLF, and drops oversized records', () => {
    const dropped = vi.fn();
    const parser = new SseParser(dropped);
    expect(parser.push(': heartbeat\n\ndata: {"a"')).toEqual([]);
    expect(parser.push(':1}\r\n\r\ndata: x\ndata: y\n\n')).toEqual(['{"a":1}', 'x\ny']);
    expect(parser.push(`data: ${'z'.repeat(1024 * 1024 + 10)}\n\ndata: ok\n\n`)).toEqual(['ok']);
    expect(dropped).toHaveBeenCalledTimes(1);
  });
});
