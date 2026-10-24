/**
 * Jarvis voice provider (J3): an OpenAI-compatible speech service chosen by the user.
 * Only non-secret settings live here and in renderer storage. Keys are Vault K entries bound to
 * the provider's exact origin and are read by the main process only.
 */
import { z } from 'zod';

/** Vault K names; each entry is bound to the provider origin with header `Authorization`. */
export const JARVIS_VOICE_VAULT = { primary: 'jarvis/voice-primary', fallback: 'jarvis/voice-fallback' } as const;
export type JarvisVoiceKeySlot = keyof typeof JARVIS_VOICE_VAULT;

/**
 * `transcriptions` posts the recording to `/audio/transcriptions`. `chat-audio` asks a
 * multimodal chat model (`/chat/completions` with `input_audio`) for a verbatim transcript;
 * g4f.space currently answers `/audio/transcriptions` with empty text, so its preset uses it.
 */
export type JarvisSttMode = 'transcriptions' | 'chat-audio';

export interface JarvisVoiceConfig {
  baseUrl: string;
  sttMode: JarvisSttMode;
  sttModel: string;
  ttsModel: string;
  voice: string;
}

export const emptyJarvisVoiceConfig = (): JarvisVoiceConfig => ({ baseUrl: '', sttMode: 'transcriptions', sttModel: '', ttsModel: '', voice: '' });

/** Model and voice names as returned by `/models`; g4f.space uses `srv_…:vendor/model`. */
const MODEL = /^[a-zA-Z0-9][\w.:/@+-]{0,199}$/;
const VOICE = /^[a-zA-Z0-9][\w.-]{0,63}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** HTTPS, or plain HTTP only on loopback (a local server). No credentials, query or fragment. */
export function parseJarvisVoiceBaseUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Enter a valid provider base URL.'); }
  if (url.username || url.password) throw new Error('The provider URL must not contain credentials.');
  if (url.search || url.hash) throw new Error('The provider URL must not contain a query or fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('The provider URL must use HTTPS (plain HTTP only on this computer).');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export const jarvisVoiceConfigSchema = z.object({
  baseUrl: z.string().max(300).refine(value => { try { parseJarvisVoiceBaseUrl(value); return true; } catch { return false; } }, 'Invalid provider URL'),
  sttMode: z.enum(['transcriptions', 'chat-audio']),
  sttModel: z.string().max(200).refine(value => value === '' || MODEL.test(value), 'Invalid model'),
  ttsModel: z.string().max(200).refine(value => value === '' || MODEL.test(value), 'Invalid model'),
  voice: z.string().max(64).refine(value => value === '' || VOICE.test(value), 'Invalid voice')
}).strict();

/** Lenient read of stored preferences: anything invalid falls back to "not configured". */
export function parseJarvisVoiceConfig(value: unknown): JarvisVoiceConfig {
  const empty = emptyJarvisVoiceConfig();
  if (!value || typeof value !== 'object') return empty;
  const data = value as Record<string, unknown>;
  const text = (key: string, max: number) => typeof data[key] === 'string' ? (data[key] as string).trim().slice(0, max) : '';
  let baseUrl = text('baseUrl', 300);
  if (baseUrl) { try { baseUrl = parseJarvisVoiceBaseUrl(baseUrl).toString().replace(/\/+$/, ''); } catch { baseUrl = ''; } }
  const model = (raw: string) => MODEL.test(raw) ? raw : '';
  return {
    baseUrl,
    sttMode: data.sttMode === 'chat-audio' ? 'chat-audio' : 'transcriptions',
    // Revisions -7/-8 shipped absent/generic Gemini STT models. Migrate only
    // those known defaults; preserve explicit custom choices and Vault entries.
    sttModel: baseUrl === 'https://generativelanguage.googleapis.com/v1beta' &&
      (!model(text('sttModel', 200)) || ['gemini-3.8-flash', 'gemini-3.8-flash-lite'].includes(model(text('sttModel', 200))))
      ? 'gemini-3.5-transcribe' : model(text('sttModel', 200)),
    ttsModel: model(text('ttsModel', 200)),
    voice: VOICE.test(text('voice', 64)) ? text('voice', 64) : ''
  };
}

/** The provider can transcribe once a URL and an STT model are set (keys are checked in main). */
export const jarvisVoiceSttReady = (config: JarvisVoiceConfig): boolean => !!config.baseUrl && !!config.sttModel;
export const jarvisVoiceTtsReady = (config: JarvisVoiceConfig): boolean => !!config.baseUrl && !!config.ttsModel && !!config.voice;

