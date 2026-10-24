import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const document = new JSDOM(html).window.document;

describe('Jarvis ChatGPT-native Settings and composer UX contract', () => {
  it('offers the normal ChatGPT route in Settings with an active-chat indicator and navigation', () => {
    const panel = document.querySelector<HTMLElement>('[data-panel="jarvis"]')!;
    expect(panel.textContent).toMatch(/ChatGPT normal/);
    expect(panel.textContent).not.toMatch(/Requires a CLIProxy chat|Hold to speak in a CLIProxy chat|Current CLIProxy chat model/);
    expect(panel.querySelector('#jarvisActiveChat')?.getAttribute('role')).toBe('status');
    expect(panel.querySelector('#jarvisGoToChat')).not.toBeNull();
    expect(panel.querySelector('#jarvisReadiness')?.getAttribute('aria-live')).toBe('polite');
    expect(panel.querySelector('#jarvisModelInfo')).not.toBeNull();
  });
  it('lets a normal ChatGPT chat discover Jarvis setup beside the push-to-talk button', () => {
    expect(document.getElementById('jarvisTalk')).not.toBeNull();
    const setup = document.getElementById('jarvisSetupChat') as HTMLButtonElement | null;
    expect(setup?.type).toBe('button');
    expect(setup?.getAttribute('aria-describedby')).toBe('jarvisStatus');
  });
  it('keeps route setup localized in all 12 shipped catalogs', () => {
    const keys = ['Jarvis with ChatGPT normal', 'Set up Jarvis', 'Selected ChatGPT conversation: {0}',
      'Speech-to-text (STT) is not configured or available.', 'Spoken replies (TTS) are off. Enable Speak replies to hear ChatGPT.'];
    for (const locale of ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW']) {
      const data = JSON.parse(readFileSync(new URL(`../src/renderer/locales/${locale}.json`, import.meta.url), 'utf8')) as Record<string,string>;
      for (const key of keys) expect(data[key], `${locale} missing ${key}`).toBeTruthy();
    }
  });
});
