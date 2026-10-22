/** Chat Marks: fixed, validated local Brain IPC on the main window only. */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { dialogLabel, mainText } from '../main-texts.js';
import { BRAIN_PROVIDER_IDS, brainSaveSchema } from '../../shared/brain.js';
import { logInfo, logWarn } from '../logger.js';
import { combinedRecall, deleteRemoteCopy, providerStatuses, syncSavedMemory } from './recall.js';
import { importMarksCodeCredential, storeProviderKey } from './provider-keys.js';
import { brainPendingApprovals, decideBrainSaveApproval, onBrainApprovalsChanged } from './approval.js';
import { brainDelete, brainDoctor, brainGet, brainList, brainSave, brainSearch, brainStatus, brainUpdate } from './store.js';
import { getBrainSettings, setBrainSettings } from './settings.js';
import { BRAIN_IMPORT_ACTIONS } from '../../shared/brain-import.js';
import { isBrainImportAction, runBrainImport } from './import/ipc.js';

const empty = z.object({}).strict();
const query = z.object({ query: z.string().min(1).max(1000), limit: z.number().int().min(1).max(100).optional() }).strict();
const identifier = z.object({ id: z.string().uuid() }).strict();
const save = brainSaveSchema.omit({ provenance: true });
const actionSchema = z.enum(['status','doctor','sources','settings.get','settings.set','recall','memories.list','memories.search','memories.get','memories.save','memories.update','memories.delete','memories.export','pending.list','pending.decide','providers.test','providers.setKey','providers.importMarksCode', ...BRAIN_IMPORT_ACTIONS]);
const providerId = z.enum(BRAIN_PROVIDER_IDS);
/** Chat Marks H1b: whether ChatGPT still has to refresh the Core plugin to see the Brain tools. */
async function chatgptRefreshState(): Promise<string | null> {
  if (!getBrainSettings().chatgptTools) return null;
  try {
    const { pluginRefreshStatuses } = await import('../plugin-refresh.js');
    return (await pluginRefreshStatuses()).core?.state ?? 'unpublished';
  } catch { return 'unknown'; }
}

export function registerBrainIpc(getWindow: () => BrowserWindow | null): void {
  onBrainApprovalsChanged(() => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('marksBrain:approvalsChanged');
  });
  ipcMain.handle('marksBrain:request', async (event, input: unknown) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      return { ok: false, error: 'Unauthorized window' };
    try {
      const request = z.object({ action: actionSchema, payload: z.unknown().optional() }).strict().parse(input);
      const { action, payload } = request;
      // Chat Marks H2: old-history search and confirmed imports (main/brain/import).
      if (isBrainImportAction(action)) return await runBrainImport(action, payload, event => { if (!window.isDestroyed()) window.webContents.send('marksBrain:progress', event); });
      let data: unknown;
      switch (action) {
        case 'status': empty.parse(payload ?? {}); data = { ...await brainStatus(), chatgptRefresh: await chatgptRefreshState() }; break;
        case 'doctor': empty.parse(payload ?? {}); data = { ...await brainDoctor(), providers: await providerStatuses(true), chatgptRefresh: await chatgptRefreshState() }; break;
        case 'sources': empty.parse(payload ?? {}); data = await providerStatuses(false); break;
        case 'providers.test': {
          const { id } = z.object({ id: providerId }).strict().parse(payload);
          data = (await providerStatuses(true)).find(row => row.id === id);
          break;
        }
        case 'providers.setKey': {
          const input = z.object({ id: providerId, value: z.string().trim().min(1).max(16384), password: z.string().min(12).max(1024) }).strict().parse(payload);
          await storeProviderKey(input.id, input.value, input.password);
          data = true;
          break;
        }
        case 'providers.importMarksCode': {
          const input = z.object({ id: z.enum(['aiMemory', 'marksApi']), password: z.string().min(12).max(1024) }).strict().parse(payload);
          data = await importMarksCodeCredential(input.id, input.password);
          break;
        }
        case 'settings.get': empty.parse(payload ?? {}); data = getBrainSettings(); break;
        case 'settings.set': data = await setBrainSettings(payload); break;
        case 'recall': {
          const input = query.parse(payload);
          data = await combinedRecall(input.query, { limit: Math.min(input.limit ?? 8, 12) });
          break;
        }
        case 'memories.search': {
          const input = query.parse(payload);
          data = await brainSearch(input.query, input.limit ?? 6);
          break;
        }
        case 'memories.list': empty.parse(payload ?? {}); data = await brainList(); break;
        case 'memories.get': data = await brainGet(identifier.parse(payload).id); break;
        case 'memories.save': {
          const memory = await brainSave({ ...save.parse(payload), provenance: { source: 'user' } });
          logInfo(`brain: saved memory (source=user, ${memory.content.length} chars)`);
          const synced = await syncSavedMemory(memory);
          data = { ...memory, synced };
          break;
        }
        case 'memories.update': {
          const input = save.partial().extend({ id: z.string().uuid() }).strict().parse(payload);
          const { id, ...changes } = input;
          data = await brainUpdate(id, changes);
          break;
        }
        case 'memories.delete': {
          const id = identifier.parse(payload).id;
          const prior = await brainGet(id);
          data = await brainDelete(id);
          if (data) { logInfo('brain: deleted memory'); await deleteRemoteCopy(prior); }
          break;
        }
        case 'memories.export': {
          empty.parse(payload ?? {});
          const target = await dialog.showSaveDialog(window, { ...dialogLabel('Export Brain memories'), defaultPath: 'chat-marks-brain.jsonl', filters: [{ name: mainText('JSON Lines'), extensions: ['jsonl'] }] });
          if (target.canceled || !target.filePath) { data = false; break; }
          const { writeFile } = await import('node:fs/promises');
          const records = await brainList(10000);
          await writeFile(target.filePath, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
          data = true;
          break;
        }
        case 'pending.list': empty.parse(payload ?? {}); data = brainPendingApprovals(); break;
        case 'pending.decide': {
          const value = z.object({ id: z.string().uuid(), accepted: z.boolean() }).strict().parse(payload);
          data = decideBrainSaveApproval(value.id, value.accepted);
          logInfo(`brain: pending save ${value.accepted ? 'approved' : 'denied'} in the Brain page`);
          break;
        }
      }
      return { ok: true, data };
    } catch (error) {
      // Chat Marks H1b: a short reason, never content or credentials (provider errors are pre-sanitised).
      const reason = error instanceof z.ZodError ? 'invalid input' : (error as Error)?.message?.slice(0, 200) || 'failed';
      logWarn(`brain: request ${String((input as { action?: unknown })?.action ?? '?').slice(0, 40)} failed: ${reason}`);
      return { ok: false, error: reason === 'invalid input' ? 'Brain request failed or input was invalid' : `Brain: ${reason}` };
    }
  });
}
