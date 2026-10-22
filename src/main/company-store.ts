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
export function mutateCompany(action: 'demo' | 'configure' | 'create' | 'move' | 'seat', payload: unknown): Promise<CompanySnapshot> {
  return serialized(async () => {
    const current = await load();
    if (action === 'demo') {
      if (current.requests.length || current.meetings.length) throw new Error('Example data requires an empty company');
      const demo = demoCompany(); await save(demo); return demo;
    }
    const now = Date.now();
    if (action === 'configure') {
      const { name, seatCount } = payload as { name: string; seatCount: number };
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
    } else {
      const { id, status, seat } = payload as { id: string; status?: CompanyRequest['status']; seat?: string | null };
      const request = current.requests.find(r => r.id === id);
      if (!request) throw new Error('Request not found');
      const before = request.status;
      if (action === 'move') {
        request.status = status!;
        if (request.status === 'assigned' || request.status === 'working' || request.status === 'review') {
          request.seat ??= current.company.seats.find(name => !current.requests.some(r => r.id !== request.id && r.seat === name && r.status !== 'done')) ?? null;
          if (!request.seat) throw new Error('No free seat; request remains queued');
        }
      } else request.seat = seat!;
      if ((request.status === 'assigned' || request.status === 'working' || request.status === 'review') && !request.seat) throw new Error('Active work needs a seat');
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
