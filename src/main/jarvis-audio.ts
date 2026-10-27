/** Explicit, bounded Jarvis transcription. Audio is held in renderer memory until one IPC call. */
import { app, ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allApiModels } from './api-chat/catalog.js';
import { apiChatKey, apiChatSettings } from './api-chat/settings.js';
import { resolveApiChatBaseUrl } from './api-chat/client.js';
import { isJarvisAudioModelId } from '../shared/jarvis-ptt.js';
import { markspanelAccessBlocked } from './markspanel-auth.js';
import { jarvisVoiceConfigSchema, jarvisVoiceRoutingSchema } from '../shared/jarvis-voice.js';
import { jarvisVoiceStatus, jarvisVoiceRouteStatus, speakJarvisVoice, storeJarvisVoiceKey, streamJarvisVoice, transcribeJarvisVoice } from './jarvis-voice.js';

const audio = z.object({ action: z.literal('transcribe'), engine: z.enum(['cliproxy', 'local', 'provider']), model: z.string().max(128),
  language: z.string().max(35), mime: z.enum(['audio/webm', 'audio/ogg', 'audio/mp4']), bytes: z.instanceof(Uint8Array).refine(b => b.length > 0 && b.length <= 12_000_000),
  voice: jarvisVoiceConfigSchema.optional() }).strict();
const status = z.object({ action: z.literal('status') }).strict();
const voiceStatus = z.object({ action: z.literal('voice-status'), voice: jarvisVoiceConfigSchema }).strict();
const voiceKey = z.object({ action: z.literal('voice-key'), slot: z.enum(['primary', 'fallback', 'fallback2', 'fallback3', 'g4f1', 'g4f2']), baseUrl: z.string().min(1).max(300),
  value: z.string().trim().min(1).max(16384), password: z.string().min(1).max(1024) }).strict();
const speak = z.object({ action: z.literal('speak'), voice: jarvisVoiceConfigSchema, text: z.string().min(1).max(4000), routing: jarvisVoiceRoutingSchema.optional(), groupId: z.string().uuid().optional() }).strict();
const speakStream = z.object({ action: z.literal('speak-stream'), voice: jarvisVoiceConfigSchema, text: z.string().min(1).max(4000), requestId: z.string().uuid(), routing: jarvisVoiceRoutingSchema.optional(), groupId: z.string().uuid().optional() }).strict();
const MAX_RESPONSE = 64_000;

/** Only recognize an already provisioned whisper.cpp executable and model. */
async function localEngine(): Promise<{ executable: string; model: string } | null> {
  const executable = process.env.MARKS_JARVIS_WHISPER_CLI;
  const model = process.env.MARKS_JARVIS_WHISPER_MODEL;
  if (!executable?.startsWith('/') || !model?.startsWith('/')) return null;
  try { await access(executable, constants.X_OK); await access(model, constants.R_OK); return { executable, model }; }
  catch { return null; }
}

export async function jarvisAudioStatus(): Promise<{ models: string[]; local: boolean; windows: boolean; error: string | null }> {
  let models: string[] = [];
  let error: string | null = null;
  try { models = (await allApiModels()).filter(m => isJarvisAudioModelId(m.id) && !/(^|[-_/])tts([-_.]|$)/i.test(m.id)).map(m => m.id); }
  catch (reason) { error = reason instanceof Error ? reason.message.slice(0, 200) : 'Model catalog unavailable'; }
  return { models, local: !!(await localEngine()), windows: process.platform === 'win32', error };
}

