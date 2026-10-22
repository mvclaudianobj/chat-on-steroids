import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS } from '../src/shared/notification-center.js';
import type { NotificationCenterView } from '../src/shared/notification-center.js';

const ipcHandlers = vi.hoisted(() => new Map<string, (
  event: { sender: { isDestroyed(): boolean }; senderFrame: object }, payload: unknown
) => Promise<unknown>>());
const files = vi.hoisted(() => ({ exportFile: '', importFile: '' }));

// Run the real secrets.ts file lifecycle against an isolated test cipher, never the host keyring.
// The cipher is authenticated and opaque; this verifies what is written without storing test
// credentials in a developer's actual OS credentials.
vi.mock('electron', async () => {
  const { createCipheriv, createDecipheriv, randomBytes } = await import('node:crypto');
  const key = Buffer.alloc(32, 0x6d);
  const header = Buffer.from('notification-test-cipher:');
  return {
    ipcMain: {
      handle: (channel: string, handler: (
        event: { sender: { isDestroyed(): boolean }; senderFrame: object }, payload: unknown
      ) => Promise<unknown>) => { ipcHandlers.set(channel, handler); }
    },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: !files.importFile, filePaths: files.importFile ? [files.importFile] : [] })),
      showSaveDialog: vi.fn(async () => ({ canceled: !files.exportFile, filePath: files.exportFile || undefined }))
    },
    safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (plaintext: string): Promise<Buffer> => {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return Buffer.concat([header, nonce, cipher.getAuthTag(), encrypted]);
      },
      decryptStringAsync: async (blob: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> => {
        if (!blob.subarray(0, header.length).equals(header)) throw new Error('Invalid test ciphertext');
        const start = header.length;
        const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(start, start + 12));
        decipher.setAuthTag(blob.subarray(start + 12, start + 28));
        return {
          result: Buffer.concat([decipher.update(blob.subarray(start + 28)), decipher.final()]).toString('utf8'),
          shouldReEncrypt: false
        };
      }
    }
  };
});

let directory = '';
const settingsFile = (): string => path.join(directory, 'state', 'marks-notification-center.json');

/** Simulates a restart while keeping the actual on-disk JSON and encrypted secret blob. */
async function boot() {
  vi.resetModules();
  const durable = await import('../src/main/durable.js');
  durable.initDurableStore(directory);
  const secrets = await import('../src/main/secrets.js');
  secrets.initSecretsPath(directory);
  const vault = await import('../src/main/marks-vault.js');
  vault.initMarksVault(directory);
  const center = await import('../src/main/notification-center.js');
  return { durable, secrets, vault, center };
}

function expectSafeDefaults(view: NotificationCenterView): void {
  expect(view.settings.throttleMinutes).toBe(1);
  expect(view.settings.batchWindowSeconds).toBe(10);
  for (const channel of NOTIFICATION_CHANNELS) {
    const config = view.settings.channels[channel];
    expect(config.enabled).toBe(false);
    expect(config.destinations).toEqual([]);
    expect(config.includeExcerpt).toBe(false);
    expect(config.config).toEqual({});
    for (const event of NOTIFICATION_EVENTS) expect(config.events[event]).toBe(false);
    expect(view.credentials[channel]).toBe(false);
  }
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), 'marks-notify-persistence-'));
  ipcHandlers.clear();
  files.exportFile = ''; files.importFile = '';
});

afterEach(async () => {
  const { resetDurableForTests } = await import('../src/main/durable.js');
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
  ipcHandlers.clear();
});

