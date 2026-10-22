import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const claude = await import('../src/main/agent-engine/claude.js');
const { argsHash } = await import('../src/main/agent-engine/approval.js');
import type { ClaudeEngine, ClaudeRuntime } from '../src/main/agent-engine/claude.js';
import { ENGINE_TERMINAL_OPEN_ELSEWHERE, ENGINE_TERMINAL_OPEN_IN_APP } from '../src/shared/agent-engine.js';

const FAKE = fileURLToPath(new URL('./fixtures/agent-engine/fake-claude.mjs', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let directory: string;
let project: string;
let logFile: string;
let extraEnv: Record<string, string> = {};
let terminalState: 'none' | 'detached' | 'attached' | 'external' = 'none';
const terminalCalls: string[] = [];
let engine: ClaudeEngine;
/** The user's Claude Code Router setup as the engine sees it: never this machine's real files. */
let routing: { detected: boolean; model: string | null; unavailable?: 'not_installed' | 'stopped' } = { detected: false, model: null };

const runtime = async (): Promise<ClaudeRuntime> => ({ bin: process.execPath, argsPrefix: [FAKE], cwd: project });

function makeEngine(): ClaudeEngine {
  return claude.createClaudeEngine({
    runtime,
    probe: async (_runtime, args) => args[0] === '--version' ? { code: 0, stdout: '2.1.306 (Claude Code)\n', stderr: '' }
      : args[0] === '--help' ? { code: 0, stdout: '  --permission-mode <mode>   Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")\n', stderr: '' }
        : { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '' },
    terminal: {
      state: async () => terminalState,
      end: async chat => { terminalCalls.push(`end:${chat}`); terminalState = 'none'; },
      open: async chat => { terminalCalls.push(`open:${chat.sessionId}:${chat.args.join(' ')}`); return { id: 'cli-1' }; }
    },
    attachModuleHooks: () => undefined,
    routing: () => routing,
    env: () => ({ ...process.env, FAKE_CLAUDE_LOG: logFile, ...extraEnv }),
    initializeTimeoutMs: 5_000,
    interruptGraceMs: 2_000,
    idleMs: 60_000
  });
}

interface LogEntry { pid: number; argv?: string[]; cwd?: string; background?: string | null; cron?: string | null; in?: Record<string, any> }
const logEntries = (): LogEntry[] => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LogEntry) : [];
/** Chat processes; the catalog probes (`initialize` only, see `probes`) are counted apart. */
const launches = (): LogEntry[] => logEntries().filter(entry => entry.argv && !entry.argv.includes('--no-session-persistence'));
const probes = (): LogEntry[] => logEntries().filter(entry => entry.argv?.includes('--no-session-persistence'));
const controlResponses = (): Array<Record<string, any>> => logEntries().map(entry => entry.in).filter((message): message is Record<string, any> => message?.type === 'control_response');
const controlRequests = (subtype: string): Array<Record<string, any>> => logEntries().map(entry => entry.in).filter((message): message is Record<string, any> => message?.type === 'control_request' && message.request?.subtype === subtype);

async function waitFor<T>(probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 8_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const pending = (sessionId: string) => waitFor(async () => (await engine.view(sessionId)).pending);
const finished = async (sessionId: string) => { await engine.turnDone(sessionId); return store.readEvents(sessionId); };

beforeAll(async () => {
  directory = await makeTempDir('cos-claude-engine-');
  project = path.join(directory, 'project');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(project);
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
  logFile = path.join(directory, `log-${crypto.randomUUID()}.jsonl`);
  writeFileSync(logFile, '');
  extraEnv = {};
  routing = { detected: false, model: null };
  terminalState = 'none';
  terminalCalls.length = 0;
  engine = makeEngine();
});

afterEach(async () => { await engine.resetForTests(); });

afterAll(async () => {
  executor.resetApiChatExecutorForTests();
  await flushDurable();
  resetRecorderForTests();
  store.resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

describe('Claude Code engine: argv and pure mapping', () => {
  it('builds the headless argv without any bypass flag, with the stdio permission prompt and the session flag', () => {
    const id = '3f2b8c1e-0d4a-4c3b-9e2f-1a2b3c4d5e6f';
    const start = claude.claudeArgs({ sessionId: id, mode: 'start', permissionMode: 'default', model: 'opus', effort: 'high' });
    expect(start).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--settings', claude.CLAUDE_FLAG_SETTINGS,
      '--disallowedTools', 'ScheduleWakeup,Monitor,CronCreate,CronDelete,CronList',
      '--model=opus', '--effort', 'high', `--session-id=${id}`
    ]);
    expect(claude.claudeArgs({ sessionId: id, mode: 'resume', permissionMode: 'manual' }).slice(-5)).toEqual(['--settings', claude.CLAUDE_FLAG_SETTINGS, '--disallowedTools', 'ScheduleWakeup,Monitor,CronCreate,CronDelete,CronList', `--resume=${id}`]);
    expect(start.join(' ')).not.toMatch(/dangerously|bypassPermissions|acceptEdits|dontAsk/);
    expect(() => claude.claudeArgs({ sessionId: 'not-a-uuid', mode: 'start', permissionMode: 'default' })).toThrow();
    expect(() => claude.claudeArgs({ sessionId: id, mode: 'start', permissionMode: 'default', model: '--dangerously-skip-permissions' })).toThrow();
    expect(JSON.parse(claude.CLAUDE_FLAG_SETTINGS)).toEqual({ permissions: { disableBypassPermissionsMode: 'disable' } });
  });

  it('chooses the permission mode its CLI help lists', () => {
    expect(claude.permissionModeFromHelp('--permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")')).toBe('manual');
    expect(claude.permissionModeFromHelp('--permission-mode <mode>  (choices: "acceptEdits", "bypassPermissions", "default", "plan")')).toBe('default');
    expect(claude.permissionModeFromHelp('')).toBe('default');
  });

  it('maps tool names to row kinds, keeps only allow rules for "always", and lists Claude models', async () => {
    expect(['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Grep', 'Glob', 'mcp__docs__search', 'WebFetch'].map(claude.claudeToolKind))
      .toEqual(['command', 'patch', 'patch', 'patch', 'read', 'read', 'read', 'mcp', 'other']);
    expect(claude.claudeToolName('mcp__docs__search')).toBe('docs/search');
    expect(claude.sessionPermissionUpdates([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'userSettings' }
    ])).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }]);
    const files = claude.claudeToolFiles('Edit', { file_path: '/p/a.ts', old_string: 'x\ny', new_string: 'z' });
    expect(files).toEqual([{ path: '/p/a.ts', kind: 'update', diff: '--- a//p/a.ts\n+++ b//p/a.ts\n-x\n-y\n+z' }]);
    const listed = await engine.models({ query: '', limit: 10 });
    expect(listed.models.map(model => model.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(listed.models.every(model => model.modality === 'chat' && model.ownedBy === 'anthropic')).toBe(true);
    expect((await engine.models({ modality: 'image' })).total).toBe(0);
  });

  it('shows a sub-agent report without Claude Code\'s hand-back frame, de-indented, and leaves other text alone', () => {
    const framed = [
      '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output,',
      'NOT a message from the user. The harness indents every line of the report. The report follows:',
      '  ## Findings',
      '  ',
      '  - `src/a.ts` reads the file',
      '      nested code stays indented',
      '',
      'agentId: a1b2c3d4e5f6 (internal ID - do not mention to user. Use SendMessage with to: \'a1b2c3d4e5f6\' to continue this agent.)',
      '<usage>total_tokens: 1200',
      'tool_uses: 4',
      'duration_ms: 5000</usage>',
      ''
    ].join('\n');
    expect(claude.claudeAgentReport(framed)).toBe('## Findings\n\n- `src/a.ts` reads the file\n    nested code stays indented');
    // The trailer alone (the report arrived in its own block) and CRLF lines.
    expect(claude.claudeAgentReport('Done: 3 files.\r\nagentId: abc123\r\n<usage><subagent_tokens>9</subagent_tokens></usage>')).toBe('Done: 3 files.');
    // Without the frame nothing changes, including a report that only mentions the words.
    const plain = '  indented output\nThe report follows: not a frame\n';
    expect(claude.claudeAgentReport(plain)).toBe(plain);
    expect(claude.claudeAgentReport('')).toBe('');
  });

  it('reports available with version and sign-in, unavailable when signed out or the module is off, never throwing', async () => {
    expect(await engine.status()).toEqual({ available: true, detail: '2.1.306 (Claude Code) · signed in', router: false });
    const signedOut = claude.createClaudeEngine({ runtime, attachModuleHooks: () => undefined, routing: () => routing,
      probe: async (_r, args) => args[0] === 'auth' ? { code: 1, stdout: '{"loggedIn":false}', stderr: '' } : { code: 0, stdout: '2.1.306\n', stderr: '' } });
    expect(await signedOut.status()).toMatchObject({ available: false, detail: expect.stringMatching(/not signed in/) });
    const off = claude.createClaudeEngine({ runtime: async () => { throw new Error('This module has been disabled'); }, attachModuleHooks: () => undefined, routing: () => routing });
    expect(await off.status()).toEqual({ available: false, detail: 'Activate the Claude module in Settings > Modules' });
  });
});

