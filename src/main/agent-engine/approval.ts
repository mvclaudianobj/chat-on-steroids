/**
 * The approval binding every engine shares. The app mints the approval id (a UUID the renderer
 * answers), binds it to the sha256 of the canonical action it showed, and keeps it in process
 * memory only: a restart never leaves an approval that could be answered. An engine's own
 * request id (a Codex JSON-RPC id, a Claude `request_id`, a MarksCode permission id) is kept
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
  engineRequestId: string | null;
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
  private closed = false;

  constructor(private readonly onChange: () => void = () => undefined) {}

  /** Waits for the answer. After `stop()` it answers `stop` at once. */
  request(input: ApprovalRequest, now = Date.now()): Promise<ApprovalOutcome> {
    if (this.closed) return Promise.resolve('stop');
    return new Promise(resolve => {
      const entry: Entry = {
        view: {
          approvalId: randomUUID(), turnId: input.turnId, toolCallId: input.toolCallId, tool: input.tool,
          summary: clip(input.summary, MAX_SUMMARY_CHARS), files: (input.files ?? []).slice(0, MAX_FILES).map(file => clip(file, 300)),
          requestedAt: now
        },
        hash: argsHash(input.tool, input.action),
        engineRequestId: input.engineRequestId ?? null,
        resolve: outcome => {
          const index = this.entries.indexOf(entry);
          if (index < 0) return;
          this.entries.splice(index, 1);
          this.onChange();
          resolve(outcome);
        }
      };
      this.entries.push(entry);
      this.onChange();
    });
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

/** MarksCode `permission/:id/reply`. */
export function marksCodeApprovalDecision(outcome: ApprovalOutcome): 'once' | 'always' | 'reject' | null {
  return outcome === 'approve' ? 'once' : outcome === 'always' ? 'always' : outcome === 'deny' || outcome === 'stop' ? 'reject' : null;
}
