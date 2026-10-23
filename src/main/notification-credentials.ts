/** Notification credentials are owned by Vault K, not the legacy secrets.bin entries. */
import { z } from 'zod';
import { readDurable, writeDurableNow } from './durable.js';
import { listVault, putVault, useVault } from './marks-vault.js';
import { NOTIFICATION_CHANNELS, type NotificationChannel } from '../shared/notification-center.js';

const ACTIVE_RECORD = 'marks-notification-credential-activation';
const activationSchema = z.object({
  smtp: z.boolean(), telegram: z.boolean(),
  'whatsapp-web': z.boolean(), 'whatsapp-cloud': z.boolean(), 'whatsapp-evolution': z.boolean()
}).strict();
type Activation = Record<NotificationChannel, boolean>;
const disabled = (): Activation => ({ smtp: false, telegram: false, 'whatsapp-web': false, 'whatsapp-cloud': false, 'whatsapp-evolution': false });
let cached: Activation | null = null;
let serial: Promise<void> = Promise.resolve();

export const notificationVaultName = (channel: NotificationChannel): string => `notification/${channel}`;

async function state(): Promise<Activation> {
  if (cached) return cached;
  const raw = await readDurable<unknown>(ACTIVE_RECORD);
  const migrated = raw && typeof raw === 'object' && !Array.isArray(raw) && !('whatsapp-web' in raw) ? { ...raw, 'whatsapp-web': false } : raw;
  const parsed = activationSchema.safeParse(migrated);
  return cached ?? (cached = parsed.success ? parsed.data : disabled());
}
async function mutate(change: (current: Activation) => Activation): Promise<void> {
  const job = serial.then(async () => {
    const next = change(await state());
    await writeDurableNow(ACTIVE_RECORD, next);
    cached = next;
  });
  serial = job.catch(() => undefined);
  await job;
}

export async function notificationCredentialPresence(): Promise<Activation> {
  const activation = await state();
  let names: Set<string>;
  try { names = new Set((await listVault()).map(entry => entry.name)); }
  catch { names = new Set(); }
  return Object.fromEntries(NOTIFICATION_CHANNELS.map(channel =>
    [channel, activation[channel] && names.has(notificationVaultName(channel))]
  )) as Activation;
}

/** Administrative credential replacement requires the Vault K master password. */
export async function storeNotificationCredential(channel: NotificationChannel, value: string, masterPassword: string): Promise<void> {
  if (!NOTIFICATION_CHANNELS.includes(channel) || !value || value.length > 4096 || masterPassword.length < 12) throw new Error('Invalid credential or master password');
  await putVault({ name: notificationVaultName(channel), value, origin: '', header: 'X-Notification-Credential' }, masterPassword);
  await mutate(active => ({ ...active, [channel]: true }));
}

/** Import disables every old Vault binding before applying the imported configuration. */
export async function requireNotificationReauthorization(): Promise<void> {
  await mutate(() => disabled());
}

/** The plaintext is confined to Vault K's main-process callback and network transport. */
export async function withNotificationCredential<T>(channel: NotificationChannel, operation: (value: string) => Promise<T>): Promise<T> {
  if (!(await notificationCredentialPresence())[channel]) throw new Error('Notification credential must be saved in Vault K');
  let result: T | undefined;
  await useVault(notificationVaultName(channel), async entry => {
    result = await operation(entry.value);
    return 'used';
  });
  return result as T;
}

/** Only isolated tests should reset the in-memory record cache. */
export function resetNotificationCredentialCacheForTests(): void { cached = null; serial = Promise.resolve(); }
