import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { companyIpcSchema } from '../src/main/company-ipc.js';
import { initCompanyStore, resetCompanyStoreForTests, getCompany, mutateCompany } from '../src/main/company-store.js';
import { companySnapshotSchema, emptyCompany } from '../src/shared/company.js';
import { createCompanyBroker, type CompanyWorkerBackend } from '../src/main/company-broker.js';

let dir: string;
const reportId='synthetic-report';
const runId='00000000-0000-4000-8000-000000000099';
const backend: CompanyWorkerBackend = {
  async spawn() { throw new Error('not used'); },
  async status() { return { runId, workers:[{id:'worker-1',runId,label:`marks1:${currentId}`,state:'finished',result:'Complete'}] }; },
  async reports() { return []; }, async send() { throw new Error('not used'); }, async ack() { throw new Error('not used'); }
};
let currentId='';
beforeEach(async()=>{ dir=await mkdtemp(path.join(tmpdir(),'marks-o6-')); initCompanyStore(dir); currentId=''; });
afterEach(async()=>{ resetCompanyStoreForTests(); await rm(dir,{recursive:true,force:true}); });

async function preparedTicket() {
  const created=await mutateCompany('create',{title:'Synthetic ticket',project:'Tests',owner:'marks-coo',origin:'ceo',acceptance:'Verify',engine:'chatgpt',model:'fake',tokenBudget:100,timeBudgetMinutes:30,dueAt:null});
  currentId=created.requests[0]!.id;
  await mutateCompany('seat',{id:currentId,seat:'marks1'});
  await mutateCompany('move',{id:currentId,status:'assigned'});
  await mutateCompany('authorize',{id:currentId,ownerId:currentId,runId,workerId:'worker-1'});
  await mutateCompany('report',{id:currentId,runId,workerId:'worker-1',reportId,result:'Complete',evidence:'synthetic broker receipt',outcome:'completed'});
  return currentId;
}

describe('Company O6 delegation',()=>{
  it('defaults to manual mode in new and legacy snapshots',async()=>{
    expect((await getCompany()).delegation.mode).toBe('manual');
    const old=emptyCompany() as Partial<ReturnType<typeof emptyCompany>>;
    delete old.delegation; delete old.delegationAudit;
    await mkdir(path.join(dir,'company'),{recursive:true});
    await writeFile(path.join(dir,'company','company.json'),JSON.stringify(old));
    const loaded=await getCompany();
    expect(loaded.delegation).toMatchObject({mode:'manual',epoch:0,delegate:null});
    await mutateCompany('configure',{name:'legacy',seatCount:5});
    expect(companySnapshotSchema.parse(JSON.parse(await readFile(path.join(dir,'company','company.json'),'utf8'))).delegation.mode).toBe('manual');
  });
  it('records explicit CEO grant and revocation and survives reload',async()=>{
    await mutateCompany('delegationGrant',undefined);
    expect((await getCompany()).delegation).toMatchObject({mode:'delegated',delegate:'marks-coo',scopes:['ticket-review'],epoch:1});
    await mutateCompany('delegationRevoke',undefined);
    expect((await getCompany()).delegation).toMatchObject({mode:'manual',epoch:2,delegate:null});
    expect((await getCompany()).delegationAudit.map(e=>e.action)).toEqual(['revoke','grant']);
    resetCompanyStoreForTests();initCompanyStore(dir);
    expect((await getCompany()).delegation.epoch).toBe(2);
  });
  it('rejects renderer impersonation and limits delegated scope',()=>{
    for (const action of ['confirmDelegated','delegationDeny','authorizeAsCoo'])
      expect(companyIpcSchema.safeParse({action,payload:{id:runId,actor:'marks-coo',authenticated:true}}).success).toBe(false);
    expect(companyIpcSchema.safeParse({action:'delegationGrant',payload:{delegate:'marks-cto',scope:'permissions'}}).success).toBe(false);
    expect(companyIpcSchema.safeParse({action:'delegationGrant',payload:{delegate:'marks-coo',scope:'ticket-review'}}).success).toBe(true);
  });
  it('refuses delegated review with no authenticated backend COO identity',async()=>{
    const id=await preparedTicket();await mutateCompany('delegationGrant',undefined);
    await expect(createCompanyBroker(backend).reviewDelegated(id,'Synthetic approved')).rejects.toThrow('identity is unavailable');
    expect((await getCompany()).requests[0]!.status).toBe('review');
    expect((await getCompany()).delegationAudit[0]!.reason).toBe('invalid-identity');
  });
  it('fences epoch changed while broker status request is in flight',async()=>{
    const id=await preparedTicket();await mutateCompany('delegationGrant',undefined);
    let release!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;});
    let started!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const delayed={...backend,status:async (...args:Parameters<CompanyWorkerBackend['status']>)=>{started();await pending;return backend.status(...args);}};
    const attempt=createCompanyBroker(delayed).reviewDelegated(id,'Synthetic verified',{role:'marks-coo',authenticated:true});
    await entered; await mutateCompany('delegationRevoke',undefined);release();
    await expect(attempt).rejects.toThrow('revoked or changed');
    expect((await getCompany()).requests[0]!.status).toBe('review');
  });
  it('allows a verified synthetic COO decision only through main broker and audits it',async()=>{
    const id=await preparedTicket();await mutateCompany('delegationGrant',undefined);
    await createCompanyBroker(backend).reviewDelegated(id,'Synthetic review evidence',{role:'marks-coo',authenticated:true});
    const state=await getCompany();
    expect(state.requests[0]).toMatchObject({status:'done',cooConfirmation:{actor:'marks-coo'}});
    expect(state.delegationAudit[0]).toMatchObject({action:'decision-approved',actor:'marks-coo',requestId:id,epoch:1});
  });
  it('keeps all meeting kinds available regardless of approval mode, without fabricated presence',async()=>{
    for (const kind of ['emergency','daily','weekly'] as const) {
      if (kind==='daily') await mutateCompany('delegationGrant',undefined);
      if (kind==='weekly') await mutateCompany('delegationRevoke',undefined);
      const result=await mutateCompany('meeting',{title:kind,agenda:'Synthetic',kind,durationMinutes:30});
      expect(result.meetings[0]).toMatchObject({kind,invitations:expect.arrayContaining([expect.objectContaining({state:'invited',confirmedAt:null})])});
      expect(result.meetings[0]!.invitations).toHaveLength(5);
    }
  });
});
