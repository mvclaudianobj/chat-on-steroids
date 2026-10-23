import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initJarvis } from '../src/renderer/jarvis.js';
import type { AppApi } from '../src/preload/index.js';

const skeleton = `<!doctype html><html><body>
  <input id="jarvisEnabled" type="checkbox"><input id="jarvisConsent" type="checkbox">
  <select id="jarvisKey"><option value="F8">F8</option></select>
  <input id="jarvisLanguage"><input id="jarvisTts" type="checkbox">
  <select id="jarvisEngine"><option value="auto">auto</option><option value="cliproxy">CLIProxy</option></select>
  <select id="jarvisVoice"><option value="">System default</option></select>
  <input id="jarvisContinuous" type="checkbox"><input id="jarvisEarcons" type="checkbox">
  <p id="jarvisSettingsStatus"></p><p id="jarvisProviderStatus"></p><textarea id="chatInput"></textarea>
  <button id="jarvisTalk" hidden type="button" aria-pressed="false"></button><span id="jarvisStatus" hidden></span>
  </body></html>`;
const voice = { baseUrl: 'https://voice.test/v1', sttMode: 'transcriptions', sttModel: 'whisper-1', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy' };
let page: JSDOM | null = null;
afterEach(() => { page?.window.close(); page = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(options: { tts?: boolean; continuous?: boolean; providerTranscribe?: 'ok' | 'fail' } = {}) {
  page = new JSDOM(skeleton, { url: 'https://local.test/' });
  const window = page.window;
  window.localStorage.setItem('chat-marks.jarvis.settings.v1', JSON.stringify({ enabled: true, tts: options.tts ?? true, continuous: options.continuous ?? false, earcons: false, provider: voice, version: 2 }));
  Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, Event: window.Event, Option: window.Option });
  const tracks = [{ stop: vi.fn() }];
  const getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
  Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('navigator', window.navigator);
  class Recorder {
    static isTypeSupported = () => true;
    state = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic audio'], { type: 'audio/webm' }) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  const players: { src: string; paused: boolean; finish: () => void }[] = [];
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    paused = true;
    constructor(readonly src: string) { players.push(this as unknown as { src: string; paused: boolean; finish: () => void }); }
    finish() { this.paused = true; this.onended?.(); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  vi.stubGlobal('Audio', FakeAudio);
  let urls = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:jarvis-${++urls}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  let changed: (change?: { sessionIds?: string[] }) => void = () => undefined;
  let events: unknown[] = [];
  const transcribe = vi.fn(async (engine: string, ..._rest: unknown[]) => engine === 'provider' && options.providerTranscribe === 'fail'
    ? { ok: false as const, error: 'provider down' } : { ok: true as const, data: `text from ${engine}` });
  const speak = vi.fn(async (_voice: unknown, text: string) => ({ ok: true as const, data: { mime: 'audio/mpeg', bytes: new TextEncoder().encode(text) } }));
  const speakCancel = vi.fn(async () => ({ ok: true as const, data: null }));
  const send = vi.fn(async () => ({ ok: true as const, data: { turnId: 'turn-01' } }));
  const api = {
    dictationSupported: false,
    jarvisAudioStatus: async () => ({ ok: true as const, data: { models: ['whisper-1'], local: false, windows: false, error: null } }),
    jarvisVoiceStatus: async () => ({ ok: true as const, data: { models: [], stt: ['whisper-1'], tts: ['gpt-4o-mini-tts'], primary: true, fallback: true, ffmpeg: true, error: null } }),
    jarvisTranscribe: transcribe, jarvisSpeak: speak, jarvisSpeakCancel: speakCancel,
    jarvisCancel: async () => ({ ok: true as const, data: null }),
    startDictation: vi.fn(), stopDictation: vi.fn(async () => ({ ok: true, data: undefined })), apiChatSend: send,
    onDictationEvent: () => () => undefined,
    onSessionChanged: (callback: typeof changed) => { changed = callback; return () => undefined; },
    getSession: vi.fn(async () => ({ ok: true as const, data: { events, summary: null, total: events.length, nextFrom: 0 } }))
  };
  initJarvis(api as unknown as AppApi, () => ({ id: 'test-jarvis-0001', conversationId: 'cosapi-test-jarvis', engine: 'cliproxy' }));
  const element = <T extends HTMLElement>(id: string): T => window.document.getElementById(id) as T;
  const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
  await flush();
  const consent = element<HTMLInputElement>('jarvisConsent'); consent.checked = true; consent.dispatchEvent(new window.Event('change'));
  const hold = () => element<HTMLTextAreaElement>('chatInput').dispatchEvent(new window.KeyboardEvent('keydown', { code: 'F8', bubbles: true }));
  const release = () => window.dispatchEvent(new window.KeyboardEvent('keyup', { code: 'F8', bubbles: true }));
  const stream = async (text: string, final = false, ended = false) => {
    events = [
      { kind: 'assistant_message', turnId: 'turn-01', messageId: 'm1', seq: 2, message: { text, truncated: false, chars: text.length }, final },
      ...(ended ? [{ kind: 'turn_end', turnId: 'turn-01', seq: 3, outcome: 'completed' }] : [])
    ];
    changed({ sessionIds: ['test-jarvis-0001'] });
    await flush();
  };
  return { element, hold, release, flush, stream, transcribe, speak, speakCancel, send, players, getUserMedia };
}

describe('Jarvis voice provider in the conversation', () => {
  it('uses the configured provider first and falls back to CLIProxy when it fails', async () => {
    const f = await fixture({ providerTranscribe: 'fail' });
    f.hold(); await f.flush();
    expect(f.element('jarvisStatus').textContent).toBe('Listening…');
    f.release(); await f.flush();
    expect(f.transcribe.mock.calls.map(call => call[0])).toEqual(['provider', 'cliproxy']);
    expect(f.transcribe.mock.calls[0]![5]).toEqual(voice);
    expect(f.send).toHaveBeenCalledWith('test-jarvis-0001', 'text from cliproxy');
    expect(f.element('jarvisTalk').dataset.state).toBe('thinking');
  });

  it('speaks the answer sentence by sentence while it streams, then returns to idle', async () => {
    const f = await fixture();
    f.hold(); await f.flush(); f.release(); await f.flush();
    expect(f.send).toHaveBeenCalledWith('test-jarvis-0001', 'text from provider');
    await f.stream('Olá, eu sou o Jarvis. Estou');
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Olá, eu sou o Jarvis.']);
    expect(f.element('jarvisTalk').dataset.state).toBe('speaking');
    await f.stream('Olá, eu sou o Jarvis. Estou pronto para ajudar. Fim', true, true);
    // One sentence is synthesized ahead of the one playing; the rest waits in order.
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Olá, eu sou o Jarvis.', 'Estou pronto para ajudar.']);
    f.players[0]!.finish(); await f.flush();
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Olá, eu sou o Jarvis.', 'Estou pronto para ajudar.', 'Fim']);
    for (let i = 1; i < 3; i++) { f.players[i]!.finish(); await f.flush(); }
    expect(f.players).toHaveLength(3);
    expect(f.element('jarvisTalk').dataset.state).toBe('idle');
  });

  it('barge-in: pressing push-to-talk while Jarvis speaks stops the voice and listens', async () => {
    const f = await fixture();
    f.hold(); await f.flush(); f.release(); await f.flush();
    await f.stream('Primeira frase longa o bastante. Segunda frase também longa. Terceira');
    expect(f.players[0]!.paused).toBe(false);
    f.hold(); await f.flush();
    expect(f.players[0]!.paused).toBe(true);
    expect(f.speakCancel).toHaveBeenCalled();
    expect(f.element('jarvisTalk').dataset.state).toBe('listening');
    await f.stream('Primeira frase longa o bastante. Segunda frase também longa. Terceira frase.', true, true);
    expect(f.players).toHaveLength(1);
  });

  it('continuous conversation listens again after the spoken answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await fixture({ continuous: true });
    f.hold(); await f.flush(); f.release(); await f.flush();
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
    await f.stream('Resposta curta e completa.', true, true);
    f.players[0]!.finish(); await f.flush();
    vi.advanceTimersByTime(500); await f.flush();
    expect(f.getUserMedia).toHaveBeenCalledTimes(2);
    expect(f.element('jarvisTalk').dataset.state).toBe('listening');
  });
});
