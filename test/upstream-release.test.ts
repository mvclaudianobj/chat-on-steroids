import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedDownloadUrl, downloadReleaseAsset, fetchLatestRelease, isNewerVersion, type GitHubRelease } from '../src/main/github-release.js';
import {
  checkListing, installUpstream, localRunner, parseHostProbe, parseVersion, probeEnvironment, type Runner
} from '../src/main/upstream/install.js';
import { OPENCODE_SPEC, OPENCODE_UPDATE_URL, opencodeLatestHint, opencodePlatformPackage, opencodeSupport } from '../src/main/opencode/release.js';
import { allowedRegistryUrl, downloadNpmTarball, fetchNpmVersion, npmTarballUrl, setRegistryRetryDelayForTests, verifyIntegrity } from '../src/main/npm-release.js';
import { ZEROCLAW_SPEC, zeroclawAssetName } from '../src/main/zeroclaw/release.js';

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const sri = (data: Buffer): string => `sha512-${createHash('sha512').update(data).digest('base64')}`;
const onLinux = process.platform === 'linux';

/** Builds a real .tar.gz with the given members (folders end with `/`, `@link` makes a symlink). */
function tarball(root: string, members: Record<string, string | Buffer>): Buffer {
  const dir = mkdtempSync(join(root, 'src-'));
  for (const [name, content] of Object.entries(members)) {
    const file = join(dir, name);
    if (name.endsWith('/')) { mkdirSync(file, { recursive: true }); continue; }
    mkdirSync(join(file, '..'), { recursive: true });
    if (typeof content === 'string' && content.startsWith('@link:')) symlinkSync(content.slice(6), file);
    else { writeFileSync(file, content); chmodSync(file, 0o755); }
  }
  const out = join(root, `${Math.random().toString(36).slice(2)}.tar.gz`);
  execFileSync('/usr/bin/tar', ['-czf', out, '-C', dir, ...Object.keys(members).filter(name => !Object.keys(members).some(other => other !== name && name.startsWith(other) && other.endsWith('/')))]);
  return readFileSync(out);
}

/** The real POSIX commands, except the binary's `--version` (the fake members are not programs). */
function runner(versions: Record<string, string>, log: string[][] = []): Runner {
  return {
    windows: false,
    async run(file, args, timeoutMs) {
      log.push([file, ...args]);
      if (file === '/usr/bin/env' && args[0] === '-i' && args.at(-1) === '--version') {
        const binary = args.at(-2)!.split('/').pop()!;
        return { stdout: `${versions[binary] ?? ''}\n`, stderr: '' };
      }
      return localRunner.run(file, args, timeoutMs);
    }
  };
}

function release(version: string, assets: Array<{ name: string; data: Buffer | null; digest?: string | null }>, repo: string): GitHubRelease {
  return {
    version,
    assets: assets.map(asset => ({ name: asset.name, size: asset.data?.length ?? 1, url: `https://github.com/${repo}/releases/download/v${version}/${asset.name}`,
      sha256: asset.digest === undefined ? (asset.data ? sha(asset.data) : null) : asset.digest }))
  };
}

/** Serves the release's assets through a GitHub-style redirect to the asset host. */
function fetchFor(files: Map<string, Buffer>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://github.com/')) {
      return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/${url.split('/').pop()}` } });
    }
    const data = files.get(url.split('/').pop()!);
    return data ? new Response(new Uint8Array(data), { status: 200 }) : new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
}

/**
 * The npm registry as OpenCode 2.x publishes there: `@opencode/cli` (latest, its platform
 * packages in `optionalDependencies`) and one `@opencode/cli-<platform>` version document plus
 * its tarball, at the registry's canonical URLs only.
 */
function npmFetch(options: { version: string; platform?: string; tarball: Buffer; integrity?: string; tarballUrl?: string; optional?: Record<string, string> },
  calls: string[] = []): typeof fetch {
  const platform = options.platform ?? '@opencode/cli-linux-x64';
  const tgz = npmTarballUrl(platform, options.version);
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.redirect !== 'error') return new Response('redirects must be refused', { status: 500 });
    if (url === 'https://registry.npmjs.org/@opencode%2fcli/latest' || url === `https://registry.npmjs.org/@opencode%2fcli/${options.version}`) {
      return new Response(JSON.stringify({ name: '@opencode/cli', version: options.version, dist: { tarball: npmTarballUrl('@opencode/cli', options.version), integrity: sri(Buffer.from('main')) },
        optionalDependencies: options.optional ?? { [platform]: options.version, '@opencode/cli-darwin-arm64': options.version } }));
    }
    if (url === `https://registry.npmjs.org/${platform.replace('/', '%2f')}/${options.version}`) {
      return new Response(JSON.stringify({ name: platform, version: options.version, dist: { tarball: options.tarballUrl ?? tgz, integrity: options.integrity ?? sri(options.tarball) } }));
    }
    if (url === tgz) return new Response(new Uint8Array(options.tarball), { status: 200 });
    return new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => setRegistryRetryDelayForTests(() => 0));
