import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/durable.js', () => ({
  readDurable: vi.fn(async () => null),
  writeDurableNow: vi.fn(async () => undefined)
}));
vi.mock('../src/main/notification-credentials.js', () => ({
  notificationCredentialPresence: vi.fn(async () => ({ smtp: true, telegram: true, 'whatsapp-cloud': true, 'whatsapp-evolution': true })),
  storeNotificationCredential: vi.fn(),
  withNotificationCredential: vi.fn(async (_channel, fn) => fn('synthetic-local-only-token')),
  requireNotificationReauthorization: vi.fn(async () => undefined)
}));
const smtp = vi.hoisted(() => ({ sendSmtp: vi.fn() }));
vi.mock('../src/main/notification-smtp.js', () => smtp);

import { notificationSettings, saveNotificationSettings, dispatchNotice } from '../src/main/notification-center.js';
import type { NotificationChannel, NotificationFailure } from '../src/shared/notification-center.js';
import { deliveryFailure, describeFailure, NotificationDeliveryError } from '../src/main/notification-failure.js';
import { httpFailureCode } from '../src/main/notification-center.js';

interface Received { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
const received: Received[] = [];
let server: http.Server;
let base = '';
let refusal: { status: number; body: unknown } | null = null;

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const piece of request) raw += piece.toString();
    received.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(raw) });
    response.writeHead(refusal?.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(refusal?.body ?? { ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fake server port');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function enable(channel: NotificationChannel): Promise<void> {
  const next = structuredClone(await notificationSettings());
  for (const c of Object.values(next.channels)) { c.enabled = false; c.destinations = []; }
  const selected = next.channels[channel];
  selected.enabled = true;
  selected.events['turn-completed'] = true;
  selected.destinations = ['5511999999999'];
  selected.titleTemplate = '{title}';
  selected.bodyTemplate = '{project} {excerpt}';
  switch (channel) {
    case 'telegram': selected.config = { apiBase: base }; break;
    case 'whatsapp-cloud': selected.config = { apiBase: `${base}/v23.0`, phoneId: '123456', template: 'synthetic_approved', parameters: 'title,body' }; break;
    case 'whatsapp-evolution': selected.config = { baseUrl: `${base}/v1/`, instance: 'synthetic' }; break;
    default: throw new Error('Only HTTP providers are tested here');
  }
  await saveNotificationSettings(next);
}

const notice = { event: 'turn-completed' as const, title: 'Synthetic finish', project: 'Test project', excerpt: 'PRIVATE SYNTHETIC EXCERPT' };
describe('real localhost HTTP provider emulators', () => {
  it('sends a Telegram Bot API request without the default-disabled excerpt', async () => {
    received.length = 0;
    await enable('telegram');
    expect(await dispatchNotice(notice, { channel: 'telegram', test: true })).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toContain('/botsynthetic-local-only-token/sendMessage');
    expect(received[0]?.body.chat_id).toBe('5511999999999');
    expect(JSON.stringify(received[0]?.body)).not.toContain(notice.excerpt);
  });

  it('sends Meta approved template messages with explicit parameters and bearer token', async () => {
    received.length = 0;
    await enable('whatsapp-cloud');
    expect(await dispatchNotice(notice, { channel: 'whatsapp-cloud', test: true })).toBe(1);
    expect(received[0]?.url).toBe('/v23.0/123456/messages');
    expect(received[0]?.headers.authorization).toBe('Bearer synthetic-local-only-token');
    expect(received[0]?.body.type).toBe('template');
    const template = received[0]?.body.template as { name: string; components: Array<{ parameters: Array<{ text: string }> }> };
    expect(template.name).toBe('synthetic_approved');
    expect(template.components[0]?.parameters.map(value => value.text)).toEqual(['Synthetic finish', 'Test project ']);
  });

  it('sends Evolution text without approval capabilities and handles a fake HTTP rejection', async () => {
    received.length = 0;
    await enable('whatsapp-evolution');
    expect(await dispatchNotice(notice, { channel: 'whatsapp-evolution', test: true })).toBe(1);
    expect(received[0]?.url).toBe('/v1/message/sendText/synthetic');
    expect(received[0]?.headers.apikey).toBe('synthetic-local-only-token');
    expect(received[0]?.body).toEqual({ number: '5511999999999', text: 'Synthetic finish\nTest project ' });
    refusal = { status: 401, body: { error: 'Unauthorized' } };
    try {
      expect(await failureOf(dispatchNotice(notice, { channel: 'whatsapp-evolution', test: true }))).toEqual({ code: 'invalid_token', httpStatus: 401, channel: 'whatsapp-evolution' });
    } finally { refusal = null; }
  });
});

async function failureOf(promise: Promise<unknown>): Promise<NotificationFailure> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(NotificationDeliveryError);
    // The error text holds the code only, never the token in the Telegram URL or the provider's text.
    expect(String(error)).not.toContain('synthetic-local-only-token');
    expect(String(error)).not.toContain('chat not found');
    return (error as NotificationDeliveryError).failure;
  }
  throw new Error('expected a delivery failure');
}

