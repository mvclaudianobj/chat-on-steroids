import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
const { TurnProjector, storeProjectorSink } = await import('../src/main/agent-engine/projector.js');
const approval = await import('../src/main/agent-engine/approval.js');
const { engineToolCallId, diffLineCounts } = await import('../src/main/agent-engine/tool-row.js');
const { projectTimeline } = await import('../src/shared/chronology.js');
import type { ProjectorSink, ProjectedMessage } from '../src/main/agent-engine/projector.js';
import type { ApprovalGate, ApprovalOutcome } from '../src/main/agent-engine/approval.js';
import type { EngineEvent } from '../src/main/agent-engine/types.js';
import type { AgentEngineId } from '../src/shared/agent-engine.js';
import type { NewSessionEvent, StoredText } from '../src/shared/session.js';

interface Fixture { engine: AgentEngineId; steps: Array<{ from: string; event: EngineEvent }> }
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/agent-engine/${name}.json`, import.meta.url), 'utf8')) as Fixture;

/** Records what the projector writes; messages are revised by id like the store does. */
function memorySink() {
  let clock = 1_000;
  const rows: Array<NewSessionEvent | ProjectedMessage> = [];
  const ledgerCalls: string[] = [];
  const sink: ProjectorSink = {
    upsertMessage: async event => {
      const at = rows.findIndex(row => 'messageId' in row && row.kind === event.kind && row.messageId === event.messageId);
      if (at >= 0) rows[at] = event; else rows.push(event);
    },
    append: async event => { rows.push(event); },
    storedText: async (text: string, cap: number): Promise<StoredText> => ({ text: text.slice(0, cap), truncated: text.length > cap, chars: text.length }),
    openTurn: async turnId => { ledgerCalls.push(`open:${turnId}`); },
    closeTurn: async turnId => { ledgerCalls.push(`close:${turnId}`); },
    changed: () => undefined,
    now: () => (clock += 100)
  };
  return { sink, rows, ledgerCalls, tick: (ms: number) => { clock += ms; } };
}

function projector(engine: AgentEngineId, sink: ProjectorSink, answers: Array<[string, ApprovalOutcome]>) {
  const gate = new approval.ApprovalGate();
  const turn = new TurnProjector({
    engine, conversationId: 'cosapi-00000000-0000-4000-8000-000000000001', turnId: 'api-turn-1', sink,
    approvals: { gate, answer: (id, outcome) => answers.push([id, outcome]) }
  });
  return { turn, gate };
}

/** A readable line per written row. */
const outline = (rows: Array<NewSessionEvent | ProjectedMessage>): string[] => rows.map(row => {
  switch (row.kind) {
    case 'user_message': return `user ${row.messageId} ${row.message.text}`;
    case 'assistant_message': return `assistant ${row.messageId} ${row.state} ${row.message.text}`;
    case 'tool_call': return `tool ${row.call.tool} ${row.call.outcome} ${row.call.summary.title}${row.call.summary.metric ? ` [${row.call.summary.metric}]` : ''}`;
    case 'chat_error': return `error ${row.recoverable ? 'recoverable' : 'fatal'} ${row.message.text}`;
    case 'turn_end': return `turn_end ${row.outcome}`;
    default: return row.kind;
  }
});

async function play(turn: InstanceType<typeof TurnProjector>, gate: ApprovalGate, steps: Fixture['steps'],
  onApproval: (approvalId: string) => void = () => undefined): Promise<void> {
  for (const { event } of steps) {
    await turn.apply(event);
    const pending = gate.view();
    if (event.type === 'approval_requested' && pending) onApproval(pending.approvalId);
  }
}

describe('turn projector (synthetic CLI streams)', () => {
  it('projects a Codex-shaped turn: answer steps, command, patch and MCP rows, usage, and an accepted approval', async () => {
    const { codex } = { codex: fixture('codex-turn') };
    const { sink, rows, ledgerCalls } = memorySink();
    const answers: Array<[string, ApprovalOutcome]> = [];
    const { turn, gate } = projector(codex.engine, sink, answers);
    await turn.start('Fix the failing test');
    let shown: ReturnType<ApprovalGate['view']> = null;
    await play(turn, gate, codex.steps, id => {
      shown = gate.view();
      expect(gate.answer(id, 'approve')).toBe(true);
      expect(gate.answer(id, 'approve')).toBe(false);
    });
    expect(outline(rows)).toEqual([
      'user api-user:api-turn-1 Fix the failing test',
      'turn_start',
      "assistant api-assistant:api-turn-1 final I'll run the tests first.",
      'tool exec_command process_exit_nonzero Ran npm test [✕ exit 1]',
      'tool apply_patch ok Edited sum.ts [+2 −1]',
      'tool mcp:docs/search ok Called docs/search',
      'assistant api-assistant:api-turn-1:1 final Fixed the sign in sum.ts.',
      'turn_end completed'
    ]);
    expect(ledgerCalls).toEqual(['open:api-turn-1', 'close:api-turn-1']);
    // The app minted the approval id; the engine's own request id stays main-side.
    expect(shown).toMatchObject({ turnId: 'api-turn-1', toolCallId: 'item-patch-1', tool: 'fileChange', files: ['update src/sum.ts'] });
    expect(answers).toEqual([['7', 'approve']]);
    expect(approval.codexApprovalDecision(answers[0]![1])).toBe('accept');
    expect(turn.usage).toEqual({ inputTokens: 1200, outputTokens: 80, cachedInputTokens: 900, reasoningTokens: 40 });
    const command = rows.find(row => row.kind === 'tool_call' && row.call.tool === 'exec_command');
    expect(command).toMatchObject({
      source: 'app', turnId: 'api-turn-1',
      call: { engine: 'codex', attribution: 'engine', attributionMethod: 'engine', requestId: null, conversationId: 'cosapi-00000000-0000-4000-8000-000000000001',
        callId: engineToolCallId('codex', 'api-turn-1', 'item-cmd-1'), summary: { kind: 'run', tone: 'bad', detail: 'in /work/app' } }
    });
    expect(command?.kind === 'tool_call' && command.call.result.text).toBe('> app test\n1 failing\n');
    const patch = rows.find(row => row.kind === 'tool_call' && row.call.tool === 'apply_patch');
    expect(patch?.kind === 'tool_call' && patch.call.changes).toEqual([{ path: '/work/app/src/sum.ts', added: 2, removed: 1, approximate: false, reviewUnavailable: 'not-kept' }]);
  });

  it('projects a Claude-shaped turn: a read row, a denied command and the deny answer', async () => {
    const claude = fixture('claude-turn');
    const { sink, rows } = memorySink();
    const answers: Array<[string, ApprovalOutcome]> = [];
    const { turn, gate } = projector(claude.engine, sink, answers);
    await turn.start('Clean the build');
    await play(turn, gate, claude.steps, id => gate.answer(id, 'deny'));
    expect(outline(rows)).toEqual([
      'user api-user:api-turn-1 Clean the build',
      'turn_start',
      'assistant api-assistant:api-turn-1 final Let me look at the README.',
      'tool read ok Read README.md',
      'tool exec_command tool_rejected Declined: Ran rm -rf build [declined]',
      'assistant api-assistant:api-turn-1:1 final I left the build folder alone.',
      'turn_end completed'
    ]);
    expect(answers).toEqual([['req-1', 'deny']]);
    expect(approval.claudeApprovalDecision('deny', { command: 'rm -rf build' })).toEqual({ behavior: 'deny', message: 'The user declined this action. It was not run.' });
    expect(approval.claudeApprovalDecision('always', { command: 'ls' })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(turn.usage).toEqual({ inputTokens: 3000, outputTokens: 120, cachedInputTokens: 0, reasoningTokens: 0 });
  });

  it('projects an OpenCode-shaped turn: a TUI-answered permission, an error, an interrupt that settles the open tool, then ignores late events', async () => {
    const opencode = fixture('opencode-turn');
    const { sink, rows } = memorySink();
    const answers: Array<[string, ApprovalOutcome]> = [];
    const { turn, gate } = projector(opencode.engine, sink, answers);
    await turn.start('Format the code');
    await play(turn, gate, opencode.steps);
    expect(outline(rows)).toEqual([
      'user api-user:api-turn-1 Format the code',
      'turn_start',
      'assistant api-assistant:api-turn-1 final Running the formatter.',
      'tool exec_command ok Ran npm run format [✓ 100 ms]',
      'error recoverable The provider is overloaded; retrying.',
      'tool apply_patch tool_execution_error Edited a.ts [did not finish]',
      'turn_end interrupted'
    ]);
    expect(rows.at(-1)).toMatchObject({ kind: 'turn_end', detail: 'The OpenCode run was stopped in its terminal' });
    // Answered in the attached TUI: the card goes and the app sends no answer of its own.
    expect(answers).toEqual([['per_1', 'resolved']]);
    expect(approval.openCodeApprovalDecision('resolved')).toBeNull();
    // "Always" is never sent upstream (2.x saves it for the whole project, beating every session's ask).
    expect(approval.openCodeApprovalDecision('always')).toBe('once');
    expect(approval.openCodeApprovalDecision('stop')).toBeNull();
    expect(gate.view()).toBeNull();
    expect(turn.ended).toBe('interrupted');
  });

  it('streams at most once per interval, fails a turn after a fatal error, and answers a pending approval stop at the end', async () => {
    const { sink, rows, tick } = memorySink();
    const answers: Array<[string, ApprovalOutcome]> = [];
    const { turn } = projector('codex', sink, answers);
    await turn.start('Go');
    await turn.apply({ type: 'text_delta', delta: 'a' });
    await turn.apply({ type: 'text_delta', delta: 'b' });
    expect(outline(rows).filter(line => line.startsWith('assistant'))).toEqual(['assistant api-assistant:api-turn-1 streaming a']);
    tick(1_000);
    await turn.apply({ type: 'text_delta', delta: 'c' });
    expect(outline(rows).filter(line => line.startsWith('assistant'))).toEqual(['assistant api-assistant:api-turn-1 streaming abc']);
    await turn.apply({ type: 'approval_requested', requestId: '9', kind: 'command', tool: 'commandExecution', summary: 'make', action: { command: 'make' } });
    await turn.apply({ type: 'error', message: 'The app-server exited', fatal: true });
    expect(await turn.finish('completed')).toBe('failed');
    expect(outline(rows).slice(2)).toEqual([
      'assistant api-assistant:api-turn-1 final abc',
      'error fatal The app-server exited',
      'turn_end failed'
    ]);
    expect(answers).toEqual([['9', 'stop']]);
    expect(approval.codexApprovalDecision('stop')).toBe('cancel');
    expect(await turn.finish('stopped')).toBe('failed');
    expect(rows.filter(row => row.kind === 'turn_end')).toHaveLength(1);
  });

  it('binds an approval to the canonical action and refuses another id', async () => {
    const gate = new approval.ApprovalGate();
    const waiting = gate.request({ turnId: 't', toolCallId: 'c', tool: 'exec_command', summary: 'ls', action: { b: 1, a: [2, { d: 3, c: 4 }] }, engineRequestId: 'e1' });
    const id = gate.view()!.approvalId;
    expect(gate.hashOf(id)).toBe(approval.argsHash('exec_command', { a: [2, { c: 4, d: 3 }], b: 1 }));
    expect(gate.answer('0f1e2d3c-aaaa-4bbb-8ccc-0123456789ab', 'approve')).toBe(false);
    expect(gate.dismiss('other')).toBe(false);
    expect(gate.answer(id, 'always')).toBe(true);
    expect(await waiting).toBe('always');
    gate.stop();
    expect(await gate.request({ turnId: 't', toolCallId: 'c', tool: 'x', summary: '', action: {} })).toBe('stop');
  });

  it('counts unified diff lines', () => {
    expect(diffLineCounts('--- a/x\n+++ b/x\n@@\n-a\n+b\n+c\n context')).toEqual({ added: 2, removed: 1 });
    expect(diffLineCounts(undefined)).toBeNull();
  });
});

describe('turn projector into the real session store', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await makeTempDir('cos-agent-engine-');
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
  afterAll(async () => {
    executor.resetApiChatExecutorForTests();
    await flushDurable();
    resetRecorderForTests();
    store.resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(directory);
  });

  async function engineChat(engine: AgentEngineId) {
    const conversationId = `cosapi-${crypto.randomUUID()}`;
    const session = await store.createSession({ title: 'CLI chat', titleSource: 'fallback', conversationId });
    await ledger.updateChatRecord(session.id, () => ({ engine, backendSessionId: 'thread-1', model: 'gpt-6-codex', effort: null }));
    return { sessionId: session.id, conversationId };
  }

  it('writes CLI tool rows the timeline places inside the turn, without the MCP kernel', async () => {
    const chat = await engineChat('codex');
    const gate = new approval.ApprovalGate();
    const turn = new TurnProjector({ engine: 'codex', conversationId: chat.conversationId, turnId: 'api-cli-1', sink: storeProjectorSink(chat.sessionId),
      approvals: { gate, answer: () => undefined } });
    await turn.start('Run the tests');
    expect((await ledger.storedChatRecord(chat.sessionId))?.openTurn?.turnId).toBe('api-cli-1');
    await play(turn, gate, fixture('codex-turn').steps, id => gate.answer(id, 'approve'));
    const events = await store.readEvents(chat.sessionId);
    const calls = events.filter(event => event.kind === 'tool_call');
    expect(calls.map(event => event.kind === 'tool_call' && event.call.tool)).toEqual(['exec_command', 'apply_patch', 'mcp:docs/search']);
    expect(calls.every(event => event.source === 'app' && event.turnId === 'api-cli-1')).toBe(true);
    const summary = await store.getSession(chat.sessionId);
    expect(summary?.toolCalls).toBe(3);
    const boundaries = summary?.timelineTurns ?? {};
    const placed = projectTimeline(events, boundaries).filter(event => event.kind === 'tool_call');
    const start = events.find(event => event.kind === 'turn_start');
    expect(placed.every(event => event.turnOrigin === boundaries['api-cli-1']?.origin && event.turnOrigin !== null)).toBe(true);
    expect(start).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', turnId: 'api-cli-1', outcome: 'completed' });
    // The record keeps engine and backend session; only the open turn is gone.
    expect(await ledger.storedChatRecord(chat.sessionId)).toEqual({ engine: 'codex', backendSessionId: 'thread-1', model: 'gpt-6-codex', effort: null });
    // The replayed context is the question and the answer steps, like a CLIProxy chat.
    expect(await executor.apiChatContext(chat.sessionId)).toEqual([
      { role: 'user', content: 'Run the tests' },
      { role: 'assistant', content: "I'll run the tests first.\n\nFixed the sign in sum.ts." }
    ]);
  });

  it('leaves a turn the restart cut to the engine-neutral recovery, which closes it interrupted', async () => {
    const chat = await engineChat('claude');
    const turn = new TurnProjector({ engine: 'claude', conversationId: chat.conversationId, turnId: 'api-cli-2', sink: storeProjectorSink(chat.sessionId),
      approvals: { gate: new approval.ApprovalGate(), answer: () => undefined } });
    await turn.start('Explain');
    await turn.apply({ type: 'text_delta', delta: 'Partial answer' });
    executor.resetApiChatExecutorForTests();
    store.resetSessionStoreForTests();
    await executor.recoverApiChats();
    const events = await store.readEvents(chat.sessionId);
    expect(events.find(event => event.kind === 'assistant_message')).toMatchObject({ state: 'final', final: true, message: { text: 'Partial answer' } });
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end', turnId: 'api-cli-2', outcome: 'interrupted' });
    expect((await ledger.storedChatRecord(chat.sessionId))?.openTurn).toBeUndefined();
    expect((await ledger.storedChatRecord(chat.sessionId))?.engine).toBe('claude');
  });
});
