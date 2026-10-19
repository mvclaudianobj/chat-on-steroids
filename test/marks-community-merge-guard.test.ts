import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Skill scripts are deliberately standalone Node .mjs CLIs without application typings.
import { compareSha, preflight, recovery } from '../.agents/skills/marks-community-merge/scripts/merge-guard.mjs';
// @ts-expect-error Skill scripts are deliberately standalone Node .mjs CLIs without application typings.
import { executeReleaseCommands, releaseCommands } from '../.agents/skills/marks-community-merge/scripts/local-release.mjs';

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(repo: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture() {
  const parent = mkdtempSync(path.join(tmpdir(), 'marks-community-merge-'));
  temporary.push(parent);
  const repo = path.join(parent, 'origin');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Merge Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'remote', 'add', 'marks', 'https://github.com/mvclaudianobj/chat-on-steroids.git');
  git(repo, 'remote', 'add', 'upstream', 'https://github.com/totec448-spec/chat-on-steroids');
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '2.1.41+1' }));
  git(repo, 'add', 'package.json', '.gitignore'); git(repo, 'commit', '-m', 'marks baseline');
  const marks = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/marks/main', marks);
  writeFileSync(path.join(repo, 'community.md'), 'new community feature');
  git(repo, 'add', 'community.md'); git(repo, 'commit', '-m', 'community changes');
  const upstream = git(repo, 'rev-parse', 'HEAD');
  const ref = 'refs/remotes/upstream/releases/v2.1.42';
  git(repo, 'update-ref', ref, upstream);
  const worktree = path.join(parent, 'integration');
  git(repo, 'worktree', 'add', '-b', 'integration/marks-community-2.1.42', worktree, marks);
  return { parent, repo, worktree, marks, upstream, ref };
}

it('pins the two source SHAs, records a nonoverwriting preflight snapshot and rejects changed work', () => {
  const { parent, worktree, marks, upstream, ref } = fixture();
  const record = path.join(parent, 'preflight.json');
  const snapshot = preflight({ repo: worktree, marks, upstream, ref, record });
  expect(snapshot).toMatchObject({ marks, upstream, ref, head: marks, tag: 'v2.1.42',
    next: { packageVersion: '2.1.42+1', productVersion: '2.1.42.1', tag: 'v2.1.42.1' } });
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(snapshot);
  expect(() => preflight({ repo: worktree, marks, upstream, ref, record })).toThrow(/EEXIST/);
  expect(() => preflight({ repo: worktree, marks, upstream: marks, ref })).toThrow(/SHA changed/);
  writeFileSync(path.join(worktree, 'local.txt'), 'preserve this work');
  expect(() => preflight({ repo: worktree, marks, upstream, ref })).toThrow(/changes or untracked/);
});

it('recovers in a fresh worktree from the reviewed baseline without removing failed merge files', () => {
  const { parent, repo, worktree, marks, upstream, ref } = fixture();
  const record = path.join(parent, 'baseline.json');
  preflight({ repo: worktree, marks, upstream, ref, record });
  writeFileSync(path.join(worktree, 'failed-merge-note.txt'), 'must survive recovery');
  const destination = path.join(parent, 'recovered');
  const opts = { repo: worktree, record, destination, branch: 'recovery/marks-community-2.1.42' };
  expect(recovery(opts)).toMatchObject({ marks, executed: false, recoveryPath: destination });
  expect(() => git(repo, 'rev-parse', '--verify', 'refs/heads/recovery/marks-community-2.1.42')).toThrow();
  const created = recovery({ ...opts, execute: true });
  expect(created.executed).toBe(true);
  expect(git(destination, 'rev-parse', 'HEAD')).toBe(marks);
  expect(readFileSync(path.join(worktree, 'failed-merge-note.txt'), 'utf8')).toBe('must survive recovery');
  expect(() => recovery({ ...opts, execute: true })).toThrow(/destination|already exists/);
  expect(() => recovery({ ...opts, destination: worktree, branch: 'recovery/other' })).toThrow(/destination/);
  git(repo, 'update-ref', 'refs/remotes/marks/main', upstream);
  expect(() => recovery({ ...opts, destination: path.join(parent, 'another'), branch: 'recovery/new' }))
    .toThrow(/baseline ref moved/);
});

