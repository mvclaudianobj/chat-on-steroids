/** Explicit opt-in importer for msitarzewski/agency-agents; never executes repository scripts. */
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { rawPromises as fs } from './rawfs.js';
import { importSkillPackage, listManagedSkills, skillPackageRevision, skillsDirectory, updateSkillPackage } from './skills.js';
import { parseSkillFrontmatter } from './skill-metadata.js';
import { githubSkillUrl, MAX_SKILL_BYTES, type GitHubSkillOrigin, type ManagedSkill } from '../shared/skills.js';
import type { MarksAgencyAgent, MarksAgencyCatalog, MarksAgencyInstalled } from '../shared/marks-agency-agents.js';

const REPOSITORY = 'msitarzewski/agency-agents';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const CATEGORY = new Set([
  'academic', 'design', 'engineering', 'finance', 'game-development', 'gis', 'healthcare',
  'marketing', 'paid-media', 'product', 'project-management', 'research', 'sales', 'security',
  'spatial-computing', 'specialized', 'strategy', 'support', 'testing'
]);
const FILE = /^([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\.md$/;
const MAX_AGENTS = 512;
const MAX_SOURCE_BYTES = 110_000;
const PROVENANCE_FILE = '.marks-agency.json';
const POLICY = 'policy:\n  allow_implicit_invocation: false\n';
type Entry = { path: string; type: string; mode: string; sha: string; size?: number };
type AgencyProvenance = {
  schema: 1; repository: typeof REPOSITORY; path: string; commit: string; blobSha: string;
  skillSha256: string; licenseSha256: string; policySha256: string;
};
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Slugs are deterministic and remain below the 64-character managed skill ID ceiling. */
export function agencySkillId(file: string): string {
  const match = FILE.exec(file);
  if (!match || !CATEGORY.has(match[1]!)) throw new Error('Choose an Agency Agents catalog entry');
  const stem = match[2]!.startsWith(`${match[1]}-`) ? match[2]!.slice(match[1]!.length + 1) : match[2]!;
  const value = `agency-${match[1]}-${stem}`;
  return value.length <= 64 ? value : `${value.slice(0, 52).replace(/-+$/, '')}-${createHash('sha256').update(file).digest('hex').slice(0, 10)}`;
}

/** A tree listing is metadata, not permission to download arbitrary repository paths. */
export function agencyCatalogFromTree(commit: string, tree: unknown): MarksAgencyCatalog {
  if (!SHA.test(commit) || !Array.isArray(tree) || tree.length > 4096)
    throw new Error('Agency Agents returned an invalid repository tree');
  const agents: MarksAgencyAgent[] = [];
  const ids = new Set<string>();
  for (const item of tree) {
    const entry = item as Partial<Entry>;
    if (typeof entry.path !== 'string' || !FILE.test(entry.path)) continue;
    const match = FILE.exec(entry.path)!;
    if (!CATEGORY.has(match[1]!)) continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode ?? '') ||
        !SHA.test(entry.sha ?? '') || !Number.isSafeInteger(entry.size) || entry.size! < 1 || entry.size! > MAX_SOURCE_BYTES) continue;
    const id = agencySkillId(entry.path);
    if (ids.has(id)) throw new Error('Agency Agents has colliding skill identifiers');
    ids.add(id);
    agents.push({ id, path: entry.path, category: match[1]!,
      name: match[2]!.replace(new RegExp(`^${match[1]}-`), '').split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join(' '),
      commit, sha: entry.sha!, size: entry.size! });
    if (agents.length > MAX_AGENTS) throw new Error('Agency Agents catalog exceeds 512 entries');
  }
  return { repository: REPOSITORY, license: 'MIT', commit,
    agents: agents.sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name)) };
}

