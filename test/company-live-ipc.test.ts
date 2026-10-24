import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCompany, initCompanyStore, mutateCompany, resetCompanyStoreForTests } from '../src/main/company-store.js';
import { registerCompanyIpc } from '../src/main/company-ipc.js';
import { initCompanyLocalGrants, resetCompanyLocalGrantsForTests, readLocalCompanyGrants } from '../src/main/company-local-grants.js';

const native = vi.hoisted(() => ({
  handler: null as null | ((event: unknown, payload: unknown) => Promise<{ok:boolean;data?:unknown;error?:string}>),
  response: 0,
  prompts: [] as string[],
  dispatches: 0
}));
vi.mock('electron',()=>({
  ipcMain:{handle:(_name:string,fn:typeof native.handler)=>{native.handler=fn;}},
  dialog:{showMessageBox:async(_window:unknown,options:{message:string})=>{
    native.prompts.push(options.message);return {response:native.response};
  }}
}));
vi.mock('../src/main/company-broker.js',()=>({
  createCompanyBroker:()=>({
    dispatch:async()=>{native.dispatches++;throw new Error('Broker denied synthetic owner grant');},
    refresh:async()=>{throw new Error('No broker-bound ticket');},
    review:async()=>{throw new Error('No broker-bound ticket');}
  })
}));
vi.mock('../src/main/company-observability.js',()=>({
  createCompanyObserver:()=>({snapshot:async()=>({at:Date.now(),demo:false,seats:[],events:[],attention:0,statusCounts:{}})})
}));

const frame={};
const contents={isDestroyed:()=>false,mainFrame:frame};
const window={isDestroyed:()=>false,webContents:contents};
const event={sender:contents,senderFrame:frame};
let home='';
const invoke=async(payload:unknown,eventOverride:unknown=event)=>{
  if(!native.handler)throw new Error('Unregistered company handler');
  return native.handler(eventOverride,payload);
};
beforeAll(()=>registerCompanyIpc(()=>window as never));
beforeEach(async()=>{
  home=await mkdtemp(path.join(os.tmpdir(),'company-live-ipc-'));
  initCompanyStore(home);
  initCompanyLocalGrants(home);
  contents.mainFrame=frame;
  native.response=0;native.prompts=[];native.dispatches=0;
});
afterEach(async()=>{resetCompanyStoreForTests();resetCompanyLocalGrantsForTests();await rm(home,{recursive:true,force:true});});

it('asks explicit native consent for durable grants but denies unproven broker chair even after approval', async () => {
  const request = { action: 'localGrantRequest', payload: { mode: 'agent', scope: 'company-local-read',
    subject: { kind: 'worker', ownerId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222', workerId: 'worker-1', conversationId: 'synthetic-chat' },
    requestId: '33333333-3333-4333-8333-333333333333' } };
  expect((await invoke(request)).ok).toBe(false);
  native.response = 1;
  const refused = await invoke(request);
  expect(refused.ok).toBe(false);
  expect(refused.error).toMatch(/attested/);
  expect(native.prompts).toContain('Autorizar sempre ESTE agente para escopo específico');
  expect((await readLocalCompanyGrants()).grants).toEqual([]);
  expect((await invoke({ action: 'localGrants' })).ok).toBe(true);
  expect((await invoke({ action: 'localGrantRevoke', payload: { id: request.payload.requestId } })).data).toBe(false);
});

describe('Company activation through the actual main IPC boundary with synthetic broker',()=>{
  it('requires main frame and native CEO confirmation before creating any backup or live state',async()=>{
    await mutateCompany('demo',undefined);
    expect((await invoke({action:'activateReal',consent:true},{sender:{},senderFrame:frame})).ok).toBe(false);
    expect((await invoke({action:'activateReal'})).ok).toBe(false);
    expect((await invoke({action:'activateReal',consent:true})).ok).toBe(false);
    expect((await getCompany()).demo).toBe(true);
    expect(await readdir(path.join(home,'company'))).toEqual(['company.json']);
    native.response=1;
    const stale=invoke({action:'activateReal',consent:true});
    contents.mainFrame={};
    expect((await stale).ok).toBe(false);
    expect((await getCompany()).demo).toBe(true);
    contents.mainFrame=frame;
    const result=await invoke({action:'activateReal',consent:true});
    expect(result.ok).toBe(true);
    expect((await getCompany())).toMatchObject({demo:false,requests:[],meetings:[]});
    expect(native.prompts).toEqual(expect.arrayContaining([expect.stringContaining('EMPTY real company')]));
  });
  it('can restore an untouched demo with fresh native consent; refuses after real work or broker denial',async()=>{
    await mutateCompany('demo',undefined);
    native.response=1;
    await invoke({action:'activateReal',consent:true});
    native.response=0;
    expect((await invoke({action:'restoreDemo',consent:true})).ok).toBe(false);
    expect((await getCompany()).demo).toBe(false);
    native.response=1;
    expect((await invoke({action:'restoreDemo',consent:true})).ok).toBe(true);
    expect((await getCompany()).demo).toBe(true);
    await invoke({action:'activateReal',consent:true});
    const created=await mutateCompany('create',{title:'Real candidate',project:'Fixture',owner:'marks-coo',
      origin:'ceo',acceptance:'Review task',engine:'chatgpt',model:'test',tokenBudget:100,timeBudgetMinutes:5,dueAt:null});
    const id=created.requests[0]!.id;
    const assigned=await invoke({action:'prepare',payload:{id,seat:'marks2'}});
    expect(assigned.ok).toBe(true);
    expect((await getCompany()).requests[0]).toMatchObject({status:'assigned',seat:'marks2'});
    const denied=await invoke({action:'dispatch',payload:{id,consent:true}});
    expect(denied).toMatchObject({ok:false,error:'Broker denied synthetic owner grant'});
    expect(native.dispatches).toBe(1);
    expect((await getCompany()).requests[0]).toMatchObject({status:'assigned'});
    expect((await getCompany()).requests[0]?.execution).toBeUndefined();
    expect((await invoke({action:'restoreDemo',consent:true})).ok).toBe(false);
  });
});
