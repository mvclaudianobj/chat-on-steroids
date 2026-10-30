import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { masterKeyPresence, prepareMasterKeyPair } from '../src/main/remote/master-key.js';

let home: string, key: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'marks-master-key-test-'));
  key = path.join(home, '.ssh', 'marks-key-mestra');
  await mkdir(path.dirname(key));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it('cannot operate without explicit confirmation', async () => {
  await expect(prepareMasterKeyPair({ local: key, confirmed: false, run: async () => ({ stdout: 'absent' }) })).rejects.toThrow('approval');
});

it('detects a root-only master key and copies the same pair to the user', async () => {
  const calls: string[][] = [];
  const fake = async (_program: string, args: string[]) => {
    calls.push(args);
    return { stdout: args.includes('-c') ? 'present' : args.at(-1)?.endsWith('.pub') ? 'ssh-ed25519 AAAA synthetic' : '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----' };
  };
  expect(await masterKeyPresence({ local: key, run: fake })).toEqual({ user: false, root: true });
  expect(await prepareMasterKeyPair({ confirmed: true, local: key, run: fake })).toBe('copied-to-user');
  expect(await readFile(`${key}.pub`, 'utf8')).toContain('ssh-ed25519');
  expect((await readFile(key, 'utf8')).startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
  expect(calls.every(args => args[0] !== '/usr/bin/install')).toBe(true);
});

it('copies existing user key to root through explicit pkexec without exposing contents in arguments', async () => {
  await writeFile(key, '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----');
  await writeFile(`${key}.pub`, 'ssh-ed25519 AAAA synthetic');
  const calls: string[][] = [];
  const fake = async (_program: string, args: string[]) => { calls.push(args); return { stdout: 'absent' }; };
  expect(await prepareMasterKeyPair({ local: key, confirmed: true, run: fake })).toBe('copied-to-root');
  expect(calls.filter(args => args[0] === '/usr/bin/install')).toHaveLength(3);
  expect(JSON.stringify(calls)).not.toContain('BEGIN OPENSSH');
});

it('creates a new user key before installing the same key for root', async () => {
  const fake = async () => ({ stdout: 'absent' });
  const generated = async (file: string) => {
    await writeFile(file, '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----');
    await writeFile(`${file}.pub`, 'ssh-ed25519 AAAA synthetic');
  };
  expect(await prepareMasterKeyPair({ local: key, confirmed: true, run: fake, generate: generated })).toBe('created');
});

it('refuses mismatched keys instead of assuming that root and user share a pair', async () => {
  await writeFile(key, '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----');
  await writeFile(`${key}.pub`, 'ssh-ed25519 AAAA local');
  const fake = async (_program: string, args: string[]) => ({ stdout: args.includes('-c') ? 'present' : 'ssh-ed25519 BBBB root' });
  await expect(prepareMasterKeyPair({ local: key, confirmed: true, run: fake })).rejects.toThrow('differ');
});
