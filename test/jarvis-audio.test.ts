import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => vi.fn(async () => [
  { id: 'whisper-1', modality: 'audio' }, { id: 'gpt-4o-mini-tts', modality: 'audio' },
  { id: 'gpt-6-sol', modality: 'chat' }
]));
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn() } }));
vi.mock('../src/main/api-chat/catalog.js', () => ({ allApiModels: models }));
vi.mock('../src/main/api-chat/settings.js', () => ({
  apiChatKey: async () => 'test-only-token',
  apiChatSettings: async () => ({ endpoint: 'http://127.0.0.1:18081/v1' })
}));
vi.mock('../src/main/markspanel-auth.js', () => ({ markspanelAccessBlocked: () => false }));

import { jarvisAudioStatus, transcribeJarvis } from '../src/main/jarvis-audio.js';

beforeEach(() => { models.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

describe('Jarvis audio main-process boundary', () => {
  it('lists candidate transcription models without any inference request and filters TTS', async () => {
    const catalog = await jarvisAudioStatus();
    expect(catalog.models).toEqual(['whisper-1']);
    expect(catalog.local).toBe(false);
    expect(models).toHaveBeenCalledOnce();
  });

  it('sends bounded audio as multipart using the saved key in main, returns text only', async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      expect(_url).toBe('http://127.0.0.1:18081/v1/audio/transcriptions');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({ authorization: 'Bearer test-only-token' });
      expect(options.body).toBeInstanceOf(FormData);
      expect((options.body as FormData).get('model')).toBe('whisper-1');
      expect((options.body as FormData).get('file')).toBeInstanceOf(Blob);
      return { ok: true, text: async () => JSON.stringify({ text: '  áudio sintético  ' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await transcribeJarvis({ action: 'transcribe', engine: 'cliproxy', model: 'whisper-1', language: 'pt-BR', mime: 'audio/webm', bytes: new Uint8Array([1, 2, 3]) }, new AbortController().signal);
    expect(result).toBe('áudio sintético');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects models outside the live catalog before sending recorded samples', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(transcribeJarvis({ action: 'transcribe', engine: 'cliproxy', model: 'unknown-audio', language: '', mime: 'audio/webm', bytes: new Uint8Array([1]) }, new AbortController().signal)).rejects.toThrow('Choose a transcription model');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
