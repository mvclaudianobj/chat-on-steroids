/**
 * Install or update CLIProxyAPI from its official release (Chat Marks, Linux x64/arm64).
 *
 * Unprivileged: download the archive and checksums.txt (GitHub release hosts only, bounded),
 * verify the archive's SHA-256, and extract only the `cli-proxy-api` executable into a private
 * 0700 staging directory. Privileged: exactly ONE `/usr/bin/pkexec /bin/sh -c <fixed script>`
 * whose script text is a constant; the only arguments are staging paths this module created and
 * validated, passed positionally ("$1"…), never interpolated into the script.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CliProxyInstallProgress } from '../../shared/cliproxy.js';
import {
  ARCHIVE_LIMIT, CHECKSUMS_LIMIT, downloadAsset, latestRelease, releaseAssets, verifyChecksum, type CliProxyRelease
} from './release.js';
import { generateApiKey } from './management.js';

const exec = promisify(execFile);
export const PKEXEC = '/usr/bin/pkexec';
const SH = '/bin/sh';
const STAGING_PREFIX = 'marks-cliproxy-';
const MEMBER = 'cli-proxy-api';
const EXAMPLE = 'config.example.yaml';

/** Replace the binary atomically, then restart the service only if it was running. */
export const UPDATE_SCRIPT = [
  'set -eu',
  '/usr/bin/install -m 0755 -o root -g root -- "$1" /usr/local/bin/cli-proxy-api.marks-new',
  '/usr/bin/mv -f -- /usr/local/bin/cli-proxy-api.marks-new /usr/local/bin/cli-proxy-api',
  'if /usr/bin/systemctl is-active --quiet cli-proxy-api.service; then /usr/bin/systemctl restart cli-proxy-api.service; fi'
].join('\n');

/**
 * Fresh install: a system user, the state directory, the config (only when none exists; it then
 * prints `config-written`), the fixed unit, the binary, and enable --now. The config directory
 * belongs to the service so the management API can persist key changes.
 */
export const INSTALL_SCRIPT = [
  'set -eu',
  'if ! /usr/bin/getent passwd cli-proxy-api >/dev/null; then /usr/sbin/useradd --system --user-group --home-dir /var/lib/cli-proxy-api --no-create-home --shell /usr/sbin/nologin cli-proxy-api; fi',
  '/usr/bin/install -d -m 0750 -o cli-proxy-api -g cli-proxy-api /var/lib/cli-proxy-api /var/lib/cli-proxy-api/auths /etc/cli-proxy-api',
  'if [ ! -e /etc/cli-proxy-api/config.yaml ]; then /usr/bin/install -m 0600 -o cli-proxy-api -g cli-proxy-api -- "$3" /etc/cli-proxy-api/config.yaml; echo config-written; fi',
  '/usr/bin/install -m 0644 -o root -g root -- "$2" /etc/systemd/system/cli-proxy-api.service',
  '/usr/bin/install -m 0755 -o root -g root -- "$1" /usr/local/bin/cli-proxy-api',
  '/usr/bin/systemctl daemon-reload',
  '/usr/bin/systemctl enable --now cli-proxy-api.service'
].join('\n');

/**
 * Repair for an existing install whose service cannot save its config (the upstream unit mounts
 * /etc read-only and the config is root-owned): a drop-in adds the config directory to
 * ReadWritePaths, the directory and file go to the service user (modes unchanged), and a running
 * service restarts. The main unit file is never edited. No arguments.
 */
export const REPAIR_DROP_IN = '/etc/systemd/system/cli-proxy-api.service.d/marks-writable-config.conf';
export const REPAIR_SCRIPT = [
  'set -eu',
  'umask 022',
  '/usr/bin/install -d -m 0755 -o root -g root /etc/systemd/system/cli-proxy-api.service.d',
  `printf '[Service]\\nReadWritePaths=/etc/cli-proxy-api\\n' > ${REPAIR_DROP_IN}`,
  '/usr/bin/chown cli-proxy-api: /etc/cli-proxy-api /etc/cli-proxy-api/config.yaml',
  '/usr/bin/systemctl daemon-reload',
  'if /usr/bin/systemctl is-active --quiet cli-proxy-api.service; then /usr/bin/systemctl restart cli-proxy-api.service; fi'
].join('\n');

export function repairCommand(): [string, string[]] {
  return [PKEXEC, [SH, '-c', REPAIR_SCRIPT, 'marks-cliproxy-repair']];
}

/**
 * True when systemd keeps /etc read-only for the service (ProtectSystem strict or full) and
 * no ReadWritePaths entry covers /etc/cli-proxy-api. Input: `systemctl show -p ProtectSystem
 * -p ReadWritePaths` output.
 */
