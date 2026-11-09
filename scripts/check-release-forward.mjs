import { pathToFileURL } from 'node:url';

/** A newly published stable release must never replace latest with a downgrade. */
export function compareReleaseVersions(left, right) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(left) || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(right)) {
    throw new Error('Invalid four-part stable product version');
  }
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const result = (a[i] ?? 0) - (b[i] ?? 0);
    if (result !== 0) return Math.sign(result);
  }
  return 0;
}

export async function assertForwardRelease({ repository, tag, token, fetchImpl = fetch, apiBase = 'https://api.github.com' }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY is missing or invalid');
  if (!/^v\d+\.\d+\.\d+(?:\.\d+)?$/.test(tag ?? '')) throw new Error('Invalid stable release tag');
  if (!token) throw new Error('GH_TOKEN is missing');
  const response = await fetchImpl(`${apiBase.replace(/\/$/, '')}/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chat-marks-release-forward-preflight' }
  });
  if (response.status === 404) return;
  if (response.status !== 200) throw new Error(`Cannot validate newest stable release: HTTP ${response.status}`);
  const latest = await response.json();
  if (!latest || latest.draft !== false || latest.prerelease !== false ||
    typeof latest.tag_name !== 'string' || !/^v\d+\.\d+\.\d+(?:\.\d+)?$/.test(latest.tag_name)) {
    throw new Error('Latest published release has invalid identity');
  }
  if (compareReleaseVersions(tag.slice(1), latest.tag_name.slice(1)) <= 0) {
    throw new Error(`Release ${tag} must be newer than public latest ${latest.tag_name}; refusing downgrade`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertForwardRelease({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.TAG || process.env.GITHUB_REF_NAME,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  }).then(() => process.stdout.write('Release order verified.\n')).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
