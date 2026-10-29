import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCompanyOrchestrator } from '../src/main/company-orchestrator.js';
import type { CompanyWorkerBackend } from '../src/main/company-broker.js';
import { getCompany, initCompanyStore, mutateCompany, resetCompanyStoreForTests } from '../src/main/company-store.js';

let directory='';
const uid=(number:number)=>`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const create={title:'Build a two-part release',project:'Isolated fixture',owner:'marks-coo' as const,
  origin:'ceo' as const,acceptance:'Both parts reviewed independently',engine:'chatgpt',model:'fixture',
  tokenBudget:1200,timeBudgetMinutes:30,dueAt:null,autoRun:true};

function fixture(){
  const workers=new Map<string,{runId:string;id:string;label:string;state:string;conversationId:string;result:string|null}>();
  const messages=new Map<string,Awaited<ReturnType<CompanyWorkerBackend['reports']>>>();
  const sent:string[]=[];const acked:string[]=[];
  let spawns=0;
  const backend:CompanyWorkerBackend={
    async spawn(owner,label){
      ++spawns;
      const worker={runId:uid(200+spawns),id:`worker-${spawns}`,label,state:'active',conversationId:`conversation-${spawns}`,result:null};
      workers.set(owner,worker);return {runId:worker.runId,workerId:worker.id};
    },
    async status(owner){const worker=workers.get(owner);return {runId:worker?.runId??null,
      workers:worker?[{...worker}]:[]};},
    async reports(owner){return messages.get(owner)??[];},
    async send(owner,_run,to,text){sent.push(`${owner}:${to}:${text}`);return `queue-${sent.length}`;},
    async ack(_owner,_run,id){acked.push(id);}
  };
  return {backend,workers,messages,sent,acked,spawns:()=>spawns};
}

beforeEach(async()=>{directory=await mkdtemp(path.join(tmpdir(),'company-orchestrator-'));initCompanyStore(directory);});
afterEach(async()=>{resetCompanyStoreForTests();await rm(directory,{recursive:true,force:true});});

describe('CEO -> COO -> two verified workers -> COO review',()=>{
  it('persists a planning meeting, delegates two real broker tickets, resumes and completes only with distinct COO receipts',async()=>{
    const state=fixture();
    const broker=createCompanyOrchestrator(state.backend);
    const id=(await mutateCompany('create',create)).requests[0]!.id;
    await broker.start(id);
    expect(state.spawns()).toBe(1);
    const chief=state.workers.get(id)!;
    state.messages.set(id,[{id:'plan-receipt',runId:chief.runId,from:chief.id,origin:'authenticated-worker-message',
      time:Date.now(),text:`COMPANY_PLAN:${id}:${JSON.stringify({tasks:[
        {seat:'marks1',title:'Implement module',acceptance:'Tests pass'},
        {seat:'marks2',title:'Verify module',acceptance:'Independent report'}],minutes:'COO delegated two parts'})}`}]);
    await broker.advance(id);
    let snapshot=await getCompany();
    let parent=snapshot.requests.find(row=>row.id===id)!;
    expect(parent.workflow?.children).toHaveLength(2);
    expect(snapshot.meetings[0]).toMatchObject({minutes:'COO delegated two parts'});
    expect(state.spawns()).toBe(3);
    // Same owner, worker, run and settled result are proved through broker receipts.
    for(const childId of parent.workflow!.children){
      const worker=state.workers.get(childId)!;
      await broker.advance(id);
      worker.state='sleeping';worker.result=`Accepted ${childId}`;
      state.messages.set(childId,[{id:`finish-${childId}`,from:worker.id,runId:worker.runId,
        origin:'broker-event',time:Date.now(),text:`[${worker.id} reported] ${worker.result}`}]);
    }
    await broker.advance(id);
    snapshot=await getCompany();parent=snapshot.requests.find(row=>row.id===id)!;
    expect(parent.workflow?.handoffs).toHaveLength(2);
    expect(parent.workflow?.handoffs.every(row=>row.state==='sent')).toBe(true);
    expect(parent.status).not.toBe('done');
    expect(state.sent).toHaveLength(2);
    const reports=parent.workflow!.children.map((childId,index)=>({id:`coo-approval-${index}`,
      from:chief.id,runId:chief.runId,time:Date.now(),origin:'authenticated-worker-message' as const,
      text:`COMPANY_REVIEW:${childId}:approved`}));
    state.messages.set(id,reports);
    await broker.advance(id);
    snapshot=await getCompany();parent=snapshot.requests.find(row=>row.id===id)!;
    expect(parent.status).toBe('done');
    expect(parent.workflow?.phase).toBe('done');
    expect(parent.workflow?.children.every(childId=>snapshot.requests.find(row=>row.id===childId)?.cooConfirmation?.actor==='marks-coo')).toBe(true);
    await createCompanyOrchestrator(state.backend).advance(id); // restart-style reinitialization
    expect(state.spawns()).toBe(3);
    expect(state.sent).toHaveLength(2);
    expect(state.acked).toContain('plan-receipt');
  });

  it('does not accept a planner receipt if the broker swapped its conversation',async()=>{
    const state=fixture();const broker=createCompanyOrchestrator(state.backend);
    const id=(await mutateCompany('create',create)).requests[0]!.id;
    await broker.start(id);
    const chief=state.workers.get(id)!;
    await broker.advance(id);
    chief.conversationId='replacement';
    state.messages.set(id,[{id:'forged',runId:chief.runId,from:chief.id,origin:'authenticated-worker-message',
      time:Date.now(),text:`COMPANY_PLAN:${id}:${JSON.stringify({tasks:[
        {seat:'marks1',title:'First',acceptance:'Check'},
        {seat:'marks2',title:'Second',acceptance:'Check'}],minutes:'No presence proof'})}`}]);
    await expect(broker.advance(id)).rejects.toThrow(/identity changed/i);
    expect((await getCompany()).requests.find(row=>row.id===id)?.workflow?.children).toEqual([]);
    expect(state.spawns()).toBe(1);
  });
});
