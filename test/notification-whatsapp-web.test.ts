import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  directory: '', sockets: [] as Array<{ ev: import('node:events').EventEmitter; ws: { close: ReturnType<typeof vi.fn> }; sendMessage: ReturnType<typeof vi.fn>; logout: ReturnType<typeof vi.fn> }>
}));
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }));
vi.mock('@whiskeysockets/baileys', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: vi.fn(() => {
      const sock = { ev: new EventEmitter(), ws: { close: vi.fn() }, sendMessage: vi.fn(async () => undefined), logout: vi.fn(async () => undefined) };
      mocks.sockets.push(sock);
      return sock;
    }),
    DisconnectReason: { loggedOut: 401 },
    useMultiFileAuthState: vi.fn(async (dir: string) => ({
      state: { creds: {} }, saveCreds: vi.fn(async () => fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ synthetic: true })))
    }))
  };
});
let web: typeof import('../src/main/notification-whatsapp-web.js');
beforeEach(async () => {
  mocks.directory = await fs.mkdtemp(path.join(tmpdir(), 'marks-whatsapp-fake-'));
  mocks.sockets = [];
  vi.resetModules();
  web = await import('../src/main/notification-whatsapp-web.js');
});
afterEach(async () => {
  await web.stopWhatsAppWeb();
  await fs.rm(mocks.directory, { recursive: true, force: true });
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
