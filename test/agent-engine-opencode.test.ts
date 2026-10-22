import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
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
const { OpenCodeClient, SseParser, basicAuth } = await import('../src/main/agent-engine/opencode-client.js');
const server = await import('../src/main/opencode/server.js');
const registry = await import('../src/main/agent-engine/registry.js');
const { getLog } = await import('../src/main/logger.js');
import type { SessionEvent } from '../src/shared/session.js';

const PASSWORD = 'pw-secret-do-not-log-7c1e';
const PROJECT = '00000000-0000-4000-8000-0000000000ab';

interface Recorded { method: string; path: string; query: URLSearchParams; body: any; auth: string | undefined }
interface Permission { id: string; sessionID: string; permission: string; patterns: string[]; metadata?: Record<string, unknown>; always?: string[]; tool?: { messageID: string; callID: string } }

/** An OpenCode 1.19.3 server in miniature: the routes and `/global/event` shapes the engine uses, as the real one sends them. */
class FakeOpenCode {
  server!: http.Server;
  url = '';
  requests: Recorded[] = [];
  streams = new Set<http.ServerResponse>();
  busy = new Set<string>();
  pending: Permission[] = [];
  messages = new Map<string, any[]>();
  sessions = new Map<string, { id: string; permission: any[] }>();
  onPrompt: (sessionId: string, body: any) => void = () => undefined;
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

  emit(type: string, properties: Record<string, unknown>, directory = 'dir'): void {
    const frame = `data: ${JSON.stringify({ directory, project: 'global', payload: { id: `evt_${++this.next}`, type, properties } })}\n\n`;
    for (const stream of this.streams) stream.write(frame);
  }

  drop(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }

  calls(method: string, route: string): Recorded[] { return this.requests.filter(item => item.method === method && item.path === route); }

  /** One assistant message of the turn whose question is `user`. */
  message(sessionID: string, info: Record<string, unknown>, parts: any[] = []): void {
    this.messages.get(sessionID)!.push({ info: { sessionID, ...info }, parts });
    this.emit('message.updated', { sessionID, info: { sessionID, ...info } });
  }

  part(sessionID: string, part: Record<string, unknown>): void {
    const list = this.messages.get(sessionID)!;
    const message = list.find(item => item.info.id === part.messageID);
    if (message) {
      const index = message.parts.findIndex((item: any) => item.id === part.id);
      if (index >= 0) message.parts[index] = part; else message.parts.push(part);
    }
    this.emit('message.part.updated', { sessionID, part: { sessionID, ...part }, time: Date.now() });
  }

  status(sessionID: string, type: 'busy' | 'idle'): void {
    if (type === 'busy') this.busy.add(sessionID); else this.busy.delete(sessionID);
    this.emit('session.status', { sessionID, status: { type } });
    if (type === 'idle') this.emit('session.idle', { sessionID });
  }

