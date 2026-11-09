/**
 * The updater, held to the two things that actually matter about it.
 *
 * One: a file that is going to be executed on quit is the published file and nothing else. The
 * release pipeline writes a `SHA256SUMS.txt` over the exact artifacts it uploads, so that is the
 * bar here — a byte count would pass a same-length wrong file straight into an installer.
 *
 * Two: nothing it does can wedge the app. Every failure has to leave the running version intact
 * and be retried the next time the app opens, which is the only schedule this has.
 *
 * The platform is faked rather than abstracted: `stagedArtifact()` reads `process.platform` and
 * `process.env.APPIMAGE` because those *are* the facts that decide what an installation can
 * apply to itself, and a seam in front of them would be a second answer to the same question.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned: Array<{ file: string; args: string[] }> = [];
const spawnOptions: Array<Record<string, unknown> | undefined> = [];
/** How the elevation step ends: Windows' answer as PowerShell's exit code, or a held answer. */
const elevation: { exitCode: number | 'held'; finish: ((code: number) => void) | null } = { exitCode: 0, finish: null };
/** What icacls answers when the app repeats the installer's access grant: an exit code, or a spawn error. */
const icacls: { calls: Array<{ file: string; args: string[] }>; result: number | string | null } = { calls: [], result: null };
const cleanupFault = vi.hoisted(() => ({ file: '' }));
const cacheBoundary = vi.hoisted(() => ({ after: async (_operation: string, _file: string): Promise<void> => undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const after = async <T>(operation: string, file: unknown, result: Promise<T>): Promise<T> => {
    const value = await result;
    await cacheBoundary.after(operation, String(file));
    return value;
  };
  return { ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => after('lstat', args[0], actual.lstat(...args)),
    readdir: (...args: Parameters<typeof actual.readdir>) => after('readdir', args[0], actual.readdir(...args)),
    mkdir: (...args: Parameters<typeof actual.mkdir>) => after('mkdir', args[0], actual.mkdir(...args)),
    rm: async (file: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (String(file) === cleanupFault.file) throw Object.assign(new Error('installer still open'), { code: 'EACCES' });
      return after('rm', file, actual.rm(file, options));
    }
  };
});
const dpkg = { installed: true, owner: 'chat-on-steroids: /usr/bin/node', calls: [] as string[][] };
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: (file: string, args: string[], options?: Record<string, unknown>) => {
    spawned.push({ file, args });
    spawnOptions.push(options);
    const listeners: Record<string, (value: unknown) => void> = {};
    if (file === 'powershell.exe') {
      const finish = (code: number) => queueMicrotask(() => listeners.exit?.(code));
      if (elevation.exitCode === 'held') elevation.finish = finish;
      else finish(elevation.exitCode);
    }
    return { on: (event: string, listener: (value: unknown) => void) => { listeners[event] = listener; }, unref: () => undefined, kill: () => true };
  },
  execFile: (file: string, args: string[], _options: unknown, done: (err: (Error & { code?: number | string }) | null) => void) => {
    icacls.calls.push({ file, args });
    const result = icacls.result;
    queueMicrotask(() => done(result === null ? null : Object.assign(new Error('icacls failed'), { code: result })));
  },
  execFileSync: (file: string, args: string[]) => {
    if (file !== '/usr/bin/dpkg-query') throw new Error(`Unexpected sync execution: ${file}`);
    dpkg.calls.push(args);
    return args[0] === '--show' ? (dpkg.installed ? 'install ok installed' : 'deinstall ok config-files') : dpkg.owner;
  }
}));

let userData = '';
let packaged = true;
const relaunched: Array<{ execPath?: string }> = [];
vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    get isPackaged() {
      return packaged;
    },
    relaunch: (options: { execPath?: string }) => relaunched.push(options)
  }
}));
const warnings: string[] = [];
vi.mock('../src/main/logger.js', () => ({ logInfo: () => undefined, logWarn: (message: string) => warnings.push(message) }));

const { APP_VERSION } = await import('../src/main/version.js');
const { isNewer } = await import('../src/shared/types.js');
const {
  applyStagedUpdate,
  checkForUpdates,
  checkForUpdatesIfStale,
  installingVersion,
  manualDownloadName,
  manualDownloadUrl,
  markInstallOnQuit,
  onInstallerTakeover,
  onUpdateHandoffStep,
  releaseVersion,
  resetUpdateForTests,
  restoreUpdateHandoff,
  installedDebBinary,
  DEBIAN_HANDOFF_SH,
  DEBIAN_ROOT_INSTALL_SCRIPT,
  setDebPackageProofForTests,
  setInstallFolderAccessForTests,
  stagedArtifact,
  startUpdateChecks,
  updateStatus
} = await import('../src/main/update.js');

const NEXT = '99.0.0';
const WINDOWS_ASSET = `ChatMarks-Setup-${process.arch}.exe`;
const APPIMAGE_ASSET = `ChatMarks-Linux-${process.arch}.AppImage`;
const DEB_ASSET = `ChatMarks-Linux-${process.arch}.deb`;

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex');

/**
 * GitHub, as the three requests this makes: the release, its checksums, and one artifact.
 *
 * `checksums` is supplied as text so a test can hand over a manifest that disagrees with the
 * bytes, which is the whole point of having one.
 */
function github(options: {
  version?: string;
  body?: string;
  checksums?: string;
  fail?: 'release' | 'sums' | 'asset';
  /** The API's status, for a check refused by GitHub's per-address quota (#1253). */
  apiStatus?: number;
  /** Simulate a partial/draft/non-stable API answer, independently from the public latest page. */
  releasePayload?: unknown;
  apiBody?: string;
  /** GitHub asset metadata (separate from releases/latest) when SHA256SUMS.txt is absent. */
  releaseAssets?: unknown;
  /** Where the public `/releases/latest` page lands, or a failing status. */
  page?: string | number;
} = {}) {
  const version = options.version ?? NEXT;
  const body = options.body ?? 'installer bytes';
  const sums = options.checksums ?? `${sha256(body)}  ${WINDOWS_ASSET}\n${sha256(body)}  ${APPIMAGE_ASSET}\n${sha256(body)}  ${DEB_ASSET}\n`;
  const asked: string[] = [];
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const name = url.split('/').pop()!;
    asked.push(name);
    if (url.includes('api.github.com')) {
      if (options.apiStatus) return new Response('{"message":"API rate limit exceeded"}', { status: options.apiStatus });
      if (options.fail === 'release') return new Response('nope', { status: 503 });
      if (url.includes('/releases/tags/')) return new Response(JSON.stringify({
        tag_name: `v${version}`, draft: false, prerelease: false, assets: options.releaseAssets ?? []
      }), { status: 200 });
      return new Response(options.apiBody ?? JSON.stringify(options.releasePayload === undefined
        ? { tag_name: `v${version}`, draft: false, prerelease: false }
        : options.releasePayload), { status: 200 });
    }
    if (url === 'https://github.com/mvclaudianobj/chat-on-steroids/releases/latest') {
      if (typeof options.page === 'number') return new Response(null, { status: options.page });
      const landed = new Response(null, { status: 200 });
      Object.defineProperty(landed, 'url', { value: options.page ?? `https://github.com/mvclaudianobj/chat-on-steroids/releases/tag/v${version}` });
      return landed;
    }
    if (name === 'SHA256SUMS.txt') {
      if (options.fail === 'sums') return new Response('nope', { status: 404 });
      return new Response(sums, { status: 200 });
    }
    if (options.fail === 'asset') return new Response('nope', { status: 500 });
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return { asked, fetch, body };
}

const publishedAsset = (version: string, name: string, digest: string, extra: Record<string, unknown> = {}) => ({
  name, state: 'uploaded', size: 100, digest: `sha256:${digest}`,
  browser_download_url: `https://github.com/mvclaudianobj/chat-on-steroids/releases/download/v${version}/${name}`,
  ...extra
});

