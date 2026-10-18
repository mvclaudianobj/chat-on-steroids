/** The Markspanel login is an application admission boundary, owned by main. */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { getSecret, setSecret } from './secrets.js';
import { logError, logInfo } from './logger.js';

const SERVER = 'https://marks.ia.br';
const CLIENT = 'opencode-cli'; // Same registered public device client used by MarksCode.
const STORE = 'markspanel:session';
const RECHECK_MS = 60_000;
const CHECK_DEADLINE_MS = 20_000;
// Runtime access must have fresh server proof. Even a transient outage ends this app
// runtime, but it does not erase credentials that may work again on the next launch.
export type MarkspanelAccessLoss = 'revoked' | 'unavailable';
let activeMonitor: (() => void) | null = null;
let monitorAccessLoss: ((reason: MarkspanelAccessLoss) => void) | null = null;
let sessionEpoch = 0;
let logoutInFlight: Promise<void> | null = null;
let accessClosing = false;
/** Close admissions synchronously while logout or loss of server proof shuts down the app. */
export function markspanelAccessBlocked(): boolean { return accessClosing || logoutInFlight !== null; }
class AuthRejected extends Error {}
class AuthUnavailable extends Error {}

function requireShutdown(onAccessLost: ((reason: MarkspanelAccessLoss) => void) | null, reason: MarkspanelAccessLoss): void {
  try {
    if (onAccessLost) onAccessLost(reason);
    else app.quit();
  } catch {
    // A broken notification hook cannot leave the app executing without a
    // live session monitor. Main's ordinary app.quit() still owns cleanup.
    app.quit();
  }
}
type Tokens = { access_token: string; refresh_token: string; expires_in: number };
type Saved = { access: string; refresh: string; expiry: number; email: string; id?: string };
type Profile = { id: string; email: string };
type Device = { device_code: string; user_code: string; verification_uri_complete: string; expires_in: number; interval: number };
const MAX_RESPONSE_BYTES = 131_072;

async function boundedResponse(response: Response): Promise<string> {
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new AuthUnavailable();
  // Stream decoding bounds bytes *before* materializing them in a string. The
  // text fallback supports minimal test doubles without a native body stream.
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new AuthUnavailable();
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let read = 0;
  let result = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      read += chunk.value.byteLength;
      if (read > MAX_RESPONSE_BYTES) throw new AuthUnavailable();
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
    if (read > MAX_RESPONSE_BYTES) void response.body.cancel().catch(() => {});
  }
}

async function json(route: string, body?: Record<string, string>, access?: string, signal?: AbortSignal): Promise<{ status: number; data: Record<string, unknown> }> {
  if (signal?.aborted) throw new AuthUnavailable();
  let response: Response;
  let content: string;
  try {
    response = await fetch(`${SERVER}${route}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(access ? { authorization: `Bearer ${access}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    });
    content = await boundedResponse(response);
  } catch { throw new AuthUnavailable(); }
  let data: unknown;
  try { data = JSON.parse(content); } catch { data = {}; }
  return { status: response.status, data: data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {} };
}

function tokens(data: Record<string, unknown>, refreshed = false): Tokens {
  if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token ||
    (refreshed ? data.token_type !== undefined && data.token_type !== 'Bearer' : data.token_type !== 'Bearer') ||
    typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 || data.expires_in > 2_592_000) throw new AuthRejected();
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in };
}

function requireSuccess(status: number): void {
  if (status === 200) return;
  if (status === 408 || status === 429 || status >= 500) throw new AuthUnavailable();
  throw new AuthRejected();
}

async function validate(access: string, signal?: AbortSignal): Promise<Profile> {
  const response = await json('/api/user', undefined, access, signal);
  requireSuccess(response.status);
  if (response.status !== 200 || typeof response.data.id !== 'string' || !response.data.id ||
    typeof response.data.email !== 'string' || !response.data.email.includes('@')) throw new AuthRejected();
  return { id: response.data.id, email: response.data.email };
}

async function prepareSession(result: Tokens, previous?: Saved, signal?: AbortSignal, epoch = sessionEpoch): Promise<Saved> {
  const profile = await validate(result.access_token, signal);
  if (previous && (profile.email.toLowerCase() !== previous.email.toLowerCase() ||
    (previous.id && profile.id !== previous.id))) throw new AuthRejected();
  if (epoch !== sessionEpoch || signal?.aborted) throw new AuthRejected();
  return { access: result.access_token, refresh: result.refresh_token,
    expiry: Date.now() + result.expires_in * 1000, email: profile.email, id: profile.id };
}

async function persist(result: Tokens, previous?: Saved, signal?: AbortSignal, epoch = sessionEpoch): Promise<void> {
  const data = await prepareSession(result, previous, signal, epoch);
  // Serialised by secrets.ts. Explicit logout increments epoch synchronously
  // before its own queued erase, so an in-flight refresh cannot win afterward.
  await setSecret(STORE, JSON.stringify(data));
}

