/** Managed, opt-in offline Jarvis speech. Official archives and models are pinned by SHA-256. */
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logInfo } from './logger.js';
import {
  PIPER_PT_BR_VOICES, DEFAULT_PIPER_VOICE_SETTINGS, parsePiperVoiceSettings,
  type PiperVoiceId, type PiperVoiceSettings, type PiperVoiceView
} from '../shared/jarvis-piper-voices.js';

export type LocalWhisperModel = 'base' | 'small';
export interface JarvisLocalStatus {
  supported: boolean; installed: boolean; stt: boolean; tts: boolean; ffmpeg: boolean;
  model: LocalWhisperModel | null; version: string; detail: string;
}

const WHISPER_VERSION = 'b5454'; // upstream whisper.cpp 1.9.5, Ubuntu x64 build
const PIPER_VERSION = '2023.11.14-2';
const VOICE_VERSION = 'v1.0.0';
const RELEASE = 'https://github.com/';
const VOICES = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/pt/pt_BR/faber/medium/';
type Asset = { url: string; sha256: string; max: number };
const ASSETS: Record<string, Asset> = {
  whisper: { url: `${RELEASE}ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c', max: 20_000_000 },
  piper: { url: `${RELEASE}rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz`,
    sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992', max: 40_000_000 },
  base: { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', max: 180_000_000 },
  small: { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', max: 550_000_000 },
  voice: { url: `${VOICES}pt_BR-faber-medium.onnx`,
    sha256: '858555e3a064209c57088fe6bd70c4c3dc54d03eaa00c45d5ecaf43a33f95aa7', max: 80_000_000 },
  voiceConfig: { url: `${VOICES}pt_BR-faber-medium.onnx.json`,
    sha256: '7e694de195ae3fc36dd732c445eb04fb49b649854893cb5506b978f0d50a1d6f', max: 20_000 }
};

const root = () => path.join(app.getPath('userData'), 'modules', 'jarvis-local');
const bundle = () => path.join(root(), 'current');
const whisperPath = () => path.join(bundle(), 'whisper-bin-ubuntu-x64', 'whisper-cli');
const piperPath = () => path.join(bundle(), 'piper', 'piper');
const modelPath = (model: LocalWhisperModel) => path.join(bundle(), `ggml-${model}.bin`);
const voicePath = () => path.join(bundle(), 'pt_BR-faber-medium.onnx');
const voiceRoot = () => path.join(root(), 'voices');
const voiceFile = (id: PiperVoiceId): string => {
  if (id === 'faber') return voicePath();
  const info = PIPER_PT_BR_VOICES.find(item => item.id === id)!;
  return path.join(voiceRoot(), id, 'pt_BR-' + id + '-' + info.quality + '.onnx');
};
const voiceSettingsFile = () => path.join(root(), 'piper-voice.json');
const exists = async (file: string, mode = constants.R_OK): Promise<boolean> => {
  try { await access(file, mode); return true; } catch { return false; }
};
const supported = () => process.platform === 'linux' && process.arch === 'x64';
let installing = false;
const now = () => performance.now();

/** A missing or corrupt preference file never switches the voice or requests network access. */
export async function readPiperVoiceSettings(): Promise<PiperVoiceSettings> {
  try {
    const raw = await readFile(voiceSettingsFile(), 'utf8');
    if (raw.length > 4096) return { ...DEFAULT_PIPER_VOICE_SETTINGS };
    return parsePiperVoiceSettings(JSON.parse(raw) as unknown);
  } catch { return { ...DEFAULT_PIPER_VOICE_SETTINGS }; }
}

async function voiceInstalled(id: PiperVoiceId): Promise<boolean> {
  const file = voiceFile(id);
  return await exists(file) && await exists(file + '.json');
}

export async function listPiperVoices(): Promise<PiperVoiceView> {
  return {
    settings: await readPiperVoiceSettings(),
    voices: await Promise.all(PIPER_PT_BR_VOICES.map(async entry => ({
      id: entry.id, label: entry.label, quality: entry.quality,
      datasetLicense: entry.datasetLicense, installed: await voiceInstalled(entry.id)
    })))
  };
}

/** Voice choice and prosody are kept per OS user. A missing voice can never be selected. */
export async function savePiperVoiceSettings(input: unknown): Promise<PiperVoiceSettings> {
  const settings = parsePiperVoiceSettings(input);
  if (settings.voice !== 'faber' && !await voiceInstalled(settings.voice)) {
    throw new Error('Install this verified Piper voice before selecting it.');
  }
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const temporary = path.join(root(), '.piper-voice-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
    await rename(temporary, voiceSettingsFile());
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  return settings;
}

/** Only a UI opt-in calls this; downloads are SHA-256 pinned and published atomically. */
export async function installPiperVoice(id: PiperVoiceId, signal: AbortSignal): Promise<PiperVoiceView> {
  const info = PIPER_PT_BR_VOICES.find(item => item.id === id);
  if (!info) throw new Error('Unknown Piper voice.');
  if (!supported()) throw new Error('Offline Piper voices currently require Linux x64.');
  if (id === 'faber') throw new Error('Faber is installed with the local speech engine.');
  if (installing) throw new Error('Another local voice installation is in progress.');
  if (!await exists(piperPath(), constants.X_OK)) throw new Error('Install local Piper before adding another voice.');
  if (await voiceInstalled(id)) {
    logInfo('jarvis local: action=local-voice-install result=skipped reason=already-installed');
    return listPiperVoices();
  }
  installing = true;
  let stage: string | null = null;
  try {
    await mkdir(voiceRoot(), { recursive: true, mode: 0o700 });
    stage = await mkdtemp(path.join(voiceRoot(), '.stage-'));
    const prefix = 'pt_BR-' + id + '-' + info.quality + '.onnx';
    const url = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/pt/pt_BR/' + id + '/' + info.quality + '/';
    await download({ url: url + prefix, sha256: info.modelSha256, max: 80_000_000 }, path.join(stage, prefix), signal);
    await download({ url: url + prefix + '.json', sha256: info.configSha256, max: 20_000 }, path.join(stage, prefix + '.json'), signal);
    await rename(stage, path.join(voiceRoot(), id));
    stage = null;
    return listPiperVoices();
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    installing = false;
  }
}

async function execute(binary: string, args: string[], options: {
  stdin?: Uint8Array | string; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number;
} = {}): Promise<void> {
  if (options.signal?.aborted) throw new Error('Jarvis local operation canceled.');
  await new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, options.timeout ?? 60_000);
    let settled = false;
    const done = (reason?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (reason) reject(reason); else resolve();
    };
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, signal: controller.signal,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-600); });
    child.on('error', error => done(error));
    child.on('close', code => done(code === 0 ? undefined : new Error(
      controller.signal.aborted ? 'Jarvis local operation canceled or timed out.' : `Local engine exited ${code}: ${stderr.slice(-240)}`)));
    if (options.stdin !== undefined) {
      child.stdin?.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') done(error); });
      child.stdin?.end(options.stdin);
    }
  });
}

async function ffmpegReady(): Promise<boolean> {
  try { await execute('ffmpeg', ['-version'], { timeout: 3000 }); return true; } catch { return false; }
}

async function selectedModel(): Promise<LocalWhisperModel | null> {
  try {
    const value = (await readFile(path.join(bundle(), 'selection.json'), 'utf8')).trim();
    const parsed: unknown = JSON.parse(value);
    return parsed === 'base' || parsed === 'small' ? parsed : null;
  } catch { return null; }
}

export async function jarvisLocalStatus(): Promise<JarvisLocalStatus> {
  const ffmpeg = await ffmpegReady();
  const model = await selectedModel();
  const stt = !!model && await exists(whisperPath(), constants.X_OK) && await exists(modelPath(model));
  const selection = await readPiperVoiceSettings();
  const tts = await exists(piperPath(), constants.X_OK) && await voiceInstalled(selection.voice);
  return { supported: supported(), installed: stt && tts, stt, tts, ffmpeg, model,
    version: `whisper.cpp ${WHISPER_VERSION} / Piper ${PIPER_VERSION} / voices ${VOICE_VERSION}`,
    detail: !supported() ? 'Managed local voice is verified on Linux x64; Windows is experimental and unavailable here.'
      : !ffmpeg ? 'Install ffmpeg using your system package manager (for example: sudo apt install ffmpeg), then refresh.'
        : stt && tts ? 'Local speech is ready. All inference stays on this computer.'
          : 'Select a Whisper model and install Local speech in Jarvis settings (one-time download).' };
}

/** Stream to a private file, checking length and SHA-256 before extraction or promotion. */
async function download(asset: Asset, destination: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(asset.url, { signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Local model download returned HTTP ${response.status}.`);
  const file = await open(destination, 'wx', 0o600);
  const digest = createHash('sha256');
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > asset.max) throw new Error('Local model download exceeded the size limit.');
      digest.update(value);
      await file.writeFile(value);
    }
  } finally { await reader.cancel().catch(() => undefined); await file.close(); }
  if (digest.digest('hex') !== asset.sha256) throw new Error('Local model checksum mismatch; installation was canceled.');
}

