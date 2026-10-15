import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error This Node CLI is intentionally plain ESM, without a generated declaration.
import { inspectMarksMerge } from '../scripts/marks-upstream-preflight.mjs';

let cwd: string;
const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (message: string): string => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
const release = 'refs/remotes/upstream/releases/v2.1.38';

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'marks-upstream-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Marks Test');
  git('config', 'user.email', 'test@example.invalid');
  git('remote', 'add', 'upstream', 'https://github.com/totec448-spec/chat-on-steroids');
  git('remote', 'add', 'marks', 'https://github.com/mvclaudianobj/chat-on-steroids.git');
  writeFileSync(path.join(cwd, 'base.ts'), 'export const identity = 1;\n');
  commit('base');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

it('reports textual conflicts without touching the working tree or index', () => {
  git('switch', '-q', '-c', 'upstream-work');
  writeFileSync(path.join(cwd, 'base.ts'), 'export const identity = 2;\n');
  const upstream = commit('upstream');
  git('update-ref', release, upstream);
  git('switch', '-q', 'main');
  writeFileSync(path.join(cwd, 'base.ts'), 'export const identity = 3;\n');
  const marks = commit('marks');
  const preview = inspectMarksMerge(cwd, release);
  expect(preview.overlappingFiles).toEqual(['base.ts']);
  expect(preview.conflictFree).toBe(false);
  expect(preview.canMergeNow).toBe(false);
  expect(git('rev-parse', 'HEAD')).toBe(marks);
  expect(git('status', '--porcelain=v1')).toBe('');
});

it('distinguishes conflict-free preview from permission to merge a dirty tree', () => {
  git('switch', '-q', '-c', 'upstream-work');
  writeFileSync(path.join(cwd, 'community.ts'), 'export const x = 1;\n');
  git('update-ref', release, commit('upstream'));
  git('switch', '-q', 'main');
  writeFileSync(path.join(cwd, 'marks.ts'), 'export const y = 1;\n');
  commit('marks');
  expect(inspectMarksMerge(cwd, release).canMergeNow).toBe(true);
  writeFileSync(path.join(cwd, 'marks.ts'), 'export const y = 2;\n');
  const preview = inspectMarksMerge(cwd, release, true);
  expect(preview.conflictFree).toBe(true);
  expect(preview.canMergeNow).toBe(false);
  expect(preview.checkFailed).toBe(true);
});

it('rejects unofficial origins and arbitrary ref names', () => {
  git('update-ref', release, git('rev-parse', 'HEAD'));
  expect(() => inspectMarksMerge(cwd, 'refs/heads/main')).toThrow(/official/);
  git('remote', 'set-url', 'upstream', 'https://github.com/example/fork');
  expect(() => inspectMarksMerge(cwd, release)).toThrow(/official/);
});
