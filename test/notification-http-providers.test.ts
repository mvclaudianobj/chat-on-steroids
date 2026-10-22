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
vi.mock('../src/main/notification-smtp.js', () => ({ sendSmtp: vi.fn() }));

import { notificationSettings, saveNotificationSettings, dispatchNotice } from '../src/main/notification-center.js';
import type { NotificationChannel } from '../src/shared/notification-center.js';

interface Received { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
const received: Received[] = [];
let server: http.Server;
let base = '';
let failure = false;

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const piece of request) raw += piece.toString();
    received.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(raw) });
    response.writeHead(failure ? 401 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: !failure }));
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
    failure = true;
    try {
      await expect(dispatchNotice(notice, { channel: 'whatsapp-evolution', test: true })).rejects.toThrow(/HTTP 401/);
    } finally { failure = false; }
  });
});
