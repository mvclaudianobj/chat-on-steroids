import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendSmtp, type SmtpMessage, type SmtpTransportOptions } from '../src/main/notification-smtp.js';
import { isCloudflareAddress, NotificationDeliveryError } from '../src/main/notification-failure.js';
import type { NotificationFailure } from '../src/shared/notification-center.js';
import { makeCertificate, type TestCertificate } from './fixtures/test-certificate.js';

const PASSWORD = 'synthetic-only-password';
const selfSigned = makeCertificate({ cn: 'marks3', altNames: ['marks3'] });
const authority = makeCertificate({ cn: 'Synthetic Test CA', ca: true });
const valid = makeCertificate({ cn: 'mail.test', altNames: ['mail.test'], issuer: authority });
const otherName = makeCertificate({ cn: 'other.test', altNames: ['other.test'], issuer: authority });

interface FakeOptions {
  implicitTls?: TestCertificate;
  starttls?: TestCertificate;
  advertiseStarttls?: boolean;
  starttlsReply?: string;
  /** Plain-text bytes written right after the STARTTLS go-ahead (command injection). */
  inject?: string;
  greeting?: string;
  auth?: string;
  mail?: string;
  rcpt?: string;
}
interface Fake { port: number; plain: string[]; secure: string[]; close: () => Promise<void> }

async function fakeSmtp(options: FakeOptions): Promise<Fake> {
  const plain: string[] = [];
  const secure: string[] = [];
  const sockets = new Set<net.Socket>();
  const serve = (socket: net.Socket, log: string[], encrypted: boolean, greet: boolean): void => {
    if (greet) socket.write(`${options.greeting ?? '220 local.test ESMTP'}\r\n`);
    let pending = '';
    let step: 'command' | 'user' | 'pass' | 'data' = 'command';
    const onData = (buffer: Buffer): void => {
      pending += buffer.toString();
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        log.push(line);
        if (step === 'data') { if (line === '.') { step = 'command'; socket.write('250 queued\r\n'); } continue; }
        if (step === 'user') { step = 'pass'; socket.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (step === 'pass') { step = 'command'; socket.write(`${options.auth ?? '235 ok'}\r\n`); continue; }
        if (line.startsWith('EHLO')) {
          socket.write(!encrypted && options.starttls && options.advertiseStarttls !== false ? '250-local.test\r\n250-AUTH LOGIN\r\n250 STARTTLS\r\n' : '250-local.test\r\n250 AUTH LOGIN\r\n');
        } else if (line === 'STARTTLS' && !encrypted && options.starttls) {
          const reply = options.starttlsReply ?? '220 go ahead';
          socket.write(`${reply}\r\n${options.inject ?? ''}`);
          if (!reply.startsWith('220')) continue;
          socket.off('data', onData);
          const upgraded = new tls.TLSSocket(socket, { isServer: true, key: options.starttls.key, cert: options.starttls.cert });
          upgraded.on('error', () => undefined);
          serve(upgraded, secure, true, false);
          return;
        } else if (line === 'AUTH LOGIN') {
          if (options.auth && !options.auth.startsWith('2')) { socket.write(`${options.auth}\r\n`); continue; }
          step = 'user'; socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (line.startsWith('MAIL FROM')) socket.write(`${options.mail ?? '250 ok'}\r\n`);
        else if (line.startsWith('RCPT TO')) socket.write(`${options.rcpt ?? '250 ok'}\r\n`);
        else if (line === 'DATA') { step = 'data'; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') { socket.end('221 bye\r\n'); }
        else socket.write('500 unsupported\r\n');
      }
    };
    socket.on('data', onData);
  };
  const server = options.implicitTls
    ? tls.createServer({ key: options.implicitTls.key, cert: options.implicitTls.cert }, socket => { sockets.add(socket); socket.on('error', () => undefined); serve(socket, secure, true, true); })
    : net.createServer(socket => { sockets.add(socket); socket.on('error', () => undefined); serve(socket, plain, false, true); });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port, plain, secure,
    close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); })
  };
}

const message = (port: number, extra: Partial<SmtpMessage> = {}): SmtpMessage => ({
  host: 'mail.test', port, security: 'starttls', username: 'synthetic-user', password: PASSWORD,
  from: 'from@example.com', to: 'to@example.com', subject: 'test', body: 'synthetic body', ...extra
});
const local: SmtpTransportOptions = { lookup: async () => ['127.0.0.1'], connectTimeoutMs: 3000, timeoutMs: 5000 };
async function failure(promise: Promise<unknown>): Promise<NotificationFailure> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(NotificationDeliveryError);
    expect(String((error as Error).message)).not.toContain(PASSWORD);
    return (error as NotificationDeliveryError).failure;
  }
  throw new Error('expected a delivery failure');
}
let fake: Fake | null = null;
afterEach(async () => { await fake?.close(); fake = null; vi.restoreAllMocks(); });
const noCredentials = (f: Fake) => {
  expect([...f.plain, ...f.secure].join(' ')).not.toContain(Buffer.from(PASSWORD).toString('base64'));
  expect([...f.plain, ...f.secure]).not.toContain('AUTH LOGIN');
};

