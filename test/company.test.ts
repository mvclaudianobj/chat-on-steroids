import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { companyIpcSchema } from '../src/main/company-ipc.js';
import { COMPANY_ROLES, companySnapshotSchema, demoCompany, emptyCompany } from '../src/shared/company.js';
import { getCompany, initCompanyStore, mutateCompany, resetCompanyStoreForTests } from '../src/main/company-store.js';
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'marks-company-')); initCompanyStore(dir); });
afterEach(async () => { resetCompanyStoreForTests(); await fs.rm(dir, { recursive: true, force: true }); });
const create = { title: 'Synthetic design review', project: 'Prototype', owner: 'marks-cpo' as const, origin: 'ceo' as const, acceptance: 'Include screenshots', engine: 'codex', model: 'example', tokenBudget: 1000, timeBudgetMinutes: 45, dueAt: null };
describe('company contract', () => {
  it('keeps seven fixed roles and five named seats', () => { const data = emptyCompany(); expect(data.company.roles).toEqual(COMPANY_ROLES); expect(data.company.seats).toEqual(['marks1','marks2','marks3','marks4','marks5']); expect(companySnapshotSchema.parse(data)).toEqual(data); });
  it('rejects skipped/duplicate seats and assigned work without a seat', () => {
    const value = emptyCompany(); value.company.seats[1] = 'marks4'; expect(companySnapshotSchema.safeParse(value).success).toBe(false);
    const demo = demoCompany(); demo.requests[0]!.status = 'working'; expect(companySnapshotSchema.safeParse(demo).success).toBe(false);
  });
  it('parses synthetic meetings, history and activity', () => { const data = demoCompany(); expect(data.requests).toHaveLength(8); expect(data.meetings).toHaveLength(1); expect(data.activities).toHaveLength(8); expect(companySnapshotSchema.safeParse(data).success).toBe(true); });
  it('validates commands at the IPC edge', () => {
    expect(companyIpcSchema.safeParse({ action: 'move', payload: { id: 'abc', status: 'done' } }).success).toBe(false);
    expect(companyIpcSchema.safeParse({ action: 'demo', extra: 'unsafe' }).success).toBe(false);
    expect(companyIpcSchema.safeParse({ action: 'create', payload: { ...create, tokenBudget: -1 } }).success).toBe(false);
    expect(companyIpcSchema.safeParse({ action: 'create', payload: create }).success).toBe(true);
  });
});
describe('company durable store', () => {
  it('starts empty without writing example records', async () => { expect(await getCompany()).toEqual(emptyCompany()); await expect(fs.stat(path.join(dir, 'company', 'company.json'))).rejects.toMatchObject({ code: 'ENOENT' }); });
  it('creates, moves, assigns and persists one request across reads', async () => {
    const added = await mutateCompany('create', create);
    const id = added.requests[0]!.id;
    await mutateCompany('seat', { id, seat: 'marks1' });
    await mutateCompany('move', { id, status: 'assigned' });
    expect((await getCompany()).requests[0]).toMatchObject({ seat: 'marks1', status: 'assigned' });
    await mutateCompany('seat', { id, seat: 'marks3' });
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'company', 'company.json'), 'utf8'));
    expect(companySnapshotSchema.parse(stored).requests[0]).toMatchObject({ seat: 'marks3', status: 'assigned' });
    expect((await getCompany()).activities).toHaveLength(4);
  });
  it('does not mutate an existing file on invalid reassignment or rejected capacity reduction', async () => {
    const added = await mutateCompany('create', create); const id = added.requests[0]!.id;
    await mutateCompany('seat', { id, seat: 'marks5' });
    const file = path.join(dir, 'company', 'company.json'); const before = await fs.readFile(file, 'utf8');
    await expect(mutateCompany('configure', { name: 'Studio', seatCount: 4 })).rejects.toThrow('Reassign');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });
  it('preserves corrupted state instead of overwriting it with defaults', async () => {
    await fs.mkdir(path.join(dir, 'company'), { recursive: true }); await fs.writeFile(path.join(dir, 'company', 'company.json'), '{broken');
    await expect(getCompany()).rejects.toThrow('could not be read');
    await expect(mutateCompany('demo', undefined)).rejects.toThrow('could not be read');
    expect(await fs.readFile(path.join(dir, 'company', 'company.json'), 'utf8')).toBe('{broken');
  });
  it('inserts sample data only with an explicit action', async () => {
    const sample = await mutateCompany('demo', undefined); expect(sample.demo).toBe(true);
    await expect(mutateCompany('demo', undefined)).rejects.toThrow('empty company');
  });
});


