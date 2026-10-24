/** Local Company orchestration through the existing owner-scoped worker broker.
 * Only calls from the trusted Electron main frame enter this module. No HTTP tokens or
 * worker/meeting assertions from the renderer are treated as evidence. */
import { z } from 'zod';
import { getCompany, mutateCompany } from './company-store.js';
import { serveWorkerAction, serveWorkerRead } from './control-workers.js';
import type { CompanyRequest, CompanySnapshot } from '../shared/company.js';

const workerId = z.string().regex(/^worker-[1-9][0-9]*$/);
const uuid = z.string().uuid();
const workerStatus = z.object({ id: workerId, runId: uuid.nullable(), label: z.string(), state: z.string(),
  result: z.string().nullable().optional(), conversationId: z.string().nullable().optional() });
const fleetStatus = z.object({ runId: uuid.nullable(), workers: z.array(workerStatus) });
const reportSchema = z.object({ id: z.string().min(1).max(100), from: z.string(), runId: uuid.nullable(), time: z.number().int().nonnegative(), text: z.string(),
  origin: z.enum(['authenticated-worker-message','broker-event']).optional() });

export interface CompanyWorkerBackend {
  spawn(ownerId: string, label: string, task: string): Promise<{ runId: string; workerId: string }>;
  status(ownerId: string, runId?: string): Promise<z.infer<typeof fleetStatus>>;
  reports(ownerId: string, runId: string): Promise<Array<z.infer<typeof reportSchema>>>;
  send(ownerId: string, runId: string, to: string, text: string): Promise<string>;
  ack(ownerId: string, runId: string, messageId: string): Promise<void>;
}

function unwrap(result: Awaited<ReturnType<typeof serveWorkerAction>>): Record<string, unknown> {
  if (!result || result.status !== 202 && result.status !== 200) throw new Error('Worker action refused');
  return result.body as Record<string, unknown>;
}

/** Uses the same auth, durable admission and profile gates as /v1/workers/{ownerId}. */
export const localCompanyWorkerBackend: CompanyWorkerBackend = {
  async spawn(ownerId, label, task) {
    const result = unwrap(await serveWorkerAction('POST', `/v1/workers/${ownerId}/spawn`,
      { workers: [{ label, task }] }, () => undefined));
    const response = z.object({ runId: uuid, workers: z.array(z.object({ id: workerId })).length(1) }).parse(result);
    return { runId: response.runId, workerId: response.workers[0]!.id };
  },
  async status(ownerId, runId) {
    const query = new URLSearchParams(); if (runId) query.set('runId', runId);
    return fleetStatus.parse(await serveWorkerRead(`/v1/workers/${ownerId}`, query));
  },
  async reports(ownerId, runId) {
    const result = await serveWorkerRead(`/v1/workers/${ownerId}/reports`, new URLSearchParams({ runId }));
    return z.object({ messages: z.array(reportSchema) }).parse(result).messages;
  },
  async send(ownerId, runId, to, text) {
    const response = unwrap(await serveWorkerAction('POST', `/v1/workers/${ownerId}/message`,
      { runId, messages: [{ to, text }] }, () => undefined));
    const parsed = z.object({ queued: z.array(z.object({ id: z.string().min(1).max(100), to: workerId })).length(1) }).parse(response);
    if (parsed.queued[0]!.to !== to) throw new Error('Wrong worker in message receipt');
    return parsed.queued[0]!.id;
  },
  async ack(ownerId, runId, messageId) {
    const response = unwrap(await serveWorkerAction('POST', `/v1/workers/${ownerId}/ack`,
      { runId, messageIds: [messageId] }, () => undefined));
    if (!z.object({ acknowledged: z.array(z.string()) }).parse(response).acknowledged.includes(messageId))
      throw new Error('Worker report acknowledgement unconfirmed');
  }
};