  ask(permission: Permission): void {
    this.pending.push(permission);
    this.emit('permission.asked', { ...permission });
  }

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
    if (url.pathname === '/global/health') return json(200, { healthy: true, version: '1.19.3' });
    if (url.pathname === '/global/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ payload: { id: 'evt_c', type: 'server.connected', properties: {} } })}\n\n`);
      this.streams.add(response);
      response.on('close', () => this.streams.delete(response));
      return;
    }
    if (url.pathname === '/config/providers') return json(200, {
      providers: [
        { id: 'opencode', name: 'OpenCode', models: {
          'big-pickle': { id: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', status: 'active', variants: {} },
          'glm-free': { id: 'glm-free', providerID: 'opencode', name: 'GLM Free', status: 'active', variants: { low: {}, high: {}, max: {} } }
        } },
        { id: 'old', name: 'Old', models: { gone: { id: 'gone', providerID: 'old', name: 'Gone', status: 'deprecated' } } }
      ],
      default: { opencode: 'big-pickle' }
    });
    if (url.pathname === '/session' && request.method === 'POST') {
      const id = `ses_${String(this.sessions.size + 1).padStart(4, '0')}AbC`;
      this.sessions.set(id, { id, permission: body.permission });
      this.messages.set(id, []);
      return json(200, { id, slug: 'happy-cabin', directory: url.searchParams.get('directory'), title: body.title, permission: body.permission, version: '1.19.3' });
    }
    if (url.pathname === '/session/status') return json(200, Object.fromEntries([...this.busy].map(id => [id, { type: 'busy' }])));
    if (url.pathname === '/permission') return json(200, this.pending);
    if (parts[0] === 'permission' && parts[2] === 'reply') {
      const found = this.pending.find(item => item.id === parts[1]);
      if (!found) return json(404, { name: 'NotFoundError', data: { message: 'Permission not found' } });
      // Upstream: reject rejects every pending request of that session.
      this.pending = this.pending.filter(item => body.reply === 'reject' ? item.sessionID !== found.sessionID : item !== found);
      json(200, true);
      this.emit('permission.replied', { sessionID: found.sessionID, requestID: found.id, reply: body.reply });
      return;
    }
    const session = parts[0] === 'session' && parts[1] ? this.sessions.get(parts[1]) : undefined;
    if (!session) return json(404, { name: 'NotFoundError', data: { message: 'Session not found' } });
    const sub = parts[2];
    if (!sub && request.method === 'PATCH') { session.permission.push(...body.permission); return json(200, { ...session }); }
    if (sub === 'message') {
      const limit = Number(url.searchParams.get('limit') ?? '100');
      return json(200, this.messages.get(session.id)!.slice(-limit));
    }
    if (sub === 'prompt_async') {
      const id = `msg_u${++this.next}`;
      response.writeHead(204);
      response.end();
      this.message(session.id, { id, role: 'user', time: { created: Date.now() } }, [{ id: `prt_u${this.next}`, type: 'text', text: body.parts[0].text, messageID: id }]);
      this.part(session.id, { id: `prt_u${this.next}`, type: 'text', text: body.parts[0].text, messageID: id });
      this.status(session.id, 'busy');
      setTimeout(() => this.onPrompt(session.id, { ...body, userID: id }), 5);
      return;
    }
    if (sub === 'abort') {
      json(200, true);
      if (this.busy.has(session.id)) setTimeout(() => {
        this.emit('session.error', { sessionID: session.id, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
        this.status(session.id, 'idle');
      }, 5);
      return;
    }
    json(404, { message: 'Not found' });
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
    case 'tool_call': return [`tool ${event.call.tool} ${event.call.outcome} ${event.call.summary.title}`];
    case 'chat_error': return [`error ${event.message.text}`];
    case 'turn_start': return ['turn_start'];
    case 'turn_end': return [`turn_end ${event.outcome}`];
    default: return [];
  }
});

describe('OpenCode agent engine (fake 1.19 server)', () => {
  let directory = '';
  const fake = new FakeOpenCode();
  let module = { enabled: true, command: true, binary: '/home/u/.config/chat-marks/modules/opencode/bin/opencode' as string | null, managed: true };
  let version: string | null = '1.19.3';
  let generation = 1;
  let exit: ((generation: number, reason: string) => void) | null = null;
  const openTerminal = vi.fn(async (_chat: { sessionId: string; projectId: string; args: string[]; title: string }) => ({ id: 'cli-opencode-1' }));
  const refreshTerminal = vi.fn(async (_chat: string, _since: number) => undefined);
  let terminalCheck: ((chat: string | undefined) => Promise<void>) | null = null;
  const settled = vi.fn();
  const startedAt = 1_700_000_000_000;

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
    resetRecorderForTests();
    store.resetSessionStoreForTests();
    await writeDurableNow(ledger.API_CHAT_SESSIONS_STATE, {});
    fake.requests.length = 0;
    fake.busy.clear();
    fake.pending = [];
    fake.sessions.clear();
    fake.messages.clear();
    fake.onPrompt = () => undefined;
    module = { enabled: true, command: true, binary: '/home/u/.config/chat-marks/modules/opencode/bin/opencode', managed: true };
    version = '1.19.3';
    generation = 1;
    exit = null;
    openTerminal.mockClear();
    refreshTerminal.mockClear();
    settled.mockClear();
    terminalCheck = null;
    const ref = () => ({ client: new OpenCodeClient({ url: fake.url, password: PASSWORD }), generation, startedAt, version: '1.19.3' });
    engine.setOpenCodeDepsForTests({
      moduleState: async () => ({ ...module }),
      version: async () => version,
      modelsDirectory: async () => '/home/u',
      projectFolder: async projectId => {
        if (projectId !== PROJECT) throw new Error('Project not found');
        return directory;
      },
      server: async () => ref(),
      runningServer: () => ref(),
      bindServer: options => { exit = options.onExit; },
      turnsSettled: settled,
      openTerminal,
      onTerminalOpen: check => { terminalCheck = check; },
      refreshTerminal,
      reconnectDelaysMs: [20, 40, 80],
      stopGraceMs: 300
    });
  });
  afterEach(() => { engine.resetOpenCodeEngineForTests(); fake.drop(); });
  afterAll(async () => {
    engine.setOpenCodeDepsForTests(null);
    engine.resetOpenCodeEngineForTests();
    await fake.stop();
    await flushDurable();
    resetRecorderForTests();
    store.resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(directory);
  });

