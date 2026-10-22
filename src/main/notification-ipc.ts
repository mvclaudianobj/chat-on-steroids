import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { NOTIFICATION_CHANNELS } from '../shared/notification-center.js';
import { notificationView, saveNotificationSettings, setNotificationCredential, testNotificationChannel } from './notification-center.js';

const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  z.object({ action: z.literal('save'), settings: z.unknown() }).strict(),
  z.object({ action: z.literal('credential'), channel: z.enum(NOTIFICATION_CHANNELS), credential: z.string().max(4096) }).strict(),
  z.object({ action: z.literal('test'), channel: z.enum(NOTIFICATION_CHANNELS) }).strict()
]);
export function registerNotificationCenterIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('marksNotify:request', async (event, payload: unknown) => {
    try {
      if (event.sender !== getWindow()?.webContents || event.sender.isDestroyed()) throw new Error('Unauthorized notification request');
      const parsed = request.parse(payload);
      let data: unknown;
      switch (parsed.action) {
        case 'get': data = await notificationView(); break;
        case 'save': data = await saveNotificationSettings(parsed.settings); break;
        case 'credential': data = await setNotificationCredential(parsed.channel, parsed.credential); break;
        case 'test': data = await testNotificationChannel(parsed.channel); break;
      }
      return { ok: true, data };
    } catch (error) {
      // Never echo exception text from transport: fetch errors may carry endpoint/token URLs.
      return { ok: false, error: error instanceof z.ZodError ? 'Invalid notification settings' : 'Notification request failed. Check channel configuration and connection.' };
    }
  });
}
