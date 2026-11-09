/**
 * Jarvis J foundation: an in-memory push-to-talk contract. This module neither opens a
 * microphone nor sends a request. The eventual main-process owner must execute each
 * effect against an explicitly selected capture device and the existing CLIProxy client.
 * Audio bytes and API credentials must never be placed in these shared/IPC shapes.
 */
import { z } from 'zod';
import { modelModality } from './api-chat.js';

export type JarvisPttPhase = 'idle' | 'starting' | 'listening' | 'stopping' | 'transcribing' | 'error';
export type JarvisPttError = 'capture-failed' | 'transcription-failed';

export interface JarvisPttState {
  phase: JarvisPttPhase;
  /** Consent is temporary and must never be restored from persisted settings. */
  consented: boolean;
  /** Exact identifier selected from the CLIProxy audio-model catalog, without any key. */
  modelId: string | null;
  /** Monotonic owner of async acknowledgements in this process, not a persisted session id. */
  attempt: number;
  error: JarvisPttError | null;
}

export const initialJarvisPttState = (): JarvisPttState => ({
  phase: 'idle', consented: false, modelId: null, attempt: 0, error: null
});

/** Strict renderer-command boundary: forbid audio data, tokens, endpoints and surprise fields. */
const userCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('consent'), microphone: z.literal(true), cliProxyAudio: z.literal(true) }).strict(),
  z.object({ type: z.literal('select-model'), modelId: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal('press') }).strict(),
  z.object({ type: z.literal('release') }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
  z.object({ type: z.literal('revoke-consent') }).strict()
]);

export type JarvisPttUserCommand = z.infer<typeof userCommand>;

export function parseJarvisPttUserCommand(value: unknown): JarvisPttUserCommand {
  return userCommand.parse(value);
}

/** These acknowledgements belong only to the future main-process capture/network owner. */
export type JarvisPttEvent = JarvisPttUserCommand |
  { type: 'capture-started'; attempt: number } |
  { type: 'capture-stopped'; attempt: number; hasAudio: boolean } |
  { type: 'transcription-completed'; attempt: number } |
  { type: 'failed'; attempt: number; reason: JarvisPttError } |
  { type: 'close' };

export type JarvisPttEffect =
  | { type: 'capture-start'; attempt: number }
  | { type: 'capture-stop-discard'; attempt: number }
  | { type: 'capture-stop'; attempt: number }
  | { type: 'cliproxy-transcribe'; attempt: number; modelId: string }
  | { type: 'cliproxy-cancel'; attempt: number };

export interface JarvisPttTransition {
  state: JarvisPttState;
  effects: JarvisPttEffect[];
}

/** Catalog classification is a first gate; the actual endpoint must confirm model availability. */
export function isJarvisAudioModelId(modelId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(modelId) && modelModality(modelId) === 'audio';
}

function stoppingEffects(state: JarvisPttState): JarvisPttEffect[] {
  if (state.phase === 'starting' || state.phase === 'listening' || state.phase === 'stopping') {
    return [{ type: 'capture-stop-discard', attempt: state.attempt }];
  }
  return state.phase === 'transcribing' ? [{ type: 'cliproxy-cancel', attempt: state.attempt }] : [];
}

/**
 * Pure transition function: sending or recording requires executing an effect separately.
 * A release never starts another capture; old asynchronous callbacks cannot revive one.
 */
export function reduceJarvisPtt(state: JarvisPttState, event: JarvisPttEvent): JarvisPttTransition {
  const unchanged = (): JarvisPttTransition => ({ state, effects: [] });
  const update = (next: JarvisPttState, effects: JarvisPttEffect[] = []): JarvisPttTransition =>
    ({ state: next, effects });

  switch (event.type) {
    case 'consent':
      return state.phase === 'idle' && event.microphone === true && event.cliProxyAudio === true
        ? update({ ...state, consented: true }) : unchanged();
    case 'revoke-consent':
      return update({ ...state, phase: 'idle', consented: false, error: null }, stoppingEffects(state));
    case 'select-model':
      return state.phase === 'idle' && isJarvisAudioModelId(event.modelId)
        ? update({ ...state, modelId: event.modelId }) : unchanged();
    case 'press': {
      if (state.phase !== 'idle' || !state.consented || !state.modelId) return unchanged();
      const attempt = state.attempt + 1;
      return update({ ...state, phase: 'starting', attempt, error: null }, [{ type: 'capture-start', attempt }]);
    }
    case 'release':
      return state.phase === 'starting' || state.phase === 'listening'
        ? update({ ...state, phase: 'stopping' }, [{ type: 'capture-stop', attempt: state.attempt }]) : unchanged();
    case 'capture-started':
      // A delayed device acknowledgement is still an open microphone: close it even
      // after cancellation, a newer attempt or a window close has invalidated its id.
      if (event.attempt !== state.attempt) return update(state, [
        { type: 'capture-stop-discard', attempt: event.attempt }
      ]);
      if (state.phase === 'starting') return update({ ...state, phase: 'listening' });
      if (state.phase === 'listening') return unchanged();
      // If release raced with device initialization, stop the newly opened device again.
      if (state.phase === 'stopping' || state.phase === 'transcribing') {
        return update(state, [{ type: 'capture-stop', attempt: state.attempt }]);
      }
      return update(state, [{ type: 'capture-stop-discard', attempt: state.attempt }]);
    case 'capture-stopped':
      if (event.attempt !== state.attempt) return unchanged();
      if (state.phase === 'starting' || state.phase === 'listening') {
        // Hardware stopped by itself: do not upload audio without an explicit release.
        return update({ ...state, phase: 'idle' }, [{ type: 'capture-stop-discard', attempt: state.attempt }]);
      }
      if (state.phase !== 'stopping') return unchanged();
      if (!event.hasAudio || !state.consented || !state.modelId) return update({ ...state, phase: 'idle' });
      return update({ ...state, phase: 'transcribing' }, [
        { type: 'cliproxy-transcribe', attempt: state.attempt, modelId: state.modelId }
      ]);
    case 'transcription-completed':
      return event.attempt === state.attempt && state.phase === 'transcribing'
        ? update({ ...state, phase: 'idle' }) : unchanged();
    case 'cancel':
      return state.phase === 'idle' && !state.error ? unchanged()
        : update({ ...state, phase: 'idle', error: null }, stoppingEffects(state));
    case 'failed':
      if (event.attempt !== state.attempt || state.phase === 'idle' || state.phase === 'error') return unchanged();
      return update({ ...state, phase: 'error', error: event.reason }, stoppingEffects(state));
    case 'close':
      // Invalidate pending asynchronous acknowledgements even if the UI opens again.
      return update({ ...initialJarvisPttState(), attempt: state.attempt + 1 }, stoppingEffects(state));
  }
}
