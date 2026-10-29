/** Retention for *local* archived sessions. Deletion is supplied by the same safe path as manual Delete. */
import { agentInfoForOwnedConversation } from '../agents.js';
import { approvalWaitingChats } from '../approval-wait.js';
import { sessionInputActivity, sessionActivityExpiresAt } from '../bridge.js';
import { getCompany } from '../company-store.js';
import { getConfig } from '../config.js';
import { logInfo, logWarn } from '../logger.js';
import type { SessionSummary } from '../../shared/session.js';
import { listInputs } from './input.js';
import { getSession, indexedSessions } from './store.js';

const DAY_MS = 86_400_000;
let running = false;

export function eligibleArchivedSession(session: SessionSummary, now: number, days: number): boolean {
  return Number.isInteger(days) && days > 0 && session.archivedAt !== undefined &&
    Number.isFinite(session.archivedAt) && session.archivedAt > 0 &&
    Number.isFinite(session.updatedAt) &&
    session.archivedAt <= now - days * DAY_MS &&
    session.updatedAt <= now - days * DAY_MS &&
    !session.activeTurnId && session.origin?.kind !== 'worker' &&
    session.origin?.kind !== 'helper';
}

export interface ArchiveRetentionSweep {
  now: number;
  retentionDays: number;
  /** Renderer must first migrate its existing localStorage pins to durable main-owned configuration. */
  pinnedReady: boolean;
  pinnedIds: readonly string[];
  sessions: () => Promise<SessionSummary[]>;
  /** Live metadata and activity can change while scanning. */
  readSession?: (id: string) => Promise<SessionSummary | null>;
  protectedConversation: (conversationId: string) => Promise<boolean>;
  isBusy: (session: SessionSummary) => Promise<boolean>;
  deleteSafely: (id: string) => Promise<void>;
  log: (line: string) => void;
}

/** One bounded pass: each candidate is checked again just before the deletion hook. */
export async function sweepArchivedSessions(options: ArchiveRetentionSweep): Promise<number> {
  if (!options.pinnedReady || options.retentionDays === 0) return 0;
  const pins = new Set(options.pinnedIds);
  let deleted = 0;
  for (const candidate of await options.sessions()) {
    if (pins.has(candidate.id) || !eligibleArchivedSession(candidate, options.now, options.retentionDays)) continue;
    const current = options.readSession ? await options.readSession(candidate.id) : candidate;
    if (!current || pins.has(current.id) || !eligibleArchivedSession(current, options.now, options.retentionDays)) continue;
    if ((current.conversationId && await options.protectedConversation(current.conversationId)) ||
        await options.isBusy(current)) continue;
    try {
      await options.deleteSafely(current.id);
      options.log(`archive retention: deleted session ${current.id} after ${options.retentionDays} days`);
      deleted += 1;
    } catch (error) {
      logWarn(`archive retention: could not delete ${current.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return deleted;
}

/**
 * Called by app lifecycle after IPC has registered its safe delete path.
 * UI pin migration is a hard prerequisite: a headless start cannot infer localStorage pins.
 */
export async function runArchiveRetentionSweep(deleteSafely: (id: string) => Promise<void>): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const config = getConfig().ui;
    return await sweepArchivedSessions({
      now: Date.now(),
      retentionDays: config.archiveRetentionDays ?? 30,
      pinnedReady: config.archiveRetentionPinsReady === true,
      pinnedIds: config.archiveRetentionPins ?? [],
      sessions: indexedSessions,
      readSession: getSession,
      protectedConversation: async conversationId => {
        const agent = agentInfoForOwnedConversation(conversationId);
        if (agent) return true; // Workers, prime ownership, and waking assignments remain preserved.
        const company = await getCompany();
        return !company.demo &&
          (company.delegation.binding?.conversationId === conversationId ||
            company.requests.some(request => request.execution?.conversationId === conversationId));
      },
      isBusy: async session => {
        const chatId = session.conversationId;
        if (sessionInputActivity(session).possible || (sessionActivityExpiresAt(session) ?? 0) > Date.now() ||
            (chatId && approvalWaitingChats().includes(chatId))) return true;
        const rows = await listInputs();
        return rows.some(row =>
          (row.sessionId === session.id || row.deliveredSessionId === session.id ||
            (!!chatId && row.conversationId === chatId)) &&
          (!['sent', 'cancelled', 'failed'].includes(row.state) ||
            (row.state === 'sent' && row.deliveredAt === undefined) ||
            (row.state === 'cancelled' && row.sendAuthorizedAt && !row.deliveredAt)));
      },
      deleteSafely: async id => {
        // Settings and pins may change during an asynchronous scan; recheck
        // immediately before entering the shared destructive path.
        const latest = getConfig().ui;
        if (latest.archiveRetentionPinsReady !== true || (latest.archiveRetentionDays ?? 30) === 0 ||
            (latest.archiveRetentionPins ?? []).includes(id)) throw new Error('retention settings or pins changed during scan');
        await deleteSafely(id);
      },
      log: logInfo
    });
  } finally {
    running = false;
  }
}
