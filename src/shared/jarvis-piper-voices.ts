/** Verified Piper v1.0.0 voices. The model digest is the upstream LFS SHA-256. */
export const PIPER_PT_BR_VOICES = [
  {
    id: 'faber', label: 'Faber', quality: 'medium', datasetLicense: 'CC0',
    modelSha256: '858555e3a064209c57088fe6bd70c4c3dc54d03eaa00c45d5ecaf43a33f95aa7',
    configSha256: '7e694de195ae3fc36dd732c445eb04fb49b649854893cb5506b978f0d50a1d6f'
  },
  {
    id: 'cadu', label: 'Cadu', quality: 'medium', datasetLicense: 'CC0',
    modelSha256: '765f0809a6ea9035d4a6d0d008dbf8876e68b2dd32029312672fa8f405bdb535',
    configSha256: '5fe03aa3d4901880554905b12075713cd552598c8a350455a1ec73f8b4e6be19'
  },
  {
    id: 'jeff', label: 'Jeff', quality: 'medium', datasetLicense: 'CC0',
    modelSha256: '3a6f4c46355813c2b7bbc4d16b6d13d60ed72074b952a393baace82a7d0c94b5',
    configSha256: '7bf8145b572b36806f5ce0f1d3322b6711975bc7d0473e8d36fced4a9ec0030d'
  },
  {
    id: 'edresson', label: 'Edresson', quality: 'low', datasetLicense: 'CC BY 4.0',
    modelSha256: 'de4cecee38b30bb1a6378a337af605d59f0c377df702c6a6752870db8991cd84',
    configSha256: 'f138992d2e777d1e3aa0bbb14c2d324307b0f342c1bcf20978765b3bea506c56'
  }
] as const;

export type PiperVoiceId = typeof PIPER_PT_BR_VOICES[number]['id'];
export type PiperVoiceSettings = {
  voice: PiperVoiceId;
  /** Phoneme duration scale: less than 1 is faster. */
  lengthScale: number;
  /** Variation in phoneme durations (Piper --noise_w). */
  noiseW: number;
  /** Seconds of silence after each sentence. */
  sentenceSilence: number;
};
export const DEFAULT_PIPER_VOICE_SETTINGS: PiperVoiceSettings = {
  voice: 'faber', lengthScale: 1, noiseW: 0.8, sentenceSilence: 0.2
};

export function parsePiperVoiceSettings(input: unknown): PiperVoiceSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...DEFAULT_PIPER_VOICE_SETTINGS };
  const value = input as Record<string, unknown>;
  const numeric = (key: keyof Omit<PiperVoiceSettings, 'voice'>, low: number, high: number): number => {
    const number = value[key];
    return typeof number === 'number' && Number.isFinite(number) && number >= low && number <= high
      ? Math.round(number * 100) / 100 : DEFAULT_PIPER_VOICE_SETTINGS[key];
  };
  return {
    voice: PIPER_PT_BR_VOICES.some(item => item.id === value.voice) ? value.voice as PiperVoiceId : 'faber',
    lengthScale: numeric('lengthScale', 0.7, 1.4),
    noiseW: numeric('noiseW', 0.3, 1.4),
    sentenceSilence: numeric('sentenceSilence', 0, 0.8)
  };
}

export interface PiperVoiceView {
  settings: PiperVoiceSettings;
  voices: Array<{ id: PiperVoiceId; label: string; quality: string; datasetLicense: string; installed: boolean }>;
}
