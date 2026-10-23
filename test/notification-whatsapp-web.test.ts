import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  directory: '', startError: null as Error | null, authError: null as Error | null, authStuck: false, authCalls: 0, saveStarted: false, saveBarrier: null as Promise<void> | null, registered: false,
  sockets: [] as Array<{ ev: import('node:events').EventEmitter; ws: { close: ReturnType<typeof vi.fn> }; sendMessage: ReturnType<typeof vi.fn>; logout: ReturnType<typeof vi.fn> }>
}));
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }));
vi.mock('@whiskeysockets/baileys', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: vi.fn(() => {
      if (mocks.startError) throw mocks.startError;
      const sock = { ev: new EventEmitter(), ws: { close: vi.fn() }, sendMessage: vi.fn(async () => undefined), logout: vi.fn(async () => undefined) };
      mocks.sockets.push(sock);
      return sock;
    }),
    DisconnectReason: { loggedOut: 401 },
    useMultiFileAuthState: vi.fn(async (dir: string) => {
      mocks.authCalls++;
      if (mocks.authError) throw mocks.authError;
      if (mocks.authStuck) return new Promise(() => undefined);
      return {
      state: { creds: { registered: mocks.registered } }, saveCreds: vi.fn(async () => {
        mocks.saveStarted = true;
        if (mocks.saveBarrier) await mocks.saveBarrier;
        await fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ synthetic: true }));
      })
      };
    })
  };
});
let web: typeof import('../src/main/notification-whatsapp-web.js');
beforeEach(async () => {
  mocks.directory = await fs.mkdtemp(path.join(tmpdir(), 'marks-whatsapp-fake-'));
  mocks.sockets = [];
  mocks.startError = null;
  mocks.authError = null;
  mocks.authStuck = false;
  mocks.authCalls = 0;
  mocks.saveStarted = false;
  mocks.saveBarrier = null;
  mocks.registered = false;
  vi.resetModules();
  web = await import('../src/main/notification-whatsapp-web.js');
});
afterEach(async () => {
  await web.stopWhatsAppWeb();
  await fs.rm(mocks.directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('returns a fixed storage code when the synthetic directory cannot be created', async () => {
  vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(Object.assign(new Error('PRIVATE PATH'), { code: 'EACCES' }));
  await expect(web.startWhatsAppWeb()).rejects.toMatchObject({ issue: 'storage_unavailable' });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'storage_unavailable' });
  expect(mocks.sockets).toHaveLength(0);
});
it('does not delete or reveal a malformed local session', async () => {
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'creds.json'), '{private-synthetic-invalid');
  mocks.authError = new SyntaxError('Private session contents must not leave the main process');
  await expect(web.startWhatsAppWeb()).rejects.toMatchObject({ issue: 'session_invalid' });
  expect((await fs.readFile(path.join(dir, 'creds.json'), 'utf8'))).toBe('{private-synthetic-invalid');
  expect(JSON.stringify(await web.getWhatsAppWebStatus())).not.toContain('private-synthetic-invalid');
});
it('classifies Baileys initialization errors without echoing private exception messages', async () => {
  mocks.startError = new Error('PRIVATE SYNTHETIC INTERNAL TOKEN');
  await expect(web.startWhatsAppWeb()).rejects.toMatchObject({ issue: 'runtime_unavailable' });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'runtime_unavailable' });
  expect(JSON.stringify(await web.getWhatsAppWebStatus())).not.toContain('TOKEN');
  mocks.startError = null;
  expect(await web.startWhatsAppWeb()).toMatchObject({ state: 'connecting' });
});
it('reports a pre-QR disconnection without exposing the transport exception', async () => {
  await web.startWhatsAppWeb();
  const socket = mocks.sockets.at(-1)!;
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('PRIVATE SOCKET DETAIL') } });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'connection_failed' });
});
it('retains the local session on remote logged-out events', async () => {
  await web.startWhatsAppWeb();
  const file = path.join(mocks.directory, 'notifications', 'whatsapp-web', 'creds.json');
  await fs.writeFile(file, '{"registered":true,"synthetic":true}');
  mocks.sockets.at(-1)!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'session_invalid' });
  expect(await fs.readFile(file, 'utf8')).toContain('synthetic');
});
it('connects, emits pairing QR without real network and sends to a validated JID', async () => {
  expect(await web.startWhatsAppWeb()).toMatchObject({ state: 'connecting' });
  const sock = mocks.sockets.at(-1)!;
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  sock.ev.emit('connection.update', { qr: 'fake-qr-text' });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'qr', qr: 'fake-qr-text' });
  sock.ev.emit('creds.update', {});
  await vi.waitFor(async () => expect((await fs.stat(path.join(dir, 'creds.json'))).mode & 0o777).toBe(0o600));
  sock.ev.emit('connection.update', { connection: 'open' });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connected' });
  await web.sendWhatsAppWeb('5511999999999', 'synthetic notice');
  expect(sock.sendMessage).toHaveBeenCalledWith('5511999999999@s.whatsapp.net', { text: 'synthetic notice' });
  await expect(web.sendWhatsAppWeb('../bad', 'no')).rejects.toThrow('Invalid WhatsApp number');
});
it('disconnect closes socket, removes local credentials, and prevents auto reconnect', async () => {
  await web.startWhatsAppWeb();
  const sock = mocks.sockets.at(-1)!;
  sock.ev.emit('creds.update', {});
  await vi.waitFor(async () => expect(await fs.stat(path.join(mocks.directory, 'notifications', 'whatsapp-web', 'creds.json'))).toBeDefined());
  expect(await web.disconnectWhatsAppWeb()).toEqual({ state: 'disconnected' });
  expect(sock.ws.close).toHaveBeenCalledOnce();
  expect(sock.logout).toHaveBeenCalledOnce();
  await expect(fs.stat(path.join(mocks.directory, 'notifications', 'whatsapp-web'))).rejects.toMatchObject({ code: 'ENOENT' });
  sock.ev.emit('connection.update', { connection: 'close' });
  expect(mocks.sockets).toHaveLength(1);
});
it('only resumes with stored auth files', async () => {
  await web.resumeWhatsAppWeb();
  expect(mocks.sockets).toHaveLength(0);
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, 'creds.json'), '{"registered":true}');
  await web.resumeWhatsAppWeb();
  expect(mocks.sockets).toHaveLength(1);
});

