import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const vault = vi.hoisted(() => ({
  entries: new Map<string, { name: string; value: string; origin: string; header: string }>(),
  put: vi.fn()
}));
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn() } }));
vi.mock('../src/main/marks-vault.js', () => ({
  vaultStatus: async () => ({ created: true, count: vault.entries.size, ready: true }),
  useVault: async (name: string, operation: (entry: unknown) => Promise<string>) => {
    const entry = vault.entries.get(name);
    if (!entry) throw new Error('Secret not found');
    return operation(entry);
  },
  putVault: vault.put
}));

import { configureJarvisVoiceForTests, jarvisVoiceStatus, jarvisVoiceRouteStatus, speakJarvisVoice, streamJarvisVoice, storeJarvisVoiceKey, transcribeJarvisVoice } from '../src/main/jarvis-voice.js';
import { JARVIS_VOICE_VAULT, type JarvisVoiceConfig, type JarvisVoiceRouting } from '../src/shared/jarvis-voice.js';

// Test-only placeholder tokens: never real provider credentials.
const PRIMARY = 'test-primary-token';
const FALLBACK = 'test-fallback-token';

type Seen = { method: string; url: string; auth: string; body: Buffer; type: string };
let server: Server;
let base = '';
let seen: Seen[] = [];
let primaryStatus = 200;
let transcriptText = 'olá jarvis';
let rejectWebm = false;

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise(resolve => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => resolve(Buffer.concat(chunks))); });
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const data = await body(request);
    const auth = request.headers.authorization ?? '';
    seen.push({ method: request.method!, url: request.url!, auth, body: data, type: request.headers['content-type'] ?? '' });
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (auth === `Bearer ${PRIMARY}` && primaryStatus !== 200) return json(primaryStatus, { error: { message: 'key rejected' } });
    if (auth !== `Bearer ${PRIMARY}` && auth !== `Bearer ${FALLBACK}`) return json(401, { error: { message: 'missing key' } });
    if (request.url === '/v1/models') return json(200, { data: [{ id: 'gpt-5' }, { id: 'gpt-4o-mini-tts' }, { id: 'whisper-1' }, { id: 'srv_x:models/gemini-flash-latest' }] });
    if (request.url === '/v1/audio/transcriptions') {
      const text = data.toString('latin1');
      if (rejectWebm && text.includes('filename="jarvis.webm"')) return json(200, { text: '' });
      return json(200, { text: `  ${transcriptText}  `, model: 'whisper-1' });
    }
    if (request.url === '/v1/chat/completions') return json(200, { choices: [{ message: { role: 'assistant', content: `"${transcriptText}"` } }] });
    if (request.url === '/v1/audio/speech') {
      const input = JSON.parse(data.toString()) as { input: string };
      if (input.input === 'error please') return json(500, { error: { message: 'synthesis failed' } });
      response.writeHead(200, { 'content-type': 'audio/mpeg' });
      response.write(Buffer.from('ID3'));
      setTimeout(() => response.end(Buffer.from(input.input)), 5);
      return;
    }
    json(404, { error: { message: 'not found' } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
afterEach(() => { seen = []; primaryStatus = 200; transcriptText = 'olá jarvis'; rejectWebm = false; vault.entries.clear(); vault.put.mockReset(); configureJarvisVoiceForTests(null); });

const config = (patch: Partial<JarvisVoiceConfig> = {}): JarvisVoiceConfig => ({ baseUrl: `${base}/v1`, sttMode: 'transcriptions', sttModel: 'whisper-1', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy', ...patch });
function keys(origin = base, both = true): void {
  vault.entries.set(JARVIS_VOICE_VAULT.primary, { name: JARVIS_VOICE_VAULT.primary, value: PRIMARY, origin, header: 'Authorization' });
  if (both) vault.entries.set(JARVIS_VOICE_VAULT.fallback, { name: JARVIS_VOICE_VAULT.fallback, value: FALLBACK, origin, header: 'Authorization' });
}
const signal = () => new AbortController().signal;

describe('Google Gemini TTS provider contract', () => {
  const google = (): JarvisVoiceConfig => ({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', sttMode: 'transcriptions', sttModel: '', ttsModel: 'gemini-3.8-flash-tts', voice: 'Charon' });
  it('stores four origin-bound credentials, publishes only boolean presence, and uses ordered fallback for 401', async () => {
    const origin = 'https://generativelanguage.googleapis.com';
    const slots = ['primary', 'fallback', 'fallback2', 'fallback3'] as const;
    const attempts: string[] = [];
    for (const [index, slot] of slots.entries()) {
      const value = `fixture-only-${index}`;
      vault.entries.set(JARVIS_VOICE_VAULT[slot], { name: JARVIS_VOICE_VAULT[slot], value, origin, header: 'x-goog-api-key' });
    }
    configureJarvisVoiceForTests({ fetch: async (_url, init) => {
      const key = (init?.headers as Record<string, string>)['x-goog-api-key']!;
      attempts.push(key);
      return key === 'fixture-only-3' ? Response.json({ output_text: 'funcionou' }) : Response.json({ error: { message: 'invalid key' } }, { status: 401 });
    } });
    const status = await jarvisVoiceStatus({ ...google(), sttModel: 'gemini-3.5-transcribe' });
    expect(status).toMatchObject({ primary: true, fallback: true, fallback2: true, fallback3: true });
    for (const slot of slots) expect(JSON.stringify(status)).not.toContain(vault.entries.get(JARVIS_VOICE_VAULT[slot])!.value);
    expect(await transcribeJarvisVoice({ ...google(), sttModel: 'gemini-3.5-transcribe' }, 'audio/webm', new Uint8Array([1]), 'pt-BR', signal())).toBe('funcionou');
    expect(attempts).toEqual(['fixture-only-0', 'fixture-only-1', 'fixture-only-2', 'fixture-only-3']);
  });
  it('does not fan out Gemini HTTP 429 across multiple keys sharing project rate limits', async () => {
    const attempts: string[] = [];
    configureJarvisVoiceForTests({
      credential: async slot => ({ header: 'x-goog-api-key', value: slot }),
      fetch: async (_url, options) => {
        attempts.push((options?.headers as Record<string, string>)['x-goog-api-key']!);
        return Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'retry-after': '30' } });
      }
    });
    await expect(transcribeJarvisVoice({ ...google(), sttModel: 'gemini-3.5-transcribe' }, 'audio/webm', new Uint8Array([1]), 'pt-BR', signal())).rejects.toThrow('429');
    expect(attempts).toEqual(['primary']);
  });
  it('requires an origin-bound vault credential', async () => {
    await expect(speakJarvisVoice(google(), 'Olá.', signal())).rejects.toThrow('Save your Google AI Studio key');
  });
  it('sends the Google API key header and decodes the WAV from Interactions', async () => {
    configureJarvisVoiceForTests({
      credential: async (_slot, origin) => origin === 'https://generativelanguage.googleapis.com' ? { header: 'x-goog-api-key', value: PRIMARY } : null,
      fetch: async (url, options) => {
        expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
        expect((options?.headers as Record<string, string>)['x-goog-api-key']).toBe(PRIMARY);
        const request = JSON.parse(String(options?.body));
        expect(request.model).toBe('gemini-3.8-flash-tts');
        expect(request.generation_config.speech_config[0].voice).toBe('Charon');
        expect(request.input[0].content[0].text).toBe('Olá.');
        return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.from('RIFF-synthetic-WAV').toString('base64') }] }] });
      }
    });
    const audio = await speakJarvisVoice(google(), 'Olá.', signal());
    expect(audio.mime).toBe('audio/wav');
    expect(Buffer.from(audio.bytes).toString()).toBe('RIFF-synthetic-WAV');
  });
  it('transcribes microphone WebM in PT-BR through Google Interactions with a vault-scoped key', async () => {
    const fetchStub = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
      expect((options?.headers as Record<string, string>)['x-goog-api-key']).toBe(PRIMARY);
      expect((options?.headers as Record<string, string>).Authorization).toBeUndefined();
      const request = JSON.parse(String(options?.body));
      expect(request.model).toBe('gemini-3.5-transcribe');
      expect(request.input).toEqual([{ type: 'audio', mime_type: 'audio/webm', data: 'AQID' }]);
      expect(request.generation_config).toEqual({ transcription_config: { language_codes: ['pt-BR'], mode: 'verbatim' } });
      return Response.json({ output_text: '  "Olá, Jarvis!"  ' });
    });
    configureJarvisVoiceForTests({
      credential: async (_slot, origin) => origin === 'https://generativelanguage.googleapis.com' ? { header: 'x-goog-api-key', value: PRIMARY } : null,
      fetch: fetchStub as typeof fetch
    });
    expect(await transcribeJarvisVoice({ ...google(), sttModel: 'gemini-3.5-transcribe' }, 'audio/webm', new Uint8Array([1, 2, 3]), 'pt-BR', signal())).toBe('Olá, Jarvis!');
    expect(fetchStub).toHaveBeenCalledOnce();
  });
  it('accepts Interactions model_output transcript and rejects empty or obsolete candidates', async () => {
    const responses = [
      { steps: [{ type: 'model_output', content: [{ type: 'text', text: '  Olá de novo.  ' }] }] },
      { candidates: [{ content: { parts: [{ text: 'Legacy output must not count.' }] } }] }
    ];
    configureJarvisVoiceForTests({
      credential: async () => ({ header: 'x-goog-api-key', value: PRIMARY }),
      fetch: async () => Response.json(responses.shift())
    });
    const config = { ...google(), sttModel: 'gemini-3.5-transcribe' };
    expect(await transcribeJarvisVoice(config, 'audio/ogg', new Uint8Array([1]), 'pt-BR', signal())).toBe('Olá de novo.');
    await expect(transcribeJarvisVoice(config, 'audio/ogg', new Uint8Array([1]), 'pt-BR', signal()))
      .rejects.toThrow('returned no text');
  });
  it('rejects missing Google keys without uploading recorded speech', async () => {
    const fetchStub = vi.fn();
    configureJarvisVoiceForTests({ credential: async () => null, fetch: fetchStub });
    await expect(transcribeJarvisVoice({ ...google(), sttModel: 'gemini-3.5-transcribe' }, 'audio/wav', new Uint8Array([1]), 'pt-BR', signal()))
      .rejects.toThrow('Save your Google AI Studio key');
    expect(fetchStub).not.toHaveBeenCalled();
  });
  it('does not mistake a TTS model for Gemini microphone transcription', async () => {
    const fetchStub = vi.fn();
    configureJarvisVoiceForTests({ credential: async () => ({ header: 'x-goog-api-key', value: PRIMARY }), fetch: fetchStub });
    await expect(transcribeJarvisVoice({ ...google(), sttModel: 'gemini-3.8-flash-tts' }, 'audio/wav', new Uint8Array([1]), 'pt-BR', signal()))
      .rejects.toThrow('audio-understanding model');
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('Jarvis voice provider (fake OpenAI-compatible server)', () => {
  it('lists models with the vault key and ranks speech models first, without returning the key', async () => {
    keys();
    configureJarvisVoiceForTests({ ffmpeg: async () => true });
    const status = await jarvisVoiceStatus(config());
    expect(status).toMatchObject({ primary: true, fallback: true, ffmpeg: true, error: null });
    expect(status.tts[0]).toBe('gpt-4o-mini-tts');
    expect(status.stt[0]).toBe('whisper-1');
    expect(JSON.stringify(status)).not.toContain(PRIMARY);
    expect(seen.map(row => [row.method, row.url, row.auth])).toEqual([['GET', '/v1/models', `Bearer ${PRIMARY}`]]);
  });

  it('transcribes a recording as multipart audio and returns trimmed text', async () => {
    keys();
    const text = await transcribeJarvisVoice(config(), 'audio/webm', new Uint8Array([1, 2, 3]), 'pt-BR', signal());
    expect(text).toBe('olá jarvis');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/v1/audio/transcriptions');
    expect(seen[0]!.type).toMatch(/^multipart\/form-data/);
    const form = seen[0]!.body.toString('latin1');
    expect(form).toContain('name="model"\r\n\r\nwhisper-1');
    expect(form).toContain('name="language"\r\n\r\npt');
    expect(form).toContain('filename="jarvis.webm"');
  });

  it('uses the fallback key when the primary key answers 401 (also 403, 429 and 5xx)', async () => {
    keys();
    for (const status of [401, 403, 429, 503]) {
      seen = [];
      primaryStatus = status;
      expect(await transcribeJarvisVoice(config(), 'audio/ogg', new Uint8Array([1]), '', signal())).toBe('olá jarvis');
      expect(seen.map(row => row.auth)).toEqual([`Bearer ${PRIMARY}`, `Bearer ${FALLBACK}`]);
    }
  });

  it('does not retry a primary-key 400 with the fallback, and reports the provider error without secrets', async () => {
    keys();
    primaryStatus = 400;
    await expect(speakJarvisVoice(config(), 'Oi.', signal())).rejects.toThrow('Voice provider speech returned HTTP 400: key rejected');
    expect(seen).toHaveLength(1);
  });

  it('converts a format the provider cannot read to WAV with ffmpeg and sends it once more', async () => {
    keys();
    rejectWebm = true;
    const toWav = vi.fn(async () => new Uint8Array([82, 73, 70, 70]));
    configureJarvisVoiceForTests({ ffmpeg: async () => true, toWav });
    expect(await transcribeJarvisVoice(config(), 'audio/webm', new Uint8Array([9]), '', signal())).toBe('olá jarvis');
    expect(toWav).toHaveBeenCalledOnce();
    expect(seen.map(row => /filename="(jarvis\.\w+)"/.exec(row.body.toString('latin1'))?.[1])).toEqual(['jarvis.webm', 'jarvis.wav']);
  });

  it('says so when the provider returns no text and ffmpeg is missing', async () => {
    keys();
    rejectWebm = true;
    configureJarvisVoiceForTests({ ffmpeg: async () => false });
    await expect(transcribeJarvisVoice(config(), 'audio/webm', new Uint8Array([9]), '', signal())).rejects.toThrow('returned no text');
  });

  it('transcribes with a multimodal chat model using WAV input_audio', async () => {
    keys();
    configureJarvisVoiceForTests({ ffmpeg: async () => true, toWav: async () => new Uint8Array([82, 73, 70, 70]) });
    const text = await transcribeJarvisVoice(config({ sttMode: 'chat-audio', sttModel: 'srv_x:models/gemini-flash-latest' }), 'audio/webm', new Uint8Array([1]), 'pt-BR', signal());
    expect(text).toBe('olá jarvis');
    const sent = JSON.parse(seen[0]!.body.toString()) as { model: string; messages: { content: { type: string; input_audio?: { format: string; data: string } }[] }[] };
    expect(seen[0]!.url).toBe('/v1/chat/completions');
    expect(sent.model).toBe('srv_x:models/gemini-flash-latest');
    expect(sent.messages[0]!.content[1]).toEqual({ type: 'input_audio', input_audio: { format: 'wav', data: 'UklGRg==' } });
  });

  it('synthesizes one sentence as audio bytes from a streamed response', async () => {
    keys();
    const audio = await speakJarvisVoice(config(), 'Olá, mundo.', signal());
    expect(audio.mime).toBe('audio/mpeg');
    expect(Buffer.from(audio.bytes).toString()).toBe('ID3Olá, mundo.');
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ model: 'gpt-4o-mini-tts', input: 'Olá, mundo.', voice: 'alloy', response_format: 'mp3' });
  });

  it('publishes early speech chunks in order before the HTTP response completes', async () => {
    keys();
    let finish: (() => void) | undefined;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([73, 68, 51]));
        finish = () => { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); };
      }
    }), { headers: { 'content-type': 'audio/mpeg' } });
    configureJarvisVoiceForTests({ fetch: async () => response });
    const events: string[] = [];
    const run = streamJarvisVoice(config(), 'Olá.', 'synthetic-id', signal(), event => {
      events.push(event.type === 'chunk' ? `chunk:${event.bytes.length}` : event.type);
    });
    await vi.waitFor(() => expect(events).toEqual(['start', 'chunk:3']));
    finish!();
    const timings = await run;
    expect(events).toEqual(['start', 'chunk:3', 'chunk:3', 'end']);
    expect(timings).toMatchObject({ bytes: 6 });
    expect(timings.firstByteMs).toBeGreaterThanOrEqual(0);
  });

  it('aborts an in-flight speech response and never publishes a late end', async () => {
    keys();
    const controller = new AbortController();
    configureJarvisVoiceForTests({ fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new Uint8Array([73, 68, 51])); }
    }), { headers: { 'content-type': 'audio/mpeg' } }) });
    const events: string[] = [];
    const run = streamJarvisVoice(config(), 'Cancelar.', 'turn-old', controller.signal, event => {
      events.push(event.type);
      if (event.type === 'chunk') controller.abort();
    });
    await expect(run).rejects.toThrow();
    expect(events).toEqual(['start', 'chunk']);
  });
  it('exits promptly when a streaming provider stalls mid-body and the turn is cancelled', async () => {
    keys();
    const turn = new AbortController();
    configureJarvisVoiceForTests({ fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new Uint8Array([73, 68, 51])); }
      // Deliberately never close or release the following reader.read().
    }), { headers: { 'content-type': 'audio/mpeg' } }) });
    const events: string[] = [];
    const run = streamJarvisVoice(config(), 'Turno cancelado.', 'stall-turn', turn.signal, event => {
      events.push(event.type);
      if (event.type === 'chunk') queueMicrotask(() => turn.abort());
    });
    await expect(Promise.race([
      run.then(() => 'completed', () => 'cancelled'),
      new Promise<string>(resolve => setTimeout(() => resolve('stalled'), 100))
    ])).resolves.toBe('cancelled');
    expect(events).toEqual(['start', 'chunk']);
  });

  it('never sends a key bound to another origin', async () => {
    keys('https://other.example');
    await expect(transcribeJarvisVoice(config(), 'audio/webm', new Uint8Array([1]), '', signal())).rejects.toThrow('belongs to another address');
    expect(seen).toHaveLength(0);
  });

  it('stores keys in the vault bound to the exact provider origin with an Authorization header', async () => {
    await storeJarvisVoiceKey('primary', 'https://g4f.space/v1', `Bearer ${PRIMARY}`, 'master-password-for-tests');
    expect(vault.put).toHaveBeenCalledWith({ name: 'jarvis/voice-primary', value: PRIMARY, origin: 'https://g4f.space', header: 'Authorization' }, 'master-password-for-tests');
    await expect(storeJarvisVoiceKey('fallback', 'http://g4f.space/v1', FALLBACK, 'x')).rejects.toThrow('HTTPS');
    await expect(storeJarvisVoiceKey('fallback', 'https://g4f.space/v1', 'two words', 'x')).rejects.toThrow('one token');
  });
});


