/** Classified, non-secret notification delivery failures. */
import net from 'node:net';
import type { NotificationFailure, NotificationFailureCode } from '../shared/notification-center.js';

export class NotificationDeliveryError extends Error {
  readonly failure: NotificationFailure;
  constructor(failure: NotificationFailure) {
    // The message carries the code only: it reaches logs and must never hold provider text.
    super(`Notification delivery failed (${failure.code})`);
    this.name = 'NotificationDeliveryError';
    this.failure = failure;
  }
}
export const deliveryFailure = (code: NotificationFailureCode, extra: Omit<NotificationFailure, 'code'> = {}): NotificationDeliveryError =>
  new NotificationDeliveryError({ code, ...extra });

/**
 * Cloudflare's published proxy ranges (https://www.cloudflare.com/ips-v4 and /ips-v6). A proxied
 * ("orange cloud") record only carries HTTP(S), so an SMTP host that resolves here never answers.
 */
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32'
] as const;
const cloudflare = new net.BlockList();
for (const range of CLOUDFLARE_RANGES) {
  const [network, prefix] = range.split('/') as [string, string];
  cloudflare.addSubnet(network, Number(prefix), network.includes(':') ? 'ipv6' : 'ipv4');
}
export function isCloudflareAddress(address: string): boolean {
  const family = net.isIP(address);
  return family !== 0 && cloudflare.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Maps a Node socket/DNS/TLS error (also a fetch error's `cause`) to a failure code. */
export function networkFailureCode(error: unknown): NotificationFailureCode {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = String((current as { code?: unknown }).code ?? '');
    if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA', 'EAI_FAIL'].includes(code)) return 'dns_failed';
    if (code === 'ECONNREFUSED') return 'connection_refused';
    if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return 'connect_timeout';
    if (['EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(code)) return 'network_unreachable';
    if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return 'connection_closed';
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls_hostname_mismatch';
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) return 'tls_untrusted';
    if ((current as { name?: unknown }).name === 'AbortError' || (current as { name?: unknown }).name === 'TimeoutError') return 'server_timeout';
    current = (current as { cause?: unknown }).cause;
  }
  return 'unknown';
}

/** Any thrown value as a failure; unclassified errors become `unknown` without their text. */
export function failureOf(error: unknown): NotificationFailure {
  if (error instanceof NotificationDeliveryError) return error.failure;
  return { code: networkFailureCode(error) };
}

/** One log-safe phrase: the code and its numeric context, never text from the provider. */
export function describeFailure(failure: NotificationFailure): string {
  return [
    failure.channel, failure.code,
    failure.smtpCode ? `SMTP ${failure.smtpCode}` : '', failure.httpStatus ? `HTTP ${failure.httpStatus}` : '',
    failure.cloudflare ? 'Cloudflare proxy address' : '', failure.pinned ? 'pinned certificate differs' : '',
    failure.certificate ? `certificate SHA-256 ${failure.certificate.fingerprint256}` : ''
  ].filter(Boolean).join(', ');
}
