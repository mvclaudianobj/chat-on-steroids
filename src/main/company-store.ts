/** Main-owned, local-only company state; never executes requests or calls external services. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { companySnapshotSchema, companySeats, demoCompany, emptyCompany, type CompanySnapshot, type CompanyRequest } from '../shared/company.js';

let root = '';
let queue: Promise<void> = Promise.resolve();
export function initCompanyStore(userData: string): void { root = path.join(userData, 'company'); }
export function resetCompanyStoreForTests(): void { root = ''; queue = Promise.resolve(); }

async function directory(): Promise<string> {
  if (!root) throw new Error('Company storage not initialized');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(root)).isDirectory() || (await fs.lstat(root)).isSymbolicLink()) throw new Error('Invalid company directory');
  return root;
}
async function load(): Promise<CompanySnapshot> {
  const location = path.join(await directory(), 'company.json');
  try {
    const info = await fs.lstat(location);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error('Invalid company state file');
    return companySnapshotSchema.parse(JSON.parse(await fs.readFile(location, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCompany();
    throw new Error('Company state could not be read');
  }
}
async function save(value: CompanySnapshot): Promise<void> {
  const target = path.join(await directory(), 'company.json');
  const next = companySnapshotSchema.parse(value);
  const tmp = path.join(root, `.${randomUUID()}.tmp`);
  try { await fs.writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await fs.rename(tmp, target); }
  finally { await fs.rm(tmp, { force: true }); }
}
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const job = queue.then(fn); queue = job.then(() => undefined, () => undefined); return job;
}
export function getCompany(): Promise<CompanySnapshot> { return serialized(load); }
export function mutateCompany(action: 'demo' | 'configure' | 'create' | 'move' | 'seat' | 'authorize' | 'report' | 'confirm' | 'meeting' | 'attendance' | 'minutes', payload: unknown): Promise<CompanySnapshot> {
  return serialized(async () => {
    const current = await load();
    if (action === 'demo') {
      if (current.requests.length || current.meetings.length) throw new Error('Example data requires an empty company');
      const demo = demoCompany(); await save(demo); return demo;
    }
    const now = Date.now();
    if (action === 'configure') {
      const { name, seatCount } = payload as { name: string; seatCount: number };
      if (seatCount > 10 && current.company.seatCount <= 10) throw new Error('New configurations support at most ten seats');
      if (seatCount < current.company.seatCount && current.requests.some(r => r.seat && Number(r.seat.slice(5)) > seatCount))
        throw new Error('Reassign occupied seats before reducing capacity');
      current.company.name = name; current.company.seatCount = seatCount; current.company.seats = companySeats(seatCount);
      current.activities.unshift({ id: randomUUID(), at: now, actor: 'ceo', kind: 'company', message: 'Company settings updated.' });
    } else if (action === 'create') {
      const fields = payload as Pick<CompanyRequest, 'title'|'project'|'owner'|'origin'|'acceptance'|'engine'|'model'|'tokenBudget'|'timeBudgetMinutes'|'dueAt'>;
      const request: CompanyRequest = {
        ...fields, id: randomUUID(), seat: null, tokensUsed: 0, minutesUsed: 0, status: 'inbox',
        raci: { responsible: fields.owner, accountable: 'ceo', consulted: [], informed: ['marks-coo'] },
        history: [{ at: now, actor: fields.origin, note: 'Request created.' }], createdAt: now, updatedAt: now
      };
      current.requests.unshift(request);
      current.activities.unshift({ id: randomUUID(), at: now, actor: fields.origin, kind: 'request', requestId: request.id, message: `Created ${request.title}` });
    } else if (action === 'meeting') {
      const fields = payload as { title: string; agenda: string; durationMinutes: number };
      const invites = current.company.seats.map(seat => ({ seat, state: 'invited' as const, contribution: '', confirmedAt: null, evidence: null }));
      current.meetings.unshift({ id: randomUUID(), title: fields.title, agenda: fields.agenda, participants: ['ceo','marks-coo', ...current.company.seats], invitations: invites, at: now, durationMinutes: fields.durationMinutes, minutes: '', decisions: [], brainSync: 'pending' });
      current.activities.unshift({ id: randomUUID(), at: now, actor: 'marks-coo', kind: 'meeting', message: `Invited ${invites.length} seats to ${fields.title}; awaiting confirmation.` });
    } else if (action === 'attendance' || action === 'minutes') {
      const fields = payload as { id: string; seat?: string; state?: 'invited'|'accepted'|'declined'|'present'; contribution?: string; evidence?: string; minutes?: string; decisions?: string[] };
      const meeting = current.meetings.find(row => row.id === fields.id);
      if (!meeting) throw new Error('Meeting not found');
      if (action === 'minutes') { meeting.minutes = fields.minutes!; meeting.decisions = fields.decisions!; }
      else {
        const invite = meeting.invitations?.find(row => row.seat === fields.seat);
        if (!invite) throw new Error('Seat not invited');
        if (fields.state === 'present' && invite.state !== 'accepted' && invite.state !== 'present') throw new Error('Presence requires acceptance');
        invite.state = fields.state!; invite.contribution = fields.contribution!; invite.evidence = fields.evidence!;
        invite.confirmedAt = fields.state === 'invited' ? null : now;
      }
      current.activities.unshift({ id: randomUUID(), at: now, actor: 'marks-coo', kind: 'meeting', message: action === 'minutes' ? `Minutes recorded: ${meeting.title}` : `${fields.seat}: ${fields.state} (${meeting.title})` });
    } else if (action === 'authorize' || action === 'report' || action === 'confirm') {
      const fields = payload as { id: string; ownerId?: string; workerId: string; runId: string; reportId?: string; result?: string; evidence?: string; outcome?: 'completed'|'failed' };
      const request = current.requests.find(row => row.id === fields.id);
      if (!request || !request.seat) throw new Error('Ticket has no assigned seat');
      if (action === 'authorize') {
        if (request.execution) throw new Error('Execution already admitted');
        if (request.status !== 'assigned') throw new Error('Ticket must be assigned before authorization');
        if (current.requests.some(row => row.id !== request.id && row.seat === request.seat && row.execution?.phase === 'running')) throw new Error('Seat already running a ticket');
        request.execution = { mode: 'live', phase: 'admitted', ownerId: fields.ownerId!, workerId: fields.workerId, runId: fields.runId, reportId: null, result: null, evidence: null, authorizedAt: now };
        request.status = 'working';
      } else if (action === 'report') {
        const exec = request.execution;
        if (!exec || exec.workerId !== fields.workerId || exec.runId !== fields.runId || exec.mode !== 'live') throw new Error('Worker identity mismatch');
        if (exec.reportId) throw new Error('Ticket already reported');
        if (request.tokenBudget > 0 && request.tokensUsed > request.tokenBudget) throw new Error('Token budget exceeded');
        exec.phase = fields.outcome === 'completed' ? 'reported' : 'failed'; exec.reportId = fields.reportId!; exec.result = fields.result!; exec.evidence = fields.evidence!;
        request.status = fields.outcome === 'completed' ? 'review' : 'needs-ceo';
      } else {
        const exec = request.execution;
        if (!exec || exec.mode !== 'live' || exec.phase !== 'reported' || request.status !== 'review' ||
            !exec.ownerId || !exec.runId || !exec.workerId || !exec.reportId || !exec.result?.trim() || !exec.evidence?.trim() ||
            exec.reportId !== fields.reportId || exec.workerId !== fields.workerId || exec.runId !== fields.runId ||
            request.cooConfirmation) throw new Error('COO confirmation requires a matching verified worker report');
        if (!fields.evidence?.trim()) throw new Error('COO review evidence required');
        request.cooConfirmation = { actor: 'marks-coo', at: now, reportId: exec.reportId, workerId: exec.workerId, evidence: fields.evidence };
        request.status = 'done';
      }
      request.updatedAt = now;
      request.history.push({ at: now, actor: 'marks-coo', note: action === 'authorize' ? `Authorized ${request.seat} as ${fields.workerId}` : action === 'report' ? `Worker ${fields.workerId} reported ${fields.outcome}` : `COO confirmed report ${fields.reportId} for ${request.seat}`, ...(action === 'confirm' ? { from: 'review' as const, to: 'done' as const } : {}) });
      current.activities.unshift({ id: randomUUID(), at: now, actor: 'marks-coo', kind: 'request', requestId: request.id, message: request.history.at(-1)!.note });
    } else {
      const { id, status, seat } = payload as { id: string; status?: CompanyRequest['status']; seat?: string | null };
      const request = current.requests.find(r => r.id === id);
      if (!request) throw new Error('Request not found');
      const before = request.status;
      if (action === 'move') {
        if (status === 'working') throw new Error('Working requires verified broker admission');
        if (status === 'done') throw new Error('Only a verified COO confirmation can complete a ticket');
        request.status = status!;
        if (request.status === 'assigned' || request.status === 'review') {
          if (!request.seat) throw new Error('COO must choose the exact seat first');
          if (!request.seat) throw new Error('No free seat; request remains queued');
        }
      } else { if (request.execution) throw new Error('Cannot silently replace an executing worker'); request.seat = seat!; }
      if ((request.status === 'assigned' || request.status === 'review') && !request.seat) throw new Error('Active work needs a seat');
      request.updatedAt = now;
      const note = action === 'move' ? `Moved to ${request.status}` : `Assigned to ${request.seat ?? 'queue'}`;
      request.history.push({ at: now, actor: 'ceo', note, ...(action === 'move' ? { from: before, to: request.status } : {}) });
      current.activities.unshift({ id: randomUUID(), at: now, actor: 'ceo', kind: action, requestId: id, message: `${request.title}: ${note}` });
    }
    current.activities = current.activities.slice(0, 1000);
    await save(current);
    return current;
  });
}
