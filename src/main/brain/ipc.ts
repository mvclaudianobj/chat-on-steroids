/** Chat Marks: fixed, validated local Brain IPC on the main window only. */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { dialogLabel, mainText } from '../main-texts.js';
import { brainSaveSchema } from '../../shared/brain.js';
import { brainPendingApprovals, decideBrainSaveApproval, onBrainApprovalsChanged } from './approval.js';
import { brainDelete, brainDoctor, brainGet, brainList, brainSave, brainSearch, brainStatus, brainUpdate } from './store.js';
import { getBrainSettings, setBrainSettings } from './settings.js';
import { BRAIN_IMPORT_ACTIONS } from '../../shared/brain-import.js';
import { isBrainImportAction, runBrainImport } from './import/ipc.js';

const empty = z.object({}).strict();
const query = z.object({ query: z.string().min(1).max(1000), limit: z.number().int().min(1).max(100).optional() }).strict();
const identifier = z.object({ id: z.string().uuid() }).strict();
const save = brainSaveSchema.omit({ provenance: true });
const actionSchema = z.enum(['status','doctor','sources','settings.get','settings.set','recall','memories.list','memories.search','memories.get','memories.save','memories.update','memories.delete','memories.export','pending.list','pending.decide', ...BRAIN_IMPORT_ACTIONS]);

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
        case 'status': empty.parse(payload ?? {}); data = await brainStatus(); break;
        case 'doctor': empty.parse(payload ?? {}); data = await brainDoctor(); break;
        case 'sources': empty.parse(payload ?? {}); data = [{ id: 'local', enabled: true, type: 'sqlite' }]; break;
        case 'settings.get': empty.parse(payload ?? {}); data = getBrainSettings(); break;
        case 'settings.set': data = await setBrainSettings(payload); break;
        case 'recall': case 'memories.search': {
          const input = query.parse(payload);
          data = await brainSearch(input.query, input.limit ?? 6);
          break;
        }
        case 'memories.list': empty.parse(payload ?? {}); data = await brainList(); break;
        case 'memories.get': data = await brainGet(identifier.parse(payload).id); break;
        case 'memories.save': data = await brainSave({ ...save.parse(payload), provenance: { source: 'user' } }); break;
        case 'memories.update': {
          const input = save.partial().extend({ id: z.string().uuid() }).strict().parse(payload);
          const { id, ...changes } = input;
          data = await brainUpdate(id, changes);
          break;
        }
        case 'memories.delete': data = await brainDelete(identifier.parse(payload).id); break;
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
          break;
        }
      }
      return { ok: true, data };
    } catch {
      return { ok: false, error: 'Brain request failed or input was invalid' };
    }
  });
}
