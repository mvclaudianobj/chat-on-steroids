#!/usr/bin/env node
/** Local, non-publishing merge gates. No branch, tag, or working-tree reset is performed. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOfficialUpstream, nextMarksVersion, parseCommunityTag } from '../../../../scripts/check-community-release.mjs';

const SOURCE = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SOURCE), '../../../..');
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MARKS_URL = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(?:mvclaudianobj\/chat-on-steroids)(?:\.git)?\/?$/i;
const TAG_REF = /^refs\/remotes\/upstream\/releases\/(v\d+\.\d+\.\d+)$/;

function git(repo, ...args) {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`git ${args[0]} failed: ${error.stderr?.toString().trim() || error.message}`); }
}

function options(argv) {
  if (argv.length % 2) throw new Error('Options must be --name value pairs (use --execute yes)');
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!/^--[a-z-]+$/.test(key) || key in result || !argv[i + 1]) throw new Error(`Invalid or duplicate option: ${key}`);
    result[key.slice(2)] = argv[i + 1];
  }
  return result;
}

function requireSha(value, name) {
  if (!SHA.test(value ?? '')) throw new Error(`${name} must be a full lowercase Git commit SHA`);
  return value;
}

function exactCommit(repo, ref) { return git(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`); }

function commonGit(repo) {
  const output = git(repo, 'rev-parse', '--git-common-dir');
  return realpathSync(path.resolve(repo, output));
}

function inspectWorkspace(repo) {
  const root = realpathSync(git(repo, 'rev-parse', '--show-toplevel'));
  if (root !== realpathSync(repo)) throw new Error('Use the exact Git worktree root as --repo');
  const metadata = path.join(root, '.git');
  if (!lstatSync(metadata).isFile()) throw new Error('A separate linked Git worktree is required');
  const branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  if (branch === 'main' || branch === 'marks/main' || branch.startsWith('release/'))
    throw new Error('Refusing an active main or release branch');
  if (!MARKS_URL.test(git(root, 'remote', 'get-url', 'marks')))
    throw new Error('marks remote is not the official Marks fork');
  if (!isOfficialUpstream(git(root, 'remote', 'get-url', 'upstream')))
    throw new Error('upstream remote is not the official community repository');
  return { root, branch, commonDir: commonGit(root), head: exactCommit(root, 'HEAD') };
}

function assertClean(repo) {
  if (git(repo, 'status', '--porcelain=v1', '--untracked-files=all'))
    throw new Error('Worktree has changes or untracked files; preserve them before this operation');
  if (existsSync(path.join(git(repo, 'rev-parse', '--git-dir'), 'MERGE_HEAD')))
    throw new Error('Merge is in progress');
}

export function preflight({ repo = REPO, marks, upstream, ref, record } = {}) {
  const workspace = inspectWorkspace(path.resolve(repo));
  const tag = TAG_REF.exec(ref ?? '')?.[1];
  if (!tag) throw new Error('Upstream ref must be refs/remotes/upstream/releases/vX.Y.Z');
  parseCommunityTag(tag);
  requireSha(marks, 'marks'); requireSha(upstream, 'upstream');
  assertClean(workspace.root);
  if (workspace.head !== marks || exactCommit(repo, 'refs/remotes/marks/main') !== marks)
    throw new Error('Marks baseline SHA changed; recreate this branch from the reviewed marks/main');
  if (exactCommit(repo, ref) !== upstream) throw new Error('Upstream ref SHA changed; review the new commit before merging');
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const next = nextMarksVersion(pkg.version, tag);
  const snapshot = { schema: 1, ...workspace, marks, upstream, ref, tag,
    next: { packageVersion: next.packageVersion, productVersion: next.productVersion, tag: next.tag } };
  if (record) writeFileSync(path.resolve(record), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return snapshot;
}

/** Recovery creates a fresh checkout at the recorded Marks baseline, preserving all failed work. */
export function recovery({ repo = REPO, record, destination, branch, execute = false } = {}) {
  if (!record || !destination || !branch) throw new Error('Recovery requires --record, --destination and --branch');
  const snapshot = JSON.parse(readFileSync(path.resolve(record), 'utf8'));
  const workspace = inspectWorkspace(path.resolve(repo));
  if (snapshot.schema !== 1 || snapshot.root !== workspace.root || snapshot.commonDir !== workspace.commonDir ||
      snapshot.branch !== workspace.branch || !SHA.test(snapshot.marks ?? '') || !SHA.test(snapshot.upstream ?? '') ||
      !TAG_REF.test(snapshot.ref ?? ''))
    throw new Error('Recovery snapshot does not identify this exact worktree');
  if (exactCommit(repo, 'refs/remotes/marks/main') !== snapshot.marks ||
      exactCommit(repo, snapshot.ref) !== snapshot.upstream)
    throw new Error('A reviewed baseline ref moved; stop and investigate before recovery');
  if (exactCommit(repo, snapshot.marks) !== snapshot.marks)
    throw new Error('Recovery baseline object cannot be verified');
  const target = path.resolve(destination);
  if (existsSync(target) || target === workspace.root || target.startsWith(`${workspace.root}${path.sep}`))
    throw new Error('Recovery destination must be a new path outside the source worktree');
  if (!branch.startsWith('recovery/') || git(repo, 'check-ref-format', '--branch', branch) !== branch)
    throw new Error('Recovery branch must be a valid new recovery/* branch');
  if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }).status === 0)
    throw new Error('Recovery branch already exists');
  const result = { ...snapshot, recoveryBranch: branch, recoveryPath: target, executed: execute };
  if (execute) git(repo, 'worktree', 'add', '-b', branch, '--', target, snapshot.marks);
  return result;
}

