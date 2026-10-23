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
  paused = true;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static played = 0;
  play(): Promise<void> { this.paused = false; FakeAudio.played++; this.onplaying?.(); return Promise.resolve(); }
  pause(): void { this.paused = true; }
  load(): void {}
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
});
