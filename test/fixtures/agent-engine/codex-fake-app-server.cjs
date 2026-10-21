#!/usr/bin/env node
/**
 * A fake `codex app-server proxy` and the server behind it at once (codex-cli 0.163 shapes) for
 * the Codex engine tests: like the real socket, its stdio is a WebSocket (HTTP upgrade, then one
 * JSON-RPC message per text frame), no model, no network. Every message it receives is appended to CODEX_FAKE_LOG as
 * one JSON line (plus `{"argv": [...]}` first), so a test asserts the exact params and replies.
 *
 * CODEX_FAKE_SCRIPT (JSON file) drives it:
 *   { account?, models?, resumeTurns?, turns?: Step[][] (one list per turn/start, in order),
 *     interruptStatus?: 'interrupted' | null (null: never confirm) , failTurnStart?: string }
 * Step: { notify, params } | { request, id, params } | { waitForResponse: id } | { waitMs }
 * Strings "$THREAD" and "$TURN" in params are replaced by the current thread and turn ids.
 * `--version` prints `codex-cli $CODEX_FAKE_VERSION` (default 0.163.0).
 */
'use strict';
const fs = require('node:fs');
const { Duplex } = require('node:stream');
const { acceptWebSocket } = require('./websocket-stdio.cjs');

if (process.argv.includes('--version')) {
  process.stdout.write(`codex-cli ${process.env.CODEX_FAKE_VERSION || '0.163.0'}\n`);
  process.exit(0);
}

const log = process.env.CODEX_FAKE_LOG;
const script = process.env.CODEX_FAKE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.CODEX_FAKE_SCRIPT, 'utf8')) : {};
const record = value => { if (log) fs.appendFileSync(log, `${JSON.stringify(value)}\n`); };
record({ argv: process.argv.slice(2) });

let socket = null;
const send = message => socket.send(JSON.stringify(message));
let threadCount = 0;
let turnCount = 0;
let thread = null;
let turn = null;
const answered = new Map();
const waiters = new Map();

const substitute = value => JSON.parse(JSON.stringify(value ?? {}).replaceAll('"$THREAD"', JSON.stringify(thread)).replaceAll('"$TURN"', JSON.stringify(turn)));
const threadShape = (id, turns = []) => ({
  id, sessionId: id, forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false, section: null, sectionEnteredAt: null,
  projectId: null, historyMode: 'full', modelProvider: 'openai', model: null, reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: null,
  status: { type: 'idle' }, path: null, cwd: '/', cliVersion: '0.163.0', originator: null, source: 'appServer', threadSource: null,
  agentNickname: null, agentRole: null, gitInfo: null, name: null, turns
});
const turnShape = (id, status = 'inProgress', error = null) => ({ id, rootTurnId: null, items: [], itemsView: 'full', status, error, startedAt: 1, completedAt: null, durationMs: null });

async function runSteps(steps) {
  for (const step of steps ?? []) {
    if (step.waitMs) await new Promise(resolve => setTimeout(resolve, step.waitMs));
    else if (step.waitForResponse !== undefined) {
      const key = JSON.stringify(step.waitForResponse);
      if (!answered.has(key)) await new Promise(resolve => waiters.set(key, resolve));
    } else if (step.request) send({ id: step.id, method: step.request, params: substitute(step.params) });
    else if (step.notify) send({ method: step.notify, params: substitute(step.params) });
  }
}

function result(method, params) {
  switch (method) {
    case 'initialize': return { userAgent: 'codex-fake/0.163.0', codexHome: '/tmp/codex-fake', platformFamily: 'unix', platformOs: 'linux' };
    case 'account/read': return script.account ?? { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true };
    case 'model/list': return { data: script.models ?? [], nextCursor: null };
    case 'thread/start':
      thread = `thread-${++threadCount}`;
      return { thread: threadShape(thread), model: params.model ?? 'gpt-5.5-codex', modelProvider: 'openai', serviceTier: null, disabledPluginIds: [], cwd: params.cwd,
        instructionSources: [], approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, sandbox: { type: 'workspaceWrite' }, reasoningEffort: null };
    case 'thread/resume':
      if (script.failResume) throw new Error(script.failResume);
      thread = params.threadId;
      return { thread: threadShape(thread, script.resumeTurns ?? []), model: 'gpt-5.5-codex', modelProvider: 'openai', serviceTier: null, disabledPluginIds: [], cwd: params.cwd,
        instructionSources: [], approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, sandbox: { type: 'workspaceWrite' }, reasoningEffort: null,
        collaborationMode: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
    case 'turn/start': {
      if (script.failTurnStart) throw new Error(script.failTurnStart);
      thread = params.threadId;
      turn = `turn-${++turnCount}`;
      const steps = (script.turns ?? [])[turnCount - 1] ?? [];
      setImmediate(() => {
        send({ method: 'turn/started', params: { threadId: thread, turn: turnShape(turn) } });
        void runSteps(steps);
      });
      return { turn: turnShape(turn) };
    }
    case 'turn/interrupt': {
      const status = script.interruptStatus === undefined ? 'interrupted' : script.interruptStatus;
      if (status) setImmediate(() => send({ method: 'turn/completed', params: { threadId: params.threadId, turn: turnShape(params.turnId, status) } }));
      return {};
    }
    default: throw new Error(`fake: unknown method ${method}`);
  }
}

function receive(text) {
  const message = JSON.parse(text);
  record(message);
  if (message.method && message.id !== undefined) {
    try { send({ id: message.id, result: result(message.method, message.params ?? {}) }); }
    catch (error) { send({ id: message.id, error: { code: -32600, message: error.message } }); }
  } else if (message.id !== undefined) {
    const key = JSON.stringify(message.id);
    answered.set(key, message);
    waiters.get(key)?.();
    waiters.delete(key);
  }
}

acceptWebSocket(Duplex.from({ readable: process.stdin, writable: process.stdout })).then(accepted => {
  socket = accepted;
  socket.on('message', (data, isBinary) => { if (!isBinary) receive(data.toString('utf8')); });
  socket.on('close', () => process.exit(0));
}, () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