export function configDirectoryReadOnly(show: string): boolean {
  const value = (name: string): string => new RegExp(`^${name}=(.*)$`, 'm').exec(show)?.[1]?.trim() ?? '';
  if (!['strict', 'full'].includes(value('ProtectSystem'))) return false;
  const paths = value('ReadWritePaths').split(/\s+/).filter(Boolean).map(path => path.replace(/^[-+]+/, '').replace(/\/+$/, ''));
  return !paths.some(path => path === '/etc/cli-proxy-api' || path === '/etc' || path === '');
}

/**
 * Read-only check: the sandbox keeps the config directory read-only, or root still owns it (the
 * service then cannot replace its config file). Null when it cannot be told.
 */
export async function serviceConfigReadOnly(): Promise<boolean | null> {
  try {
    const { stdout } = await exec('/usr/bin/systemctl', ['show', '-p', 'ProtectSystem', '-p', 'ReadWritePaths', 'cli-proxy-api.service'], { timeout: 8_000 });
    if (configDirectoryReadOnly(String(stdout))) return true;
    const directory = await lstat('/etc/cli-proxy-api').catch(() => null);
    return directory ? directory.uid === 0 : null;
  } catch {
    return null;
  }
}

let repairing = false;

export async function repairConfigWrites(runPrivileged: InstallDeps['runPrivileged'] = async (file, args) => exec(file, args, { timeout: 120_000 })): Promise<void> {
  if (running || repairing) throw new Error('install_running');
  repairing = true;
  try {
    const [file, args] = repairCommand();
    await runPrivileged!(file, args).catch(failed);
  } finally {
    repairing = false;
  }
}

/** Upstream deploy/systemd unit, plus write access to its own config directory. */
export const UNIT_FILE = `[Unit]
Description=CLIProxyAPI service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cli-proxy-api
Group=cli-proxy-api
WorkingDirectory=/var/lib/cli-proxy-api
Environment=MANAGEMENT_STATIC_PATH=/var/lib/cli-proxy-api/static
ExecStart=/usr/local/bin/cli-proxy-api --config /etc/cli-proxy-api/config.yaml
Restart=on-failure
RestartSec=5s
UMask=0077
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectClock=true
ProtectControlGroups=true
ProtectHome=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
ReadWritePaths=/var/lib/cli-proxy-api /etc/cli-proxy-api
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
`;

const SAFE_SECRET = /^[A-Za-z0-9_-]{16,128}$/;

/** Used when the release has no config.example.yaml or its layout changed. */
export function minimalConfig(managementKey: string, apiKey: string): string {
  if (!SAFE_SECRET.test(managementKey) || !/^sk-marks-[A-Za-z0-9_-]{43}$/.test(apiKey)) throw new Error('install_failed');
  return [
    'config-version: 8', 'server:', '  host: "127.0.0.1"', '  port: 18081', 'management:', '  allow-remote: false',
    `  secret-key: "${managementKey}"`, 'access:', '  api-keys:', `    - "${apiKey}"`,
    'oauth:', '  auth-dir: "/var/lib/cli-proxy-api/auths"', ''
  ].join('\n');
}

/**
 * The release's config.example.yaml with loopback 127.0.0.1:18081, the generated management
 * password and API key, and the state directory for OAuth files. Every edit is anchored on the
 * upstream example's exact lines; if any anchor is missing the minimal config is used instead.
 */