async function verifyStoredSession(signal?: AbortSignal): Promise<'valid' | MarkspanelAccessLoss> {
  try {
    const epoch = sessionEpoch;
    const stored = await getSecret(STORE);
    if (!stored) return 'revoked';
    const data: Saved = JSON.parse(stored);
    if (typeof data.access !== 'string' || !data.access || typeof data.refresh !== 'string' || !data.refresh ||
      typeof data.email !== 'string' || !data.email.includes('@') || typeof data.expiry !== 'number' ||
      !Number.isFinite(data.expiry)) return 'revoked';
    if (epoch !== sessionEpoch || signal?.aborted) return 'revoked';
    if (data.expiry - Date.now() > 300_000) {
      const profile = await validate(data.access, signal);
      if (profile.email.toLowerCase() !== data.email.toLowerCase() || (data.id && profile.id !== data.id)) return 'revoked';
      return epoch === sessionEpoch && !signal?.aborted ? 'valid' : 'revoked';
    }
    const refreshed = await json('/auth/device/token', { grant_type: 'refresh_token', refresh_token: data.refresh, client_id: CLIENT }, undefined, signal);
    if (refreshed.status === 400 && refreshed.data.error === 'invalid_grant') throw new AuthRejected();
    requireSuccess(refreshed.status);
    // MarksCode's TokenRefresh schema does not require token_type on refresh.
    await persist(tokens(refreshed.data, true), data, signal, epoch);
    return 'valid';
  } catch (error) { return error instanceof AuthUnavailable ? 'unavailable' : error instanceof AuthRejected || error instanceof SyntaxError ? 'revoked' : 'unavailable'; }
}

async function restore(): Promise<boolean> {
  return await verifyStoredSession() === 'valid';
}

/** A blocked OS keyring cannot hold the login gate or an explicit sign-out open indefinitely. */
async function writeSessionWithinDeadline(value: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      setSecret(STORE, value),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new AuthUnavailable()), CHECK_DEADLINE_MS);
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Remove local credentials; a revoked session will also fail the next server validation. */
export function logoutMarkspanel(): Promise<void> {
  if (logoutInFlight) return logoutInFlight;
  accessClosing = true;
  sessionEpoch += 1;
  const notify = monitorAccessLoss;
  // This is a terminal admission transition. Avoid a racing monitor check
  // interpreting our own epoch change as server revocation and quitting before
  // the queued encrypted delete has completed.
  activeMonitor?.();
  const task = (async (): Promise<void> => {
    try {
      await writeSessionWithinDeadline('');
    } catch (error) {
      // IPC will refuse to report successful logout, and the existing main
      // shutdown must immediately end access even if the keyring stayed locked.
      requireShutdown(notify, 'unavailable');
      throw error;
    }
  })();
  logoutInFlight = task;
  void task.finally(() => { if (logoutInFlight === task) logoutInFlight = null; }).catch(() => {});
  return task;
}

/**
 * Start one main-process owner for runtime authentication (once the startup gate succeeded).
 * Every 60s GET /api/user validates the bearer, or refreshes before token expiry and
 * validates the replacement. 401/403, malformed identities and refresh refusals revoke
 * access; 5xx/429, network failures and 15s timeouts mean unavailable. Both stop this
 * runtime immediately via onAccessLost; unavailable preserves the encrypted session for
 * a later launch, while revoked erases it. The app owner must call app.quit() in the hook
 * so its existing bounded shutdown releases bridge, processes, sessions and IPC.
 * Call the returned stop function on before-quit. No renderer or secrets are exposed.
 */
export function startMarkspanelSessionMonitor(options: {
  onAccessLost: (reason: MarkspanelAccessLoss) => void;
  isQuitting?: () => boolean;
}): () => void {
  if (activeMonitor) throw new Error('MarksPanel session monitor is already running');
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  const stop = (): void => {
    active = false;
    if (timer) clearTimeout(timer);
    if (watchdog) clearTimeout(watchdog);
    timer = null;
    watchdog = null;
    abort?.abort();
    if (activeMonitor === stop) {
      activeMonitor = null;
      monitorAccessLoss = null;
    }
  };
  const check = async (): Promise<void> => {
    if (!active || options.isQuitting?.()) { stop(); return; }
    abort = new AbortController();
    // Include OS keyring reads/writes in the deadline, not just the network fetch:
    // a locked Keychain must never leave this app executing with stale proof forever.
    const outcome = await Promise.race([
      verifyStoredSession(abort.signal),
      new Promise<'unavailable'>(resolve => {
        watchdog = setTimeout(() => { abort?.abort(); resolve('unavailable'); }, CHECK_DEADLINE_MS);
        watchdog.unref();
      })
    ]);
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    abort = null;
    if (!active || options.isQuitting?.()) { stop(); return; }
    if (outcome !== 'valid') {
      accessClosing = true;
      stop();
      if (outcome === 'revoked') {
        sessionEpoch += 1;
        // Begin durable erasure before quit; do not delay shutdown if the keyring
        // blocks. Startup always checks the server even if this write was unfinished.
        void setSecret(STORE, '').catch(() => {});
      }
      if (!options.isQuitting?.()) requireShutdown(options.onAccessLost, outcome);
      return;
    }
    timer = setTimeout(() => { timer = null; void check(); }, RECHECK_MS);
    timer.unref();
  };
  activeMonitor = stop;
  monitorAccessLoss = options.onAccessLost;
  void check();
  return stop;
}

