#!/usr/bin/env node
/**
 * Read the latest published stable community release and print a reviewable
 * integration plan. --fetch refreshes only one upstream release ref; this
 * command never checks out, merges, commits, tags or pushes code.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const latestReleaseApi = 'https://api.github.com/repos/totec448-spec/chat-on-steroids/releases/latest';
const stableVersion = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const tagPattern = new RegExp(`^v${stableVersion}$`);
const packagePattern = new RegExp(`^${stableVersion}(?:\\+([1-9]\\d*))?$`);

function numberParts(match) {
  return match.slice(1, 4).map((part) => BigInt(part));
}

export function parseCommunityTag(tag) {
  const match = tagPattern.exec(tag ?? '');
  if (!match) throw new Error(`Expected a stable upstream vX.Y.Z tag, received: ${tag}`);
  return { base: match.slice(1, 4).join('.'), parts: numberParts(match), tag };
}

export function parseMarksPackageVersion(version) {
  const match = packagePattern.exec(version ?? '');
  if (!match) throw new Error(`Invalid Marks npm version ${version}; expected X.Y.Z or X.Y.Z+N`);
  return {
    base: match.slice(1, 4).join('.'),
    parts: numberParts(match),
    revision: match[4] ? BigInt(match[4]) : 0n,
    product: `${match.slice(1, 4).join('.')}${match[4] ? `.${match[4]}` : ''}`
  };
}

export function compareCommunityVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function nextMarksVersion(currentPackageVersion, releaseTag) {
  const current = parseMarksPackageVersion(currentPackageVersion);
  const upstream = parseCommunityTag(releaseTag);
  const difference = compareCommunityVersions(upstream.parts, current.parts);
  if (difference < 0) {
    throw new Error(`Upstream ${releaseTag} is older than Marks ${current.product}; refusing a version downgrade`);
  }
  const revision = difference > 0 ? 1n : current.revision + 1n;
  return {
    current,
    upstream,
    newCommunityRelease: difference > 0,
    packageVersion: `${upstream.base}+${revision}`,
    productVersion: `${upstream.base}.${revision}`,
    tag: `v${upstream.base}.${revision}`
  };
}

export function validatePublishedRelease(release) {
  if (!release || release.draft !== false || release.prerelease !== false || !release.published_at) {
    throw new Error('GitHub did not return a published stable community release');
  }
  return parseCommunityTag(release.tag_name).tag;
}

export function isOfficialUpstream(url) {
  return /^https:\/\/github\.com\/totec448-spec\/chat-on-steroids(?:\.git)?\/?$/i.test(url)
    || /^git@github\.com:totec448-spec\/chat-on-steroids(?:\.git)?$/i.test(url)
    || /^ssh:\/\/git@github\.com\/totec448-spec\/chat-on-steroids(?:\.git)?$/i.test(url);
}

export function remoteTagObject(output, tag) {
  const expectedRef = `refs/tags/${parseCommunityTag(tag).tag}`;
  const lines = output.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) throw new Error(`Expected one upstream ref for ${tag}, found ${lines.length}`);
  const [oid, ref, ...extra] = lines[0].split(/\s+/);
  if (!/^[a-f0-9]{40,64}$/i.test(oid ?? '') || ref !== expectedRef || extra.length) {
    throw new Error(`The upstream remote did not return the exact ${expectedRef} ref`);
  }
  return oid;
}

function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: repo, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

function optionalGit(...args) {
  try {
    return execFileSync('git', args, {
      cwd: repo, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

async function getLatestRelease() {
  let response;
  try {
    response = await fetch(latestReleaseApi, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Chat-Marks-community-merge-planner'
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error(`Could not check the upstream GitHub release: ${error.message}`);
  }
  if (!response.ok) throw new Error(`GitHub release check returned HTTP ${response.status}; no merge preparation performed`);
  const data = await response.json();
  return { tag: validatePublishedRelease(data), published: data.published_at };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/check-community-release.mjs [--fetch]\n\n`);
  process.stdout.write('Without flags: inspect official upstream published stable release and print a plan (read-only).\n');
  process.stdout.write('With --fetch: additionally fetch that exact tag to refs/remotes/upstream/releases/vX.Y.Z.\n');
  process.stdout.write('Neither mode checks out, merges, commits, tags, updates versions or pushes.\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--fetch')) {
    throw new Error(`Unknown arguments: ${args.join(' ')}; run with --help`);
  }

  const url = git('remote', 'get-url', 'upstream');
  if (!isOfficialUpstream(url)) {
    throw new Error("The 'upstream' remote must point to github.com/totec448-spec/chat-on-steroids");
  }

  const packageJson = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const release = await getLatestRelease();
  const plan = nextMarksVersion(packageJson.version, release.tag);
  const remoteRef = `refs/tags/${release.tag}`;
  const localRef = `refs/remotes/upstream/releases/${release.tag}`;
  const remoteObject = remoteTagObject(git('ls-remote', '--tags', '--refs', 'upstream', remoteRef), release.tag);
  const dirtyPaths = git('status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean);
  const branch = optionalGit('symbolic-ref', '--quiet', '--short', 'HEAD') ?? '(detached HEAD)';

  if (args[0] === '--fetch') {
    git('fetch', '--no-tags', 'upstream', `${remoteRef}:${localRef}`);
  }

  const cachedObject = optionalGit('show-ref', '--verify', '--hash', localRef);
  const cached = cachedObject === remoteObject;
  const aheadBehind = cached ? optionalGit('rev-list', '--left-right', '--count', `HEAD...${localRef}`) : null;

  process.stdout.write(`Official upstream: ${url}\n`);
  process.stdout.write(`Latest published stable community release: ${release.tag} (${release.published})\n`);
  process.stdout.write(`Marks package: ${packageJson.version} (product ${plan.current.product})\n`);
  process.stdout.write(`Recommended next Marks revision: ${plan.tag} (npm ${plan.packageVersion})\n`);
  process.stdout.write(`Current branch: ${branch}; working tree: ${dirtyPaths.length ? `${dirtyPaths.length} changed/untracked paths` : 'clean'}\n`);
  process.stdout.write(`Release ref: ${localRef} (${cached ? 'verified against remote tag' : 'missing or outdated; fetch needed'})\n`);
  if (aheadBehind) {
    const [marksOnly, communityOnly] = aheadBehind.split(/\s+/);
    process.stdout.write(`Commit comparison (HEAD only / upstream only): ${marksOnly} / ${communityOnly}\n`);
  }

  if (!plan.newCommunityRelease) {
    process.stdout.write(`No newer community X.Y.Z is published. ${plan.tag} would be a Marks-only revision.\n`);
    return;
  }

  process.stdout.write('\nSuggested manual integration (no commands below were executed):\n');
  if (dirtyPaths.length) process.stdout.write('  First finish or isolate existing local changes; do not merge into the dirty tree.\n');
  if (!cached) process.stdout.write(`  node scripts/check-community-release.mjs --fetch\n`);
  process.stdout.write(`  git switch -c integration/community-${release.tag}\n`);
  process.stdout.write(`  git merge --no-ff --no-commit ${localRef}\n`);
  process.stdout.write('  Review and resolve conflicts, preserve Marks behavior and community authorship, run checks.\n');
  process.stdout.write(`  Align version sources to ${plan.productVersion} (package.json and lockfile use ${plan.packageVersion}).\n`);
  process.stdout.write(`  Review release notes docs/release-notes/${plan.tag}.md and follow docs/community-merge.md.\n`);
  process.stdout.write('  Only publish after separate human review and release validation.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Community release check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
