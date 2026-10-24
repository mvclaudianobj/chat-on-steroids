/**
 * Jarvis J3: the user's OpenAI-compatible voice provider (speech-to-text and text-to-speech).
 * Main process only. Keys come from Vault K entries bound to the provider's exact origin; the
 * renderer sends public settings, audio or text and gets back text or audio bytes, never a key.
 */
import { spawn } from 'node:child_process';
import { putVault, useVault, vaultStatus } from './marks-vault.js';
import { logInfo, logWarn, redact } from './logger.js';
import {
  JARVIS_VOICE_VAULT, jarvisVoiceUsesFallback, parseJarvisVoiceBaseUrl, rankJarvisVoiceModels,
  type JarvisVoiceConfig, type JarvisVoiceKeySlot, type JarvisVoiceRouting
} from '../shared/jarvis-voice.js';

export type JarvisAudioMime = 'audio/webm' | 'audio/ogg' | 'audio/mp4' | 'audio/wav';
export interface VoiceCredential { header: string; value: string }
export interface JarvisVoiceStatus { models: string[]; stt: string[]; tts: string[]; primary: boolean; fallback: boolean; fallback2: boolean; fallback3: boolean; ffmpeg: boolean; error: string | null }

const MAX_JSON = 2_000_000;
const MAX_AUDIO = 16_000_000;
const MAX_TEXT = 32_000;

interface Dependencies {
  credential(slot: JarvisVoiceKeySlot, origin: string): Promise<VoiceCredential | null>;
  ffmpeg(): Promise<boolean>;
  toWav(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  fetch: typeof fetch;
}

/** A missing vault or entry means "no key"; an entry bound elsewhere is an explicit error. */
async function vaultCredential(slot: JarvisVoiceKeySlot, origin: string): Promise<VoiceCredential | null> {
  try { if (!(await vaultStatus()).ready) return null; } catch { return null; }
  let found: VoiceCredential | null = null;
  let mismatch = false;
  try {
    await useVault(JARVIS_VOICE_VAULT[slot], async entry => {
      if (entry.origin !== origin) mismatch = true; else found = { header: entry.header, value: entry.value };
      return '';
    });
  } catch { return null; }
  if (mismatch) throw new Error(`The saved ${slot} voice key belongs to another address. Save it again for this provider URL.`);
  return found;
}

let ffmpegKnown: Promise<boolean> | null = null;
function ffmpegAvailable(): Promise<boolean> {
  ffmpegKnown ??= new Promise(resolve => {
    try {
      const child = spawn('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', code => resolve(code === 0));
    } catch { resolve(false); }
  });
  return ffmpegKnown;
}

/** Decode any recorded container to 16 kHz mono WAV through ffmpeg pipes; nothing touches disk. */
function ffmpegToWav(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Transcription canceled')); return; }
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = [];
    let size = 0;
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_AUDIO * 2) { child.kill(); reject(new Error('Converted audio is too large.')); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-600); });
    child.on('error', reject);
    child.stdin.on('error', () => undefined);
    child.on('close', code => code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new Error(`ffmpeg could not convert the recording (${code}): ${error.slice(-200)}`)));
    child.stdin.end(bytes);
  });
}

const defaults: Dependencies = { credential: vaultCredential, ffmpeg: ffmpegAvailable, toWav: ffmpegToWav, fetch: (...args) => fetch(...args) };
let deps: Dependencies = defaults;
export function configureJarvisVoiceForTests(override: Partial<Dependencies> | null): void { deps = override ? { ...defaults, ...override } : defaults; routeCooldown.clear(); routeFailureReason.clear(); routePinned.clear(); routeSelectionInFlight.clear(); }

function authorization(credential: VoiceCredential | null): Record<string, string> {
  if (!credential) return {};
  return { [credential.header]: /^authorization$/i.test(credential.header) ? `Bearer ${credential.value}` : credential.value };
}

/** A short, credential-free explanation from a provider error body. */
async function failure(response: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    const text = (await readBounded(response, 8_000)).toString();
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown };
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.detail ?? parsed.message;
    if (typeof message === 'string') detail = message;
  } catch { /* not JSON */ }
  detail = redact(detail.replace(/\s+/g, ' ').trim()).slice(0, 160);
  // A status-only log allows support to distinguish model, quota, and request
  // failures without logging credentials, transcripts, or captured audio.
  logWarn(`jarvis: ${what} returned HTTP ${response.status}`);
  return new Error(`Voice provider ${what} returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`);
}

