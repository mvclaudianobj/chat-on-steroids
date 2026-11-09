import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  active: true, enabled: true, installed: true, configReadable: false,
  configPort: 18081, signaturePorts: new Set([18081]), spoofPort: null as number | null,
  opened: [] as string[], windows: [] as any[], elevated: [] as string[][],
  instructions: [] as string[], managementKey: null as string | null, unauthenticatedManagement: 0
}));
vi.mock('../src/main/cliproxy/management.js', () => ({ managementKey: async () => fixture.managementKey }));

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    fixture.instructions.push(`${file} ${args.join(' ')}`);
    if (file === '/usr/bin/pkexec') {
      fixture.elevated.push(args);
      callback(null, '', '');
      return;
    }
    const operation = args[0];
    if (operation === 'show') {
      callback(null, 'ExecStart={ path=/usr/local/bin/cli-proxy-api ; argv[]=/usr/local/bin/cli-proxy-api --config /etc/cli-proxy-api/config.yaml ; }', '');
      return;
    }
    const ok = operation === 'is-active' ? fixture.active
      : operation === 'is-enabled' ? fixture.enabled : fixture.installed;
    callback(ok ? null : new Error('not active'), '', '');
  }
}));
vi.mock('node:fs/promises', () => ({
  access: async () => { if (!fixture.installed) throw Error('missing binary'); },
  readFile: async () => {
    if (!fixture.configReadable) throw Error('EACCES: config is root-only');
    return `port: ${fixture.configPort}\nmanagement:\n  secret-key: MUST-NOT-BE-EXPOSED\n`;
  }
}));
vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => { fixture.opened.push(url); return Promise.resolve(); } },
  BrowserWindow: class {
    handlers: Record<string, (event: any) => void> = {};
    requestFilter?: (request: { url: string }, callback: (reply: { cancel: boolean }) => void) => void;
    destroyed = false;
    url = '';
    scripts: string[] = [];
    webContents = {
      getURL: () => this.url,
      executeJavaScript: async (code: string) => { this.scripts.push(code); },
      handlers: {} as Record<string, (event: any) => void>,
      on: (name: string, handler: (event: any) => void) => { this.webContents.handlers[name] = handler; },
      setWindowOpenHandler: (_handler: () => unknown) => undefined,
      session: { webRequest: { onBeforeRequest: (_filter: unknown, listener: (request: { url: string }, callback: (reply: { cancel: boolean }) => void) => void) => { this.requestFilter = listener; } } }
    };
    options: Record<string, any>;
    constructor(options: Record<string, any>) { this.options = options; fixture.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    focus() { }
    loadURL(url: string) { fixture.opened.push(url); this.url = url; return Promise.resolve(); }
    close() { this.destroyed = true; this.handlers.closed?.({}); }
    on(name: string, callback: (event: any) => void) { this.handlers[name] = callback; }
  }
}));

