import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: unknown, payload: unknown) => Promise<unknown>),
  start: vi.fn(),
  status: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  warned: vi.fn()
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (_name: string, fn: typeof mocks.handler) => { mocks.handler = fn; } },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }
}));
vi.mock('../src/main/notification-whatsapp-web.js', () => ({
  startWhatsAppWeb: mocks.start,
  getWhatsAppWebStatus: mocks.status,
  resumeWhatsAppWeb: mocks.resume,
  stopWhatsAppWeb: mocks.stop,
  disconnectWhatsAppWeb: vi.fn(),
  WhatsAppPairingError: class WhatsAppPairingError extends Error {
    issue: string;
    constructor(issue: string) { super('sanitized'); this.issue = issue; }
  }
}));
vi.mock('../src/main/notification-telegram-pair.js', () => ({
  startTelegramPairing: vi.fn(), checkTelegramPairing: vi.fn(), cancelTelegramPairing: vi.fn()
}));
vi.mock('../src/main/notification-center.js', () => ({
  notificationSettings: vi.fn(), notificationView: vi.fn(), saveNotificationSettings: vi.fn(),
  setNotificationCredential: vi.fn(), importNotificationSettings: vi.fn(), testNotificationChannel: vi.fn()
}));
vi.mock('../src/main/logger.js', () => ({ logWarn: mocks.warned }));
vi.mock('../src/main/main-texts.js', () => ({ dialogLabel: vi.fn(), mainText: vi.fn() }));

beforeEach(() => { mocks.start.mockReset(); mocks.status.mockReset(); mocks.warned.mockReset(); mocks.resume.mockReset(); mocks.stop.mockReset(); });

it('passes only a safe issue and stage when WhatsApp initialization fails in the authorized main frame', async () => {
  const { WhatsAppPairingError } = await import('../src/main/notification-whatsapp-web.js');
  const { registerNotificationCenterIpc } = await import('../src/main/notification-ipc.js');
  const secret = 'SYNTHETIC-PRIVATE-DO-NOT-LOG';
  const window = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false } };
  registerNotificationCenterIpc(() => window as never);
  mocks.start.mockRejectedValue(new WhatsAppPairingError('storage_unavailable'));
  mocks.status.mockResolvedValue({ state: 'error', reason: 'storage_unavailable', stage: 'storage' });
  const response = await mocks.handler!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, { action: 'wa-start' });
  expect(response).toEqual({ ok: false, error: 'WhatsApp setup failed', setupCode: 'storage_unavailable', setupStage: 'storage' });
  expect(JSON.stringify(response)).not.toContain(secret);
  expect(JSON.stringify(mocks.warned.mock.calls)).toContain('storage_unavailable');
});

it('produces a PNG QR over authorized IPC without returning the raw QR payload', async () => {
  const { registerNotificationCenterIpc } = await import('../src/main/notification-ipc.js');
  const window = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false } };
  registerNotificationCenterIpc(() => window as never);
  mocks.status.mockResolvedValue({ state: 'qr', qr: 'TEST-QR-PAYLOAD-NEVER-DISPLAY', stage: 'qr' });
  const response = await mocks.handler!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, { action: 'wa-status' }) as { ok: boolean; data?: { qr?: string } };
  expect(response.ok).toBe(true);
  expect(response.data?.qr).toMatch(/^data:image\/png;base64,/);
  expect(JSON.stringify(response)).not.toContain('TEST-QR-PAYLOAD');
});

it('rejects renderer subframes before invoking WhatsApp start', async () => {
  const { registerNotificationCenterIpc } = await import('../src/main/notification-ipc.js');
  const window = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false } };
  registerNotificationCenterIpc(() => window as never);
  const response = await mocks.handler!({ sender: window.webContents, senderFrame: {} }, { action: 'wa-start' });
  expect(response).toMatchObject({ ok: false });
  expect(mocks.start).not.toHaveBeenCalled();
});

it('restores only the enabled WhatsApp channel after settings are saved', async () => {
  const center = await import('../src/main/notification-center.js');
  const { registerNotificationCenterIpc } = await import('../src/main/notification-ipc.js');
  const window = { isDestroyed: () => false, webContents: { mainFrame: {}, isDestroyed: () => false } };
  registerNotificationCenterIpc(() => window as never);
  vi.mocked(center.saveNotificationSettings).mockResolvedValue({} as never);
  vi.mocked(center.notificationSettings).mockResolvedValueOnce({ channels: { 'whatsapp-web': { enabled: true } } } as never)
    .mockResolvedValueOnce({ channels: { 'whatsapp-web': { enabled: false } } } as never);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  expect(await mocks.handler!(event, { action: 'save', settings: {} })).toMatchObject({ ok: true });
  expect(mocks.resume).toHaveBeenCalledTimes(1);
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(await mocks.handler!(event, { action: 'save', settings: {} })).toMatchObject({ ok: true });
  expect(mocks.stop).toHaveBeenCalledTimes(1);
});
