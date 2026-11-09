import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSshHostArgs, deleteRemoteHost, importRemoteHosts, listRemoteHosts, normalizeHost, parseRemoteTargets, previewRemoteTargets, remoteHostsFileForTests, saveRemoteHost } from '../src/main/remote/hosts.js';
import { decideRemoteApproval, remoteApprovals, requestRemoteApproval, resetRemoteApprovals, revokeRemoteChat } from '../src/main/remote/approval.js';

let directory: string;
const fixture = { name: 'Lab', type: 'ssh', host: 'server.example', port: 2222, user: 'tester' };
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'marks-hosts-')); remoteHostsFileForTests(path.join(directory, 'hosts.json')); });
afterEach(async () => { resetRemoteApprovals(); await rm(directory, { recursive: true, force: true }); });

it('persists metadata without secret fields, serializes writes and rejects duplicate names', async () => {
  const first = await saveRemoteHost({ ...fixture, password: 'synthetic-password' });
  await expect(saveRemoteHost({ ...fixture, name: 'lab' })).rejects.toThrow('already exists');
  await Promise.all([saveRemoteHost({ ...fixture, name: 'Other' }), saveRemoteHost({ ...first, port: 2200 })]);
  expect(await listRemoteHosts()).toHaveLength(2);
  expect(await readFile(path.join(directory, 'hosts.json'), 'utf8')).not.toContain('synthetic-password');
  await deleteRemoteHost(first.id);
  expect((await listRemoteHosts()).map(row => row.name)).toEqual(['Other']);
});

it('previews an original file without changing its bytes or importing credentials', async () => {
  const source = path.join(directory, 'remote-targets.json');
  const text = JSON.stringify([{ ...fixture, encrypted_password: 'encoded-credential', metadata: 'private' }]);
  await writeFile(source, text);
  const preview = await previewRemoteTargets(source);
  expect(preview[0]).toMatchObject(fixture);
  expect(JSON.stringify(preview)).not.toMatch(/encoded-credential|private|encrypted_password/);
  expect(await readFile(source, 'utf8')).toBe(text);
  expect(await listRemoteHosts()).toEqual([]);
});

it('rejects malformed imports and ambiguous names before producing a preview', () => {
  for (const text of ['{}', 'null', '[null]', JSON.stringify([{ ...fixture, port: 0 }]), JSON.stringify([fixture, fixture])]) {
    expect(() => parseRemoteTargets(text)).toThrow();
  }
});

it('imports atomically when a later profile collides with an existing name', async () => {
  await saveRemoteHost(fixture);
  const preview = parseRemoteTargets(JSON.stringify([{ ...fixture, name: 'New' }, fixture]));
  await expect(importRemoteHosts(preview)).rejects.toThrow('already exists');
  expect((await listRemoteHosts()).map(row => row.name)).toEqual(['Lab']);
});

it.each(['ssh', 'winrm', 'powershell', 'whm', 'custom'] as const)('prepares %s profiles but only builds SSH invocations', type => {
  const profile = normalizeHost({ ...fixture, type });
  if (type !== 'ssh') { expect(() => buildSshHostArgs(profile, 'hostname')).toThrow('not available'); return; }
  const command = "printf '%s' 'hello; world'";
  const args = buildSshHostArgs(profile, command);
  expect(args).toContain('BatchMode=yes');
  expect(args).toContain('StrictHostKeyChecking=yes');
  expect(args.slice(-3)).toEqual(['--', 'tester@server.example', command]);
  expect(args).toContain(path.join(os.homedir(), '.ssh', 'marks-key-mestra'));
});

it('rejects option injection, invalid users and NUL commands', () => {
  for (const patch of [{ host: '-oProxyCommand=bad' }, { user: 'a b' }, { host: 'x\nother' }, { port: 65536 }]) {
    expect(() => normalizeHost({ ...fixture, ...patch })).toThrow();
  }
  expect(() => buildSshHostArgs(normalizeHost(fixture), 'echo\0bad')).toThrow();
});

it('requires an exact one-time decision and isolates then revokes chat grants', async () => {
  const first = requestRemoteApproval('chat-a', 'tester@server.example:2222', 'hostname');
  const offered = remoteApprovals()[0]!;
  expect(offered).toMatchObject({ chat: 'chat-a', host: 'tester@server.example:2222', command: 'hostname' });
  expect(decideRemoteApproval('wrong-id', 'once')).toBe(false);
  expect(decideRemoteApproval(offered.id, 'session')).toBe(true);
  expect(await first).toBe(true);
  expect(decideRemoteApproval(offered.id, 'once')).toBe(false);
  expect(await requestRemoteApproval('chat-a', offered.host, 'pwd')).toBe(true);
  const other = requestRemoteApproval('chat-b', offered.host, 'pwd');
  revokeRemoteChat('chat-b'); expect(await other).toBe(false);
  revokeRemoteChat('chat-a');
  const revoked = requestRemoteApproval('chat-a', offered.host, 'pwd');
  expect(remoteApprovals()).toHaveLength(1);
  resetRemoteApprovals(); expect(await revoked).toBe(false);
});
