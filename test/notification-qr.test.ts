import { beforeEach, describe, expect, it, vi } from 'vitest';
const provider = vi.hoisted(() => ({ token: 'synthetic-token', calls: [] as Array<{ method: string; params: unknown }>, updates: [] as unknown[] }));
vi.mock('../src/main/notification-credentials.js', () => ({ withNotificationCredential: vi.fn(async (_channel, callback) => callback(provider.token)) }));
vi.mock('../src/main/notification-center.js', () => {
  const settings = { channels: { telegram: { destinations: [] as string[] } } };
  return { notificationSettings: vi.fn(async () => settings), saveNotificationSettings: vi.fn(async next => { settings.channels.telegram.destinations = next.channels.telegram.destinations; }) };
});
import { startTelegramPairing, checkTelegramPairing, cancelTelegramPairing } from '../src/main/notification-telegram-pair.js';
import { notificationSettings } from '../src/main/notification-center.js';

beforeEach(() => {
  provider.calls = [];
  provider.updates = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    expect(url).toContain('/botsynthetic-token/');
    const method = url.split('/').at(-1)!;
    const params = JSON.parse(init.body);
    provider.calls.push({ method, params });
    return { ok: true, json: async () => ({ ok: true, result: method === 'getMe' ? { username: 'synthetic_bot' } : provider.updates }) };
  }));
});

describe('Telegram QR one-time pairing with fake Bot API', () => {
  it('saves only the correct private-chat /start code, once', async () => {
    const { url, expires } = await startTelegramPairing();
    expect(url).toMatch(/^https:\/\/t\.me\/synthetic_bot\?start=[A-Za-z0-9_-]{24}$/);
    expect(expires).toBeGreaterThan(Date.now());
    const code = new URL(url).searchParams.get('start');
    provider.updates = [
      { update_id: 1, message: { text: `/start ${code}`, chat: { id: 111, type: 'group' } } },
      { update_id: 2, message: { text: '/start wrong', chat: { id: 222, type: 'private' } } }
    ];
    expect(await checkTelegramPairing()).toEqual({ state: 'pending' });
    provider.updates = [{ update_id: 3, message: { text: `/start ${code}`, chat: { id: 333, type: 'private' } } }];
    expect(await checkTelegramPairing()).toEqual({ state: 'paired', chatId: '333' });
    expect((await notificationSettings()).channels.telegram.destinations).toEqual(['333']);
    expect(await checkTelegramPairing()).toEqual({ state: 'expired' });
    expect(provider.calls.filter(c => c.method === 'getUpdates')[1]?.params).toMatchObject({ offset: 3 });
    expect(JSON.stringify(provider.calls)).not.toContain('synthetic-token');
  });
  it('cancels a pending code immediately', async () => {
    await startTelegramPairing();
    cancelTelegramPairing();
    expect(await checkTelegramPairing()).toEqual({ state: 'expired' });
  });
});


it('generates a real PNG QR from a synthetic pairing link without pairing a phone', async () => {
  const QRCode = (await import('qrcode')).default;
  const png = await QRCode.toDataURL('https://t.me/synthetic_bot?start=synthetic-only-code');
  expect(png).toMatch(/^data:image\/png;base64,/);
  const bytes = Buffer.from(png.split(',')[1]!, 'base64');
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.length).toBeGreaterThan(100);
});
