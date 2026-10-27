/**
 * Jarvis J3 turn-taking helpers: a sentence speech queue with barge-in, a silence gate for
 * continuous conversation, and short earcons. The queue and the gate are DOM-free so they are
 * unit-tested; playback and synthesis are injected by `jarvis.ts`.
 */
import { JarvisSentenceSplitter } from '../shared/jarvis-voice.js';

/**
 * Speech starts as soon as an answer reaches a stable, reasonably long clause,
 * even when the model has not produced a sentence-ending period yet. The
 * synthetic semicolon has the same UTF-16 width as the source comma: the
 * underlying splitter's durable cursor therefore stays aligned with each
 * later streaming snapshot, including repeated snapshots and finalization.
 *
 * Keep ordinary sentence boundaries and short clauses untouched. Avoid
 * marking punctuation in code blocks or inline code.
 */
export class JarvisStreamingSplitter {
  private readonly sentences = new JarvisSentenceSplitter();
  constructor(private readonly minClauseChars = 96) {}

  push(full: string): string[] { return this.sentences.push(this.clauses(full)); }
  finish(full: string): string[] { return this.sentences.finish(this.clauses(full)); }
  reset(): void { this.sentences.reset(); }

  private clauses(full: string): string {
    let rendered = '';
    let since = 0;
    let fence = false;
    let inline = false;
    for (let i = 0; i < full.length; i++) {
      if (full.startsWith('```', i)) {
        fence = !fence;
        rendered += '```';
        i += 2;
        continue;
      }
      const char = full[i]!;
      if (!fence && char === '`') inline = !inline;
      if (!fence && !inline) {
        if (/[.!?…。！？;:\n]/u.test(char)) since = i + 1;
        if ((char === ',' || char === '，') && i - since >= this.minClauseChars &&
            /\s/u.test(full[i + 1] ?? '')) {
          rendered += ';';
          since = i + 1;
          continue;
        }
      }
      rendered += char;
    }
    return rendered;
  }
}

export interface SpeechBackend<T> {
  /** Turn a sentence into something playable (provider audio, or text for system speech). */
  synthesize(text: string, signal: AbortSignal): Promise<T>;
  /** Resolve when playback ends or the signal aborts. */
  play(item: T, signal: AbortSignal): Promise<void>;
}

export interface SpeechQueueEvents {
  speaking?(active: boolean): void;
  /** Every queued sentence was spoken (not called after `stop`). */
  drained?(): void;
  error?(error: unknown, text: string): void;
}

/**
 * Speaks sentences in order while up to two following sentences are synthesized early.
 * The current sentence plus these two requests fits the main process's 3-stream limit.
 * This reduces gaps when synthesis takes longer than one spoken sentence. `stop` invalidates
 * everything in flight at once: a late synthesis or playback of an older generation is ignored.
 */
export class JarvisSpeechQueue<T> {
  private generation = 0;
  private pending: string[] = [];
  private prefetched: { text: string; audio: Promise<T | null> }[] = [];
  private controller = new AbortController();
  private active = false;

  constructor(private readonly backend: SpeechBackend<T>, private readonly events: SpeechQueueEvents = {}) {}

  get speaking(): boolean { return this.active; }
  get queued(): number { return this.pending.length + this.prefetched.length; }

  enqueue(sentences: readonly string[]): void {
    const clean = sentences.map(sentence => sentence.trim()).filter(Boolean);
    if (!clean.length) return;
    this.pending.push(...clean);
    if (this.active) this.topUp(); else void this.run();
  }

  /** Barge-in: silence now, drop the queue and abort synthesis and playback in flight. */
  stop(): void {
    this.generation++;
    this.pending = [];
    this.prefetched = [];
    this.controller.abort();
    this.controller = new AbortController();
    if (this.active) { this.active = false; this.events.speaking?.(false); }
  }

