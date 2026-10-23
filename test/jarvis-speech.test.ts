import { describe, expect, it, vi } from 'vitest';
import { allowJarvisMicrophone } from '../src/main/jarvis-permissions.js';
import { JarvisSilenceGate, JarvisSpeechQueue } from '../src/renderer/jarvis-speech.js';
import { JarvisSentenceSplitter, jarvisVoiceConfigSchema, jarvisVoiceUsesFallback, parseJarvisVoiceBaseUrl, speakableText } from '../src/shared/jarvis-voice.js';

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe('Jarvis sentence splitting for streamed answers', () => {
  it('emits only complete sentences while the answer grows and the rest at the end', () => {
    const splitter = new JarvisSentenceSplitter(10);
    expect(splitter.push('Olá, tudo bem')).toEqual([]);
    expect(splitter.push('Olá, tudo bem? Hoje vamos falar')).toEqual(['Olá, tudo bem?']);
    expect(splitter.push('Olá, tudo bem? Hoje vamos falar de voz. E')).toEqual(['Hoje vamos falar de voz.']);
    expect(splitter.finish('Olá, tudo bem? Hoje vamos falar de voz. E fim')).toEqual(['E fim']);
    expect(splitter.finish('Olá, tudo bem? Hoje vamos falar de voz. E fim')).toEqual([]);
  });

  it('never reads an unfinished code block and strips code, links and Markdown', () => {
    const splitter = new JarvisSentenceSplitter(5);
    expect(splitter.push('Veja o exemplo. ```ts\nconst a = 1. b = 2. ')).toEqual(['Veja o exemplo.']);
    expect(splitter.finish('Veja o exemplo. ```ts\nconst a = 1. b = 2. ```\n**Pronto**, veja [docs](https://x.test).')).toEqual(['Pronto, veja docs.']);
    expect(speakableText('# Título\n- item `code` https://a.b/c')).toBe('Título\nitem');
  });

  it('merges tiny sentences and cuts very long ones at word boundaries', () => {
    const splitter = new JarvisSentenceSplitter(12, 40);
    const parts = splitter.finish(`Sim. Ok. ${'palavra '.repeat(20)}fim.`);
    expect(parts[0]).toMatch(/^Sim\. Ok\./);
    expect(parts.every(part => part.length <= 40)).toBe(true);
  });
});

describe('Jarvis speech queue', () => {
  it('speaks in order and synthesizes the next sentence while the current one plays', async () => {
    const order: string[] = [];
    const playing = new Map<string, ReturnType<typeof deferred>>();
    const drained = vi.fn();
    const queue = new JarvisSpeechQueue<string>({
      synthesize: async text => { order.push(`synth:${text}`); return text; },
      play: async text => { order.push(`play:${text}`); const gate = deferred(); playing.set(text, gate); await gate.promise; }
    }, { drained });
    queue.enqueue(['A.', 'B.']);
    await tick();
    expect(order).toEqual(['synth:A.', 'synth:B.', 'play:A.']);
    queue.enqueue(['C.']);
    playing.get('A.')!.resolve(); await tick();
    expect(order).toEqual(['synth:A.', 'synth:B.', 'play:A.', 'synth:C.', 'play:B.']);
    playing.get('B.')!.resolve(); await tick();
    playing.get('C.')!.resolve(); await tick();
    expect(order.at(-1)).toBe('play:C.');
    expect(drained).toHaveBeenCalledOnce();
    expect(queue.speaking).toBe(false);
  });

  it('barge-in stops playback at once and ignores late synthesis from the old answer', async () => {
    const played: string[] = [];
    const slow = deferred();
    const speaking = vi.fn();
    const drained = vi.fn();
    const queue = new JarvisSpeechQueue<string>({
      synthesize: async (text) => { if (text === 'late.') await slow.promise; return text; },
      play: (text, signal) => new Promise(resolve => { played.push(text); signal.addEventListener('abort', () => resolve()); })
    }, { speaking, drained });
    queue.enqueue(['first.', 'late.']);
    await tick();
    expect(played).toEqual(['first.']);
    queue.stop();
    expect(speaking).toHaveBeenLastCalledWith(false);
    slow.resolve(); await tick();
    expect(played).toEqual(['first.']);
    expect(drained).not.toHaveBeenCalled();
    queue.enqueue(['new.']);
    await tick();
    expect(played).toEqual(['first.', 'new.']);
  });

  it('skips a sentence whose synthesis failed and reports it', async () => {
    const error = vi.fn();
    const played: string[] = [];
    const queue = new JarvisSpeechQueue<string>({
      synthesize: async text => { if (text === 'bad.') throw new Error('nope'); return text; },
      play: async text => { played.push(text); }
    }, { error });
    queue.enqueue(['bad.', 'good.']);
    await tick(20);
    expect(played).toEqual(['good.']);
    expect(error).toHaveBeenCalledWith(expect.any(Error), 'bad.');
  });
});