export async function transcribeJarvis(input: z.infer<typeof audio>, signal: AbortSignal): Promise<string> {
  if (input.engine === 'provider') {
    if (!input.voice) throw new Error('Configure the Jarvis voice provider first.');
    return transcribeJarvisVoice(input.voice, input.mime, input.bytes, input.language, signal);
  }
  if (input.engine === 'local') {
    const local = await localEngine();
    if (!local) throw new Error('Configure MARKS_JARVIS_WHISPER_CLI and MARKS_JARVIS_WHISPER_MODEL with installed absolute paths.');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'marks-jarvis-'));
    const wav = path.join(dir, 'audio.wav');
    const output = path.join(dir, 'speech');
    const command = async (binary: string, args: string[], stdin?: Uint8Array): Promise<void> => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Transcription canceled')); return; }
      const child = spawn(binary, args, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'], signal });
      let error = '';
      child.stderr?.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-1000); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Local transcription exited ${code}: ${error.slice(-300)}`)));
      child.stdin?.on('error', reject);
      if (stdin) child.stdin?.end(stdin);
    });
    try {
      await command('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], input.bytes);
      await command(local.executable, ['-m', local.model, '-f', wav, '-otxt', '-of', output, ...(input.language ? ['-l', input.language.split('-')[0]!] : [])]);
      return (await readFile(`${output}.txt`, 'utf8')).trim().slice(0, 32_000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const models = await allApiModels();
  if (!models.some(model => model.id === input.model && isJarvisAudioModelId(model.id))) throw new Error('Choose a transcription model listed by CLIProxy.');
  const { endpoint } = await apiChatSettings();
  const key = await apiChatKey();
  const form = new FormData();
  form.append('model', input.model);
  form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.mime }), input.mime === 'audio/mp4' ? 'jarvis.m4a' : input.mime === 'audio/ogg' ? 'jarvis.ogg' : 'jarvis.webm');
  if (input.language) form.append('language', input.language);
  const response = await fetch(`${resolveApiChatBaseUrl(endpoint)}/audio/transcriptions`, {
    method: 'POST', headers: key ? { authorization: `Bearer ${key}` } : {}, body: form, signal, redirect: 'error'
  });
  if (!response.ok) throw new Error(`CLIProxy transcription returned HTTP ${response.status}.`);
  let body = '';
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) throw new Error('Transcription response is too large.');
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  } else {
    body = await response.text();
    if (body.length > MAX_RESPONSE) throw new Error('Transcription response is too large.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error('CLIProxy returned an invalid transcription response.'); }
  const text = (parsed as { text?: unknown })?.text;
  if (typeof text !== 'string') throw new Error('CLIProxy returned no transcription text.');
  return text.trim().slice(0, 32_000);
}

export function registerJarvisAudioIpc(getWindow: () => BrowserWindow | null): void {
  let active: AbortController | null = null;
  const speaking = new Set<AbortController>();
  app.on('before-quit', () => { active?.abort(); for (const controller of speaking) controller.abort(); });
  ipcMain.handle('jarvis:audio', async (event, payload: unknown) => {
    try {
      const target = getWindow();
      if (!target || target.isDestroyed() || target.webContents !== event.sender || event.senderFrame !== target.webContents.mainFrame) throw new Error('Window not authorized');
      if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
      if (status.safeParse(payload).success) return { ok: true, data: await jarvisAudioStatus() };
      const action = payload && typeof payload === 'object' ? (payload as { action?: unknown }).action : undefined;
      if (action === 'cancel') { active?.abort(); active = null; return { ok: true, data: null }; }
      if (action === 'speak-cancel') { for (const controller of speaking) controller.abort(); speaking.clear(); return { ok: true, data: null }; }
      if (action === 'voice-status') return { ok: true, data: await jarvisVoiceStatus(voiceStatus.parse(payload).voice) };
      if (action === 'voice-route-status') {
        const routing = jarvisVoiceRoutingSchema.parse((payload as { routing: unknown }).routing);
        return { ok: true, data: await jarvisVoiceRouteStatus(routing) };
      }
      if (action === 'voice-key') {
        const input = voiceKey.parse(payload);
        await storeJarvisVoiceKey(input.slot, input.baseUrl, input.value, input.password);
        return { ok: true, data: true };
      }
      if (action === 'speak' || action === 'speak-stream') {
        const input = action === 'speak' ? speak.parse(payload) : speakStream.parse(payload);
        // The renderer prefetches the next sentence while one plays; more than that is a bug.
        if (speaking.size >= 3) throw new Error('Jarvis speech is already busy.');
        const controller = new AbortController();
        speaking.add(controller);
        const timer = setTimeout(() => controller.abort(), 60_000);
        try {
          if (action === 'speak-stream' && 'requestId' in input) {
            try {
              const data = await streamJarvisVoice(input.voice, input.text, input.requestId, controller.signal, chunk => {
                if (target.isDestroyed() || target.webContents.isDestroyed() || event.senderFrame !== target.webContents.mainFrame) {
                  controller.abort();
                  return;
                }
                event.sender.send('jarvis:speech-stream', chunk);
              }, input.routing, input.groupId);
              return { ok: true, data };
            } catch (reason) {
              const error = controller.signal.aborted ? 'Speech interrupted.' : reason instanceof Error ? reason.message.slice(0, 240) : 'Speech failed.';
              if (!target.isDestroyed() && !target.webContents.isDestroyed() && !controller.signal.aborted) {
                event.sender.send('jarvis:speech-stream', { requestId: input.requestId, type: 'error', error });
              }
              return { ok: false, error };
            }
          }
          return { ok: true, data: await speakJarvisVoice(input.voice, input.text, controller.signal, input.routing, input.groupId) };
        }
        finally { clearTimeout(timer); speaking.delete(controller); }
      }
      const input = audio.parse(payload);
      if (active) throw new Error('Jarvis transcription is already running.');
      const controller = new AbortController(); active = controller;
      const timeout = setTimeout(() => controller.abort(), 45_000);
      try { return { ok: true, data: await transcribeJarvis(input, controller.signal) }; }
      finally { clearTimeout(timeout); if (active === controller) active = null; }
    } catch (reason) { return { ok: false, error: reason instanceof Error ? reason.message : 'Transcription unavailable' }; }
  });
}