  const create = () => engine.openCodeEngine.create({ projectId: PROJECT });
  const events = (sessionId: string) => store.readEvents(sessionId);
  const done = async (sessionId: string): Promise<void> => {
    await until(async () => (await events(sessionId)).some(event => event.kind === 'turn_end'));
  };
  /** The assistant message answering the prompt (`parentID` = the user message). */
  const assistant = (sessionID: string, userID: string, id = 'msg_a1') => fake.message(sessionID, { id, role: 'assistant', parentID: userID, time: { created: Date.now() } });

  it('is available from its module, binary and version gate, without a running server', async () => {
    expect(await engine.openCodeStatus()).toEqual({ available: true, detail: 'OpenCode 1.19.3' });
    module = { ...module, managed: false };
    version = '1.20.0';
    expect(await engine.openCodeStatus()).toEqual({ available: true, detail: 'OpenCode 1.20.0 (newer than tested, not installed by Chat Marks)' });
    version = '2.0.0';
    expect((await engine.openCodeStatus()).available).toBe(false);
    version = '1.18.2';
    expect((await engine.openCodeStatus()).detail).toContain('not supported');
    version = null;
    expect((await engine.openCodeStatus()).available).toBe(false);
    module = { ...module, binary: null };
    expect(await engine.openCodeStatus()).toEqual({ available: false, detail: 'Install OpenCode in Settings > Modules' });
    module = { ...module, enabled: false };
    expect((await engine.openCodeStatus()).detail).toBe('Enable the OpenCode module in Settings > Modules');
    module = { ...module, command: false };
    expect((await engine.openCodeStatus()).detail).toBe('Command execution is disabled');
    expect(fake.requests).toEqual([]);
  });