/** Presets fill only public settings; keys are still entered by the user. */
export const JARVIS_VOICE_PRESETS = {
  'Google Gemini TTS': {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', sttMode: 'transcriptions', sttModel: 'gemini-3.5-transcribe',
    ttsModel: 'gemini-3.8-flash-tts', voice: 'Charon'
  },
  'g4f.space': {
    baseUrl: 'https://g4f.space/v1', sttMode: 'chat-audio', sttModel: 'srv_mrgy0nmbc8a86c407f17:models/gemini-3.5-flash-lite',
    ttsModel: 'gpt-4o-mini-tts', voice: 'alloy'
  }
} as const satisfies Record<string, JarvisVoiceConfig>;

/** OpenAI voices plus the ones g4f.space accepted for MarksCode (`packages/tui/src/markscode/tts.ts`). */
export const JARVIS_VOICE_SUGGESTIONS = ['Charon', 'Puck', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Schedar', 'Zubenelgenubi', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;

/** A rejected or failing primary key (401/403/429/5xx) is retried once with the fallback key. */
export const jarvisVoiceUsesFallback = (status: number): boolean => status === 401 || status === 403 || status === 429 || status >= 500;

/** Rank catalog ids so likely speech models come first in the pickers; nothing is excluded. */
export function rankJarvisVoiceModels(ids: readonly string[], kind: 'stt' | 'tts'): string[] {
  const score = (id: string): number => {
    const name = id.toLowerCase();
    if (kind === 'tts') return /tts|speech/.test(name) ? 0 : /audio|voice/.test(name) ? 1 : 2;
    return /whisper|transcri/.test(name) ? 0 : /gemini.*flash|omni|audio/.test(name) ? 1 : 2;
  };
  return [...new Set(ids)].filter(id => MODEL.test(id)).sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

/** Readable speech text: no code, URLs, tool noise or Markdown markers (after MarksCode tts.ts). */
export function speakableText(raw: string): string {
  return raw
    .replace(/<(thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_~|]{1,3}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const BOUNDARY = /[.!?…。！？;:](?=["')\]]?\s)|\n{2,}|\n(?=\s*(?:[-+*]|\d+[.)])\s)/gu;

/**
 * Splits a growing (streamed) answer into speakable sentences. `push` returns only sentences that
 * are complete and not yet emitted; `finish` returns the rest. An unclosed code fence holds output
 * back so half a code block is never read aloud. Very short sentences are merged and very long
 * ones are cut at word boundaries, so each TTS request stays small and the first one comes early.
 */
export class JarvisSentenceSplitter {
  private emitted = 0;
  constructor(private readonly minChars = 12, private readonly maxChars = 280) {}

  push(full: string): string[] { return this.take(full, false); }
  finish(full: string): string[] { return this.take(full, true); }
  reset(): void { this.emitted = 0; }

  private take(full: string, final: boolean): string[] {
    if (full.length < this.emitted) this.emitted = 0;
    let stable = full.length;
    if (!final) {
      const fences = [...full.matchAll(/```/g)];
      if (fences.length % 2 === 1) stable = fences.at(-1)!.index!;
      let end = -1;
      for (const match of full.slice(0, stable).matchAll(BOUNDARY)) {
        const at = match.index! + match[0].length;
        if (at > this.emitted && full.slice(this.emitted, at).trim().length >= this.minChars) end = at;
      }
      if (end < 0) {
        // Nothing complete yet: a very long run without punctuation still speaks at word breaks.
        const pending = full.slice(this.emitted, stable);
        if (pending.length <= this.maxChars * 1.5) return [];
        end = this.emitted + pending.slice(0, this.maxChars).lastIndexOf(' ');
        if (end <= this.emitted) return [];
      }
      stable = end;
    }
    const chunk = full.slice(this.emitted, stable);
    this.emitted = stable;
    return this.split(speakableText(chunk));
  }

  private split(text: string): string[] {
    if (!text) return [];
    const sentences = text.split(/(?<=[.!?…。！？;:])\s+|\n+/u).map(part => part.trim()).filter(Boolean);
    const out: string[] = [];
    for (const sentence of sentences) {
      const pieces = sentence.length <= this.maxChars ? [sentence] : sentence.split(/\s+/).reduce<string[]>((all, word) => {
        const last = all.at(-1);
        if (last !== undefined && last.length + word.length + 1 <= this.maxChars) all[all.length - 1] = `${last} ${word}`;
        else all.push(word);
        return all;
      }, []);
      for (const piece of pieces) {
        const last = out.at(-1);
        if (last !== undefined && last.length < this.minChars && last.length + piece.length + 1 <= this.maxChars) out[out.length - 1] = `${last} ${piece}`;
        else out.push(piece);
      }
    }
    return out.filter(piece => /[\p{L}\p{N}]/u.test(piece));
  }
}
