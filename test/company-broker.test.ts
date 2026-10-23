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
  let state='invited'; let label=''; let reports: Array<{id:string;from:string;runId:string;time:number;text:string}>=[]; let spawned=0;
  const backend: CompanyWorkerBackend = {
    async spawn(_owner,labelArg){spawned++;label=labelArg;return {runId,workerId:'worker-5'};},
    async status(){return {runId,workers:label?[{id:'worker-5',runId,label,state,result:state==='sleeping'?'Finished synthetic job':null}]:[]};},
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
  stub.setReports([{id:'receipt',from:'worker-5',runId,time:Date.now(),text:'[worker-5 reported] Finished synthetic job'}]);
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
});
