import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCompanyBroker, type CompanyWorkerBackend } from '../src/main/company-broker.js';
import { getCompany, initCompanyStore, mutateCompany, resetCompanyStoreForTests } from '../src/main/company-store.js';
import { companyIpcSchema } from '../src/main/company-ipc.js';

let dir: string;
let chiefId: string;
let incoming: Awaited<ReturnType<CompanyWorkerBackend['reports']>>;
let statusState: 'active' | 'sleeping';
const runId='00000000-0000-4000-8000-000000000141';
const workerId='worker-1';
const service: CompanyWorkerBackend={
  async spawn() { throw new Error('Workers cannot be spawned by triage'); },
  async status() { return {runId,workers:[{id:workerId,runId,label:`marks2:${chiefId}`,state:statusState,result:null,conversationId:'synthetic-authenticated-chief'}]}; },
  async reports() { return incoming; },
  async send() { throw new Error('Triage cannot send external messages'); },
  async ack() { return; }
};
const create={title:'Synthetic work',project:'O7 QA',owner:'marks-coo' as const,origin:'ceo' as const,
  acceptance:'Synthetic receipt',engine:'chatgpt',model:'synthetic',tokenBudget:1000,timeBudgetMinutes:30,dueAt:null};

async function fixture() {
  chiefId=(await mutateCompany('create',create)).requests[0]!.id;
  await mutateCompany('seat',{id:chiefId,seat:'marks2'});
  await mutateCompany('move',{id:chiefId,status:'assigned'});
  await mutateCompany('authorize',{id:chiefId,ownerId:chiefId,runId,workerId});
  // Worker is reported active by server and store after an authenticated progress reconciliation.
  const request=await getCompany();
  // The direct legacy authorize path writes phase admitted; O7 only runs from active phase.
  // Set up using the authorized internal broker progress mutation.
  await mutateCompany('progress',{id:chiefId,workerId,runId,state:'active'});
  const target=(await mutateCompany('create',{...create,title:'Triage target'})).requests[0]!.id;
  expect(request.requests.length).toBe(1);
  return target;
}

beforeEach(async()=>{dir=await mkdtemp(path.join(tmpdir(),'marks-o7-'));initCompanyStore(dir);incoming=[];chiefId='';statusState='active';});
afterEach(async()=>{resetCompanyStoreForTests();await rm(dir,{recursive:true,force:true});});