describe('phase 2 pilot safety', () => {
  it('keeps explicit seat and blocks false Done until matching worker report', async () => {
    const ticket = (await mutateCompany('create', create)).requests[0]!;
    await expect(mutateCompany('move',{id:ticket.id,status:'working'})).rejects.toThrow('Working requires verified broker admission');
    await mutateCompany('seat',{id:ticket.id,seat:'marks5'});
    await mutateCompany('move',{id:ticket.id,status:'assigned'});
    await expect(mutateCompany('move',{id:ticket.id,status:'done'})).rejects.toThrow('Verified report required');
    expect((await getCompany()).requests[0]!.seat).toBe('marks5');
    const ownerId='00000000-0000-4000-8000-000000000201', runId='00000000-0000-4000-8000-000000000202';
    await mutateCompany('authorize',{id:ticket.id,ownerId,runId,workerId:'worker-5',consent:true});
    await expect(mutateCompany('seat',{id:ticket.id,seat:'marks2'})).rejects.toThrow('Cannot silently replace');
    await expect(mutateCompany('report',{id:ticket.id,runId,workerId:'worker-4',reportId:'r1',result:'Done',evidence:'run receipt',outcome:'completed'})).rejects.toThrow('Worker identity mismatch');
    expect((await getCompany()).requests[0]!.status).toBe('working');
    await mutateCompany('report',{id:ticket.id,runId,workerId:'worker-5',reportId:'r1',result:'Finished review',evidence:'session event #123',outcome:'completed'});
    expect((await getCompany()).requests[0]).toMatchObject({status:'review',seat:'marks5',execution:{phase:'reported',reportId:'r1'}});
    await mutateCompany('move',{id:ticket.id,status:'done'});
    expect((await getCompany()).requests[0]!.status).toBe('done');
  });
  it('invites all seats; never presumes presence or saves minutes to Brain', async () => {
    await mutateCompany('configure',{name:'Pilot',seatCount:10});
    const snapshot = await mutateCompany('meeting',{title:'Team sync',agenda:'Planning',durationMinutes:30});
    const meeting = snapshot.meetings[0]!;
    expect(meeting.invitations).toHaveLength(10);
    expect(meeting.invitations!.every(i=>i.state==='invited' && i.confirmedAt===null)).toBe(true);
    await expect(mutateCompany('attendance',{id:meeting.id,seat:'marks1',state:'present',contribution:'Here',evidence:'simulated-signature'})).rejects.toThrow('Presence requires acceptance');
    await mutateCompany('attendance',{id:meeting.id,seat:'marks1',state:'accepted',contribution:'',evidence:'simulated-ack'});
    await mutateCompany('attendance',{id:meeting.id,seat:'marks1',state:'present',contribution:'I can check the tests',evidence:'simulated-message-1'});
    await mutateCompany('minutes',{id:meeting.id,minutes:'Synthetic agenda minutes',decisions:['Continue review']});
    const persisted=(await getCompany()).meetings[0]!;
    expect(persisted.invitations!.filter(i=>i.state==='present')).toHaveLength(1);
    expect(persisted.invitations![1]!.state).toBe('invited');
    expect(persisted.brainSync).toBe('pending');
  });
  it('keeps legacy configurations above ten without deleting seats or tickets', async () => {
    const old = emptyCompany(); old.company.seatCount=20; old.company.seats=Array.from({length:20},(_,i)=>`marks${i+1}`);
    await fs.mkdir(path.join(dir,'company'),{recursive:true});
    await fs.writeFile(path.join(dir,'company','company.json'),JSON.stringify(old));
    const ticket=(await mutateCompany('create',create)).requests[0]!;
    await mutateCompany('seat',{id:ticket.id,seat:'marks20'});
    await mutateCompany('configure',{name:'Still legacy',seatCount:20});
    expect((await getCompany()).company.seats).toContain('marks20');
    await expect(mutateCompany('configure',{name:'Shrink',seatCount:10})).rejects.toThrow('Reassign');
    expect((await getCompany()).requests[0]!.seat).toBe('marks20');
  });
});
