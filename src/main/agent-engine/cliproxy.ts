/**
 * The `cliproxy` engine: the existing API chat executor and catalog behind the engine contract,
 * with no behavior of its own. Every chat created before engines existed runs here.
 */
import { AGENT_ENGINE_LABELS } from '../../shared/agent-engine.js';
import { listApiChatModels } from '../api-chat/catalog.js';
import { apiChatView, approveApiChat, createApiChat, recoverApiChats, sendApiChat, setApiChatSettings, stopApiChat } from '../api-chat/executor.js';
import { apiChatSettings } from '../api-chat/settings.js';
import type { AgentEngine } from './types.js';

export const cliProxyEngine: AgentEngine = {
  id: 'cliproxy',
  label: AGENT_ENGINE_LABELS.cliproxy,
  terminalMode: null,
  async status() {
    // As before engines: offered once its settings answer with an endpoint. Model and key
    // are checked when a chat is created, where the renderer can send the user to Settings.
    const { endpoint } = await apiChatSettings();
    return endpoint ? { available: true, detail: endpoint } : { available: false, detail: 'No CLIProxy endpoint is set' };
  },
  models: query => listApiChatModels(query),
  create: options => createApiChat({ projectId: options.projectId, ...(options.model ? { model: options.model } : {}) }),
  view: sessionId => apiChatView(sessionId),
  send: async (sessionId, text) => ({ turnId: (await sendApiChat(sessionId, text)).turnId }),
  // The view refuses a session that is not one of this engine's chats.
  stop: async sessionId => { await apiChatView(sessionId); return stopApiChat(sessionId); },
  approve: (sessionId, approvalId, decision) => approveApiChat(sessionId, approvalId, decision),
  setChatSettings: (sessionId, patch) => setApiChatSettings(sessionId, patch),
  recover: () => recoverApiChats(),
  terminal: () => null
};
