import { describe, expect, it } from 'vitest';
import { parseJarvisPreferences } from '../src/renderer/jarvis.js';
import { jarvisVoiceSttReady, JARVIS_VOICE_PRESETS } from '../src/shared/jarvis-voice.js';

const provider = { baseUrl: '', sttMode: 'transcriptions', sttModel: '', ttsModel: '', voice: '' };
const base = { enabled: false, key: 'F8', language: '', tts: false, voice: '', engine: 'auto', audioModel: '', ttsEngine: 'auto', continuous: false, earcons: true, provider, version: 2 };

describe('Jarvis preference admission', () => {
  it('starts opt-out, push-to-talk only and with no speech synthesis', () => {
    expect(parseJarvisPreferences(null)).toEqual(base);
  });
  it('only admits supported hold keys and bounded language and voice settings', () => {
    expect(parseJarvisPreferences({ enabled: true, key: 'Alt+Space', tts: 'yes', voice: 'a'.repeat(500), language: 'pt-BR<script>', continuous: 'yes' })).toEqual({
      ...base, enabled: true, language: 'pt-BRscript', voice: 'a'.repeat(120)
    });
    expect(parseJarvisPreferences({ key: 'F10', tts: true }).key).toBe('F10');
  });
  it('moves J1/J2 saved defaults to the provider-first order but keeps an explicit J3 choice', () => {
    expect(parseJarvisPreferences({ engine: 'cliproxy' }).engine).toBe('auto');
    expect(parseJarvisPreferences({ engine: 'cliproxy', version: 2 }).engine).toBe('cliproxy');
    expect(parseJarvisPreferences({ engine: 'windows' }).engine).toBe('windows');
    expect(parseJarvisPreferences({ engine: 'provider', version: 2 }).engine).toBe('provider');
  });
  it('keeps a valid voice provider and drops unsafe URLs or names', () => {
    const ok = parseJarvisPreferences({ provider: { baseUrl: 'https://g4f.space/v1/', sttMode: 'chat-audio', sttModel: 'srv_abc:models/gemini-flash-latest', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy' } });
    expect(ok.provider).toEqual({ baseUrl: 'https://g4f.space/v1', sttMode: 'chat-audio', sttModel: 'srv_abc:models/gemini-flash-latest', ttsModel: 'gpt-4o-mini-tts', voice: 'alloy' });
    expect(parseJarvisPreferences({ provider: { baseUrl: 'http://g4f.space/v1', sttModel: 'a b', voice: '<x>' } }).provider).toEqual(provider);
    expect(parseJarvisPreferences({ provider: { baseUrl: 'http://127.0.0.1:8080/v1' } }).provider.baseUrl).toBe('http://127.0.0.1:8080/v1');
  });
  it('upgrades the existing Gemini TTS-only configuration to provide microphone transcription', () => {
    const fromRevisionSeven = parseJarvisPreferences({
      enabled: true, tts: true, engine: 'auto', ttsEngine: 'provider',
      provider: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', sttMode: 'transcriptions', sttModel: '', ttsModel: 'gemini-3.8-flash-tts', voice: 'Charon' },
      version: 2
    });
    expect(fromRevisionSeven.provider.sttModel).toBe('gemini-3.8-flash');
    expect(jarvisVoiceSttReady(fromRevisionSeven.provider)).toBe(true);
    expect(fromRevisionSeven.provider.ttsModel).toBe('gemini-3.8-flash-tts');
    expect(fromRevisionSeven.ttsEngine).toBe('provider');
    expect(JARVIS_VOICE_PRESETS['Google Gemini TTS'].sttModel).toBe('gemini-3.8-flash');
    expect(parseJarvisPreferences({ provider: { baseUrl: 'https://g4f.space/v1', sttModel: '' } }).provider.sttModel).toBe('');
  });
});