describe('Jarvis provider routing across Gemini and two G4F accounts', () => {
  const google = (): JarvisVoiceConfig => ({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', sttMode: 'transcriptions', sttModel: 'gemini-3.5-transcribe', ttsModel: 'gemini-3.8-flash-tts', voice: 'Charon' });
  const routing = (mode: 'off' | 'gemini-first' | 'g4f-first'): JarvisVoiceRouting => ({ mode, g4f: [
    { baseUrl: 'https://g4f-test.example/v1', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy' },
    { baseUrl: 'https://g4f-test.example/v1', ttsModel: 'gpt-4o-mini-tts', voice: 'nova' }
  ] });
  it('uses a saved later Gemini slot when primary is absent and pins it across one answer', async () => {
    const attempts: string[] = [];
    configureJarvisVoiceForTests({
      credential: async slot => slot === 'fallback2' ? { header: 'x-goog-api-key', value: 'fixture-fallback2' } : null,
      fetch: async (_url, init) => {
        attempts.push((init?.headers as Record<string, string>)['x-goog-api-key'] ?? 'missing');
        return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.from('RIFFtest').toString('base64') }] }] });
      }
    });
    const groupId = crypto.randomUUID();
    await speakJarvisVoice(google(), 'Primeira', signal(), routing('gemini-first'), groupId);
    await speakJarvisVoice(google(), 'Segunda', signal(), routing('gemini-first'), groupId);
    expect(attempts).toEqual(['fixture-fallback2', 'fixture-fallback2']);
  });
  it('recovers from Gemini key-specific HTTP 401 without switching voice inside the answer', async () => {
    const attempts: string[] = [];
    configureJarvisVoiceForTests({
      credential: async slot => ['primary', 'fallback'].includes(slot) ? { header: 'x-goog-api-key', value: `fixture-${slot}` } : null,
      fetch: async (_url, init) => {
        const key = (init?.headers as Record<string, string>)['x-goog-api-key']!;
        attempts.push(key);
        return key === 'fixture-primary'
          ? Response.json({ error: { message: 'invalid credential' } }, { status: 401 })
          : Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.from('RIFFtest').toString('base64') }] }] });
      }
    });
    const groupId = crypto.randomUUID();
    await speakJarvisVoice(google(), 'Primeira', signal(), routing('gemini-first'), groupId);
    await speakJarvisVoice(google(), 'Segunda', signal(), routing('gemini-first'), groupId);
    expect(attempts).toEqual(['fixture-primary', 'fixture-fallback', 'fixture-fallback']);
  });
  it('never uses a primary key bound to another origin when a valid Gemini fallback exists', async () => {
    const attempts: string[] = [];
    configureJarvisVoiceForTests({
      credential: async slot => {
        if (slot === 'primary') throw new Error('The saved primary voice key belongs to another address.');
        return slot === 'fallback' ? { header: 'x-goog-api-key', value: 'fixture-gemini-fallback' } : null;
      },
      fetch: async (_url, init) => {
        attempts.push((init?.headers as Record<string, string>)['x-goog-api-key'] ?? 'unauthenticated');
        return Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.from('RIFFtest').toString('base64') }] }] });
      }
    });
    const speech = await speakJarvisVoice(google(), 'Validar origem', signal(), routing('gemini-first'));
    expect(speech.mime).toBe('audio/wav');
    expect(attempts).toEqual(['fixture-gemini-fallback']);
  });
  it('keeps two G4F credentials separate even on the same host, never returns secrets', async () => {
    configureJarvisVoiceForTests({ credential: async slot => slot === 'g4f1' || slot === 'g4f2' ? { header: 'Authorization', value: `fixture-${slot}` } : null });
    expect(await jarvisVoiceRouteStatus(routing('g4f-first'))).toEqual({ g4f1: true, g4f2: true, error: null });
  });
  it('falls back to independent G4F when Gemini is rate limited, without trying multiple Gemini keys', async () => {
    const seen: { origin: string; key: string }[] = [];
    configureJarvisVoiceForTests({ credential: async slot => ({ header: slot.startsWith('g4f') ? 'Authorization' : 'x-goog-api-key', value: `fixture-${slot}` }),
      fetch: async (url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.push({ origin: new URL(String(url)).origin, key: headers['x-goog-api-key'] ?? headers.Authorization ?? '' });
        return String(url).includes('generativelanguage') ? Response.json({ error: { message: 'rate limited' } }, { status: 429 })
          : new Response(Buffer.from('ID3audio'), { headers: { 'content-type': 'audio/mpeg' } });
      } });
    const result = await speakJarvisVoice(google(), 'Olá', signal(), routing('gemini-first'));
    expect(result.mime).toBe('audio/mpeg');
    expect(seen).toEqual([
      { origin: 'https://generativelanguage.googleapis.com', key: 'fixture-primary' },
      { origin: 'https://g4f-test.example', key: 'Bearer fixture-g4f1' }
    ]);
  });
  it('honors provider Retry-After across answers and avoids re-requesting a cooled-down Gemini project', async () => {
    const seen: string[] = [];
    configureJarvisVoiceForTests({ credential: async slot => ({ header: slot.startsWith('g4f') ? 'Authorization' : 'x-goog-api-key', value: `fixture-${slot}` }),
      fetch: async (url) => {
        seen.push(new URL(String(url)).origin);
        return String(url).includes('generativelanguage') ? Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'retry-after': '3600' } })
          : new Response(Buffer.from('ID3audio'), { headers: { 'content-type': 'audio/mpeg' } });
      } });
    await speakJarvisVoice(google(), 'Primeiro', signal(), routing('gemini-first'));
    await speakJarvisVoice(google(), 'Segundo', signal(), routing('gemini-first'));
    expect(seen).toEqual(['https://generativelanguage.googleapis.com', 'https://g4f-test.example', 'https://g4f-test.example']);
  });
  it('recovers after the Retry-After window without replaying prior speech or credentials', async () => {
    let clock = Date.now();
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const origins: string[] = [];
      configureJarvisVoiceForTests({ credential: async slot => ({ header: slot.startsWith('g4f') ? 'Authorization' : 'x-goog-api-key', value: `fixture-${slot}` }),
        fetch: async url => {
          const origin = new URL(String(url)).origin;
          origins.push(origin);
          if (origin.includes('generativelanguage') && origins.filter(x => x === origin).length === 1)
            return Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'retry-after': '2' } });
          return origin.includes('generativelanguage')
            ? Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.from('RIFFtest').toString('base64') }] }] })
            : new Response(Buffer.from('ID3audio'), { headers: { 'content-type': 'audio/mpeg' } });
        } });
      await speakJarvisVoice(google(), 'Um', signal(), routing('gemini-first'));
      clock += 1_000;
      await speakJarvisVoice(google(), 'Dois', signal(), routing('gemini-first'));
      clock += 2_000;
      await speakJarvisVoice(google(), 'Tres', signal(), routing('gemini-first'));
      expect(origins).toEqual(['https://generativelanguage.googleapis.com', 'https://g4f-test.example', 'https://g4f-test.example', 'https://generativelanguage.googleapis.com']);
    } finally { date.mockRestore(); }
  });
  it('falls back within a bounded interval when a provider hangs before first audio', async () => {
    const origins: string[] = [];
    configureJarvisVoiceForTests({ routeTimeoutMs: 20,
      credential: async slot => ({ header: slot.startsWith('g4f') ? 'Authorization' : 'x-goog-api-key', value: `fixture-${slot}` }),
      fetch: async (url, request) => {
        const origin = new URL(String(url)).origin;
        origins.push(origin);
        if (origin.includes('generativelanguage')) return await new Promise<Response>((_resolve, reject) => {
          request?.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
        });
        return new Response(Buffer.from('ID3audio'), { headers: { 'content-type': 'audio/mpeg' } });
      } });
    const started = performance.now();
    const result = await speakJarvisVoice(google(), 'Teste', signal(), routing('gemini-first'));
    expect(result.mime).toBe('audio/mpeg');
    expect(performance.now() - started).toBeLessThan(900);
    expect(origins).toEqual(['https://generativelanguage.googleapis.com', 'https://g4f-test.example']);
  });
  it('prevents prefetch concurrency from selecting different providers for one answer', async () => {
    const id = crypto.randomUUID();
    const seen: string[] = [];
    let completeFirst: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => { completeFirst = resolve; });
    configureJarvisVoiceForTests({ credential: async slot => slot.startsWith('g4f') ? { header: 'Authorization', value: `fixture-${slot}` } : null,
      fetch: async (_url, init) => {
        const key = (init?.headers as Record<string, string>).Authorization ?? '';
        seen.push(key);
        if (seen.length === 1) await blocked;
        return new Response(Buffer.from('ID3audio'), { headers: { 'content-type': 'audio/mpeg' } });
      } });
    const first = speakJarvisVoice(google(), 'Parte um', signal(), routing('g4f-first'), id);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const second = speakJarvisVoice(google(), 'Parte dois', signal(), routing('g4f-first'), id);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(seen).toHaveLength(1);
    completeFirst!();
    await Promise.all([first, second]);
    expect(seen).toEqual(['Bearer fixture-g4f1', 'Bearer fixture-g4f1']);
  });
  it('does not change speaker/provider within a pinned answer after a later failure', async () => {
    const id = crypto.randomUUID();
    const seen: string[] = [];
    let fail = false;
    configureJarvisVoiceForTests({ credential: async slot => slot === 'g4f1' || slot === 'g4f2' ? { header: 'Authorization', value: `fixture-${slot}` } : null,
      fetch: async (_url, init) => {
        const credential = (init?.headers as Record<string, string>).Authorization;
        seen.push(credential ?? "");
        return fail ? new Response(null, { status: 503 }) : new Response(Buffer.from('ID3audio'), { headers: { 'content-type': 'audio/mpeg' } });
      } });
    await speakJarvisVoice(google(), 'Primeira frase', signal(), routing('g4f-first'), id);
    fail = true;
    await expect(speakJarvisVoice(google(), 'Segunda frase', signal(), routing('g4f-first'), id)).rejects.toThrow('503');
    expect(seen).toEqual(['Bearer fixture-g4f1', 'Bearer fixture-g4f1']);
  });
});
