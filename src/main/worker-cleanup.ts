/**
 * Explicit owner-authorized retirement of a worker fleet. This is not Clear swarm:
 * the prime, worker recordings, broker reports and Git checkouts remain available.
 */
import { ownedWorkerFleet, persistAgentAuthorityNow, retireOwnedWorkerFleet,
  managedWorktreeCleanupOffers } from './agents.js';
import { sessionControlsFor, sessionInputActivity, stopSessionTurn } from './bridge.js';
import { approvalWaitingChats } from './approval-wait.js';
import { getConfig } from './config.js';
import { readLocalCompanyGrants, revokeLocalCompanyGrant } from './company-local-grants.js';
import { logInfo, logWarn } from './logger.js';
import { revokeVaultChat } from './marks-vault-approval.js';
import { revokeRemoteChat } from './remote/approval.js';
import { cancelWorkerCommands } from './bridge.js';
import { archiveSessionLocally } from './session/local-archive.js';
import { cancelSessionInputs } from './session/input.js';
import { appendEvent, findSessionByConversation, getSession } from './session/store.js';
import { queueWorkerArchives, workerArchiveWritten } from './worker-archive.js';
import { listOfferedWorkerWorktrees } from './worktrees/index.js';

/** A page-less recorded start needs five minutes of silence before local stop is justified. */
export const WORKER_ORPHAN_MIN_AGE_MS = 5 * 60_000;

export function orphanWorkerTurnEligible(
  summary: { activeTurnId?: string | null; updatedAt: number; lastToolCallAt?: number | null; finishTurn?: { startedAt: number } | null },
  controls: { activeTurnId?: string | null; heldTurnId?: string | null; pageless?: boolean },
  activity: { possible: boolean }, approvalWaiting: boolean, now = Date.now()
): boolean {
  return Boolean(summary.activeTurnId &&
    !controls.activeTurnId && !controls.heldTurnId && !activity.possible && !approvalWaiting &&
    now - Math.max(summary.updatedAt, summary.lastToolCallAt ?? 0, summary.finishTurn?.startedAt ?? 0) >= WORKER_ORPHAN_MIN_AGE_MS);
}

export type WorkerCleanupOwner = { conversationId?: string; localOwnerId?: string; setupProfileId?: string };
export interface WorkerCleanupReport {
  owner: string;
  workers: number;
  retired: number;
  archived: number;
  stoppedLocally: number;
  stopRequested: number;
  pending: Array<{ worker: string; reason: string }>;
  dirtyWorktrees: Array<{ runId: string; agentId: string; workspace: string }>;
}

/** Only the exact broker owner is allowed to batch-retire its workers. */
export async function archiveAllOwnedWorkers(owner: WorkerCleanupOwner): Promise<WorkerCleanupReport> {
  if (Boolean(owner.conversationId) === Boolean(owner.localOwnerId))
    throw new Error('An exact worker owner is required');
  const fleet = ownedWorkerFleet(owner);
  const report: WorkerCleanupReport = { owner: owner.conversationId ?? owner.localOwnerId!, workers: fleet.length,
    retired: 0, archived: 0, stoppedLocally: 0, stopRequested: 0, pending: [], dirtyWorktrees: [] };
  if (!fleet.length) return report;

  // Commit the terminal worker authority first. A stale tab must not obtain a fresh worker
  // command or send another broker message while a slow session archive is being written.
  report.retired = retireOwnedWorkerFleet(owner);
  if (!await persistAgentAuthorityNow()) throw new Error('Worker retirement was not durable');
  for (const runId of new Set(fleet.map(worker => worker.runId))) cancelWorkerCommands('owner requested archive of all workers', undefined, runId);

  for (const worker of fleet) {
    try {
      if (!worker.conversationId) {
        report.pending.push({ worker: worker.id, reason: 'No ChatGPT conversation was assigned; broker slot retired' });
        continue;
      }
      const chatId = worker.conversationId;
      const session = await findSessionByConversation(chatId, { requireUnique: true });
      if (!session || session.origin?.kind !== 'worker' || session.origin.agentId !== worker.id) {
        report.pending.push({ worker: worker.id, reason: 'Worker session ownership cannot be verified' });
        continue;
      }
      // Revoke authority only after verifying the exact session and worker provenance.
      // A damaged/stale broker record must never revoke grants for a foreign chat.
      revokeVaultChat(chatId);
      revokeRemoteChat(chatId);
      const grants = await readLocalCompanyGrants();
      for (const grant of grants.grants) {
        if (grant.subject.kind === 'worker' && grant.subject.conversationId === chatId)
          await revokeLocalCompanyGrant(grant.id);
      }
      await cancelSessionInputs(session.id);
      const current = await getSession(session.id);
      if (!current || current.conversationId !== chatId) {
        report.pending.push({ worker: worker.id, reason: 'Session binding changed' });
        continue;
      }
      if (current.activeTurnId) {
        const controls = await sessionControlsFor(session.id);
        if (orphanWorkerTurnEligible(current, controls, sessionInputActivity(current),
          approvalWaitingChats().includes(chatId))) {
          // App-authored, audited local terminal event: not a claim that ChatGPT confirmed Stop.
          // The append-only journal is persisted before the summary is eligible for archive.
          await appendEvent(session.id, { kind: 'turn_end', source: 'app', time: Date.now(),
            turnId: current.activeTurnId, outcome: 'stopped',
            detail: 'Owner explicitly retired this page-less worker after five minutes of inactivity. Local stop; provider confirmation unavailable.' });
          report.stoppedLocally++;
          logInfo(`worker cleanup: durable local stop for worker ${worker.id}, session ${session.id}, turn ${current.activeTurnId}`);
        } else if (controls.activeTurnId === current.activeTurnId || controls.heldTurnId === current.activeTurnId) {
          try {
            await stopSessionTurn(session.id, current.activeTurnId);
            report.stopRequested++;
          } catch (error) {
            logWarn(`worker cleanup: native stop unavailable for worker ${worker.id}: ${String(error)}`);
          }
          report.pending.push({ worker: worker.id, reason: 'Native Stop requested or still in progress; archive after confirmed end' });
          continue;
        } else {
          report.pending.push({ worker: worker.id, reason: 'Turn is not yet eligible for a safe local stop' });
          continue;
        }
      }
      try {
        await archiveSessionLocally(session.id, true);
        report.archived++;
        // Explicit user intent is independent of the automatic archive-on-finish preference.
        queueWorkerArchives([chatId], Date.now(), 0, true);
      } catch (error) {
        report.pending.push({ worker: worker.id, reason: error instanceof Error ? error.message : 'Local archive unavailable' });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      report.pending.push({ worker: worker.id, reason });
      logWarn(`worker cleanup: failed to process ${worker.id} safely: ${reason}`);
    }
  }
  await workerArchiveWritten();
  try {
    const offers = await listOfferedWorkerWorktrees(getConfig().roots, managedWorktreeCleanupOffers());
    report.dirtyWorktrees = offers.filter(offer => offer.dirty).map(offer => ({
      runId: offer.runId, agentId: offer.agentId, workspace: offer.workspace
    }));
  } catch (error) {
    logWarn(`worker cleanup: checkout status unavailable: ${String(error)}`);
  }
  logInfo(`worker cleanup: owner ${report.owner}, ${report.workers} workers, ${report.archived} locally archived, ${report.pending.length} pending, ${report.dirtyWorktrees.length} dirty checkouts`);
  return report;
}
