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
  <input id="jarvisProviderUrl"><select id="jarvisSttMode"><option value="transcriptions">Transcriptions</option><option value="chat-audio">Chat audio</option></select>
  <input id="jarvisSttModel"><input id="jarvisTtsModel"><input id="jarvisProviderVoice">
  <input id="jarvisProviderKey" type="password"><input id="jarvisProviderFallbackKey" type="password">
  <input id="jarvisVaultPassword" type="password">
  <select id="jarvisRoutingMode"><option value="off">Off</option><option value="gemini-first">Gemini first</option><option value="g4f-first">G4F first</option></select>
  <input id="jarvisG4f1Url"><input id="jarvisG4f1Model"><input id="jarvisG4f1Voice"><input id="jarvisG4f1Key" type="password">
  <input id="jarvisG4f2Url"><input id="jarvisG4f2Model"><input id="jarvisG4f2Voice"><input id="jarvisG4f2Key" type="password">
  <button id="jarvisG4fSaveKeys"></button><p id="jarvisG4fStatus" role="status"></p>
  <p id="jarvisSettingsStatus"></p><p id="jarvisProviderStatus"></p><textarea id="chatInput"></textarea>
  <p id="jarvisActiveChat" role="status"></p><p id="jarvisReadiness" role="status"></p>
  <span id="jarvisModelInfo"></span><button id="jarvisGoToChat"></button><button id="jarvisSetupChat" hidden></button>
  <button id="jarvisTalk" hidden type="button" aria-pressed="false"></button><span id="jarvisStatus" hidden></span>
  <button id="jarvisRefreshAudio" type="button"></button>
  <button id="jarvisCreateCliProxyChat" hidden type="button"></button><button id="jarvisReturnChat" hidden type="button"></button>
  </body></html>`;
const voice = { baseUrl: 'https://voice.test/v1', sttMode: 'transcriptions', sttModel: 'whisper-1', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy' };
let page: JSDOM | null = null;
afterEach(() => { page?.window.close(); page = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(options: { tts?: boolean; continuous?: boolean; providerTranscribe?: 'ok' | 'fail';
  selected?: { id: string; conversationId: string | null; engine?: string } | null; consent?: boolean; noAudioEngines?: boolean;
  g4f?: boolean; createFailure?: boolean; enabled?: boolean; noProvider?: boolean; providerUnavailable?: boolean; microphoneDenied?: boolean;
  deferredProviderStatus?: boolean;
  google?: boolean; language?: string;
  routingMode?: 'off' | 'gemini-first' | 'g4f-first';
  initialEvents?: unknown[]; initialTurns?: Record<string, { origin: number; time: number; questionId: string }> } = {}) {
  page = new JSDOM(skeleton, { url: 'https://local.test/' });
  const window = page.window;
  window.localStorage.setItem('chat-marks.jarvis.settings.v1', JSON.stringify({ enabled: options.enabled !== false, tts: options.tts ?? true, continuous: options.continuous ?? false, earcons: false,
    language: options.language ?? '', provider: options.noProvider ? { ...voice, baseUrl: '' }
      : options.google ? { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', sttMode: 'transcriptions', sttModel: 'gemini-3.5-transcribe', ttsModel: 'gemini-3.8-flash-tts', voice: 'Charon' }
      : options.g4f ? { baseUrl: 'https://g4f.space/v1', sttMode: 'chat-audio', sttModel: 'srv_synthetic:gemini', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy' } : voice,
    routing: { mode: options.routingMode ?? 'off', g4f: [
      { baseUrl: 'https://g4f.space/v1', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy' },
      { baseUrl: 'https://voice-two.example/v1', ttsModel: 'gpt-4o-mini-tts', voice: 'nova' }
    ] }, version: 2 }));
  Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, Event: window.Event, Option: window.Option });
  const tracks = [{ stop: vi.fn() }];
  const getUserMedia = vi.fn(async () => {
    if (options.microphoneDenied) throw new Error('NotAllowedError: synthetic denial');
    return { getTracks: () => tracks };
  });
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
  let events: unknown[] = options.initialEvents ?? [];
  let sessionSummary: { timelineTurns: Record<string, { origin: number; time: number; questionId: string }> } | null =
    options.initialTurns ? { timelineTurns: options.initialTurns } : null;
  const transcribe = vi.fn(async (engine: string, ..._rest: unknown[]) => engine === 'provider' && options.providerTranscribe === 'fail'
    ? { ok: false as const, error: 'provider down' } : { ok: true as const, data: `text from ${engine}` });
  const speak = vi.fn(async (_voice: unknown, text: string, _routing?: unknown, _groupId?: string) => ({ ok: true as const, data: { mime: 'audio/mpeg', bytes: new TextEncoder().encode(text) } }));
  const speakCancel = vi.fn(async () => ({ ok: true as const, data: null }));
  const routeStatus = vi.fn(async () => ({ ok: true as const, data: { g4f1: true, g4f2: false, error: null } }));
  const setKey = vi.fn(async () => ({ ok: true as const, data: true }));
  const send = vi.fn(async () => ({ ok: true as const, data: { turnId: 'turn-01' } }));
  const sendInput = vi.fn(async (input: { id: string; sessionId: string | null; text: string }) => ({ ok: true as const, data: { ...input, state: 'queued' } }));
  const statusResolvers: Array<(reply: { ok: true; data: { models: string[]; stt: string[]; tts: string[]; primary: boolean; fallback: boolean; ffmpeg: boolean; error: string | null } }) => void> = [];
  const statusRejectors: Array<(error: Error) => void> = [];
  const api = {
    dictationSupported: false,
    jarvisAudioStatus: async () => ({ ok: true as const, data: { models: options.noAudioEngines ? [] : ['whisper-1'], local: false, windows: false, error: null } }),
    jarvisVoiceStatus: async () => options.deferredProviderStatus
      ? await new Promise<{ ok: true; data: { models: string[]; stt: string[]; tts: string[]; primary: boolean; fallback: boolean; ffmpeg: boolean; error: string | null } }>((resolve, reject) => {
        statusResolvers.push(resolve);
        statusRejectors.push(reject);
      })
      : options.providerUnavailable ? { ok: false as const, error: 'Vault unreadable' } : ({ ok: true as const, data: { models: [], stt: ['whisper-1'], tts: ['gpt-4o-mini-tts'], primary: true, fallback: true, ffmpeg: true, error: null } }),
    jarvisTranscribe: transcribe, jarvisSpeak: speak, jarvisSpeakCancel: speakCancel,
    jarvisVoiceRouteStatus: routeStatus, jarvisVoiceSetKey: setKey,
    jarvisCancel: async () => ({ ok: true as const, data: null }),
    startDictation: vi.fn(), stopDictation: vi.fn(async () => ({ ok: true, data: undefined })), apiChatSend: send, sendInput,
    onDictationEvent: () => () => undefined,
    onSessionChanged: (callback: typeof changed) => { changed = callback; return () => undefined; },
    getSession: vi.fn(async () => ({ ok: true as const, data: { events, summary: sessionSummary, total: events.length, nextFrom: 0 } }))
  };
  let selected = options.selected === undefined
    ? ({ id: 'test-jarvis-0001', conversationId: 'cosapi-test-jarvis', engine: 'cliproxy' }) : options.selected;
  const oldChat = selected;
  const createCliProxyChat = vi.fn(async () => {
    if (options.createFailure) return null;
    selected = { id: 'created-api-session', conversationId: 'cosapi-created', engine: 'cliproxy' };
    window.dispatchEvent(new window.Event('jarvis:selection'));
    return 'created-api-session';
  });
  const selectChat = vi.fn(async (id: string) => {
    if (id === oldChat?.id) selected = oldChat;
    window.dispatchEvent(new window.Event('jarvis:selection'));
  });
  const openSettings = vi.fn();
  const openChat = vi.fn();
  initJarvis(api as unknown as AppApi, () => selected, { createCliProxyChat, selectChat, openSettings, openChat });
  const element = <T extends HTMLElement>(id: string): T => window.document.getElementById(id) as T;
  const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
  await flush();
  const consent = element<HTMLInputElement>('jarvisConsent'); consent.checked = options.consent !== false; consent.dispatchEvent(new window.Event('change'));
  const hold = () => element<HTMLTextAreaElement>('chatInput').dispatchEvent(new window.KeyboardEvent('keydown', { code: 'F8', bubbles: true }));
  const release = () => window.dispatchEvent(new window.KeyboardEvent('keyup', { code: 'F8', bubbles: true }));
  const stream = async (text: string, final = false, ended = false, turnId = 'turn-01') => {
    events = [
      { kind: 'assistant_message', turnId, messageId: 'm1', seq: 2, message: { text, truncated: false, chars: text.length }, final },
      ...(ended ? [{ kind: 'turn_end', turnId, seq: 3, outcome: 'completed' }] : [])
    ];
    changed({ sessionIds: ['test-jarvis-0001'] });
    await flush();
  };
  const nativeEvents = async (rows: unknown[], turns?: Record<string, { origin: number; time: number; questionId: string }>) => {
    events = rows;
    sessionSummary = turns ? { timelineTurns: turns } : null;
    changed({ sessionIds: [selected?.id ?? ''] });
    await flush();
  };
  const switchTo = (target: { id: string; conversationId: string | null; engine?: string }) => {
    selected = target;
    window.dispatchEvent(new window.Event('jarvis:selection'));
  };
  const finishProviderCheck = async (index: number, saved: boolean) => {
    statusResolvers[index]?.({ ok: true, data: { models: ['gemini-3.5-transcribe', 'gemini-3.8-flash-tts'],
      stt: ['gemini-3.5-transcribe'], tts: ['gemini-3.8-flash-tts'], primary: saved, fallback: false, ffmpeg: false,
      error: saved ? null : 'Save your Google AI Studio key to enable Gemini speech.' } });
    await flush();
  };
  const rejectProviderCheck = async (index: number) => { statusRejectors[index]?.(new Error('old provider unavailable')); await flush(); };
  return { element, hold, release, flush, stream, nativeEvents, switchTo, finishProviderCheck, rejectProviderCheck, statusResolvers,
    transcribe, speak, speakCancel, routeStatus, setKey, send, sendInput, players, getUserMedia, tracks, createCliProxyChat, selectChat, openSettings, openChat };
}

describe('Jarvis Gemini/G4F public routing settings', () => {
  it('persists both independent G4F profiles, never persists credentials, and shows saved-key masks from main status', async () => {
    const f = await fixture({ routingMode: 'gemini-first' });
    expect(f.element<HTMLSelectElement>('jarvisRoutingMode').value).toBe('gemini-first');
    await f.flush();
    expect(f.element<HTMLInputElement>('jarvisG4f1Key').placeholder).toBe('••••••••');
    expect(f.element<HTMLInputElement>('jarvisG4f2Key').placeholder).toBe('');
    expect(f.element<HTMLInputElement>('jarvisG4f1Key').value).toBe('');
    f.element<HTMLInputElement>('jarvisG4f1Url').value = 'https://same-host.example/v1';
    f.element<HTMLInputElement>('jarvisG4f2Url').value = 'https://same-host.example/v1';
    f.element<HTMLInputElement>('jarvisG4f2Model').value = 'model-two';
    f.element<HTMLSelectElement>('jarvisRoutingMode').value = 'g4f-first';
    f.element<HTMLSelectElement>('jarvisRoutingMode').dispatchEvent(new page!.window.Event('change'));
    const stored = JSON.parse(page!.window.localStorage.getItem('chat-marks.jarvis.settings.v1')!);
    expect(stored.routing.mode).toBe('g4f-first');
    expect(stored.routing.g4f).toEqual([
      { baseUrl: 'https://same-host.example/v1', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy' },
      { baseUrl: 'https://same-host.example/v1', ttsModel: 'model-two', voice: 'nova' }
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/password|credential|synthetic-secret/);
    f.element<HTMLInputElement>('jarvisVaultPassword').value = 'synthetic-secret';
    f.element<HTMLInputElement>('jarvisG4f2Key').value = 'second-key';
    f.element<HTMLButtonElement>('jarvisG4fSaveKeys').click(); await f.flush();
    expect(f.setKey).toHaveBeenCalledOnce();
    expect(f.setKey).toHaveBeenCalledWith('g4f2', 'https://same-host.example/v1', 'second-key', 'synthetic-secret');
    expect(f.element<HTMLInputElement>('jarvisG4f2Key').value).toBe('');
    expect(page!.window.localStorage.getItem('chat-marks.jarvis.settings.v1')).not.toContain('second-key');
  });

  it('keeps the same groupId for each spoken sentence, and rotates it after interruption', async () => {
    const f = await fixture({ routingMode: 'g4f-first' });
    f.hold(); await f.flush(); f.release(); await f.flush();
    await f.stream('Primeira frase do Jarvis. Segunda frase do Jarvis. E terceira.', true, true);
    const requests = f.speak.mock.calls;
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const routing = requests[0]?.[2] as { mode: string };
    const group = requests[0]?.[3] as string;
    expect(routing.mode).toBe('g4f-first');
    expect(group).toMatch(/^[0-9a-f-]{36}$/i);
    expect(requests.slice(1).every(row => row[3] === group)).toBe(true);
    f.hold(); await f.flush();
    f.release(); await f.flush();
    await f.stream('Nova resposta, com uma frase completa.', true, true);
    expect(f.speak.mock.calls.at(-1)?.[3]).not.toBe(group);
  });
});

describe('Jarvis automatic voice for typed ChatGPT messages', () => {
  const chatA = { id: 'typed-chat-A', conversationId: 'conversation-A', engine: 'chatgpt' };
  const chatB = { id: 'typed-chat-B', conversationId: 'conversation-B', engine: 'chatgpt' };
  const question = (id: string, seq: number, extra: Record<string, unknown> = {}) => ({
    kind: 'user_message', messageId: id, turnId: `user-${id}`, seq,
    message: { text: 'Typed message', chars: 13, truncated: false }, ...extra
  });
  const answer = (id: string, turnId: string, text: string, seq: number) => ({
    kind: 'assistant_message', messageId: id, turnId, seq, final: true,
    message: { text, chars: text.length, truncated: false }
  });
  const completed = (turnId: string, seq: number, outcome = 'completed') => ({ kind: 'turn_end', turnId, seq, outcome });
  const turns = (questionId: string, turnId: string, origin: number) => ({
    [turnId]: { questionId, origin, time: origin * 100 }
  });

  it('speaks one new typed final once, while ignoring historical final and interim messages', async () => {
    const old = [question('old-q', 1), answer('old-a', 'old-turn', 'Historico nunca deve falar.', 2), completed('old-turn', 3)];
    const f = await fixture({ selected: chatA, initialEvents: old, initialTurns: turns('old-q', 'old-turn', 1) });
    expect(f.speak).not.toHaveBeenCalled();
    const newQuestion = question('new-q', 4);
    await f.nativeEvents([...old, newQuestion], { ...turns('old-q', 'old-turn', 1), ...turns('new-q', 'new-turn', 5) });
    await f.nativeEvents([...old, newQuestion, answer('new-a', 'new-turn', 'A resposta digitada chegou. Proxima parte.', 6)],
      { ...turns('old-q', 'old-turn', 1), ...turns('new-q', 'new-turn', 5) });
    expect(f.speak).not.toHaveBeenCalled();
    const finished = [...old, newQuestion, answer('new-a', 'new-turn', 'A resposta digitada chegou. Proxima parte.', 6), completed('new-turn', 7)];
    await f.nativeEvents(finished, { ...turns('old-q', 'old-turn', 1), ...turns('new-q', 'new-turn', 5) });
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['A resposta digitada chegou.', 'Proxima parte.']);
    await f.nativeEvents(finished, { ...turns('old-q', 'old-turn', 1), ...turns('new-q', 'new-turn', 5) });
    expect(f.speak).toHaveBeenCalledTimes(2);
    expect(f.sendInput).not.toHaveBeenCalled();
    expect(f.transcribe).not.toHaveBeenCalled();
  });

  it('does not speak a superseded typed response that finishes after a newer question', async () => {
    const f = await fixture({ selected: chatA });
    await f.nativeEvents([question('q-old', 1)], turns('q-old', 'turn-old', 2));
    await f.nativeEvents([question('q-old', 1), question('q-current', 3)], {
      ...turns('q-old', 'turn-old', 2), ...turns('q-current', 'turn-current', 4)
    });
    await f.nativeEvents([
      question('q-old', 1), question('q-current', 3),
      answer('a-old', 'turn-old', 'Resposta superada nao deve tocar.', 5), completed('turn-old', 6)
    ], { ...turns('q-old', 'turn-old', 2), ...turns('q-current', 'turn-current', 4) });
    expect(f.speak).not.toHaveBeenCalled();
    await f.nativeEvents([
      question('q-old', 1), question('q-current', 3),
      answer('a-old', 'turn-old', 'Resposta superada nao deve tocar.', 5), completed('turn-old', 6),
      answer('a-current', 'turn-current', 'Somente a resposta atual deve tocar.', 7), completed('turn-current', 8)
    ], { ...turns('q-old', 'turn-old', 2), ...turns('q-current', 'turn-current', 4) });
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Somente a resposta atual deve tocar.']);
  });

  it('rejects ambiguous question links, failed turns and automatic follow-up messages', async () => {
    const f = await fixture({ selected: chatA });
    await f.nativeEvents([
      question('ambiguous-q', 1), question('auto-q', 2, { automatic: true }), question('failed-q', 3),
      answer('amb-a', 'amb-1', 'Nunca falar ambiguo.', 4), completed('amb-1', 5),
      answer('auto-a', 'auto-turn', 'Nunca falar automático.', 6), completed('auto-turn', 7),
      answer('fail-a', 'failed-turn', 'Falha não deve falar.', 8), completed('failed-turn', 9, 'stopped')
    ], { ...turns('ambiguous-q', 'amb-1', 4), ...turns('ambiguous-q', 'amb-2', 6),
      ...turns('auto-q', 'auto-turn', 7), ...turns('failed-q', 'failed-turn', 8) });
    expect(f.speak).not.toHaveBeenCalled();
  });

  it('interrupts stale playback on a new typed question and on chat switch or voice toggle', async () => {
    const f = await fixture({ selected: chatA });
    await f.nativeEvents([question('one', 1), answer('a1', 'turn1', 'Primeira resposta antiga.', 2), completed('turn1', 3)], turns('one', 'turn1', 2));
    expect(f.players[0]?.paused).toBe(false);
    await f.nativeEvents([question('one', 1), answer('a1', 'turn1', 'Primeira resposta antiga.', 2), completed('turn1', 3), question('two', 4)],
      { ...turns('one', 'turn1', 2), ...turns('two', 'turn2', 5) });
    expect(f.players[0]?.paused).toBe(true);
    await f.nativeEvents([question('two', 4), answer('a2', 'turn2', 'Segunda resposta atual.', 5), completed('turn2', 6)], turns('two', 'turn2', 5));
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Primeira resposta antiga.', 'Segunda resposta atual.']);
    f.switchTo(chatB); await f.flush();
    expect(f.players[1]?.paused).toBe(true);
    // The new selection baselines its already-recorded history; no old reply is replayed.
    f.switchTo(chatA); f.switchTo(chatB); await f.flush();
    expect(f.speak).toHaveBeenCalledTimes(2);
    f.switchTo(chatA); await f.flush();
    await f.nativeEvents([question('third', 10), answer('a3', 'third-turn', 'Terceira fala antes de desligar.', 11), completed('third-turn', 12)], turns('third', 'third-turn', 11));
    expect(f.speak).toHaveBeenCalledTimes(3);
    const tts = f.element<HTMLInputElement>('jarvisTts'); tts.checked = false; tts.dispatchEvent(new page!.window.Event('change'));
    await f.flush();
    expect(f.players[2]?.paused).toBe(true);
    await f.nativeEvents([question('fourth', 13), answer('a4', 'fourth-turn', 'Nunca falar desligado.', 14), completed('fourth-turn', 15)], turns('fourth', 'fourth-turn', 14));
    expect(f.speak).toHaveBeenCalledTimes(3);
  });
});

describe('Jarvis native GPT discovery and setup', () => {
  const normal = { id: 'native-chat-01', conversationId: 'chatgpt-realistic', engine: 'chatgpt' };
  it('keeps Gemini STT ready when an older status (before saved key) finishes after the fresh status', async () => {
    const f = await fixture({ selected: normal, google: true, noAudioEngines: true, deferredProviderStatus: true });
    expect(f.statusResolvers).toHaveLength(1);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(true);
    f.element<HTMLButtonElement>('jarvisRefreshAudio').click();
    await f.flush();
    expect(f.statusResolvers).toHaveLength(2);
    await f.finishProviderCheck(1, true);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(false);
    await f.finishProviderCheck(0, false);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(false);
    f.hold(); await f.flush(); f.release(); await f.flush();
    expect(f.transcribe.mock.calls[0]?.[0]).toBe('provider');
  });
  it('keeps Gemini STT ready when an older failed status arrives after a newer success', async () => {
    const f = await fixture({ selected: normal, google: true, noAudioEngines: true, deferredProviderStatus: true });
    f.element<HTMLButtonElement>('jarvisRefreshAudio').click();
    await f.flush();
    await f.finishProviderCheck(1, true);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(false);
    await f.rejectProviderCheck(0);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(false);
  });
  it('revokes readiness immediately when Gemini provider URL changes before the new check finishes', async () => {
    const f = await fixture({ selected: normal, google: true, noAudioEngines: true, deferredProviderStatus: true });
    await f.finishProviderCheck(0, true);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(false);
    const providerUrl = f.element<HTMLInputElement>('jarvisProviderUrl');
    providerUrl.value = 'https://another-provider.example/v1';
    providerUrl.dispatchEvent(new page!.window.Event('change'));
    await f.flush();
    expect(f.statusResolvers).toHaveLength(2);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(true);
    f.hold(); await f.flush();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    await f.finishProviderCheck(1, false);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(true);
  });
  it('shows an inactive ChatGPT-native microphone and lets the user open setup without recording', async () => {
    const f = await fixture({ selected: normal, enabled: false, consent: false });
    expect(f.element<HTMLButtonElement>('jarvisTalk').hidden).toBe(false);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(true);
    expect(f.element<HTMLButtonElement>('jarvisSetupChat').hidden).toBe(false);
    f.element<HTMLButtonElement>('jarvisSetupChat').click();
    expect(f.openSettings).toHaveBeenCalledOnce();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.element('jarvisActiveChat').textContent).toMatch(/ChatGPT/);
    f.element<HTMLButtonElement>('jarvisGoToChat').click();
    expect(f.openChat).toHaveBeenCalledOnce();
  });
  it('reports missing STT and inactive reply voice before enabling hands-free capture', async () => {
    const f = await fixture({ selected: normal, noAudioEngines: true, noProvider: true, tts: false });
    expect(f.element('jarvisReadiness').textContent).toMatch(/transcription|STT/i);
    expect(f.element('jarvisReadiness').textContent).toMatch(/speak|voice|speech|TTS/i);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(true);
    f.hold(); await f.flush();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });
  it('does not send anything if the system denies microphone permission', async () => {
    const f = await fixture({ selected: normal, microphoneDenied: true });
    f.hold(); await f.flush();
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    expect(f.sendInput).not.toHaveBeenCalled();
    expect(f.element('jarvisSettingsStatus').textContent).toMatch(/microphone access/i);
    expect(f.element('jarvisTalk').dataset.state).toBe('idle');
  });
});

describe('Jarvis native ChatGPT bridge ownership', () => {
  const normal = { id: 'native-chat-01', conversationId: 'chatgpt-realistic', engine: 'chatgpt' };
  const message = (turnId: string, text: string) => ({ kind: 'assistant_message', turnId, messageId: 'm-'+turnId,
    seq: 3, message: { text, truncated: false, chars: text.length }, final: false });

  it('passes the Gemini PT-BR transcription choice through mic, selected native chat, streaming reply and TTS', async () => {
    const f = await fixture({ selected: normal, google: true, language: 'pt-BR' });
    expect(f.element<HTMLInputElement>('jarvisSttModel').value).toBe('gemini-3.5-transcribe');
    expect(f.element<HTMLSelectElement>('jarvisSttMode').disabled).toBe(true);
    f.hold(); await f.flush(); f.release(); await f.flush();
    expect(f.transcribe).toHaveBeenCalledWith('provider', '', 'pt-BR', 'audio/webm', expect.any(Uint8Array),
      expect.objectContaining({ sttModel: 'gemini-3.5-transcribe', ttsModel: 'gemini-3.8-flash-tts', voice: 'Charon' }));
    expect(f.sendInput).toHaveBeenCalledOnce();
    const [input] = f.sendInput.mock.calls[0]!;
    expect(input).toMatchObject({ sessionId: normal.id, text: 'text from provider' });
    await f.nativeEvents([
      { kind: 'user_message', messageId: 'question-gemini', inputId: input.id, inputDelivery: 'confirmed',
        turnId: 'native-q', seq: 1 },
      message('gemini-reply', 'Ouvindo em português brasileiro. A resposta ainda continua')
    ], { 'gemini-reply': { origin: 2, time: 100, questionId: 'question-gemini' } });
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Ouvindo em português brasileiro.']);
    expect(f.speak.mock.calls[0]?.[0]).toMatchObject({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      ttsModel: 'gemini-3.8-flash-tts', voice: 'Charon' });
    await f.nativeEvents([
      { kind: 'user_message', messageId: 'question-gemini', inputId: input.id, inputDelivery: 'confirmed', turnId: 'native-q', seq: 1 },
      message('gemini-reply', 'Ouvindo em português brasileiro. A resposta ainda continua')
    ], { 'gemini-reply': { origin: 2, time: 100, questionId: 'question-gemini' } });
    expect(f.speak).toHaveBeenCalledOnce();
  });

  it('speaks the real response turn linked by questionId when the native user turn id differs', async () => {
    const f = await fixture({ selected: normal, g4f: true });
    f.hold(); await f.flush(); f.release(); await f.flush();
    const [input] = f.sendInput.mock.calls[0]!;
    await f.nativeEvents([
      { kind: 'user_message', messageId: 'native-question-17', inputId: input.id, inputDelivery: 'confirmed',
        turnId: 'native-user-turn-uuid', seq: 1 },
      message('provider-response-turn-18', 'Agora a voz deve sair pelo provedor G4F. Ainda em andamento')
    ], { 'provider-response-turn-18': { origin: 2, time: 100, questionId: 'native-question-17' } });
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Agora a voz deve sair pelo provedor G4F.']);
  });

  it('waits for the persisted question link instead of reading an unrelated response', async () => {
    const f = await fixture({ selected: normal, g4f: true });
    f.hold(); await f.flush(); f.release(); await f.flush();
    const [input] = f.sendInput.mock.calls[0]!;
    const rows = [
      { kind: 'user_message', messageId: 'question-claimed', inputId: input.id, inputDelivery: 'confirmed',
        turnId: 'user-message-uuid', seq: 1 },
      message('response-owned', 'Esta resposta pertence ao Jarvis. Continuando'),
      message('response-foreign', 'Esta resposta pertence a outro turno. Continuando')
    ];
    await f.nativeEvents(rows, { 'response-foreign': { origin: 2, time: 100, questionId: 'other-question' } });
    expect(f.speak).not.toHaveBeenCalled();
    await f.nativeEvents(rows, { 'response-owned': { origin: 2, time: 100, questionId: 'question-claimed' },
      'response-foreign': { origin: 3, time: 101, questionId: 'other-question' } });
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Esta resposta pertence ao Jarvis.']);
  });

  it('refuses two distinct response turns claiming the same question', async () => {
    const f = await fixture({ selected: normal, g4f: true });
    f.hold(); await f.flush(); f.release(); await f.flush();
    const [input] = f.sendInput.mock.calls[0]!;
    await f.nativeEvents([
      { kind: 'user_message', messageId: 'question-ambiguous', inputId: input.id,
        inputDelivery: 'confirmed', turnId: 'user-message-uuid', seq: 1 },
      message('response-one', 'Primeira resposta, que ainda nao tem dono comprovado. Continuando'),
      message('response-two', 'Segunda resposta, que ainda nao tem dono comprovado. Continuando')
    ], { 'response-one': { origin: 2, time: 100, questionId: 'question-ambiguous' },
      'response-two': { origin: 3, time: 101, questionId: 'question-ambiguous' } });
    expect(f.speak).not.toHaveBeenCalled();
  });

  it('sends STT through the native outbox and speaks only its confirmed input turn', async () => {
    const f = await fixture({ selected: normal, g4f: true });
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(false);
    f.hold(); await f.flush(); f.release(); await f.flush();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.sendInput).toHaveBeenCalledOnce();
    const [input] = f.sendInput.mock.calls[0]!;
    expect(input).toMatchObject({ sessionId: normal.id, text: 'text from provider', mode: 'auto', model: null, reasoningEffort: null });
    expect(f.tracks[0]?.stop).toHaveBeenCalled();
    await f.nativeEvents([message('wrong-turn', 'Resposta de outra pessoa. Não falar.')]);
    expect(f.speak).not.toHaveBeenCalled();
    await f.nativeEvents([
      { kind: 'user_message', inputId: input.id, inputDelivery: 'offered', turnId: 'native-turn', seq: 2 },
      message('native-turn', 'Ainda sem confirmação de envio. Não falar.')
    ]);
    expect(f.speak).not.toHaveBeenCalled();
    await f.nativeEvents([
      { kind: 'user_message', messageId: 'native-question', inputId: input.id, inputDelivery: 'confirmed', turnId: 'native-question-uuid', seq: 2 },
      message('wrong-turn', 'Outra resposta não pode falar.'),
      message('native-turn', 'Resposta correta, do mesmo turno. Em andamento')
    ], { 'native-turn': { origin: 2, time: 100, questionId: 'native-question' },
      'wrong-turn': { origin: 3, time: 101, questionId: 'other-question' } });
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Resposta correta, do mesmo turno.']);
  });

  it('drops stale native responses after a new PTT and does not resend queued input', async () => {
    const f = await fixture({ selected: normal });
    f.hold(); await f.flush(); f.release(); await f.flush();
    const [first] = f.sendInput.mock.calls[0]!;
    f.hold(); await f.flush();
    await f.nativeEvents([{ kind: 'user_message', messageId: 'question-old', inputId: first.id,
      inputDelivery: 'confirmed', turnId: 'native-uuid-old', seq: 1 }, message('old', 'Fala antiga bloqueada.')],
    { old: { origin: 1, time: 100, questionId: 'question-old' } });
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.element('jarvisTalk').dataset.state).toBe('listening');
    expect(f.sendInput).toHaveBeenCalledTimes(1);
    f.release(); await f.flush();
    const [second] = f.sendInput.mock.calls[1]!;
    await f.nativeEvents([{ kind: 'user_message', messageId: 'question-new', inputId: second.id,
      inputDelivery: 'confirmed', turnId: 'native-uuid-new', seq: 1 }, message('new', 'Só a fala nova será ouvida. Continua')],
    { new: { origin: 2, time: 200, questionId: 'question-new' } });
    await f.flush();
    expect(f.element('jarvisSettingsStatus').textContent).toContain('delivered to ChatGPT');
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Só a fala nova será ouvida.']);
  });

  it('refuses microphone and native sends without session consent', async () => {
    const f = await fixture({ selected: normal, consent: false });
    f.hold(); await f.flush();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.sendInput).not.toHaveBeenCalled();
  });

  it('does not speak after a rejected native outbox write', async () => {
    const f = await fixture({ selected: normal });
    f.sendInput.mockResolvedValueOnce({ ok: false as const, error: 'native bridge unavailable' } as never);
    f.hold(); await f.flush(); f.release(); await f.flush();
    expect(f.sendInput).toHaveBeenCalledOnce();
    await f.nativeEvents([message('arbitrary', 'An unrelated answer must remain silent.')]);
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.element('jarvisTalk').dataset.state).toBe('idle');
  });

  it('revokes voice output after microphone consent is withdrawn while delivery is pending', async () => {
    const f = await fixture({ selected: normal });
    f.hold(); await f.flush(); f.release(); await f.flush();
    const [input] = f.sendInput.mock.calls[0]!;
    const consent = f.element<HTMLInputElement>('jarvisConsent');
    consent.checked = false; consent.dispatchEvent(new page!.window.Event('change')); await f.flush();
    await f.nativeEvents([{ kind: 'user_message', inputId: input.id, inputDelivery: 'confirmed', turnId: 'late', seq: 1 },
      message('late', 'Nunca falar depois de revogar.')]);
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    expect(f.tracks[0]?.stop).toHaveBeenCalled();
    expect(f.element('jarvisTalk').dataset.state).toBe('idle');
  });

  it('times out an unconfirmed native input without retrying or inventing a reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await fixture({ selected: normal });
    f.hold(); await f.flush(); f.release(); await f.flush();
    expect(f.element('jarvisTalk').dataset.state).toBe('thinking');
    vi.advanceTimersByTime(120_100); await f.flush();
    expect(f.element('jarvisSettingsStatus').textContent).toMatch(/did not confirm/);
    expect(f.element('jarvisTalk').dataset.state).toBe('idle');
    expect(f.sendInput).toHaveBeenCalledOnce();
    expect(f.speak).not.toHaveBeenCalled();
  });
});

describe('Jarvis voice provider in the conversation', () => {
  it('shows only verified provider-key presence as a visual mask without entering a secret', async () => {
    const saved = await fixture({ g4f: true });
    const primary = saved.element<HTMLInputElement>('jarvisProviderKey');
    const fallback = saved.element<HTMLInputElement>('jarvisProviderFallbackKey');
    expect(primary.placeholder).toBe('••••••••');
    expect(fallback.placeholder).toBe('••••••••');
    expect(primary.value).toBe('');
    expect(fallback.value).toBe('');
    const absent = await fixture({ noProvider: true });
    expect(absent.element<HTMLInputElement>('jarvisProviderKey').placeholder).toBe('');
    expect(absent.element<HTMLInputElement>('jarvisProviderFallbackKey').placeholder).toBe('');
    const unreadable = await fixture({ g4f: true, providerUnavailable: true });
    expect(unreadable.element<HTMLInputElement>('jarvisProviderKey').placeholder).toBe('');
    expect(unreadable.element<HTMLInputElement>('jarvisProviderFallbackKey').placeholder).toBe('');
    expect(unreadable.element('jarvisProviderStatus').textContent).toContain('Vault unreadable');
    expect(unreadable.element('jarvisProviderStatus').textContent).not.toContain('No primary key saved');
  });

  it('uses g4f voice in the current ChatGPT chat, with no forced CLIProxy migration', async () => {
    const f = await fixture({ g4f: true, consent: false, noAudioEngines: true,
      selected: { id: 'browser-chat', conversationId: 'chatgpt-realistic', engine: 'chatgpt' } });
    const create = f.element<HTMLButtonElement>('jarvisCreateCliProxyChat');
    expect(create.hidden).toBe(true);
    f.hold(); await f.flush();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.createCliProxyChat).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(true);
    const consent = f.element<HTMLInputElement>('jarvisConsent');
    consent.checked = true; consent.dispatchEvent(new page!.window.Event('change')); await f.flush();
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(false);
    f.hold(); await f.flush(); f.release(); await f.flush();
    expect(f.transcribe).toHaveBeenCalledWith('provider', '', '', 'audio/webm', expect.any(Uint8Array), expect.objectContaining({ baseUrl: 'https://g4f.space/v1' }));
    expect(f.sendInput).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'browser-chat', text: 'text from provider' }));
    expect(f.send).not.toHaveBeenCalled();
    expect(f.selectChat).not.toHaveBeenCalled();
  });

  it('does not move the selected chat or touch the microphone when CLIProxy creation fails', async () => {
    const f = await fixture({ g4f: true, createFailure: true,
      selected: { id: 'original', conversationId: null } });
    const create = f.element<HTMLButtonElement>('jarvisCreateCliProxyChat');
    create.click(); await f.flush();
    expect(f.createCliProxyChat).toHaveBeenCalledOnce();
    expect(create.disabled).toBe(false);
    expect(create.hidden).toBe(false);
    expect(f.selectChat).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(true);
  });

  it('allows ChatGPT chat while keeping g4f.space as an audio-only provider', async () => {
    const f = await fixture({ g4f: true, selected: { id: 'browser-chat', conversationId: 'chatgpt-realistic', engine: 'chatgpt' } });
    const button = f.element<HTMLButtonElement>('jarvisTalk');
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(f.element('jarvisStatus').textContent).not.toMatch(/CLIProxy.*required/);
    f.hold(); await f.flush();
    expect(f.getUserMedia).toHaveBeenCalledOnce();
  });

  it('guides session-only consent and does not request a microphone until expressly checked', async () => {
    const f = await fixture({ g4f: true, consent: false, noAudioEngines: true });
    expect(f.element('jarvisStatus').textContent).toMatch(/consent/i);
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(true);
    f.hold(); await f.flush();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    const consent = f.element<HTMLInputElement>('jarvisConsent');
    consent.checked = true; consent.dispatchEvent(new page!.window.Event('change'));
    await f.flush();
    expect(f.element<HTMLButtonElement>('jarvisTalk').disabled).toBe(false);
    f.hold(); await f.flush();
    expect(f.getUserMedia).toHaveBeenCalledTimes(1);
    f.release(); await f.flush();
    expect(f.transcribe).toHaveBeenCalledWith('provider', '', '', 'audio/webm', expect.any(Uint8Array), expect.objectContaining({ baseUrl: 'https://g4f.space/v1' }));
  });

  it('rejects an old CLIProxy send receipt after a new PTT interrupts thinking', async () => {
    let resolveOld!: (result: { ok: true; data: { turnId: string } }) => void;
    const oldReceipt = new Promise<{ ok: true; data: { turnId: string } }>(resolve => { resolveOld = resolve; });
    const f = await fixture();
    f.send.mockImplementationOnce(() => oldReceipt);
    f.send.mockResolvedValue({ ok: true, data: { turnId: 'turn-02' } });
    f.hold(); await f.flush(); f.release(); await f.flush();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.element('jarvisTalk').dataset.state).toBe('thinking');
    f.hold(); await f.flush();
    expect(f.element('jarvisTalk').dataset.state).toBe('listening');
    resolveOld({ ok: true, data: { turnId: 'turn-01' } });
    await f.flush();
    await f.stream('Esta resposta antiga não pode voltar a falar. Ainda gerando');
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.element('jarvisTalk').dataset.state).toBe('listening');
    f.release(); await f.flush();
    expect(f.send).toHaveBeenCalledTimes(2);
    await f.stream('Agora somente o novo turno deve falar. Texto parcial', false, false, 'turn-02');
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Agora somente o novo turno deve falar.']);
  });

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
    // Two sentences may be synthesized ahead while the first still plays.
    expect(f.speak.mock.calls.map(call => call[1])).toEqual(['Olá, eu sou o Jarvis.', 'Estou pronto para ajudar.', 'Fim']);
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