/** Runs the pass as an installation of the given shape, and puts the real one back. */
async function asPlatform(platform: string, appImage: string | undefined, run: () => Promise<void>): Promise<void> {
  const realPlatform = process.platform;
  const realAppImage = process.env.APPIMAGE;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  if (appImage) process.env.APPIMAGE = appImage;
  else delete process.env.APPIMAGE;
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = realAppImage;
  }
}

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'cos-update-'));
  packaged = true;
  spawned.length = 0;
  spawnOptions.length = 0;
  elevation.exitCode = 0;
  elevation.finish = null;
  relaunched.length = 0;
  warnings.length = 0;
  cleanupFault.file = '';
  cacheBoundary.after = async () => undefined;
  resetUpdateForTests();
  setDebPackageProofForTests(() => true);
  dpkg.installed = true;
  dpkg.owner = 'chat-on-steroids: /usr/bin/node';
  dpkg.calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(userData, { recursive: true, force: true });
});

describe('the file Get update opens for an installation that cannot update itself', () => {
  it('names the exact macOS disk image or Linux package for this machine', () => {
    expect(manualDownloadName('darwin', 'arm64', undefined, true)).toBe('ChatMarks-macOS-arm64.dmg');
    expect(manualDownloadName('darwin', 'x64', undefined, true)).toBe('ChatMarks-macOS-x64.dmg');
    expect(manualDownloadName('linux', 'x64', undefined, true)).toBeNull();
    // Installations that update themselves, a dev tree and an unpublished architecture get none.
    expect(manualDownloadName('linux', 'x64', '/opt/cos.AppImage', true)).toBeNull();
    expect(manualDownloadName('win32', 'x64', undefined, true)).toBeNull();
    expect(manualDownloadName('darwin', 'arm64', undefined, false)).toBeNull();
    expect(manualDownloadName('darwin', 'ia32', undefined, true)).toBeNull();
  });
  it('links that file for the announced version, and the release page otherwise', () => {
    expect(manualDownloadUrl('2.1.17', 'ChatMarks-macOS-arm64.dmg'))
      .toBe('https://github.com/mvclaudianobj/chat-on-steroids/releases/download/v2.1.17/ChatMarks-macOS-arm64.dmg');
    expect(manualDownloadUrl(null, 'ChatMarks-macOS-arm64.dmg')).toBe('https://github.com/mvclaudianobj/chat-on-steroids/releases/latest');
    expect(manualDownloadUrl('2.1.17', null)).toBe('https://github.com/mvclaudianobj/chat-on-steroids/releases/latest');
    expect(manualDownloadUrl('../evil', 'x.dmg')).toBe('https://github.com/mvclaudianobj/chat-on-steroids/releases/latest');
  });
});