it('allows an explicit retry while an automatic reconnect is pending, without waiting on the old delay', async () => {
  await web.startWhatsAppWeb();
  mocks.sockets.at(-1)!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('SYNTHETIC') } });
  expect(mocks.sockets).toHaveLength(1);
  const result = await web.startWhatsAppWeb();
  expect(result.state).toBe('connecting');
  expect(mocks.sockets).toHaveLength(2);
});

it('does not keep a stale QR after first-QR timeout and explicit retry', async () => {
  vi.useFakeTimers();
  try {
    expect((await web.startWhatsAppWeb()).stage).toBe('network');
    await vi.advanceTimersByTimeAsync(35_100);
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'qr_timeout' });
    expect((await web.startWhatsAppWeb()).state).toBe('connecting');
    expect(mocks.sockets).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

it('expires a silent QR and reconnects instead of returning a permanently stale code', async () => {
  vi.useFakeTimers();
  try {
    await web.startWhatsAppWeb();
    const first = mocks.sockets[0]!;
    first.ev.emit('connection.update', { qr: 'SYNTHETIC-FIRST-QR' });
    await vi.advanceTimersByTimeAsync(65_100);
    const afterExpiry = await web.getWhatsAppWebStatus();
    expect(afterExpiry).not.toHaveProperty('qr');
    expect(afterExpiry.state).not.toBe('qr');
    await vi.advanceTimersByTimeAsync(3_100);
    vi.useRealTimers();
    await vi.waitFor(() => expect(mocks.sockets).toHaveLength(2));
    expect(first.ws.close).toHaveBeenCalledTimes(1);
    mocks.sockets[1]!.ev.emit('connection.update', { qr: 'SYNTHETIC-SECOND-QR' });
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'qr', qr: 'SYNTHETIC-SECOND-QR' });
  } finally { vi.useRealTimers(); }
});

