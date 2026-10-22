import { describe, expect, it } from 'vitest';
import {
  initialJarvisPttState, isJarvisAudioModelId, parseJarvisPttUserCommand, reduceJarvisPtt,
  type JarvisPttEvent, type JarvisPttState
} from '../src/shared/jarvis-ptt.js';

function run(...events: JarvisPttEvent[]) {
  let state: JarvisPttState = initialJarvisPttState();
  const effects = [] as ReturnType<typeof reduceJarvisPtt>['effects'];
  for (const event of events) {
    const result = reduceJarvisPtt(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

const consent = { type: 'consent', microphone: true, cliProxyAudio: true } as const;
const select = { type: 'select-model', modelId: 'gpt-4o-mini-transcribe' } as const;

describe('Jarvis J opt-in push-to-talk foundation', () => {
  it('stays inert by default and requires both temporary consent and an audio model before capture', () => {
    expect(initialJarvisPttState()).toMatchObject({ phase: 'idle', consented: false, modelId: null });
    expect(run({ type: 'press' }, select, { type: 'press' }).effects).toEqual([]);
    expect(run(consent, { type: 'press' }).effects).toEqual([]);
    expect(run(consent, select, { type: 'press' })).toMatchObject({
      state: { phase: 'starting', consented: true, attempt: 1 },
      effects: [{ type: 'capture-start', attempt: 1 }]
    });
  });

  it('rejects credentials, raw audio, partial consent, malformed payloads and unsupported models', () => {
    expect(parseJarvisPttUserCommand(consent)).toEqual(consent);
    for (const value of [
      { type: 'consent', microphone: true, cliProxyAudio: false },
      { type: 'consent', microphone: true },
      { type: 'press', token: 'not-for-ipc' },
      { type: 'release', audio: [1, 2, 3] },
      { type: 'select-model', modelId: select.modelId, apiKey: 'secret' },
      { type: 'capture-started', attempt: 1 },
      { type: 'select-model', modelId: 'x'.repeat(129) },
      null
    ]) expect(() => parseJarvisPttUserCommand(value)).toThrow();
    expect(isJarvisAudioModelId('gpt-4o-mini-transcribe')).toBe(true);
    expect(isJarvisAudioModelId('gpt-4o-mini-tts')).toBe(true);
    expect(isJarvisAudioModelId('gpt-6-sol')).toBe(false);
    expect(isJarvisAudioModelId('https://proxy.invalid/audio')).toBe(false);
    expect(run(consent, { type: 'select-model', modelId: 'gpt-6-sol' }, { type: 'press' }).effects).toEqual([]);
  });

  it('captures on a single press, stops on release, and only then asks CLIProxy to transcribe', () => {
    const result = run(consent, select, { type: 'press' }, { type: 'press' },
      { type: 'capture-started', attempt: 1 }, { type: 'capture-started', attempt: 1 },
      { type: 'release' }, { type: 'release' },
      { type: 'capture-stopped', attempt: 1, hasAudio: true },
      { type: 'transcription-completed', attempt: 1 });
    expect(result.state.phase).toBe('idle');
    expect(result.effects).toEqual([
      { type: 'capture-start', attempt: 1 },
      { type: 'capture-stop', attempt: 1 },
      { type: 'cliproxy-transcribe', attempt: 1, modelId: select.modelId }
    ]);
    expect(JSON.stringify(result)).not.toMatch(/apiKey|token|audioBytes|authorization/i);
  });

  it('does not upload a silent capture or audio stopped without a release', () => {
    expect(run(consent, select, { type: 'press' }, { type: 'release' },
      { type: 'capture-stopped', attempt: 1, hasAudio: false }).effects).toEqual([
      { type: 'capture-start', attempt: 1 }, { type: 'capture-stop', attempt: 1 }
    ]);
    expect(run(consent, select, { type: 'press' }, { type: 'capture-started', attempt: 1 },
      { type: 'capture-stopped', attempt: 1, hasAudio: true }).effects).toEqual([
      { type: 'capture-start', attempt: 1 }, { type: 'capture-stop-discard', attempt: 1 }
    ]);
  });

  it('stops after a fast release even if device initialization acknowledges late', () => {
    const result = run(consent, select, { type: 'press' }, { type: 'release' },
      { type: 'capture-started', attempt: 1 }, { type: 'capture-stopped', attempt: 1, hasAudio: false });
    expect(result.state.phase).toBe('idle');
    expect(result.effects).toEqual([
      { type: 'capture-start', attempt: 1 }, { type: 'capture-stop', attempt: 1 },
      { type: 'capture-stop', attempt: 1 }
    ]);
  });

  it('rejects stale events after cancellation, close or a new hold', () => {
    const result = run(consent, select, { type: 'press' }, { type: 'cancel' },
      { type: 'capture-started', attempt: 1 }, { type: 'capture-stopped', attempt: 1, hasAudio: true },
      { type: 'press' }, { type: 'capture-started', attempt: 1 }, { type: 'release' },
      { type: 'capture-stopped', attempt: 1, hasAudio: true });
    expect(result.state.phase).toBe('stopping');
    expect(result.state.attempt).toBe(2);
    expect(result.effects).toEqual([
      { type: 'capture-start', attempt: 1 }, { type: 'capture-stop-discard', attempt: 1 },
      { type: 'capture-stop-discard', attempt: 1 }, { type: 'capture-start', attempt: 2 },
      { type: 'capture-stop-discard', attempt: 1 }, { type: 'capture-stop', attempt: 2 }
    ]);
    const closed = run(consent, select, { type: 'press' }, { type: 'close' },
      { type: 'capture-started', attempt: 1 }, { type: 'press' });
    expect(closed.state).toMatchObject({ phase: 'idle', consented: false, modelId: null, attempt: 2 });
    expect(closed.effects).toEqual([
      { type: 'capture-start', attempt: 1 }, { type: 'capture-stop-discard', attempt: 1 },
      { type: 'capture-stop-discard', attempt: 1 }
    ]);
    const reopened = reduceJarvisPtt(closed.state, consent).state;
    const newHold = reduceJarvisPtt(reduceJarvisPtt(reopened, select).state, { type: 'press' }).state;
    expect(newHold.attempt).toBe(3);
    expect(reduceJarvisPtt(newHold, { type: 'capture-started', attempt: 1 })).toEqual({
      state: newHold, effects: [{ type: 'capture-stop-discard', attempt: 1 }]
    });
  });

  it('revokes temporary consent and cancels in-flight CLIProxy work without exposing its errors', () => {
    const result = run(consent, select, { type: 'press' }, { type: 'release' },
      { type: 'capture-stopped', attempt: 1, hasAudio: true }, { type: 'revoke-consent' },
      { type: 'transcription-completed', attempt: 1 }, { type: 'press' });
    expect(result.state).toMatchObject({ phase: 'idle', consented: false });
    expect(result.effects.at(-1)).toEqual({ type: 'cliproxy-cancel', attempt: 1 });
    expect(result.effects.filter(x => x.type === 'cliproxy-transcribe')).toHaveLength(1);
    const failed = run(consent, select, { type: 'press' }, { type: 'failed', attempt: 1, reason: 'capture-failed' });
    expect(failed.state).toMatchObject({ phase: 'error', error: 'capture-failed' });
    expect(failed.effects.at(-1)).toEqual({ type: 'capture-stop-discard', attempt: 1 });
    expect(reduceJarvisPtt(failed.state, { type: 'cancel' }).state.phase).toBe('idle');
  });
});
