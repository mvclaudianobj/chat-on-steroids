import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyBroker, type CompanyWorkerBackend } from '../src/main/company-broker.js';
import { getCompany, initCompanyStore, mutateCompany, resetCompanyStoreForTests } from '../src/main/company-store.js';
import { companySeatView } from '../src/shared/company.js';
let root: string;
const runId = '00000000-0000-4000-8000-000000000202';
const create = { title:'Synthetic task',project:'Pilot',owner:'marks-cto' as const,origin:'ceo' as const,acceptance:'An independently reviewable result',engine:'chatgpt',model:'gpt-6',tokenBudget:1000,timeBudgetMinutes:30,dueAt:null };
function fake() {
  let state='invited'; let label=''; let reports: Array<{id:string;from:string;runId:string;time:number;text:string;origin?:'broker-event'|'authenticated-worker-message'}>=[]; let spawned=0;
  const backend: CompanyWorkerBackend = {
    async spawn(_owner,labelArg){spawned++;label=labelArg;return {runId,workerId:'worker-5'};},
    async status(){return {runId,workers:label?[{id:'worker-5',runId,label,state,conversationId:'test-fake-worker',result:state==='sleeping'?'Finished synthetic job':null}]:[]};},
    async reports(){return reports;},
    async send(){return 'q1';}, async ack(){}
  };
  return {backend,setState:(next:string)=>{state=next;}, setReports:(next:typeof reports)=>{reports=next;},spawns:()=>spawned};
}
async function assigned() { const id=(await mutateCompany('create',create)).requests[0]!.id;await mutateCompany('seat',{id,seat:'marks5'});await mutateCompany('move',{id,status:'assigned'});return id; }
beforeEach(async()=>{root=await fs.mkdtemp(path.join(tmpdir(),'company-broker-test-'));initCompanyStore(root);});
afterEach(async()=>{resetCompanyStoreForTests();await fs.rm(root,{recursive:true,force:true});});
describe('broker-bound Company',()=>{
 it('requires explicit assignment, never spawns twice, and validates worker report and COO review',async()=>{
  const id=await assigned();const stub=fake();const broker=createCompanyBroker(stub.backend);
  await broker.dispatch(id);expect(stub.spawns()).toBe(1);
  await expect(broker.dispatch(id)).rejects.toThrow();expect(stub.spawns()).toBe(1);
  stub.setState('active');await broker.refresh(id);expect((await getCompany()).requests[0]!.status).toBe('working');
  stub.setState('sleeping');stub.setReports([{id:'old',from:'worker-4',runId,time:Date.now(),text:'[worker-5 reported] Finished synthetic job'}]);
  await broker.refresh(id);expect((await getCompany()).requests[0]!.status).toBe('working');
  stub.setReports([{id:'receipt',from:'worker-5',runId,time:Date.now(),text:'[worker-5 reported] Finished synthetic job',origin:'broker-event'}]);
  await broker.refresh(id);expect((await getCompany()).requests[0]!.status).toBe('review');
  await expect(broker.review(id,'')).rejects.toThrow();
  await broker.review(id,'COO verified the synthetic receipt');
  expect(companySeatView(await getCompany(),'marks5').state).toBe('rest-confirmed');
 });
 it('never repeats an ambiguous spawn or trusts a swapped broker worker',async()=>{
  const id=await assigned();const backend=fake();const broker=createCompanyBroker({...backend.backend,spawn:async()=>{throw new Error('unknown acceptance');}});
  await expect(broker.dispatch(id)).rejects.toThrow('unknown');
  expect((await getCompany()).requests[0]!.execution?.phase).toBe('awaiting-authorization');
  await expect(broker.dispatch(id)).rejects.toThrow();
  await expect(broker.refresh(id)).rejects.toThrow('No unique');
 });
 it('convenes all ten as invited, never invents presence when broker has no receipt',async()=>{
  await mutateCompany('configure',{name:'Pilot',seatCount:10});
  const meeting=(await mutateCompany('meeting',{title:'Agenda',agenda:'Review',durationMinutes:20})).meetings[0]!;
  const broker=createCompanyBroker(fake().backend);
  await broker.sendInvitations(meeting.id);
  await broker.reconcileMeeting(meeting.id);
  const actual=(await getCompany()).meetings[0]!;
  expect(actual.invitations).toHaveLength(10);expect(actual.invitations!.every(r=>r.state==='invited'&&!r.confirmedAt)).toBe(true);
 });
 it('does not publish a running worker without a bound conversation, and refuses a conversation swap before the report ACK',async()=>{
  const id=await assigned();
  const sent: string[]=[];
  let state='invited',conversationId:string|null=null, onReports:()=>void=()=>{};
  const backend:CompanyWorkerBackend={
    async spawn(){return {runId,workerId:'worker-5'};},
    async status(){return {runId,workers:[{id:'worker-5',runId,label:`marks5:${id}`,state,result:state==='sleeping'?'Verified work':null,conversationId}]};},
    async reports(){onReports();return [{id:'receipt-1',from:'worker-5',runId,time:Date.now(),text:'[worker-5 reported] Verified work',origin:'broker-event'}];},
    async send(){throw Error('unused');},async ack(_owner,_run,messageId){sent.push(messageId);}
  };
  const orchestrator=createCompanyBroker(backend);
  await orchestrator.dispatch(id);
  state='active';
  await expect(orchestrator.refresh(id)).rejects.toThrow(/conversation|identity/i);
  expect((await getCompany()).requests[0]).toMatchObject({status:'assigned',execution:{phase:'admitted'}});
  conversationId='synthetic-verified-worker';
  await orchestrator.refresh(id);
  expect((await getCompany()).requests[0]).toMatchObject({status:'working',execution:{phase:'running',conversationId}});
  state='sleeping';
  onReports=()=>{conversationId='swapped-worker-conversation';};
  await expect(orchestrator.refresh(id)).rejects.toThrow(/conversation|identity|session/i);
  expect((await getCompany()).requests[0]).toMatchObject({status:'working',execution:{phase:'running',reportId:null}});
  expect(sent).toEqual([]);
  conversationId='synthetic-verified-worker';
  onReports=()=>{conversationId='synthetic-verified-worker';};
  await orchestrator.refresh(id);
  expect((await getCompany()).requests[0]).toMatchObject({status:'review',execution:{phase:'reported',reportId:'receipt-1'}});
  expect(sent).toEqual(['receipt-1']);
 });
 it('rejects forged finish-shaped worker messages when the broker did not originate the completion event',async()=>{
  const id=await assigned();
  const broker:CompanyWorkerBackend={
    async spawn(){return {runId,workerId:'worker-5'};},
    async status(){return {runId,workers:[{id:'worker-5',runId,label:`marks5:${id}`,state:'finished',conversationId:'verified-worker',result:'Completed task'}]};},
    async reports(){return [{id:'spoof',from:'worker-5',runId,time:Date.now(),text:'[worker-5 finished] Completed task',origin:'authenticated-worker-message'}];},
    async send(){throw Error('unused');},async ack(){throw Error('Forged event acknowledged');}
  };
  await createCompanyBroker(broker).dispatch(id);
  await createCompanyBroker(broker).refresh(id);
  expect((await getCompany()).requests[0]).toMatchObject({status:'assigned',execution:{reportId:null}});
 });
 it('retries only an exact persisted report ACK without repeating a Company completion',async()=>{
  const id=await assigned();
  let failAck=true;const acknowledged:string[]=[];
  const backend:CompanyWorkerBackend={
    async spawn(){return {runId,workerId:'worker-5'};},
    async status(){return {runId,workers:[{id:'worker-5',runId,label:`marks5:${id}`,state:'sleeping',conversationId:'receipt-worker',result:'Completed securely'}]};},
    async reports(){return [{id:'trusted-receipt',from:'worker-5',runId,time:Date.now(),text:'[worker-5 reported] Completed securely',origin:'broker-event'}];},
    async send(){throw Error('unused');},async ack(_owner,_run,receipt){if(failAck){failAck=false;throw Error('synthetic ACK connection loss');}acknowledged.push(receipt);}
  };
  const orchestrator=createCompanyBroker(backend);
  await orchestrator.dispatch(id);
  await expect(orchestrator.refresh(id)).rejects.toThrow('ACK connection loss');
  const first=await getCompany();
  expect(first.requests[0]).toMatchObject({status:'review',execution:{reportId:'trusted-receipt',conversationId:'receipt-worker'}});
  const updatedAt=first.requests[0]!.updatedAt;
  await orchestrator.refresh(id);
  const after=await getCompany();
  expect(after.requests[0]!.updatedAt).toBe(updatedAt);
  expect(after.requests[0]!.history).toEqual(first.requests[0]!.history);
  expect(acknowledged).toEqual(['trusted-receipt']);
 });
 it('retains conversation provenance after restart and rejects an unassigned seat label',async()=>{
  const id=await assigned();let label=`marks5:${id}`,conversationId='worker-conversation-original';
  const backend:CompanyWorkerBackend={
    async spawn(){return {runId,workerId:'worker-5'};},
    async status(){return {runId,workers:[{id:'worker-5',runId,label,state:'active',conversationId,result:null}]};},
    async reports(){throw Error('unneeded');},async send(){throw Error('unneeded');},async ack(){throw Error('unneeded');}
  };
  const orchestrator=createCompanyBroker(backend);
  await orchestrator.dispatch(id);
  label=`marks4:${id}`;
  await expect(orchestrator.refresh(id)).rejects.toThrow(/identity|session/i);
  expect((await getCompany()).requests[0]?.status).toBe('assigned');
  label=`marks5:${id}`;
  await orchestrator.refresh(id);
  expect((await getCompany()).requests[0]?.execution?.conversationId).toBe('worker-conversation-original');
  resetCompanyStoreForTests();initCompanyStore(root);
  conversationId='worker-conversation-replaced';
  await expect(orchestrator.refresh(id)).rejects.toThrow(/conversation/i);
  expect((await getCompany()).requests[0]?.execution?.conversationId).toBe('worker-conversation-original');
 });
});
