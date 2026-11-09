import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareCommunityVersions,
  isOfficialUpstream,
  nextMarksVersion,
  parseCommunityTag,
  parseMarksPackageVersion,
  remoteTagObject,
  validatePublishedRelease
} from '../scripts/check-community-release.mjs';

test('community stable release changes base and resets Marks revision', () => {
  const next = nextMarksVersion('2.1.37+9', 'v2.1.38');
  assert.deepEqual([next.productVersion, next.packageVersion, next.tag], ['2.1.38.1', '2.1.38+1', 'v2.1.38.1']);
});

test('Marks-only change increments the fourth revision', () => {
  assert.equal(nextMarksVersion('2.1.38+1', 'v2.1.38').productVersion, '2.1.38.2');
  assert.equal(nextMarksVersion('2.1.38', 'v2.1.38').packageVersion, '2.1.38+1');
});

test('prevents backwards base versions, prerelease tags and malformed semver', () => {
  assert.throws(() => nextMarksVersion('2.1.38+1', 'v2.1.37'), /downgrade/);
  for (const invalid of ['v2.1.39-rc.1', 'v2.1.39.1', '2.1.39', 'v02.1.39']) {
    assert.throws(() => parseCommunityTag(invalid), /stable/);
  }
  assert.throws(() => parseMarksPackageVersion('2.1.38.2'), /Invalid/);
  assert.equal(compareCommunityVersions(parseCommunityTag('v2.10.0').parts, parseCommunityTag('v2.9.9').parts), 1);
});

test('accepts only published stable GitHub releases', () => {
  const published = { tag_name: 'v2.1.38', draft: false, prerelease: false, published_at: '2026-10-15T10:00:00Z' };
  assert.equal(validatePublishedRelease(published), 'v2.1.38');
  assert.throws(() => validatePublishedRelease({ ...published, draft: true }), /published stable/);
  assert.throws(() => validatePublishedRelease({ ...published, prerelease: true }), /published stable/);
  assert.throws(() => validatePublishedRelease({ ...published, published_at: null }), /published stable/);
});

test('verifies official remote and exact upstream tag ref', () => {
  assert.ok(isOfficialUpstream('https://github.com/totec448-spec/chat-on-steroids.git'));
  assert.ok(isOfficialUpstream('git@github.com:totec448-spec/chat-on-steroids.git'));
  assert.equal(isOfficialUpstream('https://github.com/attacker/chat-on-steroids'), false);
  const oid = 'a'.repeat(40);
  assert.equal(remoteTagObject(`${oid}\trefs/tags/v2.1.38`, 'v2.1.38'), oid);
  assert.throws(() => remoteTagObject(`${oid}\trefs/tags/v2.1.37`, 'v2.1.38'), /exact/);
});