it('verifies exact commit and checksums while refusing mismatches, traversal, duplicates and links', async () => {
  const { parent, worktree, marks } = fixture();
  const dir = path.join(parent, 'release'); mkdirSync(dir);
  const file = path.join(dir, 'Chat-Marks-Linux-x64.deb');
  writeFileSync(file, 'fixture package bytes');
  const sha = createHash('sha256').update('fixture package bytes').digest('hex');
  const sums = path.join(dir, 'SHA256SUMS.txt');
  writeFileSync(sums, `${sha}  Chat-Marks-Linux-x64.deb\n`);
  expect((await compareSha({ repo: worktree, ref: 'HEAD', expected: marks, directory: dir, sums })).artifacts)
    .toEqual([{ name: 'Chat-Marks-Linux-x64.deb', sha256: sha }]);
  await expect(compareSha({ repo: worktree, ref: 'HEAD', expected: '0'.repeat(40), directory: dir, sums })).rejects.toThrow(/expected/);
  writeFileSync(file, 'tampered');
  await expect(compareSha({ repo: worktree, ref: 'HEAD', expected: marks, directory: dir, sums })).rejects.toThrow(/SHA256 mismatch/);
  writeFileSync(sums, `${sha}  ../outside\n`);
  await expect(compareSha({ repo: worktree, ref: 'HEAD', expected: marks, directory: dir, sums })).rejects.toThrow(/unsafe checksum/);
  writeFileSync(sums, `${sha}  Chat-Marks-Linux-x64.deb\n${sha}  Chat-Marks-Linux-x64.deb\n`);
  await expect(compareSha({ repo: worktree, ref: 'HEAD', expected: marks, directory: dir, sums })).rejects.toThrow(/duplicated/);
  rmSync(file); symlinkSync(path.join(worktree, 'package.json'), file);
  writeFileSync(sums, `${sha}  Chat-Marks-Linux-x64.deb\n`);
  await expect(compareSha({ repo: worktree, ref: 'HEAD', expected: marks, directory: dir, sums })).rejects.toThrow(/regular artifact/);
});

it('generates build/packaging gates without execution and refuses stale or dirty source', () => {
  const { worktree, marks } = fixture();
  mkdirSync(path.join(worktree, 'node_modules'));
  const opts = { repo: worktree, expectedHead: marks, tests: ['test/packaging.test.ts'] };
  expect(releaseCommands(opts).commands).toEqual([
    [process.execPath, 'scripts/verify-release-version.mjs'],
    ['npm', 'run', 'typecheck'],
    ['npm', 'test', '--', '--run', 'test/packaging.test.ts']
  ]);
  const build = releaseCommands({ ...opts, level: 'build' });
  expect(build.commands.at(-1)).toEqual(['npm', 'run', 'build']);
  const results: string[] = [];
  executeReleaseCommands(build, (binary: string, args: string[]) => { results.push([binary, ...args].join(' ')); return { status: 0 }; });
  expect(results).toHaveLength(4);
  const pkg = releaseCommands({ ...opts, level: 'package', platform: process.platform, arch: 'x64' });
  expect(pkg.commands.at(-1)).toEqual([process.execPath, 'scripts/package.mjs', '--platform', process.platform, '--arch', 'x64']);
  expect(() => releaseCommands({ ...opts, level: 'package', platform: process.platform === 'linux' ? 'win32' : 'linux' })).toThrow(/actual host/);
  expect(() => releaseCommands({ ...opts, tests: ['../../secret.test.ts'] })).toThrow(/explicit/);
  expect(() => releaseCommands({ ...opts, expectedHead: 'a'.repeat(40) })).toThrow(/pinned/);
  writeFileSync(path.join(worktree, 'dirty.txt'), 'do not release');
  expect(() => releaseCommands(opts)).toThrow(/clean committed/);
});

it('refuses linked worktree dependencies before constructing an incomplete native package', () => {
  const { parent, worktree, marks } = fixture();
  const opts = { repo: worktree, expectedHead: marks, level: 'package', platform: process.platform, arch: 'x64' };
  expect(() => releaseCommands(opts)).toThrow(/Missing node_modules/);
  const otherDependencies = path.join(parent, 'shared-deps');
  mkdirSync(otherDependencies);
  symlinkSync(otherDependencies, path.join(worktree, 'node_modules'), 'dir');
  expect(() => releaseCommands(opts)).toThrow(/Linked node_modules is unsafe/);
});