it('keeps fresh QR rotations available without creating redundant sockets', async () => {
  vi.useFakeTimers();
  try {
    await web.startWhatsAppWeb();
    const active = mocks.sockets[0]!;
    active.ev.emit('connection.update', { qr: 'SYNTHETIC-QR-1' });
    await vi.advanceTimersByTimeAsync(19_000);
    active.ev.emit('connection.update', { qr: 'SYNTHETIC-QR-2' });
    await vi.advanceTimersByTimeAsync(19_000);
    active.ev.emit('connection.update', { qr: 'SYNTHETIC-QR-3' });
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'qr', qr: 'SYNTHETIC-QR-3' });
    expect(mocks.sockets).toHaveLength(1);
    expect(active.ws.close).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});


it('classifies an authentication initialization timeout and allows another attempt', async () => {
  mocks.authStuck = true;
  await expect(web.startWhatsAppWeb()).rejects.toMatchObject({ issue: 'session_invalid' });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'session_invalid', stage: 'auth' });
  mocks.authStuck = false;
  expect((await web.startWhatsAppWeb()).state).toBe('connecting');
});

it('refuses a session directory symlink without inspecting its target', async () => {
  const target = path.join(mocks.directory, 'private-unrelated');
  await fs.mkdir(target);
  await fs.mkdir(path.join(mocks.directory, 'notifications'));
  await fs.symlink(target, path.join(mocks.directory, 'notifications', 'whatsapp-web'));
  await expect(web.startWhatsAppWeb()).rejects.toMatchObject({ issue: 'storage_unavailable' });
  expect(mocks.sockets).toHaveLength(0);
  expect((await fs.stat(target)).mode & 0o777).not.toBe(0o700);
});

it('uses one socket for concurrent start requests and one socket on retry', async () => {
  const [a, b] = await Promise.all([web.startWhatsAppWeb(), web.startWhatsAppWeb()]);
  expect(a.state).toBe('connecting');
  expect(b.state).toBe('connecting');
  expect(mocks.sockets).toHaveLength(1);
  mocks.sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('SYNTHETIC') } });
  const [c, d] = await Promise.all([web.startWhatsAppWeb(), web.startWhatsAppWeb()]);
  expect(c.state).toBe('connecting');
  expect(d.state).toBe('connecting');
  expect(mocks.sockets).toHaveLength(2);
});


it('does not reload authentication before a pending save finishes during a manual retry', async () => {
  let releaseSave: () => void = () => {};
  mocks.saveBarrier = new Promise<void>(resolve => { releaseSave = resolve; });
  await web.startWhatsAppWeb();
  expect(mocks.authCalls).toBe(1);
  mocks.sockets[0]!.ev.emit('creds.update', {});
  await vi.waitFor(() => expect(mocks.saveStarted).toBe(true));
  mocks.sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('SYNTHETIC') } });
  const retry = web.startWhatsAppWeb();
  try {
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(mocks.authCalls).toBe(1);
  } finally {
    releaseSave();
  }
  await retry;
  expect(mocks.authCalls).toBe(2);
});

it('recovers automatically when a new unpaired socket never produces a QR', async () => {
  vi.useFakeTimers();
  try {
    await web.startWhatsAppWeb();
    const stalled = mocks.sockets[0]!;
    await vi.advanceTimersByTimeAsync(35_100);
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'qr_timeout', stage: 'qr' });
    expect(stalled.ws.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_100);
    vi.useRealTimers();
    await vi.waitFor(() => expect(mocks.sockets).toHaveLength(2));
    mocks.sockets[1]!.ev.emit('connection.update', { qr: 'SYNTHETIC-RECONNECTED-QR' });
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'qr', qr: 'SYNTHETIC-RECONNECTED-QR' });
  } finally { vi.useRealTimers(); }
});

it('recovers a registered session when its socket never reaches open or close', async () => {
  mocks.registered = true;
  vi.useFakeTimers();
  try {
    await web.startWhatsAppWeb();
    const stalled = mocks.sockets[0]!;
    await vi.advanceTimersByTimeAsync(35_100);
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'connection_failed', stage: 'network' });
    expect(stalled.ws.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_100);
    vi.useRealTimers();
    await vi.waitFor(() => expect(mocks.sockets).toHaveLength(2));
    mocks.sockets[1]!.ev.emit('connection.update', { connection: 'open' });
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connected', stage: 'ready' });
  } finally { vi.useRealTimers(); }
});