const { safeManagementUrl, configuredManagementPort, moduleAction, modulesStatus, seedConsoleLogin } = await import('../src/main/modules.js');
const banner = () => new Response(JSON.stringify({ message: 'CLI Proxy API Server', endpoints: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
function fakeHttp(url: string) {
  const parsed = new URL(url), port = Number(parsed.port);
  // Every unauthenticated management request is a failed login for CLIProxyAPI's ban counter.
  if (parsed.pathname.includes('/management/')) {
    fixture.unauthenticatedManagement++;
    return new Response(JSON.stringify({ error: 'missing management key' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  if (fixture.signaturePorts.has(port)) {
    return parsed.pathname === '/' ? banner()
      : new Response('<html><title>CLI Proxy API Management Center</title></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (port === fixture.spoofPort) {
    return parsed.pathname === '/' ? banner()
      : new Response('<html><title>unrelated local service</title></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }
  throw Error('connection refused');
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  fixture.active = fixture.installed = fixture.enabled = true;
  fixture.configReadable = false;
  fixture.configPort = 18081;
  fixture.signaturePorts = new Set([18081]);
  fixture.spoofPort = null;
  fixture.managementKey = null;
  fixture.unauthenticatedManagement = 0;
  fixture.opened.length = fixture.windows.length = fixture.elevated.length = fixture.instructions.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => fakeHttp(url)));
});
afterEach(() => {
  for (const window of fixture.windows) window.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Marks modules security boundary', () => {
  it('offers official source metadata without bundling or executing an installer', async () => {
    const [module] = await modulesStatus();
    expect(module!.source).toEqual({
      kind: 'github', repository: 'router-for-me/CLIProxyAPI',
      homepage: 'https://github.com/router-for-me/CLIProxyAPI',
      install: 'external-guide', update: 'upstream-managed'
    });
    expect(fixture.elevated).toEqual([]);
    expect(fixture.opened).toEqual([]);
  });
  it('restricts to the exact local management page without URLs carrying credentials', () => {
    expect(safeManagementUrl()).toBe('http://127.0.0.1:18081/management.html');
    expect(safeManagementUrl('http://localhost:8317/management.html')).toBe('http://127.0.0.1:8317/management.html');
    expect(safeManagementUrl('http://[::1]:18081/management.html')).toBe('http://127.0.0.1:18081/management.html');
    for (const url of [
      'https://github.com/router-for-me/CLIProxyAPI', 'http://127.0.0.1.evil.com:8317/management.html',
      'http://admin:secret@localhost:8317/management.html', 'file:///etc/passwd',
      'http://127.0.0.1:8317/management.html?key=secret', 'http://127.0.0.1:8317/management.html#token',
      'http://127.0.0.1:8317/v8/management/config', 'http://127.0.0.1:8317/',
      'http://127.0.0.1:8317/management.html/other', 'javascript:alert(1)'
    ]) expect(() => safeManagementUrl(url), url).toThrow();
  });

  it('parses only top-level listener port, not nested or secret values', () => {
    expect(configuredManagementPort('port: 18081\nmanagement:\n  port: 80\n  secret-key: opaque')).toBe(18081);
    expect(configuredManagementPort('management:\n  port: 80')).toBeNull();
    expect(configuredManagementPort('port: 65536')).toBeNull();
  });

  it('prefers the active unit config when readable and never chooses forged headers on 8317', async () => {
    fixture.configReadable = true;
    fixture.configPort = 18081;
    fixture.spoofPort = 8317;
    const [module] = await modulesStatus();
    expect(module).toMatchObject({ installed: true, running: true, consoleAvailable: true, managementUrl: 'http://127.0.0.1:18081/management.html' });
    expect(fixture.opened).toEqual([]);
    expect(fixture.instructions.some(x => x.includes('/usr/bin/pkexec'))).toBe(false);
  });

  it('fails closed when two endpoints have a plausible management signature', async () => {
    fixture.signaturePorts = new Set([8317, 18081]);
    const [module] = await modulesStatus();
    expect(module!.consoleAvailable).toBe(false);
    expect(module!.managementUrl).toBe('');
    await expect(moduleAction('open', 'http://127.0.0.1:8317/management.html')).rejects.toThrow('not a verified');
  });

  it('ignores unrelated local services even if they forge x-cpa headers', async () => {
    fixture.spoofPort = 8317;
    const [module] = await modulesStatus();
    expect(module!.managementUrl).toBe('http://127.0.0.1:18081/management.html');
    await expect(moduleAction('open', 'http://127.0.0.1:8317/management.html')).rejects.toThrow('not a verified');
    expect(fixture.windows).toHaveLength(0);
  });

  it('does not open any console when the service is absent or stopped', async () => {
    fixture.active = false;
    expect((await modulesStatus())[0]).toMatchObject({ running: false, consoleAvailable: false });
    await expect(moduleAction('open', 'http://127.0.0.1:18081/management.html')).rejects.toThrow('Start the installed');
    fixture.active = true; fixture.installed = false;
    await expect(moduleAction('open', 'http://127.0.0.1:18081/management.html')).rejects.toThrow('Start the installed');
    expect(fixture.windows).toHaveLength(0);
  });

  it('opens verified service with ephemeral session and blocks redirects, cross-origin frames and requests', async () => {
    await moduleAction('open', 'http://localhost:18081/management.html');
    const [window] = fixture.windows;
    expect(window.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true });
    expect(window.options.webPreferences.partition).not.toContain('persist:');
    expect(fixture.opened).toContain('http://127.0.0.1:18081/management.html');
    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      let denied = false;
      window.webContents.handlers[event]({ url: 'https://evil.example/steal', isMainFrame: true, preventDefault() { denied = true; } });
      expect(denied, event).toBe(true);
    }
    for (const url of ['https://evil.example/frame', 'http://127.0.0.1:8317/login']) {
      let denied = false;
      window.webContents.handlers['will-frame-navigate']({ url, isMainFrame: false, preventDefault() { denied = true; } });
      expect(denied).toBe(true);
      window.requestFilter!({ url }, (reply: { cancel: boolean }) => { expect(reply.cancel).toBe(true); });
    }
    let denied = false;
    window.webContents.handlers['will-navigate']({ url: 'http://127.0.0.1:18081/another.html', isMainFrame: true, preventDefault() { denied = true; } });
    expect(denied).toBe(true);
    window.requestFilter!({ url: 'http://127.0.0.1:18081/v8/management/config' }, (reply: { cancel: boolean }) => expect(reply.cancel).toBe(false));
  });

  it('identifies the service without unauthenticated management requests (they count toward its login ban)', async () => {
    for (let index = 0; index < 6; index++) expect((await modulesStatus())[0]!.consoleAvailable).toBe(true);
    expect(fixture.unauthenticatedManagement).toBe(0);
  });

  it('opens the console without seeding when no management password is stored', async () => {
    await moduleAction('open', 'http://127.0.0.1:18081/management.html');
    const [window] = fixture.windows;
    expect(fixture.opened).toEqual(['http://127.0.0.1:18081/management.html']);
    expect(window.scripts).toEqual([]);
  });

  it('pre-signs the console in its own origin before the page loads when a password is stored', async () => {
    fixture.managementKey = 'management-secret';
    await moduleAction('open', 'http://127.0.0.1:18081/management.html');
    const [window] = fixture.windows;
    expect(fixture.opened).toEqual(['http://127.0.0.1:18081/healthz', 'http://127.0.0.1:18081/management.html']);
    expect(window.scripts).toHaveLength(1);
    const values = JSON.parse(/\}\)\((.*)\)$/.exec(window.scripts[0])![1]!);
    expect(values).toEqual({ apiBase: '"http://127.0.0.1:18081"', managementKey: '"management-secret"', isLoggedIn: 'true' });
    window.requestFilter!({ url: 'http://127.0.0.1:18081/healthz' }, (reply: { cancel: boolean }) => expect(reply.cancel).toBe(false));
  });

  it('never seeds a document that is not on the console origin', async () => {
    fixture.managementKey = 'management-secret';
    const scripts: string[] = [];
    const window = {
      loadURL: async () => undefined,
      webContents: { getURL: () => 'https://evil.example/healthz', executeJavaScript: async (code: string) => { scripts.push(code); } }
    };
    expect(await seedConsoleLogin(window as never, 'http://127.0.0.1:18081')).toBe(false);
    expect(scripts).toEqual([]);
  });

  it('rejects browsing a custom unverified port, even when the service is active', async () => {
    await expect(moduleAction('open', 'http://127.0.0.1:7070/management.html')).rejects.toThrow('not a verified');
    expect(fixture.windows).toHaveLength(0);
  });

  it('only opens the official installation guide and keeps PolicyKit for explicit service actions', async () => {
    await moduleAction('install');
    await moduleAction('update');
    expect(fixture.opened).toEqual(['https://github.com/router-for-me/CLIProxyAPI', 'https://github.com/router-for-me/CLIProxyAPI/releases']);
    await moduleAction('restart');
    expect(fixture.elevated).toEqual([['/usr/bin/systemctl', 'restart', 'cli-proxy-api.service']]);
  });
});
