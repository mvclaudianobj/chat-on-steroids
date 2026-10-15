import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** npm requires SemVer; the product and GitHub tag use a fourth numeric revision. */
export function productVersion(npmVersion) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:\+([1-9]\d*))?$/.exec(npmVersion ?? '');
  if (!parts) throw new Error(`Invalid stable package version: ${npmVersion}`);
  return `${parts[1]}.${parts[2]}.${parts[3]}${parts[4] ? `.${parts[4]}` : ''}`;
}

/** Four-part Electron product versions use Debian's -1 packaging revision. */
export function debianVersion(npmVersion) {
  const version = productVersion(npmVersion);
  return npmVersion.includes('+') ? `${version}-1` : version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = process.argv.includes('--deb') ? debianVersion(pkg.version) : productVersion(pkg.version);
  process.stdout.write(`${version}\n`);
}