describe('classified provider refusals', () => {
  it.each([
    ['telegram', 401, { ok: false, error_code: 401, description: 'Unauthorized' }, 'invalid_token'],
    ['telegram', 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 'unknown_destination'],
    ['telegram', 403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 'unknown_destination'],
    ['telegram', 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' }, 'rate_limited'],
    ['telegram', 502, {}, 'http_server_error'],
    ['whatsapp-cloud', 401, { error: { code: 190, message: 'Invalid OAuth access token' } }, 'invalid_token'],
    ['whatsapp-cloud', 400, { error: { code: 131030, message: 'Recipient phone number not in allowed list' } }, 'unknown_destination'],
    ['whatsapp-cloud', 400, { error: { code: 130429, message: 'Rate limit hit' } }, 'rate_limited'],
    ['whatsapp-cloud', 400, { error: { code: 132001, message: 'Template does not exist' } }, 'http_client_error'],
    ['whatsapp-evolution', 400, { status: 400, response: { message: [{ exists: false, number: '5511999999999' }] } }, 'unknown_destination']
  ] as const)('%s HTTP %i -> %s', async (channel, status, body, code) => {
    await enable(channel);
    refusal = { status, body };
    try {
      expect(await failureOf(dispatchNotice(notice, { channel, test: true }))).toEqual({ code, httpStatus: status, channel });
    } finally { refusal = null; }
  });
  it('classifies an unreachable endpoint without echoing the URL', async () => {
    await enable('telegram');
    const fetcher = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); }) as typeof fetch;
    expect(await failureOf(dispatchNotice(notice, { channel: 'telegram', test: true, fetcher }))).toEqual({ code: 'connection_refused', channel: 'telegram' });
  });
  it('names an endpoint that is not HTTPS as incomplete configuration', async () => {
    const next = structuredClone(await notificationSettings());
    next.channels.telegram.destinations = ['1'];
    next.channels.telegram.config = { apiBase: 'http://api.example.com' };
    await saveNotificationSettings(next);
    expect(await failureOf(dispatchNotice(notice, { channel: 'telegram', test: true }))).toEqual({ code: 'config_incomplete', channel: 'telegram' });
  });
});

describe('SMTP channel wiring', () => {
  const pin = Array.from({ length: 32 }, () => 'AB').join(':');
  async function smtpChannel(config: Record<string, string>): Promise<void> {
    const next = structuredClone(await notificationSettings());
    next.channels.smtp.destinations = ['to@example.com'];
    next.channels.smtp.config = { host: 'mail.example.com', from: 'from@example.com', username: 'user', security: 'starttls', ...config };
    await saveNotificationSettings(next);
  }
  it('passes the pinned certificate to the SMTP client', async () => {
    await smtpChannel({ tlsFingerprint: pin });
    smtp.sendSmtp.mockResolvedValueOnce({ authorized: false, pinned: true });
    expect(await dispatchNotice(notice, { channel: 'smtp', test: true })).toBe(1);
    expect(smtp.sendSmtp).toHaveBeenLastCalledWith(expect.objectContaining({ pinnedFingerprint: pin, port: 587, security: 'starttls', password: 'synthetic-local-only-token' }));
  });
  it('tags SMTP failures with the channel and keeps their public detail', async () => {
    await smtpChannel({});
    const certificate = { fingerprint256: pin, names: ['marks3'], selfSigned: true };
    smtp.sendSmtp.mockRejectedValueOnce(deliveryFailure('tls_untrusted', { certificate }));
    expect(await failureOf(dispatchNotice(notice, { channel: 'smtp', test: true }))).toEqual({ code: 'tls_untrusted', certificate, channel: 'smtp' });
  });
  it('describes a failure for the log without secrets', () => {
    expect(describeFailure({ code: 'connect_timeout', channel: 'smtp', cloudflare: true })).toBe('smtp, connect_timeout, Cloudflare proxy address');
    expect(describeFailure({ code: 'auth_failed', channel: 'smtp', smtpCode: 535 })).toBe('smtp, auth_failed, SMTP 535');
  });
  it('classifies HTTP refusals without provider-specific text', () => {
    expect(httpFailureCode('telegram', 404, '{"ok":false,"description":"Not Found"}')).toBe('invalid_token');
    expect(httpFailureCode('whatsapp-evolution', 500, '')).toBe('http_server_error');
    expect(httpFailureCode('whatsapp-cloud', 403, '')).toBe('invalid_token');
  });
});