function ticket(snapshot: CompanySnapshot, id: string): CompanyRequest {
  const request = snapshot.requests.find(item => item.id === id);
  if (!request) throw new Error('Ticket not found');
  return request;
}
function labelFor(request: CompanyRequest): string { return `${request.seat}:${request.id}`; }
function verifiedWorker(status: z.infer<typeof fleetStatus>, request: CompanyRequest,
  binding: NonNullable<CompanyRequest['execution']>) {
  if (status.runId !== binding.runId) throw new Error('Broker worker run identity mismatch');
  const matches = status.workers.filter(worker => worker.id === binding.workerId &&
    worker.runId === binding.runId && worker.label === labelFor(request));
  if (matches.length !== 1) throw new Error('Worker run or identity missing; refusing stale session');
  const worker = matches[0]!;
  // The browser may not have opened an invited worker's chat yet. Its server
  // admission is real, but it must remain pending rather than be called active.
  if (['invited','waking'].includes(worker.state) && !binding.conversationId &&
      !worker.conversationId) return worker;
  if (typeof worker.conversationId !== 'string' || !worker.conversationId.trim() ||
    worker.conversationId.length > 160 || (binding.conversationId && worker.conversationId !== binding.conversationId))
    throw new Error('Broker worker conversation identity unavailable or changed');
  return worker;
}
function ensureLive(snapshot: CompanySnapshot): void {
  if (snapshot.demo) throw new Error('Synthetic company records cannot run real workers');
}

function hasActiveChiefSession(status: z.infer<typeof fleetStatus>, binding: NonNullable<CompanySnapshot['delegation']['binding']>): boolean {
  return status.runId === binding.runId && status.workers.filter(worker=>
    worker.id===binding.workerId && worker.runId===binding.runId &&
    worker.label===binding.label && worker.state==='active' &&
    worker.conversationId===binding.conversationId).length===1;
}

/** Explicit human action reserves a durable one-shot command BEFORE spawning. If an
 * ambiguous spawn fails, no second spawn is issued: reconcile the broker by exact label. */