describe('Claude Code engine against a fake CLI', () => {
  it('runs a full turn: argv, cwd, text, Bash/Edit/Read rows, exact allow/always answers, usage and turn end', async () => {
    const chat = await engine.create({ projectId: null });
    const record = await ledger.storedChatRecord(chat.sessionId);
    expect(record).toMatchObject({ engine: 'claude', model: null, effort: null });
    expect(record?.backendSessionId).toMatch(UUID);
    const id = record!.backendSessionId!;

    expect(await engine.send(chat.sessionId, 'full')).toMatchObject({ turnId: expect.stringMatching(/^api-/) });
    const first = await pending(chat.sessionId);
    expect(first).toMatchObject({ tool: 'Bash', summary: 'npm test\n# Run the tests', toolCallId: 'toolu_bash' });
    await engine.approve(chat.sessionId, first.approvalId, 'always');
    const second = await waitFor(async () => { const view = (await engine.view(chat.sessionId)).pending; return view && view.approvalId !== first.approvalId ? view : null; });
    expect(second).toMatchObject({ tool: 'Edit', files: [`${project}/src/sum.ts`] });
    // A stale id is refused, the current one answered.
    await expect(engine.approve(chat.sessionId, first.approvalId, 'approve')).rejects.toThrow('This approval is no longer pending');
    await engine.approve(chat.sessionId, second.approvalId, 'approve');
    const events = await finished(chat.sessionId);

    const [launch] = launches();
    expect(launch!.cwd).toBe(project);
    expect(launch!.argv).toEqual(claude.claudeArgs({ sessionId: id, mode: 'start', permissionMode: 'default' }));
    expect(launch!.argv!.join(' ')).not.toMatch(/dangerously|bypass/);
    // Nothing wakes this session after its result: background work and wake-up tools are off.
    expect(launch).toMatchObject({ background: '1', cron: '1' });
    expect(controlRequests('initialize')).toHaveLength(1);
    const user = logEntries().map(entry => entry.in).find(message => message?.type === 'user');
    expect(user).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'full' }] }, parent_tool_use_id: null });

    const responses = controlResponses();
    expect(responses).toEqual([
      { type: 'control_response', response: { subtype: 'success', request_id: 'req-bash', response: {
        behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run the tests' },
        updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }]
      } } },
      { type: 'control_response', response: { subtype: 'success', request_id: 'req-edit', response: {
        behavior: 'allow', updatedInput: { file_path: `${project}/src/sum.ts`, old_string: 'a - b', new_string: 'a + b' }
      } } }
    ]);

    const outline = events.map(event => event.kind === 'tool_call' ? `tool ${event.call.tool} ${event.call.outcome} ${event.call.summary?.title}`
      : event.kind === 'assistant_message' ? `answer ${event.message.text} ${event.state}`
        : event.kind === 'user_message' ? `user ${event.message.text}` : event.kind === 'turn_end' ? `end ${event.outcome}` : event.kind);
    expect(outline).toEqual([
      'user full', 'turn_start', 'answer Let me run the tests. final',
      'tool exec_command ok Ran npm test', 'tool apply_patch ok Edited sum.ts', 'tool read ok Read README.md',
      'answer Fixed the sign. final', 'end completed'
    ]);
    const patch = events.find(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch');
    expect(patch?.kind === 'tool_call' && patch.call.changes).toEqual([expect.objectContaining({ path: `${project}/src/sum.ts`, added: 1, removed: 1 })]);
    expect(events.every(event => event.kind !== 'tool_call' || (event.call.engine === 'claude' && event.call.attribution === 'engine'))).toBe(true);
    expect((await ledger.storedChatRecord(chat.sessionId))?.openTurn).toBeUndefined();
    expect((await engine.view(chat.sessionId)).running).toBe(false);
    // The model the CLI reported joins the list.
    expect((await engine.models({})).models.map(model => model.id)).toContain('claude-fable-5');

    // The process stays: the next turn reuses it, with no second launch.
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    expect(launches()).toHaveLength(1);
  });

  it('records an Agent row with the sub-agent report alone, by Claude Code in this chat', async () => {
    const chat = await engine.create({ projectId: null });
    await engine.send(chat.sessionId, 'agent');
    const events = await finished(chat.sessionId);
    const row = events.find(event => event.kind === 'tool_call');
    expect(row?.kind === 'tool_call' && row.call).toMatchObject({ tool: 'Agent', outcome: 'ok', engine: 'claude', attribution: 'engine' });
    expect(row?.kind === 'tool_call' && row.call.result.text).toBe('Found 2 test files:\n- test/a.test.ts\n- test/b.test.ts');
  });

  it('denies with the message and records a declined row; binds the card to the shown input', async () => {
    const chat = await engine.create({ projectId: null });
    await engine.send(chat.sessionId, 'full');
    const first = await pending(chat.sessionId);
    expect(argsHash('Bash', { tool_use_id: 'toolu_bash', input: { command: 'npm test', description: 'Run the tests' } })).toMatch(/^[0-9a-f]{64}$/);
    await engine.approve(chat.sessionId, first.approvalId, 'deny');
    const second = await waitFor(async () => { const view = (await engine.view(chat.sessionId)).pending; return view && view.approvalId !== first.approvalId ? view : null; });
    await engine.approve(chat.sessionId, second.approvalId, 'deny');
    const events = await finished(chat.sessionId);
    expect(controlResponses().map(message => message.response.response)).toEqual([
      { behavior: 'deny', message: 'The user declined this action. It was not run.' },
      { behavior: 'deny', message: 'The user declined this action. It was not run.' }
    ]);
    const rows = events.filter(event => event.kind === 'tool_call').map(event => event.kind === 'tool_call' ? `${event.call.tool}:${event.call.outcome}` : '');
    expect(rows).toEqual(['exec_command:tool_rejected', 'apply_patch:tool_rejected', 'read:ok']);
  });

  it('clears the card when the CLI cancels its pending request, without answering it', async () => {
    extraEnv = { FAKE_CLAUDE_CANCEL_MS: '400' };
    const chat = await engine.create({ projectId: null });
    await engine.send(chat.sessionId, 'cancel');
    const card = await pending(chat.sessionId);
    expect(card.toolCallId).toBe('toolu_c');
    await waitFor(async () => !(await engine.view(chat.sessionId)).pending);
    await expect(engine.approve(chat.sessionId, card.approvalId, 'approve')).rejects.toThrow('no longer pending');
    const events = await finished(chat.sessionId);
    expect(controlResponses()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'completed' });
  });

  it('Stop sends interrupt, answers the pending request and ends the turn stopped; the next send reuses the process', async () => {
    const chat = await engine.create({ projectId: null });
    await engine.send(chat.sessionId, 'hang');
    await pending(chat.sessionId);
    expect(await engine.stop(chat.sessionId)).toBe(true);
    const events = await store.readEvents(chat.sessionId);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'stopped' });
    expect((await engine.view(chat.sessionId))).toMatchObject({ running: false, pending: null });
    await waitFor(() => controlRequests('interrupt').length === 1);
    expect(controlRequests('interrupt')[0]).toMatchObject({ type: 'control_request', request_id: expect.any(String), request: { subtype: 'interrupt' } });
    expect(controlResponses().map(message => message.response.response)).toEqual([{ behavior: 'deny', message: 'The user stopped this turn.' }]);
    expect(await engine.stop(chat.sessionId)).toBe(false);
    // The interrupted turn's late result belongs to nobody; the next turn is answered normally.
    await engine.send(chat.sessionId, 'plain');
    const after = await finished(chat.sessionId);
    expect(after.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'completed' });
    expect(after.filter(event => event.kind === 'assistant_message').at(-1)).toMatchObject({ message: { text: 'Hi there.' } });
    expect(launches()).toHaveLength(1);
  });

  it('fails the turn on a result with is_error, and on a crash with a redacted stderr summary', async () => {
    const chat = await engine.create({ projectId: null });
    await engine.send(chat.sessionId, 'fail');
    let events = await finished(chat.sessionId);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'failed' });
    expect(events.find(event => event.kind === 'chat_error')).toMatchObject({ message: { text: expect.stringContaining('API Error: 529 overloaded') } });

    await engine.send(chat.sessionId, 'crash');
    events = await finished(chat.sessionId);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'failed' });
    const error = events.filter(event => event.kind === 'chat_error').at(-1);
    expect(error?.kind === 'chat_error' && error.message.text).toMatch(/exited during the turn \(code 3\): fatal: boom/);
    expect(error?.kind === 'chat_error' && error.message.text).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    expect((await ledger.storedChatRecord(chat.sessionId))?.openTurn).toBeUndefined();
  });

  it('after a restart, closes the open turn interrupted and resumes the session on the next send', async () => {
    const chat = await engine.create({ projectId: null });
    const id = (await ledger.storedChatRecord(chat.sessionId))!.backendSessionId!;
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    await engine.send(chat.sessionId, 'hang');
    await pending(chat.sessionId);
    // The app quits: its process and memory are gone, the ledger still has the open turn.
    await engine.resetForTests();
    await ledger.updateChatRecord(chat.sessionId, current => current ? { ...current, openTurn: { turnId: 'api-cut', startedAt: Date.now() } } : current);
    await store.appendEvent(chat.sessionId, { time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'api-cut' });
    executor.resetApiChatExecutorForTests();
    store.resetSessionStoreForTests();
    engine = makeEngine();
    await engine.recover();
    const events = await store.readEvents(chat.sessionId);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', turnId: 'api-cut', outcome: 'interrupted' });
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    expect(launches().at(-1)!.argv!.at(-1)).toBe(`--resume=${id}`);
  });

  it('starts the session itself when a resume finds no conversation (a first turn that never reached the CLI)', async () => {
    const chat = await engine.create({ projectId: null });
    const id = (await ledger.storedChatRecord(chat.sessionId))!.backendSessionId!;
    await store.appendEvent(chat.sessionId, { time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'api-old' });
    await store.appendEvent(chat.sessionId, { time: Date.now(), source: 'app', kind: 'turn_end', turnId: 'api-old', outcome: 'failed' });
    extraEnv = { FAKE_CLAUDE_MISSING: id };
    await engine.send(chat.sessionId, 'plain');
    const events = await finished(chat.sessionId);
    expect(launches().map(entry => entry.argv!.at(-1))).toEqual([`--resume=${id}`, `--session-id=${id}`]);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'completed' });
  });

  it('runs edits and commands without a card in the chat\'s auto mode, passing the input unchanged', async () => {
    const chat = await engine.create({ projectId: null });
    await engine.setChatSettings(chat.sessionId, { approval: 'auto' });
    await engine.send(chat.sessionId, 'full');
    await finished(chat.sessionId);
    expect(controlResponses().map(message => message.response.response)).toEqual([
      { behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run the tests' } },
      { behavior: 'allow', updatedInput: { file_path: `${project}/src/sum.ts`, old_string: 'a - b', new_string: 'a + b' } }
    ]);
  });

  it('refuses a CLI that reports bypassPermissions', async () => {
    extraEnv = { FAKE_CLAUDE_MODE: 'bypassPermissions' };
    const chat = await engine.create({ projectId: null });
    await engine.send(chat.sessionId, 'hang');
    const events = await finished(chat.sessionId);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'failed' });
    expect(events.some(event => event.kind === 'chat_error' && /permission checks bypassed/.test(event.message.text))).toBe(true);
  });

  it('hands over to the terminal only while idle, and the next send ends a detached terminal and resumes', async () => {
    const chat = await engine.create({ projectId: null });
    const id = (await ledger.storedChatRecord(chat.sessionId))!.backendSessionId!;
    expect(engine.terminal({ sessionId: chat.sessionId, conversationId: chat.conversationId, backendSessionId: id, cwd: project }))
      .toEqual({ argv: ['--resume', id], mode: 'handover' });
    // Before any turn the terminal starts the session itself.
    expect(await engine.openTerminal(chat.sessionId)).toEqual({ cliSessionId: 'cli-1' });
    expect(terminalCalls).toEqual([`open:${chat.sessionId}:--session-id ${id}`]);

    await engine.send(chat.sessionId, 'hang');
    await pending(chat.sessionId);
    await expect(engine.openTerminal(chat.sessionId)).rejects.toThrow('Claude Code is still answering in this chat');
    await engine.stop(chat.sessionId);

    const hostPid = launches().at(-1)!.pid;
    expect(await engine.openTerminal(chat.sessionId)).toEqual({ cliSessionId: 'cli-1' });
    expect(terminalCalls.at(-1)).toBe(`open:${chat.sessionId}:--resume ${id}`);
    // The app's host was stopped for the hand-over.
    await waitFor(() => { try { process.kill(hostPid, 0); return false; } catch { return true; } });

    terminalState = 'attached';
    const calls = terminalCalls.length;
    await expect(engine.send(chat.sessionId, 'plain')).rejects.toThrow(ENGINE_TERMINAL_OPEN_IN_APP);
    terminalState = 'external';
    await expect(engine.send(chat.sessionId, 'plain')).rejects.toThrow(ENGINE_TERMINAL_OPEN_ELSEWHERE);
    // Refusing never closes anything, and no host started.
    expect(terminalCalls).toHaveLength(calls);
    expect(launches().at(-1)!.pid).toBe(hostPid);
    terminalState = 'detached';
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    expect(terminalCalls.at(-1)).toBe(`end:${chat.sessionId}`);
    expect(launches().at(-1)!.argv!.at(-1)).toBe(`--resume=${id}`);
    expect(launches().at(-1)!.pid).not.toBe(hostPid);
  });

  it('closes an attached hand-over terminal only on the explicit take-back, then resumes and sends', async () => {
    const chat = await engine.create({ projectId: null });
    const id = (await ledger.storedChatRecord(chat.sessionId))!.backendSessionId!;
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    await engine.openTerminal(chat.sessionId);
    for (const state of ['attached', 'external'] as const) {
      terminalState = state;
      const before = launches().length;
      await engine.send(chat.sessionId, 'plain', { takeBackTerminal: true });
      const events = await finished(chat.sessionId);
      expect(terminalCalls.at(-1)).toBe(`end:${chat.sessionId}`);
      expect(launches()).toHaveLength(before + 1);
      expect(launches().at(-1)!.argv!.at(-1)).toBe(`--resume=${id}`);
      expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'completed' });
      await engine.openTerminal(chat.sessionId);
    }
    // The terminal still refuses to open while the chat answers.
    terminalState = 'none';
    await engine.send(chat.sessionId, 'hang');
    await pending(chat.sessionId);
    await expect(engine.openTerminal(chat.sessionId)).rejects.toThrow('Claude Code is still answering in this chat');
    await engine.stop(chat.sessionId);
  });

  it('restarts the process with --resume when the chat\'s model or effort changed', async () => {
    const chat = await engine.create({ projectId: null });
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    await engine.setChatSettings(chat.sessionId, { model: 'opus', effort: 'low' });
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    const argv = launches().at(-1)!.argv!;
    expect(launches()).toHaveLength(2);
    expect(argv).toContain('--model=opus');
    expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual(['--effort', 'low']);
    expect(argv.at(-1)).toMatch(/^--resume=/);
    await expect(engine.setChatSettings(chat.sessionId, { model: '--dangerously-skip-permissions' })).rejects.toThrow();
  });
});

