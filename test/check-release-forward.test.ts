import { describe, expect, it, vi } from 'vitest';
import { assertForwardRelease, compareReleaseVersions } from '../scripts/check-release-forward.mjs';

const opts = (tag: string, latest: string, status = 200) => ({
  repository: 'mvclaudianobj/chat-on-steroids', tag, token: 'fixture-only',
  fetchImpl: vi.fn(async () => ({
    status, json: async () => ({ tag_name: latest, draft: false, prerelease: false })
  })) as unknown as typeof fetch
});

describe('stable release forward-only publication gate', () => {
  it('compares four-component numeric versions rather than publication time or lexical order', () => {
    expect(compareReleaseVersions('2.1.38.3', '2.1.39.2')).toBe(-1);
    expect(compareReleaseVersions('2.1.39.3', '2.1.39.2')).toBe(1);
    expect(compareReleaseVersions('2.1.39', '2.1.39.0')).toBe(0);
    expect(compareReleaseVersions('2.1.39.10', '2.1.39.2')).toBe(1);
  });
  it('refuses the requested version when a newer public release already exists', async () => {
    await expect(assertForwardRelease(opts('v2.1.38.3', 'v2.1.39.2')))
      .rejects.toThrow('must be newer than public latest v2.1.39.2');
    await expect(assertForwardRelease(opts('v2.1.39.2', 'v2.1.39.2')))
      .rejects.toThrow('refusing downgrade');
  });
  it('accepts a genuinely forward stable tag and fails closed on network uncertainty', async () => {
    await expect(assertForwardRelease(opts('v2.1.39.3', 'v2.1.39.2'))).resolves.toBeUndefined();
    await expect(assertForwardRelease(opts('v2.1.39.3', 'v2.1.39.2', 503)))
      .rejects.toThrow('Cannot validate');
  });
});
