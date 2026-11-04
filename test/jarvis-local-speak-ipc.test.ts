import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ handler: null as null | ((event: unknown, payload: unknown) => Promise<unknown>) }));
vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/tmp/marks-jarvis-test-uninstalled' },
  ipcMain: { handle: vi.fn((_channel: string, handler: typeof state.handler) => { state.handler = handler; }) }
}));
vi.mock('../src/main/platform.js', () => ({ requireMarksFeature: vi.fn() }));
vi.mock('../src/main/markspanel-auth.js', () => ({ markspanelAccessBlocked: () => false }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn() }));
const local = vi.hoisted(() => ({
  speakJarvisLocal: vi.fn(async (_text: string, _signal: AbortSignal) => ({ mime: 'audio/wav', bytes: new Uint8Array([82, 73, 70, 70]) })),
  jarvisLocalStatus: vi.fn(async () => ({ stt: false })), installJarvisLocal: vi.fn(), transcribeJarvisLocal: vi.fn(),
  listPiperVoices: vi.fn(async () => ({ settings: { voice: 'faber', lengthScale: 1, noiseW: 0.8, sentenceSilence: 0.2 },
    voices: [{ id: 'faber', label: 'Faber', quality: 'medium', datasetLicense: 'CC0', installed: true }] })),
  savePiperVoiceSettings: vi.fn(async (settings: unknown) => settings),
  installPiperVoice: vi.fn(async () => ({ voices: [] }))
}));
vi.mock('../src/main/jarvis-local.js', () => local);
const voice = vi.hoisted(() => ({ speakJarvisVoice: vi.fn() }));
vi.mock('../src/main/jarvis-voice.js', () => ({ ...voice, jarvisVoiceStatus: vi.fn(), jarvisVoiceRouteStatus: vi.fn(),
  storeJarvisVoiceKey: vi.fn(), streamJarvisVoice: vi.fn(), transcribeJarvisVoice: vi.fn() }));

import { registerJarvisAudioIpc } from '../src/main/jarvis-audio.js';

describe('Jarvis offline Piper IPC', () => {
  const frame = {};
  const sender = { isDestroyed: () => false };
  const window = { isDestroyed: () => false, webContents: Object.assign(sender, { mainFrame: frame }) };
  registerJarvisAudioIpc(() => window as never);
  const call = (payload: unknown) => state.handler!({ sender, senderFrame: frame }, payload);

  it('speaks a reply with Piper without a provider configuration', async () => {
    const reply = await call({ action: 'local-speak', text: 'Olá, resposta falada pelo Piper.' }) as { ok: boolean; data: { mime: string } };
    expect(reply).toMatchObject({ ok: true, data: { mime: 'audio/wav' } });
    expect(local.speakJarvisLocal).toHaveBeenCalledWith('Olá, resposta falada pelo Piper.', expect.any(AbortSignal));
    expect(voice.speakJarvisVoice).not.toHaveBeenCalled();
  });

  it('records the local gate in the bounded trace vocabulary', async () => {
    expect(await call({ action: 'trace', step: 'gate', reason: 'local', localSpeaks: true, engine: 'local' })).toEqual({ ok: true, data: null });
  });

  it('rejects empty or oversized local speech text', async () => {
    expect(await call({ action: 'local-speak', text: '' })).toMatchObject({ ok: false });
    expect(await call({ action: 'local-speak', text: 'x'.repeat(4001) })).toMatchObject({ ok: false });
  });

  it('exposes the dedicated Piper selector and audible local preview, not the provider voice picker', async () => {
    const settings = { voice: 'faber', lengthScale: 0.85, noiseW: 0.7, sentenceSilence: 0.4 };
    expect(await call({ action: 'local-voices' })).toMatchObject({
      ok: true, data: { settings: { voice: 'faber' }, voices: [{ id: 'faber', installed: true }] }
    });
    expect(await call({ action: 'local-voice-save', settings })).toMatchObject({ ok: true, data: settings });
    expect(await call({ action: 'local-voice-preview', settings })).toMatchObject({ ok: true, data: { mime: 'audio/wav' } });
    expect(local.speakJarvisLocal).toHaveBeenCalledWith(expect.stringContaining('prévia'), expect.any(AbortSignal), settings);
    expect(voice.speakJarvisVoice).not.toHaveBeenCalled();
    expect(await call({ action: 'local-voice-save', settings: { ...settings, voice: '../unsafe' } })).toMatchObject({ ok: false });
    expect(await call({ action: 'local-voice-install', voice: '../unsafe' })).toMatchObject({ ok: false });
  });
});
