/** Main-owned Company identity proof for the local grant ledger.
 * Never trust the renderer's claim of a seat, worker id or conversation by itself.
 * This grants only Company-internal scopes; host, OS and tool policies remain separate. */
import { getCompany } from './company-store.js';
import { agentInfoForOwnedConversation } from './agents.js';
import type { CompanyLocalAttestation, CompanyLocalSubject } from './company-local-grants.js';

export async function attestCompanyLocalSubject(subject: CompanyLocalSubject): Promise<CompanyLocalAttestation | null> {
  const company = await getCompany().catch(() => null);
  if (!company || company.demo) return null;
  if (subject.kind === 'coo') {
    // A named office is not an authenticated actor. Until the broker provides a
    // binding for marks-coo, role-wide grants must remain fail-closed.
    return null;
  }
  const matches = company.requests.filter(row => {
    const execution = row.execution;
    return row.seat && ['working', 'assigned', 'review'].includes(row.status) &&
      execution?.mode === 'live' && ['admitted', 'running'].includes(execution.phase) &&
      execution.ownerId === subject.ownerId && row.id === subject.ownerId &&
      execution.runId === subject.runId && execution.workerId === subject.workerId &&
      execution.conversationId === subject.conversationId;
  });
  if (matches.length !== 1) return null;
  const worker = agentInfoForOwnedConversation(subject.conversationId);
  if (!worker || worker.role !== 'worker' || worker.id !== subject.workerId ||
      worker.runId !== subject.runId || worker.conversationId !== subject.conversationId ||
      !['active', 'waking', 'detached', 'sleeping'].includes(worker.state) ||
      worker.label !== `${matches[0]!.seat}:${matches[0]!.id}`) return null;
  return { local: true, verified: true, subject: { ...subject } };
}
