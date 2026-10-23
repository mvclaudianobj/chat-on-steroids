import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ secret: 'synthetic-test-token', snapshot: null as unknown }));
vi.mock('../src/main/notification-credentials.js', () => ({
  notificationCredentialPresence: vi.fn(async () => ({ smtp: true, telegram: true, 'whatsapp-cloud': true, 'whatsapp-evolution': true })),
  storeNotificationCredential: vi.fn(async (_channel, value) => { state.secret = value; }),
  withNotificationCredential: vi.fn(async (_channel, fn) => fn(state.secret)),
  requireNotificationReauthorization: vi.fn(async () => undefined)
}));
vi.mock('../src/main/durable.js', () => ({ readDurable: vi.fn(async () => state.snapshot), writeDurableNow: vi.fn(async (_key, next) => { state.snapshot = next; }) }));
vi.mock('../src/main/notification-smtp.js', () => ({ sendSmtp: vi.fn(async () => undefined) }));
vi.mock('../src/main/notification-whatsapp-web.js', () => ({ sendWhatsAppWeb: vi.fn(async () => { throw new Error('synthetic disconnected socket'); }) }));
import { dispatchNotice, notificationSettings, saveNotificationSettings, setNotificationCredential } from '../src/main/notification-center.js';
import { sendSmtp } from '../src/main/notification-smtp.js';
import { sendWhatsAppWeb } from '../src/main/notification-whatsapp-web.js';

const event = { event: 'turn-completed' as const, title: 'Finished', project: 'Synthetic project', excerpt: 'Synthetic private conversation' };
describe('notification center outbound channels', () => {
  beforeEach(() => { vi.clearAllMocks(); state.secret = 'synthetic-test-token'; });
  it('migrates saved 2.1.45 settings by adding disabled WhatsApp Web', async () => {
    const settings = structuredClone(await notificationSettings());
    settings.channels.telegram.destinations = ['original-id'];
    delete (settings.channels as Partial<typeof settings.channels>)['whatsapp-web'];
    const result = await saveNotificationSettings(settings);
    expect(result.settings.channels.telegram.destinations).toEqual(['original-id']);
    expect(result.settings.channels['whatsapp-web'].enabled).toBe(false);
    expect(result.settings.channels['whatsapp-web'].destinations).toEqual([]);
  });
  it('reports a disconnected WhatsApp socket without a misleading SMTP/TLS error or duplicate delivery', async () => {
    const settings = structuredClone(await notificationSettings());
    for (const channel of Object.values(settings.channels)) channel.enabled = false;
    settings.channels['whatsapp-web'] = {
      ...settings.channels['whatsapp-web'], enabled: true,
      events: { ...settings.channels['whatsapp-web'].events, 'turn-completed': true },
      destinations: ['5511999999999']
    };
    await saveNotificationSettings(settings);
    await expect(dispatchNotice(event, { now: 110000 })).rejects.toMatchObject({ failure: { code: 'whatsapp_disconnected', channel: 'whatsapp-web' } });
    expect(sendWhatsAppWeb).toHaveBeenCalledTimes(1);
    expect(sendSmtp).not.toHaveBeenCalled();
  });
  it('uses per-channel events and excludes chat excerpts by default', async () => {
    const settings = structuredClone(await notificationSettings());
    settings.channels.telegram = { ...settings.channels.telegram, enabled: true, events: { ...settings.channels.telegram.events, 'turn-completed': true }, destinations: ['1234', '2345'], titleTemplate: '{title}', bodyTemplate: '{project} {excerpt}' };
    await saveNotificationSettings(settings);
    const calls: Array<{ url: string; body: string }> = [];
    const fetcher = vi.fn(async (url, opts) => { calls.push({ url: String(url), body: String(opts.body) }); return { ok: true } as Response; });
    expect(await dispatchNotice(event, { fetcher: fetcher as unknown as typeof fetch, now: 100000 })).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.every(item => !item.body.includes('Synthetic private conversation'))).toBe(true);
    expect(calls[0]?.url).toContain('sendMessage');
    expect(await dispatchNotice(event, { fetcher: fetcher as unknown as typeof fetch, now: 100001 })).toBe(0);
  });
  it('uses bearer header for Meta and an apikey header for Evolution', async () => {
    const settings = structuredClone(await notificationSettings());
    settings.channels.telegram.enabled = false;
    settings.channels['whatsapp-cloud'] = { ...settings.channels['whatsapp-cloud'], enabled: true, events: { ...settings.channels['whatsapp-cloud'].events, 'turn-completed': true }, destinations: ['5511999999999'], config: { phoneId: '123456', template: 'synthetic_notice' } };
    settings.channels['whatsapp-evolution'] = { ...settings.channels['whatsapp-evolution'], enabled: true, events: { ...settings.channels['whatsapp-evolution'].events, 'turn-completed': true }, destinations: ['5511999999999'], config: { baseUrl: 'http://127.0.0.1:4000/', instance: 'synthetic' } };
    await saveNotificationSettings(settings);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = vi.fn(async (url, opts) => { calls.push({ url: String(url), headers: opts.headers }); return { ok: true } as Response; });
    expect(await dispatchNotice(event, { fetcher: fetcher as unknown as typeof fetch, now: 500000 })).toBe(2);
    expect(calls[0]?.headers.Authorization).toBe('Bearer synthetic-test-token');
    expect(calls[1]?.headers.apikey).toBe('synthetic-test-token');
    expect(calls[1]?.url).toContain('message/sendText/synthetic');
  });
  it('routes SMTP using the encrypted credential API and disallows arbitrary config keys', async () => {
    const settings = structuredClone(await notificationSettings());
    settings.channels.telegram.enabled = false;
    settings.channels['whatsapp-cloud'].enabled = false;
    settings.channels['whatsapp-evolution'].enabled = false;
    settings.channels.smtp = { ...settings.channels.smtp, enabled: true, events: { ...settings.channels.smtp.events, 'turn-completed': true }, destinations: ['example@example.org'], config: { host: 'localhost', port: '587', security: 'starttls', from: 'sender@example.org', username: 'synthetic' } };
    await saveNotificationSettings(settings);
    expect(await dispatchNotice(event, { now: 800000 })).toBe(1);
    expect(vi.mocked(sendSmtp)).toHaveBeenCalledWith(expect.objectContaining({ password: 'synthetic-test-token', security: 'starttls' }));
    await setNotificationCredential('smtp', 'replacement-synthetic', 'synthetic-master-password');
    expect(state.secret).toBe('replacement-synthetic');
    settings.channels.smtp.config.password = 'forbidden';
    expect(() => saveNotificationSettings(settings)).toThrow();
  });
});
