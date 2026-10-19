#!/usr/bin/env node
/** Local quality and packaging commands, explicitly bound to a reviewed source commit. */
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function releaseCommands({ repo = REPO, expectedHead, level = 'check', platform = process.platform,
  arch = process.arch, tests = [] } = {}) {
  repo = path.resolve(repo);
  if (!SHA.test(expectedHead ?? '') || git(repo, 'rev-parse', '--verify', 'HEAD^{commit}') !== expectedHead)
    throw new Error('HEAD differs from the pinned release candidate commit');
  if (git(repo, 'status', '--porcelain=v1', '--untracked-files=all'))
    throw new Error('Local release requires a clean committed worktree');
  if (!['check', 'build', 'package'].includes(level)) throw new Error('Choose level check, build or package');
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error('Unknown packaging platform');
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Choose arch x64 or arm64');
  if (level === 'package' && platform !== process.platform)
    throw new Error('Native packaging must run on its actual host platform');
  if (level === 'package') {
    // electron-builder resolves production modules relative to this checkout. A linked
    // node_modules from a different worktree can create installers missing runtime modules
    // (e.g. detect-libc), even if the linked dependency works during development.
    let dependencies;
    try { dependencies = lstatSync(path.join(repo, 'node_modules')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Missing node_modules: run npm ci inside this worktree before packaging');
      throw error;
    }
    if (dependencies.isSymbolicLink())
      throw new Error('Linked node_modules is unsafe for electron-builder: install dependencies locally with npm ci in this worktree');
    if (!dependencies.isDirectory()) throw new Error('node_modules must be a real directory in the packaging worktree');
  }
  if (!Array.isArray(tests) || tests.length > 12 || tests.some(name => !/^test\/[a-zA-Z0-9][\w.-]*\.test\.ts$/.test(name)))
    throw new Error('Tests must be explicit test/name.test.ts paths');

  const commands = [
    [process.execPath, 'scripts/verify-release-version.mjs'],
    ['npm', 'run', 'typecheck'],
    ...(tests.length ? [['npm', 'test', '--', '--run', ...tests]] : []),
    // package.mjs already runs electron-vite build, so do not run a second bundle first.
    ...(level === 'build' ? [['npm', 'run', 'build']] : []),
    ...(level === 'package' ? [[process.execPath, 'scripts/package.mjs', '--platform', platform, '--arch', arch]] : [])
  ];
  return { repo, head: expectedHead, level, commands };
}

export function executeReleaseCommands(plan, spawn = spawnSync) {
  for (const [program, ...args] of plan.commands) {
    const result = spawn(program, args, { cwd: plan.repo, stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0)
      throw new Error(`${program} ${args.join(' ')} failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length % 2) throw new Error('Usage: local-release.mjs --head SHA [--level check|build|package] [--test test/example.test.ts] [--execute yes]');
    const options = { tests: [] };
    for (let i = 0; i < args.length; i += 2) {
      const [key, value] = [args[i], args[i + 1]];
      if (!value) throw new Error(`Value required for ${key}`);
      if (key === '--test') options.tests.push(value);
      else if (['--repo', '--head', '--level', '--platform', '--arch', '--execute'].includes(key)) {
        const name = key === '--head' ? 'expectedHead' : key.slice(2);
        if (name in options) throw new Error(`Duplicate option ${key}`);
        options[name] = value;
      } else throw new Error(`Unknown option ${key}`);
    }
    if (!['yes', 'no', undefined].includes(options.execute)) throw new Error('--execute accepts yes or no');
    const plan = releaseCommands(options);
    process.stdout.write(`${JSON.stringify({ ...plan, executed: options.execute === 'yes' }, null, 2)}\n`);
    if (options.execute === 'yes') executeReleaseCommands(plan);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
