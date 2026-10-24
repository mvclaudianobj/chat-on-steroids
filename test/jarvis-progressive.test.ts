import { afterEach, describe, expect, it, vi } from 'vitest';
import { JarvisProgressiveAudio, type JarvisProgressEvent } from '../src/renderer/jarvis-progressive.js';

let listener: ((event: JarvisProgressEvent) => void) | null = null;
let disposed = 0;
const subscribe = (callback: (event: JarvisProgressEvent) => void) => {
  listener = callback;
  return () => { disposed++; listener = null; };
};
const send = (event: JarvisProgressEvent) => listener?.(event);

class FakeAudio {
  src = '';
  preload = '';
  paused = true;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static played = 0;
  static created: FakeAudio[] = [];
  static loaded = 0;
  static playAttempts = 0;
  static delayPlay = false;
  static releasePlay: (() => void) | null = null;
  constructor() { FakeAudio.created.push(this); }
  play(): Promise<void> {
    FakeAudio.playAttempts++;
    const start = () => { this.paused = false; FakeAudio.played++; this.onplaying?.(); };
    if (FakeAudio.delayPlay) return new Promise(resolve => { FakeAudio.releasePlay = () => { start(); resolve(); }; });
    start(); return Promise.resolve();
  }
  pause(): void { this.paused = true; }
  load(): void { FakeAudio.loaded++; }
  removeAttribute(): void { this.src = ''; }
  finish(): void { this.onended?.(); }
}

class FakeBuffer {
  updating = false;
  mode = 'segments';
  static appended: number[] = [];
  private readonly callbacks = new Map<string, () => void>();
  addEventListener(type: string, listener: () => void): void { this.callbacks.set(type, listener); }
  appendBuffer(data: BufferSource): void {
    FakeBuffer.appended.push(data.byteLength);
    queueMicrotask(() => this.callbacks.get('updateend')?.());
  }
}

class FakeMediaSource {
  readyState = 'open';
  static isTypeSupported(type: string): boolean { return type === 'audio/mpeg'; }
  static last: FakeMediaSource | null = null;
  static ended = 0;
  static onOpen: (() => void) | null = null;
  constructor() { FakeMediaSource.last = this; }
  addEventListener(type: string, callback: () => void): void {
    if (type === 'sourceopen') FakeMediaSource.onOpen = callback;
  }
  addSourceBuffer(): FakeBuffer { return new FakeBuffer(); }
  endOfStream(): void { FakeMediaSource.ended++; this.readyState = 'ended'; }
  open(): void { FakeMediaSource.onOpen?.(); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  listener = null;
  disposed = 0;
  FakeAudio.played = 0;
  FakeAudio.created = [];
  FakeAudio.loaded = 0;
  FakeAudio.playAttempts = 0;
  FakeAudio.delayPlay = false;
  FakeAudio.releasePlay = null;
  FakeBuffer.appended = [];
  FakeMediaSource.ended = 0;
  FakeMediaSource.last = null;
  FakeMediaSource.onOpen = null;
});

