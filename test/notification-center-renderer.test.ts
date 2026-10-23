import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Language } from '../src/renderer/i18n.js';
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS, NOTIFICATION_FAILURE_CODES, type NotificationCenterSettings, type NotificationFailure } from '../src/shared/notification-center.js';

const languages: Language[] = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<body><div id="notificationCenterStatus"></div><div id="notificationCenterSettings"></div></body>', { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
});
afterEach(() => { vi.unstubAllGlobals(); dom.window.close(); });

const FINGERPRINT = '6E:41:27:0A:BC:66:6B:87:94:3D:D1:34:B3:AF:AB:B6:4C:6F:E1:84:94:9B:42:34:C1:D5:30:C0:68:75:83:52';

it.each(languages)('explains every failure code in %s', async locale => {
  const { setLanguage } = await import('../src/renderer/i18n.js');
  const { notificationFailureMessage } = await import('../src/renderer/notification-center.js');
  setLanguage('en');
  const english = NOTIFICATION_FAILURE_CODES.map(code => notificationFailureMessage({ code }));
  const hint = notificationFailureMessage({ code: 'connect_timeout', cloudflare: true });
  setLanguage(locale);
  NOTIFICATION_FAILURE_CODES.forEach((code, index) => {
    const text = notificationFailureMessage({ code });
    expect(text.trim(), code).not.toBe('');
    expect(text).not.toMatch(/\{\d+\}/);
    if (locale !== 'en') expect(text, code).not.toBe(english[index]);
  });
  expect(new Set(english).size).toBe(english.length);
  const withHint = notificationFailureMessage({ code: 'connect_timeout', cloudflare: true });
  expect(withHint.length).toBeGreaterThan(notificationFailureMessage({ code: 'connect_timeout' }).length);
  expect(withHint).toContain('Cloudflare');
  if (locale === 'en') expect(hint).toContain('DNS-only record or the MX host');
  expect(notificationFailureMessage({ code: 'auth_failed', smtpCode: 535 })).toContain('535');
  expect(notificationFailureMessage({ code: 'rate_limited', httpStatus: 429 })).toContain('429');
  expect(notificationFailureMessage({ code: 'tls_untrusted', pinned: true })).not.toBe(notificationFailureMessage({ code: 'tls_untrusted' }));
});

function settings(): NotificationCenterSettings {
  const channel = () => ({ enabled: false, events: Object.fromEntries(NOTIFICATION_EVENTS.map(e => [e, false])) as never, destinations: [] as string[], titleTemplate: '{title}', bodyTemplate: '{project}', includeExcerpt: false, config: {} as Record<string, string> });
  const value = { channels: Object.fromEntries(NOTIFICATION_CHANNELS.map(c => [c, channel()])) as unknown as NotificationCenterSettings['channels'], throttleMinutes: 1, batchWindowSeconds: 10 };
  value.channels.smtp.destinations = ['to@example.com'];
  value.channels.smtp.config = { host: 'mail.example.com', port: '587', security: 'starttls', from: 'from@example.com' };
  return value;
}

it('offers to pin the presented certificate after an explicit confirmation and can remove the trust', async () => {
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('en');
  const { installNotificationCenter } = await import('../src/renderer/notification-center.js');
  const credentials = Object.fromEntries(NOTIFICATION_CHANNELS.map(c => [c, c === 'smtp'])) as never;
  const saves: NotificationCenterSettings[] = [];
  const failure: NotificationFailure = { code: 'tls_untrusted', channel: 'smtp', certificate: { fingerprint256: FINGERPRINT, names: ['marks3'], selfSigned: true } };
  const api = {
    notificationCenterGet: async () => ({ ok: true as const, data: { settings: settings(), credentials } }),
    notificationCenterSave: async (next: NotificationCenterSettings) => { saves.push(structuredClone(next)); return { ok: true as const, data: { settings: next, credentials } }; },
    notificationCenterTest: vi.fn(async () => ({ ok: false as const, error: 'Notification request failed. Check channel configuration and connection.', failure })),
    notificationCenterSetCredential: vi.fn(), notificationCenterExport: vi.fn(), notificationCenterImport: vi.fn(), vault: vi.fn()
  };
  installNotificationCenter(api as never);
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  await vi.waitFor(() => expect($('notificationTest-smtp')).not.toBeNull());
  expect($('notificationTrustCertificate')).toBeNull();
  $('notificationTest-smtp')!.click();
  await vi.waitFor(() => expect($('notificationTrustCertificate')).not.toBeNull());
  const card = document.querySelector('.notification-trust')!;
  expect(card.textContent).toContain(FINGERPRINT);
  expect(card.textContent).toContain('marks3');
  expect(card.textContent).toContain('Self-signed certificate.');
  expect(document.querySelector('[id="notificationTitle-smtp"]')!.closest('section')!.textContent).toContain('The server certificate is not trusted');

  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  const before = saves.length;
  $('notificationTrustCertificate')!.click();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining(FINGERPRINT));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(saves.length).toBe(before);

  confirm.mockReturnValue(true);
  $('notificationTrustCertificate')!.click();
  await vi.waitFor(() => expect(saves.at(-1)?.channels.smtp.config.tlsFingerprint).toBe(FINGERPRINT));
  await vi.waitFor(() => expect($('notificationRemoveTrust')).not.toBeNull());
  expect($('notificationTrustCertificate')).toBeNull();
  expect(document.querySelector('.notification-trust')!.textContent).toContain('Trusted server certificate');

  $('notificationRemoveTrust')!.click();
  await vi.waitFor(() => expect(saves.at(-1)?.channels.smtp.config).not.toHaveProperty('tlsFingerprint'));
  await vi.waitFor(() => expect($('notificationRemoveTrust')).toBeNull());
});