async function readBounded(response: Response, max: number): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > max) { await response.body?.cancel().catch(() => undefined); throw new Error('Voice provider response is too large.'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('Voice provider response is too large.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  return Buffer.concat(chunks);
}

/**
 * One request with the primary key; a 401/403/429/5xx is retried once with the fallback key.
 * A provider without keys is called without authorization (for example a local server).
 */
async function voiceRequest(config: JarvisVoiceConfig, path: string, init: () => RequestInit, signal: AbortSignal, slot?: JarvisVoiceKeySlot): Promise<Response> {
  const base = parseJarvisVoiceBaseUrl(config.baseUrl);
  const slots: readonly JarvisVoiceKeySlot[] = slot ? [slot] : ['primary', 'fallback', 'fallback2', 'fallback3'];
  const keys = (await Promise.all(slots.map(slot => deps.credential(slot, base.origin)))).filter((key): key is VoiceCredential => !!key);
  // Never upload captured microphone audio to Google without an origin-bound key.
  if (base.origin === 'https://generativelanguage.googleapis.com' && !keys.length) {
    throw new Error('Save your Google AI Studio key in the vault before using Gemini speech.');
  }
  const attempts: (VoiceCredential | null)[] = keys.length ? keys : [null];
  for (let index = 0; index < attempts.length; index++) {
    const request = init();
    const response = await deps.fetch(`${base.toString().replace(/\/+$/, '')}${path}`, {
      ...request, headers: { ...(request.headers as Record<string, string>), ...authorization(attempts[index]!) },
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal
    });
    // Gemini rate limits are per project, not per API key. Do not fan out 429s
    // across keys that may share the same quota.
    if (response.ok || index === attempts.length - 1 || response.status === 429 && base.origin === 'https://generativelanguage.googleapis.com' || !jarvisVoiceUsesFallback(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    logInfo(`jarvis: voice provider ${path} answered HTTP ${response.status} to credential slot ${index + 1}; trying another configured slot`);
  }
  throw new Error('Voice provider request was not sent.');
}

const timeout = (signal: AbortSignal, ms: number): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

export async function jarvisVoiceStatus(config: JarvisVoiceConfig, signal = new AbortController().signal): Promise<JarvisVoiceStatus> {
  const result: JarvisVoiceStatus = { models: [], stt: [], tts: [], primary: false, fallback: false, fallback2: false, fallback3: false, ffmpeg: await deps.ffmpeg(), error: null };
  if (!config.baseUrl) return result;
  try {
    const origin = parseJarvisVoiceBaseUrl(config.baseUrl).origin;
    result.primary = !!(await deps.credential('primary', origin));
    result.fallback = !!(await deps.credential('fallback', origin));
    result.fallback2 = !!(await deps.credential('fallback2', origin));
    result.fallback3 = !!(await deps.credential('fallback3', origin));
    if (origin === 'https://generativelanguage.googleapis.com') {
      result.stt = ['gemini-3.5-transcribe'];
      result.tts = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];
      result.models = [...result.stt, ...result.tts];
      if (!result.primary && !result.fallback && !result.fallback2 && !result.fallback3) result.error = 'Save your Google AI Studio key to enable Gemini speech.';
      return result;
    }
    const response = await voiceRequest(config, '/models', () => ({ method: 'GET', headers: { accept: 'application/json' } }), timeout(signal, 15_000));
    if (!response.ok) throw await failure(response, 'model list');
    const parsed = JSON.parse((await readBounded(response, MAX_JSON)).toString()) as { data?: unknown } | unknown[];
    const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : [];
    const ids = rows.map(row => typeof row === 'string' ? row : (row as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string').slice(0, 1000);
    result.models = ids;
    result.stt = rankJarvisVoiceModels(ids, 'stt');
    result.tts = rankJarvisVoiceModels(ids, 'tts');
  } catch (error) { result.error = error instanceof Error ? error.message.slice(0, 240) : 'Voice provider is unavailable.'; }
  return result;
}

export async function storeJarvisVoiceKey(slot: JarvisVoiceKeySlot, baseUrl: string, raw: string, password: string): Promise<void> {
  const url = parseJarvisVoiceBaseUrl(baseUrl);
  const value = raw.trim().replace(/^Bearer\s+/i, '');
  if (!value || /\s/.test(value)) throw new Error('The key must be one token without spaces.');
  await putVault({ name: JARVIS_VOICE_VAULT[slot], value, origin: url.origin, header: url.origin === 'https://generativelanguage.googleapis.com' ? 'x-goog-api-key' : 'Authorization', ...(url.protocol === 'http:' ? { insecureHttp: true } : {}) }, password);
  logInfo(`jarvis: stored the ${slot} voice provider key in the vault for ${url.origin}`);
}

const fileName = (mime: JarvisAudioMime): string => mime === 'audio/wav' ? 'jarvis.wav' : mime === 'audio/mp4' ? 'jarvis.m4a' : mime === 'audio/ogg' ? 'jarvis.ogg' : 'jarvis.webm';
const cleanTranscript = (text: string): string => text.trim().replace(/^["“'«]+|["”'»]+$/g, '').trim().slice(0, MAX_TEXT);

/** Gemini's dedicated transcription model uses the Interactions API, not
 * generateContent. Short microphone recordings stay inline and in memory;
 * the Interactions response owns output_text / model_output, not candidates.
 */
async function viaGeminiTranscription(
  config: JarvisVoiceConfig, mime: JarvisAudioMime, bytes: Uint8Array, language: string, signal: AbortSignal
): Promise<string> {
  if (bytes.byteLength > 12_000_000) throw new Error('Microphone recording exceeds the Gemini inline audio limit.');
  if (!bytes.byteLength) throw new Error('Microphone recording is empty.');
  if (!/^gemini-[a-zA-Z0-9.-]+$/.test(config.sttModel) || /-tts$/.test(config.sttModel)) {
    throw new Error('Select a Gemini audio-understanding model for transcription.');
  }
  const codes = language && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language) ? [language] : [];
  const response = await voiceRequest(config, '/interactions', () => ({
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model: config.sttModel,
      input: [{ type: 'audio', mime_type: mime, data: Buffer.from(bytes).toString('base64') }],
      generation_config: { transcription_config: { language_codes: codes, mode: 'verbatim' } }
    })
  }), timeout(signal, 45_000));
  if (!response.ok) throw await failure(response, 'Gemini transcription');
  const parsed = JSON.parse((await readBounded(response, MAX_JSON)).toString()) as {
    output_text?: unknown;
    steps?: { type?: string; content?: { type?: string; text?: unknown }[] }[];
  };
  const text = typeof parsed.output_text === 'string' ? parsed.output_text
    : (parsed.steps ?? []).filter(step => step.type === 'model_output')
      .flatMap(step => step.content ?? [])
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text as string).join('');
  return cleanTranscript(text);
}

async function viaTranscriptions(config: JarvisVoiceConfig, mime: JarvisAudioMime, bytes: Uint8Array, language: string, signal: AbortSignal): Promise<{ status: number; text: string | null; response?: Response }> {
  const response = await voiceRequest(config, '/audio/transcriptions', () => {
    const form = new FormData();
    form.append('model', config.sttModel);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), fileName(mime));
    form.append('response_format', 'json');
    if (language) form.append('language', language.split('-')[0]!.toLowerCase());
    return { method: 'POST', headers: { accept: 'application/json' }, body: form };
  }, signal);
  if (!response.ok) return { status: response.status, text: null, response };
  const body = (await readBounded(response, MAX_JSON)).toString();
  let text: unknown;
  try { text = (JSON.parse(body) as { text?: unknown }).text; } catch { text = body; }
  return { status: response.status, text: typeof text === 'string' ? cleanTranscript(text) : '' };
}

async function viaChatAudio(config: JarvisVoiceConfig, wav: Uint8Array, language: string, signal: AbortSignal): Promise<string> {
  const hint = language ? ` The expected language is ${language}.` : '';
  const response = await voiceRequest(config, '/chat/completions', () => ({
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model: config.sttModel, temperature: 0, stream: false,
      messages: [{ role: 'user', content: [
        { type: 'text', text: `Transcribe this audio verbatim in its original language.${hint} Reply with the transcript only, without quotes, translation or comments. If nothing is said, reply with nothing.` },
        { type: 'input_audio', input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' } }
      ] }]
    })
  }), signal);
  if (!response.ok) throw await failure(response, 'transcription');
  const parsed = JSON.parse((await readBounded(response, MAX_JSON)).toString()) as { choices?: { message?: { content?: unknown } }[] };
  const content = parsed.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(part => typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : '').join('') : '';
  return cleanTranscript(text);
}

