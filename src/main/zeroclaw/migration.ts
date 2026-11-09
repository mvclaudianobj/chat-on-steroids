/** Explicit, bounded MarksClaw -> ZeroClaw import. No CLI is ever launched.
 * A preview is the only entry point; it owns a short-lived single-use confirmation.
 * The source is read-only, and every import takes a private, complete backup first.
 */
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { MarksClawMigrationPreview, MarksClawMigrationResult } from '../../shared/upstream-module.js';

const MAX_CONFIG = 1024 * 1024;
const MAX_ITEMS = 20_000;
const MAX_BYTES = 10 * 1024 * 1024 * 1024;
const ALIAS = /^[a-z][a-z0-9_]{0,47}$/;
const PROVIDER = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)?$/;
type Section = 'risk_profiles' | 'runtime_profiles' | 'agents';
const SECTIONS: Section[] = ['risk_profiles', 'runtime_profiles', 'agents'];
type Table = Record<string, unknown>;
type Config = Record<Section, Record<string, Table>>;
type Inspection = { view: MarksClawMigrationPreview; sourceConfig: string; targetConfig: string | null; entries: Config };

let testHome: string | null = null;
/** Test-only: lets synthetic fixtures run without opening any personal profile. */
export function setMarksClawMigrationHomeForTests(home: string | null): void { testHome = home; pending = null; }
const home = (): string => testHome ?? os.homedir();
let pending: { id: string; fingerprint: string; deadline: number } | null = null;
let importing = false;

const object = (value: unknown): Table => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) ? value as Table : {};
const aliases = (value: unknown): Record<string, Table> => Object.fromEntries(
  Object.entries(object(value)).filter(([alias, data]) => ALIAS.test(alias) && Object.keys(object(data)).length > 0).slice(0, 64).map(([name, data]) => [name, object(data)])
);
const knownNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
const knownBool = (value: unknown): value is boolean => typeof value === 'boolean';

/** Allowlist, never a generic TOML clone: credentials, URLs, shell paths and unverified
 * memory/storage schemas do not cross. Missing required provider/risk references are omitted.
 */
export function compatibleMarksClawSections(raw: unknown): Config {
  const src = object(raw);
  const risks: Record<string, Table> = {};
  for (const [name, entry] of Object.entries(aliases(src.risk_profiles))) {
    const level = entry.level;
    if (level === 'readonly' || level === 'supervised' || level === 'full') risks[name] = { level };
  }
  const runtimes: Record<string, Table> = {};
  for (const [name, entry] of Object.entries(aliases(src.runtime_profiles))) {
    const selected: Table = {};
    for (const key of ['agentic', 'parallel_tools', 'single_tool_rounds', 'compact_context']) if (knownBool(entry[key])) selected[key] = entry[key];
    for (const key of ['max_tool_iterations', 'max_history_messages', 'max_context_tokens', 'max_recursion_depth', 'agentic_timeout_secs']) {
      if (knownNumber(entry[key])) selected[key] = entry[key];
    }
    if (Object.keys(selected).length) runtimes[name] = selected;
  }
  const agents: Record<string, Table> = {};
  const sourceProviders = object(object(src.providers).models);
  for (const [name, entry] of Object.entries(aliases(src.agents))) {
    const result: Table = {};
    if (typeof entry.risk_profile === 'string' && (risks[entry.risk_profile] || entry.risk_profile === 'default')) result.risk_profile = entry.risk_profile;
    if (typeof entry.runtime_profile === 'string' && runtimes[entry.runtime_profile]) result.runtime_profile = entry.runtime_profile;
    // A provider without a corresponding non-secret upstream configuration is not runnable.
    // Never point an imported agent at the retired `marks` provider or transplant API keys.
    if (typeof entry.model_provider === 'string' && PROVIDER.test(entry.model_provider) && !entry.model_provider.startsWith('marks') &&
      (entry.model_provider.split('.').length === 1 || Object.keys(sourceProviders).length === 0)) {
      // Bare canonical family ids can resolve by ZeroClaw's own config/environment.
      if (!entry.model_provider.includes('.')) result.model_provider = entry.model_provider;
    }
    // Imported agents remain inactive until the user checks the upstream provider and credentials.
    result.enabled = false;
    if (Object.keys(result).length) agents[name] = result;
  }
  return { risk_profiles: risks, runtime_profiles: runtimes, agents };
}

