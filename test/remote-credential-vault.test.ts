import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureVaultForTests, createVault, listVault, useVault } from '../src/main/marks-vault.js';
import { remoteHostsFileForTests, saveRemoteHostWithPassword, listRemoteHosts } from '../src/main/remote/hosts.js';

let folder: string;
let storedKey: string | null;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'marks-ssh-vault-'));
  storedKey = null;
  configureVaultForTests(path.join(folder, 'vault.json'), {
    getKey: async () => storedKey,
    setKey: async key => { storedKey = key; }
  });
  remoteHostsFileForTests(path.join(folder, 'hosts.json'));
});
afterEach(async () => {
  configureVaultForTests(path.join(folder, 'unused.json'), null);
  await rm(folder, { recursive: true, force: true });
});

it('saves SSH password only in encrypted Cofre K under the stable profile identity', async () => {
  await createVault('temporary-test-password');
  const profile = await saveRemoteHostWithPassword({ name: 'marks1', type: 'ssh', host: 'one.example', port: 22, user: 'worker' }, 'temporary-ssh-pass');
  expect(await listRemoteHosts()).toMatchObject([{ id: profile.id, name: 'marks1' }]);
  const text = await readFile(path.join(folder, 'hosts.json'), 'utf8');
  const encrypted = await readFile(path.join(folder, 'vault.json'), 'utf8');
  expect(text).not.toContain('temporary-ssh-pass');
  expect(encrypted).not.toContain('temporary-ssh-pass');
  expect((await listVault()).map(item => item.name)).toEqual([`ssh/${profile.id}/password`]);
  expect(await useVault(`ssh/${profile.id}/password`, async item => item.value)).toBe('temporary-ssh-pass');
  await saveRemoteHostWithPassword({ ...profile, name: 'Renamed host' }, 'new-password');
  expect((await listVault()).map(item => item.name)).toEqual([`ssh/${profile.id}/password`]);
});

it('refuses to store a password when the Cofre is not initialized, without saving a profile', async () => {
  await expect(saveRemoteHostWithPassword({ name: 'host', type: 'ssh', host: 'one.example', port: 22, user: 'worker' }, 'password'))
    .rejects.toThrow('Cofre');
  expect(await listRemoteHosts()).toEqual([]);
});