  private synth(text: string, generation: number, signal: AbortSignal): Promise<T | null> {
    const fail = (error: unknown): null => {
      if (generation === this.generation && !signal.aborted) this.events.error?.(error, text);
      return null;
    };
    try {
      if (signal.aborted || generation !== this.generation) return Promise.resolve(null);
      return Promise.resolve(this.backend.synthesize(text, signal)).catch(fail);
    } catch (error) {
      return Promise.resolve(fail(error));
    }
  }

  private topUp(): void {
    while (this.prefetched.length < 2 && this.pending.length) {
      const text = this.pending.shift()!;
      this.prefetched.push({ text, audio: this.synth(text, this.generation, this.controller.signal) });
    }
  }

  private async run(): Promise<void> {
    const generation = this.generation;
    const signal = this.controller.signal;
    this.active = true;
    this.events.speaking?.(true);
    while (generation === this.generation) {
      if (!this.prefetched.length) this.topUp();
      const item = this.prefetched.shift();
      if (!item) break;
      const audio = await item.audio;
      if (generation !== this.generation) return;
      this.topUp();
      if (audio === null) continue;
      try { await this.backend.play(audio, signal); }
      catch (error) { if (generation === this.generation && !signal.aborted) this.events.error?.(error, item.text); }
    }
    if (generation !== this.generation) return;
    this.active = false;
    this.events.speaking?.(false);
    this.events.drained?.();
  }
}

export type SilenceVerdict = 'speech' | 'silence' | 'end' | 'no-speech' | 'limit';

/**
 * Continuous conversation decides when a hands-free utterance is over from level samples:
 * after speech, `silenceMs` of quiet ends it; with no speech for `noSpeechMs` it is dropped;
 * `maxMs` bounds the whole recording. Pure: the caller feeds RMS levels with timestamps.
 */
export class JarvisSilenceGate {
  private started: number | null = null;
  private heard = false;
  private quietSince: number | null = null;
  constructor(private readonly options = { threshold: 0.018, silenceMs: 1400, noSpeechMs: 8000, maxMs: 60_000 }) {}

  sample(rms: number, now: number): SilenceVerdict {
    this.started ??= now;
    if (now - this.started >= this.options.maxMs) return this.heard ? 'end' : 'limit';
    if (rms >= this.options.threshold) { this.heard = true; this.quietSince = null; return 'speech'; }
    if (!this.heard) return now - this.started >= this.options.noSpeechMs ? 'no-speech' : 'silence';
    this.quietSince ??= now;
    return now - this.quietSince >= this.options.silenceMs ? 'end' : 'silence';
  }
}

/** Watch a live stream's level; returns a disposer. No-op where Web Audio is unavailable. */
export function watchSilence(stream: MediaStream, onVerdict: (verdict: 'end' | 'no-speech' | 'limit') => void): () => void {
  const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Context) return () => undefined;
  let context: AudioContext;
  try { context = new Context(); } catch { return () => undefined; }
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const gate = new JarvisSilenceGate();
  let done = false;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const verdict = gate.sample(Math.sqrt(sum / samples.length), Date.now());
    if (verdict === 'end' || verdict === 'no-speech' || verdict === 'limit') { dispose(); onVerdict(verdict); }
  }, 100);
  function dispose(): void {
    if (done) return;
    done = true;
    clearInterval(timer);
    try { source.disconnect(); } catch { /* already gone */ }
    void context.close().catch(() => undefined);
  }
  return dispose;
}

let earconContext: AudioContext | null = null;
/** Short, quiet cues: listening starts, listening ends, an error. */
export function playEarcon(kind: 'listen' | 'done' | 'error'): void {
  const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Context) return;
  try {
    earconContext ??= new Context();
    const context = earconContext;
    const tones = kind === 'listen' ? [660, 880] : kind === 'done' ? [880, 660] : [330, 247];
    tones.forEach((frequency, index) => {
      const start = context.currentTime + index * 0.09;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.07, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.08);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.09);
    });
  } catch { /* cues are optional */ }
}