export function configFromExample(example: string | null, managementKey: string, apiKey: string): string {
  const fallback = minimalConfig(managementKey, apiKey);
  if (!example) return fallback;
  const edits: Array<[RegExp, string]> = [
    [/^(server:\n(?:(?: {2,}.*|\s*#.*|)\n)*?) {2}host: ""[^\n]*$/m, `$1  host: "127.0.0.1"`],
    [/^(server:\n(?:(?: {2,}.*|\s*#.*|)\n)*?) {2}port: \d+[^\n]*$/m, '$1  port: 18081'],
    [/^(management:\n(?:(?: {2,}.*|\s*#.*|)\n)*?) {2}secret-key: ""[^\n]*$/m, `$1  secret-key: "${managementKey}"`],
    [/^(access:\n(?:(?: {2,}.*|\s*#.*|)\n)*?) {2}api-keys:\n(?: {4}- "[^"\n]*"\n)+/m, `$1  api-keys:\n    - "${apiKey}"\n`],
    [/^(oauth:\n(?:(?: {2,}.*|\s*#.*|)\n)*?) {2}auth-dir: "[^"\n]*"[^\n]*$/m, '$1  auth-dir: "/var/lib/cli-proxy-api/auths"']
  ];
  let config = example.replace(/\r\n/g, '\n');
  for (const [pattern, replacement] of edits) {
    if (!pattern.test(config)) return fallback;
    config = config.replace(pattern, replacement);
  }
  return config;
}

/** Positional arguments must be files this module created in its own staging directory. */
function stagedPath(path: string, root: string, name: string): string {
  if (!root.startsWith(join(tmpdir(), STAGING_PREFIX)) || !/^[A-Za-z0-9._/-]+$/.test(path) || path !== join(root, name)) {
    throw new Error('install_failed');
  }
  return path;
}

/** The exact argument arrays given to pkexec. */
export function updateCommand(root: string, binary: string): [string, string[]] {
  return [PKEXEC, [SH, '-c', UPDATE_SCRIPT, 'marks-cliproxy-update', stagedPath(binary, root, MEMBER)]];
}

export function installCommand(root: string, binary: string, unit: string, config: string): [string, string[]] {
  return [PKEXEC, [SH, '-c', INSTALL_SCRIPT, 'marks-cliproxy-install',
    stagedPath(binary, root, MEMBER), stagedPath(unit, root, 'cli-proxy-api.service'), stagedPath(config, root, 'config.yaml')]];
}

async function extractMember(archive: string, root: string, member: string): Promise<boolean> {
  try {
    await exec('/usr/bin/tar', ['-xzf', archive, '-C', root, '--no-same-owner', '--no-same-permissions', '--', member], { timeout: 60_000 });
  } catch {
    return false;
  }
  const info = await lstat(join(root, member)).catch(() => null);
  return !!info?.isFile() && !info.isSymbolicLink();
}

async function isElf(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    return head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    await handle.close();
  }
}

export interface InstallDeps {
  fetchImpl?: typeof fetch;
  /** Runs the one privileged command; tests replace it. */
  runPrivileged?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  onProgress?: (progress: CliProxyInstallProgress) => void;
  /** Saves the generated secrets after a fresh install wrote its config. */
  saveSecrets?: (managementKey: string, apiKey: string) => Promise<void>;
}

let running = false;

export function installRunning(): boolean { return running; }

/**
 * `mode` install writes the unit and config when the service is missing; update replaces only the
 * binary. `expected` is the version the user confirmed: a newer release published meanwhile
 * is refused rather than installed unseen.
 */
export async function installRelease(mode: 'install' | 'update', expected: string, deps: InstallDeps = {}): Promise<CliProxyInstallProgress> {
  if (running) throw new Error('install_running');
  running = true;
  let root: string | null = null;
  let progress: CliProxyInstallProgress = { mode, phase: 'downloading', version: expected };
  const report = (next: Partial<CliProxyInstallProgress>): void => {
    progress = { ...progress, ...next };
    deps.onProgress?.(progress);
  };
  try {
    const release: CliProxyRelease = await latestRelease({ fetchImpl: deps.fetchImpl });
    if (release.version !== expected) throw new Error('version_changed');
    const assets = releaseAssets(release);
    if (!assets) throw new Error('unsupported_platform');
    report({ phase: 'downloading' });
    const [archive, checksums] = await Promise.all([
      downloadAsset(assets.archive.url, ARCHIVE_LIMIT, deps.fetchImpl),
      downloadAsset(assets.checksums.url, CHECKSUMS_LIMIT, deps.fetchImpl)
    ]);
    report({ phase: 'verifying' });
    verifyChecksum(archive, assets.archive.name, checksums.toString('utf8'));
    report({ phase: 'extracting' });
    root = await mkdtemp(join(tmpdir(), STAGING_PREFIX));
    await chmod(root, 0o700);
    const archivePath = join(root, 'release.tar.gz');
    await writeFile(archivePath, archive, { mode: 0o600 });
    if (!await extractMember(archivePath, root, MEMBER) || !await isElf(join(root, MEMBER))) throw new Error('extract_failed');
    await chmod(join(root, MEMBER), 0o755);
    report({ phase: 'installing' });
    const run = deps.runPrivileged ?? (async (file, args) => exec(file, args, { timeout: 300_000 }));
    if (mode === 'update') {
      const [file, args] = updateCommand(root, join(root, MEMBER));
      await run(file, args).catch(failed);
    } else {
      const example = await extractMember(archivePath, root, EXAMPLE) ? await readFile(join(root, EXAMPLE), 'utf8').catch(() => null) : null;
      const managementKey = randomBytes(24).toString('base64url');
      const apiKey = generateApiKey();
      await writeFile(join(root, 'cli-proxy-api.service'), UNIT_FILE, { mode: 0o644 });
      await writeFile(join(root, 'config.yaml'), configFromExample(example, managementKey, apiKey), { mode: 0o600 });
      const [file, args] = installCommand(root, join(root, MEMBER), join(root, 'cli-proxy-api.service'), join(root, 'config.yaml'));
      const { stdout } = await run(file, args).catch(failed);
      if (/^config-written$/m.test(stdout)) await deps.saveSecrets?.(managementKey, apiKey);
    }
    report({ phase: 'done' });
    return progress;
  } catch (error) {
    report({ phase: 'failed', error: (error as Error).message || 'install_failed' });
    throw error;
  } finally {
    running = false;
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** pkexec exits 126 when the user dismissed the password dialog, 127 when not authorized. */
function failed(error: unknown): never {
  const code = (error as { code?: unknown }).code;
  throw new Error(code === 126 || code === 127 ? 'install_cancelled' : 'install_failed');
}
