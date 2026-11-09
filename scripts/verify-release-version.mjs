import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { productVersion } from './release-version.mjs';

/** Verify the actual tag and every source of the version shipped to users. */
export function verifyReleaseVersion({ root = path.resolve(import.meta.dirname, '..'), tag = null, packageOnly = false } = {}) {
  const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const manifest = JSON.parse(read('extension/manifest.json'));
  const version = productVersion(pkg.version);
  const appVersion = read('src/main/version.ts').match(/APP_VERSION = '([^']+)'/)?.[1];
  const builder = read('electron-builder.yml');
  const builderVersion = builder.match(/^buildVersion:\s*(\S+)/m)?.[1];
  const builderExtraVersion = builder.match(/^extraMetadata:\s*\n\s*version:\s*(\S+)/m)?.[1];
  const builderNumber = builder.match(/^buildNumber:\s*['"]?(\d+)['"]?/m)?.[1];
  const revision = pkg.version.match(/\+(\d+)$/)?.[1];
  // A local TEST package may have a higher Debian revision with identical app/extension bytes
  // to avoid overwriting the installed package. A tagged release may never use that escape.
  const localQaRebuild = builder.match(/^# localQaRebuild:\s*(\d+)\s*$/m)?.[1];
  const changelogVersion = packageOnly ? null : read('CHANGELOG.md').match(/^## \[(\d+\.\d+\.\d+(?:\.\d+)?)\]/m)?.[1];
  const values = {
    'lockfile version': lock.version,
    'lockfile root version': lock.packages?.['']?.version,
    'app version': appVersion,
    'extension version': manifest.version,
    'builder version': builderVersion,
    'builder packaged version': builderExtraVersion,
    ...(!packageOnly ? { 'changelog version': changelogVersion } : {})
  };
  for (const [name, actual] of Object.entries(values)) {
    const expected = name.startsWith('lockfile') ? pkg.version : version;
    if (actual !== expected) throw new Error(`${name} ${actual ?? '<missing>'} does not match ${expected}`);
  }
  if (revision && builderNumber !== revision &&
    (tag !== null || localQaRebuild !== builderNumber || Number(builderNumber) <= Number(revision))) {
    throw new Error(`builder revision ${builderNumber ?? '<missing>'} does not match ${revision}`);
  }
  if (!packageOnly) {
    const notesPath = `docs/release-notes/v${version}.md`;
    if (!existsSync(path.join(root, notesPath)) || !/^## .+$/m.test(read(notesPath))) {
      throw new Error(`Missing reviewed release notes: ${notesPath}`);
    }
  }
  if (tag && tag !== `v${version}`) throw new Error(`Tag ${tag} does not match product version ${version}`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
    const version = verifyReleaseVersion({ tag, packageOnly: process.argv.includes('--package-only') });
    process.stdout.write(`Release metadata verified for v${version}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