  it('creates the session in the project folder with its ruleset, sends `directory` on every instance request, and lists models', async () => {
    await expect(engine.openCodeEngine.create({ projectId: null })).rejects.toThrow('Choose a project for an OpenCode chat first');
    const view = await create();
    const [call] = fake.calls('POST', '/session');
    expect(call!.query.get('directory')).toBe(directory);
    expect(call!.body).toEqual({ title: 'Chat Marks', permission: [
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '.markscode/*', action: 'deny' },
      { permission: 'edit', pattern: '*/.markscode/*', action: 'deny' }
    ] });
    // OpenCode's own evaluation (util/wildcard.ts): the last matching rule wins and `*` also matches `/`.
    const match = (input: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's').test(input);
    const evaluate = (permission: string, target: string) => call!.body.permission.findLast((rule: any) => match(permission, rule.permission) && match(target, rule.pattern))?.action;
    expect(evaluate('edit', 'src/sum.ts')).toBe('ask');
    expect(evaluate('edit', '.markscode/memories.json')).toBe('deny');
    expect(evaluate('edit', 'home/u/project/.markscode/memories.json')).toBe('deny');
    expect(evaluate('question', 'x')).toBe('deny');
    expect(view).toMatchObject({ engine: 'opencode', model: 'opencode/big-pickle', running: false, approval: 'ask', pending: null });
    expect(await ledger.storedChatRecord(view.sessionId)).toEqual({ engine: 'opencode', backendSessionId: 'ses_0001AbC', model: 'opencode/big-pickle', effort: null });
    expect(engine.openCodeEngine.terminal!({ sessionId: view.sessionId, conversationId: view.conversationId, backendSessionId: 'ses_0001AbC', cwd: directory }))
      .toEqual({ argv: ['--dir', directory, '-s', 'ses_0001AbC'], mode: 'live' });
    expect(engine.openCodeEngine.terminal!({ sessionId: view.sessionId, conversationId: view.conversationId, backendSessionId: '-rf', cwd: directory })).toBeNull();
    const models = await engine.openCodeEngine.models({});
    expect(models.models.map(item => [item.id, item.label, item.efforts ?? null])).toEqual([
      ['opencode/big-pickle', 'Big Pickle', null], ['opencode/glm-free', 'GLM Free', ['low', 'high', 'max']]
    ]);
    // Auto appends the chat's rules (OpenCode's PATCH concatenates), deny rules last.
    await engine.openCodeEngine.setChatSettings(view.sessionId, { approval: 'auto', model: 'opencode/glm-free', effort: 'high' });
    const patch = fake.calls('PATCH', '/session/ses_0001AbC').at(-1)!;
    expect(patch.query.get('directory')).toBe(directory);
    expect(patch.body.permission.map((rule: any) => `${rule.permission}:${rule.action}`)).toEqual([
      'bash:allow', 'edit:allow', 'question:deny', 'external_directory:deny', 'edit:deny', 'edit:deny']);
    for (const request of fake.requests.filter(item => !item.path.startsWith('/global') && item.path !== '/config/providers')) expect(request.query.get('directory'), request.path).toBe(directory);
  });

  it('streams a turn: deltas and the final text, bash and edit rows, usage, and idle ends it', async () => {
    const view = await create();
    await engine.openCodeEngine.setChatSettings(view.sessionId, { model: 'opencode/glm-free', effort: 'high' });
    fake.onPrompt = (sessionID, body) => {
      assistant(sessionID, body.userID);
      fake.part(sessionID, { id: 'prt_t1', type: 'text', text: '', messageID: 'msg_a1', time: { start: 1 } });
      fake.emit('message.part.delta', { sessionID, messageID: 'msg_a1', partID: 'prt_t1', field: 'text', delta: 'Running ' });
      fake.emit('message.part.delta', { sessionID, messageID: 'msg_a1', partID: 'prt_t1', field: 'text', delta: 'the tests.' });
      fake.part(sessionID, { id: 'prt_t1', type: 'text', text: 'Running the tests.', messageID: 'msg_a1', time: { start: 1, end: 2 } });
      fake.part(sessionID, { id: 'prt_r1', type: 'reasoning', text: '', messageID: 'msg_a1' });
      fake.emit('message.part.delta', { sessionID, messageID: 'msg_a1', partID: 'prt_r1', field: 'text', delta: 'secret thoughts' });
      fake.part(sessionID, { id: 'prt_b', type: 'tool', tool: 'bash', callID: 'call_b', messageID: 'msg_a1', state: { status: 'pending', input: {}, raw: '' } });
      fake.part(sessionID, { id: 'prt_b', type: 'tool', tool: 'bash', callID: 'call_b', messageID: 'msg_a1', state: { status: 'running', input: { command: 'npm test' }, time: { start: 1 } } });
      fake.part(sessionID, { id: 'prt_b', type: 'tool', tool: 'bash', callID: 'call_b', messageID: 'msg_a1', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok\n', metadata: { output: 'ok\n', exit: 0 }, title: 'npm test' } });
      const diff = 'Index: src/a.ts\n===\n--- src/a.ts\n+++ src/a.ts\n@@ -1,1 +1,1 @@\n-alpha\n+beta\n';
      fake.part(sessionID, { id: 'prt_e', type: 'tool', tool: 'edit', callID: 'call_e', messageID: 'msg_a1', state: { status: 'running', input: { filePath: `${directory}/src/a.ts`, oldString: 'alpha', newString: 'beta' } } });
      fake.part(sessionID, { id: 'prt_e', type: 'tool', tool: 'edit', callID: 'call_e', messageID: 'msg_a1', state: { status: 'completed', input: { filePath: `${directory}/src/a.ts` }, output: '',
        metadata: { diff, filediff: { file: `${directory}/src/a.ts`, patch: diff, additions: 1, deletions: 1 } } } });
      fake.part(sessionID, { id: 'prt_s1', type: 'step-finish', reason: 'tool-calls', messageID: 'msg_a1', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 0 } } });
      assistant(sessionID, body.userID, 'msg_a2');
      fake.part(sessionID, { id: 'prt_t2', type: 'text', text: 'All green.', messageID: 'msg_a2', time: { start: 3, end: 4 } });
      fake.part(sessionID, { id: 'prt_s2', type: 'step-finish', reason: 'stop', messageID: 'msg_a2', tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 120, write: 0 } } });
      fake.status(sessionID, 'idle');
    };
    const sent = await engine.openCodeEngine.send(view.sessionId, 'Run the tests');
    expect(sent.turnId).toMatch(/^api-/);
    const prompt = fake.calls('POST', '/session/ses_0001AbC/prompt_async')[0]!;
    expect(prompt.query.get('directory')).toBe(directory);
    expect(prompt.body).toEqual({ parts: [{ type: 'text', text: 'Run the tests' }], model: { providerID: 'opencode', modelID: 'glm-free' }, variant: 'high' });
    await done(view.sessionId);
    const rows = outline(await events(view.sessionId));
    expect(rows).toEqual([
      'user Run the tests', 'turn_start', 'assistant final Running the tests.',
      expect.stringMatching(/^tool exec_command ok .*npm test/), expect.stringMatching(/^tool apply_patch ok .*a\.ts/),
      'assistant final All green.', 'turn_end completed'
    ]);
    expect(rows.join('\n')).not.toContain('secret thoughts');
    const edit = (await events(view.sessionId)).find(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch');
    expect(edit?.kind === 'tool_call' && edit.call.changes?.[0]).toMatchObject({ added: 1, removed: 1 });
    expect(settled).toHaveBeenCalled();
    expect((await engine.openCodeEngine.view(view.sessionId)).running).toBe(false);
  });

  it('answers approvals once, rejects on deny, turns "always" into once + Auto, refuses stale or changed requests, and drops a TUI-answered card', async () => {
    const view = await create();
    let user = '';
    fake.onPrompt = (sessionID, body) => {
      user = body.userID;
      assistant(sessionID, user);
      fake.part(sessionID, { id: 'prt_b', type: 'tool', tool: 'bash', callID: 'call_b', messageID: 'msg_a1', state: { status: 'running', input: { command: 'rm -rf build' } } });
      fake.ask({ id: 'per_1', sessionID, permission: 'bash', patterns: ['rm -rf build'], metadata: { command: 'rm -rf build' }, always: ['rm *'], tool: { messageID: 'msg_a1', callID: 'call_b' } });
    };
    await engine.openCodeEngine.send(view.sessionId, 'Clean');
    await until(async () => !!(await engine.openCodeEngine.view(view.sessionId)).pending);
    const pending = (await engine.openCodeEngine.view(view.sessionId)).pending!;
    expect(pending).toMatchObject({ tool: 'bash', summary: 'rm -rf build' });
    // Deny: `reject` with the reason; the tool's failure is shown as declined.
    await engine.openCodeEngine.approve(view.sessionId, pending.approvalId, 'deny');
    expect(fake.calls('POST', '/permission/per_1/reply')[0]!.body).toEqual({ reply: 'reject', message: 'The user declined this in Chat Marks.' });
    fake.part(view.sessionId ? 'ses_0001AbC' : '', { id: 'prt_b', type: 'tool', tool: 'bash', callID: 'call_b', messageID: 'msg_a1',
      state: { status: 'error', input: { command: 'rm -rf build' }, error: 'The user rejected permission to use this specific tool call with the following feedback: The user declined this in Chat Marks.' } });

    // Always: answered `once` upstream, then the chat's Auto rules are appended and the chat is Auto.
    fake.part('ses_0001AbC', { id: 'prt_w', type: 'tool', tool: 'write', callID: 'call_w', messageID: 'msg_a1', state: { status: 'running', input: { filePath: `${directory}/x.txt` } } });
    fake.ask({ id: 'per_2', sessionID: 'ses_0001AbC', permission: 'edit', patterns: ['x.txt'], metadata: { filepath: `${directory}/x.txt` }, tool: { messageID: 'msg_a1', callID: 'call_w' } });
    await until(async () => (await engine.openCodeEngine.view(view.sessionId)).pending?.tool === 'edit');
    const second = (await engine.openCodeEngine.view(view.sessionId)).pending!;
    expect(second.files).toEqual([`${directory}/x.txt`]);
    await engine.openCodeEngine.approve(view.sessionId, second.approvalId, 'always');
    expect(fake.calls('POST', '/permission/per_2/reply')[0]!.body).toEqual({ reply: 'once' });
    expect(fake.calls('PATCH', '/session/ses_0001AbC').at(-1)!.body.permission[0]).toEqual({ permission: 'bash', pattern: '*', action: 'allow' });
    expect((await engine.openCodeEngine.view(view.sessionId)).approval).toBe('auto');
    expect(fake.requests.some(request => request.body?.reply === 'always')).toBe(false);

    // A request that changed after it was shown is not approved; one that is gone is refused.
    fake.ask({ id: 'per_3', sessionID: 'ses_0001AbC', permission: 'bash', patterns: ['ls'], tool: { messageID: 'msg_a1', callID: 'call_c' } });
    await until(async () => (await engine.openCodeEngine.view(view.sessionId)).pending?.summary === 'ls');
    const third = (await engine.openCodeEngine.view(view.sessionId)).pending!;
    fake.pending[0]!.patterns = ['ls; curl evil'];
    await expect(engine.openCodeEngine.approve(view.sessionId, third.approvalId, 'approve')).rejects.toThrow('changed after it was shown');
    fake.pending = [];
    await expect(engine.openCodeEngine.approve(view.sessionId, third.approvalId, 'approve')).rejects.toThrow('no longer pending');
    await until(async () => !(await engine.openCodeEngine.view(view.sessionId)).pending);

    // Answered in the attached TUI: the card goes, nothing is sent.
    fake.ask({ id: 'per_4', sessionID: 'ses_0001AbC', permission: 'bash', patterns: ['pwd'], tool: { messageID: 'msg_a1', callID: 'call_d' } });
    await until(async () => !!(await engine.openCodeEngine.view(view.sessionId)).pending);
    fake.pending = [];
    fake.emit('permission.replied', { sessionID: 'ses_0001AbC', requestID: 'per_4', reply: 'once' });
    await until(async () => !(await engine.openCodeEngine.view(view.sessionId)).pending);
    expect(fake.calls('POST', '/permission/per_4/reply')).toEqual([]);
    fake.status('ses_0001AbC', 'idle');
    await done(view.sessionId);
    const rows = outline(await events(view.sessionId));
    expect(rows).toContainEqual(expect.stringMatching(/^tool exec_command tool_rejected /));
    expect(rows.at(-1)).toBe('turn_end completed');
    expect(user).toMatch(/^msg_u/);
  });

  it('stops with abort (and clears the pending request), fails on session.error, and fails a turn whose server exits', async () => {
    const view = await create();
    fake.onPrompt = (sessionID, body) => {
      assistant(sessionID, body.userID);
      fake.ask({ id: 'per_9', sessionID, permission: 'bash', patterns: ['sleep 100'], tool: { messageID: 'msg_a1', callID: 'call_s' } });
    };
    await engine.openCodeEngine.send(view.sessionId, 'Wait');
    await until(async () => !!(await engine.openCodeEngine.view(view.sessionId)).pending);
    expect(await engine.openCodeEngine.stop(view.sessionId)).toBe(true);
    await done(view.sessionId);
    expect(fake.calls('POST', '/session/ses_0001AbC/abort')).toHaveLength(1);
    // The abort leaves the request pending upstream (real 1.19.3): the stop answers it `reject`.
    await until(() => fake.calls('POST', '/permission/per_9/reply').length === 1);
    expect(outline(await events(view.sessionId)).at(-1)).toBe('turn_end stopped');

    fake.onPrompt = (sessionID, body) => {
      assistant(sessionID, body.userID, 'msg_a3');
      fake.emit('session.error', { sessionID, error: { name: 'ProviderAuthError', data: { message: 'Missing API key' } } });
      fake.status(sessionID, 'idle');
    };
    await engine.openCodeEngine.send(view.sessionId, 'Again');
    await until(async () => outline(await events(view.sessionId)).filter(row => row.startsWith('turn_end')).length === 2);
    expect(outline(await events(view.sessionId)).slice(-2)).toEqual(['error OpenCode failed: Missing API key', 'turn_end failed']);

    fake.onPrompt = (sessionID, body) => { assistant(sessionID, body.userID, 'msg_a4'); };
    await engine.openCodeEngine.send(view.sessionId, 'Third');
    await until(() => exit !== null);
    exit!(1, 'The OpenCode server stopped (exit 1)');
    await until(async () => outline(await events(view.sessionId)).filter(row => row.startsWith('turn_end')).length === 3);
    expect(outline(await events(view.sessionId)).at(-1)).toBe('turn_end failed');
  });

  it('reconciles after the event stream drops: settled texts, finished tools and the idle end', async () => {
    const view = await create();
    let user = '';
    fake.onPrompt = (sessionID, body) => {
      user = body.userID;
      assistant(sessionID, user);
      fake.drop();
      // While disconnected: the answer settles and the run ends.
      fake.messages.get(sessionID)!.find(item => item.info.id === 'msg_a1')!.parts.push(
        { id: 'prt_t', type: 'text', text: 'Done while you were away.', messageID: 'msg_a1', time: { start: 1, end: 2 } },
        { id: 'prt_g', type: 'tool', tool: 'grep', callID: 'call_g', messageID: 'msg_a1', state: { status: 'completed', input: { pattern: 'x', path: directory }, output: 'a.ts' } });
      fake.busy.delete(sessionID);
    };
    await engine.openCodeEngine.send(view.sessionId, 'Look');
    await done(view.sessionId);
    const rows = outline(await events(view.sessionId));
    // Both imported in one reconcile (same instant): their relative order is the store's.
    expect([...rows.slice(0, 2), ...rows.slice(2, 4).sort(), rows[4]]).toEqual([
      'user Look', 'turn_start', 'assistant final Done while you were away.', expect.stringMatching(/^tool read ok /), 'turn_end completed'
    ]);
    expect(user).toMatch(/^msg_u/);
  });

  it('opens its live terminal with `--dir <cwd> -s <session>`; every attach starts the server and recreates an older terminal', async () => {
    const view = await create();
    expect(await engine.openCodeEngine.openTerminal!(view.sessionId)).toEqual({ cliSessionId: 'cli-opencode-1' });
    expect(openTerminal).toHaveBeenCalledWith({ sessionId: view.sessionId, projectId: PROJECT, args: ['--dir', directory, '-s', 'ses_0001AbC'], title: 'OpenCode · New OpenCode chat' });
    expect(terminalCheck).not.toBeNull();
    await terminalCheck!(view.sessionId);
    expect(refreshTerminal).toHaveBeenCalledWith(view.sessionId, startedAt);
    module = { ...module, enabled: false };
    await expect(terminalCheck!(view.sessionId)).rejects.toThrow('Enable the OpenCode module');
  });

  it('sends Basic auth on every request and never logs the password; a 401 is a readable error', async () => {
    const view = await create();
    expect(fake.requests.every(request => request.auth === basicAuth(PASSWORD))).toBe(true);
    const wrong = new OpenCodeClient({ url: fake.url, password: 'wrong' });
    await expect(wrong.health()).rejects.toThrow('refused the password');
    expect(JSON.stringify(getLog())).not.toContain(PASSWORD);
    expect(view.engine).toBe('opencode');
    const parser = new SseParser();
    expect(parser.push('data: {"payload":{"type":"a"}}\n\n: c\n\ndata: x')).toEqual(['{"payload":{"type":"a"}}']);
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

  it('keeps its chats readable, offers no new chat, runs nothing and claims no recovery', async () => {
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
    expect(recoversOwnTurns('opencode')).toBe(false);
  });
});

