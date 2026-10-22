import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, shell: { openExternal: async () => undefined }, ipcMain: { handle: () => undefined } }));

const release = await import('../src/main/ccr/release.js');
const service = await import('../src/main/ccr/service.js');
const router = await import('../src/main/agent-engine/router.js');
const npm = await import('../src/main/npm-release.js');

const PACKAGE = '@musistudio/claude-code-router';
const DOC = 'https://registry.npmjs.org/@musistudio%2fclaude-code-router';
const tarballUrl = (version: string) => `https://registry.npmjs.org/${PACKAGE}/-/claude-code-router-${version}.tgz`;
const sri = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;

/** The registry as CCR is published: `latest`, exact version documents and the tarball. */
function registry(options: { latest?: string; tarball?: Buffer; served?: Buffer; engines?: Record<string, string>; health?: () => boolean } = {}) {
  const latest = options.latest ?? '3.1.3';
  const tarball = options.tarball ?? Buffer.from('synthetic ccr tarball');
  const served = options.served ?? tarball;
  const calls: string[] = [];
  const doc = (version: string) => ({ name: PACKAGE, version, dist: { tarball: tarballUrl(version), integrity: sri(tarball) }, engines: options.engines ?? { node: '>=22' } });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/health')) {
      if (!options.health?.()) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ runtimeId: 'r', status: 'ok', timestamp: 'now' }), { status: 200 });
    }
    if (init?.redirect !== 'error') return new Response('redirects must be refused', { status: 500 });
    if (url === `${DOC}/latest`) return new Response(JSON.stringify(doc(latest)), { status: 200 });
    const exact = /\/(\d+\.\d+\.\d+)$/.exec(url);
    if (url.startsWith(`${DOC}/`) && exact) return new Response(JSON.stringify(doc(exact[1]!)), { status: 200 });
    if (url.startsWith(`https://registry.npmjs.org/${PACKAGE}/-/`)) return new Response(new Uint8Array(served), { status: 200 });
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let root: string;
let home: string;
let runs: Array<{ file: string; args: string[] }>;

