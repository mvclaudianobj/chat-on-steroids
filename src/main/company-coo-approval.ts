/**
 * marks-coo answers ChatGPT's tool approval card for the Company's own chats (P0, 2026-10-29).
 *
 * The CEO switches it on in Company settings (`cooHostApproval` in company.json, off by default)
 * behind a native confirmation. While it is on, a card that approval-wait.ts reports in a chat the
 * Company provably owns gets Allow once through the same exact-card answer a person's click files
 * (`requestApprovalAnswer`), and the page is woken to press it. Nothing else is answered:
 *
 * - Ownership is exact: the chat's conversation id is the one the broker recorded on exactly one
 *   live, admitted or running ticket, or the verified delegated chief's binding. No title or seat
 *   name is read. A chat no Company record names is the person's own and is left alone; one that
 *   several records, or an inactive ticket, name is held for the CEO.
 * - A card whose words match a CEO risk term, whose words may be cut off, or whose Allow once
 *   ChatGPT disabled is held for the CEO, who is told through the notification center.
 * - Every decision is one audit row (who, when, tool, chat, session, card id and fingerprint).
 * - Revocation or any policy change cancels every answer no page has taken yet.
 */
import { createHash } from 'node:crypto';
import type { ApprovalCardView } from '../shared/approval-wait.js';
import type { CompanySnapshot, CooHostApprovalAudit } from '../shared/company.js';
import { approvalCardView, approvalDecisionStatus, approvalWaitingChats, requestApprovalAnswer, withdrawApprovalAnswer } from './approval-wait.js';
import { wakeApprovalConversation } from './browser-wake.js';
import { getCompany, mutateCompany } from './company-store.js';
import { logInfo } from './logger.js';
import { queueOutboundNotice } from './notification-center.js';
import { redactSecretText } from './redaction.js';
import { findSessionByConversation } from './session/store.js';

export type CooApprovalOwner =
  | { kind: 'owned'; requestId: string | null; seat: string | null }
  | { kind: 'ambiguous'; reason: string; requestId: string | null; seat: string | null };

/** Which Company record owns this exact conversation; null when none names it. */
export function companyApprovalOwner(snapshot: CompanySnapshot, conversationId: string, now = Date.now()): CooApprovalOwner | null {
  if (snapshot.demo || !conversationId) return null;
  const tickets = snapshot.requests.filter(request => request.execution?.conversationId === conversationId);
  const binding = snapshot.delegation.mode === 'delegated' ? snapshot.delegation.binding : null;
  const chief = binding?.conversationId === conversationId ? binding : null;
  if (!tickets.length && !chief) return null;
  if (tickets.length + (chief ? 1 : 0) > 1)
    return { kind: 'ambiguous', reason: 'several Company records name this chat', requestId: null, seat: null };
  if (chief) {
    return chief.expiresAt > now ? { kind: 'owned', requestId: null, seat: chief.seat }
      : { kind: 'ambiguous', reason: 'the chief binding expired', requestId: null, seat: chief.seat };
  }
  const ticket = tickets[0]!;
  const execution = ticket.execution!;
  const live = execution.mode === 'live' && (execution.phase === 'admitted' || execution.phase === 'running') &&
    !!execution.ownerId && !!execution.runId && !!execution.workerId && !!ticket.seat && ticket.status !== 'done';
  return live ? { kind: 'owned', requestId: ticket.id, seat: ticket.seat }
    : { kind: 'ambiguous', reason: `the ticket is ${execution.phase}, not an active worker`, requestId: ticket.id, seat: ticket.seat };
}

/** The first risk term the card's words contain, matched case-insensitively at a word start. */
export function cooApprovalRisk(lines: readonly string[], terms: readonly string[]): string | null {
  const text = lines.join('\n').toLowerCase();
  for (const raw of terms) {
    const term = raw.trim().toLowerCase();
    if (term.length < 2) continue;
    for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
      // "rm -r" must not match "form -r"; "delete" still matches "deleted" and "fs_delete".
      if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!) || !/^[a-z0-9]/.test(term)) return term;
    }
  }
  return null;
}

/** The page keeps at most 8 lines of 300 characters: a card at either bound may hide its words. */
export function cooApprovalCardTruncated(lines: readonly string[]): boolean {
  return lines.length === 0 || lines.length >= 8 || lines.some(line => line.length >= 300);
}

export function cooApprovalFingerprint(lines: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex').slice(0, 16);
}