async function regularFile(file: string): Promise<boolean> {
  try {
    if (!(await lstat(file)).isFile()) throw new Error('unsafe_config_file');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function directory(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file);
    if (!stat.isDirectory()) throw new Error('unsafe_directory');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function toml(file: string): Promise<{ raw: string; parsed: Table } | null> {
  if (!(await regularFile(file))) return null;
  const stat = await lstat(file);
  if (stat.size > MAX_CONFIG) throw new Error('config_too_large');
  // O_NOFOLLOW closes the stat/open symlink race on source config.
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const raw = await fd.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(raw) > MAX_CONFIG) throw new Error('config_too_large');
    try { return { raw, parsed: object(parse(raw)) }; }
    catch { throw new Error('invalid_config'); }
  } finally { await fd.close(); }
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const names = (value: Record<string, Table>): string[] => Object.keys(value).sort();

async function inspect(): Promise<Inspection> {
  // The Windows ZeroClaw module runs inside WSL. Reading the Windows user HOME would
  // inspect a different profile, so refuse until a WSL-scoped importer is available.
  if (process.platform === 'win32' && testHome === null) throw new Error('migration_requires_wsl');
  const root = home();
  const source = path.join(root, '.marksclaw');
  const target = path.join(root, '.zeroclaw');
  const exists = await directory(source);
  await directory(target);
  const sourceToml = exists ? await toml(path.join(source, 'config.toml')) : null;
  const targetToml = await toml(path.join(target, 'config.toml'));
  const entries = compatibleMarksClawSections(sourceToml?.parsed);
  const existing = targetToml ? object(targetToml.parsed) : {};
  const collisions: string[] = [];
  let count = 0;
  for (const section of SECTIONS) {
    const targetAliases = object(existing[section]);
    for (const alias of names(entries[section])) {
      if (Object.hasOwn(targetAliases, alias)) collisions.push(`${section}.${alias}`);
      else count++;
    }
  }
  const view: MarksClawMigrationPreview = {
    available: exists,
    configuration: Boolean(sourceToml),
    sessions: exists && await regularFile(path.join(source, 'data', 'sessions', 'sessions.db')),
    devices: exists && await regularFile(path.join(source, 'devices.db')),
    encryptedCredentials: exists && await regularFile(path.join(source, '.secret_key')),
    agents: names(entries.agents), riskProfiles: names(entries.risk_profiles), runtimeProfiles: names(entries.runtime_profiles),
    existingZeroClaw: Boolean(targetToml), conflicts: collisions,
    importable: count,
    // Ticket never includes paths, config values, OAuth data or secrets.
    ticket: ''
  };
  return { view, sourceConfig: sourceToml?.raw ?? '', targetConfig: targetToml?.raw ?? null, entries };
}

export async function marksClawMigrationPreview(): Promise<MarksClawMigrationPreview> {
  pending = null;
  const inspection = await inspect();
  if (!inspection.view.available || !inspection.view.configuration) return inspection.view;
  const id = randomUUID();
  const fingerprint = digest(inspection.sourceConfig + '\0' + (inspection.targetConfig ?? ''));
  pending = { id, fingerprint, deadline: Date.now() + 5 * 60_000 };
  return { ...inspection.view, ticket: id };
}

async function copyPrivateTree(source: string, destination: string, budget: { count: number; bytes: number }, depth = 0): Promise<void> {
  if (depth > 32) throw new Error('backup_too_deep');
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory()) throw new Error('unsafe_source');
  const children = await readdir(source);
  for (const name of children) {
    if (++budget.count > MAX_ITEMS) throw new Error('backup_too_many_files');
    const from = path.join(source, name), to = path.join(destination, name);
    const info = await lstat(from);
    if (info.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      await copyPrivateTree(from, to, budget, depth + 1);
    } else if (info.isFile()) {
      budget.bytes += info.size;
      if (budget.bytes > MAX_BYTES) throw new Error('backup_too_large');
      const reader = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (!(await reader.stat()).isFile()) throw new Error('unsafe_source');
        const writer = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          // Copy from the already-verified descriptor, without reopening a changing path.
          const chunk = Buffer.allocUnsafe(64 * 1024);
          let offset = 0;
          for (;;) {
            const { bytesRead } = await reader.read(chunk, 0, chunk.length, offset);
            if (!bytesRead) break;
            if ((offset += bytesRead) > info.size || offset > MAX_BYTES) throw new Error('backup_source_changed');
            await writer.writeFile(chunk.subarray(0, bytesRead));
          }
          if (offset !== info.size) throw new Error('backup_source_changed');
          await writer.sync();
        } finally { await writer.close(); }
      } finally { await reader.close(); }
    } else throw new Error('unsafe_source');
  }
}

