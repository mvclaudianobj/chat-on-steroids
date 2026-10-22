/**
 * Renderer access to the upstream OpenCode and ZeroClaw modules (Chat Marks, Settings > Modules):
 * versions (installed, unmanaged on PATH, latest), install/update of the release the user
 * confirmed, and OpenCode's background service (state, Start/Stop/Restart). No path, binary or
 * secret crosses to the renderer.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { markspanelAccessBlocked } from '../markspanel-auth.js';
import { logWarn } from '../logger.js';
import { isNewerVersion } from '../github-release.js';
import {
  UPSTREAM_MODULE_IDS, UPSTREAM_VERSION,
  type UpstreamInstallProgress, type UpstreamModuleId, type UpstreamModuleStatus, type UpstreamModuleVersions, type UpstreamSupport
} from '../../shared/upstream-module.js';
import { installUpstream, type UpstreamSpec } from './install.js';
import { OPENCODE_SPEC, opencodeSupport } from '../opencode/release.js';
import { ZEROCLAW_SPEC } from '../zeroclaw/release.js';

const SPECS: Readonly<Record<UpstreamModuleId, UpstreamSpec>> = { opencode: OPENCODE_SPEC, zeroclaw: ZEROCLAW_SPEC };
const LATEST_TTL_MS = 60 * 60_000;
const latest = new Map<UpstreamModuleId, { at: number; version: string }>();
const lastInstall = new Map<UpstreamModuleId, UpstreamInstallProgress>();

const module = z.enum(UPSTREAM_MODULE_IDS);
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), module, refresh: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('install'), module, mode: z.enum(['install', 'update']), version: z.string().regex(UPSTREAM_VERSION) }).strict(),
  z.object({ action: z.literal('service'), module: z.literal('opencode'), op: z.enum(['start', 'stop', 'restart']) }).strict()
]);

export interface UpstreamIpcDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  binaries(id: UpstreamModuleId): Promise<{ managed: string | null; unmanaged: string | null }>;
  modulesRoot(): Promise<string>;
}

const defaultDeps: UpstreamIpcDeps = {
  binaries: async id => (await import('../cli-modules.js')).cliUpstreamBinaries(id),
  modulesRoot: async () => (await import('../cli-modules.js')).cliModulesRoot()
};
let deps = defaultDeps;
export function setUpstreamIpcDepsForTests(next: Partial<UpstreamIpcDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  latest.clear();
  lastInstall.clear();
}

/** What this app supports of a module's version: OpenCode has a gate, ZeroClaw is a terminal only. */
export function supportOf(id: UpstreamModuleId, version: string | null): UpstreamSupport | null {
  if (!version) return null;
  return id === 'opencode' ? opencodeSupport(version) : 'ok';
}

export const installablePlatform = (platform: string = process.platform, arch: string = process.arch): boolean =>
  (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) || platform === 'win32';

/** The latest version from the module's own source (npm for OpenCode, GitHub for ZeroClaw), cached 1 h. */
async function latestVersion(id: UpstreamModuleId, refresh: boolean): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const cached = latest.get(id);
  if (cached && !refresh && now - cached.at < LATEST_TTL_MS) return cached.version;
  const version = await SPECS[id].source.latest(deps.fetchImpl);
  if (!UPSTREAM_VERSION.test(version)) throw new Error('release_unavailable');
  latest.set(id, { at: now, version });
  return version;
}

export async function upstreamVersions(id: UpstreamModuleId, refresh = false): Promise<UpstreamModuleVersions> {
  const [binaries, found] = await Promise.all([
    deps.binaries(id).catch(() => ({ managed: null, unmanaged: null })),
    latestVersion(id, refresh).then(version => ({ version, error: undefined as string | undefined }),
      () => ({ version: null, error: 'release_unavailable' }))
  ]);
  const inUse = binaries.managed ?? binaries.unmanaged;
  const latestSupport = supportOf(id, found.version);
  const newer = isNewerVersion(binaries.managed, found.version);
  return {
    installed: binaries.managed, unmanaged: binaries.unmanaged, latest: found.version,
    updateAvailable: newer && latestSupport !== 'unsupported',
    latestUnsupported: latestSupport === 'unsupported' && (!binaries.managed || newer),
    support: supportOf(id, inUse), installable: installablePlatform(),
    ...(found.error ? { latestError: found.error } : {})
  };
}

export async function upstreamStatus(id: UpstreamModuleId, refresh = false): Promise<UpstreamModuleStatus> {
  const versions = await upstreamVersions(id, refresh);
  const status: UpstreamModuleStatus = { module: id, versions, install: lastInstall.get(id) ?? null };
  if (id === 'opencode') status.service = await (await import('../opencode/service.js')).openCodeServiceView();
  return status;
}

/**
 * Installs the confirmed version. OpenCode: the running service keeps the old binary's inode and
 * is restarted (`service restart`) at once when no session runs, else when the last one ends
 * (no running answer is cut).
 */
export async function upstreamInstall(id: UpstreamModuleId, mode: 'install' | 'update', version: string,
  onProgress: (progress: UpstreamInstallProgress) => void = () => undefined): Promise<UpstreamModuleStatus> {
  const spec = SPECS[id];
  if (!installablePlatform()) throw new Error('unsupported_platform');
  if (id === 'opencode' && supportOf(id, version) === 'unsupported') throw new Error('unsupported_version');
  await installUpstream(spec, version, mode, {
    modulesRoot: await deps.modulesRoot(), fetchImpl: deps.fetchImpl,
    onProgress: progress => { lastInstall.set(id, progress); onProgress(progress); }
  });
  latest.delete(id);
  if (id === 'opencode') await (await import('../opencode/service.js')).requestOpenCodeRestart()
    .catch(error => logWarn(`OpenCode: installed, but the service did not restart yet: ${(error as Error).message}`));
  return upstreamStatus(id);
}

export function registerUpstreamIpc(getWindow: () => BrowserWindow | null): void {
  // Module Stop/Disable also stops OpenCode's background service when it is the app's own.
  void import('../cli-modules.js').then(({ registerCliModuleStopHook }) => registerCliModuleStopHook(id => {
    if (id === 'opencode') void import('../opencode/service.js').then(module => module.stopOwnOpenCodeService());
  })).catch(() => undefined);
  const progress = (next: UpstreamInstallProgress): void => {
    const target = getWindow();
    if (target && !target.isDestroyed()) target.webContents.send('marksUpstream:progress', next);
  };
  ipcMain.handle('marksUpstream:request', async (event, payload: unknown) => {
    try {
      if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('Window not authorized');
      const input = request.parse(payload);
      switch (input.action) {
        case 'status': return { ok: true, data: await upstreamStatus(input.module, input.refresh) };
        case 'install': return { ok: true, data: await upstreamInstall(input.module, input.mode, input.version, progress) };
        case 'service': {
          await (await import('../opencode/service.js')).openCodeServiceAction(input.op);
          return { ok: true, data: await upstreamStatus('opencode') };
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
