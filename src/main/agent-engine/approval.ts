/**
 * The approval binding every engine shares. The app mints the approval id (a UUID the renderer
 * answers), binds it to the sha256 of the canonical action it showed, and keeps it in process
 * memory only: a restart never leaves an approval that could be answered. An engine's own
 * request id (a Codex JSON-RPC id, a Claude `request_id`, an OpenCode permission id) is kept
 * beside it so the engine answers exactly the request the user saw; the renderer never sees it.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ApiChatApprovalDecision, ApiChatPendingApproval } from '../../shared/api-chat.js';

const MAX_SUMMARY_CHARS = 600;
const MAX_FILES = 20;

/** The user's answer, `stop` when the turn ended first, `resolved` when the engine settled it elsewhere (its own TUI). */
export type ApprovalOutcome = ApiChatApprovalDecision | 'stop' | 'resolved';

export interface ApprovalRequest {
  turnId: string;
  /** The tool call the approval is for, as the engine names it. */
  toolCallId: string;
  tool: string;
  summary: string;
  files?: readonly string[];
  /** The exact action shown (arguments, command and cwd, or changes); its hash binds the answer. */
  action: unknown;
  /** The engine's own request id, when it has one. */
  engineRequestId?: string;
}

interface Entry {
  view: ApiChatPendingApproval;
  hash: string;
  identity: string;
  engineRequestId: string | null;
  pending: Promise<ApprovalOutcome>;
  resolve(outcome: ApprovalOutcome): void;
}

/** Stable JSON with sorted keys: the exact action an approval is bound to. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const argsHash = (name: string, args: unknown): string =>
  createHash('sha256').update(`${name}\n${canonicalJson(args)}`).digest('hex');

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}…` : text;

/** One running turn's pending approvals, oldest first; the renderer is shown the oldest. */
export class ApprovalGate {
  private readonly entries: Entry[] = [];
  /** Exact retransmissions of an already decided engine request must not ask again. This
   * cache is only for this running turn, never a grant for a later tool call or restart. */
  private readonly decided = new Map<string, { hash: string; outcome: ApiChatApprovalDecision }>();
  private closed = false;

  constructor(private readonly onChange: () => void = () => undefined) {}

  /** Waits for the answer. After `stop()` it answers `stop` at once. */
  request(input: ApprovalRequest, now = Date.now()): Promise<ApprovalOutcome> {
    if (this.closed) return Promise.resolve('stop');
    const identity = JSON.stringify([input.turnId, input.toolCallId, input.engineRequestId ?? null]);
    const hash = argsHash(input.tool, input.action);
    const already = this.decided.get(identity);
    if (already && already.hash === hash) return Promise.resolve(already.outcome);
    const duplicate = this.entries.find(entry => entry.identity === identity);
    if (duplicate?.hash === hash) return duplicate.pending;
    // A provider may reuse an RPC id after changing its action. Withdraw the earlier
    // prompt instead of letting an old approval authorize the replacement.
    if (duplicate) duplicate.resolve('resolved');
    let settle!: (outcome: ApprovalOutcome) => void;
    const pending = new Promise<ApprovalOutcome>(resolve => { settle = resolve; });
    const entry: Entry = {
      view: {
        approvalId: randomUUID(), turnId: input.turnId, toolCallId: input.toolCallId, tool: input.tool,
        summary: clip(input.summary, MAX_SUMMARY_CHARS), files: (input.files ?? []).slice(0, MAX_FILES).map(file => clip(file, 300)),
        requestedAt: now
      },
      hash, identity, pending,
      engineRequestId: input.engineRequestId ?? null,
      resolve: outcome => {
        const index = this.entries.indexOf(entry);
        if (index < 0) return;
        this.entries.splice(index, 1);
        if (outcome === 'approve' || outcome === 'deny' || outcome === 'always') {
          // An engine's retry of the *same* request gets the explicit answer. Never
          // reuse it for a new toolCallId, turn, or changed action.
          this.decided.delete(identity);
          this.decided.set(identity, { hash, outcome });
          if (this.decided.size > 128) this.decided.delete(this.decided.keys().next().value!);
        }
        this.onChange();
        settle(outcome);
      }
    };
    this.entries.push(entry);
    this.onChange();
    return pending;
  }

  /** Whether that exact approval id is pending now. */
  has(approvalId: string): boolean {
    return this.entries.some(entry => entry.view.approvalId === approvalId);
  }

  /** The hash the approval was bound to, while it is pending. */
  hashOf(approvalId: string): string | null {
    return this.entries.find(entry => entry.view.approvalId === approvalId)?.hash ?? null;
  }

  /** The engine's own request id behind that approval, while it is pending (main-side only). */
  engineRequestOf(approvalId: string): string | null {
    return this.entries.find(entry => entry.view.approvalId === approvalId)?.engineRequestId ?? null;
  }

  /** Answers only that exact id; a stale, answered or unknown id answers false. */
  answer(approvalId: string, decision: ApiChatApprovalDecision): boolean {
    const entry = this.entries.find(item => item.view.approvalId === approvalId);
    if (!entry) return false;
    entry.resolve(decision);
    return true;
  }

  /** The engine settled its own request (answered in its TUI, or withdrawn): the card goes. */
  dismiss(engineRequestId: string): boolean {
    const entry = this.entries.find(item => item.engineRequestId === engineRequestId);
    if (!entry) return false;
    entry.resolve('resolved');
    return true;
  }

  /** The turn ended: every pending approval answers `stop` and no new one waits. */
  stop(): void {
    this.closed = true;
    for (const entry of [...this.entries]) entry.resolve('stop');
    this.decided.clear();
  }

  view(): ApiChatPendingApproval | null {
    const first = this.entries[0];
    return first ? { ...first.view, files: [...first.view.files] } : null;
  }
}

/** Codex app-server: the JSON-RPC result of `item/*\/requestApproval`; null means do not answer. */
export function codexApprovalDecision(outcome: ApprovalOutcome): 'accept' | 'acceptForSession' | 'decline' | 'cancel' | null {
  return outcome === 'approve' ? 'accept' : outcome === 'always' ? 'acceptForSession' : outcome === 'deny' ? 'decline' : outcome === 'stop' ? 'cancel' : null;
}

/** Claude Code `can_use_tool`: the control_response body; allow passes the input that was shown. */
export function claudeApprovalDecision(outcome: ApprovalOutcome, shownInput: Record<string, unknown>):
  { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string } | null {
  if (outcome === 'approve' || outcome === 'always') return { behavior: 'allow', updatedInput: shownInput };
  if (outcome === 'deny') return { behavior: 'deny', message: 'The user declined this action. It was not run.' };
  return outcome === 'stop' ? { behavior: 'deny', message: 'The user stopped this turn.' } : null;
}

/**
 * OpenCode 2.x `POST /api/session/:id/permission/:request/reply`. "Always" is answered `once`
 * upstream: OpenCode's own `always` saves an allow rule for the whole project (every session,
 * across restarts, beating a session's `ask`); the engine switches this chat to Auto instead.
 * Stop sends nothing: `interrupt` settles the run's pending requests itself.
 */
export function openCodeApprovalDecision(outcome: ApprovalOutcome): 'once' | 'reject' | null {
  return outcome === 'approve' || outcome === 'always' ? 'once' : outcome === 'deny' ? 'reject' : null;
}