export function createCompanyBroker(backend: CompanyWorkerBackend = localCompanyWorkerBackend) {
  /** CEO selects a configured live worker. The binding comes exclusively from current
   * main-owned ticket and broker status, never from renderer-supplied worker IDs. */
  async function grantDelegation(delegate: string, scope: 'internal-triage' | 'ticket-review', chiefTitle: 'operations' | 'director' | 'manager' | 'coordinator' = 'operations'): Promise<CompanySnapshot> {
    const snapshot = await getCompany(); ensureLive(snapshot);
    if (snapshot.delegation.mode !== 'manual') throw new Error('Revoke the current delegation first');
    if (delegate === 'marks-coo') {
      if (scope !== 'ticket-review') throw new Error('Role identity lacks a worker binding');
      return mutateCompany('delegationGrant',{delegate,scope,chiefTitle:'operations'});
    }
    if (!snapshot.company.seats.slice(0,10).includes(delegate) || scope !== 'internal-triage')
      throw new Error('Select one of the ten configured employee seats for internal triage');
    const candidates = snapshot.requests.filter(row => row.seat === delegate && row.execution?.mode === 'live' &&
      row.execution.ownerId === row.id && row.execution.runId && row.execution.workerId &&
      ['admitted','running'].includes(row.execution.phase));
    if (candidates.length !== 1) throw new Error('A unique active broker-bound chief worker is required');
    const chief=candidates[0]!, bound=chief.execution!;
    const status=await backend.status(chief.id,bound.runId!);
    const verified = status.workers.filter(worker=>worker.id===bound.workerId && worker.runId===bound.runId &&
      worker.label===labelFor(chief) && worker.state==='active' && !!bound.conversationId &&
      worker.conversationId===bound.conversationId && worker.conversationId.length<=160);
    if (status.runId!==bound.runId || verified.length!==1)
      throw new Error('Selected chief has no active authenticated worker session');
    const now=Date.now();
    return mutateCompany('delegationGrant',{delegate,scope,chiefTitle,binding:{seat:delegate,ownerId:chief.id,
      runId:bound.runId,workerId:bound.workerId,label:labelFor(chief),conversationId:verified[0]!.conversationId,
      verifiedAt:now,expiresAt:now+5*60_000}});
  }

  /** Poll-based, idempotent internal triage. Worker report provenance is validated by
   * server-managed owner/run/worker identity and an exact live binding. No tool dispatch. */
  async function applyDelegatedTriage(): Promise<CompanySnapshot> {
    const snapshot=await getCompany(); ensureLive(snapshot);
    const policy=snapshot.delegation, binding=policy.binding;
    if (policy.mode!=='delegated' || !policy.scopes.includes('internal-triage') || !binding)
      throw new Error('Internal triage delegation not active');
    if (Date.now()>=binding.expiresAt) throw new Error('Chief delegation expired');
    if (!binding.conversationId) throw new Error('Chief session has no server-bound conversation proof');
    const source=ticket(snapshot,binding.ownerId);
    if (source.seat!==binding.seat || source.execution?.runId!==binding.runId || source.execution.workerId!==binding.workerId ||
      source.execution.phase!=='running' || labelFor(source)!==binding.label)
      throw new Error('Chief binding changed');
    const status=await backend.status(binding.ownerId,binding.runId);
    if (!hasActiveChiefSession(status,binding))
      throw new Error('Chief worker no longer active');
    const reports=await backend.reports(binding.ownerId,binding.runId);
    for (const report of reports) {
      // Legacy reports and server-generated finish/health text cannot authorize a
      // decision merely by containing a COMPANY_TRIAGE-shaped string.
      if (report.origin !== 'authenticated-worker-message' ||
        report.from!==binding.workerId || report.runId!==binding.runId || report.time<(policy.grantedAt??Infinity) ||
        report.time>binding.expiresAt) continue;
      const match=/^COMPANY_TRIAGE:([0-9a-f-]{36}):assigned:(marks[1-9][0-9]?)$/.exec(report.text);
      if (!match) continue;
      const id=uuid.parse(match[1]); const seat=match[2]!;
      if (!snapshot.requests.some(row=>row.id===id && row.status==='inbox')) {
        // A persisted decision may precede a failed /ack reply. Only retire the
        // exact server-sourced receipt recorded with this epoch and binding.
        const completed = snapshot.requests.some(row=>row.id===id && row.status==='assigned' && row.seat===seat) &&
          snapshot.delegationAudit.some(event=>event.action==='decision-approved' && event.scope==='internal-triage' &&
            event.requestId===id && event.receiptId===report.id && event.epoch===policy.epoch &&
            event.binding?.ownerId===binding.ownerId && event.binding.runId===binding.runId &&
            event.binding.workerId===binding.workerId);
        if (completed) { await backend.ack(binding.ownerId,binding.runId,report.id); return getCompany(); }
        continue;
      }
      // The broker may settle or retire this exact conversation between its first
      // status response and the reports response. A receipt from the old session
      // cannot approve a new decision after that transition.
      if (!hasActiveChiefSession(await backend.status(binding.ownerId,binding.runId),binding))
        throw new Error('Chief worker no longer active');
      // Store serializes epoch, TTL and one-shot decision with the ticket transition.
      await mutateCompany('delegationTriage',{id,seat,epoch:policy.epoch,ownerId:binding.ownerId,
        runId:binding.runId,workerId:binding.workerId,receiptId:report.id,receiptTime:report.time});
      await backend.ack(binding.ownerId,binding.runId,report.id);
      return getCompany();
    }
    return snapshot;
  }
  /** No verified COO actor is currently surfaced by the worker broker. A future authenticated
   * adapter must inject a proven principal, never a renderer-provided role or boolean. */
  async function reviewDelegated(id: string, evidence: string, identity: { role: 'marks-coo'; authenticated: boolean } | null = null): Promise<CompanySnapshot> {
    const initial = await getCompany();
    const epoch = initial.delegation.epoch;
    if (initial.delegation.mode !== 'delegated' || !initial.delegation.scopes.includes('ticket-review')) {
      await mutateCompany('delegationDeny',{id,reason:'policy-mismatch'});
      throw new Error('Ticket review delegation is not active');
    }
    // A role name and an injected boolean are never authentication. No live COO
    // role-session attestation exists yet; never treat a main-local flag as one.
    if (!identity?.authenticated || identity.role !== 'marks-coo' || !initial.delegation.binding) {
      await mutateCompany('delegationDeny',{id,reason:'invalid-identity'});
      throw new Error('Authenticated COO identity is unavailable; delegated decision refused');
    }
    const request=ticket(initial,id), binding=request.execution;
    if (!binding?.ownerId || !binding.runId || !binding.workerId || !binding.reportId || !binding.result ||
      request.status !== 'review' || binding.phase !== 'reported') throw new Error('Verified report required');
    const status = await backend.status(binding.ownerId,binding.runId);
    if (status.workers.filter(w=>w.id===binding.workerId && w.runId===binding.runId &&
      w.label===labelFor(request) && ['sleeping','finished'].includes(w.state) && w.result===binding.result).length!==1)
      throw new Error('Worker identity or report mismatch');
    return mutateCompany('confirmDelegated',{id,workerId:binding.workerId,runId:binding.runId,reportId:binding.reportId,evidence,epoch});
  }
  async function dispatch(id: string): Promise<CompanySnapshot> {
    let current = await getCompany(); ensureLive(current);
    const request = ticket(current, id);
    if (!request.seat || !current.company.seats.slice(0,10).includes(request.seat) || request.status !== 'assigned' || request.execution)
      throw new Error('Select an idle configured seat and assign the ticket before authorizing');
    if (request.engine !== 'chatgpt') throw new Error('This worker broker supports ChatGPT only');
    if (!request.tokenBudget || !request.timeBudgetMinutes) throw new Error('Positive budgets required');
    // A preflight refuses disabled workers or revoked settings before reserving any ticket.
    try { await backend.status(request.id); }
    catch { throw new Error('Worker broker unavailable or owner permission denied. Check the Core connection and worker permissions; no worker was started.'); }
    current = await mutateCompany('reserve', { id });
    const saved = ticket(current, id);
    const response = await backend.spawn(id, labelFor(saved),
      `Company ticket ${saved.id}. You are ${saved.seat}; respond only for your assigned seat.\n` +
      `Task: ${saved.title}\nProject: ${saved.project}\nAcceptance: ${saved.acceptance}\n` +
      `Budget guidance: max ${saved.tokenBudget} tokens and ${saved.timeBudgetMinutes} minutes. ` +
      `Stop and report if you cannot meet the limits. Report actual progress and finish using the authenticated agents finish action.`);
    // If binding persistence fails, remain pending and reconcile; never spawn again.
    await mutateCompany('bind', { id, workerId: response.workerId, runId: response.runId });
    return getCompany();
  }

  async function refresh(id: string): Promise<CompanySnapshot> {
    let current = await getCompany(); ensureLive(current);
    let request = ticket(current, id);
    const exec = request.execution;
    if (!exec || exec.mode !== 'live' || exec.ownerId !== id) throw new Error('No broker-bound ticket');
    const currentStatus = fleetStatus.parse(await backend.status(id, exec.runId ?? undefined));
    if (exec.phase === 'awaiting-authorization' && !exec.workerId && !exec.runId) {
      const matches = currentStatus.workers.filter(w => w.label === labelFor(request) && w.runId);
      if (matches.length !== 1) throw new Error('No unique worker admission found; never repeat an ambiguous spawn');
      const chosen = matches[0]!;
      current = await mutateCompany('bind', { id, workerId: chosen.id, runId: chosen.runId });
      request = ticket(current,id);
    }
    const binding = request.execution!;
    if (!binding.workerId || !binding.runId) throw new Error('Worker binding unresolved');
    // A named seat is only configuration. A real worker needs a server-bound
    // conversation identity for every state change; never adopt a model label.
    const worker = verifiedWorker(currentStatus, request, binding);
    if (worker.state === 'active' && binding.phase === 'admitted') {
      current = await mutateCompany('progress', { id, workerId: worker.id, runId: binding.runId, conversationId: worker.conversationId, state: 'active' });
    }
    if ((worker.state === 'sleeping' || worker.state === 'finished') && worker.result?.trim()) {
      const durableReport = ticket(current,id).execution!;
      if (durableReport.reportId && durableReport.phase !== 'reported') return current;
      const messages = await backend.reports(id, binding.runId);
      const found = messages.filter(message => message.from === binding.workerId && message.runId === binding.runId &&
        message.origin === 'broker-event' &&
        (!durableReport.reportId || message.id === durableReport.reportId) &&
        message.time >= (binding.authorizedAt ?? Number.MAX_SAFE_INTEGER) &&
        (message.text.startsWith(`[${binding.workerId} reported] `) || message.text.startsWith(`[${binding.workerId} finished] `)) &&
        message.text.includes(worker.result!.slice(0, 1200)));
      if (found.length !== 1) return current;
      const report = found[0]!;
      // Reports are a separate broker read. The worker must still be the same
      // server-owned conversation with the same settled result immediately
      // before the durable transition and ACK.
      const again = verifiedWorker(fleetStatus.parse(await backend.status(id, binding.runId)), request,
        ticket(await getCompany(),id).execution!);
      if (again.conversationId !== worker.conversationId ||
        !['sleeping','finished'].includes(again.state) || again.result !== worker.result)
        throw new Error('Broker worker session changed during report verification');
      if (!durableReport.reportId) {
        current = await mutateCompany('report', { id, workerId: binding.workerId, runId: binding.runId,
          conversationId: worker.conversationId, reportId: report.id, result: worker.result.slice(0,1200), evidence: `broker:${report.id}:${binding.runId}`,
          outcome: 'completed' });
      }
      // Persisted report and broker ACK are separate durable owners: after an
      // ambiguous ACK failure, use the exact receipt again without re-reporting.
      await backend.ack(id, binding.runId, report.id);
    }
    return current;
  }

  async function review(id: string, evidence: string): Promise<CompanySnapshot> {
    let current = await getCompany(); ensureLive(current);
    const request=ticket(current,id), binding=request.execution;
    if (!binding || request.status!=='review' || binding.mode!=='live' || binding.phase!=='reported' ||
      !binding.ownerId || !binding.runId || !binding.workerId || !binding.reportId || !binding.result)
      throw new Error('A broker-authenticated completion report is required');
    const status=await backend.status(binding.ownerId,binding.runId);
    if (status.runId!==binding.runId || !binding.conversationId ||
      status.workers.filter(w=>w.id===binding.workerId && w.runId===binding.runId &&
      w.label===labelFor(request) && w.conversationId===binding.conversationId &&
      ['sleeping','finished'].includes(w.state) && w.result===binding.result).length!==1)
      throw new Error('Worker is not settled with the matching broker result');
    current=await mutateCompany('confirm',{id,workerId:binding.workerId,runId:binding.runId,reportId:binding.reportId,evidence});
    return current;
  }

  async function sendInvitations(meetingId: string): Promise<CompanySnapshot> {
    let current = await getCompany(); ensureLive(current);
    const meeting = current.meetings.find(item=>item.id===meetingId);
    if (!meeting?.invitations) throw new Error('Meeting not found');
    for (const invitation of meeting.invitations) {
      if (invitation.delivery) continue; // no repeat after an ambiguous enqueue
      const matching = current.requests.filter(row => row.seat === invitation.seat && row.execution?.mode === 'live' &&
        row.execution.workerId && row.execution.runId && row.execution.ownerId &&
        ['admitted','running','reported'].includes(row.execution.phase)).sort((a,b)=>b.updatedAt-a.updatedAt);
      if (!matching.length) continue; // invited, but no authorized reachable worker
      const owner = matching[0]!.execution!;
      const status = await backend.status(owner.ownerId!, owner.runId!);
      if (status.runId!==owner.runId || !owner.conversationId ||
        status.workers.filter(w=>w.id===owner.workerId && w.runId===owner.runId &&
          w.label===labelFor(matching[0]!) && w.conversationId===owner.conversationId).length!==1) continue;
      await mutateCompany('inviteReserve',{ id: meetingId,seat:invitation.seat,ownerId:owner.ownerId,runId:owner.runId,workerId:owner.workerId });
      const queuedId = await backend.send(owner.ownerId!,owner.runId!,owner.workerId!,
        `Company meeting ${meeting.title}. Agenda: ${meeting.agenda ?? ''}. Meeting ID ${meeting.id}. `+
        `If you accept, send your prime: MEETING_ACK:${meeting.id}:accepted. `+
        `Only when actually attending send MEETING_ACK:${meeting.id}:present. `+
        `If unable, send MEETING_ACK:${meeting.id}:declined. `+
        `To contribute send MEETING_NOTE:${meeting.id}:your text.`);
      current = await mutateCompany('inviteDelivered',{ id:meetingId,seat:invitation.seat,ownerId:owner.ownerId,runId:owner.runId,workerId:owner.workerId,queuedId });
    }
    return getCompany();
  }

  async function reconcileMeeting(meetingId: string): Promise<CompanySnapshot> {
    let current = await getCompany(); ensureLive(current);
    const meeting = current.meetings.find(item=>item.id===meetingId);
    if (!meeting?.invitations) throw new Error('Meeting not found');
    for (const invitation of meeting.invitations) {
      const delivery=invitation.delivery;
      if (!delivery?.queuedId) continue;
      const status = await backend.status(delivery.ownerId, delivery.runId);
      const linked = current.requests.find(row=>row.id===delivery.ownerId &&
        row.seat===invitation.seat && row.execution?.ownerId===delivery.ownerId &&
        row.execution.runId===delivery.runId && row.execution.workerId===delivery.workerId &&
        !!row.execution.conversationId);
      if (status.runId!==delivery.runId || !linked) continue;
      const bound = (worker: z.infer<typeof workerStatus>) => worker.id===delivery.workerId && worker.runId===delivery.runId &&
        worker.label===labelFor(linked) && worker.conversationId===linked.execution!.conversationId;
      if (status.workers.filter(bound).length!==1) continue;
      const messages = await backend.reports(delivery.ownerId,delivery.runId);
      // A worker can be rebound while the report lookup is in flight. Recheck
      // both the broker conversation and the durable invitation before a receipt
      // can become attendance or be acknowledged.
      const recent = await getCompany();
      const latestInvite = recent.meetings.find(m=>m.id===meetingId)?.invitations?.find(i=>i.seat===invitation.seat);
      const latestTicket = recent.requests.find(row=>row.id===delivery.ownerId && row.seat===invitation.seat &&
        row.execution?.ownerId===delivery.ownerId && row.execution.runId===delivery.runId &&
        row.execution.workerId===delivery.workerId && row.execution.conversationId===linked.execution!.conversationId);
      if (!latestInvite?.delivery || !latestTicket || latestInvite.delivery.ownerId!==delivery.ownerId ||
          latestInvite.delivery.runId!==delivery.runId || latestInvite.delivery.workerId!==delivery.workerId ||
          latestInvite.delivery.queuedId!==delivery.queuedId) continue;
      const freshStatus = await backend.status(delivery.ownerId,delivery.runId);
      const freshWorkers = freshStatus.workers.filter(bound);
      if (freshStatus.runId!==delivery.runId || freshWorkers.length!==1) continue;
      const worker = freshWorkers[0]!;
      Object.assign(invitation,latestInvite);
      for (const message of messages) {
        if (message.origin!=='authenticated-worker-message' ||
            message.from!==delivery.workerId || message.runId!==delivery.runId || message.time<delivery.at ||
            message.id===invitation.evidence) continue;
        const prefix = `MEETING_ACK:${meetingId}:`;
        const notePrefix = `MEETING_NOTE:${meetingId}:`;
        if (message.text.startsWith(prefix)) {
          const state=message.text.slice(prefix.length);
          if (!['accepted','declined','present'].includes(state) || (state==='present' &&
            (invitation.state!=='accepted' || worker.state!=='active'))) continue;
          current = await mutateCompany('attendance',{id:meetingId,seat:invitation.seat,state,contribution:invitation.contribution,evidence:message.id});
        } else if (message.text.startsWith(notePrefix) && invitation.state==='present' && worker.state==='active') {
          const contribution=message.text.slice(notePrefix.length).trim().slice(0,1600);
          if (!contribution) continue;
          current = await mutateCompany('attendance',{id:meetingId,seat:invitation.seat,state:'present',contribution,evidence:message.id});
        } else continue;
        await backend.ack(delivery.ownerId,delivery.runId,message.id);
        const newInvite=current.meetings.find(m=>m.id===meetingId)?.invitations?.find(i=>i.seat===invitation.seat);
        if (newInvite) Object.assign(invitation,newInvite);
      }
    }
    return current;
  }

  return { dispatch, refresh, review, reviewDelegated, grantDelegation, applyDelegatedTriage, sendInvitations, reconcileMeeting };
}