async function extractArchive(archive: string, destination: string, expectedTop: string, signal: AbortSignal): Promise<void> {
  // Archives are SHA-256 verified first. Reject paths outside their fixed directory before extraction.
  const list = await new Promise<string>((resolve, reject) => {
    const child = spawn('tar', ['-tzf', archive], { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 200_000) child.kill(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error('Could not inspect local engine archive.')));
  });
  if (!list || list.split(/\r?\n/).filter(Boolean).some(entry =>
    !entry.startsWith(`${expectedTop}/`) || entry.split('/').includes('..') || entry.includes('\\'))) {
    throw new Error('Local engine archive contains an invalid path.');
  }
  await execute('tar', ['-xzf', archive, '-C', destination], { signal, timeout: 60_000 });
}

/** Installs in userData only. The previous working bundle is restored if promotion fails. */
export async function installJarvisLocal(model: LocalWhisperModel, signal: AbortSignal): Promise<JarvisLocalStatus> {
  if (!supported()) throw new Error('Managed local speech currently supports Linux x64; Windows is experimental.');
  if (installing) throw new Error('Local speech installation is already running.');
  if (!await ffmpegReady()) throw new Error('ffmpeg is missing. Install it using your system package manager, then try again.');
  installing = true;
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(path.join(root(), '.stage-'));
  const previous = path.join(root(), `.previous-${randomUUID()}`);
  let moved = false;
  try {
    for (const [key, destination] of [
      ['whisper', 'whisper.tar.gz'], ['piper', 'piper.tar.gz'],
      [model, `ggml-${model}.bin`], ['voice', 'pt_BR-faber-medium.onnx'],
      ['voiceConfig', 'pt_BR-faber-medium.onnx.json']
    ] as const) await download(ASSETS[key]!, path.join(stage, destination), signal);
    await extractArchive(path.join(stage, 'whisper.tar.gz'), stage, 'whisper-bin-ubuntu-x64', signal);
    await extractArchive(path.join(stage, 'piper.tar.gz'), stage, 'piper', signal);
    await rm(path.join(stage, 'whisper.tar.gz'));
    await rm(path.join(stage, 'piper.tar.gz'));
    if (!await exists(path.join(stage, 'whisper-bin-ubuntu-x64', 'whisper-cli'), constants.X_OK) ||
        !await exists(path.join(stage, 'piper', 'piper'), constants.X_OK)) throw new Error('Official archive lacks its speech executable.');
    await writeFile(path.join(stage, 'selection.json'), JSON.stringify(model), { mode: 0o600 });
    if (await exists(bundle())) { await rename(bundle(), previous); moved = true; }
    try { await rename(stage, bundle()); }
    catch (reason) { if (moved) await rename(previous, bundle()); throw reason; }
    if (moved) await rm(previous, { recursive: true, force: true });
    return jarvisLocalStatus();
  } finally { installing = false; await rm(stage, { recursive: true, force: true }); }
}

