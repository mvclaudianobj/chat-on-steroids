import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureVaultForTests, createVault, vaultStatus, listVault, putVault, useVault, revealVault,
  removeVault, recoverVault, changeVaultPassword, exportVault, importVault, importEntries
} from '../src/main/marks-vault.js';
import { parseGpgVault } from '../src/main/marks-vault-gpg.js';
import { redactVaultText, replaceVaultRedactionEntries, redactVaultValues } from '../src/main/marks-vault-redaction.js';
import { redactCredentialText } from '../src/main/redaction.js';
import { decideVaultApproval, onVaultApprovalsChanged, requestVaultApproval, resetVaultApprovals, revokeVaultChat, vaultApprovals } from '../src/main/marks-vault-approval.js';
let directory: string, stored: string | null, file: string;
const master = 'an example strong master passphrase';
const example = { name: 'service/token', value: 'secret-value-is-never-public', origin: 'https://service.example', header: 'Authorization' };
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'marks-vault-'));
  stored = null; file = path.join(directory, 'vault.json');
  configureVaultForTests(file, { getKey: async () => stored, setKey: async value => { stored = value; } });
});
afterEach(async () => { replaceVaultRedactionEntries([]); resetVaultApprovals(); await rm(directory, { recursive: true, force: true }); });
it('seals portable ciphertext, requires the master for admin, and uses the OS key daily', async () => {
  expect(await vaultStatus()).toEqual({ created: false, count: 0, ready: false });
  await createVault(master);
  expect(await vaultStatus()).toEqual({ created: true, count: 0, ready: true });
  await expect(putVault(example, 'incorrect password 123')).rejects.toThrow();
  await putVault(example, master);
  const ciphertext = await readFile(file, 'utf8');
  expect(ciphertext).toContain('chat-marks-vault');
  expect(ciphertext).not.toContain(example.value);
  expect(ciphertext).not.toContain(example.name);
  expect(ciphertext).not.toContain(master);
  expect(await listVault()).toEqual([{ name: example.name, origin: example.origin, header: example.header }]);
  expect(redactVaultText(`print:${example.value}`)).toBe('print:[secret:service/token]');
  expect(redactCredentialText(`output: ${example.value}`)).toBe('output: [secret:service/token]');
  expect(redactVaultValues({ content: [{ type: 'text', text: example.value }] })).toEqual({ content: [{ type: 'text', text: '[secret:service/token]' }] });
  expect(await useVault(example.name, async entry => entry.value)).toBe(example.value);
  await expect(revealVault(example.name, 'invalid master password')).rejects.toThrow();
  expect(await revealVault(example.name, master)).toBe(example.value);
  stored = null;
  expect(await vaultStatus()).toEqual({ created: true, count: null, ready: false });
  await expect(listVault()).rejects.toThrow();
  await recoverVault(master);
  expect((await listVault()).length).toBe(1);
  await changeVaultPassword(master, 'new password for recovery 1234');
  await expect(revealVault(example.name, master)).rejects.toThrow();
  expect(await revealVault(example.name, 'new password for recovery 1234')).toBe(example.value);
  await removeVault(example.name, 'new password for recovery 1234');
  expect(await listVault()).toEqual([]);
});
it('exports encrypted portable vault and imports with master recovery', async () => {
  await createVault(master); await putVault(example, master);
  const backup = path.join(directory, 'backup.json');
  await exportVault(backup, master);
  stored = null;
  configureVaultForTests(path.join(directory, 'imported.json'), { getKey: async () => stored, setKey: async value => { stored = value; } });
  await expect(importVault(backup, 'incorrect password 123')).rejects.toThrow();
  await importVault(backup, master);
  expect(await revealVault(example.name, master)).toBe(example.value);
});
it('does not overwrite old installations or corrupted ciphertext', async () => {
  expect(await vaultStatus()).toEqual({ created: false, count: 0, ready: false });
  await createVault(master);
  await putVault(example, master);
  const intact = await readFile(file, 'utf8');
  const corrupted = JSON.parse(intact);
  corrupted.records.data = Buffer.from('damaged').toString('base64');
  await writeFile(file, JSON.stringify(corrupted));
  expect(await vaultStatus()).toMatchObject({ created: true, ready: false });
  await expect(listVault()).rejects.toThrow();
  await expect(putVault(example, master)).rejects.toThrow();
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(corrupted);
  await writeFile(file, intact);
  expect(await revealVault(example.name, master)).toBe(example.value);
});
it('rejects corrupt, duplicate or unapproved origins and GPG unsupported shapes', async () => {
  await createVault(master);
  await expect(putVault({ ...example, origin: 'http://insecure.example' }, master)).rejects.toThrow();
  await expect(putVault({ ...example, origin: 'https://user:pass@service.example' }, master)).rejects.toThrow();
  await expect(importEntries([{ ...example }, { ...example }], master)).rejects.toThrow();
  expect(await listVault()).toEqual([]);
  expect(parseGpgVault(JSON.stringify({ secrets: { token: 'sample-token' } }))).toEqual([{ name: 'token', value: 'sample-token', origin: '', header: 'Authorization' }]);
  expect(() => parseGpgVault(JSON.stringify({ arbitrary: [] }))).toThrow();
});
it('requires a live human decision and scopes session grants to the chat plus name', async () => {
  const first = requestVaultApproval('chat-1', 'token', 'GET /');
  const pending = vaultApprovals(); expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ chat: 'chat-1', name: 'token' });
  expect(decideVaultApproval(pending[0]!.id, 'session')).toBe(true);
  expect(await first).toBe(true);
  expect(await requestVaultApproval('chat-1', 'token', 'POST /')).toBe(true);
  const different = requestVaultApproval('chat-2', 'token', 'GET /');
  expect(vaultApprovals()).toHaveLength(1);
  expect(decideVaultApproval(vaultApprovals()[0]!.id, 'deny')).toBe(true);
  expect(await different).toBe(false);
  revokeVaultChat('chat-1');
  const afterDeletion = requestVaultApproval('chat-1', 'token', 'GET /');
  expect(vaultApprovals()).toHaveLength(1);
  resetVaultApprovals();
  expect(await afterDeletion).toBe(false);
  const again = requestVaultApproval('chat-1', 'token', 'GET /');
  expect(vaultApprovals()).toHaveLength(1);
  resetVaultApprovals(); expect(await again).toBe(false);
});

