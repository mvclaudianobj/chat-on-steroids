/** Local WhatsApp Web connection; no bridge server or renderer access to the session keys. */
import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';

export interface WhatsAppWebStatus { state: 'disconnected' | 'connecting' | 'qr' | 'connected' | 'error'; qr?: string }
let socket: WASocket | null = null;
let status: WhatsAppWebStatus = { state: 'disconnected' };
let generation = 0;
let restart: ReturnType<typeof setTimeout> | null = null;
let wantConnection = false;
let connecting: Promise<void> | null = null;
let saving: Promise<void> = Promise.resolve();
function directory(): string { return path.join(app.getPath('userData'), 'notifications', 'whatsapp-web'); }
export async function getWhatsAppWebStatus(): Promise<WhatsAppWebStatus> { return { ...status }; }
function closeSocket(): void {
  if (restart) { clearTimeout(restart); restart = null; }
  if (socket) { socket.ev.removeAllListeners('connection.update'); socket.ev.removeAllListeners('creds.update'); socket.ws.close(); socket = null; }
}
async function connect(): Promise<void> {
  const epoch = ++generation;
  closeSocket();
  status = { state: 'connecting' };
  const dir = directory();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  if (epoch !== generation || !wantConnection) return;
  const active = makeWASocket({ auth: state, printQRInTerminal: false, logger: { level: 'silent', child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} } as never });
  socket = active;
  active.ev.on('creds.update', () => {
    if (epoch !== generation || !wantConnection) return;
    saving = saving.catch(() => undefined).then(async () => {
      if (epoch !== generation || !wantConnection) return;
      await saveCreds();
      for (const file of await fs.readdir(dir)) if (file.endsWith('.json')) await fs.chmod(path.join(dir, file), 0o600);
    });
  });
  active.ev.on('connection.update', update => {
    if (epoch !== generation) return;
    if (update.qr) status = { state: 'qr', qr: update.qr };
    if (update.connection === 'open') status = { state: 'connected' };
    if (update.connection === 'close') {
      socket = null;
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { wantConnection = false; status = { state: 'disconnected' }; void fs.rm(dir, { recursive: true, force: true }).catch(() => undefined); return; }
      status = { state: 'connecting' };
      if (wantConnection) {
        restart = setTimeout(() => { restart = null; void connect().catch(() => { status = { state: 'error' }; }); }, 3000);
        restart.unref();
      }
    }
  });
}
export async function startWhatsAppWeb(): Promise<WhatsAppWebStatus> {
  wantConnection = true;
  if (!socket && !restart) {
    connecting ??= connect().finally(() => { connecting = null; });
    await connecting;
  }
  return getWhatsAppWebStatus();
}
export async function disconnectWhatsAppWeb(): Promise<WhatsAppWebStatus> {
  const active = socket;
  wantConnection = false;
  ++generation;
  if (restart) { clearTimeout(restart); restart = null; }
  if (active) await Promise.race([active.logout().catch(() => undefined), new Promise<void>(resolve => setTimeout(resolve, 2500))]);
  closeSocket();
  if (connecting) await connecting.catch(() => undefined);
  await saving.catch(() => undefined);
  await fs.rm(directory(), { recursive: true, force: true });
  status = { state: 'disconnected' };
  return getWhatsAppWebStatus();
}
export async function sendWhatsAppWeb(number: string, message: string): Promise<void> {
  if (!socket || status.state !== 'connected') throw new Error('WhatsApp Web disconnected');
  if (!/^\d{8,15}$/.test(number)) throw new Error('Invalid WhatsApp number');
  await socket.sendMessage(`${number}@s.whatsapp.net`, { text: message });
}
export async function stopWhatsAppWeb(): Promise<void> {
  wantConnection = false; ++generation; closeSocket();
  if (connecting) await connecting.catch(() => undefined);
  await saving.catch(() => undefined);
  status = { state: 'disconnected' };
}
export async function resumeWhatsAppWeb(): Promise<void> {
  try {
    const files = await fs.readdir(directory());
    if (files.includes('creds.json')) {
      const raw = await fs.readFile(path.join(directory(), 'creds.json'), 'utf8');
      const creds = JSON.parse(raw) as { registered?: unknown };
      if (creds.registered === true) await startWhatsAppWeb();
    }
  } catch { /* No existing pairing. */ }
}