describe('Jarvis incremental audio playback', () => {
  function prepare(): JarvisProgressiveAudio {
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('MediaSource', FakeMediaSource);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:synthetic', revokeObjectURL: vi.fn() });
    return new JarvisProgressiveAudio('turn-a', subscribe);
  }

  it('starts playback after the first audio chunk while the provider stream is still open', async () => {
    const player = prepare();
    const firstAudio = vi.fn();
    const playing = player.play(new AbortController().signal, firstAudio);
    send({ requestId: 'turn-a', type: 'start', mime: 'audio/mpeg' });
    FakeMediaSource.last!.open();
    send({ requestId: 'turn-b', type: 'chunk', bytes: new Uint8Array([9]) });
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([1, 2, 3]) });
    await vi.waitFor(() => expect(FakeAudio.played).toBeGreaterThan(0));
    expect(FakeBuffer.appended).toEqual([3]);
    expect(firstAudio).toHaveBeenCalledOnce();
    expect(FakeMediaSource.ended).toBe(0);
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([4, 5]) });
    send({ requestId: 'turn-a', type: 'end' });
    await vi.waitFor(() => expect(FakeMediaSource.ended).toBe(1));
    player.cancel();
    await playing;
  });
  it('prepares MediaSource before playback and requests play only once while the first frames buffer', async () => {
    const player = prepare();
    FakeAudio.delayPlay = true;
    send({ requestId: 'turn-a', type: 'start', mime: 'audio/mpeg' });
    expect(FakeAudio.created).toHaveLength(1);
    expect(FakeAudio.created[0]?.preload).toBe('auto');
    expect(FakeAudio.loaded).toBe(1);
    FakeMediaSource.last!.open();
    const first = vi.fn();
    const playing = player.play(new AbortController().signal, first);
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([1, 2, 3]) });
    await vi.waitFor(() => expect(FakeAudio.playAttempts).toBe(1));
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([4, 5]) });
    await vi.waitFor(() => expect(FakeBuffer.appended).toHaveLength(2));
    expect(FakeAudio.playAttempts).toBe(1);
    expect(first).not.toHaveBeenCalled();
    FakeAudio.releasePlay?.();
    expect(first).toHaveBeenCalledOnce();
    player.cancel(); await playing;
  });
  it('drops repeated end and late chunks after the provider completed an MSE segment', async () => {
    const player = prepare();
    send({ requestId: 'turn-a', type: 'start', mime: 'audio/mpeg' });
    FakeMediaSource.last!.open();
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([1, 2, 3]) });
    send({ requestId: 'turn-a', type: 'end' });
    await vi.waitFor(() => expect(FakeMediaSource.ended).toBe(1));
    send({ requestId: 'turn-a', type: 'end' });
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([4, 5]) });
    send({ requestId: 'turn-a', type: 'start', mime: 'audio/mpeg' });
    await Promise.resolve();
    expect(FakeBuffer.appended).toEqual([3]);
    expect(FakeMediaSource.ended).toBe(1);
    const playing = player.play(new AbortController().signal);
    expect(FakeAudio.played).toBe(1);
    player.cancel();
    await playing;
  });

  it('drops late audio on interruption without playing the previous turn', async () => {
    const player = prepare();
    const abort = new AbortController();
    const playing = player.play(abort.signal);
    abort.abort();
    send({ requestId: 'turn-a', type: 'start', mime: 'audio/mpeg' });
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([1]) });
    send({ requestId: 'turn-a', type: 'end' });
    await playing;
    expect(disposed).toBe(1);
    expect(FakeAudio.played).toBe(0);
  });

  it('falls back to a complete blob when MediaSource cannot decode a provider MIME type', async () => {
    const player = prepare();
    const playing = player.play(new AbortController().signal);
    send({ requestId: 'turn-a', type: 'start', mime: 'audio/ogg' });
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([1]) });
    expect(FakeAudio.played).toBe(0);
    send({ requestId: 'turn-a', type: 'end' });
    expect(FakeAudio.played).toBe(1);
    player.cancel();
    await playing;
  });

  it('preloads completed Gemini WAV ahead of its turn without starting it before the prior sentence ends', async () => {
    const player = prepare();
    send({ requestId: 'turn-a', type: 'start', mime: 'audio/wav' });
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([82, 73, 70, 70]) });
    send({ requestId: 'turn-a', type: 'end' });
    expect(FakeAudio.created).toHaveLength(1);
    expect(FakeAudio.created[0]?.preload).toBe('auto');
    expect(FakeAudio.created[0]?.src).toBe('blob:synthetic');
    expect(FakeAudio.loaded).toBe(1);
    expect(FakeAudio.played).toBe(0); // The previous sentence still owns the speaker.
    const playing = player.play(new AbortController().signal);
    expect(FakeAudio.created).toHaveLength(1);
    expect(FakeAudio.played).toBe(1);
    player.cancel(); await playing;
    expect(disposed).toBe(1);
    send({ requestId: 'turn-a', type: 'chunk', bytes: new Uint8Array([5]) });
    expect(FakeAudio.played).toBe(1);
  });
});
