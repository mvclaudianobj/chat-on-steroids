/**
 * Renderer access to the Claude Code Router module (Settings > Modules > Claude Code Router):
 * status, install/update of the version the user confirmed, Start/Stop/Restart and Open router UI.
 * Sender and frame are checked; no key, token, configuration value or web UI address crosses.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { markspanelAccessBlocked } from '../markspanel-auth.js';
import { CCR_VERSION, type CcrInstallProgress } from '../../shared/ccr-module.js';
import { bindCcrRouting, ccrInstall, ccrOpenUi, ccrService, ccrStatus } from './service.js';

const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), refresh: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('install'), mode: z.enum(['install', 'update', 'update-external']), version: z.string().regex(CCR_VERSION) }).strict(),
  z.object({ action: z.literal('service'), op: z.enum(['start', 'stop', 'restart']) }).strict(),
  z.object({ action: z.literal('openUi') }).strict()
]);

export function registerCcrIpc(getWindow: () => BrowserWindow | null): void {
  bindCcrRouting();
  const progress = (next: CcrInstallProgress): void => {
    const target = getWindow();
    if (target && !target.isDestroyed()) target.webContents.send('marksCcr:progress', next);
  };
  ipcMain.handle('marksCcr:request', async (event, payload: unknown) => {
    try {
      if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('Window not authorized');
      const input = request.parse(payload);
      switch (input.action) {
        case 'status': return { ok: true, data: await ccrStatus(input.refresh) };
        case 'install': return { ok: true, data: await ccrInstall(input.mode, input.version, progress) };
        case 'service': return { ok: true, data: await ccrService(input.op) };
        case 'openUi': await ccrOpenUi(); return { ok: true, data: await ccrStatus() };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
