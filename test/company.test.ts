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
    await mutateCompany('move', { id, status: 'working' });
    expect((await getCompany()).requests[0]).toMatchObject({ seat: 'marks1', status: 'working' });
    await mutateCompany('seat', { id, seat: 'marks3' });
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'company', 'company.json'), 'utf8'));
    expect(companySnapshotSchema.parse(stored).requests[0]).toMatchObject({ seat: 'marks3', status: 'working' });
    expect((await getCompany()).activities).toHaveLength(3);
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