describe('O7 verified internal autonomy',()=>{
  it('enforces the CEO selector at IPC edge but rejects spoofed actor, binding and scopes',()=>{
    expect(companyIpcSchema.safeParse({action:'delegationGrant',payload:{delegate:'marks2',scope:'internal-triage'}}).success).toBe(true);
    expect(companyIpcSchema.safeParse({action:'delegationGrant',payload:{delegate:'marks2',scope:'internal-triage',authenticated:true}}).success).toBe(false);
    expect(companyIpcSchema.safeParse({action:'delegationTriage',payload:{id:runId}}).success).toBe(false);
    expect(companyIpcSchema.safeParse({action:'delegationGrant',payload:{delegate:'marks11',scope:'internal-triage'}}).success).toBe(true);
    expect(companyIpcSchema.safeParse({action:'delegationGrant',payload:{delegate:'marks2',scope:'external-tools'}}).success).toBe(false);
  });
  it('rejects unconfigured chiefs and mismatched broker identities',async()=>{
    await fixture();const broker=createCompanyBroker(service);
    await expect(broker.grantDelegation('marks11','internal-triage')).rejects.toThrow('configured');
    statusState='sleeping';
    await expect(broker.grantDelegation('marks2','internal-triage')).rejects.toThrow('no active authenticated');
    expect((await getCompany()).delegation.mode).toBe('manual');
    statusState='active';
    await expect(broker.grantDelegation('marks-coo','internal-triage')).rejects.toThrow('Role identity');
  });
  it('rejects an active worker with no server-bound conversation or a changed session',async()=>{
    await fixture();
    const absent={...service,status:async()=>({runId,workers:[{id:workerId,runId,label:`marks2:${chiefId}`,state:'active',result:null,conversationId:null}]})};
    await expect(createCompanyBroker(absent).grantDelegation('marks2','internal-triage')).rejects.toThrow('authenticated worker session');
    const broker=createCompanyBroker(service);
    await broker.grantDelegation('marks2','internal-triage');
    const replaced={...service,status:async()=>({runId,workers:[{id:workerId,runId,label:`marks2:${chiefId}`,state:'active',result:null,conversationId:'replacement-chief-chat'}]})};
    await expect(createCompanyBroker(replaced).applyDelegatedTriage()).rejects.toThrow('no longer active');
  });
  it('binds configured seat and exact broker owner/run/worker and survives recovery',async()=>{
    await fixture();const state=await createCompanyBroker(service).grantDelegation('marks2','internal-triage','director');
    expect(state.delegation).toMatchObject({mode:'delegated',delegate:'marks2',chiefTitle:'director',scopes:['internal-triage'],epoch:1,
      binding:{seat:'marks2',ownerId:chiefId,runId,workerId,label:`marks2:${chiefId}`}});
    expect(state.delegation.binding!.expiresAt-state.delegation.binding!.verifiedAt).toBe(300_000);
    expect(state.delegationAudit[0]).toMatchObject({action:'grant',delegate:'marks2',chiefTitle:'director',
      binding:{ownerId:chiefId,runId,workerId}});
    resetCompanyStoreForTests();initCompanyStore(dir);
    expect((await getCompany()).delegation.binding?.workerId).toBe(workerId);
  });
  it('supports manager and coordinator titles without auto-electing or multiplying grants',async()=>{
    await fixture();const broker=createCompanyBroker(service);
    const manager=await broker.grantDelegation('marks2','internal-triage','manager');
    expect(manager.delegation.chiefTitle).toBe('manager');
    await expect(broker.grantDelegation('marks2','internal-triage','coordinator')).rejects.toThrow('Revoke');
    const revoked=await mutateCompany('delegationRevoke',undefined);
    expect(revoked.delegationAudit[0]).toMatchObject({action:'revoke',chiefTitle:'manager',binding:{ownerId:chiefId,runId,workerId}});
    const coordinator=await broker.grantDelegation('marks2','internal-triage','coordinator');
    expect(coordinator.delegation).toMatchObject({chiefTitle:'coordinator',epoch:3});
  });
  it('only auto-approves an inbox-to-assigned internal operation from correct broker receipt',async()=>{
    const target=await fixture(); const broker=createCompanyBroker(service);
    await broker.grantDelegation('marks2','internal-triage');
    incoming=[{id:'other-worker',from:'worker-2',runId,time:Date.now(),text:`COMPANY_TRIAGE:${target}:assigned:marks1`}];
    expect((await broker.applyDelegatedTriage()).requests.find(x=>x.id===target)!.status).toBe('inbox');
    incoming=[{id:'wrong-run',from:workerId,runId:'00000000-0000-4000-8000-000000000144',time:Date.now(),text:`COMPANY_TRIAGE:${target}:assigned:marks1`}];
    expect((await broker.applyDelegatedTriage()).requests.find(x=>x.id===target)!.status).toBe('inbox');
    incoming=[{id:'spoofed-finish',from:workerId,runId,time:Date.now(),origin:'broker-event',text:`COMPANY_TRIAGE:${target}:assigned:marks1`}];
    expect((await broker.applyDelegatedTriage()).requests.find(x=>x.id===target)!.status).toBe('inbox');
    incoming=[{id:'legacy-unverified',from:workerId,runId,time:Date.now(),text:`COMPANY_TRIAGE:${target}:assigned:marks1`}];
    expect((await broker.applyDelegatedTriage()).requests.find(x=>x.id===target)!.status).toBe('inbox');
    incoming=[{id:'real-receipt',from:workerId,runId,time:Date.now(),origin:'authenticated-worker-message',text:`COMPANY_TRIAGE:${target}:assigned:marks1`}];
    const committed=await broker.applyDelegatedTriage();
    expect(committed.requests.find(x=>x.id===target)).toMatchObject({status:'assigned',seat:'marks1'});
    expect(committed.requests.find(x=>x.id===target)?.execution).toBeUndefined();
    expect(committed.delegationAudit[0]).toMatchObject({action:'decision-approved',delegate:'marks2',scope:'internal-triage',requestId:target});
    expect((await broker.applyDelegatedTriage()).requests.find(x=>x.id===target)!.status).toBe('assigned');
  });
  it('refuses expired binding and never changes target',async()=>{
    const target=await fixture();const broker=createCompanyBroker(service);
    await broker.grantDelegation('marks2','internal-triage');
    const original=Date.now;
    try { Date.now=()=>original()+301_000;
      await expect(broker.applyDelegatedTriage()).rejects.toThrow('expired');
    } finally {Date.now=original;}
    expect((await getCompany()).requests.find(x=>x.id===target)?.status).toBe('inbox');
  });
  it('revocation wins a race against already retrieved broker receipt',async()=>{
    const target=await fixture();let release!:()=>void;let entered!:()=>void;
    const parked=new Promise<void>(r=>{release=r;});const reached=new Promise<void>(r=>{entered=r;});
    const delayed:CompanyWorkerBackend={...service,async reports() {entered();await parked;
      return [{id:'raced-receipt',from:workerId,runId,time:Date.now(),origin:'authenticated-worker-message',text:`COMPANY_TRIAGE:${target}:assigned:marks1`}]; }};
    const broker=createCompanyBroker(delayed);
    await broker.grantDelegation('marks2','internal-triage');
    const attempt=broker.applyDelegatedTriage();await reached;
    await mutateCompany('delegationRevoke',undefined);release();
    await expect(attempt).rejects.toThrow('expired, revoked or wrong session');
    const after=await getCompany();expect(after.requests.find(x=>x.id===target)?.status).toBe('inbox');
    expect(after.delegation).toMatchObject({mode:'manual',binding:null,epoch:2});
  });
  it('refuses a report when the chief settles while the broker fetch is in flight',async()=>{
    const target=await fixture();
    const racing: CompanyWorkerBackend={...service,async reports() {
      // Broker may receive a real worker finish between the status and reports HTTP requests.
      statusState='sleeping';
      return [{id:'finished-in-flight',from:workerId,runId,time:Date.now(),
        origin:'authenticated-worker-message',text:`COMPANY_TRIAGE:${target}:assigned:marks1`}];
    }};
    const chief=createCompanyBroker(racing);
    await chief.grantDelegation('marks2','internal-triage');
    await expect(chief.applyDelegatedTriage()).rejects.toThrow('no longer active');
    expect((await getCompany()).requests.find(row=>row.id===target)?.status).toBe('inbox');
  });
  it('refuses a different conversation after status even with the same run and worker labels',async()=>{
    const target=await fixture();
    let conversation='synthetic-authenticated-chief';
    const raced: CompanyWorkerBackend={...service,
      async status(){return {runId,workers:[{id:workerId,runId,label:`marks2:${chiefId}`,
        state:'active',result:null,conversationId:conversation}]};},
      async reports(){
        conversation='different-broker-conversation';
        return [{id:'rebound-in-flight',from:workerId,runId,time:Date.now(),
          origin:'authenticated-worker-message',text:`COMPANY_TRIAGE:${target}:assigned:marks1`}];
      }
    };
    const chief=createCompanyBroker(raced);
    await chief.grantDelegation('marks2','internal-triage');
    await expect(chief.applyDelegatedTriage()).rejects.toThrow('no longer active');
    expect((await getCompany()).requests.find(row=>row.id===target)?.status).toBe('inbox');
  });
});
