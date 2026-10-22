import { BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { listRemoteHosts, saveRemoteHost, deleteRemoteHost, previewRemoteTargets, remoteHostByName, executeRemoteHost, hostKeyCandidate, trustHostKeys, installMasterKeyWithPassword, unlockMasterKeyFromVault, type HostProfile } from './hosts.js';
import { remoteApprovals, decideRemoteApproval, onRemoteApprovalsChanged } from './approval.js';
import { addRemoteProject } from '../projects.js';
import { importRemoteHosts } from './hosts.js';

let preview: HostProfile[] | null = null;
const fingerprints = new Map<string, { fingerprint: string; keys: string }>();
export function registerRemoteHostsIpc(getWindow: () => BrowserWindow | null): void {
  onRemoteApprovalsChanged(() => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('remoteHosts:pending-changed');
  });
  const register = (action: string, fn: (raw: unknown) => Promise<unknown>) => ipcMain.handle(`remoteHosts:${action}`, async (event, raw: unknown) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: 'Unauthorized window' };
    try { return { ok: true, data: await fn(raw) }; }
    catch { return { ok: false, error: 'Remote operation failed. Check the host, SSH trust and key.' }; }
  });
  const name = z.object({ name: z.string().min(1).max(80) }).strict();
  register('list', () => listRemoteHosts());
  register('save', raw => saveRemoteHost(raw));
  register('delete', async raw => { await deleteRemoteHost(z.object({ id: z.string().uuid() }).strict().parse(raw).id); });
  register('test', async raw => executeRemoteHost(await remoteHostByName(name.parse(raw).name), 'true'));
  register('install', async raw => {
    const data = name.extend({ password: z.string().min(1).max(4096) }).strict().parse(raw);
    const host = await remoteHostByName(data.name);
    await installMasterKeyWithPassword(host, data.password);
    return true;
  });
  register('unlock', async () => { await unlockMasterKeyFromVault(); return true; });
  register('fingerprint', async raw => {
    const host = await remoteHostByName(name.parse(raw).name);
    const candidate = await hostKeyCandidate(host);
    fingerprints.delete(host.id);
    if (!candidate.known) fingerprints.set(host.id, { fingerprint: candidate.fingerprint, keys: candidate.keys });
    return { known: candidate.known, fingerprint: candidate.fingerprint };
  });
  register('trust', async raw => {
    const data = name.extend({ fingerprint: z.string().min(1).max(4096) }).strict().parse(raw);
    const host = await remoteHostByName(data.name);
    const offered = fingerprints.get(host.id); fingerprints.delete(host.id);
    if (!offered || offered.fingerprint !== data.fingerprint) throw new Error('Fingerprint preview required');
    const current = await hostKeyCandidate(host);
    if (current.known || current.fingerprint !== offered.fingerprint || current.keys !== offered.keys) throw new Error('Host key changed');
    await trustHostKeys(current.keys);
    return true;
  });
  register('project', async raw => {
    const args = name.extend({ folder: z.string().min(1).max(4096) }).strict().parse(raw);
    const host = await remoteHostByName(args.name);
    if (host.type !== 'ssh') throw new Error('Only SSH profiles can become projects');
    return addRemoteProject(`${host.user}@${host.host}:${host.port}`, args.folder);
  });
  register('preview', async () => {
    preview = null;
    const window = getWindow(); if (!window) return [];
    const selection = await dialog.showOpenDialog(window, { title: 'Select a copy of remote-targets.json', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selection.canceled || !selection.filePaths[0]) return [];
    preview = await previewRemoteTargets(selection.filePaths[0]); return preview;
  });
  register('import', async () => {
    if (!preview) throw new Error('Preview required');
    const selected = preview; preview = null;
    return importRemoteHosts(selected);
  });
  register('pending', async () => remoteApprovals());
  register('decide', async raw => {
    const data = z.object({ id: z.string().uuid(), choice: z.enum(['once', 'session', 'deny']) }).strict().parse(raw);
    return decideRemoteApproval(data.id, data.choice);
  });
}
