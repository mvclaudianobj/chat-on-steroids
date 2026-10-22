/** Optional Windows push-to-talk for the currently selected CLIProxy chat.
 * Windows owns speech recognition; no raw audio is copied to the renderer or persisted.
 */
import { isApiConversationId } from '../shared/api-chat.js';
import type { DictationEvent } from '../shared/dictation.js';
import type { AppApi } from '../preload/index.js';
import { t } from './i18n.js';

const KEY = 'chat-marks.jarvis.settings.v1';
type Preferences = { enabled: boolean; key: 'F8' | 'F9' | 'F10' | 'F11'; language: string; tts: boolean; voice: string };
const defaults: Preferences = { enabled: false, key: 'F8', language: '', tts: false, voice: '' };

export function parseJarvisPreferences(value: unknown): Preferences {
  if (!value || typeof value !== 'object') return { ...defaults };
  const data = value as Partial<Preferences>;
  return {
    enabled: data.enabled === true,
    key: data.key === 'F9' || data.key === 'F10' || data.key === 'F11' ? data.key : 'F8',
    language: typeof data.language === 'string' ? data.language.slice(0, 35).replace(/[^a-zA-Z-]/g, '') : '',
    tts: data.tts === true,
    voice: typeof data.voice === 'string' ? data.voice.slice(0, 120) : ''
  };
}