/**
 * Speech to text. A recording format the provider rejects (or answers with empty text) is
 * converted to WAV with an installed ffmpeg and sent once more; nothing is written to disk.
 */
export async function transcribeJarvisVoice(config: JarvisVoiceConfig, mime: JarvisAudioMime, bytes: Uint8Array, language: string, signal: AbortSignal): Promise<string> {
  if (!config.baseUrl || !config.sttModel) throw new Error('Configure the voice provider URL and speech-to-text model.');
  const started = Date.now();
  let text: string;
  if (parseJarvisVoiceBaseUrl(config.baseUrl).origin === 'https://generativelanguage.googleapis.com') {
    text = await viaGeminiTranscription(config, mime, bytes, language, signal);
  } else if (config.sttMode === 'chat-audio') {
    if (mime !== 'audio/wav' && !(await deps.ffmpeg())) throw new Error('Chat-model transcription needs ffmpeg to convert the recording to WAV.');
    text = await viaChatAudio(config, mime === 'audio/wav' ? bytes : await deps.toWav(bytes, signal), language, signal);
  } else {
    let result = await viaTranscriptions(config, mime, bytes, language, signal);
    const retry = mime !== 'audio/wav' && (result.text === '' || [400, 415, 422].includes(result.status) || result.status >= 500);
    if (retry && await deps.ffmpeg()) {
      await result.response?.body?.cancel().catch(() => undefined);
      logInfo(`jarvis: voice provider ${result.text === '' ? 'returned no text' : `answered HTTP ${result.status}`} for ${mime}; retrying as WAV`);
      result = await viaTranscriptions(config, 'audio/wav', await deps.toWav(bytes, signal), language, signal);
    }
    if (result.text === null) throw await failure(result.response!, 'transcription');
    text = result.text;
  }
  logInfo(`jarvis: voice provider transcription (${config.sttMode}) finished in ${Date.now() - started} ms`);
  if (!text) throw new Error('The voice provider returned no text.');
  return text;
}

