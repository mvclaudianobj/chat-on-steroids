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
import { OPENCODE_SPEC, opencodeAssetName, opencodeSupport } from '../src/main/opencode/release.js';
import { ZEROCLAW_SPEC, zeroclawAssetName } from '../src/main/zeroclaw/release.js';

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
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

describe('upstream release helpers', () => {
  it('chooses the OpenCode archive like upstream\'s install script (baseline without avx2, musl) and gates versions', () => {
    expect(opencodeAssetName({ arch: 'x64', avx2: true, musl: false })).toBe('opencode-linux-x64.tar.gz');
    expect(opencodeAssetName({ arch: 'x64', avx2: false, musl: false })).toBe('opencode-linux-x64-baseline.tar.gz');
    expect(opencodeAssetName({ arch: 'x64', avx2: false, musl: true })).toBe('opencode-linux-x64-baseline-musl.tar.gz');
    expect(opencodeAssetName({ arch: 'arm64', avx2: false, musl: false })).toBe('opencode-linux-arm64.tar.gz');
    expect(opencodeAssetName({ arch: 'arm64', avx2: false, musl: true })).toBe('opencode-linux-arm64-musl.tar.gz');
    expect(opencodeAssetName({ arch: null, avx2: true, musl: false })).toBeNull();
    expect(zeroclawAssetName({ arch: 'x64', avx2: true, musl: false })).toBe('zeroclaw-x86_64-unknown-linux-gnu.tar.gz');
    expect(zeroclawAssetName({ arch: 'arm64', avx2: false, musl: true })).toBe('zeroclaw-aarch64-unknown-linux-musl.tar.gz');
    expect(parseHostProbe('x86_64 1 0\n')).toEqual({ arch: 'x64', avx2: true, musl: false });
    expect(parseHostProbe('aarch64 0 1')).toEqual({ arch: 'arm64', avx2: false, musl: true });
    expect(parseHostProbe('riscv64 0 0').arch).toBeNull();
    expect([opencodeSupport('1.19.3'), opencodeSupport('1.19.0'), opencodeSupport('1.20.1'), opencodeSupport('1.18.9'), opencodeSupport('2.0.0'), opencodeSupport(null)])
      .toEqual(['ok', 'ok', 'newer', 'unsupported', 'unsupported', null]);
    // The real 1.19.3 / 0.8.6 `--version` lines.
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
    expect(ok(['opencode'])).not.toThrow();
    expect(ok(['./opencode'])).not.toThrow();
    expect(ok(['opencode', 'extra'])).toThrow('archive_unexpected');
    expect(ok(['other'])).toThrow('archive_unexpected');
    expect(ok(['opencode'], ['l'])).toThrow('archive_unexpected');
    expect(ok(['/opencode'])).toThrow('archive_unexpected');
    const zc = (names: string[]) => () => checkListing(names, names.map(name => name.endsWith('/') ? 'drwx' : '-rwx'), ZEROCLAW_SPEC);
    expect(zc(['zeroclaw', 'zerocode', 'zerorelay', 'web/', 'web/dist/', 'web/dist/index.html', 'web/dist/assets/app-1.js'])).not.toThrow();
    expect(zc(['zeroclaw', 'zerocode', 'web/dist/', 'web/dist/../../etc/passwd'])).toThrow('archive_unexpected');
    expect(zc(['zeroclaw', 'zerocode', 'web/dist/', 'install.sh'])).toThrow('archive_unexpected');
    expect(zc(['zeroclaw', 'web/dist/'])).toThrow('archive_unexpected');
    // The probe never sees the user's own data folders.
    expect(probeEnvironment('/m/opencode/.probe').filter(entry => /^(HOME|XDG_)/.test(entry)).every(entry => entry.includes('/m/opencode/.probe'))).toBe(true);
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
  const repo = 'anomalyco/opencode';

  it('verifies the digest, the single ELF member and its version, then renames it over the old binary', async () => {
    const archive = tarball(root, { opencode: Buffer.concat([ELF, Buffer.from('v1')]) });
    const files = new Map([['opencode-linux-x64.tar.gz', archive]]);
    const phases: string[] = [];
    const log: string[][] = [];
    const done = await installUpstream(OPENCODE_SPEC, '1.19.3', 'install', {
      modulesRoot: modules, host, runner: runner({ opencode: '1.19.3' }, log), fetchImpl: fetchFor(files),
      release: release('1.19.3', [{ name: 'opencode-linux-x64.tar.gz', data: archive }], repo), onProgress: progress => phases.push(progress.phase)
    });
    expect(done.phase).toBe('done');
    expect(phases).toEqual(['downloading', 'verifying', 'extracting', 'checking', 'installing', 'done']);
    const binary = join(modules, 'opencode', 'bin', 'opencode');
    expect(readFileSync(binary).subarray(0, 4)).toEqual(ELF.subarray(0, 4));
    expect(statSync(binary).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(modules, 'opencode')).filter(name => name.startsWith('.stage-'))).toEqual([]);
    // Every step is argv to a fixed program; the version probe runs under env -i with the private folder.
    const probe = log.find(command => command[0] === '/usr/bin/env')!;
    expect(probe).toContain(`HOME=${join(modules, 'opencode')}/.stage-${probe.find(arg => arg.startsWith('HOME='))!.split('.stage-')[1]}`);

    // An update replaces the file by rename: an open handle (the running server) keeps the old inode.
    const before = statSync(binary).ino;
    const next = tarball(root, { opencode: Buffer.concat([ELF, Buffer.from('v2')]) });
    files.set('opencode-linux-x64.tar.gz', next);
    await installUpstream(OPENCODE_SPEC, '1.19.4', 'update', {
      modulesRoot: modules, host, runner: runner({ opencode: '1.19.4' }), fetchImpl: fetchFor(files),
      release: release('1.19.4', [{ name: 'opencode-linux-x64.tar.gz', data: next }], repo)
    });
    expect(readFileSync(binary).subarray(8).toString()).toBe('v2');
    expect(statSync(binary).ino).not.toBe(before);
  });

  it('refuses a changed release, a digest mismatch, extra or linked members, a non-ELF file and a wrong version, keeping the old binary', async () => {
    const good = tarball(root, { opencode: Buffer.concat([ELF, Buffer.from('old')]) });
    const files = new Map([['opencode-linux-x64.tar.gz', good]]);
    await installUpstream(OPENCODE_SPEC, '1.19.3', 'install', { modulesRoot: modules, host, runner: runner({ opencode: '1.19.3' }), fetchImpl: fetchFor(files),
      release: release('1.19.3', [{ name: 'opencode-linux-x64.tar.gz', data: good }], repo) });
    const binary = join(modules, 'opencode', 'bin', 'opencode');
    const attempt = (archive: Buffer, options: { version?: string; reported?: string; digest?: string | null; expected?: string } = {}) => {
      files.set('opencode-linux-x64.tar.gz', archive);
      return installUpstream(OPENCODE_SPEC, options.expected ?? '1.19.4', 'update', {
        modulesRoot: modules, host, runner: runner({ opencode: options.reported ?? '1.19.4' }), fetchImpl: fetchFor(files),
        release: release(options.version ?? '1.19.4', [{ name: 'opencode-linux-x64.tar.gz', data: archive, digest: options.digest }], repo)
      });
    };
    const fresh = tarball(root, { opencode: Buffer.concat([ELF, Buffer.from('new')]) });
    await expect(attempt(fresh, { version: '1.19.5' })).rejects.toThrow('version_changed');
    await expect(attempt(fresh, { digest: 'b'.repeat(64) })).rejects.toThrow('checksum_mismatch');
    await expect(attempt(fresh, { digest: null })).rejects.toThrow('checksum_mismatch');
    await expect(attempt(tarball(root, { opencode: Buffer.concat([ELF, Buffer.from('x')]), 'evil.sh': 'x' }))).rejects.toThrow('archive_unexpected');
    await expect(attempt(tarball(root, { opencode: '@link:/etc/passwd' }))).rejects.toThrow('archive_unexpected');
    await expect(attempt(tarball(root, { opencode: '#!/bin/sh\necho 1.19.4\n' }))).rejects.toThrow('extract_failed');
    await expect(attempt(fresh, { reported: '1.19.3' })).rejects.toThrow('version_mismatch');
    await expect(installUpstream(OPENCODE_SPEC, '1.19.4', 'update', { modulesRoot: modules, host: { arch: null, avx2: false, musl: false },
      runner: runner({}), fetchImpl: fetchFor(files), release: release('1.19.4', [{ name: 'opencode-linux-x64.tar.gz', data: fresh }], repo) })).rejects.toThrow('unsupported_platform');
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