function validFilename(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 256 && name !== '.' && name !== '..' &&
    !/[\\/\u0000-\u001f]/.test(name) && !name.startsWith('-');
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Exact manifest verification; SHA matches bytes, not a GitHub run/commit identity. */
export async function compareSha({ repo = REPO, ref, expected, directory, sums } = {}) {
  requireSha(expected, 'expected');
  if (!ref) throw new Error('Provide an explicit Git ref to compare');
  const actual = exactCommit(repo, ref);
  if (actual !== expected) throw new Error(`Git ref ${ref} resolves to ${actual}, expected ${expected}`);
  if (!directory && !sums) return { ref, sha: actual, artifacts: [] };
  if (!directory || !sums) throw new Error('Both --directory and --sums are required for asset verification');
  const dir = realpathSync(path.resolve(directory));
  const manifest = path.resolve(sums);
  if (path.basename(manifest) !== 'SHA256SUMS.txt' || !lstatSync(manifest).isFile() ||
      path.dirname(realpathSync(manifest)) !== dir)
    throw new Error('SHA256SUMS must be a regular file directly inside the artifact directory');
  const lines = readFileSync(manifest, 'utf8').trimEnd().split('\n');
  if (!lines.length || lines.length > 40) throw new Error('Invalid release checksum list size');
  const names = new Set();
  const entries = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  \*?([^\r\n]+)$/.exec(line);
    if (!match || !validFilename(match[2]) || names.has(match[2]) || match[2] === path.basename(manifest))
      throw new Error('Malformed, duplicated or unsafe checksum entry');
    const name = match[2]; names.add(name);
    entries.push({ name, expectedHash: match[1] });
  }
  const artifacts = [];
  for (const { name, expectedHash } of entries) {
    const file = path.join(dir, name);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`Not a regular artifact: ${name}`);
    const actualHash = await fileSha256(file);
    if (actualHash !== expectedHash) throw new Error(`SHA256 mismatch for ${name}`);
    artifacts.push({ name, sha256: actualHash });
  }
  return { ref, sha: actual, artifacts };
}

const COMMANDS = {
  preflight: { required: ['marks', 'upstream', 'ref'], keys: ['repo', 'marks', 'upstream', 'ref', 'record'] },
  'compare-sha': { required: ['ref', 'expected'], keys: ['repo', 'ref', 'expected', 'directory', 'sums'] },
  recovery: { required: ['record', 'destination', 'branch'], keys: ['repo', 'record', 'destination', 'branch', 'execute'] }
};

if (process.argv[1] && path.resolve(process.argv[1]) === SOURCE) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (!COMMANDS[command]) throw new Error('Usage: merge-guard.mjs preflight|compare-sha|recovery [--key value ...]');
    const values = options(args);
    const contract = COMMANDS[command];
    for (const key of Object.keys(values)) if (!contract.keys.includes(key)) throw new Error(`Unknown --${key}`);
    for (const key of contract.required) if (!values[key]) throw new Error(`Missing --${key}`);
    const execute = values.execute === 'yes';
    if ('execute' in values && !['yes', 'no'].includes(values.execute)) throw new Error('--execute accepts yes or no');
    const result = command === 'preflight' ? preflight(values)
      : command === 'compare-sha' ? await compareSha(values) : recovery({ ...values, execute });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