afterEach(() => setRegistryRetryDelayForTests(null));

describe('upstream release helpers', () => {
  it('tries the npm registry again after a 502 or a dropped request, and falls back to OpenCode\'s own latest answer (live 2026-10-22)', async () => {
    const data = Buffer.from('tarball bytes');
    const base = npmFetch({ version: '2.1.2', tarball: data });
    let failures = 2;
    const flaky = (async (input: string | URL, init?: RequestInit) => {
      if (failures-- > 0) return failures === 1 ? new Response('bad gateway', { status: 502 }) : Promise.reject(new TypeError('fetch failed'));
      return base(input, init);
    }) as unknown as typeof fetch;
    expect((await fetchNpmVersion('@opencode/cli', 'latest', flaky)).version).toBe('2.1.2');
    // A 404 is final: no retry.
    const calls: string[] = [];
    await expect(fetchNpmVersion('@opencode/cli', '2.9.9', npmFetch({ version: '2.1.2', tarball: data }, calls))).rejects.toThrow('release_unavailable');
    expect(calls).toHaveLength(1);

    // OpenCode's update channel names the version first (the registry's latest document may be
    // failing); the exact version documents with their integrity still come from the registry.
    const channel = { channel: 'latest', name: 'cli', distribution: 'npm', version: '2.1.2', metadata: { package: '@opencode/cli' } };
    const latestDown = (answer: unknown) => (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://registry.npmjs.org/@opencode%2fcli/latest') return new Response('bad gateway', { status: 502 });
      if (url === OPENCODE_UPDATE_URL) return init?.redirect === 'error' ? new Response(JSON.stringify(answer)) : new Response('no', { status: 500 });
      return base(input, init);
    }) as unknown as typeof fetch;
    expect(await OPENCODE_SPEC.source.latest(latestDown(channel))).toBe('2.1.2');
    expect(await opencodeLatestHint(latestDown({ ...channel, metadata: { package: '@evil/cli' } }))).toBeNull();
    expect(await opencodeLatestHint(latestDown({ ...channel, version: '0.0.0-dev-1' }))).toBeNull();
    expect(await opencodeLatestHint(latestDown({ ...channel, distribution: 'github' }))).toBeNull();
    await expect(OPENCODE_SPEC.source.latest(latestDown({ ...channel, metadata: { package: '@evil/cli' } }))).rejects.toThrow('release_unavailable');
  });

  it('chooses the OpenCode 2.x npm platform package like upstream\'s install script (baseline without avx2, musl) and gates versions', () => {
    expect(opencodePlatformPackage({ arch: 'x64', avx2: true, musl: false })).toBe('@opencode/cli-linux-x64');
    expect(opencodePlatformPackage({ arch: 'x64', avx2: false, musl: false })).toBe('@opencode/cli-linux-x64-baseline');
    expect(opencodePlatformPackage({ arch: 'x64', avx2: false, musl: true })).toBe('@opencode/cli-linux-x64-baseline-musl');
    expect(opencodePlatformPackage({ arch: 'x64', avx2: true, musl: true })).toBe('@opencode/cli-linux-x64-musl');
    expect(opencodePlatformPackage({ arch: 'arm64', avx2: false, musl: false })).toBe('@opencode/cli-linux-arm64');
    expect(opencodePlatformPackage({ arch: 'arm64', avx2: false, musl: true })).toBe('@opencode/cli-linux-arm64-musl');
    expect(opencodePlatformPackage({ arch: null, avx2: true, musl: false })).toBeNull();
    expect(zeroclawAssetName({ arch: 'x64', avx2: true, musl: false })).toBe('zeroclaw-x86_64-unknown-linux-gnu.tar.gz');
    expect(zeroclawAssetName({ arch: 'arm64', avx2: false, musl: true })).toBe('zeroclaw-aarch64-unknown-linux-musl.tar.gz');
    expect(parseHostProbe('x86_64 1 0\n')).toEqual({ arch: 'x64', avx2: true, musl: false });
    expect(parseHostProbe('aarch64 0 1')).toEqual({ arch: 'arm64', avx2: false, musl: true });
    expect(parseHostProbe('riscv64 0 0').arch).toBeNull();
    expect([opencodeSupport('2.1.2'), opencodeSupport('2.1.0'), opencodeSupport('2.2.0'), opencodeSupport('2.0.25'), opencodeSupport('1.19.3'), opencodeSupport('3.0.0'), opencodeSupport(null)])
      .toEqual(['ok', 'ok', 'newer', 'unsupported', 'unsupported', 'unsupported', null]);
    // The real 2.1.2 / 0.8.6 `--version` lines.
    expect(parseVersion('opencode v2.1.2')).toBe('2.1.2');
    expect(parseVersion('1.19.3')).toBe('1.19.3');
    expect(parseVersion('zeroclaw 0.8.6 (c473221)')).toBe('0.8.6');
    expect(parseVersion('zerocode 0.8.6')).toBe('0.8.6');
    expect(parseVersion('build 1.19.3.4')).toBeNull();
    expect(isNewerVersion('1.19.3', '1.19.4')).toBe(true);
    expect(isNewerVersion('1.19.3', '1.19.3')).toBe(false);
    expect(isNewerVersion(null, '1.19.3')).toBe(false);
  });

  it('reads the API digest of every asset and refuses drafts, prereleases and other tags', async () => {
    const body = (over: Record<string, unknown> = {}) => ({
      tag_name: 'v1.19.3', draft: false, prerelease: false,
      assets: [{ name: 'opencode-linux-x64.tar.gz', size: 5, browser_download_url: 'https://github.com/anomalyco/opencode/releases/download/v1.19.3/opencode-linux-x64.tar.gz', digest: `sha256:${'A'.repeat(64)}` },
        { name: 'no-digest', size: 1, browser_download_url: 'https://github.com/x', digest: 'md5:00' }],
      ...over
    });
    const answer = (value: unknown) => (async () => new Response(JSON.stringify(value))) as unknown as typeof fetch;
    const found = await fetchLatestRelease('anomalyco/opencode', /^v(\d+\.\d+\.\d+)$/, answer(body()));
    expect(found.version).toBe('1.19.3');
    expect(found.assets.map(asset => asset.sha256)).toEqual(['a'.repeat(64), null]);
    for (const bad of [body({ draft: true }), body({ prerelease: true }), body({ tag_name: 'v2.0.0-beta.1' }), body({ assets: null })]) {
      await expect(fetchLatestRelease('anomalyco/opencode', /^v(\d+\.\d+\.\d+)$/, answer(bad))).rejects.toThrow('release_unavailable');
    }
  });

  it('downloads only from the trusted repository through GitHub release hosts', async () => {
    const prefix = 'https://github.com/anomalyco/opencode/releases/download/';
    const files = new Map([['a.tar.gz', Buffer.from('data')]]);
    expect((await downloadReleaseAsset(`${prefix}v1.19.3/a.tar.gz`, prefix, 1024, fetchFor(files))).toString()).toBe('data');
    await expect(downloadReleaseAsset('https://github.com/evil/opencode/releases/download/v1/a.tar.gz', prefix, 1024, fetchFor(files))).rejects.toThrow('download_failed');
    const evil = (async () => new Response(null, { status: 302, headers: { location: 'https://example.com/a' } })) as unknown as typeof fetch;
    await expect(downloadReleaseAsset(`${prefix}v1.19.3/a.tar.gz`, prefix, 1024, evil)).rejects.toThrow('download_failed');
    await expect(downloadReleaseAsset(`${prefix}v1.19.3/a.tar.gz`, prefix, 2, fetchFor(files))).rejects.toThrow('download_failed');
    expect(allowedDownloadUrl('https://release-assets.githubusercontent.com/x')).toBe(true);
    expect(allowedDownloadUrl('https://user:pw@github.com/x')).toBe(false);
    expect(allowedDownloadUrl('http://github.com/x')).toBe(false);
  });

  it('accepts only regular files and folders of the allowlist, never absolute or `..` paths', () => {
    const ok = (names: string[], types: string[] = names.map(name => name.endsWith('/') ? 'd' : '-')) => () => checkListing(names, types.map(type => `${type}rwxr-xr-x x/x 1 2026 ${type}`), OPENCODE_SPEC);
    // The real 2.1.2 platform tarball: `package/package.json` and `package/bin/opencode`.
    expect(ok(['package/package.json', 'package/bin/opencode'])).not.toThrow();
    expect(ok(['package/', 'package/bin/', 'package/package.json', 'package/bin/opencode'])).not.toThrow();
    expect(ok(['package/package.json', 'package/bin/opencode', 'package/postinstall.mjs'])).toThrow('archive_unexpected');
    expect(ok(['package/package.json'])).toThrow('archive_unexpected');
    expect(ok(['package/package.json', 'package/bin/opencode'], ['-', 'l'])).toThrow('archive_unexpected');
    expect(ok(['/package/bin/opencode'])).toThrow('archive_unexpected');
    expect(ok(['package/bin/../../opencode', 'package/bin/opencode'])).toThrow('archive_unexpected');
    const zc = (names: string[]) => () => checkListing(names, names.map(name => name.endsWith('/') ? 'drwx' : '-rwx'), ZEROCLAW_SPEC);
    expect(zc(['zeroclaw', 'zerocode', 'zerorelay', 'web/', 'web/dist/', 'web/dist/index.html', 'web/dist/assets/app-1.js'])).not.toThrow();
    expect(zc(['zeroclaw', 'zerocode', 'web/dist/', 'web/dist/../../etc/passwd'])).toThrow('archive_unexpected');
    expect(zc(['zeroclaw', 'zerocode', 'web/dist/', 'install.sh'])).toThrow('archive_unexpected');
    expect(zc(['zeroclaw', 'web/dist/'])).toThrow('archive_unexpected');
    // The probe never sees the user's own data folders.
    expect(probeEnvironment('/m/opencode/.probe').filter(entry => /^(HOME|XDG_)/.test(entry)).every(entry => entry.includes('/m/opencode/.probe'))).toBe(true);
  });
});

