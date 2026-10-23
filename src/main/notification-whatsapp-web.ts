/** Local WhatsApp Web connection; no bridge server or renderer access to the session keys. */
import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';
import type { WhatsAppSetupIssue } from '../shared/notification-center.js';

export interface WhatsAppWebStatus { state: 'disconnected' | 'connecting' | 'qr' | 'connected' | 'error'; qr?: string; reason?: WhatsAppSetupIssue }
export class WhatsAppPairingError extends Error {
  constructor(readonly issue: WhatsAppSetupIssue) {
    super(`WhatsApp setup failed (${issue})`);
    this.name = 'WhatsAppPairingError';
  }
}
/** Only errno/name is inspected. Native error messages can contain a file path or account data. */
function startupIssue(error: unknown, phase: 'storage' | 'auth' | 'runtime'): WhatsAppSetupIssue {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EIO', 'ENOTDIR'].includes(code)) return 'storage_unavailable';
  if (phase === 'auth' && (error instanceof SyntaxError || code === 'ERR_INVALID_ARG_TYPE')) return 'session_invalid';
  if (phase === 'runtime' && ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(code)) return 'runtime_unavailable';
  return phase === 'storage' ? 'storage_unavailable' : phase === 'auth' ? 'session_invalid' : 'runtime_unavailable';
}
let socket: WASocket | null = null;
let status: WhatsAppWebStatus = { state: 'disconnected' };
let generation = 0;
let restart: ReturnType<typeof setTimeout> | null = null;
let wantConnection = false;
let connecting: Promise<void> | null = null;
let saving: Promise<void> = Promise.resolve();
let qrDeadline: ReturnType<typeof setTimeout> | null = null;
function directory(): string { return path.join(app.getPath('userData'), 'notifications', 'whatsapp-web'); }
export async function getWhatsAppWebStatus(): Promise<WhatsAppWebStatus> { return { ...status }; }
function closeSocket(): void {
  if (restart) { clearTimeout(restart); restart = null; }
  if (qrDeadline) { clearTimeout(qrDeadline); qrDeadline = null; }
  if (socket) { socket.ev.removeAllListeners('connection.update'); socket.ev.removeAllListeners('creds.update'); socket.ws.close(); socket = null; }
}
async function connect(): Promise<void> {
  const epoch = ++generation;
  closeSocket();
  status = { state: 'connecting' };
  const dir = directory();
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
  } catch (error) { throw new WhatsAppPairingError(startupIssue(error, 'storage')); }
  let auth: Awaited<ReturnType<typeof useMultiFileAuthState>>;
  try { auth = await useMultiFileAuthState(dir); }
  catch (error) { throw new WhatsAppPairingError(startupIssue(error, 'auth')); }
  const { state, saveCreds } = auth;
  if (epoch !== generation || !wantConnection) return;
  let active: WASocket;
  try { active = makeWASocket({ auth: state, printQRInTerminal: false, logger: { level: 'silent', child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} } as never }); }
  catch (error) { throw new WhatsAppPairingError(startupIssue(error, 'runtime')); }
  socket = active;
  if (!state.creds.registered) {
    qrDeadline = setTimeout(() => {
      if (epoch === generation && status.state === 'connecting') status = { state: 'error', reason: 'qr_timeout' };
    }, 35_000);
    qrDeadline.unref();
  }
  active.ev.on('creds.update', () => {
    if (epoch !== generation || !wantConnection) return;
    saving = saving.catch(() => undefined).then(async () => {
      if (epoch !== generation || !wantConnection) return;
      await saveCreds();
      for (const file of await fs.readdir(dir)) if (file.endsWith('.json')) await fs.chmod(path.join(dir, file), 0o600);
    }).catch(() => {
      if (epoch === generation) status = { state: 'error', reason: 'storage_unavailable' };
    });
  });
  active.ev.on('connection.update', update => {
    if (epoch !== generation) return;
    if (update.qr) {
      if (qrDeadline) { clearTimeout(qrDeadline); qrDeadline = null; }
      status = { state: 'qr', qr: update.qr };
    }
    if (update.connection === 'open') {
      if (qrDeadline) { clearTimeout(qrDeadline); qrDeadline = null; }
      status = { state: 'connected' };
    }
    if (update.connection === 'close') {
      if (qrDeadline) { clearTimeout(qrDeadline); qrDeadline = null; }
      socket = null;
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      // Never erase authentication automatically: only explicit Disconnect may revoke it.
      if (code === DisconnectReason.loggedOut) { wantConnection = false; status = { state: 'error', reason: 'session_invalid' }; return; }
      status = { state: 'error', reason: 'connection_failed' };
      if (wantConnection) {
        restart = setTimeout(() => {
          restart = null;
          void connect().catch(error => { status = { state: 'error', reason: error instanceof WhatsAppPairingError ? error.issue : 'unknown' }; });
        }, 3000);
        restart.unref();
      }
    }
  });
}
export async function startWhatsAppWeb(): Promise<WhatsAppWebStatus> {
  wantConnection = true;
  if (socket && status.state === 'error' && !restart) closeSocket();
  if (!socket && !restart) {
    connecting ??= connect().finally(() => { connecting = null; });
    try { await connecting; }
    catch (error) {
      wantConnection = false;
      const issue = error instanceof WhatsAppPairingError ? error.issue : 'unknown';
      status = { state: 'error', reason: issue };
      throw new WhatsAppPairingError(issue);
    }
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