/** The tool the card names, for the audit; a snake_case or dotted identifier, else its first line. */
export function cooApprovalTool(lines: readonly string[]): string {
  for (const line of lines) {
    const match = /\b[a-z][a-z0-9]*(?:[_.][a-z0-9]+)+\b/i.exec(line);
    if (match) return match[0].slice(0, 80);
  }
  return (lines[0] ?? 'unknown tool').slice(0, 80) || 'unknown tool';
}

export interface CooApprovalDeps {
  company(): Promise<CompanySnapshot>;
  /** mutateCompany('cooHostAudit'); rejects an `allowed` row whose epoch is no longer the enabled one. */
  audit(entry: CooHostApprovalAudit): Promise<unknown>;
  card(conversationId: string): ApprovalCardView | null;
  answer(conversationId: string, cardId: string): { ok: true; token: string } | { ok: false; error: string };
  status(conversationId: string, cardId: string): string | null;
  withdraw(conversationId: string, token: string): boolean;
  wake(conversationId: string): void;
  session(conversationId: string): Promise<string | null>;
  /** The CEO hears of a held card once, through the notification center. */
  notify(title: string, excerpt: string, dedupeKey: string): void;
  redact(text: string): string;
  log(message: string): void;
}

const FOREIGN_RECHECK_MS = 60_000;
interface Pending { conversationId: string; cardId: string; token: string; entry: CooHostApprovalAudit }

