/**
 * The Firefox add-on's identity and update manifest, shared by the stager and the release.
 *
 * Releases attach the Mozilla-signed add-on (self-hosted, "unlisted" on AMO) and this manifest.
 * The add-on's own update_url points at the latest release's copy, and Firefox installs the
 * package it names after checking its hash. The id is permanent once Mozilla signs it.
 *
 *   node scripts/firefox-update-manifest.mjs <signed.xpi> <version> <out.json>
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { productVersion } from './release-version.mjs';

// Fork-specific, stable AMO identity. Never sign updates with the community add-on's ID.
export const FIREFOX_ADDON_ID = 'companion@chatmarks.app';
// Signing probes never claim a production add-on version or Gecko identity.
export const FIREFOX_SIGN_CHECK_ADDON_ID = 'companion-signcheck@chatmarks.app';
export const FIREFOX_XPI = 'Chat-Marks-Firefox.xpi';
export const FIREFOX_UPDATES = 'firefox-updates.json';
const RELEASES = 'https://github.com/mvclaudianobj/chat-on-steroids/releases';
export const FIREFOX_UPDATE_URL = `${RELEASES}/latest/download/${FIREFOX_UPDATES}`;
// AMO permits 1-4 numeric parts, up to nine digits per part; this project uses 3 or 4.
const VERSION = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2,3}$/;

/** Probe versions use the existing X.Y.Z and a distinct fourth revision, never npm's +N. */
export function firefoxSigningTestVersion(npmVersion, runNumber) {
  const current = productVersion(npmVersion);
  const parts = current.split('.');
  if ((parts.length !== 3 && parts.length !== 4) || !VERSION.test(current) || !/^[1-9]\d*$/.test(String(runNumber))) {
    throw new Error('Firefox signing check requires a Marks X.Y.Z or X.Y.Z.N package and a positive workflow run number');
  }
  const probeRevision = BigInt(runNumber) + 1000n;
  const candidate = `${parts.slice(0, 3).join('.')}.${probeRevision}`;
  const publicRevision = parts[3] ?? '0';
  if (probeRevision <= BigInt(publicRevision) || !VERSION.test(candidate)) {
    throw new Error(`Firefox signing check revision ${probeRevision} must exceed ${publicRevision} and fit AMO's numeric version range`);
  }
  return candidate;
}

/**
 * Fail closed if the output of Mozilla's web-ext sign is an unsigned ZIP, an unrelated
 * add-on, or the wrong version. web-ext's successful AMO sign is the signing authority;
 * these extra checks ensure its returned artifact has the expected Mozilla PKCS7 metadata.
 */
export function verifySignedFirefoxXpi(xpi, version, exec = execFileSync, addonId = FIREFOX_ADDON_ID) {
  if (!VERSION.test(version)) throw new Error(`Not a Firefox version: ${version}`);
  exec('unzip', ['-tq', xpi]);
  const entries = new Set(String(exec('unzip', ['-Z1', xpi], { encoding: 'utf8' })).trim().split('\n'));
  for (const entry of ['manifest.json', 'META-INF/manifest.mf', 'META-INF/mozilla.sf', 'META-INF/mozilla.rsa']) {
    if (!entries.has(entry)) throw new Error(`Signed Firefox package is missing ${entry}`);
  }
  const manifest = JSON.parse(String(exec('unzip', ['-p', xpi, 'manifest.json'], { encoding: 'utf8' })));
  if (manifest.version !== version || manifest.browser_specific_settings?.gecko?.id !== addonId) {
    throw new Error(`Signed Firefox package must have version ${version} and Gecko ID ${addonId}`);
  }
  // Parse the embedded detached-signature certificate; the real AMO signing step must succeed too.
  const pkcs7 = exec('unzip', ['-p', xpi, 'META-INF/mozilla.rsa']);
  const certs = String(exec('openssl', ['pkcs7', '-inform', 'DER', '-print_certs', '-noout'], { input: pkcs7, encoding: 'utf8' }));
  if (!/mozilla/i.test(certs)) throw new Error('Signed Firefox package has no Mozilla-issued signature certificate');
  return true;
}

export function firefoxUpdateManifest({ version, sha256 }) {
  if (!VERSION.test(version)) throw new Error(`Not a release version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Not a sha256 digest');
  // Chat Marks: the fourth part is the Marks revision and part of the tag (v2.1.43.1), so the
  // link names the whole version; upstream's Firefox-only fourth part does not exist here.
  return {
    addons: {
      [FIREFOX_ADDON_ID]: {
        updates: [{ version, update_link: `${RELEASES}/download/v${version}/${FIREFOX_XPI}`, update_hash: `sha256:${sha256}` }]
      }
    }
  };
}

export async function writeFirefoxUpdateManifest({ xpi, version, out }, verifySigned = verifySignedFirefoxXpi) {
  verifySigned(xpi, version);
  const sha256 = createHash('sha256').update(await readFile(xpi)).digest('hex');
  await writeFile(out, `${JSON.stringify(firefoxUpdateManifest({ version, sha256 }), null, 2)}\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--test-id') {
    if (process.argv.length !== 3) throw new Error('Usage: --test-id');
    process.stdout.write(`${FIREFOX_SIGN_CHECK_ADDON_ID}\n`);
    process.exit(0);
  }
  if (process.argv[2] === '--test-version') {
    if (!process.argv[3] || process.argv.length !== 4) throw new Error('Usage: --test-version <GITHUB_RUN_NUMBER>');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${firefoxSigningTestVersion(pkg.version, process.argv[3])}\n`);
    process.exit(0);
  }
  if (process.argv[2] === '--verify-signed') {
    if (!process.argv[3] || !process.argv[4] || process.argv.length > 6 || (process.argv.length === 6 && process.argv[5] !== '--test-addon')) {
      throw new Error('Usage: --verify-signed <signed.xpi> <version> [--test-addon]');
    }
    verifySignedFirefoxXpi(process.argv[3], process.argv[4], execFileSync,
      process.argv[5] === '--test-addon' ? FIREFOX_SIGN_CHECK_ADDON_ID : FIREFOX_ADDON_ID);
    process.stdout.write(`Verified Mozilla signing metadata and Marks identity for ${process.argv[4]}\n`);
    process.exit(0);
  }
  const [xpi, version, out] = process.argv.slice(2);
  if (!xpi || !version || !out) {
    console.error('Usage: node scripts/firefox-update-manifest.mjs <signed.xpi> <version> <out.json>');
    process.exit(2);
  }
  await writeFirefoxUpdateManifest({ xpi, version, out });
}
