/** Local presentation archive. No browser/ChatGPT archive commands or deletion side effects. */
import { agentInfoForOwnedConversation } from '../agents.js';
import { approvalWaitingChats } from '../approval-wait.js';
import { sessionInputActivity, sessionActivityExpiresAt } from '../bridge.js';
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
        // Sleeping is also reached after ambiguous silence. A current, proven finish is needed.
        if (!agent || agent.role !== 'worker' ||
            !['sleeping', 'finished'].includes(agent.state) ||
            !summary.lastFinishReportAt || !agent.result ||
            summary.lastFinishReportAt < (agent.activatedAt ?? 0) ||
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
