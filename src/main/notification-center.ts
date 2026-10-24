/** Outbound notification channels. The renderer never reads credentials or message excerpts. */
import { z } from 'zod';
import { readDurable, writeDurableNow } from './durable.js';
import { notificationCredentialPresence, storeNotificationCredential, withNotificationCredential, requireNotificationReauthorization } from './notification-credentials.js';
import { CERTIFICATE_FINGERPRINT, NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS, type NotificationChannel, type NotificationEvent, type NotificationCenterSettings, type NotificationCenterView, type NotificationFailureCode } from '../shared/notification-center.js';
import { sendWhatsAppWeb } from './notification-whatsapp-web.js';
import { sendSmtp } from './notification-smtp.js';
import { deliveryFailure, describeFailure, failureOf, networkFailureCode, NotificationDeliveryError } from './notification-failure.js';
import { logInfo, logWarn } from './logger.js';

const STATE = 'marks-notification-center';
const DEFAULT_EVENTS = Object.fromEntries(NOTIFICATION_EVENTS.map(e => [e, false])) as Record<NotificationEvent, boolean>;
const channelSchema = z.object({
  enabled: z.boolean(),
  events: z.object(Object.fromEntries(NOTIFICATION_EVENTS.map(e => [e, z.boolean()])) as Record<NotificationEvent, z.ZodBoolean>).strict(),
  destinations: z.array(z.string().trim().min(1).max(254)).max(20),
  titleTemplate: z.string().max(300), bodyTemplate: z.string().max(1000),
  includeExcerpt: z.boolean(), config: z.record(z.string().max(64), z.string().max(700)).refine(v => Object.keys(v).length <= 16)
}).strict();
const schema = z.object({
  channels: z.object(Object.fromEntries(NOTIFICATION_CHANNELS.map(c => [c, channelSchema])) as Record<NotificationChannel, typeof channelSchema>).strict(),
  throttleMinutes: z.number().int().min(0).max(1440), batchWindowSeconds: z.number().int().min(0).max(300)
}).strict();
const defaultChannel = () => ({ enabled: false, events: { ...DEFAULT_EVENTS }, destinations: [], titleTemplate: '{title}', bodyTemplate: '{project} — {event}', includeExcerpt: false, config: {} });
const defaults = (): NotificationCenterSettings => ({ channels: {
  smtp: defaultChannel(), telegram: defaultChannel(), 'whatsapp-web': defaultChannel(), 'whatsapp-cloud': defaultChannel(), 'whatsapp-evolution': defaultChannel()
}, throttleMinutes: 1, batchWindowSeconds: 10 });
let saved: NotificationCenterSettings | null = null;
let loadInFlight: Promise<NotificationCenterSettings> | null = null;
let queue: Promise<void> = Promise.resolve();
export async function notificationSettings(): Promise<NotificationCenterSettings> {
  if (saved) return saved;
  if (loadInFlight) return loadInFlight;
  const load = (async () => {
    let loaded: NotificationCenterSettings;
    try { loaded = checkSettings(await readDurable<unknown>(STATE)); }
    catch { loaded = defaults(); }
    return saved ?? (saved = loaded);
  })();
  loadInFlight = load;
  try { return await load; }
  finally { if (loadInFlight === load) loadInFlight = null; }
}
export async function notificationView(): Promise<NotificationCenterView> {
  return { settings: await notificationSettings(), credentials: await notificationCredentialPresence() };
}
function checkSettings(value: unknown): NotificationCenterSettings {
  // Existing 2.1.45 files predate local WhatsApp. Add the disabled channel without losing saved preferences.
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const channels = input.channels && typeof input.channels === 'object' && !Array.isArray(input.channels) ? input.channels as Record<string, unknown> : {};
  const migrated = Object.hasOwn(channels, 'whatsapp-web') ? value : { ...input, channels: { ...channels, 'whatsapp-web': defaultChannel() } };
  const settings = schema.parse(migrated);
  for (const channel of NOTIFICATION_CHANNELS) {
    const { config, destinations } = settings.channels[channel];
    // Never accept arbitrary keys that could be mistaken for credentials in the durable settings.
    const names: Record<NotificationChannel, string[]> = {
      smtp: ['host', 'port', 'username', 'from', 'security', 'tlsFingerprint'], telegram: ['apiBase'], 'whatsapp-web': [],
      'whatsapp-cloud': ['apiBase', 'phoneId', 'template', 'language', 'parameters'], 'whatsapp-evolution': ['baseUrl', 'instance']
    };
    for (const k of Object.keys(config)) if (!names[channel].includes(k)) throw new Error('Unsupported channel setting');
    if (channel === 'smtp' && config.security && !['tls', 'starttls'].includes(config.security)) throw new Error('SMTP requires TLS or STARTTLS');
    // A pinned certificate is public data, but only the exact SHA-256 form is ever accepted.
    if (channel === 'smtp' && config.tlsFingerprint && !CERTIFICATE_FINGERPRINT.test(config.tlsFingerprint)) throw new Error('Invalid pinned certificate fingerprint');
    if (channel === 'whatsapp-cloud' && config.parameters) {
      const parameters = config.parameters.split(',').map(part => part.trim());
      if (parameters.length > 10 || parameters.some(part => !['title', 'body', 'project', 'event', 'excerpt'].includes(part))) throw new Error('Unsupported Meta template parameter');
    }
    if (destinations.length !== new Set(destinations).size) throw new Error('Duplicate destination');
  }
  return settings;
}
export function saveNotificationSettings(value: unknown): Promise<NotificationCenterView> {
  const next = checkSettings(value);
  const run = queue.then(async () => {
    await notificationSettings();
    await writeDurableNow(STATE, next);
    saved = next;
  });
  queue = run.catch(() => undefined);
  return run.then(notificationView);
}
export async function setNotificationCredential(channel: NotificationChannel, credential: string, masterPassword: string): Promise<NotificationCenterView> {
  if (!NOTIFICATION_CHANNELS.includes(channel)) throw new Error('Unknown channel');
  if (credential.length > 4096) throw new Error('Credential too long');
  await storeNotificationCredential(channel, credential, masterPassword);
  return notificationView();
}

