import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  BrowserWindow: vi.fn(function () { throw new Error('A valid restored session must not open a login window'); }),
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showErrorBox: vi.fn() }
}));
vi.mock('../src/main/secrets.js', () => ({ getSecret: vi.fn(), setSecret: vi.fn() }));
vi.mock('../src/main/logger.js', () => ({ logError: vi.fn(), logInfo: vi.fn() }));

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { getSecret, setSecret } from '../src/main/secrets.js';
import { logInfo } from '../src/main/logger.js';
import { logoutMarkspanel, requireMarkspanelLogin, startMarkspanelSessionMonitor } from '../src/main/markspanel-auth.js';

const options = { loginPage: '/app/login.html', preload: '/app/login.js' };
const fakeResponse = (body: unknown, status = 200): Response => ({ status, text: async () => JSON.stringify(body) }) as Response;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const saved = (expiry = Date.now() + 3600_000, authenticatedAt = Date.now()): string =>
  JSON.stringify({ access: 'valid-access', refresh: 'refresh', expiry, email: 'owner@example.com', authenticatedAt });
let stop: (() => void) | undefined;

function loginWindow() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn() });
  const win = Object.assign(new EventEmitter(), {
    webContents: contents, setMenu: vi.fn(), show: vi.fn(), loadFile: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    close(this: EventEmitter & { destroyed: boolean }) { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); },
    destroy(this: EventEmitter & { destroyed: boolean }) { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  });
  vi.mocked(BrowserWindow).mockImplementationOnce(function () { return win as never; });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const handler = (channel: string): ((event: unknown, input?: unknown) => Promise<{ok: boolean; message: string}>) => {
    const record = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
    if (!record) throw new Error(`No handler for ${channel}`);
    return record[1] as (event: unknown, input?: unknown) => Promise<{ok: boolean; message: string}>;
  };
  return { win, contents, event, handler };
}

