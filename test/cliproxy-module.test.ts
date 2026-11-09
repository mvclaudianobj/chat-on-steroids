import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  chatKey: null as string | null,
  execCalls: [] as Array<{ file: string; args: string[] }>,
  versionOutput: 'CLIProxyAPI Version: v8.0.13-14-g8ef43e4d-dirty, Commit: 8ef43e4d, BuiltAt: 2026-10-07T20:14:49Z\nUsage of cli-proxy-api\n',
  example: null as string | null,
  elf: true,
  show: 'ReadWritePaths=/var/lib/cli-proxy-api\nProtectSystem=strict\n'
}));

vi.mock('node:child_process', async () => {
  const { promisify: custom } = await import('node:util');
  const { writeFile } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const run = async (file: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    state.execCalls.push({ file, args });
    if (file === '/usr/bin/tar') {
      const root = args[args.indexOf('-C') + 1]!, member = args[args.length - 1]!;
      if (member === 'cli-proxy-api') await writeFile(joinPath(root, member), state.elf ? Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2]) : 'not a program');
      else if (member === 'config.example.yaml' && state.example !== null) await writeFile(joinPath(root, member), state.example);
      else throw Object.assign(new Error('Not found in archive'), { code: 2 });
      return { stdout: '', stderr: '' };
    }
    if (file.endsWith('/cli-proxy-api')) return { stdout: state.versionOutput, stderr: '' };
    if (file === '/usr/bin/systemctl' && args[0] === 'show') return { stdout: state.show, stderr: '' };
    throw new Error(`unexpected command ${file}`);
  };
  const execFile = Object.assign(() => { throw new Error('callback execFile is not used'); }, { [custom.custom]: run });
  return { execFile };
});
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => state.secrets.get(key) ?? null,
  setSecret: async (key: string, value: string) => { if (value) state.secrets.set(key, value); else state.secrets.delete(key); }
}));
vi.mock('../src/main/api-chat/settings.js', () => ({
  apiChatKey: async () => state.chatKey,
  setApiChatKey: async (value: string) => { state.chatKey = value || null; }
}));

const release = await import('../src/main/cliproxy/release.js');
const installer = await import('../src/main/cliproxy/installer.js');
const management = await import('../src/main/cliproxy/management.js');

