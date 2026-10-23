import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  directory: '', startError: null as Error | null, authError: null as Error | null,
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
      if (mocks.authError) throw mocks.authError;
      return {
      state: { creds: {} }, saveCreds: vi.fn(async () => fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ synthetic: true })))
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
  expect(await web.getWhatsAppWebStatus()).toEqual({ state: 'error', reason: 'storage_unavailable' });
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
  expect(await web.getWhatsAppWebStatus()).toEqual({ state: 'error', reason: 'runtime_unavailable' });
  expect(JSON.stringify(await web.getWhatsAppWebStatus())).not.toContain('TOKEN');
  mocks.startError = null;
  expect(await web.startWhatsAppWeb()).toEqual({ state: 'connecting' });
});
it('reports a pre-QR disconnection without exposing the transport exception', async () => {
  await web.startWhatsAppWeb();
  const socket = mocks.sockets.at(-1)!;
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('PRIVATE SOCKET DETAIL') } });
  expect(await web.getWhatsAppWebStatus()).toEqual({ state: 'error', reason: 'connection_failed' });
});
it('retains the local session on remote logged-out events', async () => {
  await web.startWhatsAppWeb();
  const file = path.join(mocks.directory, 'notifications', 'whatsapp-web', 'creds.json');
  await fs.writeFile(file, '{"registered":true,"synthetic":true}');
  mocks.sockets.at(-1)!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  expect(await web.getWhatsAppWebStatus()).toEqual({ state: 'error', reason: 'session_invalid' });
  expect(await fs.readFile(file, 'utf8')).toContain('synthetic');
});
it('connects, emits pairing QR without real network and sends to a validated JID', async () => {
  expect(await web.startWhatsAppWeb()).toEqual({ state: 'connecting' });
  const sock = mocks.sockets.at(-1)!;
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  sock.ev.emit('connection.update', { qr: 'fake-qr-text' });
  expect(await web.getWhatsAppWebStatus()).toEqual({ state: 'qr', qr: 'fake-qr-text' });
  sock.ev.emit('creds.update', {});
  await vi.waitFor(async () => expect((await fs.stat(path.join(dir, 'creds.json'))).mode & 0o777).toBe(0o600));
  sock.ev.emit('connection.update', { connection: 'open' });
  expect(await web.getWhatsAppWebStatus()).toEqual({ state: 'connected' });
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