export function initJarvis(api: AppApi, selected: () => { id: string; conversationId: string | null; engine?: string } | null): void {
  const find = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const button = find<HTMLButtonElement>('jarvisTalk');
  const status = find<HTMLElement>('jarvisSettingsStatus');
  const enable = find<HTMLInputElement>('jarvisEnabled');
  const consent = find<HTMLInputElement>('jarvisConsent');
  const key = find<HTMLSelectElement>('jarvisKey');
  const language = find<HTMLInputElement>('jarvisLanguage');
  const tts = find<HTMLInputElement>('jarvisTts');
  const voice = find<HTMLSelectElement>('jarvisVoice');
  let preferences = defaults;
  try { preferences = parseJarvisPreferences(JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { /* default */ }
  enable.checked = preferences.enabled;
  key.value = preferences.key;
  language.value = preferences.language;
  tts.checked = preferences.tts;
  let consented = false;
  let attempt = 0;
  let owner: string | null = null;
  let running = false;
  let stopping = false;
  let committed = '';
  let finished = false;
  let held = false;
  let speechVoice = preferences.voice;
  let expectedAnswer: { sessionId: string; turnId: string } | null = null;
  let spokenTurn: string | null = null;
  const recognitionAvailable = api.dictationSupported && typeof api.startDictation === 'function';
  const eligible = (): string | null => {
    const chat = selected();
    return chat && isApiConversationId(chat.conversationId) && (!chat.engine || chat.engine === 'cliproxy') ? chat.id : null;
  };
  function paint(): void {
    button.hidden = !preferences.enabled;
    button.disabled = !recognitionAvailable || !consented || !eligible() || stopping;
    button.dataset.state = running ? stopping ? 'stopping' : 'listening' : 'idle';
    button.setAttribute('aria-pressed', String(running));
    button.title = t('Hold to speak to Jarvis') + ` (${preferences.key})`;
    if (!recognitionAvailable) status.textContent = t('Jarvis speech recognition currently requires Windows.');
    else if (!consented) status.textContent = t('Enable microphone consent to use Jarvis.');
    else if (!eligible()) status.textContent = t('Select a CLIProxy chat to use Jarvis.');
    else if (!running && !status.textContent) status.textContent = t('Jarvis is ready.');
  }
  function stop(): void {
    if (!running || stopping) return;
    stopping = true;
    status.textContent = t('Finishing dictation…');
    paint();
    void api.stopDictation().then(reply => {
      if (!reply.ok) { cancel(); status.textContent = t(reply.error); }
    }).catch(() => { cancel(); });
  }
  function cancel(): void {
    attempt++;
    owner = null;
    committed = '';
    finished = false;
    held = false;
    if (running) void api.stopDictation().catch(() => undefined);
    running = false;
    stopping = false;
    expectedAnswer = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    paint();
  }
  function start(): void {
    if (running || !preferences.enabled || !consented || !recognitionAvailable) return;
    const target = eligible();
    if (!target) { paint(); return; }
    const id = ++attempt;
    owner = target;
    running = true;
    stopping = false;
    committed = '';
    finished = false;
    status.textContent = t('Preparing microphone…');
    paint();
    void api.startDictation(preferences.language).then(reply => {
      if (id !== attempt) { void api.stopDictation().catch(() => undefined); return; }
      if (!reply.ok) { cancel(); status.textContent = t(reply.error); }
    }).catch(() => { if (id === attempt) { cancel(); status.textContent = t('Dictation could not start. Check microphone access and try again.'); } });
  }
  function eventReceived(event: DictationEvent): void {
    if (!running || !owner) return;
    if (selected()?.id !== owner || !consented || !preferences.enabled) { cancel(); return; }
    if (event.type === 'final' && typeof event.text === 'string') {
      const chunk = event.text.trim();
      if (chunk) committed = chunk.startsWith(committed) ? chunk : committed ? `${committed} ${chunk}` : chunk;
    } else if (event.type === 'error') {
      cancel(); status.textContent = event.message.slice(0, 240);
    } else if (event.type === 'status' && event.status === 'stopped') {
      const text = committed.trim().slice(0, 32_000);
      const target = owner;
      const shouldSend = stopping && !finished && text && target === eligible();
      finished = true;
      running = false;
      stopping = false;
      owner = null;
      paint();
      if (!shouldSend) { status.textContent = t('No speech was sent.'); return; }
      status.textContent = t('Sending Jarvis message…');
      void api.apiChatSend(target!, text).then(reply => {
        if (reply.ok) {
          expectedAnswer = { sessionId: target!, turnId: reply.data.turnId };
          spokenTurn = null;
          status.textContent = t('Jarvis message sent to this CLIProxy chat.');
        } else status.textContent = t(reply.error);
      }).catch(() => { status.textContent = t('Jarvis message could not be sent.'); });
    } else if (event.type === 'status' && event.status === 'listening') status.textContent = t('Listening…');
  }
  api.onDictationEvent(eventReceived);
  let readingAnswer = false;
  api.onSessionChanged(change => {
    const expected = expectedAnswer;
    if (!expected || !preferences.tts || !('speechSynthesis' in window) || readingAnswer ||
        (change?.sessionIds && !change.sessionIds.includes(expected.sessionId))) return;
    readingAnswer = true;
    void api.getSession(expected.sessionId, { limit: 50 }).then(reply => {
      if (!reply.ok || expectedAnswer !== expected || !preferences.tts || selected()?.id !== expected.sessionId) return;
      const answer = [...reply.data.events].reverse().find(event => event.kind === 'assistant_message' &&
        event.turnId === expected.turnId && event.final === true);
      if (!answer || answer.kind !== 'assistant_message' || spokenTurn === expected.turnId) return;
      spokenTurn = expected.turnId;
      expectedAnswer = null;
      const utterance = new SpeechSynthesisUtterance(answer.message.text.slice(0, 4000));
      if (preferences.language) utterance.lang = preferences.language;
      const chosen = speechSynthesis.getVoices().find(candidate => candidate.voiceURI === preferences.voice);
      if (chosen) utterance.voice = chosen;
      speechSynthesis.speak(utterance);
    }).catch(() => undefined).finally(() => { readingAnswer = false; });
  });
  function persist(): void {
    preferences = parseJarvisPreferences({ enabled: enable.checked, key: key.value, language: language.value, tts: tts.checked, voice: voice.value });
    localStorage.setItem(KEY, JSON.stringify(preferences));
    if (!preferences.enabled) { cancel(); consented = false; consent.checked = false; }
    paint();
  }
  for (const element of [enable, key, language, tts, voice]) element.addEventListener('change', persist);
  consent.addEventListener('change', () => { consented = consent.checked; if (!consented) cancel(); paint(); });
  const fillVoices = (): void => {
    if (!('speechSynthesis' in window)) return;
    const voices = speechSynthesis.getVoices();
    voice.replaceChildren(new Option(t('System default'), ''));
    for (const candidate of voices) voice.appendChild(new Option(`${candidate.name} (${candidate.lang})`, candidate.voiceURI));
    voice.value = speechVoice;
  };
  fillVoices();
  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', fillVoices);
  voice.addEventListener('change', () => { speechVoice = voice.value; });
  button.addEventListener('pointerdown', event => { if (event.button !== 0 || button.disabled) return; event.preventDefault(); held = true; button.setPointerCapture(event.pointerId); start(); });
  button.addEventListener('pointerup', () => { if (held) { held = false; stop(); } });
  button.addEventListener('lostpointercapture', () => { if (held) { held = false; stop(); } });
  const input = find<HTMLTextAreaElement>('chatInput');
  input.addEventListener('keydown', event => {
    if (event.code !== preferences.key || event.repeat || event.altKey || event.ctrlKey || event.metaKey || !preferences.enabled) return;
    event.preventDefault(); held = true; start();
  });
  window.addEventListener('keyup', event => { if (held && event.code === preferences.key) { held = false; stop(); } }, true);
  window.addEventListener('blur', () => { held = false; cancel(); });
  window.addEventListener('jarvis:selection', () => { if (running || stopping) cancel(); paint(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('beforeunload', cancel, { once: true });
  // Consent and capture must never survive a page reload.
  paint();
}
