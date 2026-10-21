/**
 * Renderer access to CLIProxyAPI management (Chat Marks, Settings > Modules > CLIProxyAPI).
 * The management password and API keys travel in one direction only: the renderer can write
 * the password, and sees API keys as id + last four characters.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { markspanelAccessBlocked } from '../markspanel-auth.js';
import { setSecret } from '../secrets.js';
import { setApiChatKey } from '../api-chat/settings.js';
import { verifiedManagementBase } from '../modules.js';
import { CLIPROXY_VERSION, type CliProxyInstallProgress, type CliProxyManageStatus, type CliProxyVersions } from '../../shared/cliproxy.js';
import { installablePlatform, installedVersion, isOfficialVersion, isUpdateAvailable, latestRelease } from './release.js';
import { installRelease, repairConfigWrites, serviceConfigReadOnly } from './installer.js';
import {
  createApiKey, listApiKeys, MANAGEMENT_KEY, managementKey, managementKeyRejected, revokeApiKey, setManagementKey
} from './management.js';

const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), refresh: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('setManagementKey'), key: z.string().max(4096) }).strict(),
  z.object({ action: z.literal('createKey') }).strict(),
  z.object({ action: z.literal('revokeKey'), id: z.string().regex(/^[0-9a-f]{16}$/) }).strict(),
  z.object({ action: z.literal('repairConfig') }).strict(),
  z.object({ action: z.literal('install'), mode: z.enum(['install', 'update']), version: z.string().regex(CLIPROXY_VERSION) }).strict()
]);

let lastInstall: CliProxyInstallProgress | null = null;
/** A management write answered "failed to save config" since the last repair. */
let saveFailed = false;

export async function cliProxyVersions(refresh = false): Promise<CliProxyVersions> {
  const installable = installablePlatform();
  const [installed, latest] = await Promise.all([
    process.platform === 'linux' ? installedVersion() : Promise.resolve(null),
    latestRelease({ refresh }).then(release => ({ version: release.version, error: undefined }),
      (error: Error) => ({ version: null, error: error.message === 'release_unavailable' ? error.message : 'release_unavailable' }))
  ]);
  return {
    installed, installedOfficial: isOfficialVersion(installed), latest: latest.version,
    updateAvailable: isUpdateAvailable(installed, latest.version), installable,
    ...(latest.error ? { latestError: latest.error } : {})
  };
}

export async function cliProxyStatus(refresh = false): Promise<CliProxyManageStatus> {
  const [versions, key, base, readOnly] = await Promise.all([
    cliProxyVersions(refresh), managementKey(), verifiedManagementBase(),
    process.platform === 'linux' ? serviceConfigReadOnly() : Promise.resolve(null)
  ]);
  let keys: CliProxyManageStatus['keys'] = null;
  let keysError: string | undefined;
  let valid: boolean | null = null;
  if (!key) keysError = 'management_key_missing';
  else if (managementKeyRejected()) { valid = false; keysError = 'management_key_invalid'; }
  else if (!base) keysError = 'management_unreachable';
  else {
    try {
      keys = await listApiKeys(base);
      valid = true;
    } catch (error) {
      keysError = (error as Error).message;
      if (keysError === 'management_key_invalid') valid = false;
    }
  }
  return {
    versions, hasManagementKey: !!key, managementKeyValid: valid, keys, ...(keysError ? { keysError } : {}),
    install: lastInstall,
    configRepair: process.platform === 'linux' && versions.installed !== null && (saveFailed || readOnly === true)
  };
}

async function base(): Promise<string> {
  const found = await verifiedManagementBase();
  if (!found) throw new Error('management_unreachable');
  return found;
}

async function noteSave<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if ((error as Error).message === 'management_save_failed') saveFailed = true;
    throw error;
  }
}

export function registerCliProxyIpc(getWindow: () => BrowserWindow | null): void {
  const progress = (next: CliProxyInstallProgress): void => {
    lastInstall = next;
    const target = getWindow();
    if (target && !target.isDestroyed()) target.webContents.send('marksCliProxy:progress', next);
  };
  ipcMain.handle('marksCliProxy:request', async (event, payload: unknown) => {
    try {
      if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('Window not authorized');
      const input = request.parse(payload);
      switch (input.action) {
        case 'status': return { ok: true, data: await cliProxyStatus(input.refresh) };
        case 'setManagementKey':
          await setManagementKey(input.key.trim() ? await base() : null, input.key);
          return { ok: true, data: await cliProxyStatus() };
        case 'createKey': await noteSave(createApiKey(await base())); return { ok: true, data: await cliProxyStatus() };
        case 'revokeKey': await noteSave(revokeApiKey(await base(), input.id)); return { ok: true, data: await cliProxyStatus() };
        case 'repairConfig':
          if (process.platform !== 'linux') throw new Error('unsupported_platform');
          await repairConfigWrites();
          saveFailed = false;
          return { ok: true, data: await cliProxyStatus() };
        case 'install':
          if (!installablePlatform()) throw new Error('unsupported_platform');
          await installRelease(input.mode, input.version, {
            onProgress: progress,
            saveSecrets: async (management, apiKey) => { await setSecret(MANAGEMENT_KEY, management); await setApiChatKey(apiKey); }
          });
          return { ok: true, data: await cliProxyStatus(true) };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