export function createCooHostApprover(deps: CooApprovalDeps): {
  consider(conversationId: string): Promise<void>;
  revoke(reason: string): Promise<number>;
  pending(): number;
} {
  /** An answer filed and not yet reported on by its page, by conversation. */
  const pending = new Map<string, Pending>();
  /** Cards already decided in this run, so a standing card is decided once. */
  const decided = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  /** Cards in chats no Company record named, until they are worth reading company.json again. */
  const foreign = new Map<string, number>();
  /** Bumped by `revoke`: a decision that started under an older generation sends nothing. */
  let generation = 0;
  const key = (conversationId: string, cardId: string) => `${conversationId}\n${cardId}`;

  const write = async (entry: CooHostApprovalAudit): Promise<boolean> => {
    try { await deps.audit(entry); return true; }
    catch (error) { deps.log(`company: COO host approval audit refused for ${entry.conversationId}: ${(error as Error).message}`); return false; }
  };

  const settle = async (conversationId: string): Promise<void> => {
    const filed = pending.get(conversationId);
    if (!filed) return;
    const status = deps.status(conversationId, filed.cardId);
    if (status === 'pending') return;
    pending.delete(conversationId);
    const decision = status === 'clicked' ? 'clicked' : status === 'dismissed' ? 'dismissed' : 'unconfirmed';
    await write({ ...filed.entry, at: Date.now(), decision, reason: status ? `page reported ${status}` : 'no page report' });
  };

  const decide = async (conversationId: string): Promise<void> => {
    await settle(conversationId);
    if (pending.has(conversationId)) return;
    const card = deps.card(conversationId);
    if (!card || decided.has(key(conversationId, card.id)) || (foreign.get(key(conversationId, card.id)) ?? 0) > Date.now()) return;
    // A person's own answer for this card is already on its way.
    if (card.answer && card.answer.outcome === null) return;
    const started = generation;
    const snapshot = await deps.company();
    const policy = snapshot.cooHostApproval;
    if (!policy.enabled || snapshot.demo || started !== generation) return;
    const owner = companyApprovalOwner(snapshot, conversationId);
    if (!owner) {
      // The person's own chat: its standing card polls often, so look again only after a while.
      foreign.set(key(conversationId, card.id), Date.now() + FOREIGN_RECHECK_MS);
      if (foreign.size > 500) foreign.delete(foreign.keys().next().value!);
      return;
    }
    // The card may have been replaced while the company was read.
    const current = deps.card(conversationId);
    if (!current || current.id !== card.id || started !== generation) return;
    decided.add(key(conversationId, card.id));
    if (decided.size > 500) decided.delete(decided.values().next().value!);
    const tool = deps.redact(cooApprovalTool(card.lines)).slice(0, 80) || 'unknown tool';
    const entry: CooHostApprovalAudit = {
      at: Date.now(), actor: 'marks-coo', conversationId: conversationId.slice(0, 160),
      sessionId: (await deps.session(conversationId).catch(() => null))?.slice(0, 160) ?? null,
      requestId: owner.requestId, seat: owner.seat as CooHostApprovalAudit['seat'], cardId: card.id.slice(0, 64),
      fingerprint: cooApprovalFingerprint(card.lines), tool, decision: 'allowed', reason: 'exact Company ownership', epoch: policy.epoch
    };
    const risk = cooApprovalRisk(card.lines, policy.riskTerms);
    const hold = owner.kind === 'ambiguous' ? { decision: 'held-unattributed' as const, reason: owner.reason }
      : !card.allow ? { decision: 'held-unavailable' as const, reason: 'ChatGPT disabled Allow once' }
      : risk ? { decision: 'held-risk' as const, reason: `matches CEO risk term "${risk}"` }
      : cooApprovalCardTruncated(card.lines) ? { decision: 'held-risk' as const, reason: 'the card text may be cut off' }
      : null;
    if (hold) {
      const held = { ...entry, ...hold, reason: deps.redact(hold.reason).slice(0, 160) };
      deps.log(`company: COO left the tool approval in ${conversationId} for the CEO (${held.decision}: ${held.reason})`);
      await write(held);
      deps.notify('COO held a tool approval for the CEO', `${owner.seat ?? 'Company chat'} · ${tool} · ${held.reason}`,
        `coo-hold:${conversationId}:${card.id}`);
      return;
    }
    // The store checks the epoch under its own queue; a revocation in between refuses the row.
    if (!await write(entry) || started !== generation) return;
    const answer = deps.answer(conversationId, card.id);
    if (!answer.ok) {
      await write({ ...entry, at: Date.now(), decision: 'unconfirmed', reason: `answer not filed: ${answer.error}` });
      return;
    }
    pending.set(conversationId, { conversationId, cardId: card.id, token: answer.token, entry });
    deps.log(`company: marks-coo allowed ${tool} in ${conversationId} (${owner.seat ?? 'chief'}, epoch ${policy.epoch})`);
    deps.wake(conversationId);
  };

  return {
    /** One activity poll's chance to decide the card in this chat; serialized per chat. */
    consider(conversationId) {
      const next = (chains.get(conversationId) ?? Promise.resolve()).then(() => decide(conversationId))
        .catch(error => deps.log(`company: COO host approval failed for ${conversationId}: ${(error as Error).message}`));
      chains.set(conversationId, next);
      void next.finally(() => { if (chains.get(conversationId) === next) chains.delete(conversationId); });
      return next;
    },
    /** Synchronously stops new answers, then withdraws every answer no page took yet. */
    async revoke(reason) {
      generation++;
      decided.clear();
      foreign.clear();
      const filed = [...pending.values()];
      pending.clear();
      // Every withdrawal happens before the first await: none waits behind an audit write.
      const results = filed.map(row => ({ row, withdrawn: deps.withdraw(row.conversationId, row.token) }));
      for (const { row, withdrawn } of results) {
        await write({ ...row.entry, at: Date.now(), decision: withdrawn ? 'revoked' : 'unconfirmed',
          reason: withdrawn ? reason.slice(0, 160) : 'already taken by the page before revocation' });
      }
      return results.filter(result => result.withdrawn).length;
    },
    pending: () => pending.size
  };
}

let shared: ReturnType<typeof createCooHostApprover> | null = null;
/** The app's one approver, with the real owners wired in. */
export function cooHostApprover(): ReturnType<typeof createCooHostApprover> {
  shared ??= createCooHostApprover({
    company: getCompany,
    audit: entry => mutateCompany('cooHostAudit', entry),
    card: conversationId => approvalCardView(conversationId),
    answer: (conversationId, cardId) => requestApprovalAnswer(conversationId, cardId, 'allow'),
    status: (conversationId, cardId) => approvalDecisionStatus(conversationId, cardId),
    withdraw: withdrawApprovalAnswer,
    wake: wakeApprovalConversation,
    session: async conversationId => (await findSessionByConversation(conversationId, { requireUnique: true }))?.id ?? null,
    notify: (title, excerpt, dedupeKey) => void queueOutboundNotice({ event: 'approval-pending', title, project: 'Chat Marks', excerpt, dedupeKey })
      .catch(() => undefined),
    redact: redactSecretText,
    log: logInfo
  });
  return shared;
}

/** Every chat whose card stands now, for a policy that was just switched on. */
export async function sweepCooHostApprovals(): Promise<void> {
  const approver = cooHostApprover();
  await Promise.all(approvalWaitingChats().map(conversationId => approver.consider(conversationId)));
}