describe('SMTP failure codes', () => {
  it('rejects header injection before any network operation', async () => {
    expect(await failure(sendSmtp(message(587, { from: 'sender@example.com\r\nBcc: secret@example.com' })))).toEqual({ code: 'config_incomplete' });
  });
  it('reports a name that does not resolve', async () => {
    const lookup = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); };
    expect(await failure(sendSmtp(message(587), { lookup }))).toEqual({ code: 'dns_failed' });
  });
  it('reports a refused port', async () => {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await failure(sendSmtp(message(port), local))).toMatchObject({ code: 'connection_refused' });
  });
  it('uses the next resolved address when the first refuses TCP before SMTP begins', async () => {
    fake = await fakeSmtp({ starttls: selfSigned });
    const report = await sendSmtp(message(fake.port, { pinnedFingerprint: selfSigned.fingerprint256 }), {
      ...local, lookup: async () => ['127.0.0.2', '127.0.0.1']
    });
    expect(report.pinned).toBe(true);
    expect(fake.plain).toEqual(['EHLO chat-marks', 'STARTTLS']);
    expect(fake.secure).toContain('DATA');
    expect(fake.plain).not.toContain('AUTH LOGIN');
    expect(fake.plain.join(' ')).not.toContain(Buffer.from(PASSWORD).toString('base64'));
  });
  it('reports a connect timeout and names Cloudflare proxy addresses', async () => {
    // An unconnected socket never emits `connect`: no real network is touched.
    vi.spyOn(net, 'connect').mockImplementation(() => new net.Socket());
    expect(await failure(sendSmtp(message(587), { lookup: async () => ['172.67.178.171', '2606:4700::6810:1'], connectTimeoutMs: 50 })))
      .toEqual({ code: 'connect_timeout', cloudflare: true });
    expect(await failure(sendSmtp(message(587), { lookup: async () => ['209.50.241.100'], connectTimeoutMs: 50 })))
      .toEqual({ code: 'connect_timeout' });
  });
  it('knows the published Cloudflare ranges', () => {
    expect(isCloudflareAddress('172.67.178.171')).toBe(true);
    expect(isCloudflareAddress('104.16.0.1')).toBe(true);
    expect(isCloudflareAddress('2606:4700::1')).toBe(true);
    expect(isCloudflareAddress('209.50.241.100')).toBe(false);
    expect(isCloudflareAddress('127.0.0.1')).toBe(false);
    expect(isCloudflareAddress('not-an-ip')).toBe(false);
  });
  it('refuses a relay that does not advertise STARTTLS without sending credentials', async () => {
    fake = await fakeSmtp({ starttls: selfSigned, advertiseStarttls: false });
    expect(await failure(sendSmtp(message(fake.port), local))).toEqual({ code: 'starttls_unavailable' });
    expect(fake.plain).toEqual(['EHLO chat-marks']);
    noCredentials(fake);
  });
  it('refuses a relay whose STARTTLS fails', async () => {
    fake = await fakeSmtp({ starttls: selfSigned, starttlsReply: '454 TLS not currently available' });
    expect(await failure(sendSmtp(message(fake.port), local))).toEqual({ code: 'starttls_unavailable', smtpCode: 454 });
    expect(fake.plain).toEqual(['EHLO chat-marks', 'STARTTLS']);
    noCredentials(fake);
  });
  it('reports a refused greeting with its SMTP code', async () => {
    fake = await fakeSmtp({ starttls: selfSigned, greeting: '554 no service' });
    expect(await failure(sendSmtp(message(fake.port), local))).toEqual({ code: 'server_error', smtpCode: 554 });
  });
});