async function speechResponse(config: JarvisVoiceConfig, text: string, signal: AbortSignal, slot?: JarvisVoiceKeySlot): Promise<{ mime: string; response: Response }> {
  if (!config.baseUrl || !config.ttsModel || !config.voice) throw new Error('Configure the voice provider URL, speech model and voice.');
  const input = text.trim().slice(0, 4000);
  if (!input) throw new Error('Nothing to speak.');
  if (parseJarvisVoiceBaseUrl(config.baseUrl).origin === 'https://generativelanguage.googleapis.com') {
    const googleKey = await deps.credential('primary', 'https://generativelanguage.googleapis.com') ?? await deps.credential('fallback', 'https://generativelanguage.googleapis.com') ?? await deps.credential('fallback2', 'https://generativelanguage.googleapis.com') ?? await deps.credential('fallback3', 'https://generativelanguage.googleapis.com');
    if (!googleKey) throw new Error('Save your Google AI Studio key in the vault before testing speech.');
    const response = await voiceRequest(config, '/interactions', () => ({
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model: config.ttsModel, input: [{ type: 'user_input', content: [{
        type: 'text', text: input, annotations: [{ type: 'speech_metadata', style: 'Natural Brazilian Portuguese, warm conversational delivery, medium pace.' }]
      }] }], response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: config.voice }] } })
    }), signal, slot);
    if (!response.ok) { const retryAfterMs = retryAfterDelay(response); const error = await failure(response, 'Gemini speech'); throw new ProviderUnavailable(response.status, retryAfterMs, error.message); }
    const payload = JSON.parse((await readBounded(response, MAX_AUDIO * 2)).toString()) as {
      steps?: { type?: string; content?: { type?: string; data?: string }[] }[]
    };
    const encoded = payload.steps?.flatMap(step => step.type === 'model_output' ? step.content ?? [] : [])
      .filter(part => part.type === 'audio' && typeof part.data === 'string').at(-1)?.data;
    if (!encoded || encoded.length > MAX_AUDIO * 2) throw new Error('Gemini returned no usable audio.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_AUDIO || bytes.subarray(0, 4).toString() !== 'RIFF') throw new Error('Gemini returned invalid WAV audio.');
    return { mime: 'audio/wav', response: new Response(bytes, { headers: { 'content-type': 'audio/wav' } }) };
  }
  const response = await voiceRequest(config, '/audio/speech', () => ({
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'audio/mpeg,audio/*;q=0.9' },
    body: JSON.stringify({ model: config.ttsModel, input, voice: config.voice, response_format: 'mp3' })
  }), signal, slot);
  if (!response.ok) { const retryAfterMs = retryAfterDelay(response); const error = await failure(response, 'speech'); throw new ProviderUnavailable(response.status, retryAfterMs, error.message); }
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!/^audio\/|^application\/(ogg|octet-stream)$/.test(type)) {
    await response.body?.cancel().catch(() => undefined);
    logWarn(`jarvis: voice provider speech returned ${type || 'no content type'} instead of audio`);
    throw new Error('Voice provider speech returned no audio.');
  }
  return { response, mime: type === 'application/ogg' ? 'audio/ogg' : type === 'application/octet-stream' ? 'audio/mpeg' : type };
}

