/** A narrow, opt-in adapter to an EXISTING CLIProxyAPI systemd service. No config writes. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { BrowserWindow, shell } from 'electron';
import { MARKS_MODULE_SOURCES } from '../shared/module-sources.js';
import { managementKey } from './cliproxy/management.js';
import type { MarksModuleAction, MarksModuleState } from '../shared/modules.js';
import { externalModuleStatus } from './external-modules.js';

const exec = promisify(execFile);
const SERVICE = 'cli-proxy-api.service';
const BINARY = '/usr/local/bin/cli-proxy-api';
// The Marks CLIProxyAPI unit normally listens on 18081. Status discovery remains
// authoritative and also supports the upstream 8317 default when configured.
const DEFAULT_MANAGER = 'http://127.0.0.1:18081/management.html';
const FALLBACK_PORTS = [8317, 18081] as const;
const MANAGER_PATH = '/management.html';
const MANAGEMENT_TITLE = /<title>\s*CLI Proxy API Management Center\s*<\/title>/i;

let consoleWindow: BrowserWindow | null = null;
let consoleOrigin: string | null = null;

function portNumber(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Parse only the root-level listener port; never parse/log secret or authentication fields. */
export function configuredManagementPort(config: string): number | null {
  const match = /^port:\s*(\d{1,5})\s*(?:#.*)?$/m.exec(config);
  return match ? portNumber(match[1]!) : null;
}

/**
 * systemd is authoritative for the service's config path. On hardened installations it
 * is root-readable only; that is normal and requires a conservative validated fallback.
 */
async function serviceConfigPort(): Promise<number | null> {
  try {
    const { stdout } = await exec('/usr/bin/systemctl', ['show', '--property=ExecStart', '--value', SERVICE], { timeout: 8_000 });
    const config = /--config\s+(?:'([^']+)'|"([^"]+)"|([^\s;]+))/.exec(stdout);
    const configPath = config?.[1] ?? config?.[2] ?? config?.[3];
    if (!configPath?.startsWith('/etc/cli-proxy-api/') || !configPath.endsWith('.yaml')) return null;
    return configuredManagementPort(await readFile(configPath, 'utf8'));
  } catch {
    return null; // Never elevate, expose secrets or weaken config file permissions.
  }
}

/**
 * Validate both upstream routes (the root banner and the console page title). The identity
 * probe never calls the management API without a key: CLIProxyAPI counts every unauthenticated
 * management request as a failed login and bans the loopback client for 30 minutes after five.
 */
async function probeConsole(port: number): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const status = await fetch(`${base}/`, {
      redirect: 'manual', signal: AbortSignal.timeout(2_000)
    });
    const apiType = status.headers.get('content-type') ?? '';
    if (status.status !== 200 || !apiType.includes('application/json')) {
      await status.body?.cancel();
      return false;
    }
    const response = await status.json() as unknown;
    if (!response || typeof response !== 'object' || Array.isArray(response) ||
        (response as { message?: unknown }).message !== 'CLI Proxy API Server') return false;

    const page = await fetch(`${base}${MANAGER_PATH}`, {
      redirect: 'manual', signal: AbortSignal.timeout(2_000)
    });
    if (page.status !== 200 || !(page.headers.get('content-type') ?? '').includes('text/html')) {
      await page.body?.cancel();
      return false;
    }
    // The title is in the first kilobytes of the upstream console. Avoid downloading or
    // retaining its complete multi-megabyte bundle merely to identify the page.
    const reader = page.body?.getReader();
    if (!reader) return false;
    const decoder = new TextDecoder();
    let beginning = '';
    try {
      while (beginning.length < 32_768) {
        const { done, value } = await reader.read();
        if (done) break;
        beginning += decoder.decode(value, { stream: true });
        if (MANAGEMENT_TITLE.test(beginning)) return true;
      }
      return false;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

/** URL validation is separate from endpoint ownership/identity validation. */
export function safeManagementUrl(raw?: string): string {
  const parsed = new URL(raw ?? DEFAULT_MANAGER);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      parsed.username || parsed.password || parsed.pathname !== MANAGER_PATH ||
      parsed.search || parsed.hash || !portNumber(parsed.port || '80')) {
    throw new Error('Use the local CLIProxyAPI management address ending in /management.html, without credentials.');
  }
  // Always use numeric loopback; localhost may resolve through an altered hosts file.
  return `http://127.0.0.1:${Number(parsed.port || 80)}${MANAGER_PATH}`;
}