describe('npm registry downloads', () => {
  it('trusts only https://registry.npmjs.org, exact versions and sha512 integrity, and never follows a redirect', async () => {
    expect(allowedRegistryUrl('https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.1.2.tgz')).toBe(true);
    for (const bad of ['http://registry.npmjs.org/x', 'https://registry.npmjs.org.evil.com/x', 'https://user:pw@registry.npmjs.org/x', 'https://registry.npmjs.org:444/x', 'https://registry.yarnpkg.com/x']) {
      expect(allowedRegistryUrl(bad)).toBe(false);
    }
    expect(npmTarballUrl('@opencode/cli-linux-x64', '2.1.2')).toBe('https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.1.2.tgz');
    const data = Buffer.from('tarball bytes');
    expect(() => verifyIntegrity(data, sri(data))).not.toThrow();
    expect(() => verifyIntegrity(data, sri(Buffer.from('else')))).toThrow('checksum_mismatch');
    expect(() => verifyIntegrity(data, null)).toThrow('checksum_mismatch');
    const meta = await fetchNpmVersion('@opencode/cli', 'latest', npmFetch({ version: '2.1.2', tarball: data }));
    expect(meta).toMatchObject({ name: '@opencode/cli', version: '2.1.2' });
    expect(meta.optionalDependencies['@opencode/cli-linux-x64']).toBe('2.1.2');
    // A prerelease or dist-tag version, another package's document, or a bad tag are refused.
    const answer = (value: unknown) => (async () => new Response(JSON.stringify(value))) as unknown as typeof fetch;
    const doc = { name: '@opencode/cli', version: '2.1.2', dist: { tarball: 'x', integrity: sri(data) } };
    await expect(fetchNpmVersion('@opencode/cli', 'latest', answer({ ...doc, version: '0.0.0-dev-21530' }))).rejects.toThrow('release_unavailable');
    await expect(fetchNpmVersion('@opencode/cli', 'latest', answer({ ...doc, name: '@evil/cli' }))).rejects.toThrow('release_unavailable');
    await expect(fetchNpmVersion('@opencode/cli', '2.1.3', answer(doc))).rejects.toThrow('release_unavailable');
    await expect(fetchNpmVersion('@opencode/cli', '../x', answer(doc))).rejects.toThrow('release_unavailable');
    const tgz = npmTarballUrl('@opencode/cli-linux-x64', '2.1.2');
    const tarballMeta = { name: '@opencode/cli-linux-x64', version: '2.1.2', tarball: tgz, integrity: sri(data) };
    expect((await downloadNpmTarball(tarballMeta, 1024, npmFetch({ version: '2.1.2', tarball: data }))).toString()).toBe('tarball bytes');
    await expect(downloadNpmTarball(tarballMeta, 4, npmFetch({ version: '2.1.2', tarball: data }))).rejects.toThrow('download_failed');
    await expect(downloadNpmTarball({ ...tarballMeta, tarball: 'https://registry.npmjs.org/@evil/x/-/x-2.1.2.tgz' }, 1024, npmFetch({ version: '2.1.2', tarball: data }))).rejects.toThrow('download_failed');
    const redirecting = (async (_url: string, init?: RequestInit) => {
      if (init?.redirect === 'error') throw new TypeError('redirect refused');
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/x.tgz' } });
    }) as unknown as typeof fetch;
    await expect(downloadNpmTarball(tarballMeta, 1024, redirecting)).rejects.toThrow('download_failed');
  });
});