type RoutedVoice = { config: JarvisVoiceConfig; slot: JarvisVoiceKeySlot; id: string };
const routePinned = new Map<string, { route: RoutedVoice; until: number }>();
const routeCooldown = new Map<string, number>();
const routeFailureReason = new Map<string, string>();
const routeSelectionInFlight = new Map<string, Promise<void>>();
const FAILURE_COOLDOWN_MS = 30_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
function retryAfterDelay(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw.trim());
  const milliseconds = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, milliseconds)) : null;
}
class ProviderUnavailable extends Error {
  constructor(readonly code: number, readonly retryAfterMs: number | null, message: string) { super(message); }
}

const GROUP_TTL_MS = 120_000;
function voiceCandidates(config: JarvisVoiceConfig, routing: JarvisVoiceRouting): RoutedVoice[] {
  const google = config.baseUrl.startsWith('https://generativelanguage.googleapis.com/') ?
    [{ config, slot: 'primary' as const, id: 'gemini' }] : [];
  const g4f = routing.g4f.flatMap((entry, index): RoutedVoice[] => {
    if (!entry.baseUrl || !entry.ttsModel || !entry.voice) return [];
    try {
      const baseUrl = parseJarvisVoiceBaseUrl(entry.baseUrl).toString().replace(/\/+$/, '');
      return [{ config: { baseUrl, sttMode: 'chat-audio', sttModel: '', ttsModel: entry.ttsModel, voice: entry.voice },
        slot: index === 0 ? 'g4f1' : 'g4f2', id: `g4f${index + 1}` }];
    } catch { return []; }
  });
  // Existing non-Google voice providers retain the legacy behavior.
  if (!google.length) return [];
  return routing.mode === 'g4f-first' ? [...g4f, ...google] : [...google, ...g4f];
}
export async function jarvisVoiceRouteStatus(routing: JarvisVoiceRouting): Promise<{ g4f1: boolean; g4f2: boolean; error: string | null }> {
  const result = { g4f1: false, g4f2: false, error: null as string | null };
  for (let i = 0; i < 2; i++) {
    const entry = routing.g4f[i]!;
    if (!entry.baseUrl) continue;
    try { result[i === 0 ? 'g4f1' : 'g4f2'] = !!await deps.credential(i === 0 ? 'g4f1' : 'g4f2', parseJarvisVoiceBaseUrl(entry.baseUrl).origin); }
    catch { result.error = 'A saved G4F credential is unavailable for its configured provider URL.'; }
  }
  return result;
}
/** Each answer is pinned to one voice/provider; a fallback only occurs before audible output. */
async function routedSpeechResponse(config: JarvisVoiceConfig, text: string, signal: AbortSignal,
  routing?: JarvisVoiceRouting, groupId?: string): Promise<{ mime: string; response: Response }> {
  if (!routing || routing.mode === 'off') return speechResponse(config, text, signal);
  const previous = groupId ? routeSelectionInFlight.get(groupId) : undefined;
  if (previous) { await previous; signal.throwIfAborted(); }
  // Only the first simultaneous segment chooses the provider. Later segments
  // wait until that decision is pinned, so prefetch cannot mix voices.
  let release: (() => void) | undefined;
  const lock = !previous && groupId && !routePinned.has(groupId) ? new Promise<void>(resolve => { release = resolve; }) : null;
  if (lock && groupId) routeSelectionInFlight.set(groupId, lock);
  try { return await selectSpeechResponse(config, text, signal, routing, groupId); }
  finally {
    if (groupId && lock && routeSelectionInFlight.get(groupId) === lock) routeSelectionInFlight.delete(groupId);
    release?.();
  }
}
async function selectSpeechResponse(config: JarvisVoiceConfig, text: string, signal: AbortSignal,
  routing: JarvisVoiceRouting, groupId?: string): Promise<{ mime: string; response: Response }> {
  const candidates = voiceCandidates(config, routing);
  if (!candidates.length) return speechResponse(config, text, signal);
  const now = Date.now();
  for (const [key, group] of routePinned) if (group.until <= now) routePinned.delete(key);
  const pinned = groupId && routePinned.get(groupId)?.route;
  const ordered = pinned ? [pinned] : candidates;
  let lastError: unknown;
  for (const candidate of ordered) {
    signal.throwIfAborted();
    if (!pinned && (routeCooldown.get(candidate.id) ?? 0) > now) continue;
    if (candidate.slot !== 'primary' && !await deps.credential(candidate.slot, parseJarvisVoiceBaseUrl(candidate.config.baseUrl).origin)) continue;
    try {
      const result = await speechResponse(candidate.config, text, signal, candidate.slot);
      if (groupId && !pinned) routePinned.set(groupId, { route: candidate, until: Date.now() + GROUP_TTL_MS });
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      // Quota failure is shared among keys within one project. Never retry another Gemini key.
      if (/HTTP (429|500|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT/.test(String(error))) {
        routeCooldown.set(candidate.id, Date.now() + (error instanceof ProviderUnavailable && error.retryAfterMs !== null ? error.retryAfterMs : FAILURE_COOLDOWN_MS));
        routeFailureReason.set(candidate.id, error instanceof ProviderUnavailable ? `HTTP ${error.code}` : 'network');
      } else if (!/HTTP (401|403)/.test(String(error))) throw error;
      if (pinned) throw error; // Never change a speaker in the middle of the same answer.
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No configured speech provider is currently available.');
}

/** Compatibility route: providers and clients without incremental playback get one bounded buffer. */
export async function speakJarvisVoice(config: JarvisVoiceConfig, text: string, signal: AbortSignal, routing?: JarvisVoiceRouting, groupId?: string): Promise<{ mime: string; bytes: Uint8Array }> {
  const { response, mime } = await routedSpeechResponse(config, text, signal, routing, groupId);
  const bytes = await readBounded(response, MAX_AUDIO);
  if (!bytes.length) throw new Error('Voice provider speech returned no audio.');
  return { mime: mime === 'audio/mpeg' && bytes.subarray(0, 4).toString() === 'OggS' ? 'audio/ogg' : mime, bytes: new Uint8Array(bytes) };
}

export type JarvisAudioStreamEvent =
  | { requestId: string; type: 'start'; mime: string }
  | { requestId: string; type: 'chunk'; bytes: Uint8Array }
  | { requestId: string; type: 'end' };

/**
 * Forward each bounded provider chunk as it arrives. The renderer owns playback and may start
 * after the first decodable frames, while the response is still being generated. IPC is scoped
 * to the requesting main frame; cancellation aborts the HTTP stream and suppresses late events.
 */
export async function streamJarvisVoice(
  config: JarvisVoiceConfig, text: string, requestId: string, signal: AbortSignal,
  emit: (event: JarvisAudioStreamEvent) => void, routing?: JarvisVoiceRouting, groupId?: string
): Promise<{ firstByteMs: number; totalMs: number; bytes: number }> {
  const started = performance.now();
  const { response, mime } = await routedSpeechResponse(config, text, signal, routing, groupId);
  signal.throwIfAborted();
  emit({ requestId, type: 'start', mime });
  if (!response.body) throw new Error('Voice provider speech returned no audio.');
  const reader = response.body.getReader();
  let bytes = 0;
  let firstByteMs = -1;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      signal.throwIfAborted();
      bytes += value.byteLength;
      if (bytes > MAX_AUDIO) throw new Error('Voice provider response is too large.');
      if (value.byteLength && firstByteMs < 0) firstByteMs = Math.round(performance.now() - started);
      // Bounded messages prevent a provider's large network read becoming one huge IPC payload.
      for (let offset = 0; offset < value.byteLength; offset += 64 * 1024) {
        signal.throwIfAborted();
        emit({ requestId, type: 'chunk', bytes: value.slice(offset, offset + 64 * 1024) });
      }
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  signal.throwIfAborted();
  if (!bytes) throw new Error('Voice provider speech returned no audio.');
  emit({ requestId, type: 'end' });
  const totalMs = Math.round(performance.now() - started);
  logInfo(`jarvis: speech stream first byte ${firstByteMs} ms, completed ${totalMs} ms (${bytes} bytes)`);
  return { firstByteMs, totalMs, bytes };
}
