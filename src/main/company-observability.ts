/** Sanitized, read-only projection of the Company's exact local broker bindings.
 * No session transcripts, instructions, commands, account names or secrets are stored. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getCompany } from './company-store.js';
import { localCompanyWorkerBackend, type CompanyWorkerBackend } from './company-broker.js';
import { companySeatView, type CompanySnapshot } from '../shared/company.js';

export const OP_STATES = ['working','shell-wait','needs-ceo','review','available-confirmed','meeting-present','disconnected','unverified'] as const;
const stateSchema = z.enum(OP_STATES);
const eventSchema = z.object({ id:z.string().uuid(),at:z.number().int().nonnegative(),seat:z.string().regex(/^marks(?:[1-9][0-9]?)$/),ticketId:z.string().uuid().nullable(),kind:stateSchema,source:z.enum(['broker','company','meeting','expired','error']),runId:z.string().uuid().nullable(),workerId:z.string().regex(/^worker-[1-9][0-9]*$/).nullable() }).strict();
const journalSchema=z.object({version:z.literal(1),retentionDays:z.number().int().min(1).max(30),events:z.array(eventSchema).max(2000)}).strict();
export type CompanyObservationEvent=z.infer<typeof eventSchema>;
export type CompanyOperationalState={seat:string;state:typeof OP_STATES[number];statusSince:number;observedAt:number|null;source:CompanyObservationEvent['source'];provenance:string;ticketId:string|null;ownerId:string|null;runId:string|null;workerId:string|null;tokensUsed:number|null;minutesUsed:number|null;error:boolean};
export type CompanyObservabilityView={at:number;demo:boolean;seats:CompanyOperationalState[];events:CompanyObservationEvent[];attention:number;statusCounts:Record<string,number>};
let directoryPath='';let serialize:Promise<void>=Promise.resolve();
const memory=new Map<string,{at:number;state:CompanyOperationalState['state'];source:CompanyObservationEvent['source'];since:number}>();
const TTL=90_000;
export function initializeCompanyObservability(userData:string):void {directoryPath=path.join(userData,'company');memory.clear();serialize=Promise.resolve();}
export function resetCompanyObservabilityForTests():void {directoryPath='';memory.clear();serialize=Promise.resolve();}
function lock<T>(fn:()=>Promise<T>):Promise<T> {const job=serialize.then(fn);serialize=job.then(()=>undefined,()=>undefined);return job;}
async function read():Promise<z.infer<typeof journalSchema>> {
 if(!directoryPath)throw new Error('Observability not initialized');
 const file=path.join(directoryPath,'observations.json');
 try {const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>300_000)throw Error('Invalid journal');return journalSchema.parse(JSON.parse(await fs.readFile(file,'utf8')));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,retentionDays:7,events:[]};throw Error('Observability journal unreadable');}
}
async function persist(journal:z.infer<typeof journalSchema>):Promise<void>{
 await fs.mkdir(directoryPath,{recursive:true,mode:0o700});
 const file=path.join(directoryPath,'observations.json');const tmp=path.join(directoryPath,`.observation-${randomUUID()}.tmp`);
 try{await fs.writeFile(tmp,JSON.stringify(journalSchema.parse(journal)),{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}
}
export async function readObservationEvents(now=Date.now()):Promise<CompanyObservationEvent[]> {return lock(async()=>{const journal=await read();return journal.events.filter(event=>event.at>=now-journal.retentionDays*86_400_000);});}
export async function setObservationRetention(days:number):Promise<void>{if(!Number.isInteger(days)||days<1||days>30)throw Error('Invalid retention');await lock(async()=>{const j=await read();j.retentionDays=days;j.events=j.events.filter(e=>e.at>=Date.now()-days*86_400_000);await persist(j);});}
async function record(entries:Omit<CompanyObservationEvent,'id'>[],now:number):Promise<CompanyObservationEvent[]>{return lock(async()=>{
 const journal=await read();journal.events=journal.events.filter(item=>item.at>=now-journal.retentionDays*86_400_000);
 for(const entry of entries){const last=journal.events.findLast(e=>e.seat===entry.seat&&e.ticketId===entry.ticketId);if(last?.kind===entry.kind&&last?.source===entry.source&&last?.runId===entry.runId)continue;journal.events.push(eventSchema.parse({...entry,id:randomUUID()}));}
 journal.events=journal.events.slice(-2000);await persist(journal);return journal.events;
});}

/** A single explicit refresh. A broker error never creates fake idle/completion. */
export function createCompanyObserver(backend:CompanyWorkerBackend=localCompanyWorkerBackend){
 async function snapshot(now=Date.now(),refreshBroker=true,fixture?:CompanySnapshot):Promise<CompanyObservabilityView>{
  const company=fixture??await getCompany();const records:CompanyOperationalState[]=[];
  const previous=await readObservationEvents(now);
  const updates:Omit<CompanyObservationEvent,'id'>[]=[];
  for(const seat of company.company.seats.slice(0,10)){
   const tickets=company.requests.filter(r=>r.seat===seat).sort((a,b)=>b.updatedAt-a.updatedAt);
   const current=tickets.find(r=>r.status!=='done')??tickets[0];const exec=current?.execution;
   let state:CompanyOperationalState['state']='unverified';let source:CompanyObservationEvent['source']='company';let error=false;let observedAt:number|null=null;
   const seatState=companySeatView(company,seat,now);
   if(seatState.state==='meeting-present'){state='meeting-present';source='meeting';}
   else if(seatState.state==='needs-ceo'){state='needs-ceo';}
   else if(seatState.state==='review'){state='review';}
   else if(seatState.state==='rest-confirmed'&&!company.demo){state='available-confirmed';}
   else if(exec?.mode==='live'&&exec.ownerId===current?.id&&exec.runId&&exec.workerId&&!company.demo){
    const key=`${current.id}:${exec.runId}:${exec.workerId}`;const last=memory.get(key);
    if(refreshBroker){try{
      const found=await backend.status(exec.ownerId,exec.runId);
      if(found.runId!==exec.runId)throw Error('run identity');
      const workers=found.workers.filter(w=>w.id===exec.workerId&&w.runId===exec.runId&&w.label===`${seat}:${current.id}`&&
        typeof w.conversationId==='string'&&w.conversationId.length>0&&w.conversationId.length<=160&&
        (!exec.conversationId||w.conversationId===exec.conversationId));
      if(workers.length!==1)throw Error('identity');const worker=workers[0]!;
      // Broker does not expose shell state reliably in every version. Unknown never means shell.
      state=worker.state==='active'?'working':'disconnected';source='broker';observedAt=now;
      memory.set(key,{at:now,state,source,since:last?.state===state?last.since:now});
    }catch{error=true;state='disconnected';source='error';}}
    else if(last&&now-last.at<=TTL){state=last.state;source=last.source;observedAt=last.at;}
    else{state='disconnected';source='expired';}
   } else if(seatState.state==='busy'||seatState.state==='unverified'||seatState.state==='meeting-invited'||seatState.state==='meeting-accepted')state='unverified';
   const prior=previous.findLast(e=>e.seat===seat&&e.ticketId===(current?.id??null));
   const statusSince=prior?.kind===state?prior.at:now;
   records.push({seat,state,statusSince,observedAt,source,provenance:exec?.runId?'bound-owner-run-worker':'company-state',ticketId:current?.id??null,ownerId:exec?.ownerId??null,runId:exec?.runId??null,workerId:exec?.workerId??null,tokensUsed:current?.execution?.mode==='live'&&current.tokensUsed>0?current.tokensUsed:null,minutesUsed:current?.execution?.mode==='live'&&current.minutesUsed>0?current.minutesUsed:null,error});
   if(!company.demo)updates.push({at:now,seat,ticketId:current?.id??null,kind:state,source,runId:exec?.runId??null,workerId:exec?.workerId??null});
  }
  const events=company.demo?[]:await record(updates,now);
  const statusCounts:Record<string,number>={};for(const record of records)statusCounts[record.state]=(statusCounts[record.state]??0)+1;
  return {at:now,demo:company.demo,seats:records,events:events.slice(-100).reverse(),attention:records.filter(r=>r.state==='needs-ceo').length,statusCounts};
 }
 return {snapshot};
}