describe('the OpenCode server process', () => {
  const fixture = path.resolve('test/fixtures/agent-engine/fake-opencode.mjs');
  let dir = '';
  beforeAll(async () => { dir = await makeTempDir('cos-opencode-server-'); });
  afterEach(async () => { await server.stopOpenCodeServer('module'); server.resetOpenCodeServerForTests(); server.setOpenCodeServerHostForTests(null); });
  afterAll(async () => { await removeTempDir(dir); });

  const host = (extra: Partial<Parameters<typeof server.setOpenCodeServerHostForTests>[0] & object> = {}) => server.setOpenCodeServerHostForTests({
    runtime: async () => ({ binary: fixture, windows: false }),
    stateDir: async () => path.join(dir, 'state'),
    home: async () => dir,
    ...extra
  });

  it('starts `serve` with exact argv and an environment holding only its own password, no Electron node mode and no MarksCode path', async () => {
    if (process.platform === 'win32') return;
    const record = path.join(dir, 'record.json');
    const saved = { ...process.env };
    process.env.FAKE_OPENCODE_RECORD = record;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.OPENCODE_SERVER_USERNAME = 'someone';
    process.env.OPENCODE_SERVER_PASSWORD = 'inherited';
    process.env.MARKSCODE_HOME = '/home/u/.markscode';
    process.env.SOME_DIR = '/home/u/.local/share/markscode';
    process.env.PATH = `/home/u/.markscode/bin:${saved.PATH}`;
    try {
      host();
      const running = await server.ensureOpenCodeServer();
      expect(running).toMatchObject({ version: '1.19.3', generation: expect.any(Number) });
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const seen = JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; env: Record<string, string>; cwd: string };
      expect(seen.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0', '--no-mdns']);
      expect(seen.cwd).toBe(dir);
      expect(seen.env.OPENCODE_SERVER_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(seen.env.OPENCODE_SERVER_PASSWORD).toBe(running.password);
      expect(seen.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
      expect(seen.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(seen.env.OPENCODE_SERVER_USERNAME).toBeUndefined();
      for (const name of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'OPENCODE_DB', 'OPENCODE_CONFIG_DIR']) expect(seen.env[name]).toBe(saved[name]);
      // Nothing points OpenCode at MarksCode's data or binaries.
      expect(JSON.stringify([seen.args, seen.env]).toLowerCase()).not.toContain('markscode');
      // The registration file (URL, then password) is private; the pidfile names the child.
      const registration = path.join(dir, 'state', 'server');
      expect(readFileSync(registration, 'utf8')).toBe(`${running.url}\n${running.password}\n`);
      expect((await import('node:fs')).statSync(registration).mode & 0o777).toBe(0o600);
      expect(Number(readFileSync(path.join(dir, 'state', 'server.pid'), 'utf8'))).toBeGreaterThan(1);
      expect(server.openCodeServerView()).toMatchObject({ running: true, port: Number(new URL(running.url).port), restartPending: false });
      // A restart request while a turn runs waits for the turn.
      let busy = true;
      server.bindOpenCodeServer({ busy: () => busy, onExit: () => undefined });
      await server.requestOpenCodeRestart();
      expect(server.openCodeServerView()).toMatchObject({ running: true, restartPending: true });
      busy = false;
      server.openCodeTurnsSettled();
      await until(() => !server.openCodeServerView().running);
      expect(existsSync(registration)).toBe(false);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it('stops an orphan of this profile by its pidfile, only when it is `opencode … serve`, and redacts the password from a failed start', async () => {
    if (process.platform === 'win32') return;
    const kill = vi.fn();
    const state = path.join(dir, 'state2');
    (await import('node:fs')).mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(state, 'server.pid'), '424242');
    host({ stateDir: async () => state, kill, commandLine: async () => '/home/u/.config/chat-marks/modules/opencode/bin/opencode serve --hostname 127.0.0.1 --port 0 --no-mdns' });
    await server.ensureOpenCodeServer();
    expect(kill).toHaveBeenCalledWith(424242);
    await server.stopOpenCodeServer('module');
    server.resetOpenCodeServerForTests();
    writeFileSync(path.join(state, 'server.pid'), '424243');
    kill.mockClear();
    host({ stateDir: async () => state, kill, commandLine: async () => '/usr/bin/vim notes.txt' });
    await server.ensureOpenCodeServer();
    expect(kill).not.toHaveBeenCalled();
    await server.stopOpenCodeServer('module');
    server.resetOpenCodeServerForTests();
    process.env.FAKE_OPENCODE_FAIL = '1';
    try {
      host({ stateDir: async () => state });
      const failure = await server.ensureOpenCodeServer().catch((error: Error) => error);
      expect((failure as Error).message).toContain('[redacted]');
      expect((failure as Error).message).not.toMatch(/boom [A-Za-z0-9_-]{43}/);
    } finally {
      delete process.env.FAKE_OPENCODE_FAIL;
    }
  });
});
