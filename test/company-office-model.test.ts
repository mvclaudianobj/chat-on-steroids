import {expect,it} from 'vitest';
import {companyOfficeEmployees} from '../src/renderer/company-office-model.js';
import {emptyCompany} from '../src/shared/company.js';
import type {CompanyObservabilityView} from '../src/main/company-observability.js';
const id='00000000-0000-4000-8000-000000000111';
const run='00000000-0000-4000-8000-000000000222';
function fixture(){
 const company=emptyCompany();const now=Date.now();
 company.requests.push({id,title:'Implement feature',project:'Office',origin:'ceo',owner:'marks-cto',seat:'marks1',
 engine:'chatgpt',model:'fixture',acceptance:'Done',tokenBudget:1000,timeBudgetMinutes:30,tokensUsed:0,
 minutesUsed:0,dueAt:null,status:'working',raci:{responsible:'marks1',accountable:'ceo',consulted:[],informed:[]},
 execution:{mode:'live',phase:'running',ownerId:id,workerId:'worker-1',runId:run,conversationId:'worker-chat',
 reportId:null,result:null,evidence:null,authorizedAt:now},history:[{at:now,actor:'ceo',note:'Start'}],createdAt:now,updatedAt:now});
 const observed:CompanyObservabilityView={at:now,demo:false,attention:0,statusCounts:{working:1},events:[],seats:[{
 seat:'marks1',state:'working',source:'broker',statusSince:now,observedAt:now,provenance:'bound-owner-run-worker',
 ticketId:id,ownerId:id,runId:run,workerId:'worker-1',sessionId:'00000000-0000-4000-8000-000000000333',tokensUsed:null,
 minutesUsed:null,error:false}]};
 return {company,observed,now};
}
it('uses the verified broker session for opening an employee and does not reuse a stale binding',()=>{
 const {company,observed,now}=fixture();
 const live=companyOfficeEmployees(company,observed,now)[0]!;
 expect(live).toMatchObject({location:'desk',state:'working',role:'marks-cto',ticket:{title:'Implement feature'},
 sessionId:'00000000-0000-4000-8000-000000000333'});
 observed.seats[0]!.workerId='worker-2';
 expect(companyOfficeEmployees(company,observed,now)[0]?.sessionId).toBeNull();
 expect(companyOfficeEmployees(company,null,now)[0]?.state).toBe('unverified');
});
it('moves confirmed completed workers to rest and represents meeting presence without manufacturing a session',()=>{
 const {company,observed,now}=fixture();
 company.requests[0]!.status='done';company.requests[0]!.execution!.phase='reported';
 Object.assign(company.requests[0]!.execution!,{reportId:'receipt',result:'Complete',evidence:'broker'});
 company.requests[0]!.cooConfirmation={actor:'marks-coo',at:now,reportId:'receipt',workerId:'worker-1',evidence:'Reviewed'};
 observed.seats[0]!.state='available-confirmed';observed.seats[0]!.source='company';
 expect(companyOfficeEmployees(company,observed,now)[0]).toMatchObject({location:'rest',restKind:'rest-confirmed'});
 observed.seats[0]!.state='meeting-present';observed.seats[0]!.source='meeting';
 expect(companyOfficeEmployees(company,observed,now)[0]).toMatchObject({location:'meeting',sessionId:'00000000-0000-4000-8000-000000000333'});
});
it('marks approval pending as attention without claiming a different worker session',()=>{
 const {company,observed,now}=fixture();
 observed.seats[0]!.state='approval-wait';
 expect(companyOfficeEmployees(company,observed,now)[0]).toMatchObject({state:'approval-wait',location:'desk'});
 observed.seats[0]!.source='company';
 expect(companyOfficeEmployees(company,observed,now)[0]?.state).toBe('unverified');
});