describe('vault approval change events', () => {
  it('announces each held, decided and revoked request so the window never polls', async () => {
    resetVaultApprovals();
    let changes = 0;
    const stop = onVaultApprovalsChanged(() => { changes++; });
    const first = requestVaultApproval('chat-a', 'deploy-key', 'header');
    expect(changes).toBe(1);
    expect(decideVaultApproval(vaultApprovals()[0]!.id, 'once')).toBe(true);
    await expect(first).resolves.toBe(true);
    expect(changes).toBe(2);
    const second = requestVaultApproval('chat-b', 'deploy-key', 'header');
    revokeVaultChat('chat-b');
    await expect(second).resolves.toBe(false);
    expect(changes).toBe(4);
    stop();
    void requestVaultApproval('chat-c', 'deploy-key', 'header');
    expect(changes).toBe(4);
    resetVaultApprovals();
  });

  it('does not start a renderer timer for the pending banner', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/renderer/marks-vault.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/setInterval\(/);
    expect(source).toContain('onVaultPendingChanged');
  });
  it('uses authenticated vault names for saved-value indicators without filling the password field', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/renderer/marks-vault.ts', import.meta.url), 'utf8');
    expect(source).toContain("const listed = await call('list')");
    expect(source).toContain('storedNames = vaultReady && listed.ok && Array.isArray(listed.data)');
    expect(source).toContain("secretValue.placeholder = present ? '••••••••' : ''");
    expect(source).toContain("secretValue.setAttribute('aria-describedby', 'vaultValueState')");
    expect(source).toContain("secretName.addEventListener('input', () => { secretValue.value = ''; paintSecretPresence(); })");
    expect(source).not.toMatch(/secretValue\.value\s*=\s*['\"]•/);
  });
});
