import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn() }));
import { jarvisLocalStatus, speakJarvisLocal, transcribeJarvisLocal } from '../src/main/jarvis-local.js';

let directory = '';
let previousPath = '';
const binary = async (file: string, contents: string): Promise<void> => {
  await writeFile(file, `#!/bin/sh\n${contents}\n`, { mode: 0o700 });
  await chmod(file, 0o700);
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'marks-local-test-'));
  state.userData = directory;
  previousPath = process.env.PATH ?? '';
  const bin = path.join(directory, 'test-bin');
  await mkdir(bin);
  await binary(path.join(bin, 'ffmpeg'), 'if [ "$1" = "-version" ]; then exit 0; fi\nwhile [ "$#" -gt 1 ]; do shift; done\nprintf "RIFF" > "$1"');
  process.env.PATH = `${bin}:${previousPath}`;
});
afterEach(async () => {
  process.env.PATH = previousPath;
  await rm(directory, { recursive: true, force: true });
});

describe('Jarvis managed offline voice', () => {
  it('reports missing engines without downloading any file', async () => {
    const result = await jarvisLocalStatus();
    expect(result.stt).toBe(false);
    expect(result.tts).toBe(false);
    expect(result.ffmpeg).toBe(true);
  });

  it('runs fake ffmpeg, whisper.cpp and Piper with local model files and no network', async () => {
    const root = path.join(directory, 'modules', 'jarvis-local', 'current');
    await mkdir(path.join(root, 'whisper-bin-ubuntu-x64'), { recursive: true });
    await mkdir(path.join(root, 'piper'), { recursive: true });
    await writeFile(path.join(root, 'selection.json'), '"base"');
    await writeFile(path.join(root, 'ggml-base.bin'), 'synthetic');
    await writeFile(path.join(root, 'pt_BR-faber-medium.onnx'), 'synthetic');
    await writeFile(path.join(root, 'pt_BR-faber-medium.onnx.json'), '{}');
    await binary(path.join(root, 'whisper-bin-ubuntu-x64', 'whisper-cli'), 'while [ "$#" -gt 1 ]; do if [ "$1" = "-of" ]; then shift; printf "fala local" > "$1.txt"; exit 0; fi; shift; done\nexit 2');
    await binary(path.join(root, 'piper', 'piper'), 'while [ "$#" -gt 1 ]; do if [ "$1" = "--output_file" ]; then shift; printf "RIFFsynthetic" > "$1"; exit 0; fi; shift; done\nexit 2');
    expect(await jarvisLocalStatus()).toMatchObject({ stt: true, tts: true, installed: true, model: 'base' });
    expect(await transcribeJarvisLocal(new Uint8Array([1, 2]), 'pt-BR', new AbortController().signal)).toBe('fala local');
    expect(await speakJarvisLocal('Olá', new AbortController().signal)).toMatchObject({ mime: 'audio/wav' });
  });
});