const VERSION = '8.0.36';
const DL = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${VERSION}/`;
const assetNames = [
  'checksums.txt', `CLIProxyAPI_${VERSION}_darwin_aarch64.tar.gz`, `CLIProxyAPI_${VERSION}_linux_aarch64.tar.gz`,
  `CLIProxyAPI_${VERSION}_linux_aarch64_no-plugin.tar.gz`, `CLIProxyAPI_${VERSION}_linux_amd64_no-plugin.tar.gz`,
  `CLIProxyAPI_${VERSION}_linux_amd64.tar.gz`, `CLIProxyAPI_${VERSION}_windows_amd64.zip`
];
const releaseBody = () => ({ tag_name: `v${VERSION}`, draft: false, prerelease: false,
  assets: assetNames.map(name => ({ name, size: 10, browser_download_url: `${DL}${name}` })) });
const archive = Buffer.from('synthetic release archive');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

interface Net { checksum: string; redirect: string | null; calls: string[]; releaseCalls: number }
let net: Net;
function fakeFetch(): typeof fetch {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    net.calls.push(url);
    if (url === 'https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest') {
      net.releaseCalls++;
      return new Response(JSON.stringify(releaseBody()), { status: 200 });
    }
    if (url.startsWith(DL)) {
      return new Response(null, { status: 302, headers: { location: net.redirect ?? `https://release-assets.githubusercontent.com/${url.slice(DL.length)}` } });
    }
    if (url.startsWith('https://release-assets.githubusercontent.com/')) {
      const name = url.split('/').pop()!;
      return new Response(name === 'checksums.txt' ? net.checksum : archive, { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  state.secrets.clear();
  state.chatKey = null;
  state.execCalls.length = 0;
  state.example = null;
  state.elf = true;
  net = { checksum: `${sha(archive)}  CLIProxyAPI_${VERSION}_linux_amd64.tar.gz\n${'0'.repeat(64)}  checksums-other\n`, redirect: null, calls: [], releaseCalls: 0 };
  release.resetReleaseCacheForTests();
  management.resetManagementForTests();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
});
afterEach(() => { vi.restoreAllMocks(); });

describe('CLIProxyAPI versions', () => {
  it('parses the version line of local and official builds', () => {
    expect(release.parseVersionOutput(state.versionOutput)).toBe('8.0.13-14-g8ef43e4d-dirty');
    expect(release.parseVersionOutput('CLIProxyAPI Version: 8.0.36, Commit: abc, BuiltAt: x')).toBe('8.0.36');
    expect(release.parseVersionOutput('something else')).toBeNull();
    expect(release.isOfficialVersion('8.0.36')).toBe(true);
    expect(release.isOfficialVersion('8.0.13-14-g8ef43e4d-dirty')).toBe(false);
    expect(release.isOfficialVersion(null)).toBe(false);
  });

  it('marks an update only when the latest release is newer than the installed base version', () => {
    expect(release.isUpdateAvailable('8.0.13-14-g8ef43e4d-dirty', '8.0.36')).toBe(true);
    expect(release.isUpdateAvailable('8.0.36', '8.0.36')).toBe(false);
    expect(release.isUpdateAvailable('8.1.0', '8.0.36')).toBe(false);
    expect(release.isUpdateAvailable('7.9.99', '8.0.0')).toBe(true);
    expect(release.isUpdateAvailable(null, '8.0.36')).toBe(false);
    expect(release.isUpdateAvailable('8.0.1', null)).toBe(false);
  });

  // The installed binary, its staging paths and pkexec exist only on Linux (ipc.ts gates them).
  it.skipIf(process.platform !== 'linux')('reads the installed version by running the binary with -h and an absent config, once per binary change', async () => {
    const binary = join(mkdtempSync(join(tmpdir(), 'cliproxy-version-test-')), 'cli-proxy-api');
    writeFileSync(binary, 'old build');
    expect(await release.installedVersion(binary)).toBe('8.0.13-14-g8ef43e4d-dirty');
    expect(state.execCalls).toEqual([{ file: binary, args: ['-config', '/nonexistent/marks-version-probe.yaml', '-h'] }]);
    expect(await release.installedVersion(binary)).toBe('8.0.13-14-g8ef43e4d-dirty');
    expect(state.execCalls).toHaveLength(1); // cached by path, mtime and size
    writeFileSync(binary, 'new official build');
    utimesSync(binary, new Date(), new Date(Date.now() + 5_000));
    state.versionOutput = 'CLIProxyAPI Version: 8.0.36, Commit: abc, BuiltAt: x\n';
    expect(await release.installedVersion(binary)).toBe('8.0.36');
    expect(state.execCalls).toHaveLength(2);
    expect(await release.installedVersion(join(tmpdir(), 'absent-dir-cliproxy', 'cli-proxy-api'))).toBeNull();
    expect(state.execCalls).toHaveLength(2);
  });

  it('caches the latest release for an hour', async () => {
    const fetchImpl = fakeFetch();
    expect((await release.latestRelease({ fetchImpl, now: 0 })).version).toBe(VERSION);
    await release.latestRelease({ fetchImpl, now: 59 * 60_000 });
    expect(net.releaseCalls).toBe(1);
    await release.latestRelease({ fetchImpl, now: 61 * 60_000 });
    expect(net.releaseCalls).toBe(2);
  });

  it('refuses drafts, prereleases and tags that are not x.y.z', async () => {
    for (const body of [{ ...releaseBody(), draft: true }, { ...releaseBody(), prerelease: true }, { ...releaseBody(), tag_name: 'nightly' }]) {
      release.resetReleaseCacheForTests();
      await expect(release.latestRelease({ fetchImpl: (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch })).rejects.toThrow('release_unavailable');
    }
  });

  it('selects the default Linux build per architecture, never the no-plugin one', async () => {
    const latest = await release.latestRelease({ fetchImpl: fakeFetch() });
    expect(release.releaseAssets(latest, 'linux', 'x64')?.archive.name).toBe(`CLIProxyAPI_${VERSION}_linux_amd64.tar.gz`);
    expect(release.releaseAssets(latest, 'linux', 'arm64')?.archive.name).toBe(`CLIProxyAPI_${VERSION}_linux_aarch64.tar.gz`);
    expect(release.releaseAssets(latest, 'linux', 'x64')?.checksums.name).toBe('checksums.txt');
    expect(release.releaseAssets(latest, 'darwin', 'arm64')).toBeNull();
    expect(release.releaseAssets(latest, 'win32', 'x64')).toBeNull();
    expect(release.releaseAssets(latest, 'linux', 'ia32')).toBeNull();
    // An asset URL outside the repository's own release path is not used.
    const moved = { ...latest, assets: latest.assets.map(asset => ({ ...asset, url: asset.url.replace('router-for-me', 'someone-else') })) };
    expect(release.releaseAssets(moved, 'linux', 'x64')).toBeNull();
  });
});

describe('CLIProxyAPI downloads', () => {
  it('allows only https GitHub release hosts', () => {
    for (const ok of [`${DL}checksums.txt`, 'https://objects.githubusercontent.com/x', 'https://release-assets.githubusercontent.com/y']) {
      expect(release.allowedDownloadUrl(ok), ok).toBe(true);
    }
    for (const bad of ['http://github.com/x', 'https://evil.example/x', 'https://github.com.evil.example/x', 'https://user:pw@github.com/x',
      'https://github.com:8443/x', 'file:///etc/passwd']) {
      expect(release.allowedDownloadUrl(bad), bad).toBe(false);
    }
  });

  it('follows a redirect to a release host and refuses one to any other host', async () => {
    const fetchImpl = fakeFetch();
    expect((await release.downloadAsset(`${DL}checksums.txt`, 1024, fetchImpl)).toString()).toBe(net.checksum);
    net.redirect = 'https://evil.example/payload';
    await expect(release.downloadAsset(`${DL}checksums.txt`, 1024, fetchImpl)).rejects.toThrow('download_failed');
    expect(net.calls).not.toContain('https://evil.example/payload');
    await expect(release.downloadAsset('https://github.com/other/repo/releases/download/v1/x', 1024, fetchImpl)).rejects.toThrow('download_failed');
  });

  it('bounds the body size', async () => {
    const big = (async () => new Response('x'.repeat(2048))) as unknown as typeof fetch;
    await expect(release.downloadAsset(`${DL}checksums.txt`, 1024, big)).rejects.toThrow('download_failed');
  });

  it('verifies the archive against checksums.txt and refuses a mismatch or a missing entry', () => {
    expect(() => release.verifyChecksum(archive, `CLIProxyAPI_${VERSION}_linux_amd64.tar.gz`, net.checksum)).not.toThrow();
    expect(() => release.verifyChecksum(Buffer.from('tampered'), `CLIProxyAPI_${VERSION}_linux_amd64.tar.gz`, net.checksum)).toThrow('checksum_mismatch');
    expect(() => release.verifyChecksum(archive, 'other.tar.gz', net.checksum)).toThrow('checksum_mismatch');
  });
});

describe.skipIf(process.platform !== 'linux')('CLIProxyAPI installer', () => {
  it('updates with one fixed pkexec command whose only argument is the verified staged binary', async () => {
    const privileged: Array<[string, string[]]> = [];
    const phases: string[] = [];
    let staged = '';
    const result = await installer.installRelease('update', VERSION, {
      fetchImpl: fakeFetch(),
      onProgress: progress => phases.push(progress.phase),
      runPrivileged: async (file, args) => { privileged.push([file, args]); staged = args[4]!; expect(existsSync(staged)).toBe(true); return { stdout: '' }; }
    });
    expect(result.phase).toBe('done');
    expect(phases).toEqual(['downloading', 'verifying', 'extracting', 'installing', 'done']);
    expect(privileged).toHaveLength(1);
    expect(privileged[0]![0]).toBe('/usr/bin/pkexec');
    expect(privileged[0]![1].slice(0, 4)).toEqual(['/bin/sh', '-c', installer.UPDATE_SCRIPT, 'marks-cliproxy-update']);
    expect(privileged[0]![1]).toHaveLength(5);
    expect(staged).toMatch(/\/marks-cliproxy-[A-Za-z0-9]+\/cli-proxy-api$/);
    expect(installer.UPDATE_SCRIPT).not.toMatch(/\$\{|`/);
    const tar = state.execCalls.find(call => call.file === '/usr/bin/tar')!;
    expect(tar.args.slice(-2)).toEqual(['--', 'cli-proxy-api']);
    expect(tar.args).toContain('--no-same-owner');
    expect(existsSync(staged)).toBe(false); // the staging directory is removed
  });

  it('never elevates when the checksum does not match', async () => {
    net.checksum = `${'1'.repeat(64)}  CLIProxyAPI_${VERSION}_linux_amd64.tar.gz\n`;
    const runPrivileged = vi.fn();
    await expect(installer.installRelease('update', VERSION, { fetchImpl: fakeFetch(), runPrivileged })).rejects.toThrow('checksum_mismatch');
    expect(runPrivileged).not.toHaveBeenCalled();
    expect(state.execCalls.some(call => call.file === '/usr/bin/tar')).toBe(false);
  });

  it('never elevates when the extracted file is not a program, or the release changed after confirmation', async () => {
    const runPrivileged = vi.fn();
    state.elf = false;
    await expect(installer.installRelease('update', VERSION, { fetchImpl: fakeFetch(), runPrivileged })).rejects.toThrow('extract_failed');
    await expect(installer.installRelease('update', '8.0.35', { fetchImpl: fakeFetch(), runPrivileged })).rejects.toThrow('version_changed');
    expect(runPrivileged).not.toHaveBeenCalled();
  });

  it('refuses unsupported platforms before downloading', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const runPrivileged = vi.fn();
    await expect(installer.installRelease('update', VERSION, { fetchImpl: fakeFetch(), runPrivileged })).rejects.toThrow('unsupported_platform');
    expect(net.calls.some(url => url.startsWith(DL))).toBe(false);
  });

  it('validates every pkexec argument as a file in its own staging directory', () => {
    const root = join(tmpdir(), 'marks-cliproxy-abc123');
    expect(installer.updateCommand(root, join(root, 'cli-proxy-api'))[1][4]).toBe(join(root, 'cli-proxy-api'));
    for (const [base, file] of [
      [root, '/usr/local/bin/cli-proxy-api'], [root, join(root, 'other')], ['/home/user', '/home/user/cli-proxy-api'],
      [root, join(root, 'cli-proxy-api; rm -rf /')], [`${root}/../x`, `${root}/../x/cli-proxy-api`]
    ] as const) {
      expect(() => installer.updateCommand(base, file), file).toThrow('install_failed');
    }
    expect(() => installer.installCommand(root, join(root, 'cli-proxy-api'), join(root, 'cli-proxy-api.service'), '/etc/shadow')).toThrow('install_failed');
  });

  it('fresh install writes unit and config, and keeps the generated secrets only when its config was written', async () => {
    state.example = EXAMPLE;
    let config = '', unit = '';
    const saved: string[][] = [];
    await installer.installRelease('install', VERSION, {
      fetchImpl: fakeFetch(),
      runPrivileged: async (file, args) => {
        expect(file).toBe('/usr/bin/pkexec');
        expect(args.slice(0, 4)).toEqual(['/bin/sh', '-c', installer.INSTALL_SCRIPT, 'marks-cliproxy-install']);
        unit = readFileSync(args[5]!, 'utf8');
        config = readFileSync(args[6]!, 'utf8');
        return { stdout: 'config-written\n' };
      },
      saveSecrets: async (managementKey, apiKey) => { saved.push([managementKey, apiKey]); }
    });
    expect(unit).toBe(installer.UNIT_FILE);
    expect(saved).toHaveLength(1);
    const [managementKey, apiKey] = saved[0]!;
    expect(apiKey).toMatch(/^sk-marks-[A-Za-z0-9_-]{43}$/);
    expect(config).toContain('  host: "127.0.0.1"\n');
    expect(config).toContain('  port: 18081\n');
    expect(config).toContain(`  secret-key: "${managementKey}"`);
    expect(config).toContain(`  api-keys:\n    - "${apiKey}"\n\n`);
    expect(config).not.toContain('your-api-key');
    expect(config).toContain('  auth-dir: "/var/lib/cli-proxy-api/auths"');
    expect(config).toContain('# Comments from the example stay.');

    saved.length = 0;
    await installer.installRelease('install', VERSION, { fetchImpl: fakeFetch(), runPrivileged: async () => ({ stdout: '' }), saveSecrets: async (a, b) => { saved.push([a, b]); } });
    expect(saved).toEqual([]); // an existing config was kept, so its secrets are unknown
  });

  it('falls back to a minimal config when the example is missing or its layout changed', () => {
    const minimal = installer.configFromExample(null, 'A'.repeat(32), `sk-marks-${'b'.repeat(43)}`);
    expect(minimal).toContain('port: 18081');
    expect(installer.configFromExample('server:\n  port: 1\n', 'A'.repeat(32), `sk-marks-${'b'.repeat(43)}`)).toBe(minimal);
    expect(() => installer.minimalConfig('bad"key', `sk-marks-${'b'.repeat(43)}`)).toThrow();
  });

  it('reports a dismissed authorization dialog as cancelled', async () => {
    await expect(installer.installRelease('update', VERSION, {
      fetchImpl: fakeFetch(), runPrivileged: async () => { throw Object.assign(new Error('dismissed'), { code: 126 }); }
    })).rejects.toThrow('install_cancelled');
  });
});

describe('CLIProxyAPI config save repair', () => {
  it('detects a sandbox that keeps the config directory read-only', () => {
    expect(installer.configDirectoryReadOnly('ReadWritePaths=/var/lib/cli-proxy-api\nProtectSystem=strict\n')).toBe(true);
    expect(installer.configDirectoryReadOnly('ProtectSystem=full\nReadWritePaths=\n')).toBe(true);
    expect(installer.configDirectoryReadOnly('ProtectSystem=strict\nReadWritePaths=/var/lib/cli-proxy-api /etc/cli-proxy-api\n')).toBe(false);
    expect(installer.configDirectoryReadOnly('ProtectSystem=strict\nReadWritePaths=-/etc/cli-proxy-api/\n')).toBe(false);
    expect(installer.configDirectoryReadOnly('ProtectSystem=strict\nReadWritePaths=/etc\n')).toBe(false);
    expect(installer.configDirectoryReadOnly('ProtectSystem=strict\nReadWritePaths=/etc/cli-proxy-api-other\n')).toBe(true);
    expect(installer.configDirectoryReadOnly('ProtectSystem=no\nReadWritePaths=\n')).toBe(false);
    expect(installer.configDirectoryReadOnly('ProtectSystem=yes\nReadWritePaths=\n')).toBe(false);
  });

  it('asks systemd read-only with fixed arguments', async () => {
    expect(await installer.serviceConfigReadOnly()).toBe(true);
    expect(state.execCalls).toEqual([{ file: '/usr/bin/systemctl', args: ['show', '-p', 'ProtectSystem', '-p', 'ReadWritePaths', 'cli-proxy-api.service'] }]);
  });

  it('repairs with one fixed pkexec command that writes only a drop-in, never the unit', async () => {
    const privileged: Array<[string, string[]]> = [];
    await installer.repairConfigWrites(async (file, args) => { privileged.push([file, args]); return { stdout: '' }; });
    expect(privileged).toEqual([['/usr/bin/pkexec', ['/bin/sh', '-c', installer.REPAIR_SCRIPT, 'marks-cliproxy-repair']]]);
    const script = installer.REPAIR_SCRIPT;
    expect(script).toContain("printf '[Service]\\nReadWritePaths=/etc/cli-proxy-api\\n' > /etc/systemd/system/cli-proxy-api.service.d/marks-writable-config.conf");
    expect(script).toContain('/usr/bin/chown cli-proxy-api: /etc/cli-proxy-api /etc/cli-proxy-api/config.yaml');
    expect(script).toContain('/usr/bin/systemctl daemon-reload');
    expect(script).toContain('if /usr/bin/systemctl is-active --quiet cli-proxy-api.service; then /usr/bin/systemctl restart cli-proxy-api.service; fi');
    expect(script).not.toMatch(/chmod|\$\d|\$\{|`/);
    expect(script).not.toMatch(/> \/etc\/systemd\/system\/cli-proxy-api\.service(\s|$)/);
    await expect(installer.repairConfigWrites(async () => { throw Object.assign(new Error('dismissed'), { code: 126 }); })).rejects.toThrow('install_cancelled');
  });
});

const EXAMPLE = `config-version: 8

server:
  # Server host/interface to bind to.
  host: ""

  # Server port
  port: 8317
  tls:
    enable: false

management:
  allow-remote: false
  # Comments from the example stay.
  secret-key: ""
  disable-control-panel: false

access:
  # API keys for authentication
  api-keys:
    - "your-api-key-1"
    - "your-api-key-2"

  # allow-anonymous-model-listing: true

oauth:
  auth-dir: "~/.cli-proxy-api"
`;

describe('CLIProxyAPI management API', () => {
  const BASE = 'http://127.0.0.1:18081';
  interface Call { method: string; url: string; auth: string | null; body: unknown }
  let calls: Call[];
  let keys: string[];
  let password: string;
  const api = (): typeof fetch => (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const auth = new Headers(init.headers).get('authorization');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? 'GET', url: `${url.pathname}${url.search}`, auth, body });
    if (auth !== `Bearer ${password}`) return new Response(JSON.stringify({ error: 'invalid management key' }), { status: 401 });
    if (url.pathname === '/v0/management/config') return new Response('{}', { status: 200 });
    if (url.pathname === '/v0/management/api-keys') {
      if (init.method === 'PATCH') { const patch = body as { old: string; new: string }; if (!keys.includes(patch.old)) keys.push(patch.new); }
      if (init.method === 'DELETE') keys.splice(Number(url.searchParams.get('index')), 1);
      return new Response(JSON.stringify(init.method && init.method !== 'GET' ? { status: 'ok' } : { 'api-keys': keys }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  beforeEach(() => {
    calls = [];
    keys = ['sk-existing-one-1234', 'short'];
    password = 'right-password';
  });

  it('validates the password with GET /v0/management/config: 200 ok, 401 wrong', async () => {
    expect(await management.validateManagementKey(BASE, 'right-password', api())).toBe(true);
    expect(await management.validateManagementKey(BASE, 'wrong', api())).toBe(false);
    expect(calls.map(call => `${call.method} ${call.url} ${call.auth}`)).toEqual([
      'GET /v0/management/config Bearer right-password', 'GET /v0/management/config Bearer wrong'
    ]);
  });

  it('saves the password only after the service accepted it', async () => {
    await expect(management.setManagementKey(BASE, 'wrong', api())).rejects.toThrow('management_key_invalid');
    expect(state.secrets.has('marks:cliproxyManagementKey')).toBe(false);
    await expect(management.setManagementKey(null, 'right-password', api())).rejects.toThrow('management_unreachable');
    await management.setManagementKey(BASE, 'right-password', api());
    expect(state.secrets.get('marks:cliproxyManagementKey')).toBe('right-password');
    await management.setManagementKey(null, '', api());
    expect(state.secrets.has('marks:cliproxyManagementKey')).toBe(false);
  });

  it('only talks to the loopback service address', async () => {
    await expect(management.managementRequest('http://evil.example:18081', 'k', 'GET', '/config', undefined, api())).rejects.toThrow('management_unreachable');
    expect(calls).toEqual([]);
  });

  it('lists keys masked to their last four characters and marks the chat key', async () => {
    state.secrets.set('marks:cliproxyManagementKey', 'right-password');
    state.chatKey = 'sk-existing-one-1234';
    const listed = await management.listApiKeys(BASE, api());
    expect(listed).toEqual([
      { id: management.keyId('sk-existing-one-1234'), last4: '1234', chat: true },
      { id: management.keyId('short'), last4: '', chat: false }
    ]);
    expect(JSON.stringify(listed)).not.toContain('sk-existing');
  });

  it('creates a key with PATCH {old,new}, keeps the others and makes it the chat key', async () => {
    state.secrets.set('marks:cliproxyManagementKey', 'right-password');
    const listed = await management.createApiKey(BASE, api());
    const patch = calls.find(call => call.method === 'PATCH')!;
    expect(patch.url).toBe('/v0/management/api-keys');
    const created = (patch.body as { new: string }).new;
    expect(patch.body).toEqual({ old: created, new: created });
    expect(created).toMatch(/^sk-marks-[A-Za-z0-9_-]{43}$/);
    expect(keys).toEqual(['sk-existing-one-1234', 'short', created]);
    expect(state.chatKey).toBe(created);
    expect(listed.find(key => key.chat)?.last4).toBe(created.slice(-4));
  });

  it('revokes exactly the listed key by index and stops the chat using it', async () => {
    state.secrets.set('marks:cliproxyManagementKey', 'right-password');
    state.chatKey = 'sk-existing-one-1234';
    const listed = await management.revokeApiKey(BASE, management.keyId('sk-existing-one-1234'), api());
    expect(calls.find(call => call.method === 'DELETE')?.url).toBe('/v0/management/api-keys?index=0');
    expect(keys).toEqual(['short']);
    expect(state.chatKey).toBeNull();
    expect(listed).toHaveLength(1);
    await expect(management.revokeApiKey(BASE, 'ffffffffffffffff', api())).rejects.toThrow('key_not_found');
  });

  it('does not retry a stored password the service rejected until it is replaced', async () => {
    state.secrets.set('marks:cliproxyManagementKey', 'stale');
    await expect(management.listApiKeys(BASE, api())).rejects.toThrow('management_key_invalid');
    const sent = calls.length;
    await expect(management.listApiKeys(BASE, api())).rejects.toThrow('management_key_invalid');
    expect(calls.length).toBe(sent);
    await management.setManagementKey(BASE, 'right-password', api());
    expect(await management.listApiKeys(BASE, api())).toHaveLength(2);
  });

  it('needs a stored password', async () => {
    await expect(management.createApiKey(BASE, api())).rejects.toThrow('management_key_missing');
    expect(calls).toEqual([]);
  });
});
