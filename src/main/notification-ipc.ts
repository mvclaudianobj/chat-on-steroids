import { startWhatsAppWeb, disconnectWhatsAppWeb, getWhatsAppWebStatus } from './notification-whatsapp-web.js';
import { startTelegramPairing, checkTelegramPairing, cancelTelegramPairing } from './notification-telegram-pair.js';
import QRCode from 'qrcode';
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { NOTIFICATION_CHANNELS } from '../shared/notification-center.js';
import { importNotificationSettings, notificationSettings, notificationView, saveNotificationSettings, setNotificationCredential, testNotificationChannel } from './notification-center.js';
import { logWarn } from './logger.js';
import { describeFailure, NotificationDeliveryError } from './notification-failure.js';
import { dialogLabel, mainText } from './main-texts.js';

const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  z.object({ action: z.literal('wa-start') }).strict(),
  z.object({ action: z.literal('wa-status') }).strict(),
  z.object({ action: z.literal('wa-disconnect') }).strict(),
  z.object({ action: z.literal('tg-start') }).strict(),
  z.object({ action: z.literal('tg-check') }).strict(),
  z.object({ action: z.literal('tg-cancel') }).strict(),
  z.object({ action: z.literal('save'), settings: z.unknown() }).strict(),
  z.object({ action: z.literal('credential'), channel: z.enum(NOTIFICATION_CHANNELS), credential: z.string().max(4096), masterPassword: z.string().max(1024) }).strict(),
  z.object({ action: z.literal('test'), channel: z.enum(NOTIFICATION_CHANNELS) }).strict(),
  z.object({ action: z.literal('export') }).strict(),
  z.object({ action: z.literal('import') }).strict()
]);
const FORMAT = 'chat-marks-notification-settings';
const VERSION = 1;
const MAX_IMPORT_BYTES = 256 * 1024;
async function exportSettings(window: BrowserWindow): Promise<boolean> {
  const dialogResult = await dialog.showSaveDialog(window, {
    ...dialogLabel('Export notification settings'), defaultPath: 'chat-marks-notifications.json',
    filters: [{ name: mainText('Chat Marks notification settings'), extensions: ['json'] }]
  });
  if (dialogResult.canceled || !dialogResult.filePath) return false;
  // Strict whitelist: exported file never contains credentials, passwords, vault metadata or key handles.
  const body = JSON.stringify({ format: FORMAT, version: VERSION, settings: await notificationSettings() }, null, 2) + '\n';
  if (Buffer.byteLength(body) > MAX_IMPORT_BYTES) throw new Error('Exported settings too large');
  // Atomic replacement avoids leaving a partial file and always enforces private file permissions.
  const target = dialogResult.filePath;
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(body, 'utf8');
    await file.sync();
  } catch (error) {
    await file.close();
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  try { await fs.rename(temporary, target); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return true;
}
async function importSettings(window: BrowserWindow): Promise<{ imported: boolean }> {
  const dialogResult = await dialog.showOpenDialog(window, {
    ...dialogLabel('Import notification settings'), properties: ['openFile'],
    filters: [{ name: mainText('Chat Marks notification settings'), extensions: ['json'] }]
  });
  const selected = dialogResult.filePaths[0];
  if (dialogResult.canceled || !selected) return { imported: false };
  const handle = await fs.open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let raw: string;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_IMPORT_BYTES) throw new Error('Invalid settings file');
    raw = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings format');
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== 'format,settings,version' || value.format !== FORMAT || value.version !== VERSION) throw new Error('Invalid settings format');
  await importNotificationSettings(value.settings);
  return { imported: true };
}
export function registerNotificationCenterIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('marksNotify:request', async (event, payload: unknown) => {
    try {
      const window = getWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.sender.isDestroyed()) throw new Error('Unauthorized notification request');
      const parsed = request.parse(payload);
      let data: unknown;
      switch (parsed.action) {
        case 'get': data = await notificationView(); break;
        case 'wa-start': { const status = await startWhatsAppWeb(); data = { ...status, qr: status.qr ? await QRCode.toDataURL(status.qr) : undefined }; break; }
        case 'wa-status': { const status = await getWhatsAppWebStatus(); data = { ...status, qr: status.qr ? await QRCode.toDataURL(status.qr) : undefined }; break; }
        case 'wa-disconnect': data = await disconnectWhatsAppWeb(); break;
        case 'tg-start': { const result = await startTelegramPairing(); data = { ...result, qr: await QRCode.toDataURL(result.url) }; break; }
        case 'tg-check': data = await checkTelegramPairing(); break;
        case 'tg-cancel': cancelTelegramPairing(); data = true; break;
        case 'save': data = await saveNotificationSettings(parsed.settings); break;
        case 'credential': data = await setNotificationCredential(parsed.channel, parsed.credential, parsed.masterPassword); break;
        case 'test': data = await testNotificationChannel(parsed.channel); break;
        case 'export': data = await exportSettings(window); break;
        case 'import': data = await importSettings(window); break;
      }
      return { ok: true, data };
    } catch (error) {
      // Never echo exception text from transport: fetch errors may carry endpoint/token URLs.
      // A classified delivery failure carries only a code and public context (SMTP/HTTP status,
      // the presented certificate's names and fingerprint), which the renderer translates.
      if (error instanceof z.ZodError) {
        logWarn('Notification IPC: request refused (invalid schema)');
        return { ok: false, error: 'Invalid notification settings' };
      }
      const failure = error instanceof NotificationDeliveryError ? error.failure : null;
      logWarn(`Notification IPC: request refused (${failure ? describeFailure(failure) : 'permission, credential or setting failure'}); secrets and provider text omitted`);
      return { ok: false, error: 'Notification request failed. Check channel configuration and connection.', ...(failure ? { failure } : {}) };
    }
  });
}