it('shows WhatsApp setup failures without suggesting a Telegram bot token', async () => {
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('pt-BR');
  const { installNotificationCenter } = await import('../src/renderer/notification-center.js');
  const credentials = Object.fromEntries(NOTIFICATION_CHANNELS.map(c => [c, false])) as never;
  const api = {
    notificationCenterGet: async () => ({ ok: true as const, data: { settings: settings(), credentials } }),
    notificationWhatsAppStart: vi.fn(async () => ({ ok: false as const, error: 'Internal synthetic sensitive path', setupCode: 'storage_unavailable', setupStage: 'storage' })),
    notificationWhatsAppStatus: vi.fn(), notificationWhatsAppDisconnect: vi.fn(),
    notificationTelegramPairStart: vi.fn(async () => ({ ok: false as const, error: 'synthetic failure' })),
    notificationTelegramPairCheck: vi.fn(), notificationTelegramPairCancel: vi.fn(),
    notificationCenterSave: vi.fn(), notificationCenterTest: vi.fn(), notificationCenterSetCredential: vi.fn(),
    notificationCenterExport: vi.fn(), notificationCenterImport: vi.fn(), vault: vi.fn()
  };
  installNotificationCenter(api as never);
  await vi.waitFor(() => expect(document.getElementById('notificationPair-whatsapp-web')).not.toBeNull());
  document.getElementById('notificationPair-whatsapp-web')!.click();
  const whatsapp = document.getElementById('notificationTitle-whatsapp-web')!.closest('section')!;
  await vi.waitFor(() => expect(whatsapp.textContent).toContain('permissões da pasta'));
  expect(whatsapp.textContent).not.toContain('token salvo do bot');
  expect(whatsapp.textContent).not.toContain('sensitive');
  expect(whatsapp.textContent).toContain('WA-storage_unavailable / storage');
  document.getElementById('notificationPair-telegram')!.click();
  const telegram = document.getElementById('notificationTitle-telegram')!.closest('section')!;
  await vi.waitFor(() => expect(telegram.textContent).toContain('token salvo do bot'));
});

it('ignores a late WhatsApp status response from before a manual retry', async () => {
  const { setLanguage } = await import('../src/renderer/i18n.js');
  const { installNotificationCenter } = await import('../src/renderer/notification-center.js');
  setLanguage('en');
  let poll: (() => void) | undefined;
  const realSetInterval = globalThis.setInterval;
  vi.stubGlobal('setInterval', (_callback: () => void) => { poll = _callback; return 77; });
  let finishOldPoll: (value: unknown) => void = () => undefined;
  const oldPoll = new Promise(resolve => { finishOldPoll = resolve; });
  const credentials = Object.fromEntries(NOTIFICATION_CHANNELS.map(channel => [channel, false]));
  const api = {
    notificationCenterGet: async () => ({ ok: true, data: { settings: settings(), credentials } }),
    notificationWhatsAppStart: vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { state: 'connecting', stage: 'network' } })
      .mockResolvedValueOnce({ ok: false, setupCode: 'storage_unavailable', setupStage: 'storage' }),
    notificationWhatsAppStatus: vi.fn(() => oldPoll),
    notificationWhatsAppDisconnect: vi.fn(), notificationTelegramPairStart: vi.fn(),
    notificationTelegramPairCheck: vi.fn(), notificationTelegramPairCancel: vi.fn(),
    notificationCenterSave: vi.fn(), notificationCenterTest: vi.fn(), notificationCenterSetCredential: vi.fn(),
    notificationCenterExport: vi.fn(), notificationCenterImport: vi.fn(), vault: vi.fn()
  };
  try {
    installNotificationCenter(api as never);
    await vi.waitFor(() => expect(document.getElementById('notificationPair-whatsapp-web')).not.toBeNull());
    const button = document.getElementById('notificationPair-whatsapp-web')!;
    const card = document.getElementById('notificationTitle-whatsapp-web')!.closest('section')!;
    button.click();
    await vi.waitFor(() => expect(poll).toBeTypeOf('function'));
    poll!();
    await vi.waitFor(() => expect(api.notificationWhatsAppStatus).toHaveBeenCalledTimes(1));
    button.click();
    await vi.waitFor(() => expect(card.textContent).toContain('WA-storage_unavailable / storage'));
    finishOldPoll({ ok: true, data: { state: 'connected', stage: 'ready' } });
    await new Promise(resolve => realSetInterval(() => resolve(undefined), 1));
    expect(card.textContent).toContain('WA-storage_unavailable / storage');
  } finally { vi.unstubAllGlobals(); }
});