describe('SMTP certificate trust', () => {
  it('rejects a self-signed STARTTLS certificate and shows its names and fingerprint, before AUTH', async () => {
    fake = await fakeSmtp({ starttls: selfSigned });
    const result = await failure(sendSmtp(message(fake.port), local));
    expect(result).toEqual({ code: 'tls_untrusted', certificate: expect.objectContaining({ fingerprint256: selfSigned.fingerprint256, names: ['marks3'], selfSigned: true }) });
    expect(fake.secure).toEqual([]);
    noCredentials(fake);
  });
  it('delivers over the pinned certificate only after the TLS check, never in plain text', async () => {
    fake = await fakeSmtp({ starttls: selfSigned });
    const report = await sendSmtp(message(fake.port, { pinnedFingerprint: selfSigned.fingerprint256.toLowerCase() }), local);
    expect(report).toMatchObject({ pinned: true, authorized: false, certificate: { fingerprint256: selfSigned.fingerprint256 } });
    expect(fake.plain).toEqual(['EHLO chat-marks', 'STARTTLS']);
    expect(fake.secure.slice(0, 4)).toEqual(['EHLO chat-marks', 'AUTH LOGIN', Buffer.from('synthetic-user').toString('base64'), Buffer.from(PASSWORD).toString('base64')]);
    expect(fake.secure).toContain('MAIL FROM:<from@example.com>');
    expect(fake.secure).toContain('RCPT TO:<to@example.com>');
  });
  it('refuses any other certificate once a fingerprint is pinned, even a publicly valid one', async () => {
    fake = await fakeSmtp({ starttls: valid });
    const pinned = await failure(sendSmtp(message(fake.port, { pinnedFingerprint: selfSigned.fingerprint256 }), { ...local, ca: authority.cert }));
    expect(pinned).toMatchObject({ code: 'tls_untrusted', pinned: true, certificate: { fingerprint256: valid.fingerprint256, names: ['mail.test'] } });
    expect(fake.secure).toEqual([]);
    noCredentials(fake);
  });
  it('rejects a malformed pin before connecting', async () => {
    expect(await failure(sendSmtp(message(587, { pinnedFingerprint: 'AA:BB' }), local))).toEqual({ code: 'config_incomplete' });
  });
  it('accepts a trusted certificate for the host and reports a name mismatch', async () => {
    fake = await fakeSmtp({ starttls: valid });
    expect(await sendSmtp(message(fake.port), { ...local, ca: authority.cert })).toMatchObject({ authorized: true, pinned: false });
    await fake.close();
    fake = await fakeSmtp({ starttls: otherName });
    expect(await failure(sendSmtp(message(fake.port), { ...local, ca: authority.cert })))
      .toMatchObject({ code: 'tls_hostname_mismatch', certificate: { names: ['other.test'], selfSigned: false } });
    noCredentials(fake);
  });
  it('checks implicit TLS the same way', async () => {
    fake = await fakeSmtp({ implicitTls: selfSigned });
    expect(await failure(sendSmtp(message(fake.port, { security: 'tls' }), local))).toMatchObject({ code: 'tls_untrusted' });
    expect(fake.secure).toEqual([]);
    expect(await sendSmtp(message(fake.port, { security: 'tls', pinnedFingerprint: selfSigned.fingerprint256 }), local)).toMatchObject({ pinned: true });
    expect(fake.secure).toContain('AUTH LOGIN');
  });
  it('drops plain-text replies injected before the STARTTLS handshake', async () => {
    fake = await fakeSmtp({ starttls: selfSigned, inject: '250 injected\r\n' });
    await sendSmtp(message(fake.port, { pinnedFingerprint: selfSigned.fingerprint256 }), local);
    expect(fake.secure).toContain('DATA');
  });
  it('inspects the certificate without credentials and without AUTH or mail', async () => {
    fake = await fakeSmtp({ starttls: selfSigned });
    const report = await failure(sendSmtp(message(fake.port, { username: '', password: '' }), { ...local, inspectOnly: true }));
    expect(report).toMatchObject({ code: 'tls_untrusted', certificate: { fingerprint256: selfSigned.fingerprint256 } });
    await fake.close();
    fake = await fakeSmtp({ starttls: selfSigned });
    expect(await sendSmtp(message(fake.port, { username: '', password: '', pinnedFingerprint: selfSigned.fingerprint256 }), { ...local, inspectOnly: true }))
      .toMatchObject({ pinned: true });
    await vi.waitFor(() => expect(fake!.secure).toEqual(['EHLO chat-marks', 'QUIT']));
  });
});

describe('SMTP refusals after TLS', () => {
  const pinned = { pinnedFingerprint: selfSigned.fingerprint256 };
  it('names a rejected login', async () => {
    fake = await fakeSmtp({ starttls: selfSigned, auth: '535 5.7.8 authentication failed' });
    expect(await failure(sendSmtp(message(fake.port, pinned), local))).toEqual({ code: 'auth_failed', smtpCode: 535 });
  });
  it('names a rejected sender', async () => {
    fake = await fakeSmtp({ starttls: selfSigned, mail: '553 5.7.1 sender not owned' });
    expect(await failure(sendSmtp(message(fake.port, pinned), local))).toEqual({ code: 'sender_rejected', smtpCode: 553 });
  });
  it('names a rejected recipient', async () => {
    fake = await fakeSmtp({ starttls: selfSigned, rcpt: '550 5.1.1 no such user' });
    expect(await failure(sendSmtp(message(fake.port, pinned), local))).toEqual({ code: 'recipient_rejected', smtpCode: 550 });
  });
});
