/** One explicit CEO request drives one durable Company workflow. All workers use
 * the existing locally owned broker; no separate fleet or synthetic completions. */
import { z } from 'zod';
import { getCompany, mutateCompany } from './company-store.js';
import { localCompanyWorkerBackend, createCompanyBroker, type CompanyWorkerBackend } from './company-broker.js';
import type { CompanyRequest, CompanySnapshot } from '../shared/company.js';

const planSchema = z.object({ tasks: z.array(z.object({ seat: z.string().regex(/^marks[1-9][0-9]?$/),
  title: z.string().trim().min(1).max(160), acceptance: z.string().trim().min(1).max(1200) }).strict()).length(2),
  minutes: z.string().max(5000) }).strict();
function root(snapshot: CompanySnapshot, id: string): CompanyRequest {
  const request = snapshot.requests.find(row=>row.id===id);
  if (!request?.workflow || snapshot.demo) throw Error('Real COO workflow not found');
  return request;
}
function plannerIdentity(request: CompanyRequest, fleet: Awaited<ReturnType<CompanyWorkerBackend['status']>>) {
  const planner=request.workflow!.planner;
  if (!planner?.workerId || !planner.runId || fleet.runId!==planner.runId) throw Error('COO broker run mismatch');
  const found=fleet.workers.filter(row=>row.id===planner.workerId && row.runId===planner.runId &&
    row.label===`marks-coo:${request.id}` && (!planner.conversationId || row.conversationId===planner.conversationId));
  if (found.length!==1) throw Error('COO worker identity changed');
  return found[0]!;
}

