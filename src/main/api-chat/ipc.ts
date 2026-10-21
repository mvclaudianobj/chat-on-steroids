/**
 * Renderer access to Chat Marks API chats and their settings. The key travels in one direction
 * only. Chat actions go through the agent-engine registry: a new chat names its engine
 * (default `cliproxy`), every other chat action is routed by the chat's ledger record.
 */
import { app, ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { markspanelAccessBlocked } from '../markspanel-auth.js';
import { logWarn } from '../logger.js';
import { API_CHAT_APPROVAL_MODES, API_CHAT_EFFORTS } from '../../shared/api-chat.js';
import { AGENT_ENGINE_IDS, DEFAULT_AGENT_ENGINE } from '../../shared/agent-engine.js';
import { agentEngine, createAgentChat, engineForChat, listAgentEngines, recoverAgentEngines } from '../agent-engine/registry.js';
import { storedChatRecord } from '../agent-engine/ledger.js';
import { shutdownMarksCodeEngine, startMarksCodeService } from '../agent-engine/markscode.js';
import { getSession } from '../session/store.js';
import { localProjectPath, projectWorkspace } from '../projects.js';
import { ApiChatHttpError, streamCompletion } from './client.js';
import { MAX_API_CHAT_INPUT_CHARS } from './executor.js';
import {
  apiChatKey, apiChatSettings, apiChatStatus, noteKeyRequired, noteModelAvailability, setApiChatKey,
  toggleFavoriteModel, updateApiChatSettings
} from './settings.js';

const TEST_TIMEOUT_MS = 30_000;
const modelId = z.string().min(1).max(200);
const sessionId = z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i);
const engine = z.enum(AGENT_ENGINE_IDS);

const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('engines') }).strict(),
  z.object({ action: z.literal('setKey'), key: z.string().max(4096) }).strict(),
  z.object({ action: z.literal('setSettings'), settings: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal('toggleFavorite'), model: modelId }).strict(),
  z.object({
    action: z.literal('models'),
    query: z.string().max(100).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    modality: z.enum(['chat', 'image', 'audio', 'embedding', 'moderation']).optional(),
    refresh: z.boolean().optional(),
    engine: engine.optional()
  }).strict(),
  z.object({ action: z.literal('test'), model: modelId.optional() }).strict(),
  z.object({ action: z.literal('createChat'), projectId: z.string().uuid().nullable().optional(), model: modelId.optional(), engine: engine.optional() }).strict(),
  z.object({ action: z.literal('send'), sessionId, text: z.string().min(1).max(MAX_API_CHAT_INPUT_CHARS) }).strict(),
  z.object({ action: z.literal('stop'), sessionId }).strict(),
  // The chat's backend session in its module's durable terminal (MarksCode `-s <session>`).
  z.object({ action: z.literal('terminal'), sessionId }).strict(),
  // An explicit user action: start the engine's background service (`markscode service start`).
  z.object({ action: z.literal('startEngineService'), engine: z.literal('markscode') }).strict(),
  z.object({ action: z.literal('chatSettings'), sessionId }).strict(),
  z.object({
    action: z.literal('setChatSettings'), sessionId, model: modelId.optional(), effort: z.enum(API_CHAT_EFFORTS).nullable().optional(),
    approval: z.enum(API_CHAT_APPROVAL_MODES).optional()
  }).strict(),
  // Chat Marks D4: only this authenticated window answers an approval, never a notification.
  z.object({ action: z.literal('approve'), sessionId, approvalId: z.string().uuid(), decision: z.enum(['approve', 'deny', 'always']) }).strict()
]);

/**
 * Proves the endpoint, key and a model with the smallest real chat request, and records the
 * outcome as that model's availability. The model list alone proves nothing about either the
 * key or the model: CLIProxyAPI lists its models without a key.
 */