const piperEnvironment = () => {
  const dir = path.dirname(piperPath());
  return { ...process.env, LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'), ESPEAK_DATA_PATH: path.join(dir, 'espeak-ng-data') };
};

export async function transcribeJarvisLocal(bytes: Uint8Array, language: string, signal: AbortSignal): Promise<string> {
  const status = await jarvisLocalStatus();
  if (!status.stt || !status.model) throw new Error('Install the local Whisper model in Jarvis settings.');
  if (!status.ffmpeg) throw new Error('ffmpeg is required. Install ffmpeg using the system package manager.');
  const started = now();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marks-jarvis-local-'));
  try {
    const wav = path.join(dir, 'audio.wav');
    const target = path.join(dir, 'transcript');
    await execute('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', wav],
      { stdin: bytes, signal, timeout: 20_000 });
    await execute(whisperPath(), ['-m', modelPath(status.model), '-f', wav, '-otxt', '-of', target, '-l', language.startsWith('pt') ? 'pt' : language.split('-')[0] || 'auto'],
      { signal, cwd: path.dirname(whisperPath()), timeout: 60_000 });
    const transcript = (await readFile(`${target}.txt`, 'utf8')).trim().slice(0, 32_000);
    logInfo(`jarvis local STT: ${Math.round(now() - started)}ms`);
    return transcript;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function speakJarvisLocal(text: string, signal: AbortSignal, preview?: PiperVoiceSettings): Promise<{ mime: string; bytes: Uint8Array }> {
  if (!text.trim() || text.length > 4000) throw new Error('Invalid local speech text.');
  const settings = preview ? parsePiperVoiceSettings(preview) : await readPiperVoiceSettings();
  if (!await exists(piperPath(), constants.X_OK) || !await voiceInstalled(settings.voice)) {
    throw new Error('Install the local Piper voice in Jarvis settings.');
  }
  const started = now();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'marks-jarvis-local-'));
  try {
    const wav = path.join(dir, 'voice.wav');
    await execute(piperPath(), [
      '--model', voiceFile(settings.voice), '--output_file', wav,
      '--length_scale', String(settings.lengthScale),
      '--noise_w', String(settings.noiseW),
      '--sentence_silence', String(settings.sentenceSilence)
    ],
      { stdin: text, signal, cwd: path.dirname(piperPath()), env: piperEnvironment(), timeout: 60_000 });
    if ((await stat(wav)).size > 20_000_000) throw new Error('Local speech output exceeded the size limit.');
    const bytes = new Uint8Array(await readFile(wav));
    logInfo(`jarvis local TTS: ${Math.round(now() - started)}ms`);
    return { mime: 'audio/wav', bytes };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
