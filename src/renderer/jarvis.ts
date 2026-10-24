/** Opt-in push-to-talk for the currently selected ChatGPT or CLIProxy chat.
 * MediaRecorder retains bounded audio only in memory until the selected transcriber consumes it.
 * J3 adds the user's OpenAI-compatible voice provider, sentence-by-sentence spoken answers with
 * barge-in, optional continuous conversation and a visible turn state.
 */
import { isApiConversationId } from '../shared/api-chat.js';
import { responseTurnId, type TimelineTurns } from '../shared/chronology.js';
import type { DictationEvent } from '../shared/dictation.js';
import type { SessionEvent } from '../shared/session.js';
import {
  JARVIS_VOICE_PRESETS, JARVIS_VOICE_SUGGESTIONS, JarvisSentenceSplitter, emptyJarvisVoiceConfig, jarvisVoiceSttReady,
  jarvisVoiceTtsReady, parseJarvisVoiceConfig, type JarvisVoiceConfig
} from '../shared/jarvis-voice.js';
import type { AppApi } from '../preload/index.js';
import { onLanguageChange, t } from './i18n.js';
import { JarvisSpeechQueue, playEarcon, watchSilence } from './jarvis-speech.js';
import { JarvisProgressiveAudio } from './jarvis-progressive.js';

const KEY = 'chat-marks.jarvis.settings.v1';
type Engine = 'provider' | 'cliproxy' | 'local' | 'windows';
type EngineChoice = 'auto' | Engine;
type TtsEngine = 'auto' | 'provider' | 'system';
export type JarvisPhase = 'idle' | 'listening' | 'stopping' | 'transcribing' | 'thinking' | 'speaking';
type Preferences = {
  enabled: boolean; key: 'F8' | 'F9' | 'F10' | 'F11'; language: string; tts: boolean; voice: string; engine: EngineChoice; audioModel: string;
  ttsEngine: TtsEngine; continuous: boolean; earcons: boolean; provider: JarvisVoiceConfig; version: 2;
};
const defaults: Preferences = {
  enabled: false, key: 'F8', language: '', tts: false, voice: '', engine: 'auto', audioModel: '',
  ttsEngine: 'auto', continuous: false, earcons: true, provider: emptyJarvisVoiceConfig(), version: 2
};
/** Default order once a voice provider is configured: provider → CLIProxy → local Whisper → Windows. */
const ORDER: Engine[] = ['provider', 'cliproxy', 'local', 'windows'];
const MAX_SPOKEN = 8000;

export function parseJarvisPreferences(value: unknown): Preferences {
  if (!value || typeof value !== 'object') return { ...defaults, provider: emptyJarvisVoiceConfig() };
  const data = value as Partial<Omit<Preferences, 'engine' | 'version'>> & { engine?: unknown; version?: unknown };
  let engine: EngineChoice = data.engine === 'provider' || data.engine === 'cliproxy' || data.engine === 'local' || data.engine === 'windows' ? data.engine : 'auto';
  // J1/J2 stored their default "cliproxy" on every save; the J3 default adds the provider first.
  if (data.version !== 2 && engine === 'cliproxy') engine = 'auto';
  return {
    enabled: data.enabled === true,
    key: data.key === 'F9' || data.key === 'F10' || data.key === 'F11' ? data.key : 'F8',
    language: typeof data.language === 'string' ? data.language.slice(0, 35).replace(/[^a-zA-Z-]/g, '') : '',
    tts: data.tts === true,
    voice: typeof data.voice === 'string' ? data.voice.slice(0, 120) : '',
    engine,
    audioModel: typeof data.audioModel === 'string' && /^[\w./-]{0,128}$/.test(data.audioModel) ? data.audioModel : '',
    ttsEngine: data.ttsEngine === 'provider' || data.ttsEngine === 'system' ? data.ttsEngine : 'auto',
    continuous: data.continuous === true,
    earcons: data.earcons !== false,
    provider: parseJarvisVoiceConfig(data.provider),
    version: 2
  };
}

type ProviderCapability = { checked: boolean; primary: boolean; fallback: boolean; ffmpeg: boolean; stt: string[]; tts: string[]; error: string | null };
type Playable = { kind: 'audio'; url: string } | { kind: 'system'; text: string } | { kind: 'stream'; player: JarvisProgressiveAudio };

