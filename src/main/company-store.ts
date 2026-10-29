/** Main-owned, local-only company state; never executes requests or calls external services. */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
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

/** Migration is deliberately separate from sample data insertion and broker admission.
 * The complete demo must reach a private immutable backup before the empty live view is published. */
function blankFromDemo(demo: CompanySnapshot, backupId: string, startedAt: number): CompanySnapshot {
  const live = emptyCompany();
  live.company = { ...demo.company, seats: [...demo.company.seats] };
  live.demoRecovery = { backupId, startedAt };
  return companySnapshotSchema.parse(live);
}
async function backupDirectory(): Promise<string> {
  const destination = path.join(await directory(), 'demo-backups');
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid demo backup directory');
  await fs.chmod(destination, 0o700);
  return destination;
}
async function readDemoBackup(id: string): Promise<CompanySnapshot> {
  const file = path.join(await backupDirectory(), `${id}.json`);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2_100_000) throw new Error('Invalid demo backup');
    const saved: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!saved || typeof saved !== 'object') throw new Error('Invalid demo backup');
    const record = saved as Record<string, unknown>;
    if (record['version'] !== 1 || record['backupId'] !== id || typeof record['sha256'] !== 'string') throw new Error('Invalid demo backup');
    const snapshot = companySnapshotSchema.parse(record['snapshot']);
    if (!snapshot.demo || createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') !== record['sha256'])
      throw new Error('Demo backup integrity check failed');
    return snapshot;
  } finally { await handle.close(); }
}
export function activateRealCompany(): Promise<CompanySnapshot> {
  return serialized(async () => {
    const demo = await load();
    if (!demo.demo) throw new Error('Only a demonstration can be converted to a real company');
    const backupId = randomUUID(), startedAt = Date.now();
    const source = companySnapshotSchema.parse(demo);
    const record = {version:1,backupId,createdAt:startedAt,sha256:createHash('sha256').update(JSON.stringify(source)).digest('hex'),snapshot:source};
    const file = path.join(await backupDirectory(), `${backupId}.json`);
    // A completed file flush precedes replacing company.json, even if the app exits suddenly.
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    await readDemoBackup(backupId);
    const live = blankFromDemo(source, backupId, startedAt);
    await save(live);
    return live;
  });
}
export function restoreDemoCompany(): Promise<CompanySnapshot> {
  return serialized(async () => {
    const current = await load();
    if (current.demo || !current.demoRecovery) throw new Error('No real company with a demo backup to restore');
    const original = await readDemoBackup(current.demoRecovery.backupId);
    // Roll back only while absolutely no real work/configuration has been authored since transition.
    const pristine = blankFromDemo(original, current.demoRecovery.backupId, current.demoRecovery.startedAt);
    if (JSON.stringify(current) !== JSON.stringify(pristine))
      throw new Error('Real company has changed; backup retained, automatic restore refused');
    await save(original);
    return original;
  });
}
export function mutateCompany(action: 'demo' | 'configure' | 'create' | 'prepare' | 'move' | 'seat' | 'authorize' | 'report' | 'confirm' | 'confirmDelegated' | 'delegationGrant' | 'delegationRevoke' | 'delegationDeny' | 'delegationTriage' | 'meeting' | 'attendance' | 'minutes' | 'reserve' | 'bind' | 'progress' | 'inviteReserve' | 'inviteDelivered', payload: unknown): Promise<CompanySnapshot> {
  return serialized(async () => {
    const current = await load();
    if (action === 'demo') {
      if (current.requests.length || current.meetings.length || current.delegationAudit.length) throw new Error('Example data requires an empty company');
      const demo = demoCompany(); await save(demo); return demo;
    }
    const now = Date.now();
    if (action === 'prepare') {
      if (current.demo) throw new Error('Convert the demonstration before assigning real workers');
      const fields = payload as { id: string; seat: string };
      const request = current.requests.find(row => row.id === fields.id);
      if (!request || request.status !== 'inbox' || request.execution || request.seat) throw new Error('Only a new inbox ticket can be prepared');
      if (!current.company.seats.slice(0,10).includes(fields.seat as `marks${number}`) ||
        current.requests.some(row => row.id !== fields.id && row.seat === fields.seat &&
          (row.status === 'working' || row.execution && ['admitted','running','awaiting-authorization'].includes(row.execution.phase))))
        throw new Error('Selected seat is unavailable for a real worker');
      request.seat = fields.seat as `marks${number}`; request.status = 'assigned'; request.updatedAt = now;
      request.history.push({at:now,actor:'ceo',note:`Prepared configured seat ${fields.seat}; broker admission still requires approval`,from:'inbox',to:'assigned'});
      current.activities.unshift({id:randomUUID(),at:now,actor:'ceo',kind:'seat',requestId:request.id,message:`Ticket assigned to ${fields.seat}; worker not started`});
      await save(current); return current;
    }
    if (action === 'delegationGrant' || action === 'delegationRevoke') {
      if (current.demo) throw new Error('Delegation is unavailable for synthetic company data');
      const previousDelegate = current.delegation.delegate;
      const previousScope = current.delegation.scopes[0] ?? null;
      const previousTitle = current.delegation.chiefTitle;
      const previousBinding = current.delegation.binding;
      if (action === 'delegationGrant') {
        const fields = payload as { delegate?: string; chiefTitle?: string; binding?: CompanySnapshot['delegation']['binding']; scope?: string } | undefined;
        if (current.delegation.mode === 'delegated') throw new Error('Delegation already enabled');
        const delegate = fields?.delegate ?? 'marks-coo';
        const seat = current.company.seats.includes(delegate as `marks${number}`);
        if (!seat && delegate !== 'marks-coo') throw new Error('Selected chief not eligible');
        if (seat && (!fields?.binding || !fields.binding.conversationId || fields.binding.seat !== delegate ||
          fields.binding.expiresAt <= now || fields.binding.verifiedAt > now ||
          !current.requests.some(row => row.id === fields.binding!.ownerId && row.seat === delegate &&
            row.status === 'working' && row.execution?.phase === 'running' &&
            row.execution?.mode === 'live' && row.execution.phase === 'running' &&
            row.status === 'working' && row.execution.ownerId === fields.binding!.ownerId &&
            row.execution.runId === fields.binding!.runId && row.execution.workerId === fields.binding!.workerId &&
            row.execution.conversationId === fields.binding!.conversationId &&
            `${row.seat}:${row.id}` === fields.binding!.label)))
          throw new Error('Chief worker binding cannot be verified');
        if (seat && fields?.scope !== 'internal-triage') throw new Error('Worker delegation only supports internal triage');
        if (!seat && fields?.scope && fields.scope !== 'ticket-review') throw new Error('Unsupported chief role scope');
        const chiefTitle = seat ? fields?.chiefTitle : 'operations';
        if (!chiefTitle || !['operations','director','manager','coordinator'].includes(chiefTitle)) throw new Error('Invalid chief title');
        current.delegation = { mode: 'delegated', delegate: delegate as CompanySnapshot['delegation']['delegate'],
          chiefTitle: chiefTitle as CompanySnapshot['delegation']['chiefTitle'], binding: seat ? fields!.binding! : null,
          scopes: [seat ? 'internal-triage' : 'ticket-review'], epoch: current.delegation.epoch + 1, grantedAt: now, revokedAt: null };
      } else {
        if (current.delegation.mode !== 'delegated') throw new Error('Delegation is not active');
        current.delegation = { mode: 'manual', delegate: null, chiefTitle: null, binding: null, scopes: [],
          epoch: current.delegation.epoch + 1, grantedAt: null, revokedAt: now };
      }
      current.delegationAudit.unshift({ id: randomUUID(), at: now, epoch: current.delegation.epoch,
        action: action === 'delegationGrant' ? 'grant' : 'revoke', actor: 'ceo', delegate: action === 'delegationGrant' ? current.delegation.delegate : previousDelegate,
        scope: action === 'delegationGrant' ? current.delegation.scopes[0]! : previousScope,
        chiefTitle: action === 'delegationGrant' ? current.delegation.chiefTitle : previousTitle,
        binding: (() => { const b=action === 'delegationGrant' ? current.delegation.binding : previousBinding;
          return b ? {ownerId:b.ownerId,runId:b.runId,workerId:b.workerId} : null; })(),
        requestId: null, reason: 'explicit-ceo' });
    } else if (action === 'delegationDeny') {
      const fields = payload as { id: string; reason: 'revoked' | 'invalid-identity' | 'policy-mismatch' | 'expired' | 'stale-session' };
      // Only callable by trusted main code; never an IPC action.
      current.delegationAudit.unshift({ id: randomUUID(), at: now, epoch: current.delegation.epoch,
        action: 'decision-denied', actor: 'system', delegate: current.delegation.delegate,
        scope: current.delegation.scopes[0] ?? null, requestId: fields.id, reason: fields.reason });
    } else if (action === 'delegationTriage') {
      const fields = payload as { id: string; seat: string; epoch: number; ownerId: string; runId: string; workerId: string; receiptId: string; receiptTime: number };
      const authority = current.delegation;
      if (authority.mode !== 'delegated' || authority.epoch !== fields.epoch || !authority.scopes.includes('internal-triage') ||
          !authority.binding || authority.delegate !== authority.binding.seat ||
          authority.binding.ownerId !== fields.ownerId || authority.binding.runId !== fields.runId ||
          authority.binding.workerId !== fields.workerId || authority.binding.expiresAt <= now ||
          fields.receiptTime < (authority.grantedAt ?? Number.MAX_SAFE_INTEGER) || fields.receiptTime > now)
        throw new Error('Delegation expired, revoked or wrong session');
      const chiefRequest = current.requests.find(row => row.id === authority.binding!.ownerId);
      if (!chiefRequest || chiefRequest.seat !== authority.binding.seat ||
          `${chiefRequest.seat}:${chiefRequest.id}` !== authority.binding.label ||
          chiefRequest.execution?.mode !== 'live' || chiefRequest.execution?.phase !== 'running' ||
          chiefRequest.execution.runId !== fields.runId || chiefRequest.execution.workerId !== fields.workerId)
        throw new Error('Selected chief session no longer matches the active broker ticket');
      const request = current.requests.find(row => row.id === fields.id);
      if (!request || request.status !== 'inbox' || request.execution || request.seat) throw new Error('Ticket is not in the triage inbox');
      if (!current.company.seats.includes(fields.seat as `marks${number}`) ||
          current.requests.some(row => row.id !== request.id && row.seat === fields.seat &&
            row.execution && ['admitted','running','awaiting-authorization'].includes(row.execution.phase)))
        throw new Error('Invalid or occupied assignment seat');
      if (current.delegationAudit.some(row => row.action === 'decision-approved' && row.requestId === fields.id))
        throw new Error('Delegated triage already recorded');
      request.seat = fields.seat as `marks${number}`;
      request.status = 'assigned'; request.updatedAt = now;
      request.history.push({ at: now, actor: authority.delegate, note: `Internal triage broker receipt ${fields.receiptId}`, from:'inbox', to:'assigned' });
      current.activities.unshift({ id: randomUUID(), at: now, actor: authority.delegate, kind: 'move', requestId: request.id, message: `Internal triage assigned to ${fields.seat}` });
      current.delegationAudit.unshift({ id: randomUUID(), at: now, epoch: authority.epoch,
        action: 'decision-approved', actor: authority.delegate, delegate: authority.delegate, scope: 'internal-triage',
        chiefTitle: authority.chiefTitle, binding: {ownerId:fields.ownerId,runId:fields.runId,workerId:fields.workerId},
        receiptId: fields.receiptId, requestId: fields.id, reason: 'authenticated-coo' });
    } else if (action === 'configure') {
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
      const fields = payload as { title: string; agenda: string; durationMinutes: number; kind?: 'ad-hoc'|'emergency'|'daily'|'weekly' };
      const invites = current.company.seats.map(seat => ({ seat, state: 'invited' as const, contribution: '', confirmedAt: null, evidence: null }));
      current.meetings.unshift({ id: randomUUID(), title: fields.title, kind: fields.kind ?? 'ad-hoc', agenda: fields.agenda, participants: ['ceo','marks-coo', ...current.company.seats], invitations: invites, at: now, durationMinutes: fields.durationMinutes, minutes: '', decisions: [], brainSync: 'pending' });
      current.activities.unshift({ id: randomUUID(), at: now, actor: 'marks-coo', kind: 'meeting', message: `Invited ${invites.length} seats to ${fields.title}; awaiting confirmation.` });
    } else if (action === 'inviteReserve' || action === 'inviteDelivered') {
      const fields = payload as { id: string; seat: string; ownerId: string; runId: string; workerId: string; queuedId?: string };
      const meeting = current.meetings.find(m => m.id === fields.id);
      const invite = meeting?.invitations?.find(row => row.seat === fields.seat);
      if (!meeting || !invite) throw new Error('Meeting invitation not found');
      if (action === 'inviteReserve') {
        if (invite.delivery) throw new Error('Meeting invitation already submitted or pending');
        invite.delivery = { ownerId: fields.ownerId, runId: fields.runId, workerId: fields.workerId, at: now, queuedId: null };
      } else {
        if (!invite.delivery || invite.delivery.queuedId || invite.delivery.ownerId !== fields.ownerId ||
            invite.delivery.runId !== fields.runId || invite.delivery.workerId !== fields.workerId)
          throw new Error('Meeting invitation identity changed');
        invite.delivery.queuedId = fields.queuedId!;
      }
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
    } else if (action === 'reserve' || action === 'bind' || action === 'progress') {
      const fields = payload as { id: string; ownerId?: string; workerId?: string; runId?: string; state?: string; conversationId?: string };
      const request = current.requests.find(r => r.id === fields.id);
      if (!request || !request.seat || !current.company.seats.slice(0, 10).includes(request.seat)) throw new Error('Explicit configured seat required');
      if (action === 'reserve') {
        if (request.status !== 'assigned' || request.execution || current.requests.some(r => r.id !== request.id && r.seat === request.seat &&
            (r.status === 'working' || r.execution && ['admitted','running','awaiting-authorization'].includes(r.execution.phase))))
          throw new Error('Seat occupied or execution already submitted');
        if (request.engine !== 'chatgpt' || !request.tokenBudget || !request.timeBudgetMinutes)
          throw new Error('Real broker requires ChatGPT with positive token and time budgets');
        request.execution = { mode: 'live', phase: 'awaiting-authorization', ownerId: request.id, workerId: null, runId: null,
          reportId: null, result: null, evidence: null, authorizedAt: now };
      } else {
        const execution = request.execution;
        if (!execution || execution.mode !== 'live' || execution.ownerId !== request.id) throw new Error('Execution not reserved');
        if (action === 'bind') {
          if (execution.phase !== 'awaiting-authorization' || execution.workerId || execution.runId) throw new Error('Worker already bound');
          execution.workerId = fields.workerId!; execution.runId = fields.runId!; execution.phase = 'admitted';
        } else {
          if (execution.workerId !== fields.workerId || execution.runId !== fields.runId) throw new Error('Worker identity mismatch');
          if (fields.conversationId !== undefined) {
            if (!fields.conversationId.trim() || fields.conversationId.length > 160 ||
              (execution.conversationId && execution.conversationId !== fields.conversationId))
              throw new Error('Broker worker conversation identity changed');
            execution.conversationId = fields.conversationId;
          }
          if (execution.phase === 'admitted' && fields.state === 'active') { execution.phase = 'running'; request.status = 'working'; }
        }
      }
      request.updatedAt = now;
      request.history.push({ at: now, actor: 'marks-coo', note: action === 'reserve' ? `Reserved ${request.seat} for authorized broker submission` :
        action === 'bind' ? `Broker bound ${fields.workerId} to ${request.seat}` : `Broker state ${fields.state}` });
      current.activities.unshift({ id: randomUUID(), at: now, actor: 'marks-coo', kind: 'request', requestId: request.id, message: request.history.at(-1)!.note });
    } else if (action === 'authorize' || action === 'report' || action === 'confirm' || action === 'confirmDelegated') {
      const fields = payload as { id: string; ownerId?: string; workerId: string; runId: string; conversationId?: string; reportId?: string; result?: string; evidence?: string; outcome?: 'completed'|'failed'; epoch?: number };
      const request = current.requests.find(row => row.id === fields.id);
      if (!request || !request.seat) throw new Error('Ticket has no assigned seat');
      if (action === 'confirmDelegated' && (current.delegation.mode !== 'delegated' ||
        current.delegation.delegate !== 'marks-coo' || !current.delegation.scopes.includes('ticket-review') ||
        current.delegation.epoch !== fields.epoch)) throw new Error('Delegation revoked or changed; decision refused');
      if (action === 'authorize') {
        if (request.execution) throw new Error('Execution already admitted');
        if (request.status !== 'assigned') throw new Error('Ticket must be assigned before authorization');
        if (current.requests.some(row => row.id !== request.id && row.seat === request.seat && row.execution?.phase === 'running')) throw new Error('Seat already running a ticket');
        request.execution = { mode: 'live', phase: 'admitted', ownerId: fields.ownerId!, workerId: fields.workerId, runId: fields.runId, reportId: null, result: null, evidence: null, authorizedAt: now };
        request.status = 'working';
      } else if (action === 'report') {
        const exec = request.execution;
        if (!exec || exec.workerId !== fields.workerId || exec.runId !== fields.runId || exec.mode !== 'live' || !['running','admitted'].includes(exec.phase)) throw new Error('Worker identity mismatch');
        if (fields.conversationId !== undefined) {
          if (!fields.conversationId.trim() || fields.conversationId.length > 160 ||
            (exec.conversationId && exec.conversationId !== fields.conversationId))
            throw new Error('Broker worker conversation identity changed');
          exec.conversationId = fields.conversationId;
        }
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
        request.cooConfirmation = { actor: action === 'confirmDelegated' ? 'marks-coo' : 'ceo', at: now, reportId: exec.reportId, workerId: exec.workerId, evidence: fields.evidence };
        request.status = 'done';
        if (action === 'confirm') current.delegationAudit.unshift({ id: randomUUID(), at: now,
          epoch: current.delegation.epoch, action: 'decision-approved', actor: 'ceo', delegate: null,
          scope: 'ticket-review', requestId: request.id, reason: 'explicit-ceo' });
        if (action === 'confirmDelegated') current.delegationAudit.unshift({ id: randomUUID(), at: now,
          epoch: current.delegation.epoch, action: 'decision-approved', actor: 'marks-coo', delegate: 'marks-coo',
          scope: 'ticket-review', requestId: request.id, reason: 'authenticated-coo' });
      }
      request.updatedAt = now;
      const confirmation = action === 'confirm' || action === 'confirmDelegated';
      const decisionActor = action === 'confirm' ? 'ceo' : 'marks-coo';
      request.history.push({ at: now, actor: decisionActor, note: action === 'authorize' ? `Authorized ${request.seat} as ${fields.workerId}` : action === 'report' ? `Worker ${fields.workerId} reported ${fields.outcome}` : `${decisionActor} confirmed report ${fields.reportId} for ${request.seat}`, ...(confirmation ? { from: 'review' as const, to: 'done' as const } : {}) });
      current.activities.unshift({ id: randomUUID(), at: now, actor: decisionActor, kind: 'request', requestId: request.id, message: request.history.at(-1)!.note });
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
    current.delegationAudit = current.delegationAudit.slice(0, 300);
    await save(current);
    return current;
  });
}
