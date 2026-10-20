/** Renderer access to Chat Marks API chat settings. The key travels in one direction only. */
import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { markspanelAccessBlocked } from '../markspanel-auth.js';
import { listApiChatModels } from './catalog.js';
import { streamCompletion } from './client.js';
import { apiChatKey, apiChatSettings, apiChatStatus, setApiChatKey, updateApiChatSettings } from './settings.js';

const TEST_TIMEOUT_MS = 30_000;

const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('setKey'), key: z.string().max(4096) }).strict(),
  z.object({ action: z.literal('setSettings'), settings: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal('models'), query: z.string().max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  z.object({ action: z.literal('test') }).strict()
]);

/**
 * Proves the endpoint, key and default model with the smallest real chat request. The model
 * list alone proves nothing about the key: CLIProxyAPI lists its models without one.
 */
export async function testApiChat(fetchImpl?: typeof fetch): Promise<{ model: string }> {
  const settings = await apiChatSettings();
  if (!settings.model) throw new Error('Choose a default model first');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);
  try {
    await streamCompletion({
      baseUrl: settings.endpoint,
      key: await apiChatKey(),
      request: { model: settings.model, messages: [{ role: 'user', content: 'Reply with OK.' }] },
      signal: abort.signal,
      fetchImpl
    });
    return { model: settings.model };
  } catch (error) {
    if (abort.signal.aborted) throw new Error('The API did not answer in time');
    throw error;
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
            : input.action === 'models' ? await listApiChatModels(input)
              : await testApiChat();
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
