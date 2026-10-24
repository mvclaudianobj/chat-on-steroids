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

import { configureJarvisVoiceForTests, jarvisVoiceStatus, speakJarvisVoice, streamJarvisVoice, storeJarvisVoiceKey, transcribeJarvisVoice } from '../src/main/jarvis-voice.js';
import { JARVIS_VOICE_VAULT, type JarvisVoiceConfig } from '../src/shared/jarvis-voice.js';

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
  it('transcribes microphone WebM in PT-BR through Google generateContent with a vault-scoped key', async () => {
    const fetchStub = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent');
      expect((options?.headers as Record<string, string>)['x-goog-api-key']).toBe(PRIMARY);
      expect((options?.headers as Record<string, string>).Authorization).toBeUndefined();
      const request = JSON.parse(String(options?.body));
      expect(request.contents[0].parts).toEqual([{ inlineData: { mimeType: 'audio/webm', data: 'AQID' } }]);
      expect(request.generationConfig).toEqual({ audioTranscriptionConfig: { languageCodes: ['pt-BR'], mode: 'VERBATIM' } });
      return Response.json({ candidates: [{ content: { parts: [{ text: '  "Olá, Jarvis!"  ' }] } }] });
    });
    configureJarvisVoiceForTests({
      credential: async (_slot, origin) => origin === 'https://generativelanguage.googleapis.com' ? { header: 'x-goog-api-key', value: PRIMARY } : null,
      fetch: fetchStub as typeof fetch
    });
    expect(await transcribeJarvisVoice({ ...google(), sttModel: 'gemini-3.5-transcribe' }, 'audio/webm', new Uint8Array([1, 2, 3]), 'pt-BR', signal())).toBe('Olá, Jarvis!');
    expect(fetchStub).toHaveBeenCalledOnce();
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
