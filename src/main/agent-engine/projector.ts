/**
 * Projects one CLI engine turn (engine-neutral `EngineEvent`s) into the session store, in the
 * shapes the API chat already writes, so the timeline, recovery and context replay need no
 * engine knowledge:
 *
 * - `start(text)`: the ledger's open turn, then `user_message` `api-user:<turn>`, then `turn_start`.
 * - Answer text: one `assistant_message` per answer step (`api-assistant:<turn>[:<step>]`),
 *   written `streaming` at most once per `streamWriteMs` and `final` when the step closes. A
 *   step closes on `text_final`, before a tool or approval, and at the end of the turn.
 * - Tools: one `tool_call` row per finished tool (tool-row.ts), never through the MCP kernel.
 *   A tool still open when the turn ends is written as unfinished.
 * - Approvals: the shared `ApprovalGate` mints the id the renderer answers; the decision goes
 *   back to the engine through `answer(engineRequestId, outcome)`. Nothing is recorded.
 * - `error`: a `chat_error` (a fatal one makes the turn fail); `usage`: kept as the turn's
 *   latest totals; `turn_end` (or `finish`): `turn_end`, then the ledger's open turn is closed.
 *
 * Events are applied strictly in order; anything after the end is ignored.
 */
import { notifyChanged } from '../session/recorder.js';
import { appendEvent, MAX_USER_MESSAGE_CHARS, upsertMessageEvent } from '../session/store.js';
import type { AgentEngineId } from '../../shared/agent-engine.js';
import type { NewSessionEvent, StoredText, TurnOutcome } from '../../shared/session.js';
import type { ApprovalGate, ApprovalOutcome } from './approval.js';
import { updateChatRecord, withoutTurn } from './ledger.js';
import { engineToolEvent, type EngineToolActivity } from './tool-row.js';
import { assistantMessageId, MAX_ASSISTANT_CHARS, storedText, userMessageId } from './transcript.js';
import type { EngineEvent, EngineFileChange, EngineToolKind, EngineUsage } from './types.js';

const STREAM_WRITE_MS = 1_000;
/** Output kept in memory for one tool; the stored row is bounded again (with an overflow asset). */
const MAX_TOOL_OUTPUT_CHARS = 1_000_000;

export type ProjectedMessage = Extract<NewSessionEvent, { kind: 'user_message' | 'assistant_message' }>;

/** Where a projected turn is written. `storeProjectorSink` is the real one; tests record. */
export interface ProjectorSink {
  upsertMessage(event: ProjectedMessage): Promise<void>;
  append(event: NewSessionEvent): Promise<void>;
  storedText(text: string, cap: number): Promise<StoredText>;
  /** The ledger's open turn, written before `turn_start` so a crash after it is always closed. */
  openTurn(turnId: string, startedAt: number): Promise<void>;
  closeTurn(turnId: string): Promise<void>;
  changed(): void;
  now(): number;
}

export function storeProjectorSink(sessionId: string): ProjectorSink {
  return {
    upsertMessage: async event => { await upsertMessageEvent(sessionId, event as Parameters<typeof upsertMessageEvent>[1]); },
    append: async event => { await appendEvent(sessionId, event); },
    storedText: (text, cap) => storedText(sessionId, text, cap),
    openTurn: (turnId, startedAt) => updateChatRecord(sessionId, current => {
      if (!current) throw new Error('This chat has no engine record');
      return { ...current, openTurn: { turnId, startedAt } };
    }),
    closeTurn: turnId => updateChatRecord(sessionId, current => current?.openTurn?.turnId === turnId ? withoutTurn(current) : current),
    changed: () => notifyChanged(sessionId),
    now: () => Date.now()
  };
}

export interface TurnProjectorOptions {
  engine: AgentEngineId;
  conversationId: string;
  turnId: string;
  sink: ProjectorSink;
  approvals: { gate: ApprovalGate; answer(engineRequestId: string, outcome: ApprovalOutcome): void };
  streamWriteMs?: number;
  /** The first answer step's number: a turn re-attached after a restart continues after the steps already written. */
  firstStep?: number;
}

interface OpenTool {
  kind: EngineToolKind;
  name: string;
  input?: unknown;
  command?: string;
  cwd?: string;
  path?: string;
  files: EngineFileChange[];
  output: string;
  startedAt: number;
}

export class TurnProjector {
  private chain: Promise<void> = Promise.resolve();
  private step = 0;
  private text = '';
  private written = '';
  private lastWrite = 0;
  private readonly tools = new Map<string, OpenTool>();
  private fatal: string | null = null;
  private latestUsage: EngineUsage | null = null;
  private outcome: TurnOutcome | null = null;
  private readonly streamWriteMs: number;

  constructor(private readonly options: TurnProjectorOptions) {
    this.streamWriteMs = options.streamWriteMs ?? STREAM_WRITE_MS;
    this.step = Math.max(0, Math.floor(options.firstStep ?? 0));
  }

  get turnId(): string { return this.options.turnId; }
  get usage(): EngineUsage | null { return this.latestUsage ? { ...this.latestUsage } : null; }
  /** The turn's outcome once it ended, else null. */
  get ended(): TurnOutcome | null { return this.outcome; }

  /** Records the question and opens the turn. */
  start(question: string): Promise<void> {
    return this.serial(async () => {
      const { sink, turnId } = this.options;
      const startedAt = sink.now();
      await sink.openTurn(turnId, startedAt);
      await sink.upsertMessage({
        time: startedAt, source: 'app', kind: 'user_message', messageId: userMessageId(turnId),
        message: await sink.storedText(question, MAX_USER_MESSAGE_CHARS)
      });
      await sink.append({ time: sink.now(), source: 'app', kind: 'turn_start', turnId });
      sink.changed();
    });
  }