export async function requireMarkspanelLogin(options: { loginPage: string; loginUrl?: string; preload: string; isQuitting?: () => boolean }): Promise<boolean> {
  if (options.isQuitting?.()) return false;
  if (await restore()) return true;
  if (options.isQuitting?.()) return false;

  const gateEpoch = sessionEpoch;
  const loginAbort = new AbortController();
  const win = new BrowserWindow({ width: 470, height: 580, minWidth: 420, minHeight: 520, title: 'Chat Marks — Entrar',
    backgroundColor: '#11131a', autoHideMenuBar: true, show: false,
    webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false } });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-redirect', event => event.preventDefault());
  let closed = false;
  const own = (event: Electron.IpcMainInvokeEvent): boolean => !closed && !win.isDestroyed() && !options.isQuitting?.() &&
    event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  let running = false;
  let approvedSession: Saved | null = null;
  let device: { data: Device; expires: number; next: number } | null = null;
  const passwordHandler = async (event: Electron.IpcMainInvokeEvent, input: unknown): Promise<{ ok: boolean; message: string }> => {
    if (!own(event) || running || !input || typeof input !== 'object') return { ok: false, message: 'Solicitação inválida' };
    const { email, password } = input as { email?: unknown; password?: unknown };
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 2048 || !email.includes('@') || !password) return { ok: false, message: 'Informe e-mail e senha válidos' };
    running = true;
    try {
      const response = await json('/auth/device/login', { email, password }, undefined, loginAbort.signal);
      if (response.status !== 200) return { ok: false, message: response.status === 401 ? 'E-mail ou senha incorretos' : 'Não foi possível autenticar' };
      const approved = await prepareSession(tokens(response.data), undefined, loginAbort.signal, gateEpoch);
      if (closed || options.isQuitting?.() || gateEpoch !== sessionEpoch) return { ok: false, message: 'Autenticação cancelada' };
      // Commit on the approved window-close transition, never from an IPC handler
      // that can complete long after someone has closed/cancelled this login.
      approvedSession = approved;
      win.close();
      return { ok: true, message: 'Autenticado' };
    } catch { return { ok: false, message: 'Falha na autenticação ou conexão com o servidor' }; }
    finally { running = false; }
  };
  const startHandler = async (event: Electron.IpcMainInvokeEvent): Promise<{ ok: boolean; code?: string; retryAfterMs?: number; message: string }> => {
    if (!own(event) || running) return { ok: false, message: 'Solicitação inválida' };
    running = true;
    try {
      device = null;
      const response = await json('/auth/device/code', { client_id: CLIENT }, undefined, loginAbort.signal);
      const d = response.data;
      if (response.status !== 200 || typeof d.device_code !== 'string' || !d.device_code || d.device_code.length > 2048 ||
        typeof d.user_code !== 'string' || !d.user_code || typeof d.verification_uri_complete !== 'string' ||
        d.user_code.length > 128 || d.verification_uri_complete.length > 4096 ||
        typeof d.expires_in !== 'number' || !Number.isInteger(d.expires_in) || d.expires_in <= 0 ||
        typeof d.interval !== 'number' || !Number.isInteger(d.interval) || d.interval <= 0) throw new Error('Não foi possível iniciar o login pelo navegador');
      const url = new URL(d.verification_uri_complete, SERVER);
      if (url.origin !== SERVER || url.protocol !== 'https:' || url.username || url.password) throw new Error('Endereço de autenticação inválido');
      await shell.openExternal(url.toString());
      if (closed || loginAbort.signal.aborted) return { ok: false, message: 'Autenticação cancelada' };
      const retryAfterMs = Math.max(5, Math.min(30, d.interval)) * 1000;
      device = { data: d as unknown as Device, expires: Date.now() + Math.min(d.expires_in, 900) * 1000, next: Date.now() + retryAfterMs };
      return { ok: true, code: d.user_code, retryAfterMs, message: 'Autorize o código no navegador' };
    } catch { return { ok: false, message: 'Não foi possível iniciar a autorização' }; }
    finally { running = false; }
  };
  const pollHandler = async (event: Electron.IpcMainInvokeEvent): Promise<{ ok: boolean; pending?: boolean; retryAfterMs?: number; message: string }> => {
    if (!own(event) || !device || running) return { ok: false, message: 'Inicie o login no navegador' };
    if (Date.now() > device.expires) { device = null; return { ok: false, message: 'Código expirado. Gere outro.' }; }
    if (Date.now() < device.next) return { ok: true, pending: true, retryAfterMs: device.next - Date.now(), message: 'Aguardando autorização' };
    running = true;
    try {
      device.next = Date.now() + Math.max(5, Math.min(30, device.data.interval)) * 1000;
      const response = await json('/auth/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.data.device_code, client_id: CLIENT }, undefined, loginAbort.signal);
      if (response.data.error === 'authorization_pending' || response.data.error === 'slow_down') {
        if (response.data.error === 'slow_down') device.next += 5000;
        return { ok: true, pending: true, retryAfterMs: Math.max(1000, device.next - Date.now()), message: 'Aguardando autorização' };
      }
      if (response.status !== 200) return { ok: false, message: 'Autorização recusada ou expirada' };
      const approved = await prepareSession(tokens(response.data), undefined, loginAbort.signal, gateEpoch);
      if (closed || options.isQuitting?.() || gateEpoch !== sessionEpoch) return { ok: false, message: 'Autenticação cancelada' };
      approvedSession = approved;
      win.close();
      return { ok: true, message: 'Autenticado' };
    } catch { return { ok: false, message: 'Falha na autorização ou conexão com o servidor' }; }
    finally { running = false; }
  };
  const installed: string[] = [];
  let appearanceDeadline: ReturnType<typeof setTimeout> | null = null;
  let failureShown = false;
  const showFailure = (message: string): void => {
    if (failureShown || options.isQuitting?.()) return;
    failureShown = true;
    logError(`MarksPanel login window failure: ${message}`);
    dialog.showErrorBox('Login do MarksPanel', `${message}\n\nO aplicativo será encerrado. Tente abrir novamente.`);
  };
  try {
    // Register and clean up this window's exact IPC handlers as one lifetime.
    // If another login gate already owns a channel, dispose only our handlers.
    for (const [channel, handler] of [
      ['markspanel:password', passwordHandler],
      ['markspanel:start', startHandler],
      ['markspanel:poll', pollHandler]
    ] as const) {
      ipcMain.handle(channel, handler);
      installed.push(channel);
    }
    return await new Promise<boolean>((resolve) => {
      win.once('closed', () => {
        closed = true;
        loginAbort.abort();
        device = null;
        if (appearanceDeadline) clearTimeout(appearanceDeadline);
        const session = approvedSession;
        approvedSession = null;
        if (!session || options.isQuitting?.() || gateEpoch !== sessionEpoch) { resolve(false); return; }
        // Only this main-process authorization owns the encrypted commit.
        // Successful validation is necessary; a missing/unavailable keyring
        // still refuses entry even after the UI has closed.
        void writeSessionWithinDeadline(JSON.stringify(session)).then(async () => {
          if (options.isQuitting?.() || gateEpoch !== sessionEpoch) {
            try { await setSecret(STORE, ''); } catch { /* No workspace access is granted. */ }
            resolve(false);
          } else resolve(true);
        }, () => resolve(false));
      });
      win.once('ready-to-show', () => {
        if (appearanceDeadline) clearTimeout(appearanceDeadline);
        appearanceDeadline = null;
        if (!options.isQuitting?.()) {
          win.show();
          logInfo('markspanel login ready');
        } else win.close();
      });
      win.webContents.on('render-process-gone', () => {
        showFailure('A tela de login não pôde ser renderizada.');
        if (!win.isDestroyed()) win.close();
      });
      appearanceDeadline = setTimeout(() => {
        showFailure('A tela de login não ficou disponível a tempo.');
        if (!win.isDestroyed()) win.close();
      }, CHECK_DEADLINE_MS);
      appearanceDeadline.unref();
      // electron-vite's dev renderer is served in memory; no out/renderer HTML
      // exists on a clean checkout. Packaged builds continue to load their file.
      const target = options.loginUrl && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/markspanel-login\.html$/.test(options.loginUrl)
        ? win.loadURL(options.loginUrl) : win.loadFile(options.loginPage);
      void target.catch(() => {
        showFailure('A tela de login não pôde ser carregada.');
        if (!win.isDestroyed()) win.close();
      });
    });
  } finally {
    if (appearanceDeadline) clearTimeout(appearanceDeadline);
    loginAbort.abort();
    for (const channel of installed) ipcMain.removeHandler(channel);
    if (!win.isDestroyed()) win.destroy();
  }
}