describe('cleanup of updater-owned downloads', () => {
  /** Hold an actual filesystem result, so a reset can revoke the pass before its next write. */
  function pauseAfter(operation: string, file: string, occurrence = 1) {
    let resume!: () => void;
    let reached!: () => void;
    const held = new Promise<void>(resolve => { resume = resolve; });
    const paused = new Promise<void>(resolve => { reached = resolve; });
    cacheBoundary.after = async (seenOperation, seenFile) => {
      if (seenOperation === operation && seenFile === file && --occurrence === 0) {
        reached();
        await held;
      }
    };
    return { paused, resume };
  }
  function cached(version: string, body = 'previous download'): string {
    const dir = path.join(userData, 'updates', version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'download.part'), body);
    return dir;
  }
  it('checks the release normally when the existing update cache is empty', async () => {
    const root = path.join(userData, 'updates');
    mkdirSync(root);
    const { asked } = github({ fail: 'release' });
    await checkForUpdates();
    expect(readdirSync(root)).toEqual([]);
    expect(asked).toEqual(['latest']);
    expect(updateStatus().stage).toBe('failed');
  });
  it('handles a 1024-directory mixed cache while preserving reset custody and retained entries', async () => {
    const obsolete = Array.from({ length: 128 }, (_, i) => cached(`0.0.${i}`));
    const future = Array.from({ length: 128 }, (_, i) => cached(`99.0.${i}`, 'future candidate'));
    const root = path.join(userData, 'updates');
    const unknown = Array.from({ length: 384 }, (_, i) => path.join(root, `saved-${i}`));
    const damaged = Array.from({ length: 384 }, (_, i) => path.join(root, `2.1.${i}-damaged`));
    for (const dir of [...unknown, ...damaged]) mkdirSync(dir);
    const keep = path.join(unknown[0]!, 'keep');
    writeFileSync(keep, 'unrecognized root entry');
    const note = path.join(root, 'handoff.json'), receipt = JSON.stringify({ version: '98.0.0', at: 1 });
    writeFileSync(note, receipt);
    const { asked } = github({ fail: 'release' });
    const boundary = pauseAfter('readdir', root);
    const old = checkForUpdates();
    await boundary.paused;
    resetUpdateForTests(); boundary.resume();
    await old;
    expect(obsolete.every(existsSync)).toBe(true);
    expect(asked).toEqual([]);
    expect(updateStatus().stage).toBe('idle');

    await checkForUpdates();
    expect(obsolete.some(existsSync)).toBe(false);
    expect([...future, ...unknown, ...damaged].every(existsSync)).toBe(true);
    expect(readFileSync(path.join(future[0]!, 'download.part'), 'utf8')).toBe('future candidate');
    expect(readFileSync(keep, 'utf8')).toBe('unrecognized root entry');
    expect(readFileSync(note, 'utf8')).toBe(receipt);
    expect(asked).toEqual(['latest']);
    expect(updateStatus().stage).toBe('failed');
  });
  it.each(['lstat', 'readdir'])('does not prune or contact GitHub after a reset during cache %s', async operation => {
    const previous = cached('0.0.1');
    const { asked } = github();
    const boundary = pauseAfter(operation, path.join(userData, 'updates'));
    const old = checkForUpdates();
    await boundary.paused;
    resetUpdateForTests();
    boundary.resume();
    await old;
    expect(existsSync(previous)).toBe(true);
    expect(asked).toEqual([]);
    expect(updateStatus().stage).toBe('idle');
  });
  it('stops cleanup between entries when the pass is reset', async () => {
    const first = cached('0.0.1');
    const second = cached('0.0.2');
    const { asked } = github();
    const boundary = pauseAfter('rm', first);
    const old = checkForUpdates();
    await boundary.paused;
    resetUpdateForTests();
    boundary.resume();
    await old;
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(asked).toEqual([]);
    expect(updateStatus().stage).toBe('idle');
  });
  it('does not retire other candidates after a reset during successful adoption cleanup', async () => {
    const previous = cached('98.0.0');
    const dir = cached(NEXT);
    writeFileSync(path.join(dir, WINDOWS_ASSET), 'installer bytes');
    const { asked } = github();
    // The first root inspection is the offline cleanup; the second retires other candidates.
    const boundary = pauseAfter('lstat', path.join(userData, 'updates'), 2);
    const old = asPlatform('win32', undefined, () => checkForUpdates());
    await boundary.paused;
    resetUpdateForTests();
    boundary.resume();
    await old;
    expect(existsSync(previous)).toBe(true);
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt']);
    expect(updateStatus().stage).toBe('idle');
    expect(markInstallOnQuit()).toBe(false);
  });
  it.each(['lstat', 'mkdir'])('does not remove a partial file after a reset during directory %s', async operation => {
    const dir = cached(NEXT);
    const partial = path.join(dir, `${WINDOWS_ASSET}.part`);
    writeFileSync(partial, 'keep this partial');
    const { asked } = github();
    const boundary = pauseAfter(operation, dir);
    const old = asPlatform('win32', undefined, () => checkForUpdates());
    await boundary.paused;
    resetUpdateForTests();
    boundary.resume();
    await old;
    expect(readFileSync(partial, 'utf8')).toBe('keep this partial');
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt']);
    expect(updateStatus().stage).toBe('idle');
    expect(markInstallOnQuit()).toBe(false);
  });
  it('preserves a newer pass\'s ready installer when obsolete cleanup resumes after a reset', async () => {
    const dir = cached(NEXT);
    writeFileSync(path.join(dir, WINDOWS_ASSET), 'installer bytes');
    github();
    const boundary = pauseAfter('lstat', path.join(userData, 'updates'), 2);
    const old = asPlatform('win32', undefined, () => checkForUpdates());
    await boundary.paused;
    resetUpdateForTests();
    const newer = '100.0.0';
    github({ version: newer });
    await checkForUpdates();
    boundary.resume();
    await old;
    expect(readFileSync(path.join(userData, 'updates', newer, WINDOWS_ASSET), 'utf8')).toBe('installer bytes');
    expect(updateStatus()).toMatchObject({ stage: 'ready', latest: newer, error: null });
    expect(markInstallOnQuit(newer)).toBe(true);
  });
  it('removes installed versions even offline, preserving future candidates and unknown contents', async () => {
    const old = cached('0.0.1');
    const current = cached(APP_VERSION);
    const future = cached(NEXT);
    const backup = cached('backup');
    const damaged = cached('2.1.49-damaged');
    github({ fail: 'release' });
    await checkForUpdates();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(current)).toBe(false);
    expect([future, backup, damaged].every(existsSync)).toBe(true);
    expect(updateStatus().stage).toBe('failed');
  });
  it('preserves a legacy flat installer while removing an obsolete version offline', async () => {
    const old = cached('0.0.1');
    const legacy = path.join(userData, 'updates', WINDOWS_ASSET);
    writeFileSync(legacy, 'legacy installer bytes');
    github({ fail: 'release' });
    await checkForUpdates();
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(legacy, 'utf8')).toBe('legacy installer bytes');
    expect(updateStatus().stage).toBe('failed');
  });
  it('never scans a version-shaped backup outside the updater-exclusive cache', async () => {
    const old = cached('0.0.1');
    const backup = path.join(userData, 'backups', '0.0.1');
    mkdirSync(backup, { recursive: true });
    const installer = path.join(backup, WINDOWS_ASSET);
    writeFileSync(installer, 'manually saved installer');
    github({ fail: 'release' });
    await checkForUpdates();
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(installer, 'utf8')).toBe('manually saved installer');
    expect(updateStatus().stage).toBe('failed');
  });
  it('keeps the previous candidate and the handoff note when a newer download fails', async () => {
    const previous = cached('98.0.0');
    const note = path.join(userData, 'updates', 'handoff.json');
    writeFileSync(note, JSON.stringify({ version: '98.0.0', at: 1 }));
    github({ fail: 'asset' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('failed');
    expect(existsSync(previous)).toBe(true);
    expect(JSON.parse(readFileSync(note, 'utf8')).version).toBe('98.0.0');
  });
  it('does not discard a previous candidate when the replacement fails its checksum', async () => {
    const previous = cached('98.0.0');
    github({ checksums: `${'a'.repeat(64)}  ${WINDOWS_ASSET}\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('failed');
    expect(existsSync(previous)).toBe(true);
  });
  it('defers a locked obsolete installer without failing the update or touching another file', async () => {
    cleanupFault.file = cached('0.0.1');
    const removable = cached('0.0.2');
    github({ version: APP_VERSION });
    await checkForUpdates();
    expect(updateStatus().stage).toBe('idle');
    expect(existsSync(cleanupFault.file)).toBe(true);
    expect(existsSync(removable)).toBe(false);
    expect(warnings).toContain('update: obsolete 0.0.1 download is still in use or cannot be removed; cleanup deferred');
  });
  it('retires superseded candidates only after verifying the replacement, keeping the handoff receipt', async () => {
    const previous = cached('98.0.0');
    const note = path.join(userData, 'updates', 'handoff.json');
    writeFileSync(note, JSON.stringify({ version: '98.0.0', at: 1 }));
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('ready');
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(path.join(userData, 'updates', NEXT, WINDOWS_ASSET))).toBe(true);
    expect(JSON.parse(readFileSync(note, 'utf8')).version).toBe('98.0.0');
    await restoreUpdateHandoff();
    expect(updateStatus().notInstalled).toBe('98.0.0');
  });
  it('cleans obsolete files when adopting an already verified download after restart', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    resetUpdateForTests();
    const previous = cached('98.0.0');
    const { asked } = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('ready');
    expect(existsSync(previous)).toBe(false);
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt']);
  });
  it('does not follow a version-directory link into a backup', async () => {
    const backup = path.join(userData, 'saved-app');
    mkdirSync(backup);
    writeFileSync(path.join(backup, 'keep'), 'backup');
    mkdirSync(path.join(userData, 'updates'));
    symlinkSync(backup, path.join(userData, 'updates', '0.0.1'), 'junction');
    github({ version: APP_VERSION });
    await checkForUpdates();
    expect(readFileSync(path.join(backup, 'keep'), 'utf8')).toBe('backup');
    expect(existsSync(path.join(userData, 'updates', '0.0.1'))).toBe(true);
  });
  it('skips a linked cache root, logging why without failing the release check', async () => {
    const backup = path.join(userData, 'saved-updates');
    mkdirSync(path.join(backup, '0.0.1'), { recursive: true });
    symlinkSync(backup, path.join(userData, 'updates'), 'junction');
    github({ version: APP_VERSION });
    await checkForUpdates();
    expect(existsSync(path.join(backup, '0.0.1'))).toBe(true);
    expect(updateStatus().stage).toBe('idle');
    expect(warnings).toContain('update: cache cleanup skipped because the updates root is not an ordinary directory');
  });
  it.each(['root', 'version'])('refuses a new download through a linked %s without overwriting its target', async linked => {
    const target = path.join(userData, 'outside-cache');
    const dir = linked === 'root' ? path.join(target, NEXT) : target;
    mkdirSync(dir, { recursive: true });
    const outside = path.join(dir, WINDOWS_ASSET);
    writeFileSync(outside, 'keep this file');
    const updates = path.join(userData, 'updates');
    if (linked === 'version') mkdirSync(updates);
    symlinkSync(target, linked === 'root' ? updates : path.join(updates, NEXT), 'junction');
    const { asked } = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(readFileSync(outside, 'utf8')).toBe('keep this file');
    expect(updateStatus()).toMatchObject({ stage: 'failed', error: 'the update staging path must use ordinary directories' });
    expect(markInstallOnQuit()).toBe(false);
    expect(existsSync(`${outside}.part`)).toBe(false);
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt']);
  });
  it.each(['root', 'version'])('preserves legacy checksum-verified adoption through a linked %s without new writes', async linked => {
    const target = path.join(userData, 'existing-downloads');
    const dir = linked === 'root' ? path.join(target, NEXT) : target;
    mkdirSync(dir, { recursive: true });
    const outside = path.join(dir, WINDOWS_ASSET);
    writeFileSync(outside, 'installer bytes');
    const updates = path.join(userData, 'updates');
    if (linked === 'version') mkdirSync(updates);
    symlinkSync(target, linked === 'root' ? updates : path.join(updates, NEXT), 'junction');
    const { asked } = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('ready');
    expect(readFileSync(outside, 'utf8')).toBe('installer bytes');
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt']);
    expect(spawned).toEqual([]);
  });
  it('restarts a linked partial file with a fresh inode instead of truncating its other name', async () => {
    const outside = path.join(userData, 'keep.txt');
    writeFileSync(outside, 'keep this file');
    const dir = path.join(userData, 'updates', NEXT);
    mkdirSync(dir, { recursive: true });
    linkSync(outside, path.join(dir, `${WINDOWS_ASSET}.part`));
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('ready');
    expect(readFileSync(outside, 'utf8')).toBe('keep this file');
    expect(readFileSync(path.join(dir, WINDOWS_ASSET), 'utf8')).toBe('installer bytes');
  });
  it('does not recursively erase an unexpected directory at the selected partial-file name', async () => {
    const dir = path.join(userData, 'updates', NEXT, `${WINDOWS_ASSET}.part`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'keep'), 'keep this file');
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('failed');
    expect(readFileSync(path.join(dir, 'keep'), 'utf8')).toBe('keep this file');
  });
  it('does not clean an installed app cache from an unpackaged developer run', async () => {
    const old = cached('0.0.1');
    packaged = false;
    github();
    await checkForUpdates();
    expect(existsSync(old)).toBe(true);
  });
});

describe('which installations update themselves', () => {
  it('takes the Windows installer and the Linux AppImage, and nothing else', () => {
    expect(stagedArtifact('win32', 'x64')).toMatchObject({ name: 'ChatMarks-Setup-x64.exe', kind: 'installer' });
    expect(stagedArtifact('linux', 'arm64', '/opt/cos.AppImage')).toMatchObject({
      name: 'ChatMarks-Linux-arm64.AppImage',
      kind: 'appimage',
      target: '/opt/cos.AppImage'
    });
  });

  it('stages a digest-verified Linux package, but requires an explicit install click', async () => {
    expect(stagedArtifact('linux', 'x64', undefined)).toMatchObject({ kind: 'deb', name: 'ChatMarks-Linux-x64.deb' });
    expect(stagedArtifact('darwin', 'arm64')).toBeNull();
    const { asked } = github();
    await asPlatform('linux', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', DEB_ASSET]);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });

  it('requires proof that dpkg owns the actual binary before selecting a Debian update', async () => {
    setDebPackageProofForTests(installedDebBinary);
    const expectedBinary = realpathSync(process.execPath);
    await asPlatform('linux', undefined, async () => {
      dpkg.installed = false;
      expect(stagedArtifact('linux', 'x64', undefined, true)).toBeNull();
      expect(dpkg.calls).toEqual([['--show', '--showformat=${Status}', 'chat-on-steroids']]);
      dpkg.calls.length = 0;
      dpkg.installed = true;
      dpkg.owner = 'another-package: /usr/bin/node';
      expect(stagedArtifact('linux', 'x64', undefined, true)).toBeNull();
      expect(dpkg.calls[1]).toMatchObject(['--search', '--', expect.any(String)]);
      dpkg.owner = `chat-on-steroids: ${expectedBinary}`;
      expect(stagedArtifact('linux', 'x64', undefined, true)).toMatchObject({ kind: 'deb' });
      // APPIMAGE remains authoritative even if dpkg has no record for the executable.
      expect(stagedArtifact('linux', 'x64', '/tmp/appimage', true)).toMatchObject({ kind: 'appimage' });
      dpkg.installed = false;
      dpkg.calls.length = 0;
      github();
      await checkForUpdates();
      expect(updateStatus()).toMatchObject({ stage: 'idle', latest: NEXT });
      expect(dpkg.calls).toHaveLength(1);
    });
  });

  /**
   * A development tree is not an installation. It is permanently "behind" the moment a release
   * ships, and staging for it would mean quitting `electron-vite dev` silently ran an NSIS
   * installer over the maintainer's real per-user install.
   */
  it('never stages for an unpackaged run', async () => {
    packaged = false;
    expect(stagedArtifact('win32', 'x64')).toBeNull();

    const { asked } = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
    expect(asked).toEqual(['latest']);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });
});

describe('finding a newer release', () => {
  it('reads a release tag, and refuses anything that is not one', () => {
    expect(releaseVersion('v2.1.0')).toBe('2.1.0');
    expect(releaseVersion('2.1.0')).toBe('2.1.0');
    expect(releaseVersion('v2.1.37.1')).toBe('2.1.37.1');
    expect(releaseVersion('v2.1.37.1.2')).toBeNull();
    expect(manualDownloadUrl('2.1.37.1', 'ChatMarks-Linux-x64.deb')).toBe('https://github.com/mvclaudianobj/chat-on-steroids/releases/download/v2.1.37.1/ChatMarks-Linux-x64.deb');
    expect(releaseVersion('v2.1.0-rc.1')).toBeNull();
    expect(releaseVersion(null)).toBeNull();
  });

  /** A published downgrade must not install itself over a newer app. */
  it('compares versions as numbers, not as strings', () => {
    expect(isNewer('2.0.10', '2.0.9')).toBe(true);
    expect(isNewer('2.0.9', '2.0.10')).toBe(false);
    expect(isNewer('2.0.2', '2.0.2')).toBe(false);
    expect(isNewer('1.9.9', '2.0.0')).toBe(false);
    expect(isNewer('2.1.37.1', '2.1.37')).toBe(true);
    expect(isNewer('2.1.37', '2.1.37.1')).toBe(false);
    expect(isNewer('2.1.37.2', '2.1.37.1')).toBe(true);
    expect(isNewer('2.1.38', '2.1.37.1')).toBe(true);
    expect(isNewer('2.1.37.0', '2.1.37')).toBe(false);
    expect(isNewer('2.1.37-rc.1', '2.1.36')).toBe(false);
  });

  /**
   * `checkedAt` is the difference between "checked, nothing to install" and "has not asked yet",
   * which are the same `{latest: null, stage: 'idle'}` record otherwise. The renderer says "up to
   * date" on the strength of that timestamp, so a pass that never reached GitHub must not set it.
   */
  it('reports nothing when the published release is the version already running', async () => {
    const { asked } = github({ version: APP_VERSION });
    expect(updateStatus().checkedAt).toBeNull();
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ current: APP_VERSION, latest: null, stage: 'idle' });
    expect(updateStatus().checkedAt).toBeGreaterThan(0);
    // It stopped at the release: no checksums, no artifact, nothing written.
    expect(asked).toEqual(['latest']);
    expect(readdirSync(userData)).toEqual([]);
  });
});

describe('asking again when Settings open', () => {
  it('asks GitHub only when the last answer is over ten minutes old', async () => {
    const { asked } = github({ version: APP_VERSION });
    // Never asked yet: it asks.
    await checkForUpdatesIfStale();
    expect(asked).toEqual(['latest']);
    const checkedAt = updateStatus().checkedAt!;
    // A fresh answer stands.
    await checkForUpdatesIfStale(checkedAt + 9 * 60_000);
    expect(asked).toEqual(['latest']);
    // An old one does not: 2.1.27 said "Up to date" for hours after 2.1.28 was published.
    await checkForUpdatesIfStale(checkedAt + 11 * 60_000);
    expect(asked).toEqual(['latest', 'latest']);
  });
});

describe('staging the new version', () => {
  it('downloads the artifact, checks it against the published SHA-256, and installs it on quit', async () => {
    const { asked, body } = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);

    const staged = path.join(userData, 'updates', NEXT, WINDOWS_ASSET);
    expect(readFileSync(staged, 'utf8')).toBe(body);
    expect(existsSync(`${staged}.part`)).toBe(false);

    // The quit half of the restart: the file that was staged is the one handed over, silently,
    // and without starting the app again behind a user who quit for their own reasons.
    await applyStagedUpdate();
    expect(spawned).toEqual([{ file: staged, args: ['/S', '--updated'] }]);
    expect(spawnOptions[0]?.windowsHide).toBe(true);
  });

  /**
   * #1490: the installer re-grants the Chromium sandbox read access on the install folder, which
   * needs the right to change its permissions. In a folder an administrator created (a custom
   * D:\\ path, C:\\Program Files) a user may write files but not that, so the silent installer
   * stopped and nothing said so. Windows now asks for permission; a per-user install stays silent.
   */
  it('asks Windows for permission when the install folder needs an administrator', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    const staged = path.join(userData, 'updates', NEXT, WINDOWS_ASSET);
    setInstallFolderAccessForTests(async () => false);
    expect(markInstallOnQuit(NEXT)).toBe(true);
    await asPlatform('win32', undefined, () => applyStagedUpdate());
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.file).toBe('powershell.exe');
    const script = spawned[0]!.args.at(-1)!;
    expect(script).toContain(`Start-Process -FilePath '${staged.replaceAll("'", "''")}'`);
    // Asked to install now: the installer is shown, not silent (2026-10-15).
    expect(script).toContain("-ArgumentList '--updated','--force-run'");
    expect(script).toContain('-Verb RunAs');
  });

  it('waits for Windows to answer, with the permission step attached to this app', async () => {
    // 2026-10-15, Windows VM: started detached, PowerShell had no console and ran nothing, so no
    // prompt ever showed. Attached, it ends with this app unless the handoff waits for the answer.
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    setInstallFolderAccessForTests(async () => false);
    elevation.exitCode = 'held';
    let handedOver = false;
    const handoff = asPlatform('win32', undefined, () => applyStagedUpdate()).then(() => { handedOver = true; });
    await vi.waitFor(() => expect(elevation.finish).not.toBeNull());
    expect(spawnOptions[0]?.detached).not.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(handedOver).toBe(false);
    elevation.finish!(0);
    await handoff;
    expect(warnings).toEqual([]);
  });

  it('says so when Windows does not give permission', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    setInstallFolderAccessForTests(async () => false);
    elevation.exitCode = 1;
    await asPlatform('win32', undefined, () => applyStagedUpdate());
    expect(warnings).toEqual([expect.stringContaining(`Windows did not give permission, so ${NEXT} was not installed`)]);
    // The next start still says the version did not install.
    expect(JSON.parse(readFileSync(path.join(userData, 'updates', 'handoff.json'), 'utf8'))).toMatchObject({ version: NEXT });
  });

  it('names the version a quit installs for a person waiting on it, and reports each handoff step', async () => {
    // The app shows its own "Installing" window from the quit until the installer takes over.
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(installingVersion()).toBeNull();
    expect(markInstallOnQuit(NEXT)).toBe(true);
    expect(installingVersion()).toBe(NEXT);
    const steps: string[] = [];
    onUpdateHandoffStep(step => steps.push(step));
    setInstallFolderAccessForTests(async () => false);
    await asPlatform('win32', undefined, () => applyStagedUpdate());
    expect(steps).toEqual(['permission', 'installer']);
    expect(installingVersion()).toBeNull();
    // A refused prompt reaches no installer.
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(markInstallOnQuit(NEXT)).toBe(true);
    steps.length = 0; elevation.exitCode = 1;
    await asPlatform('win32', undefined, () => applyStagedUpdate());
    expect(steps).toEqual(['permission']);
    onUpdateHandoffStep(() => undefined);
  });

  it('keeps the silent per-user install when the folder is the user’s own', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    setInstallFolderAccessForTests(async () => true);
    await asPlatform('win32', undefined, () => applyStagedUpdate());
    expect(spawned).toEqual([{ file: path.join(userData, 'updates', NEXT, WINDOWS_ASSET), args: ['/S', '--updated'] }]);
  });

  it('decides by repeating the installer’s own access grant on the app folder', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    for (const [result, elevated] of [[5, true], [null, false], ['ENOENT', false]] as const) {
      spawned.length = 0; icacls.calls.length = 0; icacls.result = result;
      await asPlatform('win32', undefined, () => applyStagedUpdate());
      expect(icacls.calls).toEqual([{ file: expect.stringMatching(/icacls\.exe$/i),
        args: [path.dirname(process.execPath), '/grant', '*S-1-15-2-2:(OI)(CI)(RX)', '/Q'] }]);
      expect(spawned[0]?.file === 'powershell.exe', String(result)).toBe(elevated);
      await asPlatform('win32', undefined, () => checkForUpdates());
    }
    icacls.result = null;
  });

  /**
   * #1490: the installer failed silently and the next start was simply the old version again, with
   * nothing said. The handover leaves a note; a start that is still older than it says so once.
   */
  it('says at the next start when the handed-over version did not install', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    setInstallFolderAccessForTests(async () => true);
    await asPlatform('win32', undefined, () => applyStagedUpdate());
    const note = path.join(userData, 'updates', 'handoff.json');
    expect(JSON.parse(readFileSync(note, 'utf8'))).toMatchObject({ version: NEXT });
    resetUpdateForTests();
    await restoreUpdateHandoff();
    expect(updateStatus().notInstalled).toBe(NEXT);
    expect(existsSync(note)).toBe(false);
    // Said once: the next start no longer repeats it.
    resetUpdateForTests();
    await restoreUpdateHandoff();
    expect(updateStatus().notInstalled ?? null).toBeNull();
  });

  it('forgets the note quietly when the handed-over version is the one running', async () => {
    const note = path.join(userData, 'updates', 'handoff.json');
    mkdirSync(path.dirname(note), { recursive: true });
    writeFileSync(note, JSON.stringify({ version: APP_VERSION, at: Date.now() }));
    await restoreUpdateHandoff();
    expect(updateStatus().notInstalled ?? null).toBeNull();
    expect(existsSync(note)).toBe(false);
  });

  it('clears the notice once the update is installed again', async () => {
    const note = path.join(userData, 'updates', 'handoff.json');
    mkdirSync(path.dirname(note), { recursive: true });
    writeFileSync(note, JSON.stringify({ version: NEXT, at: Date.now() }));
    await restoreUpdateHandoff();
    expect(updateStatus().notInstalled).toBe(NEXT);
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(markInstallOnQuit(NEXT)).toBe(true);
    expect(updateStatus().notInstalled ?? null).toBeNull();
  });

  /**
   * The one that a length check would wave through, and the reason the digest is the bar: the
   * artifact that arrives is the wrong build at exactly the right size. Nothing may be staged,
   * and nothing may be left on disk for a later quit to find.
   */
  it('stages nothing when the artifact is not the file the release published', async () => {
    github({ checksums: `${sha256('a different build')}  ${WINDOWS_ASSET}\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(updateStatus().stage).toBe('failed');
    expect(updateStatus().error).toContain('not the published file');
    // The `.part` is gone with it: nothing a later quit could find and run is left behind.
    expect(readdirSync(path.join(userData, 'updates', NEXT))).toEqual([]);

    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });

  it('stages nothing when the release does not publish an artifact for this installation', async () => {
    github({ checksums: `${sha256('x')}  ChatMarks-Extension.zip\n` });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('failed');
    expect(updateStatus().error).toContain(`publishes no ${WINDOWS_ASSET}`);
    expect(spawned).toEqual([]);
  });

  it('refuses to stage or install a Debian release when the published SHA256SUMS.txt is absent', async () => {
    const { asked } = github({ fail: 'sums' });
    await asPlatform('linux', undefined, () => checkForUpdates());
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', `v${NEXT}`]);
    // The release exists, but without a checksum it cannot become an installable offer.
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    expect(updateStatus().error).toContain('no usable GitHub SHA-256 asset digests');
    expect(markInstallOnQuit()).toBe(false);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });

  it('stages a Debian update using the official GitHub asset digest when SHA256SUMS.txt is absent', async () => {
    const { asked } = github({ fail: 'sums', releaseAssets: [publishedAsset(NEXT, DEB_ASSET, sha256('installer bytes'))] });
    await asPlatform('linux', undefined, () => checkForUpdates());
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', `v${NEXT}`, DEB_ASSET]);
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(readFileSync(path.join(userData, 'updates', NEXT, DEB_ASSET), 'utf8')).toBe('installer bytes');
    // Preparing an update never prompts PolicyKit, installs packages, or modifies the OS.
    expect(spawned).toEqual([]);
  });

  it('never overrides a present but contradictory SHA256SUMS.txt with API asset metadata', async () => {
    const { asked } = github({ checksums: `${sha256('different package')}  ${DEB_ASSET}\n`,
      releaseAssets: [publishedAsset(NEXT, DEB_ASSET, sha256('installer bytes'))] });
    await asPlatform('linux', undefined, () => checkForUpdates());
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', DEB_ASSET]);
    expect(updateStatus().stage).toBe('failed');
    expect(updateStatus().error).toContain('not the published file');
    expect(spawned).toEqual([]);
  });

  it('rejects untrusted, mismatched or missing GitHub asset metadata without installing anything', async () => {
    const badAssets = [
      [publishedAsset(NEXT, DEB_ASSET, '0'.repeat(64))],
      [publishedAsset(NEXT, DEB_ASSET, sha256('installer bytes'), { state: 'starter' })],
      [publishedAsset(NEXT, DEB_ASSET, sha256('installer bytes'), {
        browser_download_url: `https://github.com/totec448-spec/chat-on-steroids/releases/download/v${NEXT}/${DEB_ASSET}`
      })],
      [publishedAsset(NEXT, DEB_ASSET, sha256('installer bytes'), { digest: 'sha256:INVALID' })]
    ];
    for (const releaseAssets of badAssets) {
      resetUpdateForTests();
      github({ fail: 'sums', releaseAssets });
      await asPlatform('linux', undefined, () => checkForUpdates());
      expect(updateStatus().stage).toBe('failed');
      expect(markInstallOnQuit()).toBe(false);
      expect(spawned).toEqual([]);
    }
  });

  /**
   * An AppImage has no installer: the running file is the whole application, so the update is
   * that file being replaced. By rename, never by writing through it - the old build is still
   * executing out of that path while this runs.
   */
  it('replaces the running AppImage with the staged one', async () => {
    const live = path.join(userData, 'Chat-On-Steroids.AppImage');
    writeFileSync(live, 'the old build');
    const { body } = github();

    await asPlatform('linux', live, async () => {
      await checkForUpdates();
      expect(updateStatus().stage).toBe('ready');
      await applyStagedUpdate();
    });

    expect(readFileSync(live, 'utf8')).toBe(body);
    expect(existsSync(`${live}.new`)).toBe(false);
    expect(spawned).toEqual([]);
  });
});

