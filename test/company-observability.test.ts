import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {initCompanyStore,mutateCompany,resetCompanyStoreForTests,} from '../src/main/company-store.js';
import {createCompanyObserver,initializeCompanyObservability,resetCompanyObservabilityForTests,readObservationEvents,setObservationRetention} from '../src/main/company-observability.js';
import type {CompanyWorkerBackend} from '../src/main/company-broker.js';
import {demoCompany} from '../src/shared/company.js';
let root:string;
const runId='00000000-0000-4000-8000-000000000301';
const create={title:'Synthetic job',project:'Test',origin:'ceo' as const,owner:'marks-cto' as const,acceptance:'Synthetic result',engine:'chatgpt',model:'test',tokenBudget:1000,timeBudgetMinutes:30,dueAt:null};
beforeEach(async()=>{root=await fs.mkdtemp(path.join(tmpdir(),'company-observe-'));initCompanyStore(root);initializeCompanyObservability(root);});
afterEach(async()=>{resetCompanyStoreForTests();resetCompanyObservabilityForTests();await fs.rm(root,{recursive:true,force:true});});
async function bind(){const id=(await mutateCompany('create',create)).requests[0]!.id;await mutateCompany('seat',{id,seat:'marks2'});await mutateCompany('move',{id,status:'assigned'});await mutateCompany('reserve',{id});await mutateCompany('bind',{id,workerId:'worker-7',runId});return id;}
const fake=(ownerId:string,wrong=false):CompanyWorkerBackend=>({spawn:async()=>{throw Error('must not spawn');},send:async()=>{throw Error('must not send');},ack:async()=>{throw Error('must not ack');},reports:async()=>{throw Error('must not load transcripts');},status:async()=>({runId,workers:[{id:wrong?'worker-8':'worker-7',runId,label:`marks2:${ownerId}`,state:'active',result:null}]})});
describe('Company O5 read-only observations',()=>{
 it('observes exact bound owner/run/worker without spawning and expires heartbeat',async()=>{const id=await bind();const observer=createCompanyObserver(fake(id));const now=Date.now();const first=await observer.snapshot(now);expect(first.seats.find(s=>s.seat==='marks2')).toMatchObject({state:'working',source:'broker',ticketId:id});expect(first.events.every(e=>!JSON.stringify(e).includes('Synthetic job'))).toBe(true);
 const repeated=await observer.snapshot(now+1000,false);expect(repeated.events.filter(e=>e.seat==='marks2')).toHaveLength(1);
 const expired=await observer.snapshot(now+91_000,false);expect(expired.seats.find(s=>s.seat==='marks2')?.state).toBe('disconnected');expect(expired.events.find(e=>e.seat==='marks2')?.kind).toBe('disconnected');
 });
 it('rejects spoofed worker and old session without claiming idle',async()=>{const id=await bind();const view=await createCompanyObserver(fake(id,true)).snapshot();expect(view.seats.find(s=>s.seat==='marks2')).toMatchObject({state:'disconnected',error:true});});
 it('replays persisted sanitized event history after observer reload and enforces retention',async()=>{const id=await bind();const now=Date.now();await createCompanyObserver(fake(id)).snapshot(now);expect((await readObservationEvents(now)).some(e=>e.seat==='marks2')).toBe(true);resetCompanyObservabilityForTests();initializeCompanyObservability(root);expect((await readObservationEvents(now)).some(e=>e.seat==='marks2')).toBe(true);await setObservationRetention(1);expect(await readObservationEvents(now+2*86_400_000)).toEqual([]);});
 it('never turns demo into broker presence or writes events',async()=>{const backend=fake('00000000-0000-4000-8000-000000000111');const snapshot=demoCompany();const result=await createCompanyObserver(backend).snapshot(Date.now(),true,snapshot);expect(result.demo).toBe(true);expect(result.events).toHaveLength(0);expect(result.seats.some(s=>s.state==='working')).toBe(false);expect(await readObservationEvents()).toHaveLength(0);});
 it('does not assume shell, token costs or account metrics absent from broker',async()=>{const id=await bind();const result=await createCompanyObserver(fake(id)).snapshot();const item=result.seats.find(s=>s.seat==='marks2')!;expect(item.tokensUsed).toBeNull();expect(item.minutesUsed).toBeNull();expect(item.state).not.toBe('shell-wait');});
});