export async function importNotificationSettings(value: unknown): Promise<NotificationCenterView> {
  const settings = checkSettings(value);
  // Revoke old credentials before any imported active channel becomes visible.
  await requireNotificationReauthorization();
  return saveNotificationSettings(settings);
}

export interface OutboundNotice { event: NotificationEvent; title: string; project: string; excerpt?: string; }
const lastSent = new Map<string, number>();
const counts = new Map<string, { at: number; count: number }>();
const inFlight = new Set<string>();
const LIMIT_PER_HOUR = 30;
/** Single bounded aggregation owner for bursts of many simultaneous turn completions. */
const batches = new Map<NotificationEvent, { notices: OutboundNotice[]; timer: ReturnType<typeof setTimeout> }>();
export async function queueOutboundNotice(notice: OutboundNotice): Promise<void> {
  const windowSeconds = (await notificationSettings()).batchWindowSeconds;
  if (!windowSeconds) { await dispatchNotice(notice); return; }
  const current = batches.get(notice.event);
  if (current) {
    if (current.notices.length < 100) current.notices.push(notice);
    return;
  }
  const entry = { notices: [notice], timer: setTimeout(() => {
    batches.delete(notice.event);
    const count = entry.notices.length;
    const payload = count === 1 ? entry.notices[0]! : {
      event: notice.event,
      title: `${count} Chat Marks events`, project: 'Chat Marks'
    };
    void dispatchNotice(payload).catch(error => logWarn(`Notification ${notice.event}: delivery failed (${describeFailure(failureOf(error))})`));
  }, windowSeconds * 1000) };
  entry.timer.unref();
  batches.set(notice.event, entry);
}
function fill(pattern: string, values: Record<string, string>): string {
  return pattern.replace(/\{(title|project|event|excerpt)\}/g, (_, k: string) => values[k] ?? '').slice(0, 1200);
}
async function postJson(channel: NotificationChannel, url: string, headers: Record<string, string>, body: unknown, fetcher: typeof fetch): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let response: Response;
    try { response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal }); }
    catch (error) {
      const code = networkFailureCode(error);
      // Fetch errors may carry the endpoint URL (Telegram's holds the token): only the code leaves.
      throw deliveryFailure(code === 'unknown' ? 'connection_closed' : code);
    }
    if (!response.ok) {
      const text = await response.text().then(value => value.slice(0, 4096), () => '');
      throw deliveryFailure(httpFailureCode(channel, response.status, text), { httpStatus: response.status });
    }
  } finally { clearTimeout(timeout); }
}
/** Classifies a provider's HTTP refusal; the response text is read here only and never kept. */
export function httpFailureCode(channel: NotificationChannel, status: number, text: string): NotificationFailureCode {
  if (status === 429) return 'rate_limited';
  let metaCode = 0;
  try { metaCode = Number((JSON.parse(text) as { error?: { code?: unknown } }).error?.code ?? 0); } catch { /* not JSON */ }
  if (channel === 'telegram') {
    if (status === 401 || status === 404) return 'invalid_token';
    if ((status === 400 || status === 403) && /chat not found|user not found|bot was blocked|bot was kicked|PEER_ID_INVALID|chat_id is empty|not a member|have no rights/i.test(text)) return 'unknown_destination';
  } else if (channel === 'whatsapp-cloud') {
    if (metaCode === 190 || status === 401) return 'invalid_token';
    if ([4, 80007, 130429, 131048, 131056].includes(metaCode)) return 'rate_limited';
    if ([131026, 131030, 131021, 133010].includes(metaCode)) return 'unknown_destination';
  } else if (channel === 'whatsapp-evolution') {
    if (status === 401 || status === 403) return 'invalid_token';
    if ((status === 400 || status === 404) && /"exists"\s*:\s*false|not exists?|does not exist/i.test(text)) return 'unknown_destination';
  }
  if (status === 401 || status === 403) return 'invalid_token';
  return status >= 500 ? 'http_server_error' : 'http_client_error';
}
function secureBase(base: string, fallback: string): URL {
  let url: URL;
  try { url = new URL(base || fallback); } catch { throw deliveryFailure('config_incomplete'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw deliveryFailure('config_incomplete');
  if (url.username || url.password || url.search || url.hash) throw deliveryFailure('config_incomplete');
  return url;
}
export async function dispatchNotice(notice: OutboundNotice, options: { channel?: NotificationChannel; fetcher?: typeof fetch; now?: number; test?: boolean } = {}): Promise<number> {
  const settings = await notificationSettings();
  const now = options.now ?? Date.now();
  const fetcher = options.fetcher ?? fetch;
  let delivered = 0;
  for (const channel of NOTIFICATION_CHANNELS) {
    if (options.channel && options.channel !== channel) continue;
    const choice = settings.channels[channel];
    if (!options.test && !choice.enabled) { logInfo(`Notification ${channel}: skipped ${notice.event} (channel disabled)`); continue; }
    if (!options.test && !choice.events[notice.event]) { logInfo(`Notification ${channel}: skipped ${notice.event} (event unsubscribed)`); continue; }
    if (!choice.destinations.length) { logInfo(`Notification ${channel}: skipped ${notice.event} (no destinations)`); continue; }
    const fingerprint = `${channel}:${notice.event}`;
    if (!options.test && inFlight.has(fingerprint)) continue;
    const bucket = counts.get(channel);
    if (!options.test && bucket && now - bucket.at < 3600000 && bucket.count + choice.destinations.length > LIMIT_PER_HOUR) {
      logInfo(`Notification ${channel}: skipped ${notice.event} (hourly limit)`);
      continue;
    }
    if (!options.test && now - (lastSent.get(fingerprint) ?? -Infinity) < settings.throttleMinutes * 60000) {
      logInfo(`Notification ${channel}: skipped ${notice.event} (throttled)`);
      continue;
    }
    if (!options.test) inFlight.add(fingerprint);
    try {
    const values = { title: notice.title.slice(0, 180), project: notice.project.slice(0, 160), event: notice.event, excerpt: choice.includeExcerpt ? (notice.excerpt ?? '').slice(0, 160) : '' };
    const title = fill(choice.titleTemplate, values);
    const body = fill(choice.bodyTemplate, values);
    const cfg = choice.config;
    if (channel !== 'whatsapp-web' && !(await notificationCredentialPresence())[channel]) throw deliveryFailure('credential_missing', { channel });
    let reachedProvider = false;
    try {
    const deliver = async (secret: string) => {
    reachedProvider = true;
    if (channel === 'smtp') {
      if (!cfg.host || !cfg.from) throw deliveryFailure('config_incomplete');
      for (const to of choice.destinations) {
        await sendSmtp({ host: cfg.host, port: Number(cfg.port || (cfg.security === 'tls' ? 465 : 587)), security: cfg.security === 'tls' ? 'tls' : 'starttls', username: cfg.username ?? '', password: secret, from: cfg.from, to, subject: title, body, ...(cfg.tlsFingerprint ? { pinnedFingerprint: cfg.tlsFingerprint } : {}) });
        delivered++;
      }
    } else if (channel === 'telegram') {
      const base = secureBase(cfg.apiBase ?? '', 'https://api.telegram.org');
      for (const chat_id of choice.destinations) {
        const url = new URL(`/bot${encodeURIComponent(secret)}/sendMessage`, base);
        await postJson(channel, url.toString(), {}, { chat_id, text: `${title}\n${body}` }, fetcher); delivered++;
      }
    } else if (channel === 'whatsapp-web') {
      for (const number of choice.destinations) {
        try { await sendWhatsAppWeb(number, `${title}\n${body}`); }
        catch { throw deliveryFailure('whatsapp_disconnected'); }
        delivered++;
      }
    } else if (channel === 'whatsapp-cloud') {
      if (!cfg.phoneId || !/^\d{3,30}$/.test(cfg.phoneId) || !cfg.template) throw deliveryFailure('config_incomplete');
      const base = secureBase(cfg.apiBase ?? '', 'https://graph.facebook.com');
      const parameters = (cfg.parameters || '').split(',').map(part => part.trim()).filter(Boolean);
      const template = {
        name: cfg.template,
        language: { code: cfg.language || 'pt_BR' },
        ...(parameters.length ? { components: [{ type: 'body', parameters: parameters.map(name => ({ type: 'text', text: ({ ...values, body } as Record<string, string>)[name] ?? '' })) }] } : {})
      };
      for (const to of choice.destinations) {
        const version = /^\/v\d+\.\d+\/?$/.test(base.pathname) ? base.pathname.replace(/\/$/, '') : '/v22.0';
        if (base.pathname !== '/' && !/^\/v\d+\.\d+\/?$/.test(base.pathname)) throw deliveryFailure('config_incomplete');
        const url = new URL(`${version}/${cfg.phoneId}/messages`, base.origin);
        await postJson(channel, url.toString(), { Authorization: `Bearer ${secret}` }, { messaging_product: 'whatsapp', to, type: 'template', template }, fetcher); delivered++;
      }
    } else {
      if (!cfg.baseUrl || !cfg.instance) throw deliveryFailure('config_incomplete');
      const base = secureBase(cfg.baseUrl, 'https://localhost');
      for (const number of choice.destinations) {
        const url = new URL(`message/sendText/${encodeURIComponent(cfg.instance)}`, base.toString().replace(/\/?$/, '/'));
        await postJson(channel, url.toString(), { apikey: secret }, { number, text: `${title}\n${body}` }, fetcher); delivered++;
      }
    }
    };
    if (channel === 'whatsapp-web') await deliver('');
    else await withNotificationCredential(channel, deliver);
    } catch (error) {
      if (error instanceof NotificationDeliveryError) throw new NotificationDeliveryError({ ...error.failure, channel });
      // Before the callback ran, Vault K could not open the stored credential.
      throw deliveryFailure(reachedProvider ? networkFailureCode(error) : 'credential_unavailable', { channel });
    }
    if (!options.test && delivered) {
      lastSent.set(fingerprint, now);
      counts.set(channel, { at: bucket && now - bucket.at < 3600000 ? bucket.at : now, count: (bucket && now - bucket.at < 3600000 ? bucket.count : 0) + choice.destinations.length });
    }
    logInfo(`Notification ${channel}: ${options.test ? 'test' : notice.event} sent to ${choice.destinations.length} destination(s)`);
    } finally {
      if (!options.test) inFlight.delete(fingerprint);
    }
  }
  return delivered;
}
export async function testNotificationChannel(channel: NotificationChannel): Promise<{ delivered: number }> {
  return { delivered: await dispatchNotice({ event: 'turn-completed', title: 'Chat Marks test', project: 'Chat Marks' }, { channel, test: true }) };
}
