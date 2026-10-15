/** A narrow, opt-in systemd adapter. Does not alter CLIProxyAPI's config, API or binary. */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { BrowserWindow, shell } from 'electron';
import type { MarksModuleAction, MarksModuleState } from '../shared/modules.js';

const exec = promisify(execFile);
const SERVICE = 'cli-proxy-api.service';
const BINARY = '/usr/local/bin/cli-proxy-api';
const MANAGER = 'http://127.0.0.1:8317/management.html';
const LOCAL_PORTS = [8317, 18081] as const;

/** Probe only fixed localhost endpoints, and accept the CLIProxyAPI signature, not any web server. */
async function managementUrl(): Promise<string> {
  for (const port of LOCAL_PORTS) {
    try {
      const url = `http://127.0.0.1:${port}/v8/management/config`;
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.headers.has('x-cpa-version') || response.headers.has('x-cpa-build-date')) {
        await response.body?.cancel();
        return `http://127.0.0.1:${port}/management.html`;
      }
      await response.body?.cancel();
    } catch { /* A port not in use is ordinary, never a module failure. */ }
  }
  return MANAGER;
}

const INSTALL_URL = 'https://github.com/router-for-me/CLIProxyAPI';
let consoleWindow: BrowserWindow | null = null;
let consoleOrigin: string | null = null;

/** Render the upstream console in an isolated native Marks window, without injecting code. */
async function openConsole(url: string): Promise<void> {
  const origin = new URL(url).origin;
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    if (consoleOrigin === origin) {
      consoleWindow.focus();
      await consoleWindow.loadURL(url);
      return;
    }
    // Another local CLIProxyAPI port is a distinct web origin. Recreate the isolated window
    // so the original navigation fence cannot accidentally follow its previous origin.
    consoleWindow.close();
  }
  const window = new BrowserWindow({
    title: 'Chat Marks - CLIProxyAPI', width: 1100, height: 780, minWidth: 700, minHeight: 500,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, partition: 'persist:marks-cli-proxy-console' }
  });
  consoleWindow = window;
  consoleOrigin = origin;
  window.on('closed', () => { if (consoleWindow === window) { consoleWindow = null; consoleOrigin = null; } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => {
    if (!URL.canParse(destination) || new URL(destination).origin !== origin) event.preventDefault();
  });
  try { await window.loadURL(url); } catch (error) {
    if (!window.isDestroyed()) window.close();
    throw new Error(`Unable to open the local CLIProxyAPI console: ${(error as Error).message}`);
  }
}


async function command(command: string, args: string[]): Promise<boolean> {
  try { await exec(command, args, { timeout: 8_000 }); return true; } catch { return false; }
}

export async function modulesStatus(): Promise<MarksModuleState[]> {
  if (process.platform !== 'linux') return [{
    id: 'cli-proxy-api', name: 'CLIProxyAPI', description: 'API proxy and management console',
    installed: false, enabled: false, running: false, supported: false, managementUrl: MANAGER,
    detail: 'System service management is currently available on Linux only.'
  }];
  const [active, enabled, loaded, binary] = await Promise.all([
    command('/usr/bin/systemctl', ['is-active', '--quiet', SERVICE]),
    command('/usr/bin/systemctl', ['is-enabled', '--quiet', SERVICE]),
    command('/usr/bin/systemctl', ['cat', SERVICE]),
    access(BINARY).then(() => true, () => false)
  ]);
  const consoleUrl = active ? await managementUrl() : MANAGER;
  return [{
    id: 'cli-proxy-api', name: 'CLIProxyAPI', description: 'API proxy and management console',
    installed: loaded && binary, enabled, running: active, supported: true,
    managementUrl: consoleUrl,
    detail: loaded && binary ? 'Managed through the existing systemd service. Configuration and credentials stay with CLIProxyAPI.' : 'Not installed as the supported systemd service.'
  }];
}

/** Constrain management URLs to the local machine, never proxy credentials or remote commands. */
export function safeManagementUrl(raw?: string): string {
  const parsed = new URL(raw ?? MANAGER);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error('The management console must use a local HTTP address.');
  }
  if (!/^\/[^?#]*$/.test(parsed.pathname) || parsed.search || parsed.hash) throw new Error('Invalid management console URL.');
  return parsed.href;
}

export async function moduleAction(action: MarksModuleAction, managementUrl?: string): Promise<MarksModuleState[]> {
  if (action === 'open') {
    await openConsole(safeManagementUrl(managementUrl));
    return modulesStatus();
  }
  if (action === 'install') {
    // No unreviewed curl|sh installer or app-owned root writes: guide to the official project.
    await shell.openExternal(INSTALL_URL);
    return modulesStatus();
  }
  if (process.platform !== 'linux') throw new Error('Service controls are available on Linux only.');
  const [service] = await modulesStatus();
  if (!service?.installed) throw new Error('CLIProxyAPI is not installed as a systemd service.');
  if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw new Error('Unknown module action.');
  // PolicyKit owns elevation and prompts. The user must explicitly request this action.
  await exec('/usr/bin/pkexec', ['/usr/bin/systemctl', action, SERVICE], { timeout: 120_000 });
  return modulesStatus();
}
