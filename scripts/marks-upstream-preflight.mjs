#!/usr/bin/env node
/**
 * Read-only preflight for merging official Chat On Steroids into Chat Marks.
 *
 * It only uses already-fetched refs. It never fetches, switches branches,
 * merges, modifies the index, commits, retags or pushes. git merge-tree writes
 * temporary Git objects, not working-tree/index files.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOfficialUpstream } from './check-community-release.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stableRef = /^refs\/remotes\/upstream\/releases\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function changed(cwd, base, tip) {
  return new Set(git(cwd, 'diff', '--name-only', '--diff-filter=ACDMRT', base, tip)
    .split('\n').filter(Boolean));
}

/**
 * A missing/newly-published upstream ref is NOT silently substituted by
 * upstream/main. The user must explicitly fetch the official stable tag via
 * scripts/check-community-release.mjs --fetch.
 */
export function inspectMarksMerge(cwd, ref, requireClean = false) {
  if (ref !== 'refs/remotes/upstream/main' && !stableRef.test(ref)) {
    throw new Error('Only the official upstream/main or an official cached stable release ref is allowed');
  }
  const upstream = git(cwd, 'remote', 'get-url', 'upstream');
  if (!isOfficialUpstream(upstream)) throw new Error('The upstream remote does not point to the official Chat On Steroids repository');
  const marks = git(cwd, 'remote', 'get-url', 'marks');
  if (!/^https:\/\/github\.com\/mvclaudianobj\/chat-on-steroids(?:\.git)?\/?$/i.test(marks) &&
      !/^git@github\.com:mvclaudianobj\/chat-on-steroids(?:\.git)?$/i.test(marks) &&
      !/^ssh:\/\/git@github\.com\/mvclaudianobj\/chat-on-steroids(?:\.git)?$/i.test(marks)) {
    throw new Error('The marks remote must point to the Chat Marks fork, never upstream');
  }
  const target = git(cwd, 'rev-parse', '--verify', `${ref}^{commit}`);
  const head = git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}');
  const base = git(cwd, 'merge-base', head, target);
  const aheadBehind = git(cwd, 'rev-list', '--left-right', '--count', `${head}...${target}`)
    .split(/\s+/).map(Number);
  const ourPaths = changed(cwd, base, head);
  const upstreamPaths = changed(cwd, base, target);
  const overlaps = [...ourPaths].filter(file => upstreamPaths.has(file)).sort();
  const dirty = git(cwd, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean);
  // Does not touch the checked-out branch, index, worktree or remotes.
  const merged = spawnSync('git', ['merge-tree', '--write-tree', '--messages', '--name-only', head, target], {
    cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  });
  if (merged.error || ![0, 1].includes(merged.status)) {
    throw new Error(`Git merge-tree preflight failed: ${merged.error?.message ?? merged.stderr?.trim() ?? merged.status}`);
  }
  const conflicts = merged.status === 1;
  return {
    head, target, ref, base, upstreamRemote: upstream, marksRemote: marks,
    marksOnlyCommits: aheadBehind[0], upstreamOnlyCommits: aheadBehind[1],
    changedByMarks: ourPaths.size, changedByUpstream: upstreamPaths.size,
    overlappingFiles: overlaps, workingTreeChanges: dirty,
    conflictFree: !conflicts, conflictDetails: conflicts ? merged.stdout.trim().slice(0, 10_000) : '',
    canMergeNow: !conflicts && dirty.length === 0,
    checkFailed: conflicts || (requireClean && dirty.length > 0)
  };
}

function parseArgs(argv) {
  let ref, requireClean = false, json = false;
  for (const argument of argv) {
    if (argument === '--require-clean') requireClean = true;
    else if (argument === '--json') json = true;
    else if (argument === '--main') ref = 'refs/remotes/upstream/main';
    else if (argument.startsWith('--ref=') && stableRef.test(argument.slice(6))) ref = argument.slice(6);
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!ref) {
    const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
    const match = /^(\d+\.\d+\.\d+)(?:\+\d+)?$/.exec(version);
    if (!match) throw new Error('Marks package version is not X.Y.Z+N');
    ref = `refs/remotes/upstream/releases/v${match[1]}`;
  }
  return { ref, requireClean, json };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/marks-upstream-preflight.mjs [--ref=refs/remotes/upstream/releases/vX.Y.Z | --main] [--require-clean] [--json]\n');
    process.stdout.write('Checks cached refs ONLY. Never fetches, merges, switches, commits or publishes. --main is exploratory and not an official stable release.\n');
    return;
  }
  const { ref, requireClean, json } = parseArgs(process.argv.slice(2));
  let report;
  try { report = inspectMarksMerge(repo, ref, requireClean); }
  catch (error) {
    throw new Error(`${error.message}. Fetch only the official stable release with: node scripts/check-community-release.mjs --fetch`);
  }
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`Official remote: ${report.upstreamRemote}\nMarks remote: ${report.marksRemote}\n`);
    process.stdout.write(`Cached candidate: ${report.ref} @ ${report.target.slice(0, 12)} (NOT verified fresh against GitHub)\n`);
    process.stdout.write(`Commits (Marks only / upstream only): ${report.marksOnlyCommits} / ${report.upstreamOnlyCommits}\n`);
    process.stdout.write(`Potential overlapping files: ${report.overlappingFiles.length}\n`);
    for (const file of report.overlappingFiles.slice(0, 40)) process.stdout.write(`  ${file}\n`);
    if (report.overlappingFiles.length > 40) process.stdout.write(`  ... and ${report.overlappingFiles.length - 40} more\n`);
    process.stdout.write(`Virtual merge: ${report.conflictFree ? 'no textual conflicts detected' : 'CONFLICTS DETECTED'}\n`);
    if (report.conflictDetails) process.stdout.write(`Conflict details:\n${report.conflictDetails}\n`);
    process.stdout.write(`Uncommitted/untracked paths: ${report.workingTreeChanges.length}\n`);
    if (report.workingTreeChanges.length) process.stdout.write('Do NOT merge yet: first finish or isolate ALL local changes without discarding them.\n');
    process.stdout.write('No remote access, branch switch, merge, commit, tag or push performed.\n');
  }
  if (report.checkFailed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Upstream preflight failed: ${error.message}\n`); process.exitCode = 1; });
}