describe('MarksPanel login gate', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(setSecret).mockResolvedValue(undefined); });
  afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('clears the encrypted session on local logout', async () => {
    await logoutMarkspanel();
    expect(setSecret).toHaveBeenCalledWith('markspanel:session', '');
  });

  it('validates a stored session with the server and does not show a login window', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved());
    const fetcher = vi.fn().mockResolvedValue(fakeResponse({ id: 'user-id', email: 'owner@example.com' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await requireMarkspanelLogin(options)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('https://marks.ia.br/api/user', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer valid-access' }) }));
    expect(setSecret).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows a safe error when the login page cannot be loaded', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const login = loginWindow();
    login.win.loadFile = vi.fn().mockRejectedValue(new Error('renderer load failed'));
    expect(await requireMarkspanelLogin(options)).toBe(false);
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Login do MarksPanel',
      expect.stringContaining('A tela de login não pôde ser carregada.')
    );
  });

  it('reports readiness only when the login window is ready to show', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const login = loginWindow();
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(login.win.loadFile).toHaveBeenCalledWith('/app/login.html'));
    expect(logInfo).not.toHaveBeenCalledWith('markspanel login ready');
    login.win.emit('ready-to-show');
    expect(login.win.show).toHaveBeenCalledOnce();
    expect(logInfo).toHaveBeenCalledWith('markspanel login ready');
    login.win.close();
    expect(await gate).toBe(false);
  });

  it('renews an expired session and revalidates the new bearer before granting access', async () => {
    vi.mocked(getSecret).mockResolvedValue(JSON.stringify({ ...JSON.parse(saved(Date.now() - 1000)), access: 'expired', refresh: 'refresh-old' }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(fakeResponse({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }))
      .mockResolvedValueOnce(fakeResponse({ id: 'user-id', email: 'owner@example.com' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await requireMarkspanelLogin(options)).toBe(true);
    expect(fetcher).toHaveBeenNthCalledWith(1, 'https://marks.ia.br/auth/device/token', expect.objectContaining({ method: 'POST' }));
    expect(fetcher).toHaveBeenNthCalledWith(2, 'https://marks.ia.br/api/user', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer access-new' }) }));
    expect(vi.mocked(setSecret)).toHaveBeenCalledWith('markspanel:session', expect.stringContaining('refresh-new'));
    vi.unstubAllGlobals();
  });

  it('revokes runtime access on 401 and erases persisted credentials before notifying the app owner', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ error: 'invalid_token' }, 401)));
    const onAccessLost = vi.fn(() => {
      expect(setSecret).toHaveBeenCalledWith('markspanel:session', '');
    });
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledWith('revoked'));
  });

  it('fails closed on temporary network failures without deleting a potentially valid session', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private URL or token must not be logged')));
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledWith('unavailable'));
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('treats HTTP 503 as unavailable and refuses to keep running without server proof', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ error: 'maintenance' }, 503)));
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledWith('unavailable'));
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('calls the normal app shutdown even if the main callback fails unexpectedly', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({}, 401)));
    stop = startMarkspanelSessionMonitor({ onAccessLost: () => { throw new Error('main callback failure'); } });
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
  });

  it('refreshes an aging runtime session and validates the new bearer before continuing', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved(Date.now() + 5_000));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(fakeResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }))
      .mockResolvedValueOnce(fakeResponse({ id: 'user-id', email: 'owner@example.com' }));
    vi.stubGlobal('fetch', fetcher);
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(setSecret).toHaveBeenCalledWith('markspanel:session', expect.stringContaining('new-refresh')));
    expect(onAccessLost).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenNthCalledWith(2, 'https://marks.ia.br/api/user', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer new-access' }) }));
  });

  it('retains the original login time across a bearer refresh', async () => {
    const authenticatedAt = Date.now() - SEVEN_DAYS_MS + 120_000;
    vi.mocked(getSecret).mockResolvedValue(saved(Date.now() - 1000, authenticatedAt));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(fakeResponse({ access_token: 'renewed', refresh_token: 'new-refresh', expires_in: 3600 }))
      .mockResolvedValueOnce(fakeResponse({ id: 'user-id', email: 'owner@example.com' })));
    expect(await requireMarkspanelLogin(options)).toBe(true);
    const persisted = vi.mocked(setSecret).mock.calls.find(([key, value]) => key === 'markspanel:session' && value !== '');
    expect(JSON.parse(persisted![1]).authenticatedAt).toBe(authenticatedAt);
  });

  it('asks for a new login after seven days even if the bearer still works', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved(Date.now() + 3600_000, Date.now() - SEVEN_DAYS_MS));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const window = loginWindow();
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(window.win.loadFile).toHaveBeenCalled());
    expect(fetcher).not.toHaveBeenCalled();
    window.win.close();
    expect(await gate).toBe(false);
  });

  it('requires a fresh login for sessions saved before the seven-day timestamp existed', async () => {
    vi.mocked(getSecret).mockResolvedValue(JSON.stringify({ access: 'access', refresh: 'refresh', expiry: Date.now() + 3600_000, email: 'owner@example.com' }));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const window = loginWindow();
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(window.win.loadFile).toHaveBeenCalled());
    expect(fetcher).not.toHaveBeenCalled();
    window.win.close();
    expect(await gate).toBe(false);
  });

  it('closes an active session at the seven-day boundary without refreshing it', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved(Date.now() + 3600_000, Date.now() - SEVEN_DAYS_MS));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledWith('revoked'));
    expect(fetcher).not.toHaveBeenCalled();
    expect(setSecret).toHaveBeenCalledWith('markspanel:session', '');
  });

  it('rejects refresh-token revocation with no revalidation against the old access token', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved(Date.now() - 1_000));
    const fetcher = vi.fn().mockResolvedValue(fakeResponse({ error: 'invalid_grant' }, 401));
    vi.stubGlobal('fetch', fetcher);
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledWith('revoked'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(setSecret).toHaveBeenCalledWith('markspanel:session', '');
  });

  it('rejects account identity changes during refresh instead of silently switching users', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved(Date.now() - 1_000));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(fakeResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }))
      .mockResolvedValueOnce(fakeResponse({ id: 'different-id', email: 'another@example.com' })));
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledWith('revoked'));
    expect(setSecret).not.toHaveBeenCalledWith('markspanel:session', expect.stringContaining('new-access'));
  });

  it('rejects a different account ID even when the returned email is unchanged', async () => {
    vi.mocked(getSecret).mockResolvedValue(JSON.stringify({ ...JSON.parse(saved()), id: 'original-id' }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ id: 'other-id', email: 'owner@example.com' })));
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledWith('revoked'));
    expect(setSecret).toHaveBeenCalledWith('markspanel:session', '');
  });

  it('treats invalid_grant on refresh as account revocation', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved(Date.now() - 1_000));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ error: 'invalid_grant' }, 400)));
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledWith('revoked'));
    expect(setSecret).toHaveBeenCalledWith('markspanel:session', '');
  });

  it('closes access after a bounded deadline when secure credential storage hangs', async () => {
    vi.useFakeTimers();
    vi.mocked(getSecret).mockImplementation(() => new Promise(() => {}));
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onAccessLost).toHaveBeenCalledWith('unavailable');
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('coalesces two concurrent logout requests into one encrypted erase', async () => {
    let finish!: () => void;
    vi.mocked(setSecret).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = logoutMarkspanel();
    const second = logoutMarkspanel();
    expect(second).toBe(first);
    expect(setSecret).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
  });

  it('stops monitoring during logout even if an earlier server response arrives afterward', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved());
    let resolveFetch!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await logoutMarkspanel();
    resolveFetch(fakeResponse({ error: 'revoked' }, 401));
    await Promise.resolve();
    await Promise.resolve();
    expect(onAccessLost).not.toHaveBeenCalled();
    expect(setSecret).toHaveBeenCalledWith('markspanel:session', '');
  });

  it('fails closed and tells main to shut down if encrypted logout persistence fails', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ id: 'user-id', email: 'owner@example.com' })));
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await new Promise<void>(resolve => setImmediate(resolve));
    vi.mocked(setSecret).mockRejectedValueOnce(new Error('keyring unavailable'));
    await expect(logoutMarkspanel()).rejects.toThrow('keyring unavailable');
    expect(onAccessLost).toHaveBeenCalledWith('unavailable');
    const other = startMarkspanelSessionMonitor({ onAccessLost: vi.fn() });
    other();
  });

  it('fails closed after 20 seconds when logout storage cannot complete', async () => {
    vi.useFakeTimers();
    vi.mocked(getSecret).mockResolvedValue(saved());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ id: 'user-id', email: 'owner@example.com' })));
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    vi.mocked(setSecret).mockImplementationOnce(() => new Promise(() => {}));
    const logout = logoutMarkspanel();
    const rejection = expect(logout).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(onAccessLost).toHaveBeenCalledWith('unavailable');
  });

  it('closing the password login while its network request is pending never saves a session', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const window = loginWindow();
    let resolveLogin!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { resolveLogin = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledTimes(3));
    const password = window.handler('markspanel:password')(window.event, { email: 'owner@example.com', password: 'test-password' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    window.win.close();
    expect(await gate).toBe(false);
    resolveLogin(fakeResponse({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 }));
    expect((await password).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(setSecret).not.toHaveBeenCalled();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('markspanel:password');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('markspanel:poll');
  });

  it('authorizes password login only after the verified account is stored securely', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const window = loginWindow();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(fakeResponse({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 }))
      .mockResolvedValueOnce(fakeResponse({ id: 'stable-user', email: 'owner@example.com' })));
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledTimes(3));
    const password = window.handler('markspanel:password')(window.event, { email: 'owner@example.com', password: 'test-password' });
    expect((await password).ok).toBe(true);
    expect(await gate).toBe(true);
    const committed = vi.mocked(setSecret).mock.calls.find(([name, value]) => name === 'markspanel:session' && value !== '');
    expect(committed).toBeDefined();
    expect(JSON.parse(committed![1])).toMatchObject({ access: 'access', email: 'owner@example.com', id: 'stable-user' });
    expect(JSON.parse(committed![1]).authenticatedAt).toBeGreaterThan(0);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(3);
  });

  it('refuses workspace access when token encryption fails after server validation', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    vi.mocked(setSecret).mockRejectedValueOnce(new Error('OS keychain is locked'));
    const window = loginWindow();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(fakeResponse({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 }))
      .mockResolvedValueOnce(fakeResponse({ id: 'stable-user', email: 'owner@example.com' })));
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledTimes(3));
    expect((await window.handler('markspanel:password')(window.event, { email: 'owner@example.com', password: 'test-password' })).ok).toBe(true);
    expect(await gate).toBe(false);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(3);
  });

  it('does not leave startup pending indefinitely if the OS keyring stalls after a successful login', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    vi.mocked(setSecret).mockImplementationOnce(() => new Promise<void>(() => {}));
    const window = loginWindow();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(fakeResponse({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600 }))
      .mockResolvedValueOnce(fakeResponse({ id: 'stable-user', email: 'owner@example.com' })));
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledTimes(3));
    vi.useFakeTimers();
    expect((await window.handler('markspanel:password')(window.event, { email: 'owner@example.com', password: 'test-password' })).ok).toBe(true);
    const denied = expect(gate).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await denied;
    expect(window.win.isDestroyed()).toBe(true);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(3);
  });

  it('rejects untrusted device authorization URLs without opening the browser or leaving a device code', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const window = loginWindow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({
      device_code: 'private-device', user_code: 'ABCD',
      verification_uri_complete: 'https://other.example/steal', expires_in: 600, interval: 5
    })));
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledTimes(3));
    expect((await window.handler('markspanel:start')(window.event)).ok).toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect((await window.handler('markspanel:poll')(window.event)).ok).toBe(false);
    window.win.close();
    expect(await gate).toBe(false);
  });

  it('refuses login IPC from a different frame or sender', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const window = loginWindow();
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledTimes(3));
    const password = window.handler('markspanel:password');
    expect((await password({ sender: window.contents, senderFrame: {} }, { email: 'owner@example.com', password: 'x' })).ok).toBe(false);
    expect((await password({ sender: {}, senderFrame: window.contents.mainFrame }, { email: 'owner@example.com', password: 'x' })).ok).toBe(false);
    expect(setSecret).not.toHaveBeenCalled();
    window.win.close();
    expect(await gate).toBe(false);
  });

  it('cleans IPC handlers and refuses access if the local renderer fails to load', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const window = loginWindow();
    window.win.loadFile.mockRejectedValueOnce(new Error('file unavailable'));
    const gate = requireMarkspanelLogin(options);
    expect(await gate).toBe(false);
    expect(window.win.isDestroyed()).toBe(true);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(3);
  });

  it('loads the live electron-vite login page in dev without requiring prebuilt renderer files', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const window = loginWindow();
    const gate = requireMarkspanelLogin({ ...options, loginUrl: 'http://127.0.0.1:5173/markspanel-login.html' });
    await vi.waitFor(() => expect(window.win.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/markspanel-login.html'));
    expect(window.win.loadFile).not.toHaveBeenCalled();
    window.win.close();
    expect(await gate).toBe(false);
  });

  it('refuses a non-local login URL and retains the bundled login file', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const window = loginWindow();
    const gate = requireMarkspanelLogin({ ...options, loginUrl: 'https://attacker.example/markspanel-login.html' });
    await vi.waitFor(() => expect(window.win.loadFile).toHaveBeenCalledWith('/app/login.html'));
    expect(window.win.loadURL).not.toHaveBeenCalled();
    window.win.close();
    expect(await gate).toBe(false);
  });

  it('refuses access when the renderer process crashes during login', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    const window = loginWindow();
    const gate = requireMarkspanelLogin(options);
    await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledTimes(3));
    window.contents.emit('render-process-gone');
    expect(await gate).toBe(false);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(3);
  });

  it('bounds streamed server responses before they are buffered', async () => {
    vi.mocked(getSecret).mockResolvedValue(saved());
    const oversized = new Uint8Array(150_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(oversized); controller.close(); }
    }), { status: 200 })));
    const onAccessLost = vi.fn();
    stop = startMarkspanelSessionMonitor({ onAccessLost });
    await vi.waitFor(() => expect(onAccessLost).toHaveBeenCalledWith('unavailable'));
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('blocks new privileged admissions synchronously when logout begins, even if the keyring is slow', async () => {
    vi.resetModules();
    const auth = await import('../src/main/markspanel-auth.js');
    expect(auth.markspanelAccessBlocked()).toBe(false);
    let release!: () => void;
    vi.mocked(setSecret).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = auth.logoutMarkspanel();
    expect(auth.markspanelAccessBlocked()).toBe(true);
    release();
    await pending;
    expect(auth.markspanelAccessBlocked()).toBe(true);
  });
});