describe.skipIf(!onLinux)('installing an upstream release into the module folder', () => {
  let root: string;
  let modules: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'marks-upstream-'));
    modules = join(root, 'modules');
    mkdirSync(modules, { mode: 0o700 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const host = { arch: 'x64' as const, avx2: true, musl: false };

  const npmPackage = (binary: string | Buffer, extra: Record<string, string | Buffer> = {}) =>
    tarball(root, { 'package/package.json': '{"name":"@opencode/cli-linux-x64"}', 'package/bin/opencode': binary, ...extra });

  it('installs OpenCode 2.x from the npm registry: integrity, only package/bin/opencode, ELF, `opencode v2.1.2`, then a rename over the old binary', async () => {
    const archive = npmPackage(Buffer.concat([ELF, Buffer.from('v1')]));
    const phases: string[] = [];
    const log: string[][] = [];
    const calls: string[] = [];
    const done = await installUpstream(OPENCODE_SPEC, '2.1.2', 'install', {
      modulesRoot: modules, host, runner: runner({ opencode: 'opencode v2.1.2' }, log), fetchImpl: npmFetch({ version: '2.1.2', tarball: archive }, calls),
      onProgress: progress => phases.push(progress.phase)
    });
    expect(done.phase).toBe('done');
    expect(phases).toEqual(['downloading', 'verifying', 'extracting', 'checking', 'installing', 'done']);
    expect(calls).toEqual([
      OPENCODE_UPDATE_URL, 'https://registry.npmjs.org/@opencode%2fcli/latest', 'https://registry.npmjs.org/@opencode%2fcli/2.1.2',
      'https://registry.npmjs.org/@opencode%2fcli-linux-x64/2.1.2',
      'https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.1.2.tgz'
    ]);
    const binary = join(modules, 'opencode', 'bin', 'opencode');
    expect(readFileSync(binary).subarray(0, 4)).toEqual(ELF.subarray(0, 4));
    expect(statSync(binary).mode & 0o777).toBe(0o700);
    // Only the binary is extracted (package.json stays in the archive).
    expect(readdirSync(join(modules, 'opencode', 'bin'))).toEqual(['opencode']);
    expect(readdirSync(join(modules, 'opencode')).filter(name => name.startsWith('.stage-'))).toEqual([]);
    expect(log.find(command => command[0] === '/usr/bin/tar' && command[1] === '-xzf')).toContain('--strip-components=2');
    const probe = log.find(command => command[0] === '/usr/bin/env')!;
    expect(probe).toContain(`HOME=${join(modules, 'opencode')}/.stage-${probe.find(arg => arg.startsWith('HOME='))!.split('.stage-')[1]}`);
    expect(probe).toContain('OPENCODE_DISABLE_AUTOUPDATE=1');

    // An update replaces the file by rename: the running service keeps the old inode.
    const before = statSync(binary).ino;
    const next = npmPackage(Buffer.concat([ELF, Buffer.from('v2')]));
    await installUpstream(OPENCODE_SPEC, '2.1.3', 'update', {
      modulesRoot: modules, host: { arch: 'x64', avx2: false, musl: true }, runner: runner({ opencode: 'opencode v2.1.3' }),
      fetchImpl: npmFetch({ version: '2.1.3', platform: '@opencode/cli-linux-x64-baseline-musl', tarball: next })
    });
    expect(readFileSync(binary).subarray(8).toString()).toBe('v2');
    expect(statSync(binary).ino).not.toBe(before);
  });

  it('refuses a moved latest, an integrity mismatch, a missing platform build, a foreign tarball URL, extra or linked members, a non-ELF file and a wrong version, keeping the old binary', async () => {
    const good = npmPackage(Buffer.concat([ELF, Buffer.from('old')]));
    await installUpstream(OPENCODE_SPEC, '2.1.2', 'install', { modulesRoot: modules, host, runner: runner({ opencode: 'opencode v2.1.2' }), fetchImpl: npmFetch({ version: '2.1.2', tarball: good }) });
    const binary = join(modules, 'opencode', 'bin', 'opencode');
    const fresh = npmPackage(Buffer.concat([ELF, Buffer.from('new')]));
    const attempt = (archive: Buffer, options: Partial<Parameters<typeof npmFetch>[0]> & { reported?: string; expected?: string } = {}) =>
      installUpstream(OPENCODE_SPEC, options.expected ?? '2.1.3', 'update', {
        modulesRoot: modules, host, runner: runner({ opencode: options.reported ?? 'opencode v2.1.3' }),
        fetchImpl: npmFetch({ version: '2.1.3', tarball: archive, ...options })
      });
    await expect(attempt(fresh, { version: '2.1.4' })).rejects.toThrow('version_changed');
    await expect(attempt(fresh, { integrity: sri(Buffer.from('other')) })).rejects.toThrow('checksum_mismatch');
    await expect(attempt(fresh, { integrity: `sha1-${'a'.repeat(27)}=` })).rejects.toThrow('release_unavailable');
    await expect(attempt(fresh, { optional: { '@opencode/cli-darwin-arm64': '2.1.3' } })).rejects.toThrow('unsupported_platform');
    await expect(attempt(fresh, { optional: { '@opencode/cli-linux-x64': '2.1.2' } })).rejects.toThrow('unsupported_platform');
    await expect(attempt(fresh, { tarballUrl: 'https://evil.example/cli-linux-x64-2.1.3.tgz' })).rejects.toThrow('download_failed');
    await expect(attempt(npmPackage(Buffer.concat([ELF, Buffer.from('x')]), { 'package/postinstall.mjs': 'x' }))).rejects.toThrow('archive_unexpected');
    await expect(attempt(npmPackage('@link:/etc/passwd'))).rejects.toThrow('archive_unexpected');
    await expect(attempt(npmPackage('#!/bin/sh\necho opencode v2.1.3\n'))).rejects.toThrow('extract_failed');
    await expect(attempt(fresh, { reported: 'opencode v2.1.2' })).rejects.toThrow('version_mismatch');
    await expect(installUpstream(OPENCODE_SPEC, '2.1.3', 'update', { modulesRoot: modules, host: { arch: null, avx2: false, musl: false },
      runner: runner({}), fetchImpl: npmFetch({ version: '2.1.3', tarball: fresh }) })).rejects.toThrow('unsupported_platform');
    expect(readFileSync(binary).subarray(8).toString()).toBe('old');
    expect(readdirSync(join(modules, 'opencode')).filter(name => name.startsWith('.stage-'))).toEqual([]);
  });

  it('installs ZeroClaw\'s zeroclaw, zerocode and dashboard together after SHA256SUMS and the digest agree, swapping the whole bin folder', async () => {
    const zrepo = 'zeroclaw-labs/zeroclaw';
    const name = 'zeroclaw-x86_64-unknown-linux-gnu.tar.gz';
    const make = (tag: string) => tarball(root, {
      zeroclaw: Buffer.concat([ELF, Buffer.from(tag)]), zerocode: Buffer.concat([ELF, Buffer.from(tag)]), zerorelay: Buffer.concat([ELF, Buffer.from(tag)]),
      'web/': '', 'web/dist/': '', 'web/dist/index.html': `<p>${tag}</p>`, 'web/dist/assets/': '', 'web/dist/assets/app.js': '1'
    });
    const first = make('a');
    const files = new Map([[name, first], ['SHA256SUMS', Buffer.from(`${sha(first)}  ${name}\n`)]]);
    const assets = (archive: Buffer, sums: string) => {
      files.set(name, archive);
      files.set('SHA256SUMS', Buffer.from(sums));
      return release('0.8.6', [{ name, data: archive }, { name: 'SHA256SUMS', data: Buffer.from(sums) }], zrepo);
    };
    await installUpstream(ZEROCLAW_SPEC, '0.8.6', 'install', { modulesRoot: modules, host, runner: runner({ zeroclaw: 'zeroclaw 0.8.6 (c473221)', zerocode: 'zerocode 0.8.6' }),
      fetchImpl: fetchFor(files), release: assets(first, `${sha(first)}  ${name}\n`) });
    const bin = join(modules, 'zeroclaw', 'bin');
    expect(readdirSync(bin).sort()).toEqual(['web', 'zeroclaw', 'zerocode']);
    expect(readFileSync(join(bin, 'web', 'dist', 'index.html'), 'utf8')).toBe('<p>a</p>');
    // A SHA256SUMS that disagrees with the archive refuses it, even with a matching API digest.
    const second = make('b');
    await expect(installUpstream(ZEROCLAW_SPEC, '0.8.6', 'update', { modulesRoot: modules, host, runner: runner({ zeroclaw: 'zeroclaw 0.8.6', zerocode: 'zerocode 0.8.6' }),
      fetchImpl: fetchFor(files), release: assets(second, `${'c'.repeat(64)}  ${name}\n`) })).rejects.toThrow('checksum_mismatch');
    // zerocode must report the same version as zeroclaw.
    await expect(installUpstream(ZEROCLAW_SPEC, '0.8.6', 'update', { modulesRoot: modules, host, runner: runner({ zeroclaw: 'zeroclaw 0.8.6', zerocode: 'zerocode 0.8.5' }),
      fetchImpl: fetchFor(files), release: assets(second, `${sha(second)}  ${name}\n`) })).rejects.toThrow('version_mismatch');
    expect(readFileSync(join(bin, 'web', 'dist', 'index.html'), 'utf8')).toBe('<p>a</p>');
    await installUpstream(ZEROCLAW_SPEC, '0.8.6', 'update', { modulesRoot: modules, host, runner: runner({ zeroclaw: 'zeroclaw 0.8.6', zerocode: 'zerocode 0.8.6' }),
      fetchImpl: fetchFor(files), release: assets(second, `${sha(second)}  ${name}\n`) });
    expect(readFileSync(join(bin, 'web', 'dist', 'index.html'), 'utf8')).toBe('<p>b</p>');
    expect(readdirSync(join(modules, 'zeroclaw')).filter(entry => entry !== 'bin' && entry !== '.probe')).toEqual([]);
    expect(existsSync(join(bin, 'zerorelay'))).toBe(false);
  });
});