describe('notification center persistent state', () => {
  it('defaults every channel and event to OFF when the settings file is absent', async () => {
    const { center, durable } = await boot();
    expect(await durable.readDurable('marks-notification-center')).toBeNull();
    expectSafeDefaults(await center.notificationView());
    await expect(fs.stat(settingsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['truncated JSON', '{"channels":'],
    ['schema-invalid JSON', JSON.stringify({ channels: { smtp: { enabled: true } } })]
  ])('recovers safely from %s without rewriting the original', async (_kind, contents) => {
    await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
    await fs.writeFile(settingsFile(), contents, 'utf8');

    const { center } = await boot();
    expectSafeDefaults(await center.notificationView());
    expect(await fs.readFile(settingsFile(), 'utf8')).toBe(contents);
  });

  it('persists channel choices and reloads them after a fresh module initialization', async () => {
    const first = await boot();
    const settings = structuredClone(await first.center.notificationSettings());
    settings.throttleMinutes = 12;
    settings.batchWindowSeconds = 45;
    settings.channels.telegram.enabled = true;
    settings.channels.telegram.events['turn-completed'] = true;
    settings.channels.telegram.destinations = ['synthetic-chat-1', 'synthetic-chat-2'];
    settings.channels.telegram.titleTemplate = 'Done: {title}';
    settings.channels.telegram.config.apiBase = 'https://api.telegram.org';

    const written = await first.center.saveNotificationSettings(settings);
    expect(written.settings).toEqual(settings);
    expect(JSON.parse(await fs.readFile(settingsFile(), 'utf8'))).toEqual(settings);

    const second = await boot();
    expect(await second.durable.readDurable('marks-notification-center')).toEqual(settings);
    expect((await second.center.notificationView()).settings).toEqual(settings);
    expect((await second.center.notificationView()).credentials.telegram).toBe(false);
  });

  it('stores a credential in encrypted Vault K, never in settings/secrets.bin or IPC', async () => {
    const { center, vault } = await boot();
    const masterPassword = 'synthetic-only-master-password';
    await vault.createVault(masterPassword);
    const settings = structuredClone(await center.notificationSettings());
    settings.channels.telegram.destinations = ['synthetic-chat'];
    await center.saveNotificationSettings(settings);
    const durableBefore = await fs.readFile(settingsFile(), 'utf8');

    const sender = { isDestroyed: () => false, mainFrame: {} };
    const { registerNotificationCenterIpc } = await import('../src/main/notification-ipc.js');
    registerNotificationCenterIpc(() => ({ webContents: sender, isDestroyed: () => false }) as never);
    const invoke = ipcHandlers.get('marksNotify:request');
    expect(invoke).toBeDefined();

    const credential = 'synthetic-credential-never-in-state-or-ipc';
    const reply = await invoke!({ sender, senderFrame: sender.mainFrame }, { action: 'credential', channel: 'telegram', credential, masterPassword });
    expect(reply).toMatchObject({ ok: true, data: { credentials: { telegram: true } } });
    expect(JSON.stringify(reply)).not.toContain(credential);
    expect(await fs.readFile(settingsFile(), 'utf8')).toBe(durableBefore);
    expect(durableBefore).not.toContain(credential);

    const blob = await fs.readFile(path.join(directory, 'secrets.bin'));
    expect(blob.includes(Buffer.from(credential))).toBe(false);
    const encryptedVault = await fs.readFile(path.join(directory, 'marks-vault.json'));
    expect(encryptedVault.includes(Buffer.from(credential))).toBe(false);
    const credentials = await vault.listVault();
    expect(credentials).toContainEqual(expect.objectContaining({ name: 'notification/telegram' }));
    await vault.useVault('notification/telegram', async entry => { expect(entry.value).toBe(credential); return 'used'; });

    const getReply = await invoke!({ sender, senderFrame: sender.mainFrame }, { action: 'get' });
    expect(JSON.stringify(getReply)).not.toContain(credential);
    expect(getReply).toMatchObject({ ok: true, data: { credentials: { telegram: true } } });

    const restarted = await boot();
    await restarted.vault.useVault('notification/telegram', async entry => { expect(entry.value).toBe(credential); return 'used'; });
    const restartedView = await restarted.center.notificationView();
    expect(restartedView.credentials.telegram).toBe(true);
    expect(JSON.stringify(restartedView)).not.toContain(credential);
    expect(await fs.readFile(settingsFile(), 'utf8')).toBe(durableBefore);
  });

  it('exports only settings and requires credentials again after importing without a vault', async () => {
    const { center, vault } = await boot();
    const masterPassword = 'synthetic-only-master-password';
    await vault.createVault(masterPassword);
    const initial = structuredClone(await center.notificationSettings());
    initial.channels.telegram.enabled = true;
    initial.channels.telegram.events['turn-completed'] = true;
    initial.channels.telegram.destinations = ['synthetic-chat-007'];
    await center.saveNotificationSettings(initial);
    const sender = { isDestroyed: () => false, mainFrame: {} };
    const { registerNotificationCenterIpc } = await import('../src/main/notification-ipc.js');
    registerNotificationCenterIpc(() => ({ webContents: sender, isDestroyed: () => false }) as never);
    const invoke = (action: unknown) => ipcHandlers.get('marksNotify:request')!({ sender, senderFrame: sender.mainFrame }, action);
    const credential = 'synthetic-only-credential-do-not-export';
    expect(await invoke({ action: 'credential', channel: 'telegram', credential, masterPassword })).toMatchObject({ ok: true });
    files.exportFile = path.join(directory, 'notification-export.json');
    expect(await invoke({ action: 'export' })).toEqual({ ok: true, data: true });
    const raw = await fs.readFile(files.exportFile, 'utf8');
    const exported = JSON.parse(raw);
    expect(exported.format).toBe('chat-marks-notification-settings');
    expect(exported.version).toBe(1);
    expect(exported.settings.channels.telegram.destinations).toEqual(['synthetic-chat-007']);
    expect(raw).not.toContain(credential);
    expect(raw).not.toContain(masterPassword);
    expect(raw).not.toContain('notification/telegram');
    const changed = structuredClone(await center.notificationSettings());
    changed.channels.telegram.enabled = false;
    changed.channels.telegram.destinations = [];
    await center.saveNotificationSettings(changed);
    files.importFile = files.exportFile;
    expect(await invoke({ action: 'import' })).toEqual({ ok: true, data: { imported: true } });
    const view = await center.notificationView();
    expect(view.settings).toEqual(initial);
    expect(view.credentials.telegram).toBe(false);
    // The old encrypted Vault K entry remains intact, but the imported configuration cannot reuse it.
    expect((await vault.listVault()).some(entry => entry.name === 'notification/telegram')).toBe(true);
    await expect(center.dispatchNotice({ event: 'turn-completed', title: 'Synthetic', project: 'test' }, { channel: 'telegram', test: true }))
      .rejects.toThrow(/must be saved/);
    expect(await invoke({ action: 'credential', channel: 'telegram', credential: 'new-synthetic-token', masterPassword })).toMatchObject({ ok: true, data: { credentials: { telegram: true } } });
  });

  it('rejects malformed imported files without changing settings', async () => {
    const { center } = await boot();
    const original = structuredClone(await center.notificationSettings());
    files.importFile = path.join(directory, 'bad-notification-settings.json');
    await fs.writeFile(files.importFile, JSON.stringify({ format: 'chat-marks-notification-settings', version: 1, settings: { channels: { telegram: { enabled: true, credential: 'bad-secret' } } } }), 'utf8');
    const sender = { isDestroyed: () => false, mainFrame: {} };
    const { registerNotificationCenterIpc } = await import('../src/main/notification-ipc.js');
    registerNotificationCenterIpc(() => ({ webContents: sender, isDestroyed: () => false }) as never);
    const reply = await ipcHandlers.get('marksNotify:request')!({ sender, senderFrame: sender.mainFrame }, { action: 'import' });
    expect(reply).toMatchObject({ ok: false });
    expect(JSON.stringify(reply)).not.toContain('bad-secret');
    expect(await center.notificationSettings()).toEqual(original);
  });
});