describe('one pass at a time, and one more next time the app opens', () => {
  it('joins a check that is already running instead of downloading twice', async () => {
    const { asked } = github();
    await asPlatform('win32', undefined, async () => {
      await Promise.all([checkForUpdates(), checkForUpdates(), checkForUpdates()]);
    });
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);
    expect(updateStatus().stage).toBe('ready');
  });

  /**
   * The only schedule this has is the app being opened, so a pass that failed has to leave
   * itself repeatable. A retained in-flight promise would turn one unreachable network into an
   * app that never checks again for as long as it runs.
   */
  it('retries the next time the app opens after a check that could not reach GitHub', async () => {
    github({ fail: 'release' });
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed', checkedAt: null });
    expect(updateStatus().error).toContain('503');

    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
  });

  it('finds the release from the public page when GitHub\'s API refuses the check (#1253)', async () => {
    for (const status of [403, 404, 429]) {
      resetUpdateForTests();
      github({ apiStatus: status });
      await asPlatform('win32', undefined, () => checkForUpdates());
      expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    }
  });

  it.each([
    { tag_name: null, draft: false, prerelease: false },
    { tag_name: 'not-semver', draft: false, prerelease: false },
    { tag_name: 'v99.0.0-rc.1', draft: false, prerelease: true },
    { tag_name: 'v99.0.0', draft: true, prerelease: false },
    { tag_name: 'v99.0.0', draft: false, prerelease: true },
    { tag_name: 'v99.0.0', draft: undefined, prerelease: undefined },
    { tag_name: '99.0.0', draft: false, prerelease: false }
  ])('recovers the public stable Marks release when the API latest metadata is unusable: %j', async releasePayload => {
    const { asked } = github({ releasePayload });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(asked).toEqual(['latest', 'latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(warnings).toContain('update: GitHub latest release API returned no usable published stable Marks tag; checking the public latest release page');
  });

  it('recovers a malformed API JSON body through the stable release page', async () => {
    const { asked } = github({ apiBody: 'unexpected non-JSON upstream response' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(asked).toEqual(['latest', 'latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
  });

  it('trusts the release page only when it lands on a version tag on github.com', async () => {
    for (const page of ['https://evil.example/mvclaudianobj/chat-on-steroids/releases/tag/v9.9.9',
      'https://github.com/totec448-spec/chat-on-steroids/releases/tag/v9.9.9',
      'https://github.com/mvclaudianobj/chat-on-steroids/releases/tag/v9.9.9/more',
      'https://github.com/mvclaudianobj/chat-on-steroids/releases', 404]) {
      resetUpdateForTests();
      github({ apiStatus: 403, page });
      await asPlatform('win32', undefined, () => checkForUpdates());
      expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    }
    resetUpdateForTests();
    github({ releasePayload: { tag_name: 'v99.0.0', draft: true, prerelease: false },
      page: 'https://github.com/totec448-spec/chat-on-steroids/releases/tag/v99.0.0' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed' });
    // Other API failures are not quota refusals and keep their own error.
    resetUpdateForTests();
    const { fetch } = github({ fail: 'release' });
    await checkForUpdates();
    expect(updateStatus().error).toContain('503');
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain('https://github.com/mvclaudianobj/chat-on-steroids/releases/latest');
  });

  it('retries the next time the app opens after a download that stopped', async () => {
    github({ fail: 'asset' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'failed' });

    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('ready');
  });

  /** Already staged: the same release is not fetched a second time. */
  it('does not download a version it has already staged', async () => {
    const first = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(first.asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);

    const second = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(second.asked).toEqual(['latest']);
    expect(updateStatus().stage).toBe('ready');
  });

  /** Handed over once. A second quit has nothing to install and must not re-run an installer. */
  it('hands a staged update over exactly once', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    await applyStagedUpdate();
    await applyStagedUpdate();
    expect(spawned).toHaveLength(1);
  });
});

/**
 * The failure this exists for: this app is closed to the tray and can go days without a real
 * quit, and a staged artifact used to live only in the memory of the process that fetched it.
 * Every start after that downloaded the same hundred megabytes, staged it, and ended in the
 * same place - and any start that ended by being killed rather than quit applied none of it.
 */
describe('a download that survives the process that fetched it', () => {
  it('reuses the artifact a previous run already staged instead of fetching it again', async () => {
    const first = github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(first.asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);

    // A new run of the app: same disk, no memory of what the last one did.
    resetUpdateForTests();
    const second = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    // The sums are read again — the proof has to be current, not remembered — and the artifact
    // itself is not. That request is the hundred megabytes.
    expect(second.asked).toEqual(['latest', 'SHA256SUMS.txt']);
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });

    await applyStagedUpdate();
    expect(spawned).toEqual([
      { file: path.join(userData, 'updates', NEXT, WINDOWS_ASSET), args: ['/S', '--updated'] }
    ]);
  });

  /**
   * Reuse is never trust. A file that no longer matches what the release publishes - a corrupted
   * disk, a re-cut release under the same tag - is not adopted and not run; it is fetched again.
   */
  it('fetches again when the artifact on disk is not what the release publishes', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    writeFileSync(path.join(userData, 'updates', NEXT, WINDOWS_ASSET), 'something else entirely');

    resetUpdateForTests();
    const second = github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(second.asked).toEqual(['latest', 'SHA256SUMS.txt', WINDOWS_ASSET]);
    expect(updateStatus().stage).toBe('ready');
    expect(readFileSync(path.join(userData, 'updates', NEXT, WINDOWS_ASSET), 'utf8')).toBe(second.body);
  });

  /** A staged build for a release nobody is going to install is not kept alongside the new one. */
  it('keeps one version staged at a time', async () => {
    github({ version: '98.0.0' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(readdirSync(path.join(userData, 'updates'))).toEqual(['98.0.0']);

    resetUpdateForTests();
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(readdirSync(path.join(userData, 'updates'))).toEqual([NEXT]);
  });
});

/**
 * The Install button. It applies nothing itself: it records that the user is waiting, and the
 * quit it triggers runs the same handoff every other quit runs. The difference the flag makes is
 * the one the user can see - the app comes back.
 */
describe('installing on request', () => {
  it('refuses an Update all handoff for a different release than the verified staged artifact', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(markInstallOnQuit('98.0.0')).toBe(false);
    expect(markInstallOnQuit(NEXT)).toBe(true);
  });
  it('shows the installer to a person waiting for it and asks it to start the app again', async () => {
    // 2026-10-15: silent, the app vanished for about 100 s with nothing on screen. The installer's
    // own progress window now shows and closes itself (scripts/windows-installer-acl.nsh).
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());

    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();
    expect(spawned).toEqual([
      { file: path.join(userData, 'updates', NEXT, WINDOWS_ASSET), args: ['--updated', '--force-run'] }
    ]);
    // Measured on Windows: started with windowsHide, the installer's window stayed hidden too.
    expect(spawnOptions[0]?.windowsHide).not.toBe(true);
  });

  it('waits for the shown installer to take over, and never for a silent one', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    let waits = 0;
    onInstallerTakeover(async () => { waits++; });
    expect(markInstallOnQuit()).toBe(true);
    await asPlatform('win32', undefined, () => applyStagedUpdate());
    expect(waits).toBe(1);
    await asPlatform('win32', undefined, () => checkForUpdates());
    await asPlatform('win32', undefined, () => applyStagedUpdate());
    expect(waits, 'an ordinary quit installs silently and exits').toBe(1);
    onInstallerTakeover(async () => undefined);
  });

  it('installs a verified Debian package only after clicking Install, via the system PolicyKit agent', async () => {
    github();
    await asPlatform('linux', undefined, async () => {
      await checkForUpdates();
      expect(updateStatus().stage).toBe('ready');
      expect(markInstallOnQuit()).toBe(true);
      await applyStagedUpdate();
    });
    expect(spawned).toHaveLength(1);
    const [installer] = spawned;
    expect(installer!.file).toBe('/bin/sh');
    expect(installer!.args[0]).toBe('-c');
    expect(installer!.args[1]).toContain('/usr/bin/pkexec /usr/bin/python3 -c "$helper" "$deb" "$digest"');
    expect(installer!.args[1]).not.toContain('/usr/bin/pkexec /usr/bin/apt-get');
    expect(installer!.args[1]).toContain('Chat Marks .deb update cancelled');
    expect(installer!.args[1]).toContain('pkexec exit %s');
    expect(installer!.args[1]).toContain('kill -0 "$old_pid"');
    // CI also runs this Linux-handoff fixture on Windows, where /bin/sh is not installed.
    // Verify the emitted shell syntax only on hosts with a POSIX shell.
    if (process.platform !== 'win32') {
      expect(spawnSync('/bin/sh', ['-n'], { input: installer!.args[1], encoding: 'utf8' }).status).toBe(0);
    }
    expect(installer!.args[3]).toBe(path.join(userData, 'updates', NEXT, DEB_ASSET));
    expect(installer!.args[4]).toBe(sha256('installer bytes'));
    expect(installer!.args[5]).toBe(userData);
    expect(installer!.args[7]).toBe(String(process.pid));
    expect(installer!.args[8]).toBe(DEBIAN_ROOT_INSTALL_SCRIPT);
    expect(installer!.args[1]).toBe(DEBIAN_HANDOFF_SH);
    expect(DEBIAN_ROOT_INSTALL_SCRIPT).toContain('os.O_NOFOLLOW');
    expect(DEBIAN_ROOT_INSTALL_SCRIPT).toContain('os.fstat');
    expect(DEBIAN_ROOT_INSTALL_SCRIPT).toContain('hmac.compare_digest(digest.hexdigest(), expected)');
    expect(DEBIAN_ROOT_INSTALL_SCRIPT).toContain('subprocess.run(["/usr/bin/apt-get", "install", "--assume-yes", "--only-upgrade", target], check=True)');
    expect(DEBIAN_ROOT_INSTALL_SCRIPT).not.toContain('subprocess.run(["/usr/bin/apt-get", "install", "--assume-yes", "--only-upgrade", source]');
    expect(JSON.parse(readFileSync(path.join(userData, 'updates', 'handoff.json'), 'utf8'))).toMatchObject({ version: NEXT });
  });

  it.skipIf(process.platform !== 'linux')('installs only a digest-checked root-private Debian snapshot, with apt entirely mocked', () => {
    // Exercise the actual privileged Python source as an ordinary user; replace subprocess.run
    // before exec so this fixture NEVER invokes apt or pkexec, even for a matching digest.
    const wrapper = [
      'import os, stat, subprocess, sys',
      'def fake_apt(argv, check=False):',
      '    assert argv[:4] == ["/usr/bin/apt-get", "install", "--assume-yes", "--only-upgrade"]',
      '    assert check is True',
      '    assert argv[-1] != sys.argv[1]',
      '    assert os.stat(os.path.dirname(argv[-1])).st_mode & 0o777 == 0o700',
      '    assert os.stat(argv[-1]).st_mode & 0o777 == 0o600',
      '    assert open(argv[-1], "rb").read() == b"verified package bytes"',
      '    print("MOCK_APT_PRIVATE_SNAPSHOT")',
      'subprocess.run = fake_apt',
      'exec(sys.stdin.read())'
    ].join('\n');
    const file = path.join(userData, 'file name; $(never-execute).deb');
    writeFileSync(file, 'verified package bytes');
    const run = (source: string) => spawnSync('/usr/bin/python3', ['-c', wrapper, source, sha256('verified package bytes')], {
      input: DEBIAN_ROOT_INSTALL_SCRIPT, encoding: 'utf8', timeout: 5000
    });
    const correct = run(file);
    expect(correct.status, correct.stderr).toBe(0);
    expect(correct.stdout).toContain('MOCK_APT_PRIVATE_SNAPSHOT');
    writeFileSync(file, 'changed after the JavaScript handoff digest');
    const swapped = run(file);
    expect(swapped.status).not.toBe(0);
    expect(swapped.stderr).toContain('changed since verification');
    expect(swapped.stdout).not.toContain('MOCK_APT_PRIVATE_SNAPSHOT');
    const link = path.join(userData, 'swapped-symlink.deb');
    symlinkSync(file, link);
    const linked = run(link);
    expect(linked.status).not.toBe(0);
    expect(linked.stdout).not.toContain('MOCK_APT_PRIVATE_SNAPSHOT');
    rmSync(link);
  });

  it('relaunches an AppImage install itself, having no installer to ask', async () => {
    const live = path.join(userData, 'Chat-On-Steroids.AppImage');
    writeFileSync(live, 'the old build');
    const { body } = github();

    await asPlatform('linux', live, async () => {
      await checkForUpdates();
      expect(markInstallOnQuit()).toBe(true);
      await applyStagedUpdate();
    });

    expect(readFileSync(live, 'utf8')).toBe(body);
    expect(relaunched).toEqual([{ execPath: live }]);
  });

  /** Nothing staged, nothing to do — and above all, no quit. */
  it('refuses when there is nothing downloaded to install', async () => {
    github({ version: APP_VERSION });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(markInstallOnQuit()).toBe(false);
  });

  /** The flag belongs to one press. A later ordinary quit must not reopen the app. */
  it('does not carry the request into the next quit', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();

    resetUpdateForTests();
    spawned.length = 0;
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    await applyStagedUpdate();
    expect(spawned).toEqual([
      { file: path.join(userData, 'updates', NEXT, WINDOWS_ASSET), args: ['/S', '--updated'] }
    ]);
  });
});

describe('staged executable authority across later events', () => {
  it('retires the old staged installer before a replacement download fails', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    github({ version: '99.0.1', fail: 'asset' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus().stage).toBe('failed');
    expect(markInstallOnQuit()).toBe(false);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });
  it('does not apply a staged release withdrawn from the latest feed', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    github({ version: APP_VERSION });
    await checkForUpdates();
    expect(markInstallOnQuit()).toBe(false);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });
  it('checks staged bytes again at the actual installer handoff', async () => {
    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    writeFileSync(path.join(userData, 'updates', NEXT, WINDOWS_ASSET), 'changed after download');
    await applyStagedUpdate();
    expect(spawned).toEqual([]);
  });
  it('starts immediately and repeats on the unreferenced six-hour timer', async () => {
    const unref = vi.fn();
    let repeat: (() => void) | undefined;
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
      expect(delay).toBe(6 * 60 * 60_000);
      repeat = callback;
      return { unref };
    }) as unknown as typeof setInterval);
    try {
      const { startUpdateChecks } = await import('../src/main/update.js');
      const first = github({ version: APP_VERSION });
      startUpdateChecks(); await checkForUpdates();
      expect(first.asked).toEqual(['latest']); expect(unref).toHaveBeenCalledOnce();
      const next = github({ version: APP_VERSION });
      repeat!(); await checkForUpdates();
      expect(next.asked).toEqual(['latest']);
    } finally { interval.mockRestore(); }
  });
});