/** A fake npm/node: `npm install` lays out the package in the prefix, everything else answers like the real tools. */
function fakeRun(options: { nodeVersion?: string; npmFails?: boolean; nativeFails?: boolean; installVersion?: string } = {}) {
  return async (file: string, args: string[]) => {
    runs.push({ file, args });
    if (file === '/usr/bin/node' && args[0] === '--version') return { stdout: `${options.nodeVersion ?? 'v22.23.4'}\n`, stderr: '' };
    if (file === '/usr/bin/npm' && args[0] === 'install') {
      if (options.npmFails) throw new Error('npm ERR!');
      const prefix = args.find(arg => arg.startsWith('--prefix='))!.slice('--prefix='.length);
      const packageDir = args.includes('--global') ? path.join(prefix, 'lib', 'node_modules', PACKAGE) : path.join(prefix, 'node_modules', PACKAGE);
      await writeTree(packageDir, {
        'package.json': JSON.stringify({ name: PACKAGE, version: options.installVersion ?? '3.1.3', bin: { ccr: 'dist/main/cli.js' } }),
        'dist/main/cli.js': '#!/usr/bin/env node\n'
      });
      await writeTree(path.join(prefix, 'node_modules', 'better-sqlite3'), { 'package.json': '{}' });
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/npm' && args[0] === 'rebuild') return { stdout: 'rebuilt dependencies successfully\n', stderr: '' };
    if (file === '/usr/bin/node' && args[0] === '-e') { if (options.nativeFails) throw new Error('invalid ELF header'); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
}

function useHost(extra: Partial<Parameters<typeof service.setCcrHostForTests>[0] & object> = {}, run = fakeRun()) {
  service.setCcrHostForTests({
    platform: 'linux', home: () => home, modulesRoot: async () => root, env: () => ({ PATH: '/usr/bin:/bin', HOME: home }),
    run, processList: async () => '', configAddress: async () => null,
    which: async name => name === 'node' ? '/usr/bin/node' : name === 'npm' ? '/usr/bin/npm' : null,
    openExternal: async () => undefined, now: () => Date.now(), fetchImpl: registry().fetchImpl,
    ...extra
  });
}

beforeEach(async () => {
  home = await makeTempDir('cos-ccr-home-');
  root = path.join(home, 'userData', 'modules');
  await fs.mkdir(root, { recursive: true });
  runs = [];
  npm.setRegistryRetryDelayForTests(() => 0);
});

afterEach(async () => {
  service.setCcrHostForTests(null);
  router.registerRouterAvailability(null);
  npm.setRegistryRetryDelayForTests(null);
  await removeTempDir(home);
});

describe('Claude Code Router release and version gate', () => {
  it('supports the 3.x line it was checked against and refuses another major', () => {
    expect(release.ccrSupport('3.1.3')).toBe('ok');
    expect(release.ccrSupport('3.0.9')).toBe('ok');
    expect(release.ccrSupport('3.2.0')).toBe('newer');
    expect(release.ccrSupport('4.0.0')).toBe('unsupported');
    expect(release.ccrSupport('2.9.9')).toBe('unsupported');
    expect(release.ccrSupport(null)).toBeNull();
  });

  it('reads only the registry, refuses a moved latest and checks the tarball against dist.integrity', async () => {
    const { fetchImpl, calls } = registry();
    expect(await release.ccrLatest(fetchImpl)).toBe('3.1.3');
    const meta = await release.ccrRelease('3.1.3', fetchImpl);
    expect(meta).toMatchObject({ version: '3.1.3', tarball: tarballUrl('3.1.3'), engines: { node: '>=22' } });
    expect(calls.every(url => url.startsWith('https://registry.npmjs.org/'))).toBe(true);
    await expect(release.ccrRelease('3.1.2', fetchImpl)).rejects.toThrow('version_changed');
    await expect(release.ccrRelease('not-a-version', fetchImpl)).rejects.toThrow('release_unavailable');
    const tampered = registry({ served: Buffer.from('tampered') });
    const bad = await release.ccrRelease('3.1.3', tampered.fetchImpl);
    await expect(npm.downloadNpmTarball(bad, release.CCR_TARBALL_LIMIT, tampered.fetchImpl)).rejects.toThrow('checksum_mismatch');
  });

  it('builds npm and service argv without scripts, user config or shell text', () => {
    expect(release.npmInstallArgv('/m/ccr/.stage/app', '/m/ccr/.stage/package.tgz', '/m/ccr/.stage/npmrc')).toEqual([
      'install', '--prefix=/m/ccr/.stage/app', '--ignore-scripts', '--omit=dev', '--no-save', '--registry=https://registry.npmjs.org/',
      '--userconfig=/m/ccr/.stage/npmrc', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=warn', '--', '/m/ccr/.stage/package.tgz'
    ]);
    expect(release.npmInstallArgv('/home/u/.local', '/t.tgz', '/rc', true).slice(0, 3)).toEqual(['install', '--global', '--prefix=/home/u/.local']);
    // Only the allowlisted native package runs its install script.
    expect(release.npmRebuildArgv('/m/app', '/rc').slice(-2)).toEqual(['--', 'better-sqlite3']);
    expect(release.ccrServiceArgv('start')).toEqual(['start', '--daemon', '--no-open']);
    expect(release.ccrServiceArgv('stop')).toEqual(['stop']);
    expect(release.minimumNodeMajor('>=22')).toBe(22);
    expect(release.minimumNodeMajor('^20.19.0 || >=22.12.0')).toBe(20);
    expect(release.minimumNodeMajor(undefined)).toBe(22);
    expect(release.nodeMajor('v22.23.4\n')).toBe(22);
    expect(release.nodeMajor('garbage')).toBeNull();
  });
});

describe('Claude Code Router install and update (module folder)', () => {
  it('installs the verified tarball into a new version folder and points the module at it', async () => {
    useHost();
    const progress: string[] = [];
    const status = await service.ccrInstall('install', '3.1.3', next => progress.push(next.phase));
    expect(progress).toEqual(['downloading', 'verifying', 'installing', 'checking', 'done']);
    const npmCalls = runs.filter(call => call.file === '/usr/bin/npm');
    expect(npmCalls.map(call => call.args[0])).toEqual(['install', 'rebuild']);
    expect(npmCalls[0]!.args).toEqual(expect.arrayContaining(['--ignore-scripts', '--registry=https://registry.npmjs.org/', '--omit=dev']));
    expect(npmCalls[0]!.args.at(-1)).toMatch(/\/ccr\/\.stage-[0-9a-f-]+\/package\.tgz$/);
    // The native binding had to load before the copy was used.
    expect(runs.some(call => call.file === '/usr/bin/node' && call.args[0] === '-e')).toBe(true);
    const current = readFileSync(path.join(root, 'ccr', 'current'), 'utf8');
    expect(current).toMatch(/^v3\.1\.3-[0-9a-f]{8}\n$/);
    const cli = path.join(root, 'ccr', 'versions', current.trim(), 'node_modules', PACKAGE, 'dist', 'main', 'cli.js');
    expect(existsSync(cli)).toBe(true);
    expect(readFileSync(path.join(root, 'ccr', 'bin', 'ccr'), 'utf8')).toContain(`exec '/usr/bin/node' '${cli}' "$@"`);
    expect((await fs.readdir(path.join(root, 'ccr'))).filter(name => name.startsWith('.stage-'))).toEqual([]);
    expect(status).toMatchObject({ inUse: 'managed', managed: { kind: 'managed', version: '3.1.3', path: '~/userData/modules/ccr/bin/ccr' }, updateAvailable: false });
  });

  it('refuses a tampered download, a moved latest, an unsupported major and a too old Node.js before npm runs', async () => {
    useHost({ fetchImpl: registry({ served: Buffer.from('tampered') }).fetchImpl });
    await expect(service.ccrInstall('install', '3.1.3')).rejects.toThrow('checksum_mismatch');
    useHost({ fetchImpl: registry({ latest: '3.1.4' }).fetchImpl });
    await expect(service.ccrInstall('install', '3.1.3')).rejects.toThrow('version_changed');
    useHost({ fetchImpl: registry({ latest: '4.0.0' }).fetchImpl });
    await expect(service.ccrInstall('install', '4.0.0')).rejects.toThrow('unsupported_version');
    useHost({}, fakeRun({ nodeVersion: 'v20.11.0' }));
    await expect(service.ccrInstall('install', '3.1.3')).rejects.toThrow('node_too_old');
    expect(runs.filter(call => call.file === '/usr/bin/npm')).toEqual([]);
    expect(existsSync(path.join(root, 'ccr', 'current'))).toBe(false);
  });

  it('keeps the old copy when npm, the version check or the native binding fails', async () => {
    useHost({}, fakeRun({ npmFails: true }));
    await expect(service.ccrInstall('install', '3.1.3')).rejects.toThrow('npm_failed');
    useHost({}, fakeRun({ installVersion: '3.1.2' }));
    await expect(service.ccrInstall('install', '3.1.3')).rejects.toThrow('version_mismatch');
    useHost({}, fakeRun({ nativeFails: true }));
    await expect(service.ccrInstall('install', '3.1.3')).rejects.toThrow('native_failed');
    expect(existsSync(path.join(root, 'ccr', 'current'))).toBe(false);
    expect((await fs.readdir(path.join(root, 'ccr'))).filter(name => name.startsWith('.stage-'))).toEqual([]);
  });

  it('shows a copy the user installed, updates it in place only when its prefix is writable', async () => {
    const prefix = path.join(home, '.local');
    const packageDir = path.join(prefix, 'lib', 'node_modules', PACKAGE);
    await writeTree(packageDir, { 'package.json': JSON.stringify({ name: PACKAGE, version: '3.1.2', bin: { ccr: 'dist/main/cli.js' } }), 'dist/main/cli.js': '' });
    await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
    await fs.symlink(path.join(packageDir, 'dist', 'main', 'cli.js'), path.join(prefix, 'bin', 'ccr'));
    useHost({ which: async name => name === 'ccr' ? path.join(prefix, 'bin', 'ccr') : name === 'node' ? '/usr/bin/node' : name === 'npm' ? '/usr/bin/npm' : null });
    const status = await service.ccrStatus();
    expect(status).toMatchObject({
      managed: null, inUse: 'external', latest: '3.1.3', updateAvailable: true,
      external: { kind: 'external', version: '3.1.2', path: `~/.local/lib/node_modules/${PACKAGE}/dist/main/cli.js`, writable: true }
    });
    await service.ccrInstall('update-external', '3.1.3');
    const npmCalls = runs.filter(call => call.file === '/usr/bin/npm');
    expect(npmCalls[0]!.args.slice(0, 3)).toEqual(['install', '--global', `--prefix=${prefix}`]);
    // A global package keeps its own node_modules: the rebuild runs there.
    expect(npmCalls[1]!.args).toContain(`--prefix=${packageDir}`);
    expect(existsSync(path.join(root, 'ccr', 'current'))).toBe(false);
    await fs.chmod(path.dirname(packageDir), 0o500);
    try {
      if (process.getuid?.() !== 0) await expect(service.ccrInstall('update-external', '3.1.3')).rejects.toThrow('external_not_writable');
    } finally { await fs.chmod(path.dirname(packageDir), 0o700); }
  });
});

describe('Claude Code Router status', () => {
  it('parses the daemon from the process list and its gateway health', async () => {
    const listing = [
      ' 311913 /usr/bin/node /home/u/.local/lib/node_modules/@musistudio/claude-code-router/dist/main/cli.js serve --daemon-child --no-open',
      ' 349591 /usr/bin/node /home/u/.local/lib/node_modules/@musistudio/claude-code-router/dist/main/gateway-bootstrap.js',
      ' 400000 /usr/bin/node /home/u/.local/lib/node_modules/@musistudio/claude-code-router/dist/main/cli.js start --daemon --no-open',
      ' 12 bash -c echo claude-code-router/dist/main/cli.js serve --daemon-child'
    ].join('\n');
    expect(service.parseDaemonProcesses(listing)).toEqual([{ pid: 311913, cli: '/home/u/.local/lib/node_modules/@musistudio/claude-code-router/dist/main/cli.js' }]);
    const ok = (async () => new Response(JSON.stringify({ runtimeId: 'x', status: 'ok' }), { status: 200 })) as unknown as typeof fetch;
    const html = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    const missing = (async () => new Response('Not found', { status: 404 })) as unknown as typeof fetch;
    const refused = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const address = { host: '127.0.0.1', port: 3456 };
    expect(await service.probeHealth(address, ok)).toBe(true);
    for (const answer of [html, missing, refused]) expect(await service.probeHealth(address, answer)).toBe(false);
  });

  it('reads only the gateway address of CCR\'s config store, read-only', async () => {
    expect(service.ccrAddressFromConfig({ gateway: { host: '0.0.0.0', port: 4567 }, PORT: 3456 })).toEqual({ host: '127.0.0.1', port: 4567 });
    expect(service.ccrAddressFromConfig({ HOST: '127.0.0.1', PORT: 3999 })).toEqual({ host: '127.0.0.1', port: 3999 });
    expect(service.ccrAddressFromConfig({ gateway: { port: 70000 } })).toBeNull();
    expect(service.ccrAddressFromConfig(null)).toBeNull();
    const { DatabaseSync } = await import('node:sqlite');
    await fs.mkdir(path.join(home, '.claude-code-router'));
    const file = path.join(home, '.claude-code-router', 'config.sqlite');
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE app_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE api_keys (id TEXT, encrypted_key TEXT)");
    db.prepare('INSERT INTO app_config VALUES (?, ?, ?)').run('default', JSON.stringify({ APIKEY: 'sk-synthetic-secret', gateway: { host: '127.0.0.1', port: 3466 }, Providers: [{ api_key: 'sk-synthetic' }] }), 'now');
    db.prepare('INSERT INTO api_keys VALUES (?, ?)').run('1', 'sk-synthetic');
    db.close();
    const before = readFileSync(file);
    expect(await service.readCcrConfigAddress(home)).toEqual({ host: '127.0.0.1', port: 3466 });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(await service.readCcrConfigAddress(path.join(home, 'nobody'))).toBeNull();
  });

  it('opens only a loopback web UI of a live daemon, and never hands its address to the renderer', async () => {
    let opened: string | null = null;
    useHost({ openExternal: async url => { opened = url; } });
    await expect(service.ccrOpenUi()).rejects.toThrow('ui_unavailable');
    await writeTree(home, { '.claude-code-router/service.json': JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:3458/?ccr_web_token=synthetic', serviceToken: 'synthetic' }) });
    await service.ccrOpenUi();
    expect(opened).toBe('http://127.0.0.1:3458/?ccr_web_token=synthetic');
    const status = await service.ccrStatus();
    expect(status.service.ui).toBe(true);
    expect(JSON.stringify(status)).not.toContain('synthetic');
    await writeTree(home, { '.claude-code-router/service.json': JSON.stringify({ pid: process.pid, url: 'http://example.com:3458/?ccr_web_token=synthetic' }) });
    expect(await service.webUiUrl()).toBeNull();
    await writeTree(home, { '.claude-code-router/service.json': JSON.stringify({ pid: 2 ** 22 + 12345, url: 'http://127.0.0.1:3458/' }) });
    expect(await service.webUiUrl()).toBeNull();
  });

  it('starts and stops through the CLI of the copy in use and waits for the gateway', async () => {
    let healthy = false;
    const run = fakeRun();
    useHost({ fetchImpl: registry({ health: () => healthy }).fetchImpl }, async (file, args) => {
      if (args[1] === 'start') healthy = true;
      if (args[1] === 'stop') healthy = false;
      return run(file, args);
    });
    await expect(service.ccrService('start')).rejects.toThrow('not_installed');
    await service.ccrInstall('install', '3.1.3');
    const cli = path.join(root, 'ccr', 'versions', readFileSync(path.join(root, 'ccr', 'current'), 'utf8').trim(), 'node_modules', PACKAGE, 'dist', 'main', 'cli.js');
    expect((await service.ccrService('start')).service).toMatchObject({ state: 'running', host: '127.0.0.1', port: 3456 });
    const cliCalls = runs.filter(call => call.args[0] === cli).map(call => call.args.slice(1));
    expect(cliCalls).toEqual([['start', '--daemon', '--no-open']]);
    // The daemon's own environment: no Electron variables, Node.js first on PATH.
    expect(service.ccrEnvironment({ PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1', npm_config_registry: 'x', HOME: '/h' }, '/opt/node/bin/node'))
      .toEqual({ PATH: '/opt/node/bin:/usr/bin:/bin', HOME: '/h', NO_COLOR: '1' });
    expect((await service.ccrService('stop')).service.state).toBe('stopped');
    expect(runs.filter(call => call.args[0] === cli).map(call => call.args.slice(1)).at(-1)).toEqual(['stop']);
  });

  it('restarts after an update only when no routed turn runs', async () => {
    let healthy = true;
    const run = fakeRun();
    useHost({ fetchImpl: registry({ health: () => healthy }).fetchImpl }, async (file, args) => {
      if (args[1] === 'start') healthy = true;
      if (args[1] === 'stop') healthy = false;
      return run(file, args);
    });
    let busy = true;
    const unregister = router.registerRoutedTurnProbe(() => busy);
    try {
      const status = await service.ccrInstall('install', '3.1.3');
      expect(status.service).toMatchObject({ state: 'running', restartPending: true, routedTurns: true });
      expect(runs.some(call => call.args[1] === 'stop' || call.args[1] === 'start')).toBe(false);
      busy = false;
      await service.requestCcrRestart();
      expect(runs.filter(call => call.args[1] === 'stop' || call.args[1] === 'start').map(call => call.args[1])).toEqual(['stop', 'start']);
      expect(service.ccrRestartPending()).toBe(false);
    } finally { unregister(); }
  });
});

describe('Claude Code Router and the chat routes', () => {
  const CCR_SETTINGS = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456', ANTHROPIC_MODEL: 'Local/router-model' } });

  it('a fresh machine without CCR: nothing is detected and both routes are the CLI as it is', async () => {
    useHost();
    service.bindCcrRouting();
    expect(await service.refreshCcrAvailability(true)).toBe('not_installed');
    const env = { home, env: {}, platform: 'linux' as const };
    const detection = router.detectClaudeRouter(env);
    expect(detection).toEqual({ detected: false, model: null });
    expect(router.chatRoutes('router', detection)).toEqual({ routes: [] });
    expect(router.effectiveRoute('router', detection)).toBe('direct');
    expect(router.claudeRouteSettings('router', detection)).toBe(router.CLAUDE_FLAG_SETTINGS);
    const status = await service.ccrStatus();
    expect(status).toMatchObject({ managed: null, external: null, inUse: null, configured: { claude: false, codex: false }, service: { state: 'stopped' } });
  });

  it('a configured router that is missing or stopped falls back to direct with the reason; one that answers is offered', async () => {
    await writeTree(home, { '.claude/settings.json': CCR_SETTINGS });
    let healthy = false;
    useHost({ fetchImpl: registry({ health: () => healthy }).fetchImpl });
    service.bindCcrRouting();
    const env = { home, env: {}, platform: 'linux' as const };
    await router.refreshRouterAvailability();
    let detection = router.detectClaudeRouter(env);
    expect(detection).toEqual({ detected: true, model: 'Local/router-model', unavailable: 'not_installed' });
    expect(router.routerUsable(detection)).toBe(false);
    expect(router.chatRoutes('router', detection)).toEqual({ routes: ['direct'], routeNotice: 'not_installed' });
    expect(router.chatRoutes('direct', detection)).toEqual({ routes: [] });
    expect(router.effectiveRoute('router', detection)).toBe('direct');
    // The CLI must not try the dead router address: the direct overrides apply to both routes.
    expect(router.claudeRouteSettings('router', detection)).toBe(router.CLAUDE_DIRECT_SETTINGS);
    const codex = { detected: true, provider: 'claude-code-router', directOverrides: ['model_provider="openai"'], unavailable: 'stopped' as const };
    expect(router.codexRouteOverrides('router', codex)).toEqual(['model_provider="openai"']);

    await service.ccrInstall('install', '3.1.3');
    expect(await service.refreshCcrAvailability(true)).toBe('stopped');
    expect(router.detectClaudeRouter(env).unavailable).toBe('stopped');
    healthy = true;
    expect(await service.refreshCcrAvailability(true)).toBeNull();
    detection = router.detectClaudeRouter(env);
    expect(detection).toEqual({ detected: true, model: 'Local/router-model' });
    expect(router.chatRoutes('direct', detection)).toEqual({ routes: ['direct', 'router'] });
    expect(router.claudeRouteSettings('router', detection)).toBe(router.CLAUDE_FLAG_SETTINGS);
    expect((await service.ccrStatus()).configured).toEqual({ claude: true, codex: false });
  });

  it('finds the gateway port in the CLI files when CCR\'s store cannot be read', async () => {
    await writeTree(home, { '.codex/config.toml': '[model_providers.claude-code-router]\nname = "Claude Code Router"\nbase_url = "http://127.0.0.1:3999/v1"\n' });
    useHost();
    expect(await service.gatewayAddress()).toEqual({ host: '127.0.0.1', port: 3999 });
    await writeTree(home, { '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:3777' } }) });
    expect(await service.gatewayAddress()).toEqual({ host: 'localhost', port: 3777 });
    useHost({ configAddress: async () => ({ host: '127.0.0.1', port: 4100 }) });
    expect(await service.gatewayAddress()).toEqual({ host: '127.0.0.1', port: 4100 });
  });
});