export interface JarvisChatActions {
  createCliProxyChat(): Promise<string | null>;
  selectChat(id: string): Promise<void> | void;
  openSettings?(): void;
  openChat?(): void;
}
type JarvisSelection = { id: string; conversationId: string | null; engine?: string; title?: string; model?: string };
export function initJarvis(api: AppApi, selected: () => JarvisSelection | null, actions?: JarvisChatActions): void {
  const find = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const maybe = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
  const button = find<HTMLButtonElement>('jarvisTalk');
  const status = find<HTMLElement>('jarvisSettingsStatus');
  const targetLabel = maybe<HTMLElement>('jarvisActiveChat');
  const readiness = maybe<HTMLElement>('jarvisReadiness');
  const modelLabel = maybe<HTMLElement>('jarvisModelInfo');
  const goToChat = maybe<HTMLButtonElement>('jarvisGoToChat');
  const setupChat = maybe<HTMLButtonElement>('jarvisSetupChat');
  const enable = find<HTMLInputElement>('jarvisEnabled');
  const consent = find<HTMLInputElement>('jarvisConsent');
  const key = find<HTMLSelectElement>('jarvisKey');
  const language = find<HTMLInputElement>('jarvisLanguage');
  const tts = find<HTMLInputElement>('jarvisTts');
  const voice = find<HTMLSelectElement>('jarvisVoice');
  const engine = maybe<HTMLSelectElement>('jarvisEngine');
  const audioModel = maybe<HTMLSelectElement>('jarvisAudioModel');
  const ttsEngine = maybe<HTMLSelectElement>('jarvisTtsEngine');
  const continuous = maybe<HTMLInputElement>('jarvisContinuous');
  const earcons = maybe<HTMLInputElement>('jarvisEarcons');
  const preset = maybe<HTMLSelectElement>('jarvisProviderPreset');
  const providerUrl = maybe<HTMLInputElement>('jarvisProviderUrl');
  const sttMode = maybe<HTMLSelectElement>('jarvisSttMode');
  const sttModel = maybe<HTMLInputElement>('jarvisSttModel');
  const ttsModel = maybe<HTMLInputElement>('jarvisTtsModel');
  const providerVoice = maybe<HTMLInputElement>('jarvisProviderVoice');
  const providerStatus = maybe<HTMLElement>('jarvisProviderStatus');
  const stateLabel = maybe<HTMLElement>('jarvisStatus');
  const createChat = maybe<HTMLButtonElement>('jarvisCreateCliProxyChat');
  const returnChat = maybe<HTMLButtonElement>('jarvisReturnChat');
  let creating = false;
  let previousChat: string | null = null;
  let preferences = defaults;
  try { preferences = parseJarvisPreferences(JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { /* default */ }
  enable.checked = preferences.enabled;
  key.value = preferences.key;
  language.value = preferences.language;
  tts.checked = preferences.tts;
  if (engine) engine.value = preferences.engine;
  if (ttsEngine) ttsEngine.value = preferences.ttsEngine;
  if (continuous) continuous.checked = preferences.continuous;
  if (earcons) earcons.checked = preferences.earcons;
  const showProvider = (): void => {
    const config = preferences.provider;
    if (providerUrl) providerUrl.value = config.baseUrl;
    if (sttMode) {
      sttMode.value = config.sttMode;
      // Google's transcription endpoint is not OpenAI's /audio/transcriptions
      // or /chat/completions. Both choices would otherwise imply a fake switch.
      sttMode.disabled = config.baseUrl === 'https://generativelanguage.googleapis.com/v1beta';
    }
    if (sttModel) sttModel.value = config.sttModel;
    if (ttsModel) ttsModel.value = config.ttsModel;
    if (providerVoice) providerVoice.value = config.voice;
    if (preset) preset.value = Object.entries(JARVIS_VOICE_PRESETS).find(([, value]) => value.baseUrl === config.baseUrl)?.[0] ?? '';
  };
  showProvider();
  let consented = false;
  let attempt = 0;
  let owner: string | null = null;
  let running = false;
  let stopping = false;
  let committed = '';
  let finished = false;
  let held = false;
  let handsFree = false;
  let stopWatching: () => void = () => undefined;
  let phase: JarvisPhase = 'idle';
  let speechVoice = preferences.voice;
  let answer: { sessionId: string; turnId: string; splitter: JarvisSentenceSplitter; spoken: number } | null = null;
  // The recorded question -> response relation also covers ordinary typed messages.
  // Each selection/voice opt-in gets a new baseline so historical answers stay silent.
  let typedWatch: {
    sessionId: string; conversationId: string; ready: boolean; questions: Set<string>;
    pending: Set<string>; spoken: Set<string>;
  } | null = null;
  let typedEpoch = 0;
  const resetTypedWatch = (): void => { typedWatch = null; typedEpoch++; };
  const typedSelection = () => {
    const chat = selected();
    return preferences.enabled && preferences.tts && consented && chat?.conversationId && eligible() === chat.id
      ? { sessionId: chat.id, conversationId: chat.conversationId } : null;
  };
  const activeTypedWatch = () => {
    const target = typedSelection();
    if (!target) return null;
    if (!typedWatch || typedWatch.sessionId !== target.sessionId || typedWatch.conversationId !== target.conversationId) {
      resetTypedWatch();
      typedWatch = { ...target, ready: false, questions: new Set(), pending: new Set(), spoken: new Set() };
    }
    return typedWatch;
  };
  // A native outbox acceptance is NOT a ChatGPT turn. Only the browser's recorded
  // user_message with this exact inputId can bind the resulting assistant turn.
  let nativePending: { sessionId: string; inputId: string; generation: number } | null = null;
  let nativeDeadline: ReturnType<typeof setTimeout> | null = null;
  let answerDone = false;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  const recognitionAvailable = api.dictationSupported && typeof api.startDictation === 'function';
  const recorderAvailable = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  const systemSpeech = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window;
  let capability: { models: string[]; local: boolean; windows: boolean; error: string | null } = { models: [], local: false, windows: recognitionAvailable, error: null };
  let provider: ProviderCapability = { checked: false, primary: false, fallback: false, ffmpeg: false, stt: [], tts: [], error: null };
  let media: { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; bytes: number; id: number; mode: Engine } | null = null;
  const modes = (): Engine[] => preferences.engine === 'auto' ? ORDER : [preferences.engine, ...ORDER.filter(candidate => candidate !== preferences.engine)];
  const providerReachable = (): boolean => provider.primary || provider.fallback || (provider.checked && !provider.error);
  const usable = (mode: Engine): boolean => mode === 'windows' ? recognitionAvailable
    : recorderAvailable && (mode === 'provider' ? jarvisVoiceSttReady(preferences.provider) && providerReachable()
      : mode === 'local' ? capability.local : capability.models.length > 0);
  const mode = (): Engine | null => modes().find(usable) ?? null;
  const providerSpeaks = (): boolean => jarvisVoiceTtsReady(preferences.provider) && typeof api.jarvisSpeak === 'function' &&
    (preferences.ttsEngine === 'provider' || (preferences.ttsEngine === 'auto' && providerReachable()));
  const speaks = (): boolean => preferences.tts && (providerSpeaks() || systemSpeech());
  const liveStreams = new Set<JarvisProgressiveAudio>();

  const setPhase = (next: JarvisPhase): void => { phase = next; paint(); };
  const cue = (kind: 'listen' | 'done' | 'error'): void => { if (preferences.earcons) playEarcon(kind); };

  const speech = new JarvisSpeechQueue<Playable>({
    synthesize: async (text, signal) => {
      if (providerSpeaks()) {
        try {
          // Start the HTTP request before the next sentence finishes: the player can begin
          // as soon as its first decodable frames arrive, without waiting for the whole MP3.
          if (api.jarvisSpeakStream && api.onJarvisSpeechStream) {
            const requestId = crypto.randomUUID();
            const player = new JarvisProgressiveAudio(requestId, api.onJarvisSpeechStream);
            liveStreams.add(player);
            if (signal.aborted) { player.cancel(); liveStreams.delete(player); return { kind: 'system', text: '' }; }
            void api.jarvisSpeakStream(preferences.provider, text, requestId).then(reply => {
              if (!reply.ok) player.fail(new Error(reply.error));
            }).catch(error => player.fail(error));
            return { kind: 'stream', player };
          }
          const reply = await api.jarvisSpeak(preferences.provider, text);
          if (reply.ok) {
            if (signal.aborted) return { kind: 'system', text: '' };
            return { kind: 'audio', url: URL.createObjectURL(new Blob([new Uint8Array(reply.data.bytes)], { type: reply.data.mime })) };
          }
          if (!systemSpeech()) throw new Error(reply.error);
          status.textContent = `${t('Provider speech failed; using the system voice.')} ${reply.error}`;
        } catch (error) { if (!systemSpeech()) throw error; }
      }
      return { kind: 'system', text };
    },
    play: (item, signal) => new Promise<void>((resolve, reject) => {
      if (item.kind === 'stream') {
        void item.player.play(signal, ms => { status.textContent = `${t('First audio')} ${ms} ms`; })
          .then(resolve, reject).finally(() => { item.player.cancel(); liveStreams.delete(item.player); });
        return;
      }
      if (signal.aborted) { if (item.kind === 'audio') URL.revokeObjectURL(item.url); resolve(); return; }
      if (item.kind === 'system') {
        if (!item.text || !systemSpeech()) { resolve(); return; }
        const utterance = new SpeechSynthesisUtterance(item.text);
        if (preferences.language) utterance.lang = preferences.language;
        const chosen = speechSynthesis.getVoices().find(candidate => candidate.voiceURI === preferences.voice);
        if (chosen) utterance.voice = chosen;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        signal.addEventListener('abort', () => { speechSynthesis.cancel(); resolve(); }, { once: true });
        speechSynthesis.speak(utterance);
        return;
      }
      const audio = new Audio(item.url);
      const done = (error?: unknown): void => { audio.onended = audio.onerror = null; URL.revokeObjectURL(item.url); if (error) reject(error); else resolve(); };
      audio.onended = () => done();
      audio.onerror = () => done(new Error('Audio playback failed'));
      signal.addEventListener('abort', () => { audio.pause(); done(); }, { once: true });
      audio.play().catch(error => done(error));
    })
  }, {
    speaking: active => { if (active) setPhase('speaking'); else if (phase === 'speaking') setPhase(answer ? 'thinking' : 'idle'); },
    drained: () => { if (answerDone) turnComplete(); },
    error: () => { status.textContent = t('Jarvis could not speak part of the answer.'); }
  });
  /** Barge-in or cancel: stop the voice now, wherever it comes from. */
  const silence = (): void => {
    speech.stop();
    for (const stream of liveStreams) stream.cancel();
    liveStreams.clear();
    void api.jarvisSpeakCancel?.().catch(() => undefined);
    if (systemSpeech()) speechSynthesis.cancel();
  };
  const clearNativeDeadline = (): void => {
    if (nativeDeadline) { clearTimeout(nativeDeadline); nativeDeadline = null; }
  };

  const fillList = (id: string, values: readonly string[]): void => {
    const list = maybe<HTMLDataListElement>(id);
    if (!list) return;
    list.replaceChildren(...values.slice(0, 300).map(value => { const option = document.createElement('option'); option.value = value; return option; }));
  };
  fillList('jarvisProviderVoices', JARVIS_VOICE_SUGGESTIONS);
  function paintProvider(): void {
    // A saved-key indicator is a placeholder, NEVER the password field value.
    // Presence comes only from the main-process provider status, not the schema.
    const keyState = (id: string, saved: boolean, savedText: string, absentText: string): void => {
      const field = maybe<HTMLInputElement>(id);
      if (!field) return;
      field.placeholder = provider.checked && saved ? '••••••••' : '';
      field.setAttribute('aria-label', !provider.checked
        ? t('Checking the voice provider…') : provider.error && !provider.primary && !provider.fallback
          ? t('Voice provider is unavailable.') : saved ? t(savedText) : t(absentText));
      field.setAttribute('aria-describedby', 'jarvisProviderStatus');
    };
    keyState('jarvisProviderKey', provider.primary, 'Primary key saved.', 'No primary key saved.');
    keyState('jarvisProviderFallbackKey', provider.fallback, 'Fallback key saved.', 'No fallback key saved.');
    if (!providerStatus) return;
    const config = preferences.provider;
    if (!config.baseUrl) { providerStatus.textContent = t('No voice provider configured.'); return; }
    // An unreadable provider must not be announced as two absent credentials.
    if (provider.error && !provider.primary && !provider.fallback) { providerStatus.textContent = provider.error; return; }
    const parts = [
      provider.primary ? t('Primary key saved.') : t('No primary key saved.'),
      provider.fallback ? t('Fallback key saved.') : t('No fallback key saved.')
    ];
    if (provider.checked && !provider.error) parts.push(t('Model list read.'));
    if (provider.checked && !provider.error && provider.stt.length && config.sttModel && !provider.stt.includes(config.sttModel)) {
      parts.push(t("The speech-to-text model is not in the provider's model list."));
    }
    if (config.sttMode === 'chat-audio' && provider.checked && !provider.ffmpeg) parts.push(t('Chat-model transcription needs ffmpeg installed.'));
    if (provider.error) parts.push(provider.error);
    providerStatus.textContent = parts.join(' ');
  }
  const refreshProvider = (): void => {
    if (!api.jarvisVoiceStatus) return;
    const config = preferences.provider;
    if (!config.baseUrl) { provider = { ...provider, checked: false, primary: false, fallback: false, error: null }; paintProvider(); paint(); return; }
    if (providerStatus) providerStatus.textContent = t('Checking the voice provider…');
    void api.jarvisVoiceStatus(config).then(reply => {
      if (JSON.stringify(preferences.provider) !== JSON.stringify(config)) return;
      if (!reply.ok) { provider = { ...provider, checked: true, primary: false, fallback: false, error: reply.error }; paintProvider(); paint(); return; }
      const data = reply.data;
      provider = {
        checked: true, primary: data?.primary === true, fallback: data?.fallback === true, ffmpeg: data?.ffmpeg === true,
        stt: Array.isArray(data?.stt) ? data.stt : [], tts: Array.isArray(data?.tts) ? data.tts : [],
        error: typeof data?.error === 'string' ? data.error : null
      };
      fillList('jarvisSttModels', provider.stt);
      fillList('jarvisTtsModels', provider.tts);
      paintProvider();
      paint();
    }).catch(() => { provider = { ...provider, checked: true, primary: false, fallback: false, error: t('Voice provider is unavailable.') }; paintProvider(); paint(); });
  };
  const refresh = (): void => {
    refreshProvider();
    if (!api.jarvisAudioStatus) return;
    void api.jarvisAudioStatus().then(result => {
      if (!result.ok) { capability.error = result.error; paint(); return; }
      // A reply without data (an old main process, a mocked API) keeps the last known engines.
      const data = result.data as Partial<typeof capability> | null | undefined;
      capability = {
        models: Array.isArray(data?.models) ? data.models.filter((name): name is string => typeof name === 'string') : [],
        local: data?.local === true,
        windows: data?.windows === true || recognitionAvailable,
        error: typeof data?.error === 'string' ? data.error : null
      };
      if (audioModel) {
        const selectedModel = preferences.audioModel;
        audioModel.replaceChildren(new Option(t('Detect automatically'), ''));
        for (const name of capability.models) audioModel.append(new Option(name, name));
        audioModel.value = capability.models.includes(selectedModel) ? selectedModel : '';
      }
      paint();
    }).catch(() => { capability.error = 'Transcription model catalog is unavailable.'; paint(); });
  };
  const eligible = (): string | null => {
    const chat = selected();
    if (!chat?.conversationId) return null;
    return isApiConversationId(chat.conversationId)
      ? (!chat.engine || chat.engine === 'cliproxy' ? chat.id : null)
      : (!chat.engine || chat.engine === 'chatgpt' ? chat.id : null);
  };
  const phaseText = (): string => phase === 'listening' ? t('Listening…') : phase === 'stopping' || phase === 'transcribing' ? t('Transcribing…')
    : phase === 'thinking' ? t('Thinking…') : phase === 'speaking' ? t('Speaking… press to interrupt') : '';
  function paint(): void {
    const chat = selected();
    const target = eligible();
    const native = !!target && !!chat?.conversationId && !isApiConversationId(chat.conversationId);
    const stt = mode();
    const ready = preferences.enabled && !!stt && consented && !!target && !stopping;
    // Keep the microphone discoverable in the normal ChatGPT composer, including
    // before initial opt-in. Setup is an explicit UI action and never captures audio.
    button.hidden = !native && !preferences.enabled;
    button.disabled = !ready;
    if (setupChat) {
      setupChat.hidden = !native || (ready && speaks());
      setupChat.textContent = t('Set up Jarvis');
    }
    if (targetLabel) targetLabel.textContent = !target
      ? t('No active ChatGPT conversation. Select a normal chat, then return to Jarvis settings.')
      : native ? t('Selected ChatGPT conversation: {0}', [chat?.title?.trim() || t('Current chat')])
        : t('Selected CLIProxy conversation: {0}', [chat?.title?.trim() || t('Current chat')]);
    if (goToChat) goToChat.disabled = !target;
    if (modelLabel) modelLabel.textContent = !target ? t('Select a ChatGPT conversation')
      : chat?.model ? t('Current chat model: {0}', [chat.model])
        : native ? t('ChatGPT model: use the model selected in this chat') : t('CLIProxy model: use the model selected in this chat');
    if (readiness) {
      const checks = [!preferences.enabled ? t('Enable Jarvis to start.') : !target ? t('Select a ChatGPT or CLIProxy conversation.')
        : !consented ? t('Allow microphone capture and audio transmission for this session.')
          : stt ? t('Speech-to-text (STT) is ready.') : t('Speech-to-text (STT) is not configured or available.')];
      checks.push(!preferences.tts ? t('Spoken replies (TTS) are off. Enable Speak replies to hear ChatGPT.')
        : speaks() ? t('Spoken replies (TTS) are available.') : t('Spoken replies (TTS) need a working provider or system voice.'));
      readiness.textContent = checks.join(' ');
    }
    if (createChat) {
      createChat.hidden = !preferences.enabled || !!target || !actions;
      createChat.disabled = creating;
      createChat.textContent = t(creating ? 'Creating CLIProxy chat…' : 'Open optional CLIProxy chat');
    }
    if (returnChat) {
      returnChat.hidden = !preferences.enabled || !previousChat || !target || !actions;
      returnChat.textContent = t('Return to previous chat');
    }
    const reason = !preferences.enabled ? t('Set up Jarvis in Settings to speak with ChatGPT.') : !target
      ? t('Jarvis needs a ChatGPT or CLIProxy conversation. The voice provider configures audio, not chat.')
      : !consented ? t('Enable microphone and audio transmission consent in Jarvis settings for this session.')
      : !stt ? t('No transcription engine is ready. Check the voice provider URL, saved key and STT model, or choose a CLIProxy transcription model.')
      : !recorderAvailable && stt !== 'windows' ? t('This app cannot access microphone recording. Check system permissions and restart the app.')
      : '';
    const shown = running ? stopping ? 'stopping' : 'listening' : phase;
    button.dataset.state = shown;
    button.setAttribute('aria-pressed', String(running));
    button.setAttribute('aria-label', native ? t('Hold to speak to Jarvis in ChatGPT') : t('Hold to speak to Jarvis'));
    button.title = reason || (phase === 'speaking' ? t('Press to interrupt Jarvis') : t('Hold to speak to Jarvis')) + ` (${preferences.key})`;
    if (stateLabel) {
      stateLabel.dataset.state = shown;
      stateLabel.textContent = reason || phaseText();
      stateLabel.title = reason;
      stateLabel.hidden = !native && !preferences.enabled || (!reason && shown === 'idle');
    }
    if (!mode()) status.textContent = t('No transcription engine available. Configure a voice provider, a CLIProxy audio model, an installed local Whisper engine, or Windows speech recognition.') + (capability.error ? ` ${capability.error}` : '');
    else if (!consented) status.textContent = t('Enable microphone consent to use Jarvis.');
    else if (!eligible()) status.textContent = t('Select a ChatGPT or CLIProxy chat to use Jarvis.');
    else if (!running && !status.textContent) status.textContent = t('Jarvis is ready.');
  }
  setupChat?.addEventListener('click', () => { actions?.openSettings?.(); });
  goToChat?.addEventListener('click', () => { if (eligible()) actions?.openChat?.(); });
  createChat?.addEventListener('click', () => {
    if (!actions || creating || !preferences.enabled || eligible()) return;
    const origin = selected()?.id ?? null;
    creating = true; paint();
    void actions.createCliProxyChat().then(id => {
      if (!id) { status.textContent = t('Could not create a CLIProxy chat. Check CLIProxy settings.'); return; }
      if (origin && origin !== id) previousChat = origin;
      status.textContent = t('CLIProxy chat selected. Give microphone consent, then hold the Jarvis key to speak.');
    }).catch(() => { status.textContent = t('Could not create a CLIProxy chat. Check CLIProxy settings.'); })
      .finally(() => { creating = false; paint(); });
  });
  returnChat?.addEventListener('click', () => {
    if (!actions || !previousChat || !eligible() || running) return;
    const target = previousChat;
    void Promise.resolve(actions.selectChat(target)).then(() => { previousChat = null; paint(); })
      .catch(() => { status.textContent = t('Could not return to the previous chat.'); });
  });
  function stop(): void {
    if (!running || stopping) return;
    stopping = true;
    stopWatching(); stopWatching = () => undefined;
    status.textContent = t('Finishing dictation…');
    cue('done');
    paint();
    if (media) {
      const current = media;
      if (current.recorder.state !== 'inactive') current.recorder.stop();
      current.stream.getTracks().forEach(track => track.stop());
      return;
    }
    if (mode() !== 'windows') { running = false; stopping = false; owner = null; phase = 'idle'; paint(); return; }
    void api.stopDictation().then(reply => {
      if (!reply.ok) { cancel(); status.textContent = t(reply.error); }
    }).catch(() => { cancel(); });
  }
  function cancel(): void {
    attempt++;
    resetTypedWatch();
    owner = null;
    committed = '';
    finished = false;
    held = false;
    handsFree = false;
    stopWatching(); stopWatching = () => undefined;
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    if (media) {
      const previous = media; media = null;
      previous.recorder.ondataavailable = null;
      previous.recorder.onstop = null;
      if (previous.recorder.state !== 'inactive') previous.recorder.stop();
      previous.stream.getTracks().forEach(track => track.stop());
      previous.chunks.length = 0;
    }
    void api.jarvisCancel?.().catch(() => undefined);
    if (running) void api.stopDictation().catch(() => undefined);
    running = false;
    stopping = false;
    answer = null;
    nativePending = null;
    clearNativeDeadline();
    answerDone = false;
    silence();
    phase = 'idle';
    paint();
  }
  /** Recorded audio goes to the first usable recorder engine; a failure tries the next one. */
  async function transcribe(id: number, first: Engine, mime: 'audio/webm' | 'audio/ogg' | 'audio/mp4', bytes: Uint8Array): Promise<{ ok: true; data: string } | { ok: false; error: string } | null> {
    const chain = [first, ...modes().filter(candidate => candidate !== first && candidate !== 'windows' && usable(candidate))];
    let last: { ok: false; error: string } = { ok: false, error: t('Transcription failed.') };
    for (const candidate of chain) {
      if (id !== attempt) return null;
      const model = preferences.audioModel && capability.models.includes(preferences.audioModel) ? preferences.audioModel : capability.models[0] ?? '';
      const reply = candidate === 'provider'
        ? await api.jarvisTranscribe('provider', '', preferences.language, mime, bytes, preferences.provider)
        : await api.jarvisTranscribe(candidate === 'local' ? 'local' : 'cliproxy', model, preferences.language, mime, bytes);
      if (reply.ok && reply.data.trim()) return reply;
      last = reply.ok ? { ok: false, error: t('No speech was recognized.') } : reply;
    }
    return last;
  }
  function start(options: { handsFree?: boolean } = {}): void {
    if (phase === 'speaking' || phase === 'thinking' || answer || nativePending) {
      // Barge-in: the person talks over Jarvis, so its voice stops at once.
      answer = null; nativePending = null; clearNativeDeadline(); answerDone = false; silence();
      if (phase === 'speaking' || phase === 'thinking') phase = 'idle';
    }
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    if (running && handsFree && !options.handsFree) {
      // A press during hands-free listening turns it into an ordinary hold.
      handsFree = false; stopWatching(); stopWatching = () => undefined; return;
    }
    if (running || !preferences.enabled || !consented || !mode()) { paint(); return; }
    const target = eligible();
    if (!target) { paint(); return; }
    // A new microphone turn supersedes any unfinished typed-reply watch.
    resetTypedWatch();
    const id = ++attempt;
    owner = target;
    running = true;
    stopping = false;
    handsFree = options.handsFree === true;
    committed = '';
    finished = false;
    status.textContent = t('Preparing microphone…');
    phase = 'listening';
    paint();
    const chosen = mode()!;
    if (chosen !== 'windows') {
      void navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(stream => {
        if (id !== attempt || (!held && !handsFree) || !running) { stream.getTracks().forEach(track => track.stop()); return; }
        const mime = ['audio/webm', 'audio/ogg', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
        if (!mime) { stream.getTracks().forEach(track => track.stop()); cancel(); status.textContent = t('MediaRecorder audio format is unavailable.'); return; }
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        const row = { recorder, stream, chunks: [] as Blob[], bytes: 0, id, mode: chosen };
        media = row;
        recorder.ondataavailable = event => {
          if (media !== row || !event.data.size) return;
          row.bytes += event.data.size;
          if (row.bytes > 12_000_000) { cancel(); status.textContent = t('Recording exceeds the 12 MB limit.'); return; }
          row.chunks.push(event.data);
        };
        recorder.onstop = () => {
          stream.getTracks().forEach(track => track.stop());
          if (media !== row) return;
          media = null;
          if (!stopping || id !== attempt || !consented || owner !== eligible()) { cancel(); return; }
          if (!row.bytes) { cancel(); status.textContent = t('No speech was sent.'); return; }
          const blob = new Blob(row.chunks, { type: mime });
          row.chunks.length = 0;
          status.textContent = t('Transcribing recorded audio…');
          phase = 'transcribing';
          paint();
          void blob.arrayBuffer().then(buffer => {
            if (id !== attempt || !stopping || !consented || owner !== eligible()) return null;
            return transcribe(id, chosen, mime as 'audio/webm' | 'audio/ogg' | 'audio/mp4', new Uint8Array(buffer));
          }).then(reply => {
            if (!reply || id !== attempt || !stopping) return;
            if (!reply.ok) { cancel(); cue('error'); status.textContent = reply.error; return; }
            committed = reply.data.trim();
            eventReceived({ type: 'status', status: 'stopped' });
          }).catch(() => { if (id === attempt) { cancel(); status.textContent = t('Transcription failed.'); } });
        };
        try { recorder.start(250); } catch { cancel(); status.textContent = t('MediaRecorder audio format is unavailable.'); return; }
        if (handsFree) {
          stopWatching = watchSilence(stream, verdict => {
            if (id !== attempt || !handsFree) return;
            if (verdict === 'end') stop();
            else { cancel(); status.textContent = t('Continuous conversation paused. Hold the key to speak again.'); }
          });
        }
        cue('listen');
        status.textContent = handsFree ? t('Listening… stop talking to send.') : t('Listening…');
      }).catch(() => { if (id === attempt) { cancel(); status.textContent = t('Dictation could not start. Check microphone access and try again.'); } });
      return;
    }
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
      handsFree = false;
      owner = null;
      phase = shouldSend ? 'thinking' : 'idle';
      paint();
      if (!shouldSend) { status.textContent = t('No speech was sent.'); return; }
      status.textContent = t('Sending Jarvis message…');
      // Either transport can outlive the next PTT press or loss of microphone consent.
      // A late receipt belongs to the capture that submitted it, never to the new voice turn.
      const submittedAttempt = attempt;
      const currentSend = (): boolean => submittedAttempt === attempt && eligible() === target &&
        preferences.enabled && consented && phase === 'thinking';
      const chat = selected();
      if (chat?.conversationId && !isApiConversationId(chat.conversationId)) {
        const inputId = crypto.randomUUID();
        void api.sendInput({ id: inputId, sessionId: target, text, mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null }).then(reply => {
          if (!currentSend()) return;
          if (!reply.ok || reply.data.id !== inputId || reply.data.sessionId !== target ||
              reply.data.state === 'failed' || reply.data.state === 'cancelled') {
            status.textContent = t('Jarvis message could not be sent.'); setPhase('idle'); return;
          }
          nativePending = { sessionId: target!, inputId, generation: submittedAttempt };
          status.textContent = t('Waiting for ChatGPT to confirm the Jarvis message…');
          nativeDeadline = setTimeout(() => {
            if (nativePending?.inputId !== inputId) return;
            nativePending = null;
            nativeDeadline = null;
            status.textContent = t('ChatGPT did not confirm the Jarvis message. Check this chat in the timeline.');
            if (phase === 'thinking') setPhase('idle');
          }, 120_000);
          void readAnswer();
        }).catch(() => { if (currentSend()) { status.textContent = t('Jarvis message could not be sent.'); setPhase('idle'); } });
      } else {
        void api.apiChatSend(target!, text).then(reply => {
          if (!currentSend()) return;
          if (reply.ok) {
            answer = { sessionId: target!, turnId: reply.data.turnId, splitter: new JarvisSentenceSplitter(), spoken: 0 };
            answerDone = false;
            status.textContent = t('Jarvis message sent to this CLIProxy chat.');
            void readAnswer();
          } else { status.textContent = t(reply.error); setPhase('idle'); }
        }).catch(() => { if (currentSend()) { status.textContent = t('Jarvis message could not be sent.'); setPhase('idle'); } });
      }
    } else if (event.type === 'status' && event.status === 'listening') status.textContent = t('Listening…');
  }
  api.onDictationEvent(eventReceived);

  /** After a spoken answer, continuous conversation listens again; otherwise Jarvis waits. */
  function turnComplete(): void {
    answerDone = false;
    if (phase === 'thinking' || phase === 'speaking') setPhase('idle');
    if (!preferences.continuous || !preferences.enabled || !consented || running || !eligible() || !recorderAvailable) return;
    const usableRecorder = mode();
    if (!usableRecorder || usableRecorder === 'windows') return;
    // A short pause keeps the end of Jarvis's own voice out of the next recording.
    resumeTimer = setTimeout(() => { resumeTimer = null; if (!running && !answer && phase === 'idle') start({ handsFree: true }); }, 450);
  }
  let reading = false;
  let readAgain = false;
  /** Only a newly observed, user-authored question with one *completed* linked response may speak. */
  function readTypedFinal(
    watch: NonNullable<typeof typedWatch>, events: SessionEvent[], turns: TimelineTurns | undefined
  ): void {
    const questions = events.filter((event): event is Extract<SessionEvent, { kind: 'user_message' }> =>
      event.kind === 'user_message' && !!event.messageId && event.inputDelivery !== 'offered');
    if (!watch.ready) {
      for (const event of questions) watch.questions.add(event.messageId!);
      watch.ready = true;
      return;
    }
    let newQuestion = false;
    for (const event of questions) {
      const id = event.messageId!;
      if (watch.questions.has(id)) continue;
      watch.questions.add(id);
      if (!event.automatic && (!event.inputId || event.inputId !== nativePending?.inputId)) {
        // A newer authored question supersedes any older pending reply, even if
        // the old server turn finishes after this message was already submitted.
        watch.pending.clear();
        watch.pending.add(id);
        newQuestion = true;
      }
    }
    // A new typed question interrupts the last response rather than mixing both audios.
    if (newQuestion && !answer && !nativePending && !running && (speech.speaking || speech.queued)) silence();
    if (!turns || answer || nativePending || running || stopping) return;
    for (const questionId of watch.pending) {
      const linked = [...new Set(Object.entries(turns)
        .filter(([, turn]) => turn.questionId === questionId)
        .map(([id]) => responseTurnId(turns, id)))];
      if (linked.length !== 1) continue;
      const turnId = linked[0]!;
      const key = `${questionId}:${turnId}`;
      if (watch.spoken.has(key)) { watch.pending.delete(questionId); continue; }
      const completed = events.some(event => event.kind === 'turn_end' && event.outcome === 'completed' &&
        !!event.turnId && responseTurnId(turns, event.turnId) === turnId);
      if (!completed) continue;
      const messages = new Map<string, Extract<SessionEvent, { kind: 'assistant_message' }>>();
      for (const event of events) {
        if (event.kind === 'assistant_message' && event.final && event.turnId &&
            responseTurnId(turns, event.turnId) === turnId) messages.set(event.messageId ?? String(event.seq), event);
      }
      const text = [...messages.values()].map(event => event.message.text).join('\n\n');
      if (!text.trim()) continue;
      watch.spoken.add(key);
      watch.pending.delete(questionId);
      if (speaks()) {
        const sentences = new JarvisSentenceSplitter().finish(text);
        let spoken = 0;
        const bounded = sentences.filter(sentence => { spoken += sentence.length; return spoken <= MAX_SPOKEN; });
        if (bounded.length) {
          if (speech.speaking || speech.queued) silence();
          speech.enqueue(bounded);
        }
      }
    }
    // Session reads are bounded, so keep only identities that can still be observed.
    while (watch.questions.size > 160) watch.questions.delete(watch.questions.values().next().value!);
    while (watch.spoken.size > 160) watch.spoken.delete(watch.spoken.values().next().value!);
  }
  /** Streamed answer text becomes speech sentence by sentence while the chat is still writing. */
  async function readAnswer(): Promise<void> {
    if (reading) { readAgain = true; return; }
    reading = true;
    try {
      do {
        readAgain = false;
        let current = answer;
        const pending = nativePending;
        const typed = activeTypedWatch();
        const epoch = typedEpoch;
        if (!current && !pending && !typed) return;
        if (!api.getSession) return;
        const sessionId = (current ?? pending ?? typed)!.sessionId;
        const reply = await api.getSession(sessionId, { limit: 80 });
        if (!reply.ok || answer !== current || nativePending !== pending) continue;
        if (typed && (typed !== typedWatch || epoch !== typedEpoch)) continue;
        if (selected()?.id !== sessionId || !consented || !preferences.enabled) { cancel(); return; }
        if (typed && typedSelection()?.conversationId === typed.conversationId) {
          readTypedFinal(typed, reply.data.events, reply.data.summary?.timelineTurns);
        }
        if (pending) {
          if (pending.generation !== attempt || phase !== 'thinking') { nativePending = null; return; }
          const submitted = reply.data.events.filter((event): event is Extract<SessionEvent, { kind: 'user_message' }> =>
            event.kind === 'user_message').find(event => event.inputId === pending.inputId &&
            event.inputDelivery === 'confirmed' && (!!event.messageId || !!event.turnId));
          if (!submitted) continue;
          // ChatGPT's native user-message turnId is not the response turnId. The recorder's
          // exact questionId -> response-turn relation is the only valid bridge between them.
          // The relation may arrive after the confirmed input: wait for the next session change.
          const turns = reply.data.summary?.timelineTurns;
          const linked = turns && submitted.messageId
            ? [...new Set(Object.entries(turns)
              .filter(([, turn]) => turn.questionId === submitted.messageId)
              .map(([id]) => responseTurnId(turns, id)))] : [];
          // No recorded relation or two independent responses: leave the input pending.
          const responseTurn = linked.length === 1 ? linked[0] : null;
          if (!responseTurn) continue;
          nativePending = null;
          clearNativeDeadline();
          current = { sessionId: pending.sessionId, turnId: responseTurn, splitter: new JarvisSentenceSplitter(), spoken: 0 };
          answer = current;
          status.textContent = t('Jarvis message delivered to ChatGPT.');
        }
        if (!current) continue;
        const messages = new Map<string, Extract<SessionEvent, { kind: 'assistant_message' }>>();
        let ended = false;
        for (const event of reply.data.events) {
          if (event.turnId !== current.turnId) continue;
          if (event.kind === 'assistant_message') messages.set(event.messageId ?? String(event.seq), event);
          else if (event.kind === 'turn_end') ended = true;
        }
        const text = [...messages.values()].map(event => event.message.text).join('\n\n');
        if (speaks()) {
          const sentences = (ended ? current.splitter.finish(text) : current.splitter.push(text)).filter(sentence => {
            current.spoken += sentence.length;
            return current.spoken <= MAX_SPOKEN;
          });
          speech.enqueue(sentences);
        }
        if (ended) {
          answer = null;
          answerDone = true;
          if (!speech.speaking && !speech.queued) turnComplete();
        }
      } while (readAgain);
    } catch { /* the next session change retries */ }
    finally { reading = false; }
  }
  api.onSessionChanged(change => {
    const expected = answer ?? nativePending;
    const watch = typedSelection();
    if (!expected && !watch) return;
    if (change?.sessionIds && !change.sessionIds.includes((expected ?? watch)!.sessionId)) return;
    void readAnswer();
  });

  const readProvider = (): JarvisVoiceConfig => parseJarvisVoiceConfig({
    baseUrl: providerUrl?.value ?? preferences.provider.baseUrl, sttMode: sttMode?.value ?? preferences.provider.sttMode,
    sttModel: sttModel?.value ?? preferences.provider.sttModel, ttsModel: ttsModel?.value ?? preferences.provider.ttsModel,
    voice: providerVoice?.value ?? preferences.provider.voice
  });
  function persist(): void {
    if (running || stopping || nativePending || answer || phase === 'thinking' || speech.speaking) cancel();
    resetTypedWatch();
    const before = JSON.stringify(preferences.provider);
    preferences = parseJarvisPreferences({
      enabled: enable.checked, key: key.value, language: language.value, tts: tts.checked, voice: voice.value, engine: engine?.value ?? preferences.engine,
      audioModel: audioModel?.value ?? preferences.audioModel, ttsEngine: ttsEngine?.value ?? preferences.ttsEngine,
      continuous: continuous?.checked ?? preferences.continuous, earcons: earcons?.checked ?? preferences.earcons, provider: readProvider(), version: 2
    });
    try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* preferences stay for this session */ }
    if (!preferences.enabled) { cancel(); consented = false; consent.checked = false; }
    if (JSON.stringify(preferences.provider) !== before) { showProvider(); refreshProvider(); }
    else if (preferences.enabled) refresh();
    paintProvider();
    paint();
    void readAnswer();
  }
  for (const element of [enable, key, language, tts, voice, engine, audioModel, ttsEngine, continuous, earcons, providerUrl, sttMode, sttModel, ttsModel, providerVoice]) element?.addEventListener('change', persist);
  preset?.addEventListener('change', () => {
    const chosen = JARVIS_VOICE_PRESETS[preset.value as keyof typeof JARVIS_VOICE_PRESETS];
    if (!chosen) return;
    if (providerUrl) providerUrl.value = chosen.baseUrl;
    if (sttMode) sttMode.value = chosen.sttMode;
    if (sttModel) sttModel.value = chosen.sttModel;
    if (ttsModel) ttsModel.value = chosen.ttsModel;
    if (providerVoice) providerVoice.value = chosen.voice;
    persist();
  });
  maybe<HTMLButtonElement>('jarvisSaveKeys')?.addEventListener('click', () => {
    const primary = maybe<HTMLInputElement>('jarvisProviderKey');
    const fallback = maybe<HTMLInputElement>('jarvisProviderFallbackKey');
    const password = maybe<HTMLInputElement>('jarvisVaultPassword');
    const say = (text: string): void => { if (providerStatus) providerStatus.textContent = text; };
    const baseUrl = preferences.provider.baseUrl;
    if (!baseUrl) { say(t('Enter the provider URL first.')); return; }
    if (!password?.value) { say(t('Enter the vault master password first.')); password?.focus(); return; }
    const writes = ([['primary', primary], ['fallback', fallback]] as const).filter(([, field]) => field?.value.trim());
    if (!writes.length) { say(t('Enter a key to save.')); return; }
    void (async () => {
      for (const [slot, field] of writes) {
        const reply = await api.jarvisVoiceSetKey(slot, baseUrl, field!.value, password.value);
        if (!reply.ok) { say(reply.error); return; }
        field!.value = '';
      }
      password.value = '';
      say(t('Keys saved in the vault.'));
      refreshProvider();
    })().catch(() => say(t('The keys could not be saved.')));
  });
  maybe<HTMLButtonElement>('jarvisTestProviderVoice')?.addEventListener('click', () => {
    const button = maybe<HTMLButtonElement>('jarvisTestProviderVoice');
    if (!button || !api.jarvisSpeak) return;
    persist();
    if (!jarvisVoiceTtsReady(preferences.provider)) { if (providerStatus) providerStatus.textContent = 'Configure a voice and TTS model first.'; return; }
    const config = { ...preferences.provider };
    button.disabled = true;
    if (providerStatus) providerStatus.textContent = 'Generating a PT-BR audio sample…';
    void api.jarvisSpeak(config, 'Olá! Aqui é o Jarvis do Chat Marks. Estou testando minha voz natural em português brasileiro.')
      .then(async reply => {
        if (!reply.ok) throw new Error(reply.error);
        const audio = new Audio(URL.createObjectURL(new Blob([new Uint8Array(reply.data.bytes)], { type: reply.data.mime })));
        try { await audio.play(); await new Promise<void>((resolve, reject) => { audio.onended = () => resolve(); audio.onerror = () => reject(new Error('Audio playback failed.')); });
          if (providerStatus) providerStatus.textContent = 'Voice test completed.';
        } finally { URL.revokeObjectURL(audio.src); }
      }).catch(error => { if (providerStatus) providerStatus.textContent = error instanceof Error ? error.message.slice(0, 240) : 'Voice test failed.'; })
      .finally(() => { button.disabled = false; });
  });
  consent.addEventListener('change', () => {
    consented = consent.checked;
    if (!consented) cancel();
    resetTypedWatch();
    paint();
    if (consented) void readAnswer();
  });
  const fillVoices = (): void => {
    if (!systemSpeech()) return;
    const voices = speechSynthesis.getVoices();
    voice.replaceChildren(new Option(t('System default'), ''));
    for (const candidate of voices) voice.appendChild(new Option(`${candidate.name} (${candidate.lang})`, candidate.voiceURI));
    voice.value = speechVoice;
  };
  fillVoices();
  if (systemSpeech()) speechSynthesis.addEventListener('voiceschanged', fillVoices);
  voice.addEventListener('change', () => { speechVoice = voice.value; });
  maybe<HTMLButtonElement>('jarvisRefreshAudio')?.addEventListener('click', refresh);
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
  window.addEventListener('jarvis:selection', () => {
    if (running || stopping || nativePending || answer || phase === 'thinking' || speech.speaking) cancel();
    resetTypedWatch();
    paint();
    void readAnswer();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('beforeunload', cancel, { once: true });
  onLanguageChange(paint);
  // Consent and capture must never survive a page reload.
  refresh();
  paintProvider();
  paint();
}