describe('a check or download that goes wrong on a bad connection', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each(['API', 'public release page', 'artifact'] as const)('explains a rejected %s request, keeps its diagnostic and can retry', async request => {
    const { fetch } = github({ apiStatus: request === 'public release page' ? 403 : undefined });
    const answer = fetch.getMockImplementation()!;
    const target = request === 'API' ? 'https://api.github.com/repos/mvclaudianobj/chat-on-steroids/releases/latest'
      : request === 'public release page' ? 'https://github.com/mvclaudianobj/chat-on-steroids/releases/latest'
      : `https://github.com/mvclaudianobj/chat-on-steroids/releases/download/v${NEXT}/${WINDOWS_ASSET}`;
    fetch.mockImplementation(async input => {
      if (String(input) === target) {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
      }
      return answer(input);
    });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({
      latest: request === 'artifact' ? NEXT : null, stage: 'failed', error: 'GitHub could not be reached'
    });
    expect(fetch).toHaveBeenCalledTimes(request === 'API' ? 1 : request === 'public release page' ? 2 : 3);
    expect(warnings).toContain('update check failed: fetch failed');
    expect(markInstallOnQuit()).toBe(false);
    await applyStagedUpdate();
    expect(spawned).toEqual([]);

    github();
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
  });

  it.each([
    new Error('fetch failed'),
    new TypeError('Invalid URL'),
    new Error('EACCES: permission denied')
  ])('preserves an unrelated updater error: %s', async failure => {
    const { fetch } = github();
    fetch.mockRejectedValueOnce(failure);
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed', error: failure.message });
    expect(warnings).toContain(`update check failed: ${failure.message}`);
  });

  /**
   * The app starts at login, often before the network is up. The check failed, Activity showed
   * "update check failed" in red, and nothing asked again for six hours.
   */
  it('asks again a minute after a failed check, then leaves a successful one alone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const offline = github({ fail: 'release' });
    startUpdateChecks();
    await vi.waitFor(() => expect(updateStatus().stage).toBe('failed'));
    expect(offline.asked).toEqual(['latest']);
    const online = github();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(online.asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(updateStatus().checkedAt).not.toBeNull());
    // checkedAt records GitHub's answer before staging finishes: drain the prior pass so
    // its still-running download cannot reach into the next test's fresh platform mock.
    await checkForUpdates();
    expect(updateStatus().error).toBeNull();
    const calls = online.asked.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(online.asked).toHaveLength(calls);
  });

  /**
   * A pass still waiting for the installer when the state is reset belongs to the reset before it.
   * It used to finish anyway: it wrote the installer into the staging folder and set it as staged,
   * so the next check announced "ready" without downloading anything (CodeRabbit on #2018).
   */
  it('leaves no file and no staged update behind from a pass that outlived a reset', async () => {
    const { fetch } = github();
    const answer = fetch.getMockImplementation()!;
    let release: (() => void) | null = null;
    fetch.mockImplementation(async (input: string | URL) => {
      if (!String(input).endsWith(WINDOWS_ASSET)) return answer(input);
      // Answers only when the test says so, and as the real fetch would even if the pass was told to stop.
      await new Promise<void>(resolve => { release = resolve; });
      return answer(input);
    });
    const old = asPlatform('win32', undefined, () => checkForUpdates());
    await vi.waitFor(() => expect(release).not.toBeNull(), { timeout: 10_000 });
    resetUpdateForTests();
    release!();
    await old;
    expect(updateStatus().stage).toBe('idle');
    expect(existsSync(path.join(userData, 'updates', NEXT))
      ? readdirSync(path.join(userData, 'updates', NEXT)) : []).toEqual([]);
    // The next check has nothing staged to fall back on: it fetches the installer itself.
    const next = github({ fail: 'asset' });
    await asPlatform('win32', undefined, () => checkForUpdates());
    expect(next.asked).toContain(WINDOWS_ASSET);
    expect(updateStatus().stage).toBe('failed');
  });

  it('gives up on a download only when no data arrives for a minute, however long the whole file takes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const body = 'installer bytes';
    // One chunk, then silence: the connection is still open but nothing comes. `pull` runs once the
    // chunk has been taken, and the download restarts its 60-second watch on each chunk, so the clock
    // moves only after that: on a slow runner the chunk used to arrive after the jump, the watch
    // restarted there, and the test waited out its timeout (14 retries in 15 CI runs, 2026-11-01).
    let taken = false;
    // A fresh stream per request: a pass left over from an earlier test can still reach this fake and
    // took the one shared stream first, so this test's own download found it used ("Response body object
    // should not be disturbed or locked") and failed — every other run on Windows (#2008).
    const stalled = () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(body.slice(0, 5))); },
      pull() { taken = true; return new Promise<void>(() => undefined); }
    });
    const { fetch } = github({ body });
    const answer = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input: string | URL) => String(input).endsWith(WINDOWS_ASSET) ? new Response(stalled(), { status: 200 }) : answer(input));
    let done = false;
    const pass = asPlatform('win32', undefined, () => checkForUpdates()).then(() => { done = true; });
    await vi.waitFor(() => expect(taken).toBe(true), { timeout: 10_000, interval: 5 });
    expect(updateStatus().stage).toBe('downloading');
    // The chunk's 'data' event (which restarts the watch) runs on Node's own queue, not the faked timers.
    await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await pass;
    expect(updateStatus()).toMatchObject({ stage: 'failed', latest: NEXT });
    expect(updateStatus().error).toContain('no data for 60 seconds');
  });
});