function navigable(destination: string, origin: string, mainFrame: boolean): boolean {
  try {
    const url = new URL(destination);
    return url.origin === origin && (!mainFrame || (url.pathname === MANAGER_PATH && !url.search));
  } catch {
    return false;
  }
}

/**
 * Chat Marks: open the console already signed in. The bundled management page restores a
 * remembered login from its own localStorage (`managementKey`, `apiBase`, `isLoggedIn`; plain
 * JSON values are re-obfuscated by the page itself). They are written into the fresh ephemeral
 * partition on a script-free same-origin document (`/healthz`, JSON) before the console loads,
 * only when a management password is stored and only after that document's origin is checked.
 */
export async function seedConsoleLogin(window: Pick<BrowserWindow, 'loadURL' | 'webContents'>, origin: string): Promise<boolean> {
  const key = await managementKey();
  if (!key) return false;
  await window.loadURL(`${origin}/healthz`);
  if (new URL(window.webContents.getURL()).origin !== origin) return false;
  const values = { apiBase: JSON.stringify(origin), managementKey: JSON.stringify(key), isLoggedIn: 'true' };
  await window.webContents.executeJavaScript(
    `(values => { for (const [name, value] of Object.entries(values)) localStorage.setItem(name, value); })(${JSON.stringify(values)})`);
  return true;
}

/** Dedicated, ephemeral session. Never reuse cookies between ports or app sessions. */
async function openConsole(url: string): Promise<void> {
  const origin = new URL(url).origin;
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    if (consoleOrigin === origin) {
      await consoleWindow.loadURL(url);
      consoleWindow.focus();
      return;
    }
    consoleWindow.close();
  }
  const window = new BrowserWindow({
    title: 'Chat Marks - CLIProxyAPI', width: 1100, height: 780, minWidth: 700, minHeight: 500,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false,
      partition: `marks-cli-proxy-console-${randomUUID()}`
    }
  });
  consoleWindow = window;
  consoleOrigin = origin;
  window.on('closed', () => { if (consoleWindow === window) { consoleWindow = null; consoleOrigin = null; } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', event => {
    if (!navigable(event.url, origin, true)) event.preventDefault();
  });
  window.webContents.on('will-redirect', event => {
    if (!navigable(event.url, origin, event.isMainFrame)) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', event => {
    if (!navigable(event.url, origin, event.isMainFrame)) event.preventDefault();
  });
  // Navigation fences alone do not stop cross-origin XHR, fetch, CSS or iframe requests.
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({ cancel: !navigable(details.url, origin, false) });
  });
  try {
    await seedConsoleLogin(window, origin);
    await window.loadURL(url);
  } catch {
    if (!window.isDestroyed()) window.close();
    throw new Error('Unable to load the verified local CLIProxyAPI console.');
  }
}

async function command(command: string, args: string[]): Promise<boolean> {
  try { await exec(command, args, { timeout: 8_000 }); return true; } catch { return false; }
}

async function serviceState(): Promise<{ installed: boolean; running: boolean; enabled: boolean }> {
  const [running, enabled, loaded, binary] = await Promise.all([
    command('/usr/bin/systemctl', ['is-active', '--quiet', SERVICE]),
    command('/usr/bin/systemctl', ['is-enabled', '--quiet', SERVICE]),
    command('/usr/bin/systemctl', ['cat', SERVICE]),
    access(BINARY).then(() => true, () => false)
  ]);
  return { installed: loaded && binary, running, enabled };
}

