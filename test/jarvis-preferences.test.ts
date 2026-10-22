import { describe, expect, it } from 'vitest';
import { parseJarvisPreferences } from '../src/renderer/jarvis.js';

describe('Jarvis preference admission', () => {
  it('starts opt-out and with no speech synthesis', () => {
    expect(parseJarvisPreferences(null)).toEqual({ enabled: false, key: 'F8', language: '', tts: false, voice: '' });
  });
  it('only admits supported hold keys and bounded language and voice settings', () => {
    expect(parseJarvisPreferences({ enabled: true, key: 'Alt+Space', tts: 'yes', voice: 'a'.repeat(500), language: 'pt-BR<script>' })).toEqual({
      enabled: true, key: 'F8', language: 'pt-BRscript', tts: false, voice: 'a'.repeat(120)
    });
    expect(parseJarvisPreferences({ key: 'F10', tts: true }).key).toBe('F10');
  });
});
