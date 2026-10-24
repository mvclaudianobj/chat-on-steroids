/**
 * In-app playback EVENT telemetry. "playing" is a Chromium event, NOT proof
 * that sound reached the speakers or that a person heard it.
 * Never stores text, voice identities, endpoints, keys or conversation ids.
 */
export interface JarvisPlaybackSample {
  /** From first TTS enqueue, not from microphone capture or user submission. */
  firstPlayingEventMs: number | null;
  interSegmentGapMs: number[];
  segmentsStarted: number;
  segmentsFinished: number;
  failures: number;
  maxQueued: number;
  elapsedMs: number;
}

export class JarvisPlaybackMetrics {
  private first: number | null = null;
  private lastEnded: number | null = null;
  private readonly gaps: number[] = [];
  private started = 0;
  private finished = 0;
  private failures = 0;
  private maxQueued = 0;
  private readonly MAX_GAPS = 128;
  constructor(private readonly began: number, private readonly clock: () => number = () => performance.now()) {}
  queued(depth: number): void { this.maxQueued = Math.max(this.maxQueued, Math.max(0, Math.floor(depth))); }
  playing(): void {
    const now = this.clock();
    if (this.first === null) this.first = now;
    if (this.lastEnded !== null && this.gaps.length < this.MAX_GAPS) this.gaps.push(Math.max(0, now - this.lastEnded));
    this.lastEnded = null;
    this.started++;
  }
  ended(): void { this.lastEnded = this.clock(); this.finished++; }
  failed(): void { this.failures++; this.lastEnded = null; }
  /** Aggregate only, without storing transcripts or provider identifiers. */
  summary(): { first: number | null; meanGap: number | null; maxGap: number | null; played: number; failures: number; queuePeak: number } {
    const gaps = this.gaps;
    return {
      first: this.first === null ? null : Math.round(Math.max(0, this.first - this.began)),
      meanGap: gaps.length ? Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) : null,
      maxGap: gaps.length ? Math.round(Math.max(...gaps)) : null,
      played: this.started, failures: this.failures, queuePeak: this.maxQueued
    };
  }
  snapshot(): JarvisPlaybackSample {
    return {
      firstPlayingEventMs: this.first === null ? null : Math.round(Math.max(0, this.first - this.began)),
      interSegmentGapMs: this.gaps.map(v => Math.round(v)),
      segmentsStarted: this.started, segmentsFinished: this.finished,
      failures: this.failures, maxQueued: this.maxQueued,
      elapsedMs: Math.round(Math.max(0, this.clock() - this.began))
    };
  }
}
