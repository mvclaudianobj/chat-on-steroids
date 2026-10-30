/** One conservative board/office/RPG projection. Tickets own assignments;
 * broker observations alone attest current worker activity. */
import { COMPANY_ROLES, companySeatView, type CompanyRequest, type CompanySnapshot } from '../shared/company.js';
import type { CompanyObservabilityView } from '../main/company-observability.js';
import { companyLiveSeatState, type CompanyVisibleSeatState } from './company-live-presentation.js';

export interface OfficeEmployee {
  seat: string;
  role: typeof COMPANY_ROLES[number];
  ticket: CompanyRequest | null;
  state: CompanyVisibleSeatState;
  source: string;
  location: 'desk' | 'rest' | 'meeting';
  restKind: 'rest-free' | 'rest-confirmed' | null;
  sessionId: string | null;
}
const rank:Record<CompanyRequest['status'],number>={working:5,'needs-ceo':4,review:3,assigned:2,inbox:1,done:0};

export function companyOfficeEmployees(snapshot:CompanySnapshot, observations:CompanyObservabilityView|null, now=Date.now()):OfficeEmployee[] {
  const seats=snapshot.company.seats;
  return seats.map((seat,index)=>{
    const requests=snapshot.requests.filter(row=>row.seat===seat).sort((a,b)=>rank[b.status]-rank[a.status]||b.updatedAt-a.updatedAt);
    const ticket=requests[0]??null;
    const live=companyLiveSeatState(observations,seat,snapshot.demo,now);
    const rest=companySeatView(snapshot,seat,now);
    const state=live.state;
    const location=state==='meeting-present'?'meeting':
      state==='working'||state==='approval-wait'||state==='shell-wait'||state==='needs-ceo'||state==='review'?'desk':
      (rest.state==='rest-free'||rest.state==='rest-confirmed')?'rest':'desk';
    const observed=observations?.seats.find(item=>item.seat===seat);
    const bound=!!ticket?.execution && !snapshot.demo && live.state!=='unverified' && observed?.ticketId===ticket.id &&
      observed.ownerId===ticket.id && observed.runId===ticket.execution.runId && observed.workerId===ticket.execution.workerId &&
      !!observed.sessionId && !observed.error;
    return {seat,role:ticket?.owner??COMPANY_ROLES[index%COMPANY_ROLES.length]!,ticket,
      state,source:live.source,location,restKind:location==='rest'?(rest.state==='rest-confirmed'?'rest-confirmed':'rest-free'):null,
      sessionId:bound?observed!.sessionId??null:null};
  });
}
