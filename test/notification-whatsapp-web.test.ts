import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  directory: '', startError: null as Error | null, authError: null as Error | null, authStuck: false, authCalls: 0, saveStarted: false, saveBarrier: null as Promise<void> | null, registered: false,
  sockets: [] as Array<{ ev: import('node:events').EventEmitter; ws: { close: ReturnType<typeof vi.fn> }; sendMessage: ReturnType<typeof vi.fn>; logout: ReturnType<typeof vi.fn> }>
}));
it('uses the named socket factory exported by the actual Baileys CommonJS entry', () => {
  const actual = createRequire(import.meta.url)('@whiskeysockets/baileys') as {
    default: unknown; makeWASocket: unknown; useMultiFileAuthState: unknown
  };
  expect(typeof actual).toBe('object');
  expect(typeof actual.makeWASocket).toBe('function');
  expect(actual.makeWASocket).toBe(actual.default);
  expect(typeof actual.useMultiFileAuthState).toBe('function');
});
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }));
vi.mock('@whiskeysockets/baileys', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    makeWASocket: vi.fn(() => {
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
        await fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ synthetic: true, registered: mocks.registered }));
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
  await expect(web.startWhatsAppWeb()).rejects.toMatchObject({ issue: 'initialization_failed' });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'initialization_failed', stage: 'socket' });
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
it('accepts only live direct text from other numbered users and never its own or group traffic', async () => {
  const inbound = vi.fn(async () => undefined);
  web.setWhatsAppWebInbound(inbound);
  await web.startWhatsAppWeb();
  const sock = mocks.sockets.at(-1)!;
  const message = (remoteJid: string, fromMe = false) => ({ key: { id: 'exact-message-1', remoteJid, fromMe }, message: { conversation: '/menu' } });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('5511999999999@s.whatsapp.net')] });
  expect(inbound).not.toHaveBeenCalled(); // Only connected sockets accept text.
  sock.ev.emit('connection.update', { connection: 'open' });
  sock.ev.emit('messages.upsert', { type: 'append', messages: [message('5511999999999@s.whatsapp.net')] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('5511999999999@g.us'), message('5511999999999@lid'), message('5511999999999@s.whatsapp.net', true)] });
  expect(inbound).not.toHaveBeenCalled();
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('5511999999999@s.whatsapp.net')] });
  expect(inbound).toHaveBeenCalledTimes(1);
  expect(inbound).toHaveBeenCalledWith('5511999999999', 'exact-message-1', '/menu');
  await web.stopWhatsAppWeb();
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('5511999999999@s.whatsapp.net')] });
  expect(inbound).toHaveBeenCalledTimes(1);
});
it('resolves a LID direct message via its Baileys PN alternate, never via the LID digits or group participant', async () => {
  const inbound = vi.fn(async () => undefined);
  web.setWhatsAppWebInbound(inbound);
  await web.startWhatsAppWeb();
  const sock = mocks.sockets.at(-1)!;
  sock.ev.emit('connection.update', { connection: 'open' });
  const message = (remoteJid: string, remoteJidAlt?: string, fromMe = false, participantAlt?: string) => ({
    key: { id: 'synthetic-lid-message', remoteJid, remoteJidAlt, fromMe, participantAlt },
    message: { conversation: '/menu' }
  });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [message('9876543212345@lid', '5511999999999@s.whatsapp.net')] });
  expect(inbound).toHaveBeenCalledOnce();
  expect(inbound).toHaveBeenCalledWith('5511999999999', 'synthetic-lid-message', '/menu');
  // Baileys group participant PN is not the direct chat origin; never honor it.
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [
    message('5511888888888@g.us', '5511999999999@s.whatsapp.net'),
    message('5511888888888@g.us', undefined, false, '5511999999999@s.whatsapp.net'),
    message('9876543212345@lid'),
    message('9876543212345@lid', '9876543212345@lid'),
    message('9876543212345@lid', '5511999999999@s.whatsapp.net', true),
    message('9876543212345@lid', '5511999999999@s.whatsapp.net', false, '5511999999999@s.whatsapp.net')
  ] });
  expect(inbound).toHaveBeenCalledTimes(1);
});
it('accepts a modern long opaque LID without treating its digits as a phone number', async () => {
  const inbound = vi.fn(async () => undefined);
  web.setWhatsAppWebInbound(inbound);
  await web.startWhatsAppWeb();
  const sock = mocks.sockets.at(-1)!;
  sock.ev.emit('connection.update', { connection: 'open' });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { id: 'modern-lid', remoteJid: '999988887777666655@lid', remoteJidAlt: '5511999999999@s.whatsapp.net', fromMe: false }, message: { extendedTextMessage: { text: '/menu' } } }
  ] });
  expect(inbound).toHaveBeenCalledOnce();
  expect(inbound).toHaveBeenCalledWith('5511999999999', 'modern-lid', '/menu');
});
it('hardens legacy WhatsApp auth metadata before connecting without replacing file contents', async () => {
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  await fs.mkdir(dir, { recursive: true });
  const creds = path.join(dir, 'creds.json');
  const legacy = path.join(dir, 'session-legacy.json');
  await fs.writeFile(creds, '{"synthetic":true}');
  await fs.writeFile(legacy, '{"synthetic":"legacy"}');
  await fs.chmod(creds, 0o664);
  await fs.chmod(legacy, 0o664);
  await web.startWhatsAppWeb();
  expect((await fs.stat(creds)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(legacy)).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(creds, 'utf8')).toBe('{"synthetic":true}');
  expect(await fs.readFile(legacy, 'utf8')).toBe('{"synthetic":"legacy"}');
});
it('tolerates a disappearing Baileys session key during startup permissions sweep', async () => {
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  await fs.mkdir(dir, { recursive: true });
  const deleted = path.join(dir, 'transient-session.json');
  await fs.writeFile(deleted, '{"synthetic":true}');
  const original = fs.lstat.bind(fs);
  const missing = Object.assign(new Error('synthetic key vanished'), { code: 'ENOENT' });
  const spy = vi.spyOn(fs, 'lstat').mockImplementation(async file => {
    if (String(file) === deleted) throw missing;
    return original(file);
  });
  await expect(web.startWhatsAppWeb()).resolves.toMatchObject({ state: 'connecting' });
  expect(mocks.sockets).toHaveLength(1);
  expect(spy).toHaveBeenCalledWith(deleted);
});
it('does not silently start a fresh pairing when the actual credentials file vanishes mid-scan', async () => {
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  await fs.mkdir(dir, { recursive: true });
  const creds = path.join(dir, 'creds.json');
  await fs.writeFile(creds, '{"registered":true,"synthetic":true}');
  const original = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation(async file => {
    if (String(file) === creds) throw Object.assign(new Error('synthetic missing credentials'), { code: 'ENOENT' });
    return original(file);
  });
  await expect(web.startWhatsAppWeb()).rejects.toMatchObject({ issue: 'storage_unavailable' });
  expect(mocks.sockets).toHaveLength(0);
  expect(mocks.authCalls).toBe(0);
});
it('preserves genuine permissions errors instead of hiding them as Baileys deletion races', async () => {
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  await fs.mkdir(dir, { recursive: true });
  const key = path.join(dir, 'blocked-session.json');
  await fs.writeFile(key, '{"synthetic":true}');
  await fs.chmod(key, 0o664);
  const original = fs.chmod.bind(fs);
  vi.spyOn(fs, 'chmod').mockImplementation(async (file, mode) => {
    if (String(file) === key) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
    return original(file, mode);
  });
  await expect(web.startWhatsAppWeb()).rejects.toMatchObject({ issue: 'storage_unavailable' });
  expect(mocks.authCalls).toBe(0);
});
it('does not mark a live WhatsApp socket as storage unavailable when a session key disappears while chmod runs', async () => {
  await web.startWhatsAppWeb();
  const sock = mocks.sockets.at(-1)!;
  sock.ev.emit('connection.update', { connection: 'open' });
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  const transient = path.join(dir, 'transient-session.json');
  await fs.writeFile(transient, '{"synthetic":true}');
  const original = fs.chmod.bind(fs);
  let vanished = false;
  const spy = vi.spyOn(fs, 'chmod').mockImplementation(async (file, mode) => {
    if (!vanished && String(file) === transient) {
      vanished = true;
      await fs.rm(transient);
      throw Object.assign(new Error('synthetic deleted key'), { code: 'ENOENT' });
    }
    return original(file, mode);
  });
  sock.ev.emit('creds.update', {});
  await vi.waitFor(() => expect(vanished).toBe(true));
  await vi.waitFor(async () => expect((await fs.readFile(path.join(dir, 'creds.json'), 'utf8'))).toContain('synthetic'));
  // No benign key removal can mask an already authenticated connection.
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connected' });
  expect(spy).toHaveBeenCalledWith(transient, 0o600);
});
it('refuses symlinked auth JSON before Baileys can follow it', async () => {
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  const external = path.join(mocks.directory, 'never-touch.json');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(external, '{"private":"synthetic"}');
  await fs.symlink(external, path.join(dir, 'creds.json'));
  await expect(web.startWhatsAppWeb()).rejects.toMatchObject({ issue: 'storage_unavailable' });
  expect(mocks.authCalls).toBe(0);
  expect(await fs.readFile(external, 'utf8')).toBe('{"private":"synthetic"}');
});
it('exposes only aggregate inbound diagnostics and distinguishes unreachable handler from LID without PN', async () => {
  await web.startWhatsAppWeb();
  const sock = mocks.sockets.at(-1)!;
  sock.ev.emit('connection.update', { connection: 'open' });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { id: 'SENSITIVE-MSG-ID', remoteJid: '9876543212345@lid' }, message: { conversation: 'PRIVATE BODY' } }
  ] });
  const before = await web.getWhatsAppWebStatus();
  expect(before.inboundDiagnostics).toMatchObject({ noHandler: 1 });
  const inbound = vi.fn(async () => undefined);
  web.setWhatsAppWebInbound(inbound);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { id: 'SENSITIVE-MSG-ID-2', remoteJid: '9876543212345@lid' }, message: { conversation: 'PRIVATE BODY' } }
  ] });
  const after = await web.getWhatsAppWebStatus();
  expect(after.inboundDiagnostics).toMatchObject({ noHandler: 1, lidWithoutPn: 1 });
  expect(JSON.stringify(after)).not.toContain('SENSITIVE-MSG-ID');
  expect(JSON.stringify(after)).not.toContain('9876543212345');
  expect(JSON.stringify(after)).not.toContain('PRIVATE BODY');
});
it('sends only verified in-memory MP3 bytes and never fabricated Jarvis audio', async () => {
  await web.startWhatsAppWeb();
  const sock = mocks.sockets.at(-1)!;
  sock.ev.emit('connection.update', { connection: 'open' });
  await expect(web.sendWhatsAppWebMp3('5511999999999', Buffer.from('fake'))).rejects.toThrow('Invalid MP3 audio');
  const sample = Buffer.alloc(180); sample.write('ID3');
  await web.sendWhatsAppWebMp3('5511999999999', sample);
  expect(sock.sendMessage).toHaveBeenCalledWith('5511999999999@s.whatsapp.net', { audio: sample, mimetype: 'audio/mpeg', ptt: false });
});
it('does not replace an authenticated connection with a late pairing QR', async () => {
  await web.startWhatsAppWeb();
  const active = mocks.sockets.at(-1)!;
  active.ev.emit('connection.update', { connection: 'open' });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connected', stage: 'ready' });
  vi.useFakeTimers();
  try {
    // A delayed QR from the same socket cannot regress an authenticated session
    // or arm the QR expiry timeout that would close the already connected socket.
    active.ev.emit('connection.update', { qr: 'STALE-SYNTHETIC-QR' });
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connected', stage: 'ready' });
    expect(await web.getWhatsAppWebStatus()).not.toHaveProperty('qr');
    await vi.advanceTimersByTimeAsync(65_100);
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connected', stage: 'ready' });
    expect(active.ws.close).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
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
it('keeps a new manual connect requested during an unfinished disconnect', async () => {
  await web.startWhatsAppWeb();
  const old = mocks.sockets[0]!;
  let releaseLogout!: () => void;
  const logoutWaiting = new Promise<void>(resolve => { releaseLogout = resolve; });
  old.logout.mockImplementation(() => logoutWaiting);
  const disconnect = web.disconnectWhatsAppWeb();
  const reconnect = web.startWhatsAppWeb();
  releaseLogout();
  await disconnect;
  await reconnect;
  expect(mocks.sockets).toHaveLength(2);
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connecting' });
});
it('revokes notification sends immediately when disconnect begins, even while logout is pending', async () => {
  await web.startWhatsAppWeb();
  const old = mocks.sockets[0]!;
  old.ev.emit('connection.update', { connection: 'open' });
  let finishLogout!: () => void;
  old.logout.mockImplementation(() => new Promise<void>(resolve => { finishLogout = resolve; }));
  const disconnect = web.disconnectWhatsAppWeb();
  try {
    await expect(web.sendWhatsAppWeb('5511999999999', 'must-not-send')).rejects.toThrow('disconnected');
    expect(old.sendMessage).not.toHaveBeenCalled();
  } finally {
    finishLogout();
    await disconnect;
  }
  expect(await web.getWhatsAppWebStatus()).toEqual({ state: 'disconnected' });
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
it('does not restart a persisted WhatsApp session after shutdown wins a delayed resume read', async () => {
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'creds.json'), '{"registered":true}');
  const originalRead = fs.readFile.bind(fs);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let observed!: () => void;
  const reached = new Promise<void>(resolve => { observed = resolve; });
  vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith('creds.json')) { observed(); await gate; }
    return originalRead(...args);
  }) as typeof fs.readFile);
  const starting = web.resumeWhatsAppWeb();
  await reached;
  const stopping = web.stopWhatsAppWeb();
  release();
  await Promise.all([starting, stopping]);
  expect(mocks.sockets).toHaveLength(0);
  expect(await web.getWhatsAppWebStatus()).toEqual({ state: 'disconnected' });
});

