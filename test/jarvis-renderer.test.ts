import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initJarvis } from '../src/renderer/jarvis.js';
import type { AppApi } from '../src/preload/index.js';
import type { DictationEvent } from '../src/shared/dictation.js';

const skeleton = `<!doctype html><html><body>
  <input id="jarvisEnabled" type="checkbox"><input id="jarvisConsent" type="checkbox">
  <select id="jarvisKey"><option value="F8">F8</option><option value="F9">F9</option></select>
  <input id="jarvisLanguage"><input id="jarvisTts" type="checkbox">
  <select id="jarvisEngine"><option value="cliproxy">CLIProxy</option></select>
  <select id="jarvisAudioModel"><option value="">Auto</option></select>
  <select id="jarvisVoice"><option value="">System default</option></select>
  <p id="jarvisSettingsStatus"></p><textarea id="chatInput"></textarea>
  <button id="jarvisTalk" hidden type="button" aria-pressed="false"></button>
  </body></html>`;
let page: JSDOM | null = null;
afterEach(() => { page?.window.close(); page = null; vi.unstubAllGlobals(); });

async function fixture(audio = false) {
  page = new JSDOM(skeleton, { url: 'https://local.test/' });
  const window = page.window;
  Object.assign(globalThis, {
    window, document: window.document, localStorage: window.localStorage,
    Event: window.Event, Option: window.Option
  });
  let emit: (event: DictationEvent) => void = () => undefined;
  let selection = { id: 'test-jarvis-0001', conversationId: 'cosapi-test-jarvis', engine: 'cliproxy' };
  const start = vi.fn(async () => ({ ok: true, data: { status: 'starting' } }));
  const stop = vi.fn(async () => ({ ok: true, data: undefined }));
  const send = vi.fn(async () => ({ ok: true, data: { turnId: 'turn-01' } }));
  const transcribe = vi.fn(async () => ({ ok: true as const, data: 'Hello from Linux' }));
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks };
  if (audio) {
    Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
    vi.stubGlobal('navigator', window.navigator);
    class Recorder {
      static isTypeSupported = () => true;
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: unknown, _options: unknown) { }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic audio'], { type: 'audio/webm' }) }); this.onstop?.(); }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
  }
  const api = {
    dictationSupported: true,
    jarvisAudioStatus: async () => ({ ok: true as const, data: { models: ['whisper-1'], local: false, windows: true, error: null } }),
    jarvisTranscribe: transcribe, jarvisCancel: async () => ({ ok: true as const, data: null }),
    startDictation: start, stopDictation: stop, apiChatSend: send,
    onDictationEvent: (callback: typeof emit) => { emit = callback; return () => undefined; },
    onSessionChanged: () => () => undefined
  };
  initJarvis(api as unknown as AppApi, () => selection);
  const element = <T extends HTMLElement>(id: string): T => window.document.getElementById(id) as T;
  const check = (id: string) => { const input = element<HTMLInputElement>(id); input.checked = true; input.dispatchEvent(new window.Event('change')); };
  const hold = () => element<HTMLTextAreaElement>('chatInput').dispatchEvent(new window.KeyboardEvent('keydown', { code: 'F8', bubbles: true }));
  const release = () => window.dispatchEvent(new window.KeyboardEvent('keyup', { code: 'F8', bubbles: true }));
  const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
  return { window, element, check, hold, release, flush, start, stop, send, transcribe, tracks,
    emit: (event: DictationEvent) => emit(event), select: (id: string) => { selection = { ...selection, id }; window.dispatchEvent(new window.Event('jarvis:selection')); } };
}

describe('Jarvis hold-to-talk safety and actual composer routing', () => {
  it('does not start until enabled and consented; releases exactly one final transcript into the selected CLIProxy chat', async () => {
    const f = await fixture();
    f.hold();
    expect(f.start).not.toHaveBeenCalled();
    f.check('jarvisEnabled');
    f.hold();
    expect(f.start).not.toHaveBeenCalled();
    f.check('jarvisConsent');
    f.hold(); await f.flush();
    expect(f.start).toHaveBeenCalledTimes(1);
    f.emit({ type: 'status', status: 'listening' });
    f.emit({ type: 'final', text: 'Hello Jarvis' });
    expect(f.send).not.toHaveBeenCalled();
    f.release(); await f.flush();
    expect(f.stop).toHaveBeenCalledTimes(1);
    f.emit({ type: 'status', status: 'stopped' }); await f.flush();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith('test-jarvis-0001', 'Hello Jarvis');
    f.emit({ type: 'status', status: 'stopped' });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('discards an unfinished utterance when the user changes chats', async () => {
    const f = await fixture();
    f.check('jarvisEnabled'); f.check('jarvisConsent');
    f.hold(); await f.flush();
    f.emit({ type: 'final', text: 'sensitive draft' });
    f.select('test-jarvis-0002');
    f.release();
    f.emit({ type: 'status', status: 'stopped' });
    await f.flush();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.element<HTMLButtonElement>('jarvisTalk').getAttribute('aria-pressed')).toBe('false');
  });

  it('records synthetic audio only during hold, transcribes on release and sends recognized text', async () => {
    const f = await fixture(true);
    f.check('jarvisEnabled'); f.check('jarvisConsent');
    f.hold(); await f.flush();
    expect(f.transcribe).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.release(); await f.flush();
    expect(f.transcribe).toHaveBeenCalledOnce();
    expect(f.transcribe).toHaveBeenCalledWith('cliproxy', 'whisper-1', '', 'audio/webm', expect.any(Uint8Array));
    expect(f.send).toHaveBeenCalledWith('test-jarvis-0001', 'Hello from Linux');
    expect(f.tracks[0]?.stop).toHaveBeenCalled();
  });
});