describe('Claude Code engine: routes (direct CLI account or a detected Claude Code Router)', () => {
  // As Claude Code 2.1.306 answers `initialize`: the direct route's own catalog, and the router's.
  const DIRECT_MODELS = JSON.stringify([
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', supportedEffortLevels: ['low', 'high'] }
  ]);
  const ROUTER_MODELS = JSON.stringify([
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' },
    { value: 'anthropic/claude-ccr-h00', resolvedModel: 'anthropic/claude-ccr-h00', displayName: 'Local/router-model', description: 'From gateway' },
    { value: 'Local/router-model', resolvedModel: 'Local/router-model', displayName: 'Local/router-model', description: 'Custom model' }
  ]);
  const signedIn = (yes: boolean) => JSON.stringify(yes ? { tokenSource: 'claude.ai', apiProvider: 'firstParty' } : { tokenSource: 'none', apiProvider: 'firstParty' });

  beforeEach(() => {
    routing = { detected: true, model: 'Local/router-model' };
    extraEnv = { FAKE_CLAUDE_DIRECT_MODELS: DIRECT_MODELS, FAKE_CLAUDE_DIRECT_ACCOUNT: signedIn(true), FAKE_CLAUDE_MODELS: ROUTER_MODELS, FAKE_CLAUDE_ACCOUNT: JSON.stringify({ tokenSource: 'apiKeyHelper', apiKeySource: 'apiKeyHelper' }) };
  });

  it('unsets the router for the direct route only: "" values and an empty key helper in the flag layer', () => {
    const direct = JSON.parse(claude.CLAUDE_DIRECT_SETTINGS);
    expect(direct.permissions).toEqual({ disableBypassPermissionsMode: 'disable' });
    expect(direct.apiKeyHelper).toBe('');
    expect(Object.keys(direct.env)).toEqual(expect.arrayContaining(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH_TOKEN']));
    // Claude Code refuses `null` (and then drops the whole layer); "" is what it reads as unset.
    expect(Object.values(direct.env).every(value => value === '')).toBe(true);
    expect(claude.CLAUDE_DIRECT_SETTINGS).not.toContain('null');
    const id = '3f2b8c1e-0d4a-4c3b-9e2f-1a2b3c4d5e6f';
    const argv = claude.claudeArgs({ sessionId: id, mode: 'start', permissionMode: 'default', settings: claude.CLAUDE_DIRECT_SETTINGS });
    expect(argv.slice(argv.indexOf('--settings'), argv.indexOf('--settings') + 2)).toEqual(['--settings', claude.CLAUDE_DIRECT_SETTINGS]);
    expect(() => claude.claudeArgs({ sessionId: id, mode: 'start', permissionMode: 'default', settings: '{"permissions":{"defaultMode":"bypassPermissions"}}' })).toThrow('Invalid Claude flag settings');
  });

  it('says a router is detected and whether the direct route has an account of its own', async () => {
    extraEnv.FAKE_CLAUDE_DIRECT_ACCOUNT = signedIn(false);
    expect(await engine.status()).toEqual({ available: true, router: true, detail: '2.1.306 (Claude Code) · direct: not signed in · Claude Code Router detected' });
    // The direct account was read from a process with the direct settings that got `initialize` only.
    expect(probes()).toHaveLength(1);
    expect(probes()[0]!.argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--settings', claude.CLAUDE_DIRECT_SETTINGS]));
    expect(logEntries().filter(entry => entry.in?.type === 'user')).toEqual([]);
    const fresh = makeEngine();
    extraEnv.FAKE_CLAUDE_DIRECT_ACCOUNT = signedIn(true);
    expect((await fresh.status()).detail).toBe('2.1.306 (Claude Code) · direct: signed in · Claude Code Router detected');
    await fresh.resetForTests();
  });

  it('lists each route\'s own catalog with the concrete model of every alias', async () => {
    const direct = await engine.models({ route: 'direct' });
    expect(direct.models.map(model => [model.id, model.label, model.efforts])).toEqual([
      ['opus', 'opus (claude-opus-5-5)', ['low', 'medium', 'high']],
      ['haiku', 'haiku (claude-haiku-5-5)', ['low', 'high']]
    ]);
    const router = await engine.models({ route: 'router' });
    expect(router.models.map(model => [model.id, model.label])).toEqual([
      ['opus', 'opus (claude-opus-5-5)'], ['anthropic/claude-ccr-h00', 'Local/router-model'], ['Local/router-model', undefined]
    ]);
    expect(probes().map(entry => entry.argv!.includes(claude.CLAUDE_DIRECT_SETTINGS))).toEqual([true, false]);
    // Cached per route: a second list starts nothing.
    await engine.models({ route: 'direct' });
    expect(probes()).toHaveLength(2);
    // Without a catalog (the probe failed) the bare aliases stay choosable.
    expect(claude.claudeModelRows(null, [], {}).models.map(model => model.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('starts new chats direct, runs them with the direct settings, and moves a chat between routes on the same session', async () => {
    const chat = await engine.create({ projectId: null });
    expect(chat).toMatchObject({ route: 'direct', routes: ['direct', 'router'] });
    const record = await ledger.storedChatRecord(chat.sessionId);
    expect(record).toMatchObject({ route: 'direct' });
    const id = record!.backendSessionId!;
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    expect(launches().at(-1)!.argv).toEqual(claude.claudeArgs({ sessionId: id, mode: 'start', permissionMode: 'default', settings: claude.CLAUDE_DIRECT_SETTINGS }));

    // Between turns: the same Claude session resumes with the router route's settings.
    expect(await engine.setChatSettings(chat.sessionId, { route: 'router' })).toMatchObject({ route: 'router' });
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    expect(launches()).toHaveLength(2);
    expect(launches().at(-1)!.argv).toEqual(claude.claudeArgs({ sessionId: id, mode: 'resume', permissionMode: 'default', settings: claude.CLAUDE_FLAG_SETTINGS }));
    expect((await ledger.storedChatRecord(chat.sessionId))?.backendSessionId).toBe(id);

    // A route change waits for the running answer.
    await engine.send(chat.sessionId, 'hang');
    await pending(chat.sessionId);
    await expect(engine.setChatSettings(chat.sessionId, { route: 'direct' })).rejects.toThrow(claude.CLAUDE_ROUTE_WHILE_RUNNING);
    await engine.stop(chat.sessionId);

    // The hand-over terminal runs on the chat's route too.
    await engine.setChatSettings(chat.sessionId, { route: 'direct' });
    await engine.openTerminal(chat.sessionId);
    expect(terminalCalls.at(-1)).toBe(`open:${chat.sessionId}:--settings ${claude.CLAUDE_DIRECT_SETTINGS} --resume ${id}`);
    expect(engine.terminal({ sessionId: chat.sessionId, conversationId: chat.conversationId, backendSessionId: id, cwd: null, route: 'router' }))
      .toEqual({ argv: ['--resume', id], mode: 'handover' });
  });

  it('refuses a direct send without the CLI\'s own login, records nothing, and drops a model the other route lacks', async () => {
    extraEnv.FAKE_CLAUDE_DIRECT_ACCOUNT = signedIn(false);
    const chat = await engine.create({ projectId: null, route: 'router', model: 'Local/router-model' });
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    // To direct: the router's model is not in the direct catalog, so the chat takes the CLI's default.
    expect(await engine.setChatSettings(chat.sessionId, { route: 'direct' })).toMatchObject({ route: 'direct', model: null });
    const before = (await store.readEvents(chat.sessionId)).length;
    await expect(engine.send(chat.sessionId, 'plain')).rejects.toThrow(claude.CLAUDE_DIRECT_NOT_SIGNED_IN);
    expect(await store.readEvents(chat.sessionId)).toHaveLength(before);
    expect(launches()).toHaveLength(1);
  });

  it('falls back to the CLI account while the configured router is not installed or not running, and says why', async () => {
    const chat = await engine.create({ projectId: null, route: 'router' });
    const id = (await ledger.storedChatRecord(chat.sessionId))!.backendSessionId!;
    routing = { detected: true, model: 'Local/router-model', unavailable: 'not_installed' };
    expect(await engine.view(chat.sessionId)).toMatchObject({ route: 'router', routes: ['direct'], routeNotice: 'not_installed' });
    const fresh = makeEngine();
    expect(await fresh.status()).toEqual({ available: true, router: false,
      detail: '2.1.306 (Claude Code) · direct: signed in · Claude Code Router is not installed. Install it from Settings > Modules > Claude Code Router.' });
    await fresh.resetForTests();
    // The same session runs with the direct settings: the CLI never tries the dead router address.
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    expect(launches().at(-1)!.argv).toEqual(claude.claudeArgs({ sessionId: id, mode: 'start', permissionMode: 'default', settings: claude.CLAUDE_DIRECT_SETTINGS }));
    expect((await ledger.storedChatRecord(chat.sessionId))?.route).toBe('router');
    // Choosing the router route needs one that answers.
    routing = { detected: true, model: 'Local/router-model', unavailable: 'stopped' };
    const other = await engine.create({ projectId: null });
    expect(other).toMatchObject({ route: 'direct', routes: [] });
    await expect(engine.setChatSettings(other.sessionId, { route: 'router' })).rejects.toThrow('Claude Code Router is not running. Start it from Settings > Modules > Claude Code Router.');
    await expect(engine.create({ projectId: null, route: 'router' })).rejects.toThrow('Claude Code Router is not running.');
    // Without an account of its own the fallback is refused with both reasons.
    extraEnv.FAKE_CLAUDE_DIRECT_ACCOUNT = signedIn(false);
    const signedOut = makeEngine();
    await expect(signedOut.send(chat.sessionId, 'plain')).rejects.toThrow(`Claude Code Router is not running. Start it from Settings > Modules > Claude Code Router. ${claude.CLAUDE_DIRECT_NOT_SIGNED_IN}`);
    await signedOut.resetForTests();
    // Once it answers again, the chat is back on the router with the same session.
    extraEnv.FAKE_CLAUDE_DIRECT_ACCOUNT = signedIn(true);
    routing = { detected: true, model: 'Local/router-model' };
    expect(await engine.view(chat.sessionId)).toMatchObject({ route: 'router', routes: ['direct', 'router'] });
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    expect(launches().at(-1)!.argv).toEqual(claude.claudeArgs({ sessionId: id, mode: 'resume', permissionMode: 'default', settings: claude.CLAUDE_FLAG_SETTINGS }));
  });

  it('changes nothing without a detected router: no override, no route choice', async () => {
    routing = { detected: false, model: null };
    const chat = await engine.create({ projectId: null });
    expect(chat).toMatchObject({ route: 'direct', routes: [] });
    await engine.send(chat.sessionId, 'plain');
    await finished(chat.sessionId);
    expect(launches().at(-1)!.argv).toContain(claude.CLAUDE_FLAG_SETTINGS);
    expect(launches().at(-1)!.argv).not.toContain(claude.CLAUDE_DIRECT_SETTINGS);
    // A chat stored before routes reads as the configured CLI (`router`).
    await ledger.updateChatRecord(chat.sessionId, current => { const { route: _route, ...rest } = current!; void _route; return rest; });
    expect((await engine.view(chat.sessionId)).route).toBe('router');
  });
});