it('does not reconnect when shutdown supersedes an in-flight startup credential read', async () => {
  const dir = path.join(mocks.directory, 'notifications', 'whatsapp-web');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'creds.json'), '{"registered":true}');
  const original = fs.readFile.bind(fs);
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith('creds.json')) { entered(); await blocked; }
    return original(...args);
  }) as typeof fs.readFile);
  const resume = web.resumeWhatsAppWeb();
  await started;
  const stop = web.stopWhatsAppWeb();
  unblock();
  await Promise.all([resume, stop]);
  expect(mocks.sockets).toHaveLength(0);
  expect(await web.getWhatsAppWebStatus()).toEqual({ state: 'disconnected' });
});

it('retries a transient storage failure during automatic reconnect and returns to connected', async () => {
  await web.startWhatsAppWeb();
  mocks.sockets[0]!.ev.emit('connection.update', { connection: 'open' });
  const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementationOnce(async () => {
    throw Object.assign(new Error('synthetic unavailable drive'), { code: 'EIO' });
  });
  vi.useFakeTimers();
  try {
    mocks.sockets[0]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('synthetic network') } });
    await vi.advanceTimersByTimeAsync(3_100);
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'error', reason: 'storage_unavailable' });
    mkdirSpy.mockRestore();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(6_100);
    vi.useRealTimers();
    await vi.waitFor(() => expect(mocks.sockets).toHaveLength(2));
    mocks.sockets[1]!.ev.emit('connection.update', { connection: 'open' });
    expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connected' });
  } finally { vi.useRealTimers(); }
});

it('flushes a queued registered auth update on graceful shutdown and reconnects after process reinitialization', async () => {
  await web.startWhatsAppWeb();
  const oldSocket = mocks.sockets[0]!;
  mocks.registered = true;
  // Baileys emits creds.update immediately before the app closes; the disk write
  // is scheduled in a promise, so stop must await it without cancelling the save.
  oldSocket.ev.emit('creds.update', {});
  await web.stopWhatsAppWeb();
  const authFile = path.join(mocks.directory, 'notifications', 'whatsapp-web', 'creds.json');
  expect(JSON.parse(await fs.readFile(authFile, 'utf8'))).toMatchObject({ registered: true });
  vi.resetModules();
  web = await import('../src/main/notification-whatsapp-web.js');
  await web.resumeWhatsAppWeb();
  expect(mocks.sockets).toHaveLength(2);
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connecting' });
  mocks.sockets[1]!.ev.emit('connection.update', { connection: 'open' });
  expect(await web.getWhatsAppWebStatus()).toMatchObject({ state: 'connected' });
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