export async function testApiChat(model?: string, fetchImpl?: typeof fetch): Promise<{ model: string }> {
  const settings = await apiChatSettings();
  const target = model ?? settings.model;
  if (!target) throw new Error('Choose a default model first');
  const key = await apiChatKey();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);
  try {
    await streamCompletion({
      baseUrl: settings.endpoint,
      key,
      request: { model: target, messages: [{ role: 'user', content: 'Reply with OK.' }] },
      signal: abort.signal,
      fetchImpl
    });
    await noteModelAvailability(settings.endpoint, target, { ok: true });
    return { model: target };
  } catch (error) {
    const message = abort.signal.aborted ? 'The API did not answer in time' : error instanceof Error ? error.message : String(error);
    if (!key && error instanceof ApiChatHttpError && error.status === 401) noteKeyRequired(settings.endpoint);
    await noteModelAvailability(settings.endpoint, target, { ok: false, error: message });
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}

export async function chatAction(input: z.infer<typeof request>): Promise<unknown> {
  switch (input.action) {
    case 'engines': return listAgentEngines();
    case 'models': {
      const { action: _action, engine: id, ...query } = input;
      void _action;
      return agentEngine(id ?? DEFAULT_AGENT_ENGINE).models(query);
    }
    case 'createChat': return createAgentChat(input.engine ?? DEFAULT_AGENT_ENGINE, { projectId: input.projectId ?? null, ...(input.model ? { model: input.model } : {}) });
    // The turn streams on in main; the renderer follows it through session change notices.
    case 'send': return { turnId: (await (await engineForChat(input.sessionId)).send(input.sessionId, input.text)).turnId };
    case 'stop': return { stopped: await (await engineForChat(input.sessionId)).stop(input.sessionId) };
    case 'chatSettings': return (await engineForChat(input.sessionId)).view(input.sessionId);
    case 'terminal': return engineTerminal(input.sessionId);
    case 'startEngineService': return startMarksCodeService();
    case 'setChatSettings': return (await engineForChat(input.sessionId)).setChatSettings(input.sessionId, {
      ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.approval !== undefined ? { approval: input.approval } : {})
    });
    case 'approve': return (await engineForChat(input.sessionId)).approve(input.sessionId, input.approvalId, input.decision);
    default: throw new Error('Unknown API chat action');
  }
}

/**
 * Opens (or reuses) the durable module terminal that shows this chat's backend session live:
 * the engine names the arguments, cli-modules owns the tmux session in the chat's project.
 */
export async function engineTerminal(sessionId: string): Promise<unknown> {
  const engine = await engineForChat(sessionId);
  const view = await engine.view(sessionId);
  const session = await getSession(sessionId);
  if (!session?.projectId) throw new Error('This chat has no project');
  const folder = await projectWorkspace(session.projectId);
  const cwd = localProjectPath(folder);
  if (!cwd) throw new Error('This chat\'s project is not on this computer');
  const record = await storedChatRecord(sessionId);
  const terminal = engine.terminal?.({ sessionId, conversationId: view.conversationId, backendSessionId: record?.backendSessionId ?? null, cwd }) ?? null;
  if (!terminal || terminal.mode !== 'live' || engine.id !== 'markscode') throw new Error('This chat has no terminal yet');
  const { cliEngineSession } = await import('../cli-modules.js');
  return cliEngineSession('markscode', session.projectId, terminal.argv.slice(1), sessionId, `${engine.label} · ${session.title ?? 'chat'}`.slice(0, 120));
}

/** Validates one renderer request exactly as the IPC handler does. */
export const parseApiChatRequest = (payload: unknown): z.infer<typeof request> => request.parse(payload);

export function registerApiChatIpc(getWindow: () => BrowserWindow | null): void {
  // Turns the previous run left open are closed as interrupted before any new one starts.
  void recoverAgentEngines().catch(error => logWarn(`API chat recovery failed: ${(error as Error).message}`));
  // Quit closes MarksCode event streams without ending their turns: the next start re-attaches.
  app.on('before-quit', shutdownMarksCodeEngine);
  ipcMain.handle('marksApiChat:request', async (event, payload: unknown) => {
    try {
      if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('Window not authorized');
      const input = parseApiChatRequest(payload);
      const data = input.action === 'status' ? await apiChatStatus()
        : input.action === 'setKey' ? (await setApiChatKey(input.key), await apiChatStatus())
          : input.action === 'setSettings' ? (await updateApiChatSettings(input.settings), await apiChatStatus())
            : input.action === 'toggleFavorite' ? (await toggleFavoriteModel(input.model), await apiChatStatus())
              : input.action === 'test' ? await testApiChat(input.model)
                : await chatAction(input);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