export function createCompanyOrchestrator(backend:CompanyWorkerBackend=localCompanyWorkerBackend) {
  const ticketBroker=createCompanyBroker(backend);
  /** Resumes from durable reservations after crashes; never retries an uncertain spawn or send. */
  async function advance(id:string):Promise<CompanySnapshot> {
    let snapshot=await getCompany();let request=root(snapshot,id);let flow=request.workflow!;
    if (flow.phase==='done'||flow.phase==='needs-ceo') return snapshot;
    if (flow.phase==='planning') {
      if (!flow.planner) {
        await backend.status(id); // fail before reserving if broker is disabled
        snapshot=await mutateCompany('autoPlanReserve',{id});request=root(snapshot,id);flow=request.workflow!;
      }
      if (!flow.planner?.runId) {
        // Another call may have been admitted before the previous process crashed.
        const fleet=await backend.status(id);
        const matching=fleet.workers.filter(row=>row.label===`marks-coo:${id}` && row.runId);
        if (matching.length>1) throw Error('Ambiguous COO admission; manual reconciliation required');
        if (matching.length===1) {
          const found=matching[0]!;
          snapshot=await mutateCompany('autoPlanBind',{id,runId:found.runId,workerId:found.id});
        } else {
          // A pending reservation cannot be retried: even a failed spawn may have succeeded.
          throw Error('COO planner reserved; broker admission pending. No duplicate worker spawned.');
        }
        request=root(snapshot,id);flow=request.workflow!;
      }
      const fleet=await backend.status(id,flow.planner!.runId!);
      const worker=plannerIdentity(request,fleet);
      if (!worker.conversationId) return snapshot;
      if (!flow.planner?.conversationId) {
        snapshot=await mutateCompany('autoPlanConversation',{id,conversationId:worker.conversationId});
        request=root(snapshot,id);flow=request.workflow!;
      }
      const reports=await backend.reports(id,flow.planner!.runId!);
      const candidates=reports.filter(row=>row.origin==='authenticated-worker-message' &&
        row.from===flow.planner!.workerId && row.runId===flow.planner!.runId &&
        row.text.startsWith(`COMPANY_PLAN:${id}:`));
      if (!candidates.length) return snapshot;
      if (candidates.length!==1) throw Error('Ambiguous COO planning receipts');
      const receipt=candidates[0]!;
      const parsed=planSchema.parse(JSON.parse(receipt.text.slice(`COMPANY_PLAN:${id}:`.length)));
      const fresh=plannerIdentity(request,await backend.status(id,flow.planner!.runId!));
      if (fresh.conversationId!==worker.conversationId) throw Error('COO conversation switched during plan');
      snapshot=await mutateCompany('autoPlanReceive',{id,plan:parsed.tasks,minutes:parsed.minutes,reportId:receipt.id});
      await backend.ack(id,flow.planner!.runId!,receipt.id);
      request=root(snapshot,id);flow=request.workflow!;
    }
    if (flow.phase==='running'||flow.phase==='reviewing') {
      for (const childId of flow.children) {
        snapshot=await getCompany();request=root(snapshot,id);flow=request.workflow!;
        const child=snapshot.requests.find(row=>row.id===childId && row.parentId===id);
        if (!child) throw Error('COO child missing');
        if (!child.execution) {
          // Each child reserves before admission. A failed/ambiguous spawn is never repeated.
          await ticketBroker.dispatch(childId);
        } else if (child.execution.phase==='admitted'||child.execution.phase==='running'||child.execution.phase==='awaiting-authorization') {
          await ticketBroker.refresh(childId);
        }
        snapshot=await getCompany();request=root(snapshot,id);flow=request.workflow!;
        const current=snapshot.requests.find(row=>row.id===childId)!;
        if (current.status==='needs-ceo') return mutateCompany('autoNeedsCeo',{id,reason:`Worker ${current.seat} needs review`});
        if (current.status!=='review') continue;
        const handoff=flow.handoffs.find(item=>item.childId===childId);
        if (!handoff) {
          snapshot=await mutateCompany('autoHandoffReserve',{id,childId});
          // A reserved handoff requires broker receipt reconciliation after interruptions.
          const sent=await backend.send(id,request.workflow!.planner!.runId!,request.workflow!.planner!.workerId!,
            `Review Company child ${childId} from ${current.seat}. Authenticated broker report ${current.execution!.reportId}: ${current.execution!.result}. `+
            `Send COMPANY_REVIEW:${childId}:approved after checking acceptance: ${current.acceptance}. `+
            `If incomplete send COMPANY_REVIEW:${childId}:rejected.`);
          await mutateCompany('autoHandoffSent',{id,childId,queuedId:sent});
        }
      }
      snapshot=await getCompany();request=root(snapshot,id);flow=request.workflow!;
      if (flow.handoffs.some(row=>row.state==='sent')) {
        const planner=flow.planner!;
        const worker=plannerIdentity(request,await backend.status(id,planner.runId!));
        if (worker.state!=='active'||!worker.conversationId||worker.conversationId!==planner.conversationId) return snapshot;
        const reports=await backend.reports(id,planner.runId!);
        for (const handoff of flow.handoffs.filter(item=>item.state==='sent')) {
          const receipts=reports.filter(row=>row.origin==='authenticated-worker-message'&&row.from===planner.workerId&&
            row.runId===planner.runId&&row.text===`COMPANY_REVIEW:${handoff.childId}:approved`);
          const rejected=reports.find(row=>row.origin==='authenticated-worker-message'&&row.from===planner.workerId&&
            row.runId===planner.runId&&row.text===`COMPANY_REVIEW:${handoff.childId}:rejected`);
          if (rejected) return mutateCompany('autoNeedsCeo',{id,reason:`COO rejected child ${handoff.childId}`});
          if (receipts.length!==1) continue;
          const latest=root(await getCompany(),id);
          const verified=plannerIdentity(latest,await backend.status(id,planner.runId!));
          if (verified.conversationId!==worker.conversationId || verified.state!=='active') throw Error('COO review identity changed');
          await mutateCompany('autoReview',{id,childId:handoff.childId,receiptId:receipts[0]!.id});
          await backend.ack(id,planner.runId!,receipts[0]!.id);
        }
      }
      snapshot=await getCompany();request=root(snapshot,id);flow=request.workflow!;
      if (flow.children.length===2 && flow.handoffs.length===2 && flow.handoffs.every(row=>row.state==='approved'))
        snapshot=await mutateCompany('autoFinish',{id});
    }
    return snapshot;
  }
  async function start(id:string):Promise<CompanySnapshot>{
    const snapshot=await getCompany();const request=root(snapshot,id);
    if (request.workflow!.planner) return advance(id);
    await backend.status(id);
    await mutateCompany('autoPlanReserve',{id});
    const task=`You are marks-coo, the planning and review worker for Company request ${id}. `+
      `Split this request into EXACTLY two independent workers from configured seats: ${(await getCompany()).company.seats.join(', ')}. `+
      `Title: ${request.title}. Acceptance: ${request.acceptance}. Project: ${request.project}. `+
      `Send your prime a single authenticated message in this precise format: COMPANY_PLAN:${id}:`+
      `{"tasks":[{"seat":"marks1","title":"specific task","acceptance":"specific evidence"},`+
      `{"seat":"marks2","title":"specific task","acceptance":"specific evidence"}],"minutes":"meeting minutes"}. `+
      `Later inspect each verified employee report, return COMPANY_REVIEW:<childId>:approved or :rejected. `+
      `Stay available for review messages.`;
    const created=await backend.spawn(id,`marks-coo:${id}`,task);
    await mutateCompany('autoPlanBind',{id,runId:created.runId,workerId:created.workerId});
    return getCompany();
  }
  return {start,advance};
}
