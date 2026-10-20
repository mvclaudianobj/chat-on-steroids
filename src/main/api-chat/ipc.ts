/** Renderer access to Chat Marks API chat settings. The key travels in one direction only. */
import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { markspanelAccessBlocked } from '../markspanel-auth.js';
import { listApiChatModels } from './catalog.js';
import { ApiChatHttpError, streamCompletion } from './client.js';
import {
  apiChatKey, apiChatSettings, apiChatStatus, noteKeyRequired, noteModelAvailability, setApiChatKey,
  toggleFavoriteModel, updateApiChatSettings
} from './settings.js';

const TEST_TIMEOUT_MS = 30_000;
const modelId = z.string().min(1).max(200);

const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('setKey'), key: z.string().max(4096) }).strict(),
  z.object({ action: z.literal('setSettings'), settings: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal('toggleFavorite'), model: modelId }).strict(),
  z.object({
    action: z.literal('models'),
    query: z.string().max(100).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    modality: z.enum(['chat', 'image', 'audio', 'embedding', 'moderation']).optional(),
    refresh: z.boolean().optional()
  }).strict(),
  z.object({ action: z.literal('test'), model: modelId.optional() }).strict()
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

export function registerApiChatIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('marksApiChat:request', async (event, payload: unknown) => {
    try {
      if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('Window not authorized');
      const input = request.parse(payload);
      const data = input.action === 'status' ? await apiChatStatus()
        : input.action === 'setKey' ? (await setApiChatKey(input.key), await apiChatStatus())
          : input.action === 'setSettings' ? (await updateApiChatSettings(input.settings), await apiChatStatus())
            : input.action === 'toggleFavorite' ? (await toggleFavoriteModel(input.model), await apiChatStatus())
              : input.action === 'models' ? await listApiChatModels(input)
                : await testApiChat(input.model);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
