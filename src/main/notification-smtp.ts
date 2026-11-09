/**
 * Minimal SMTP client: implicit TLS or mandatory STARTTLS, bounded responses, no debug output.
 * Every failure is a classified `NotificationDeliveryError`; no credential, body or server text
 * leaves this module. A channel may pin one exact server certificate by SHA-256 fingerprint: then
 * only that certificate is accepted (still over TLS, STARTTLS still mandatory), checked before
 * anything is sent on the encrypted connection.
 */
import net from 'node:net';
import tls from 'node:tls';
import { promises as dns } from 'node:dns';
import { timingSafeEqual } from 'node:crypto';
import { CERTIFICATE_FINGERPRINT, type NotificationFailureCode, type PresentedCertificate } from '../shared/notification-center.js';
import { deliveryFailure, isCloudflareAddress, networkFailureCode, NotificationDeliveryError } from './notification-failure.js';

export interface SmtpMessage {
  host: string; port: number; security: 'tls' | 'starttls'; username: string; password: string;
  from: string; to: string; subject: string; body: string;
  /** Pinned server certificate (`fingerprint256` form); when set, no other certificate is accepted. */
  pinnedFingerprint?: string;
}
export interface SmtpTransportOptions {
  /** Connect to this address instead of resolving `host`; TLS still names and verifies `host`. */
  connectAddress?: string;
  lookup?: (host: string) => Promise<string[]>;
  connectTimeoutMs?: number;
  timeoutMs?: number;
  /** Stop after the TLS handshake and certificate check: no AUTH, no mail. Used for diagnostics. */
  inspectOnly?: boolean;
  /** Extra trusted CA (tests only). */
  ca?: string;
}
export interface SmtpReport { certificate?: PresentedCertificate; authorized: boolean; pinned: boolean }
interface SmtpReply { code: number; lines: string[] }

const addr = /^[^\s<>\r\n@]+@[^\s<>\r\n@]+\.[^\s<>\r\n@]+$/;
function escapeHeader(s: string): string { return s.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 300); }
function encodeHeader(s: string): string { return `=?UTF-8?B?${Buffer.from(escapeHeader(s)).toString('base64')}?=`; }
const defaultLookup = async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true, verbatim: true })).map(entry => entry.address);
const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 253);
const transportCode = (error: unknown): NotificationFailureCode => {
  const code = networkFailureCode(error);
  return code === 'unknown' ? 'connection_closed' : code;
};

