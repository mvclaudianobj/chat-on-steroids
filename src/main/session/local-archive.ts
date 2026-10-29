/** Local presentation archive. No browser/ChatGPT archive commands or deletion side effects. */
import { agentInfoForOwnedConversation } from '../agents.js';
import { approvalWaitingChats } from '../approval-wait.js';
import { sessionInputActivity, sessionActivityExpiresAt } from '../bridge.js';
import { getCompany } from '../company-store.js';
import { isApiConversationId } from '../../shared/api-chat.js';
import { listInputs } from './input.js';
import { setSessionArchived } from './store.js';
import type { SessionSummary } from '../../shared/session.js';

export async function archiveSessionLocally(id: string, archived: boolean): Promise<SessionSummary> {
  return setSessionArchived(id, archived, async summary => {
    if (!summary.conversationId && summary.origin?.kind !== 'worker') return 'This chat has not opened yet';
    const chatId = summary.conversationId;
    if (summary.activeTurnId || sessionInputActivity(summary).possible ||
        (sessionActivityExpiresAt(summary) ?? 0) > Date.now()) return 'The chat is still active';
    if (chatId && approvalWaitingChats().includes(chatId)) return 'A tool approval is waiting';
    if (chatId) {
      // Only exact main-owned Company conversation bindings are authority here. A role
      // inferred from a session title or worker label could wrongly hide COO/integrator work.
      const company = await getCompany();
      if (!company.demo && (company.delegation.binding?.conversationId === chatId ||
          company.requests.some(request => request.execution?.mode === 'live' &&
            request.execution.conversationId === chatId &&
            (request.status !== 'done' || !['reported', 'failed'].includes(request.execution.phase))))) {
        return 'Company owner or integration still owns this conversation';
      }
    }
    // A queued message, offered browser send or unconfirmed receipt must keep its visible row.
    const inputs = await listInputs();
    if (inputs.some(row => (row.sessionId === id || row.deliveredSessionId === id ||
      (!!chatId && row.conversationId === chatId)) &&
      (!['sent', 'cancelled', 'failed'].includes(row.state) ||
        (row.state === 'sent' && row.deliveredAt === undefined) ||
        (row.state === 'cancelled' && row.sendAuthorizedAt && !row.deliveredAt)))) {
      return 'The chat has pending messages or acknowledgements';
    }
    if (chatId && !isApiConversationId(chatId)) {
      const agent = agentInfoForOwnedConversation(chatId);
      // Company prime/COO/integrator owners never become anonymous ordinary archived chats.
      if (agent?.role === 'prime') return 'An owner chat cannot be archived';
      if (summary.origin?.kind === 'worker') {
        // Browser-settled worker answers can finish in the broker without an MCP
        // `agents finish` call. The broker's current result is the completion proof:
        // ambiguous silence leaves result null, and revival clears it before waking.
        if (!agent || agent.role !== 'worker' ||
            !['sleeping', 'finished'].includes(agent.state) ||
            agent.result === null || agent.silenceParked === true ||
            agent.pending > 0 || agent.awaitingAck > 0) {
          return 'This worker has no verified completed, idle assignment';
        }
      }
    } else if (summary.origin?.kind === 'worker') {
      return 'Worker ownership cannot be verified';
    }
    if (summary.activeTurnId || sessionInputActivity(summary).possible ||
        (sessionActivityExpiresAt(summary) ?? 0) > Date.now() ||
        (chatId && approvalWaitingChats().includes(chatId))) return 'The chat became active';
    return null;
  });
}