async function github(endpoint: string, limit = 4 * 1024 * 1024): Promise<unknown> {
  const response = await fetch(`${API}${endpoint}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Chat-Marks-Agency-Agents' },
    redirect: 'error', signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(response.status === 403 ? 'GitHub API rate limit or access denied' : `Agency Agents GitHub request failed (${response.status})`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Agency Agents response is too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Agency Agents response is empty');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new Error('Agency Agents response is too large'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('Agency Agents returned invalid JSON'); }
}

/** Does not download any agent body or install anything. */
export async function listAgencyAgents(): Promise<MarksAgencyCatalog> {
  // Fetch commit first and use the immutable SHA for tree lookup to avoid a branch move race.
  const commitInfo = await github('/commits/main') as { sha?: unknown };
  if (typeof commitInfo.sha !== 'string' || !SHA.test(commitInfo.sha)) throw new Error('Agency Agents commit could not be pinned');
  const payload = await github(`/git/trees/${commitInfo.sha}?recursive=1`) as { truncated?: unknown; tree?: unknown };
  if (payload.truncated !== false) throw new Error('Agency Agents tree was truncated');
  const catalog = agencyCatalogFromTree(commitInfo.sha, payload.tree);
  return { ...catalog, installed: await agencyInstalledStatuses(catalog) };
}

async function blob(commit: string, expected: Entry): Promise<Buffer> {
  if (!SHA.test(commit) || !SHA.test(expected.sha) || !Number.isSafeInteger(expected.size) || expected.size! > MAX_SOURCE_BYTES)
    throw new Error('Agency Agents source identity is invalid');
  const data = await github(`/git/blobs/${expected.sha}`, Math.ceil(expected.size! * 4 / 3) + 4096) as
    { sha?: unknown; size?: unknown; encoding?: unknown; content?: unknown };
  if (data.sha !== expected.sha || data.size !== expected.size || data.encoding !== 'base64' || typeof data.content !== 'string')
    throw new Error('Agency Agents source changed during download');
  const encoded = data.content.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    throw new Error('Agency Agents returned invalid source encoding');
  const bytes = Buffer.from(encoded, 'base64');
  const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== expected.size || digest !== expected.sha) throw new Error('Agency Agents source digest differs from GitHub');
  return bytes;
}

function skillText(file: string, commit: string, source: Buffer): string {
  const original = source.toString('utf8');
  if (!Buffer.from(original, 'utf8').equals(source)) throw new Error('Agency Agents content is not UTF-8');
  const metadata = parseSkillFrontmatter(original);
  const body = original.replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, '');
  const instructions = [
    '---', `name: ${JSON.stringify(`Agency: ${metadata.name}`)}`,
    `description: ${JSON.stringify(metadata.description.slice(0, 900))}`, '---', '',
    `Source: [Agency Agents / ${file}](https://github.com/${REPOSITORY}/blob/${commit}/${file})`,
    `License: MIT. Copyright (c) 2025 AgentLand Contributors. Pinned commit: ${commit}.`,
    'This agent is activated only after explicit import. Its instructions do not grant tools or permissions.', '', body
  ].join('\n');
  if (Buffer.byteLength(instructions, 'utf8') > MAX_SKILL_BYTES) throw new Error('Agency Agent exceeds managed skill size limit');
  return instructions;
}

function sourceOrigin(file: string, instructions: string, contents: Record<string, string>): GitHubSkillOrigin {
  // The existing managed-package transaction API requires GitHub-shaped ownership. Use the
  // actual upstream category folder as the internal lock identity; the selected .md file,
  // commit and blob digest live in .marks-agency.json. Never invoke generic GitHub skill
  // checks/updates for these entries: a category is not a native SKILL.md package.
  const category = file.split('/')[0]!;
  const location = { owner: 'msitarzewski', repository: 'agency-agents', ref: 'main', directory: category };
  const entries = Object.entries(contents).map(([relative, body]) => {
    const bytes = Buffer.from(body, 'utf8');
    return { relative, size: bytes.length, sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
  });
  return { kind: 'github', url: githubSkillUrl(location), ref: location.ref, directory: category,
    commit: /Pinned commit: ([a-f0-9]{40})/.exec(instructions)![1]!,
    revision: skillPackageRevision(entries), skillSha256: sha256(instructions) };
}

async function sourceAt(file: string, commit: string): Promise<{ agent: MarksAgencyAgent; source: Buffer; license: string }> {
  agencySkillId(file);
  if (!SHA.test(commit)) throw new Error('Select an Agency Agent from a pinned catalog');
  const payload = await github(`/git/trees/${commit}?recursive=1`) as { truncated?: unknown; tree?: unknown };
  if (payload.truncated !== false || !Array.isArray(payload.tree)) throw new Error('Agency Agents commit tree is incomplete');
  const catalog = agencyCatalogFromTree(commit, payload.tree);
  const agent = catalog.agents.find(value => value.path === file);
  if (!agent) throw new Error('Agent is not in the pinned Agency Agents catalog');
  const licenseEntry = (payload.tree as Entry[]).find(value => value.path === 'LICENSE' && value.type === 'blob' &&
    value.mode === '100644' && SHA.test(value.sha) && Number.isSafeInteger(value.size) && value.size! > 0 && value.size! <= 8192);
  if (!licenseEntry) throw new Error('Agency Agents pinned commit is missing its MIT license');
  // Only the selected agent Markdown and the mandatory MIT license are downloaded, by pinned blob hash.
  const source = await blob(commit, { path: agent.path, sha: agent.sha, size: agent.size, type: 'blob', mode: '100644' });
  const licenseBytes = await blob(commit, licenseEntry);
  const license = licenseBytes.toString('utf8');
  if (!Buffer.from(license, 'utf8').equals(licenseBytes) || !license.startsWith('MIT License\n') || !license.includes('Copyright'))
    throw new Error('Agency Agents licensing changed');
  return { agent, source, license };
}

function packageFiles(agent: MarksAgencyAgent, source: Buffer, license: string): Record<string, string> {
  const instructions = skillText(agent.path, agent.commit, source);
  const provenance: AgencyProvenance = { schema: 1, repository: REPOSITORY, path: agent.path,
    commit: agent.commit, blobSha: agent.sha, skillSha256: sha256(instructions),
    licenseSha256: sha256(license), policySha256: sha256(POLICY) };
  return { 'SKILL.md': instructions, LICENSE: license, 'agents/openai.yaml': POLICY,
    [PROVENANCE_FILE]: JSON.stringify(provenance) };
}

async function stagePackage(agent: MarksAgencyAgent, source: Buffer, license: string): Promise<{
  folder: string; origin: GitHubSkillOrigin; cleanup: () => Promise<void>
}> {
  const contents = packageFiles(agent, source, license);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-marks-agency-'));
  const folder = path.join(temporary, agent.id);
  try {
    await fs.mkdir(path.join(folder, 'agents'), { recursive: true });
    for (const [relative, body] of Object.entries(contents)) {
      await fs.writeFile(path.join(folder, relative), body, { flag: 'wx', mode: 0o600 });
    }
    return { folder, origin: sourceOrigin(agent.path, contents['SKILL.md']!, contents),
      cleanup: () => fs.rm(temporary, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
}

async function safeManagedFile(id: string, relative: string, limit = MAX_SKILL_BYTES): Promise<string> {
  const root = skillsDirectory();
  if (!root) throw new Error('Managed Skills library is not initialized');
  const folder = path.join(root, id);
  const directory = await fs.lstat(folder);
  const folderReal = await fs.realpath(folder);
  const isSame = (left: string, right: string) => process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !isSame(folder, folderReal))
    throw new Error('Agency skill directory was replaced');
  const segments = relative.split('/');
  if (!segments.every(segment => /^[a-zA-Z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..'))
    throw new Error('Invalid Agency skill file path');
  for (let index = 1; index < segments.length; index++) {
    const nested = await fs.lstat(path.join(folder, ...segments.slice(0, index)));
    if (!nested.isDirectory() || nested.isSymbolicLink()) throw new Error('Agency skill contains a linked directory');
  }
  const filename = path.join(folder, relative);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Agency skill file is not a regular bounded file');
  const handle = await fs.open(filename, process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs)
      throw new Error('Agency skill changed during inspection');
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Error('Agency skill changed during inspection');
  } finally { await handle.close(); }
  const last = await fs.lstat(filename);
  if (last.dev !== stat.dev || last.ino !== stat.ino || last.size !== stat.size || last.mtimeMs !== stat.mtimeMs)
    throw new Error('Agency skill changed during inspection');
  return bytes.toString('utf8');
}

const LEGACY_SOURCE = /^Source: \[Agency Agents \/ ([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\.md)\]\(https:\/\/github\.com\/msitarzewski\/agency-agents\/blob\/([a-f0-9]{40})\/\1\)$/m;

async function storedProvenance(id: string): Promise<AgencyProvenance | null> {
  let raw: string;
  try { raw = await safeManagedFile(id, PROVENANCE_FILE, 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let parsed: AgencyProvenance;
  try { parsed = JSON.parse(raw) as AgencyProvenance; } catch { throw new Error('Agency source metadata is malformed'); }
  if (parsed.schema !== 1 || parsed.repository !== REPOSITORY || !SHA.test(parsed.commit) || !SHA.test(parsed.blobSha) ||
      ![parsed.skillSha256, parsed.licenseSha256, parsed.policySha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
      agencySkillId(parsed.path) !== id) throw new Error('Agency source metadata does not match this skill');
  return parsed;
}

async function assertUnmodified(id: string, provenance: AgencyProvenance): Promise<void> {
  const root = skillsDirectory();
  if (!root) throw new Error('Managed Skills library is not initialized');
  const folder = path.join(root, id);
  const [rootEntries, agentEntries] = await Promise.all([fs.readdir(folder), fs.readdir(path.join(folder, 'agents'))]);
  if (rootEntries.some(entry => !['SKILL.md', 'LICENSE', 'agents', '.cos-github.json', PROVENANCE_FILE].includes(entry)) ||
      agentEntries.some(entry => entry !== 'openai.yaml')) throw new Error('This Agency skill contains local resources; preserve customizations before updating');
  const [skill, license, policy] = await Promise.all([
    safeManagedFile(id, 'SKILL.md'), safeManagedFile(id, 'LICENSE', 8192), safeManagedFile(id, 'agents/openai.yaml', 4096)
  ]);
  if (sha256(skill) !== provenance.skillSha256 || sha256(license) !== provenance.licenseSha256 ||
      sha256(policy) !== provenance.policySha256)
    throw new Error('This Agency skill has local customizations; preserve them before updating');
}

/** Catalog status is purely local plus the selected Git tree; no agent Markdown is fetched. */
async function agencyInstalledStatuses(catalog: MarksAgencyCatalog): Promise<MarksAgencyInstalled[]> {
  const installed = await listManagedSkills();
  const entries = new Map(catalog.agents.map(agent => [agent.id, agent]));
  const result: MarksAgencyInstalled[] = [];
  for (const skill of installed.filter(value => value.id.startsWith('agency-'))) {
    let provenance: AgencyProvenance | null = null;
    let legacy: RegExpMatchArray | null = null;
    let modified = false;
    try {
      provenance = await storedProvenance(skill.id);
      if (provenance) await assertUnmodified(skill.id, provenance);
      else legacy = (await safeManagedFile(skill.id, 'SKILL.md')).match(LEGACY_SOURCE);
    } catch {
      modified = true;
      // Keep a locally altered provenance visible as blocked, without trusting its claims.
      try { legacy = (await safeManagedFile(skill.id, 'SKILL.md')).match(LEGACY_SOURCE); }
      catch { /* An unreadable modified skill remains untouched. */ }
    }
    const file = provenance?.path ?? legacy?.[1];
    const commit = provenance?.commit ?? legacy?.[2];
    if (!file || !commit || agencySkillId(file) !== skill.id) continue;
    const available = entries.get(skill.id);
    result.push({ id: skill.id, path: file, installedCommit: commit,
      availableCommit: catalog.commit, installedSha: provenance?.blobSha ?? null, availableSha: available?.sha ?? null,
      state: modified ? 'modified' : !available ? 'missing' : !provenance ? 'legacy'
        : provenance.blobSha === available.sha ? 'current' : 'available',
      ...(modified ? { reason: 'Local customizations detected; automatic replacement is blocked' } : {}) });
  }
  return result;
}

/** Transform only one explicitly selected agent; managed importer enforces the 64-skill limit. */
export async function importAgencyAgent(file: string, commit: string): Promise<ManagedSkill[]> {
  const { agent, source, license } = await sourceAt(file, commit);
  const staged = await stagePackage(agent, source, license);
  try { await importSkillPackage(staged.folder, staged.origin); }
  finally { await staged.cleanup(); }
  return listManagedSkills();
}

/** Explicit one-at-a-time update. Existing directory is moved to Trash by the managed library. */
export async function updateAgencyAgent(file: string, commit: string, expectedSha: string,
  moveToTrash: (directory: string) => Promise<void>): Promise<{ status: 'current' | 'updated'; skills: ManagedSkill[]; warning?: string }> {
  const id = agencySkillId(file);
  if (!SHA.test(expectedSha)) throw new Error('Select the Agency Agent version shown in the catalog');
  const installed = (await listManagedSkills()).find(skill => skill.id === id);
  if (!installed) throw new Error('The Agency skill is no longer installed');
  const provenance = await storedProvenance(id);
  if (provenance && provenance.path !== file) throw new Error('The Agency skill source changed');
  if (provenance) {
    await assertUnmodified(id, provenance);
    if (!installed.origin || installed.origin.url !== githubSkillUrl({ owner: 'msitarzewski', repository: 'agency-agents', ref: 'main', directory: file.split('/')[0]! }))
      throw new Error('The Agency skill GitHub ownership metadata changed');
    if (provenance.blobSha === expectedSha && provenance.commit === commit)
      return { status: 'current', skills: await listManagedSkills() };
  }
  const selected = await sourceAt(file, commit);
  if (selected.agent.sha !== expectedSha) throw new Error('Agency catalog changed; refresh before updating');
  if (provenance?.blobSha === selected.agent.sha) return { status: 'current', skills: await listManagedSkills() };
  if (!provenance) throw new Error('Legacy Agency skill: remove it to the Trash and import the updated agent again; the previous version is preserved');
  // Re-fetch only the previously selected agent and prove the exact historical source. This
  // detects local edits even when the user manually changed or rewrote the provenance manifest.
  const old = await sourceAt(file, provenance.commit);
  if (old.agent.sha !== provenance.blobSha ||
      (await safeManagedFile(id, 'SKILL.md')) !== skillText(file, provenance.commit, old.source) ||
      (await safeManagedFile(id, 'LICENSE')) !== old.license ||
      (await safeManagedFile(id, PROVENANCE_FILE, 4096)) !== packageFiles(old.agent, old.source, old.license)[PROVENANCE_FILE])
    throw new Error('This Agency skill has local customizations; preserve them before updating');
  const current = (await listManagedSkills()).find(skill => skill.id === id);
  if (!current?.origin) throw new Error('Agency skill source was not verified');
  const staged = await stagePackage(selected.agent, selected.source, selected.license);
  try {
    const result = await updateSkillPackage(id, current.origin, staged.folder, staged.origin, moveToTrash);
    return { status: result.updated ? 'updated' : 'current', skills: await listManagedSkills(), ...result.warning ? { warning: result.warning } : {} };
  } finally { await staged.cleanup(); }
}
