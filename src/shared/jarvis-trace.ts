/** Bounded diagnostic metadata only. No transcript, provider URL, credentials or error strings. */
export type JarvisTrace = {
  step: 'send' | 'receipt' | 'observed' | 'gate' | 'decision' | 'speak-call' | 'speak-result' | 'wait' | 'cancel' | 'session-change' | 'provider-status';
  reason?: 'accepted' | 'rejected' | 'not-selected' | 'not-eligible' | 'not-confirmed' | 'no-link' | 'ambiguous-link' | 'no-text' | 'empty-sentences' | 'tts-disabled' | 'provider' | 'system' | 'unavailable' | 'stream' | 'audio' | 'success' | 'failed' | 'aborted' | 'stale' | 'error' | 'complete' | 'partial';
  sessionId?: string;
  inputId?: string;
  messageId?: string;
  turnId?: string;
  enabled?: boolean;
  tts?: boolean;
  consented?: boolean;
  target?: boolean;
  providerReady?: boolean;
  providerSpeaks?: boolean;
  systemSpeech?: boolean;
  providerChecked?: boolean;
  engine?: 'auto' | 'provider' | 'local' | 'system';
};
