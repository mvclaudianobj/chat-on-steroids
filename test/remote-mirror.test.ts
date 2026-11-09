import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { initConfigPath, saveConfig, defaultConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { saveRemoteHost, remoteHostsFileForTests } from '../src/main/remote/hosts.js';
import { addRemoteProfileProject } from '../src/main/projects.js';
import { syncRemoteProfileProject } from '../src/main/remote/mirror.js';
import { SftpClient } from '../src/main/remote/sftp.js';
import { closeRemoteSessions } from '../src/main/remote/ssh.js';

const SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/sftp-server'].find(existsSync);
const real = describe.skipIf(!SERVER);
let directory: string, local: string, remote: string;
let projectId: string;
const processes: ChildProcessWithoutNullStreams[] = [];
const clients: SftpClient[] = [];
const connect = async (): Promise<SftpClient> => {
  const proc = spawn(SERVER!, [], { cwd: remote, stdio: ['pipe', 'pipe', 'pipe'] });
  processes.push(proc);
  const client = await SftpClient.start(proc.stdout, proc.stdin);
  clients.push(client);
  return client;
};

beforeEach(async () => {
  // macOS exposes /var as a link to /private/var. Approved roots are canonical
  // identities, so store the same real path that resolvePath will later compare.
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marks-mirror-')));
  local = path.join(directory, 'local'); remote = path.join(directory, 'remote');
  await fs.mkdir(local); await fs.mkdir(remote);
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  remoteHostsFileForTests(path.join(directory, 'hosts.json'));
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'mirror', path: local }] });
  const host = await saveRemoteHost({ name: 'Mirror Server', type: 'ssh', host: 'example.test', user: 'test', port: 22 });
  projectId = (await addRemoteProfileProject(local, host.id, remote)).id;
});
afterEach(async () => {
  closeRemoteSessions();
  for (const client of clients.splice(0)) client.close();
  for (const proc of processes.splice(0)) proc.kill();
  resetSessionStoreForTests(); resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

real('explicit local SFTP mirror', () => {
  it('pulls and pushes only on explicit request without deleting destination extras', async () => {
    await fs.mkdir(path.join(remote, 'src'));
    await fs.writeFile(path.join(remote, 'src', 'main.ts'), 'export const remote = true;');
    await fs.writeFile(path.join(local, 'keep.txt'), 'local data');
    expect(await fs.readdir(local)).toEqual(['keep.txt']);
    const pulled = await syncRemoteProfileProject(projectId, 'pull', { connect });
    expect(pulled.files).toBe(1);
    expect(await fs.readFile(path.join(local, 'src', 'main.ts'), 'utf8')).toContain('remote = true');
    expect(await fs.readFile(path.join(local, 'keep.txt'), 'utf8')).toBe('local data');
    await fs.writeFile(path.join(local, 'src', 'main.ts'), 'export const local = true;');
    const pushed = await syncRemoteProfileProject(projectId, 'push', { connect });
    expect(pushed.files).toBe(2);
    expect(await fs.readFile(path.join(remote, 'src', 'main.ts'), 'utf8')).toContain('local = true');
  });

  it('excludes common secret paths and symbolic links in both directions', async () => {
    await fs.writeFile(path.join(remote, '.env'), 'TEST_SECRET=remote');
    await fs.writeFile(path.join(remote, 'safe.txt'), 'safe');
    await fs.symlink(path.join(remote, '.env'), path.join(remote, 'sneaky.txt'));
    await syncRemoteProfileProject(projectId, 'pull', { connect });
    expect(await fs.readdir(local)).toEqual(['safe.txt']);
    await fs.writeFile(path.join(local, '.npmrc'), 'TEST_SECRET=local');
    await fs.symlink(path.join(local, '.npmrc'), path.join(local, 'linked.txt'));
    await syncRemoteProfileProject(projectId, 'push', { connect });
    expect(await fs.readdir(remote)).toEqual(['.env', 'safe.txt', 'sneaky.txt']);
  });

  it('rejects symlinks at the destination instead of overwriting their targets', async () => {
    await fs.writeFile(path.join(remote, 'sensitive.txt'), 'external');
    await fs.writeFile(path.join(remote, 'data.txt'), 'remote');
    await fs.symlink(path.join(remote, 'sensitive.txt'), path.join(local, 'data.txt'));
    await expect(syncRemoteProfileProject(projectId, 'pull', { connect })).rejects.toThrow(/Unsafe local mirror|Path escapes its approved folder/);
    expect(await fs.readFile(path.join(remote, 'sensitive.txt'), 'utf8')).toBe('external');
  });
});
