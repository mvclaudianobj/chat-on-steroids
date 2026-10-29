import type { JarvisAudioStreamEvent } from '../main/jarvis-voice.js';

export type JarvisProgressEvent = JarvisAudioStreamEvent | { requestId: string; type: 'error'; error: string };

/**
 * One TTS request and one player. HTTP chunks arrive through the narrow, authenticated main
 * frame IPC bridge; MediaSource feeds Chromium as they arrive. Unsupported containers are
 * buffered into one bounded Blob, preserving compatibility with non-streaming providers.
 */
export class JarvisProgressiveAudio {
  private readonly unsubscribe: () => void;
  private readonly received: Uint8Array[] = [];
  private readonly startedAt = performance.now();
  private mime = '';
  private total = 0;
  private finished = false;
  private stopped = false;
  private playing = false;
  private playbackRequested = false;
  private playbackStarting = false;
  private source: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private audio: HTMLAudioElement | null = null;
  private url = '';
  private resolve: (() => void) | null = null;
  private reject: ((reason: unknown) => void) | null = null;
  private firstAudio: ((ms: number) => void) | null = null;
  private error: Error | null = null;
  private detachAbort: (() => void) | null = null;

  constructor(readonly requestId: string, subscribe: (listener: (event: JarvisProgressEvent) => void) => () => void) {
    this.unsubscribe = subscribe(event => this.accept(event));
  }

  /** No earlier or later turn can send chunks into this request's playback. */
  accept(event: JarvisProgressEvent): void {
    if (this.stopped || this.error || event.requestId !== this.requestId) return;
    // Main already committed the complete stream. Replayed starts, errors,
    // chunks or ends must not interrupt its buffered, not-yet-played audio.
    if (this.finished) return;
    if (event.type === 'error') { this.fail(new Error(event.error)); return; }
    if (event.type === 'start') {
      if (this.mime) { this.fail(new Error('Duplicate speech stream start.')); return; }
      this.mime = event.mime;
      const Media = typeof MediaSource !== 'undefined' ? MediaSource : null;
      if (Media && Media.isTypeSupported(event.mime)) {
        this.source = new Media();
        this.audio = new Audio();
        this.audio.preload = 'auto';
        this.url = URL.createObjectURL(this.source);
        this.audio.src = this.url;
        this.installAudioEvents();
        // Attach MediaSource before the queue asks to play, so the next
        // segment can buffer its initial frames while the current one speaks.
        this.audio.load();
        this.source.addEventListener('sourceopen', () => {
          if (this.stopped || !this.source || this.source.readyState !== 'open') return;
          try {
            this.buffer = this.source.addSourceBuffer(this.mime);
            this.buffer.mode = 'sequence';
            this.buffer.addEventListener('updateend', () => this.pump());
            this.buffer.addEventListener('error', () => this.fail(new Error('Audio decoding failed.')));
            this.pump();
          } catch (reason) { this.fail(reason); }
        }, { once: true });
      }
      return;
    }
    if (!this.mime) { this.fail(new Error('Speech stream has no audio format.')); return; }
    if (event.type === 'chunk') {
      this.total += event.bytes.byteLength;
      if (this.total > 16_000_000) { this.fail(new Error('Audio stream is too large.')); return; }
      if (event.bytes.byteLength) this.received.push(new Uint8Array(event.bytes));
      this.pump();
    } else if (event.type === 'end') {
      if (this.total === 0) { this.fail(new Error('Voice provider returned no audio.')); return; }
      this.finished = true;
      this.pump();
    }
  }

  play(signal: AbortSignal, onFirstAudio?: (ms: number) => void): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (signal.aborted || this.stopped) { this.cancel(); return Promise.resolve(); }
    this.playbackRequested = true;
    this.firstAudio = onFirstAudio ?? null;
    return new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      const onAbort = () => this.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      this.detachAbort = () => signal.removeEventListener('abort', onAbort);
      this.pump();
    });
  }

  /** Silences immediately and forgets late network chunks, even for prefetched sentences. */
  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.detachAbort?.();
    this.detachAbort = null;
    this.playbackStarting = false;
    this.unsubscribe();
    this.received.length = 0;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = '';
    this.resolve?.();
    this.resolve = this.reject = null;
  }

  fail(reason: unknown): void {
    if (this.stopped) return;
    this.error = reason instanceof Error ? reason : new Error('Audio playback failed.');
    this.reject?.(this.error);
    this.resolve = this.reject = null;
    this.cancel();
  }

  private installAudioEvents(): void {
    if (!this.audio) return;
    this.audio.onplaying = () => {
      if (this.playing || this.stopped) return;
      this.playing = true;
      this.firstAudio?.(Math.round(performance.now() - this.startedAt));
    };
    this.audio.onended = () => { this.resolve?.(); this.cancel(); };
    this.audio.onerror = () => this.fail(new Error('Audio playback failed.'));
  }

  private pump(): void {
    if (this.stopped || this.error) return;
    if (this.source) {
      if (!this.buffer || this.buffer.updating) return;
      const bytes = this.received.shift();
      if (bytes) {
        try {
          this.buffer.appendBuffer(bytes as BufferSource);
          if (this.playbackRequested) this.startPlayback();
        } catch (reason) { this.fail(reason); }
      } else if (this.finished && this.source.readyState === 'open') {
        try { this.source.endOfStream(); } catch (reason) { this.fail(reason); }
      }
    } else if (this.finished && !this.audio) {
      // Gemini WAV and other formats unsupported by MediaSource arrive complete.
      // Create/load the next sentence's audio while the previous one still plays.
      // Starting playback remains the queue's exclusive, ordered decision.
      const parts = this.received.map(bytes => new Uint8Array(bytes));
      this.received.length = 0;
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.url = URL.createObjectURL(new Blob(parts, { type: this.mime }));
      this.audio.src = this.url;
      this.installAudioEvents();
      this.audio.load();
    }
    if (this.audio && this.playbackRequested) this.startPlayback();
  }

  private startPlayback(): void {
    if (!this.audio || this.stopped || !this.playbackRequested || !this.audio.paused || this.playbackStarting) return;
    this.playbackStarting = true;
    void this.audio.play()
      .then(() => { this.playbackStarting = false; })
      .catch(error => { this.playbackStarting = false; if (!this.stopped) this.fail(error); });
  }
}