/** Only absent profiles are appended; existing TOML (including its comments and secrets) is
 * preserved byte for byte. All target updates follow a successful complete private backup.
 */
export async function importMarksClaw(ticket: string): Promise<MarksClawMigrationResult> {
  if (importing) throw new Error('migration_busy');
  const issued = pending;
  pending = null;
  if (!issued || ticket !== issued.id || Date.now() > issued.deadline) throw new Error('preview_expired');
  importing = true;
  try {
    const found = await inspect();
    if (digest(found.sourceConfig + '\0' + (found.targetConfig ?? '')) !== issued.fingerprint) throw new Error('preview_changed');
    if (!found.view.configuration) throw new Error('no_marksclaw_config');
    const root = home();
    const backup = path.join(root, `.zeroclaw.marksclaw-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    await mkdir(backup, { mode: 0o700 });
    try {
      await mkdir(path.join(backup, 'marksclaw'), { mode: 0o700 });
      await copyPrivateTree(path.join(root, '.marksclaw'), path.join(backup, 'marksclaw'), { count: 0, bytes: 0 });
      if (found.targetConfig !== null) {
        const saved = await open(path.join(backup, 'zeroclaw-config.toml'), 'wx', 0o600);
        try { await saved.writeFile(found.targetConfig); await saved.sync(); } finally { await saved.close(); }
      }
    } catch (error) { await rm(backup, { recursive: true, force: true }); throw error; }

    const existing = found.targetConfig ? object(parse(found.targetConfig)) : {};
    const sections: string[] = [];
    for (const section of SECTIONS) {
      for (const alias of names(found.entries[section])) {
        if (Object.hasOwn(object(existing[section]), alias)) continue;
        const data = found.entries[section][alias]!;
        sections.push(stringify({ [section]: { [alias]: data } }).trim());
      }
    }
    if (!sections.length) return { backupCreated: true, backupName: path.basename(backup), imported: 0, skipped: found.view.conflicts.length };
    const targetDir = path.join(root, '.zeroclaw');
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    await directory(targetDir);
    const targetPath = path.join(targetDir, 'config.toml');
    const now = await toml(targetPath);
    if ((now?.raw ?? null) !== found.targetConfig) throw new Error('target_changed_after_backup');
    const content = `${found.targetConfig ?? ''}${found.targetConfig && !found.targetConfig.endsWith('\n') ? '\n' : ''}\n${sections.join('\n\n')}\n`;
    try { parse(content); } catch { throw new Error('incompatible_config'); }
    const temp = path.join(targetDir, `.marksclaw-import-${randomUUID()}.tmp`);
    const fh = await open(temp, 'wx', 0o600);
    try {
      await fh.writeFile(content); await fh.sync();
    } finally { await fh.close(); }
    try { await rename(temp, targetPath); } finally { await rm(temp, { force: true }); }
    return { backupCreated: true, backupName: path.basename(backup), imported: sections.length, skipped: found.view.conflicts.length };
  } finally { importing = false; }
}