describe('Jarvis continuous conversation silence gate', () => {
  it('ends after speech followed by silence, drops silence-only recordings and bounds length', () => {
    const gate = new JarvisSilenceGate({ threshold: 0.02, silenceMs: 1000, noSpeechMs: 3000, maxMs: 10_000 });
    expect(gate.sample(0.001, 0)).toBe('silence');
    expect(gate.sample(0.1, 500)).toBe('speech');
    expect(gate.sample(0.001, 1000)).toBe('silence');
    expect(gate.sample(0.001, 2100)).toBe('end');
    const quiet = new JarvisSilenceGate({ threshold: 0.02, silenceMs: 1000, noSpeechMs: 3000, maxMs: 10_000 });
    expect(quiet.sample(0, 0)).toBe('silence');
    expect(quiet.sample(0, 3000)).toBe('no-speech');
    const long = new JarvisSilenceGate({ threshold: 0.02, silenceMs: 1000, noSpeechMs: 3000, maxMs: 2000 });
    long.sample(0.5, 0);
    expect(long.sample(0.5, 2000)).toBe('end');
  });
});

describe('Jarvis voice settings validation', () => {
  it('accepts HTTPS or loopback HTTP and refuses credentials, queries or remote HTTP', () => {
    expect(parseJarvisVoiceBaseUrl('https://g4f.space/v1/').toString()).toBe('https://g4f.space/v1');
    expect(parseJarvisVoiceBaseUrl('http://localhost:8080/v1').origin).toBe('http://localhost:8080');
    expect(() => parseJarvisVoiceBaseUrl('http://g4f.space/v1')).toThrow('HTTPS');
    expect(() => parseJarvisVoiceBaseUrl('https://user:pw@g4f.space/v1')).toThrow('credentials');
    expect(() => parseJarvisVoiceBaseUrl('https://g4f.space/v1?key=x')).toThrow('query');
    expect(() => parseJarvisVoiceBaseUrl('not a url')).toThrow('valid');
  });
  it('validates the IPC config strictly', () => {
    const good = { baseUrl: 'https://g4f.space/v1', sttMode: 'chat-audio', sttModel: 'srv_a:models/gemini-flash-latest', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy' };
    expect(jarvisVoiceConfigSchema.parse(good)).toEqual(good);
    expect(jarvisVoiceConfigSchema.safeParse({ ...good, key: 'x' }).success).toBe(false);
    expect(jarvisVoiceConfigSchema.safeParse({ ...good, baseUrl: 'ftp://x' }).success).toBe(false);
    expect(jarvisVoiceConfigSchema.safeParse({ ...good, voice: 'a b' }).success).toBe(false);
  });
  it('falls back only for rejected, rate-limited or failing primary requests', () => {
    expect([400, 401, 403, 404, 429, 500, 503].map(jarvisVoiceUsesFallback)).toEqual([false, true, true, false, true, true, true]);
  });
});

describe('Jarvis microphone permission', () => {
  const app = 'file:///opt/Chat%20Marks/resources/app.asar/out/renderer/index.html';
  const base = { permission: 'media', fromMainWindow: true, isMainFrame: true, requestingUrl: app, appUrl: app, mediaTypes: ['audio'] };
  it('allows only an audio-only request from the app page main frame', () => {
    expect(allowJarvisMicrophone(base)).toBe(true);
    expect(allowJarvisMicrophone({ ...base, requestingUrl: 'http://localhost:5173/', appUrl: 'http://localhost:5173/' })).toBe(true);
    for (const denied of [
      { ...base, permission: 'notifications' }, { ...base, mediaTypes: ['audio', 'video'] }, { ...base, mediaTypes: [] },
      { ...base, fromMainWindow: false }, { ...base, isMainFrame: false }, { ...base, requestingUrl: 'https://chatgpt.com/' },
      { ...base, requestingUrl: 'file:///tmp/other.html' }, { ...base, appUrl: '' },
      { ...base, requestingUrl: 'https://evil.test/', appUrl: 'https://evil.test/' }
    ]) expect(allowJarvisMicrophone(denied)).toBe(false);
  });
});
