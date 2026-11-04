import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const local = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => local.userData, getLocale: () => 'pt-BR' } }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn() }));

import { DEFAULT_PIPER_VOICE_SETTINGS, PIPER_PT_BR_VOICES, parsePiperVoiceSettings } from '../src/shared/jarvis-piper-voices.js';
import { installPiperVoice, listPiperVoices, readPiperVoiceSettings, savePiperVoiceSettings, speakJarvisLocal } from '../src/main/jarvis-local.js';

beforeEach(async () => {
  local.userData = await mkdtemp(path.join(os.tmpdir(), 'marks-piper-voices-'));
});
afterEach(async () => {
  await rm(local.userData, { recursive: true, force: true });
});

it('keeps Faber as the migrated default and validates voice and bounded speech controls', () => {
  expect(parsePiperVoiceSettings(null)).toEqual(DEFAULT_PIPER_VOICE_SETTINGS);
  expect(parsePiperVoiceSettings({ voice: '../../bad', lengthScale: -1, noiseW: 99, sentenceSilence: NaN }))
    .toEqual(DEFAULT_PIPER_VOICE_SETTINGS);
  expect(parsePiperVoiceSettings({ voice: 'jeff', lengthScale: 0.85, noiseW: 0.95, sentenceSilence: 0.4 }))
    .toEqual({ voice: 'jeff', lengthScale: 0.85, noiseW: 0.95, sentenceSilence: 0.4 });
  expect(PIPER_PT_BR_VOICES.map(item => item.id)).toEqual(['faber', 'cadu', 'jeff', 'edresson']);
  expect(PIPER_PT_BR_VOICES.every(item => item.modelSha256.length === 64 && item.configSha256.length === 64)).toBe(true);
});

it('does not download voices just by listing and refuses to choose an uninstalled voice', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
    expect(await readPiperVoiceSettings()).toEqual(DEFAULT_PIPER_VOICE_SETTINGS);
    const catalog = await listPiperVoices();
    expect(catalog.settings.voice).toBe('faber');
    expect(catalog.voices.find(item => item.id === 'jeff')).toMatchObject({ installed: false });
    await expect(savePiperVoiceSettings({ voice: 'jeff', lengthScale: 1, noiseW: 0.8, sentenceSilence: 0.2 }))
      .rejects.toThrow(/install|voice/i);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('persists validated controls and refuses a Piper voice when its engine is missing', async () => {
  const current = path.join(local.userData, 'modules', 'jarvis-local', 'current');
  await mkdir(current, { recursive: true });
  await writeFile(path.join(current, 'pt_BR-faber-medium.onnx'), 'fixture');
  await writeFile(path.join(current, 'pt_BR-faber-medium.onnx.json'), '{}');
  const bin = path.join(current, 'piper', 'piper');
  await mkdir(path.dirname(bin), { recursive: true });
  await writeFile(bin, '#!/bin/sh\nexit 0\n');
  await chmod(bin, 0o700);
  const next = { voice: 'faber' as const, lengthScale: 1.2, noiseW: 0.4, sentenceSilence: 0.45 };
  expect(await savePiperVoiceSettings(next)).toEqual(next);
  expect(await readPiperVoiceSettings()).toEqual(next);
  await rm(bin);
  await expect(speakJarvisLocal('Teste', new AbortController().signal)).rejects.toThrow(/Piper|Install/i);
});

it('passes only bounded voice speed, variation and pauses to the local Piper executable', async () => {
  const current = path.join(local.userData, 'modules', 'jarvis-local', 'current');
  const bin = path.join(current, 'piper', 'piper');
  await mkdir(path.dirname(bin), { recursive: true });
  await writeFile(path.join(current, 'pt_BR-faber-medium.onnx'), 'fixture');
  await writeFile(path.join(current, 'pt_BR-faber-medium.onnx.json'), '{}');
  const argsFile = path.join(local.userData, 'piper-args');
  await writeFile(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "' + argsFile + '"\nwhile [ "$1" != "--output_file" ]; do shift; done\nshift\nprintf "RIFFtestWAVE" > "$1"\n');
  await chmod(bin, 0o700);
  await savePiperVoiceSettings({ voice: 'faber', lengthScale: 0.85, noiseW: 0.6, sentenceSilence: 0.4 });
  const result = await speakJarvisLocal('Teste do Jarvis', new AbortController().signal);
  expect(result.mime).toBe('audio/wav');
  const { readFile } = await import('node:fs/promises');
  const argv = (await readFile(argsFile, 'utf8')).trim().split('\n');
  expect(argv).toContain('--length_scale');
  expect(argv).toContain('0.85');
  expect(argv).toContain('--noise_w');
  expect(argv).toContain('0.6');
  expect(argv).toContain('--sentence_silence');
  expect(argv).toContain('0.4');
});

it('requires opt-in and refuses an unverified optional voice without altering preferences', async () => {
  const current = path.join(local.userData, 'modules', 'jarvis-local', 'current');
  const bin = path.join(current, 'piper', 'piper');
  await mkdir(path.dirname(bin), { recursive: true });
  await writeFile(bin, '#!/bin/sh\nexit 0\n');
  await chmod(bin, 0o700);
  const mockFetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal('fetch', mockFetch);
  try {
    await expect(installPiperVoice('cadu', new AbortController().signal)).rejects.toThrow(/checksum/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((await listPiperVoices()).voices.find(item => item.id === 'cadu')?.installed).toBe(false);
    expect(await readPiperVoiceSettings()).toEqual(DEFAULT_PIPER_VOICE_SETTINGS);
  } finally { vi.unstubAllGlobals(); }
});