/**
 * Prefer a port from the service's local config. When unreadable, fallback ports must
 * BOTH pass the management API and page fingerprint; ambiguity fails closed.
 */
async function verifiedPort(preferred?: number): Promise<number | null> {
  const configured = await serviceConfigPort();
  if (configured !== null) {
    if (preferred !== undefined && preferred !== configured) return null;
    return await probeConsole(configured) ? configured : null;
  }
  if (preferred !== undefined && !FALLBACK_PORTS.includes(preferred as typeof FALLBACK_PORTS[number])) return null;
  const matches = await Promise.all(FALLBACK_PORTS.map(async port => await probeConsole(port) ? port : null));
  const valid = matches.filter(port => port !== null);
  return valid.length === 1 && (preferred === undefined || preferred === valid[0]) ? valid[0]! : null;
}

/** Chat Marks: the verified local service origin for management requests, or null. */
export async function verifiedManagementBase(): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  const service = await serviceState();
  const port = service.installed && service.running ? await verifiedPort() : null;
  return port !== null ? `http://127.0.0.1:${port}` : null;
}

export async function modulesStatus(): Promise<MarksModuleState[]> {
  const base: MarksModuleState = {
    id: 'cli-proxy-api', name: 'CLIProxyAPI', description: 'API proxy and management console',
    source: MARKS_MODULE_SOURCES['cli-proxy-api'],
    installed: false, enabled: false, running: false, supported: false, managementUrl: '',
    consoleAvailable: false, detail: 'System service management is currently available on Linux only.'
  };
  if (process.platform !== 'linux') return [base, ...await externalModuleStatus()];
  const service = await serviceState();
  const port = service.installed && service.running ? await verifiedPort() : null;
  return [{ ...base, ...service, supported: true, consoleAvailable: port !== null,
    managementUrl: port !== null ? `http://127.0.0.1:${port}${MANAGER_PATH}` : '',
    detail: !service.installed ? 'Not installed as the supported systemd service.'
      : !service.running ? 'The CLIProxyAPI systemd service is stopped.'
        : port === null ? 'CLIProxyAPI is active, but its management console could not be safely identified. Check the service port.'
          : 'Managed through the existing systemd service. Configuration and credentials stay with CLIProxyAPI.'
  }, ...await externalModuleStatus()];
}

export async function moduleAction(action: MarksModuleAction, managementUrl?: string): Promise<MarksModuleState[]> {
  // Chat Marks: on Linux x64/arm64 the renderer installs and updates through the verified
  // release installer (`cliproxy/installer.ts`, explicit confirmation); these stay the guides
  // for every other platform.
  if (action === 'install') {
    // Installation is opt-in and stays with the official upstream. Never
    // execute remote install scripts or elevate during a catalog action.
    await shell.openExternal(MARKS_MODULE_SOURCES['cli-proxy-api'].homepage);
    return modulesStatus();
  }
  if (action === 'update') {
    // Never silently overwrite a separately installed system service. The
    // publisher's release page is an explicit update guide until a verified,
    // pinned installer protocol is implemented for this module.
    await shell.openExternal(`${MARKS_MODULE_SOURCES['cli-proxy-api'].homepage}/releases`);
    return modulesStatus();
  }
  if (process.platform !== 'linux') throw new Error('Service controls are available on Linux only.');
  if (action === 'open') {
    const service = await serviceState();
    if (!service.installed || !service.running) throw new Error('Start the installed CLIProxyAPI service before opening its console.');
    const desired = safeManagementUrl(managementUrl);
    const port = Number(new URL(desired).port);
    if (await verifiedPort(port) !== port) {
      throw new Error('The requested local address is not a verified CLIProxyAPI management console.');
    }
    await openConsole(desired);
    return modulesStatus();
  }
  const service = await serviceState();
  if (!service.installed) throw new Error('CLIProxyAPI is not installed as a systemd service.');
  if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) throw new Error('Unknown module action.');
  await exec('/usr/bin/pkexec', ['/usr/bin/systemctl', action, SERVICE], { timeout: 120_000 });
  return modulesStatus();
}