/** Public identity of the presented certificate, shown so the user can decide whether to pin it. */
export function presentedCertificate(socket: tls.TLSSocket): PresentedCertificate | undefined {
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.fingerprint256) return undefined;
  const names = new Set<string>();
  const cn = cert.subject?.CN as string | string[] | undefined;
  for (const value of Array.isArray(cn) ? cn : cn ? [cn] : []) names.add(printable(value));
  for (const part of (cert.subjectaltname ?? '').split(',')) {
    const value = part.trim().replace(/^(DNS|IP Address):/i, '');
    if (value) names.add(printable(value));
  }
  const subject = JSON.stringify(cert.subject ?? {});
  return {
    fingerprint256: cert.fingerprint256.toUpperCase(),
    names: [...names].filter(Boolean).slice(0, 10),
    selfSigned: socket.authorizationError?.toString() === 'DEPTH_ZERO_SELF_SIGNED_CERT' || (subject !== '{}' && subject === JSON.stringify(cert.issuer ?? {})),
    ...(cert.valid_to ? { validTo: printable(cert.valid_to) } : {})
  };
}
function sameFingerprint(a: string, b: string): boolean {
  const left = Buffer.from(a.toUpperCase()); const right = Buffer.from(b.toUpperCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function sendSmtp(message: SmtpMessage, options: SmtpTransportOptions = {}): Promise<SmtpReport> {
  if (!addr.test(message.from) || !addr.test(message.to)) throw deliveryFailure('config_incomplete');
  if (!message.host || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) throw deliveryFailure('config_incomplete');
  if (!options.inspectOnly && (!message.username || !message.password)) throw deliveryFailure('credential_missing');
  const pin = message.pinnedFingerprint?.trim().toUpperCase() || '';
  if (pin && !CERTIFICATE_FINGERPRINT.test(pin)) throw deliveryFailure('config_incomplete');

  const target = options.connectAddress ?? message.host;
  let addresses: string[];
  try { addresses = net.isIP(target) ? [target] : await (options.lookup ?? defaultLookup)(target); }
  catch { throw deliveryFailure('dns_failed'); }
  if (!addresses.length) throw deliveryFailure('dns_failed');
  const cloudflare = addresses.some(isCloudflareAddress);
  // DNS may return a stale/unreachable first A or AAAA record. Try another address only before
  // receiving the SMTP greeting: after that point the server may have accepted commands/mail.
  // A refused/unreachable socket or a pre-greeting close has not received credentials or mail.
  const deadline = Date.now() + (options.timeoutMs ?? 20000);
  const targets = [...new Set(addresses)].slice(0, 4);
  for (const [index, address] of targets.entries()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw deliveryFailure('connect_timeout', cloudflare ? { cloudflare } : {});
    let greeted = false;
    try {
      return await sendSmtpAtAddress(message, address, cloudflare, pin, {
        ...options, timeoutMs: remaining, connectTimeoutMs: Math.min(options.connectTimeoutMs ?? 10000, remaining)
      }, () => { greeted = true; });
    } catch (error) {
      if (!(error instanceof NotificationDeliveryError) || greeted ||
        !['connect_timeout', 'connection_refused', 'network_unreachable', 'connection_closed'].includes(error.failure.code) ||
        index === targets.length - 1) throw error;
    }
  }
  throw deliveryFailure('connection_closed');
}

async function sendSmtpAtAddress(
  message: SmtpMessage, address: string, cloudflare: boolean, pin: string, options: SmtpTransportOptions,
  onGreeting: () => void
): Promise<SmtpReport> {
  const connectFailure = (code: NotificationFailureCode) => deliveryFailure(code, cloudflare ? { cloudflare } : {});

  const tlsOptions = (): tls.ConnectionOptions => ({
    // Trust is decided by verify() from `authorized` or the pin before any byte is written over TLS.
    rejectUnauthorized: false, minVersion: 'TLSv1.2',
    ...(net.isIP(message.host) ? {} : { servername: message.host }),
    checkServerIdentity: (_name, cert) => tls.checkServerIdentity(message.host, cert),
    ...(options.ca ? { ca: [...tls.rootCertificates, options.ca] } : {})
  });
  let socket: net.Socket | tls.TLSSocket = message.security === 'tls'
    ? tls.connect({ host: address, port: message.port, ...tlsOptions() })
    : net.connect({ host: address, port: message.port });
  let connected = false;
  let failed: NotificationDeliveryError | null = null;
  const rejecters = new Set<(error: NotificationDeliveryError) => void>();
  const abort = (error: NotificationDeliveryError): void => {
    if (failed) return;
    failed = error;
    for (const reject of rejecters) reject(error);
    rejecters.clear();
    socket.destroy();
  };
  const wait = <T>(start: (resolve: (value: T) => void) => void): Promise<T> => new Promise<T>((resolve, reject) => {
    if (failed) { reject(failed); return; }
    const done = (error: NotificationDeliveryError) => reject(error);
    rejecters.add(done);
    start(value => { rejecters.delete(done); resolve(value); });
  });

  let stash = '';
  let lines: string[] = [];
  const replies: SmtpReply[] = [];
  const readers: Array<(reply: SmtpReply) => void> = [];
  const receive = (chunk: Buffer | string): void => {
    stash += chunk.toString('latin1');
    if (stash.length > 16384) { abort(deliveryFailure('server_error')); return; }
    let index: number;
    while ((index = stash.indexOf('\n')) >= 0) {
      const line = stash.slice(0, index).replace(/\r$/, '');
      stash = stash.slice(index + 1);
      const match = /^(\d{3})([ -]|$)/.exec(line);
      if (!match || lines.length >= 100) { abort(deliveryFailure('server_error')); return; }
      lines.push(line.slice(4));
      if (match[2] === '-') continue;
      const answer = { code: Number(match[1]), lines };
      lines = [];
      const reader = readers.shift();
      if (reader) reader(answer); else replies.push(answer);
    }
  };
  const watch = (current: net.Socket): (() => void) => {
    const onError = (error: Error) => abort(connected ? deliveryFailure(transportCode(error)) : connectFailure(transportCode(error)));
    const onClose = () => abort(connected ? deliveryFailure('connection_closed') : connectFailure('connection_closed'));
    current.on('data', receive); current.on('error', onError); current.on('close', onClose);
    return () => { current.off('data', receive); current.off('error', onError); current.off('close', onClose); };
  };
  const connectTimer = setTimeout(() => { if (!connected) abort(connectFailure('connect_timeout')); }, options.connectTimeoutMs ?? 10000);
  const deadline = setTimeout(() => abort(connected ? deliveryFailure('server_timeout') : connectFailure('connect_timeout')), options.timeoutMs ?? 20000);
  connectTimer.unref(); deadline.unref();

  const reply = (): Promise<SmtpReply> => replies.length ? Promise.resolve(replies.shift()!) : wait<SmtpReply>(resolve => { readers.push(resolve); });
  const expect = async (accepted: number[], code: NotificationFailureCode): Promise<SmtpReply> => {
    const answer = await reply();
    if (!accepted.includes(answer.code)) throw deliveryFailure(code, { smtpCode: answer.code });
    return answer;
  };
  const command = (value: string, accepted: number[], code: NotificationFailureCode): Promise<SmtpReply> => { socket.write(`${value}\r\n`); return expect(accepted, code); };
  let certificate: PresentedCertificate | undefined;
  let authorized = false;
  const verify = (secure: tls.TLSSocket): void => {
    certificate = presentedCertificate(secure);
    if (!certificate) throw deliveryFailure('tls_untrusted');
    if (pin) {
      if (!sameFingerprint(certificate.fingerprint256, pin)) throw deliveryFailure('tls_untrusted', { pinned: true, certificate });
      authorized = secure.authorized;
      return;
    }
    if (!secure.authorized) throw deliveryFailure(secure.authorizationError?.toString() === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'tls_hostname_mismatch' : 'tls_untrusted', { certificate });
    authorized = true;
  };
  const secured = (secure: tls.TLSSocket): Promise<void> => wait<void>(resolve => secure.once('secureConnect', () => resolve()));
  const report = (): SmtpReport => ({ ...(certificate ? { certificate } : {}), authorized, pinned: !!pin });
  try {
    const unwatch = watch(socket);
    await wait<void>(resolve => socket.once('connect', () => resolve()));
    connected = true;
    clearTimeout(connectTimer);
    if (message.security === 'tls') { await secured(socket as tls.TLSSocket); verify(socket as tls.TLSSocket); }
    await expect([220], 'server_error');
    onGreeting();
    const hello = await command('EHLO chat-marks', [250], 'server_error');
    if (message.security === 'starttls') {
      if (!hello.lines.some(line => /^STARTTLS\b/i.test(line))) throw deliveryFailure('starttls_unavailable');
      await command('STARTTLS', [220], 'starttls_unavailable');
      // Plain-text bytes sent before the handshake are discarded (STARTTLS command injection).
      unwatch();
      socket.on('error', () => undefined);
      stash = ''; lines = []; replies.length = 0;
      const secure = tls.connect({ socket, ...tlsOptions() });
      socket = secure;
      watch(secure);
      await secured(secure);
      verify(secure);
      await command('EHLO chat-marks', [250], 'server_error');
    }
    if (options.inspectOnly) { socket.write('QUIT\r\n'); return report(); }
    await command('AUTH LOGIN', [334], 'auth_failed');
    await command(Buffer.from(message.username).toString('base64'), [334], 'auth_failed');
    await command(Buffer.from(message.password).toString('base64'), [235], 'auth_failed');
    await command(`MAIL FROM:<${message.from}>`, [250], 'sender_rejected');
    await command(`RCPT TO:<${message.to}>`, [250, 251], 'recipient_rejected');
    await command('DATA', [354], 'server_error');
    const safeBody = message.body.replace(/\r\n|\r|\n/g, '\n').split('\n').map(s => s.startsWith('.') ? `.${s}` : s).join('\r\n');
    socket.write(`From: <${message.from}>\r\nTo: <${message.to}>\r\nSubject: ${encodeHeader(message.subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(safeBody).toString('base64')}\r\n.\r\n`);
    await expect([250], 'server_error');
    socket.write('QUIT\r\n');
    return report();
  } catch (error) {
    if (error instanceof NotificationDeliveryError) throw error;
    throw deliveryFailure(transportCode(error));
  } finally {
    clearTimeout(connectTimer); clearTimeout(deadline);
    failed ??= deliveryFailure('connection_closed');
    socket.destroy();
  }
}