  apply(event: EngineEvent): Promise<void> {
    return this.serial(() => this.handle(event));
  }

  /** Ends the turn unless an event already did; settles open text, tools and approvals. */
  finish(outcome: TurnOutcome, detail?: string): Promise<TurnOutcome> {
    return this.serial(() => this.end(outcome, detail)).then(() => this.outcome ?? outcome);
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async handle(event: EngineEvent): Promise<void> {
    if (this.outcome) return;
    const { sink } = this.options;
    switch (event.type) {
      case 'text_delta':
        if (!event.delta) return;
        this.text += event.delta;
        if (sink.now() - this.lastWrite >= this.streamWriteMs) await this.writeText(false);
        return;
      case 'text_final':
        if (event.text !== undefined) this.text = event.text;
        await this.closeText();
        return;
      case 'tool_started': {
        await this.closeText();
        const open = this.tools.get(event.toolId);
        this.tools.set(event.toolId, {
          kind: event.kind, name: event.name, input: event.input ?? open?.input, command: event.command ?? open?.command,
          cwd: event.cwd ?? open?.cwd, path: event.path ?? open?.path, files: event.files ?? open?.files ?? [],
          output: open?.output ?? '', startedAt: open?.startedAt ?? sink.now()
        });
        return;
      }
      case 'tool_output': {
        const open = this.tools.get(event.toolId);
        if (open && open.output.length < MAX_TOOL_OUTPUT_CHARS) open.output = (open.output + event.chunk).slice(0, MAX_TOOL_OUTPUT_CHARS);
        return;
      }
      case 'tool_finished': {
        await this.closeText();
        const open = this.tools.get(event.toolId) ?? { kind: 'other' as const, name: event.toolId, files: [], output: '', startedAt: sink.now() };
        this.tools.delete(event.toolId);
        await this.writeTool(event.toolId, open, {
          status: event.status, exitCode: event.exitCode, output: event.output ?? open.output,
          files: event.files ?? open.files, error: event.error
        });
        return;
      }
      case 'approval_requested': {
        await this.closeText();
        const { gate, answer } = this.options.approvals;
        void gate.request({
          turnId: this.options.turnId, toolCallId: event.toolId ?? event.requestId, tool: event.tool, summary: event.summary,
          files: event.files, action: event.action, engineRequestId: event.requestId
        }, sink.now()).then(outcome => answer(event.requestId, outcome));
        return;
      }
      case 'approval_resolved':
        this.options.approvals.gate.dismiss(event.requestId);
        return;
      case 'usage': {
        const previous = this.latestUsage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
        const count = (value: number | undefined, fallback: number): number => Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : fallback;
        this.latestUsage = {
          inputTokens: count(event.inputTokens, previous.inputTokens), outputTokens: count(event.outputTokens, previous.outputTokens),
          cachedInputTokens: count(event.cachedInputTokens, previous.cachedInputTokens), reasoningTokens: count(event.reasoningTokens, previous.reasoningTokens)
        };
        return;
      }
      case 'error':
        await this.closeText();
        if (event.fatal) this.fatal = event.message;
        await sink.append({
          time: sink.now(), source: 'app', kind: 'chat_error', turnId: this.options.turnId, recoverable: !event.fatal,
          message: await sink.storedText(event.message, 2000)
        });
        sink.changed();
        return;
      case 'turn_end':
        await this.end(event.outcome, event.detail);
        return;
    }
  }

  private async writeText(final: boolean): Promise<void> {
    const { sink, turnId } = this.options;
    const text = this.text;
    if (!text || (!final && text === this.written)) return;
    this.written = text;
    this.lastWrite = sink.now();
    await sink.upsertMessage({
      time: sink.now(), source: 'app', kind: 'assistant_message', turnId, messageId: assistantMessageId(turnId, this.step),
      message: await sink.storedText(text, MAX_ASSISTANT_CHARS), state: final ? 'final' : 'streaming', final
    });
    sink.changed();
  }

  /** Settles the current answer step; the next text opens a new one. */
  private async closeText(): Promise<void> {
    if (!this.text) return;
    await this.writeText(true);
    this.step++;
    this.text = '';
    this.written = '';
    this.lastWrite = 0;
  }

  private async writeTool(toolId: string, open: OpenTool, finish: Pick<EngineToolActivity, 'status' | 'exitCode' | 'output' | 'files' | 'error'>): Promise<void> {
    const { sink, engine, conversationId, turnId } = this.options;
    const activity: EngineToolActivity = {
      engine, conversationId, turnId, toolId, kind: open.kind, name: open.name, input: open.input, command: open.command,
      cwd: open.cwd, path: open.path, startedAt: open.startedAt, finishedAt: sink.now(), ...finish
    };
    await sink.append(await engineToolEvent(activity, (text, cap) => sink.storedText(text, cap)));
    sink.changed();
  }

  private async end(requested: TurnOutcome, detail?: string): Promise<void> {
    if (this.outcome) return;
    const outcome = this.fatal && requested === 'completed' ? 'failed' : requested;
    this.outcome = outcome;
    const { sink, turnId, approvals } = this.options;
    approvals.gate.stop();
    await this.closeText();
    for (const [toolId, open] of [...this.tools]) {
      this.tools.delete(toolId);
      await this.writeTool(toolId, open, { status: 'unfinished', output: open.output, files: open.files });
    }
    await sink.append({ time: sink.now(), source: 'app', kind: 'turn_end', turnId, outcome, ...(detail ? { detail } : {}) });
    await sink.closeTurn(turnId);
    sink.changed();
  }
}
