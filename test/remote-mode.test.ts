import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSessionStore, resetSessionStoreForTests, createSession, getSession } from '../src/main/session/store.js';
import { remoteHostsFileForTests, saveRemoteHost } from '../src/main/remote/hosts.js';
import { addRemoteProfileProject, assignSessionProject, projectWorkspace } from '../src/main/projects.js';
import { remoteModeInstructions, remoteModeView, setChatRemoteMode } from '../src/main/remote/mode.js';
import { remoteApprovals, requestRemoteApproval, decideRemoteApproval, resetRemoteApprovals } from '../src/main/remote/approval.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'marks-mode-'));
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  remoteHostsFileForTests(path.join(directory, 'hosts.json'));
  await mkdir(path.join(directory, 'local'));
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'test', path: directory }] });
});
afterEach(async () => {
  resetRemoteApprovals(); resetSessionStoreForTests(); resetDurableForTests();
  await rm(directory, { recursive: true, force: true });
});

it('binds per chat, injects reference-only instructions and revokes grants on profile change or Off', async () => {
  const first = await saveRemoteHost({ name: 'Remote Lab', type: 'ssh', host: 'first.example', port: 22, user: 'worker' });
  const second = await saveRemoteHost({ name: 'Second', type: 'ssh', host: 'second.example', port: 22, user: 'worker' });
  const chat = await createSession({ conversationId: 'conversation-a' });
  await setChatRemoteMode(chat.id, first.id);
  expect((await getSession(chat.id))?.remoteMode).toEqual({ profileId: first.id });
  expect(await remoteModeView(chat.id)).toMatchObject({ name: 'Remote Lab' });
  const instruction = await remoteModeInstructions(chat.id);
  expect(instruction).toContain('remote_exec');
  expect(instruction).toContain('SFTP');
  expect(instruction).toContain('Cofre K');
  const approved = requestRemoteApproval('conversation-a', 'first.example', 'pwd');
  decideRemoteApproval(remoteApprovals()[0]!.id, 'session');
  expect(await approved).toBe(true);
  expect(await requestRemoteApproval('conversation-a', 'first.example', 'ls')).toBe(true);
  await setChatRemoteMode(chat.id, second.id);
  const pending = requestRemoteApproval('conversation-a', 'second.example', 'hostname');
  expect(remoteApprovals()).toHaveLength(1);
  await setChatRemoteMode(chat.id, null);
  expect(await pending).toBe(false);
  expect((await getSession(chat.id))?.remoteMode).toBeNull();
  expect(await remoteModeView(chat.id)).toBeNull();
  expect(await remoteModeInstructions(chat.id)).toContain('REMOTE MODE OFF');
});

it('creates a local mirror and new chats inherit the SSH profile without a grant', async () => {
  const host = await saveRemoteHost({ name: 'Lab', type: 'ssh', host: 'lab.example', port: 2222, user: 'worker' });
  const project = await addRemoteProfileProject(path.join(directory, 'local'), host.id, '/srv/work');
  expect(project.remote).toBeUndefined();
  expect(project.remoteProfile).toEqual({ profileId: host.id, folder: '/srv/work' });
  expect((await projectWorkspace(project.id)).real).toBe(path.join(directory, 'local'));
  const chat = await createSession({ conversationId: 'conversation-b' });
  await assignSessionProject(chat.id, project.id);
  expect((await getSession(chat.id))?.remoteMode).toEqual({ profileId: host.id });
  expect(await remoteModeView(chat.id)).toMatchObject({ name: 'Lab' });
  expect(remoteApprovals()).toEqual([]);
  await setChatRemoteMode(chat.id, null);
  expect(await remoteModeView(chat.id)).toBeNull();
});
