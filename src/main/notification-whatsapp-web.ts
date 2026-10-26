/** Local WhatsApp Web connection; no bridge server or renderer access to the session keys. */
import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makeWASocket, DisconnectReason, useMultiFileAuthState, type WASocket } from '@whiskeysockets/baileys';
import type { WhatsAppSetupIssue } from '../shared/notification-center.js';

export interface WhatsAppWebStatus { state: 'disconnected' | 'connecting' | 'qr' | 'connected' | 'error'; qr?: string; reason?: WhatsAppSetupIssue; stage?: 'storage' | 'auth' | 'socket' | 'network' | 'qr' | 'ready'; inboundDiagnostics?: Readonly<Record<InboundReason, number>> }
type InboundReason = 'batches' | 'notLive' | 'history' | 'noHandler' | 'own' | 'nonDirect' | 'lidWithoutPn' | 'invalidPn' | 'invalidText' | 'dispatched' | 'handlerFailed';
const inboundCounts = Object.fromEntries((['batches', 'notLive', 'history', 'noHandler', 'own', 'nonDirect', 'lidWithoutPn', 'invalidPn', 'invalidText', 'dispatched', 'handlerFailed'] as InboundReason[]).map(k => [k, 0])) as Record<InboundReason, number>;
function tally(reason: InboundReason): void { inboundCounts[reason] = Math.min(1_000_000, inboundCounts[reason] + 1); }
/** Only direct chats. LID digits are opaque identifiers, NEVER phone numbers. */
function inboundNumber(key: { remoteJid?: string | null; remoteJidAlt?: string | null; participant?: string | null; participantAlt?: string | null }): string | null {
  const primary = key.remoteJid ?? '';
  if (key.participant || key.participantAlt || !/^(?:\d{1,32})@lid$|^(?:\d{8,15})@s\.whatsapp\.net$/.test(primary)) { tally('nonDirect'); return null; }
  const pn = primary.endsWith('@lid') ? key.remoteJidAlt ?? '' : primary;
  const match = /^(\d{8,15})@s\.whatsapp\.net$/.exec(pn);
  if (!match) { tally(primary.endsWith('@lid') ? 'lidWithoutPn' : 'invalidPn'); return null; }
  return match[1]!;
}
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
  return phase === 'storage' ? 'storage_unavailable' : phase === 'auth' ? 'session_invalid' : 'initialization_failed';
}
let socket: WASocket | null = null;
let status: WhatsAppWebStatus = { state: 'disconnected' };
let generation = 0;
let restart: ReturnType<typeof setTimeout> | null = null;
let wantConnection = false;
let connecting: Promise<void> | null = null;
let disconnecting: Promise<void> | null = null;
let saving: Promise<void> = Promise.resolve();
let retryCount = 0;
let qrDeadline: ReturnType<typeof setTimeout> | null = null;
let qrRefreshDeadline: ReturnType<typeof setTimeout> | null = null;
let inbound: ((number: string, messageId: string, text: string) => Promise<void>) | null = null;
/** The main process installs a single owner-gated handler; the socket itself grants no authority. */
export function setWhatsAppWebInbound(handler: typeof inbound): void { inbound = handler; }
const FIRST_QR_VALIDITY_MS = 65_000;
const REFRESH_QR_VALIDITY_MS = 25_000;
const SETUP_IO_TIMEOUT_MS = 12_000;
function bounded<T>(work: Promise<T>, timeoutMs: number, issue: WhatsAppSetupIssue): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WhatsAppPairingError(issue)), timeoutMs);
  })]).finally(() => { if (timer) clearTimeout(timer); });
}
function beginConnect(): Promise<void> {
  if (connecting) return connecting;
  const task = connect().finally(() => { if (connecting === task) connecting = null; });
  connecting = task;
  return task;
}
function directory(): string { return path.join(app.getPath('userData'), 'notifications', 'whatsapp-web'); }
async function secureAuthMetadata(dir: string): Promise<void> {
  // Baileys multi-file storage uses plain writeFile() and inherits legacy file
  // permissions. Repair metadata before it reads keys, without inspecting contents.
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new WhatsAppPairingError('storage_unavailable');
    const filename = path.join(dir, entry.name);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new WhatsAppPairingError('storage_unavailable');
    if ((stat.mode & 0o077) !== 0) await fs.chmod(filename, 0o600);
  }
}
export async function getWhatsAppWebStatus(): Promise<WhatsAppWebStatus> { return status.state === 'connected' ? { ...status, inboundDiagnostics: { ...inboundCounts } } : { ...status }; }
function closeSocket(): void {
  if (restart) { clearTimeout(restart); restart = null; }
  if (qrDeadline) { clearTimeout(qrDeadline); qrDeadline = null; }
  if (qrRefreshDeadline) { clearTimeout(qrRefreshDeadline); qrRefreshDeadline = null; }
  if (socket) {
    const previous = socket; socket = null;
    previous.ev.removeAllListeners('connection.update'); previous.ev.removeAllListeners('creds.update');
    previous.ev.removeAllListeners('messages.upsert');
    // Baileys 7 closes asynchronously; never leave an unhandled rejection on a stale socket.
    try { void Promise.resolve(previous.ws.close()).catch(() => undefined); } catch { /* Socket already closed. */ }
  }
}
function scheduleReconnect(): void {
  if (!wantConnection || restart) return;
  const backoff = Math.min(3000 * 2 ** retryCount++, 30_000);
  restart = setTimeout(() => {
    restart = null;
    void beginConnect().catch(error => {
      if (wantConnection) status = {
        state: 'error', reason: error instanceof WhatsAppPairingError ? error.issue : 'unknown', stage: status.stage
      };
    });
  }, backoff);
  restart.unref();
}
async function connect(): Promise<void> {
  const epoch = ++generation;
  closeSocket();
  status = { state: 'connecting', stage: 'storage' };
  const dir = directory();
  try {
    await bounded(fs.mkdir(dir, { recursive: true, mode: 0o700 }), SETUP_IO_TIMEOUT_MS, 'storage_unavailable');
    const directoryStat = await bounded(fs.lstat(dir), SETUP_IO_TIMEOUT_MS, 'storage_unavailable');
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new WhatsAppPairingError('storage_unavailable');
    await bounded(fs.chmod(dir, 0o700), SETUP_IO_TIMEOUT_MS, 'storage_unavailable');
    await bounded(secureAuthMetadata(dir), SETUP_IO_TIMEOUT_MS, 'storage_unavailable');
  } catch (error) { throw new WhatsAppPairingError(startupIssue(error, 'storage')); }
  // Baileys' multi-file auth reads creds.json here. A rapid retry can otherwise read a
  // partially-written session from the previous socket; never delete or overwrite it.
  await bounded(saving.catch(() => undefined), SETUP_IO_TIMEOUT_MS, 'storage_unavailable');
  if (epoch !== generation || !wantConnection) return;
  status = { state: 'connecting', stage: 'auth' };
  let auth: Awaited<ReturnType<typeof useMultiFileAuthState>>;
  try { auth = await bounded(useMultiFileAuthState(dir), SETUP_IO_TIMEOUT_MS, 'session_invalid'); }
  catch (error) { throw new WhatsAppPairingError(startupIssue(error, 'auth')); }
  const { state, saveCreds } = auth;
  if (epoch !== generation || !wantConnection) return;
  status = { state: 'connecting', stage: 'socket' };
  let active: WASocket;
  try { active = makeWASocket({ auth: state, printQRInTerminal: false, logger: { level: 'silent', child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} } as never }); }
  catch (error) { throw new WhatsAppPairingError(startupIssue(error, 'runtime')); }
  socket = active;
  status = { state: 'connecting', stage: 'network' };
  active.ev.on('messages.upsert', ({ type, messages }) => {
    if (epoch !== generation) return;
    tally('batches');
    if (status.state !== 'connected') { tally('notLive'); return; }
    if (type !== 'notify') { tally('history'); return; }
    if (!inbound) { tally('noHandler'); return; }
    for (const item of messages) {
      if (item.key.fromMe) { tally('own'); continue; }
      if (!item.key.id) { tally('invalidText'); continue; }
      const number = inboundNumber(item.key);
      if (!number) continue;
      const content = item.message?.ephemeralMessage?.message ?? item.message;
      const text = content?.conversation ?? content?.extendedTextMessage?.text ?? '';
      if (!text.trim() || text.length > 5000) { tally('invalidText'); continue; }
      tally('dispatched');
      void inbound(number, item.key.id, text).catch(() => { tally('handlerFailed'); });
    }
  });
  // A WebSocket can remain silent without emitting close. This occurs with both
  // new QR pairing and already-registered sessions; a status-only timeout leaves
  // the socket alive and prevents automatic recovery indefinitely.
  qrDeadline = setTimeout(() => {
    if (epoch !== generation || status.state !== 'connecting') return;
    status = state.creds.registered
      ? { state: 'error', reason: 'connection_failed', stage: 'network' }
      : { state: 'error', reason: 'qr_timeout', stage: 'qr' };
    closeSocket();
    scheduleReconnect();
  }, 35_000);
  qrDeadline.unref();
  active.ev.on('creds.update', () => {
    if (epoch !== generation || !wantConnection) return;
    saving = saving.catch(() => undefined).then(async () => {
      // Once Baileys emitted a valid auth update, it must be persisted even if
      // graceful shutdown/reconnect revokes this socket before the microtask runs.
      // stop/disconnect both await "saving"; disconnect then deletes the folder.
      await saveCreds();
      for (const file of await fs.readdir(dir)) if (file.endsWith('.json')) await fs.chmod(path.join(dir, file), 0o600);
    }).catch(() => {
      if (epoch === generation) status = { state: 'error', reason: 'storage_unavailable', stage: 'storage' };
    });
  });
  active.ev.on('connection.update', update => {
    if (epoch !== generation) return;
    // A delayed pairing update must not replace an already authenticated socket
    // with an expiring QR or close that live connection on its expiry timer.
    if (update.qr && status.state !== 'connected') {
      if (qrDeadline) { clearTimeout(qrDeadline); qrDeadline = null; }
      if (qrRefreshDeadline) { clearTimeout(qrRefreshDeadline); qrRefreshDeadline = null; }
      const validity = status.state === 'qr' ? REFRESH_QR_VALIDITY_MS : FIRST_QR_VALIDITY_MS;
      status = { state: 'qr', qr: update.qr, stage: 'qr' };
      retryCount = 0;
      // Baileys 7 supplies the first QR for 60s and rotates later codes after 20s.
      // If the socket stalls, never offer an expired code indefinitely to the user.
      qrRefreshDeadline = setTimeout(() => {
        if (epoch !== generation || status.state !== 'qr') return;
        status = { state: 'error', reason: 'qr_timeout', stage: 'qr' };
        closeSocket();
        scheduleReconnect();
      }, validity);
      qrRefreshDeadline.unref();
    }
    if (update.connection === 'open') {
      if (qrDeadline) { clearTimeout(qrDeadline); qrDeadline = null; }
      if (qrRefreshDeadline) { clearTimeout(qrRefreshDeadline); qrRefreshDeadline = null; }
      status = { state: 'connected', stage: 'ready' };
      retryCount = 0;
    }
    if (update.connection === 'close') {
      // Baileys may still have a transport object; release all listeners/socket
      // before retrying, even when the network closes without a new QR.
      closeSocket();
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      // Never erase authentication automatically: only explicit Disconnect may revoke it.
      if (code === DisconnectReason.loggedOut) { wantConnection = false; status = { state: 'error', reason: 'session_invalid', stage: 'auth' }; return; }
      status = { state: 'error', reason: 'connection_failed', stage: 'network' };
      scheduleReconnect();
    }
  });
}
export async function startWhatsAppWeb(): Promise<WhatsAppWebStatus> {
  // Disconnect owns logout and session removal. A new Connect intent waits for that
  // transition to commit before opening a socket or inspecting saved credentials.
  if (disconnecting) await disconnecting;
  wantConnection = true;
  // A deliberate user retry supersedes the scheduled backoff immediately.
  if (restart) { clearTimeout(restart); restart = null; }
  if (socket && status.state === 'error') closeSocket();
  if (!socket) {
    try { await beginConnect(); }
    catch (error) {
      wantConnection = false;
      const issue = error instanceof WhatsAppPairingError ? error.issue : 'unknown';
      status = { state: 'error', reason: issue, stage: status.stage };
      throw new WhatsAppPairingError(issue);
    }
  }
  return getWhatsAppWebStatus();
}
async function disconnectNow(): Promise<void> {
  const active = socket;
  wantConnection = false;
  ++generation;
  if (restart) { clearTimeout(restart); restart = null; }
  if (active) await Promise.race([active.logout().catch(() => undefined), new Promise<void>(resolve => setTimeout(resolve, 2500))]);
  closeSocket();
  if (connecting) await bounded(connecting.catch(() => undefined), SETUP_IO_TIMEOUT_MS, 'storage_unavailable');
  await bounded(saving.catch(() => undefined), SETUP_IO_TIMEOUT_MS, 'storage_unavailable');
  await fs.rm(directory(), { recursive: true, force: true });
  status = { state: 'disconnected' };
}
export async function disconnectWhatsAppWeb(): Promise<WhatsAppWebStatus> {
  if (!disconnecting) {
    const task = disconnectNow();
    disconnecting = task;
    void task.finally(() => { if (disconnecting === task) disconnecting = null; }).catch(() => undefined);
  }
  await disconnecting;
  return getWhatsAppWebStatus();
}
export async function sendWhatsAppWeb(number: string, message: string): Promise<void> {
  // Disconnect revokes send authority synchronously, before Baileys logout settles.
  if (!wantConnection || !socket || status.state !== 'connected') throw new Error('WhatsApp Web disconnected');
  if (!/^\d{8,15}$/.test(number)) throw new Error('Invalid WhatsApp number');
  await socket.sendMessage(`${number}@s.whatsapp.net`, { text: message });
}
/** Reserved for Jarvis once an actual MP3 is produced; never synthesize/claim audio here. */
export async function sendWhatsAppWebMp3(number: string, audio: Buffer): Promise<void> {
  if (!wantConnection || !socket || status.state !== 'connected') throw new Error('WhatsApp Web disconnected');
  if (!/^\d{8,15}$/.test(number)) throw new Error('Invalid WhatsApp number');
  if (!Buffer.isBuffer(audio) || audio.length < 128 || audio.length > 8 * 1024 * 1024 ||
      !(audio.subarray(0, 3).toString('ascii') === 'ID3' || (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0))) {
    throw new Error('Invalid MP3 audio');
  }
  await socket.sendMessage(`${number}@s.whatsapp.net`, { audio, mimetype: 'audio/mpeg', ptt: false });
}
export async function stopWhatsAppWeb(): Promise<void> {
  wantConnection = false; ++generation; closeSocket();
  if (connecting) await bounded(connecting.catch(() => undefined), SETUP_IO_TIMEOUT_MS, 'unknown').catch(() => undefined);
  await bounded(saving.catch(() => undefined), SETUP_IO_TIMEOUT_MS, 'storage_unavailable').catch(() => undefined);
  status = { state: 'disconnected' };
}
export async function resumeWhatsAppWeb(): Promise<void> {
  if (wantConnection || status.state === 'connected' || status.state === 'connecting' || status.state === 'qr') return;
  try {
    const files = await fs.readdir(directory());
    if (files.includes('creds.json')) {
      const raw = await fs.readFile(path.join(directory(), 'creds.json'), 'utf8');
      const creds = JSON.parse(raw) as { registered?: unknown };
      if (creds.registered === true) await startWhatsAppWeb();
    }
  } catch { /* No existing pairing. */ }
}
