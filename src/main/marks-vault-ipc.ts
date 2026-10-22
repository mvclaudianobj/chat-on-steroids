import { BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { createVault, vaultStatus, listVault, putVault, removeVault, revealVault, changeVaultPassword, recoverVault, importVault, exportVault, importEntries } from './marks-vault.js';
import { decryptGpgVault } from './marks-vault-gpg.js';
import { decideVaultApproval, vaultApprovals } from './marks-vault-approval.js';
import { logWarn } from './logger.js';
import { dialogLabel, mainText } from './main-texts.js';

/** Dedicated guarded IPC: renderer has no raw filesystem/keyring access. */
export function registerVaultIpc(getWindow: () => BrowserWindow | null): void {
  const register = (name: string, fn: (input: any) => Promise<unknown>) => ipcMain.handle(`vault:${name}`, async (event, input: unknown) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, error: 'Unauthorized window' };
    }
    try { return { ok: true, data: await fn(input) }; }
    catch { logWarn(`vault administration refused: ${name} failed validation or secure storage`); return { ok: false, error: 'Vault action failed. Verify the master password, permissions and input format.' }; }
  });
  const password = z.object({ password: z.string().min(12).max(1024) }).strict();
  const name = z.string().min(1).max(80);
  register('status', async () => vaultStatus());
  register('list', async () => listVault());
  register('create', async raw => createVault(password.parse(raw).password));
  register('recover', async raw => recoverVault(password.parse(raw).password));
  register('put', async raw => {
    const data = password.extend({ name, value: z.string().min(1).max(16384), origin: z.string().max(300), header: z.string().min(1).max(80) }).strict().parse(raw);
    return putVault(data, data.password);
  });
  register('remove', async raw => { const data = password.extend({ name }).strict().parse(raw); return removeVault(data.name, data.password); });
  register('reveal', async raw => { const data = password.extend({ name }).strict().parse(raw); return revealVault(data.name, data.password); });
  register('changePassword', async raw => {
    const data = z.object({ oldPassword: password.shape.password, newPassword: password.shape.password }).strict().parse(raw);
    return changeVaultPassword(data.oldPassword, data.newPassword);
  });
  register('export', async raw => {
    const data = password.parse(raw);
    const window = getWindow();
    if (!window) return false;
    const selection = await dialog.showSaveDialog(window, { ...dialogLabel('Export encrypted Chat Marks vault'), defaultPath: 'chat-marks-vault.json', filters: [{ name: mainText('Chat Marks vault'), extensions: ['json'] }] });
    return !selection.canceled && !!selection.filePath ? (await exportVault(selection.filePath, data.password), true) : false;
  });
  register('import', async raw => {
    const data = password.parse(raw);
    const window = getWindow(); if (!window) return false;
    const selection = await dialog.showOpenDialog(window, { ...dialogLabel('Import encrypted Chat Marks vault'), properties: ['openFile'], filters: [{ name: mainText('Chat Marks vault'), extensions: ['json'] }] });
    return selection.canceled || !selection.filePaths[0] ? false : (await importVault(selection.filePaths[0], data.password), true);
  });
  register('importGpg', async raw => {
    const data = z.object({ password: password.shape.password, gpgPassword: z.string().max(1024) }).strict().parse(raw);
    const window = getWindow(); if (!window) return 0;
    const selection = await dialog.showOpenDialog(window, { ...dialogLabel('Import GPG secrets'), properties: ['openFile'], filters: [{ name: mainText('GPG encrypted files'), extensions: ['gpg', 'asc'] }] });
    return selection.canceled || !selection.filePaths[0] ? 0 : importEntries(await decryptGpgVault(selection.filePaths[0], data.gpgPassword), data.password);
  });
  register('pending', async () => vaultApprovals());
  register('decide', async raw => {
    const data = z.object({ id: z.string().uuid(), choice: z.enum(['once', 'session', 'deny']) }).strict().parse(raw);
    return decideVaultApproval(data.id, data.choice);
  });
}
