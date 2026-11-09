import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agencyCatalogFromTree, agencySkillId, importAgencyAgent, listAgencyAgents, updateAgencyAgent } from '../src/main/marks-agency-agents.js';
import { initSkillsPath, listManagedSkills } from '../src/main/skills.js';

const commit = 'a'.repeat(40);
const nextCommit = 'b'.repeat(40);
const source = Buffer.from('---\nname: Backend Architect\ndescription: Create secure and reliable backend systems.\ncolor: blue\n---\n\n# Architect\n\nReview architecture carefully.\n');
const nextSource = Buffer.from(source.toString('utf8').replace('Review architecture carefully.', 'Review architecture carefully and cite the assumptions.'));
const license = Buffer.from('MIT License\n\nCopyright (c) 2025 AgentLand Contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n');
const digest = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const agentFile = 'engineering/engineering-backend-architect.md';
const entries = [
  { path: agentFile, type: 'blob', mode: '100644', sha: digest(source), size: source.length },
  { path: 'LICENSE', type: 'blob', mode: '100644', sha: digest(license), size: license.length },
  { path: 'scripts/untrusted.sh', type: 'blob', mode: '100755', sha: 'f'.repeat(40), size: 100 },
  { path: 'examples/not-an-agent.md', type: 'blob', mode: '100644', sha: 'e'.repeat(40), size: 42 }
];
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
let directory = '';

function githubFixture() {
  const requests: string[] = [];
  let head = commit;
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/commits/main')) return json({ sha: head });
    if (url.endsWith(`/git/trees/${commit}?recursive=1`)) return json({ truncated: false, tree: entries });
    if (url.endsWith(`/git/trees/${nextCommit}?recursive=1`)) return json({ truncated: false,
      tree: entries.map(value => value.path === agentFile ? { ...value, sha: digest(nextSource), size: nextSource.length } : value) });
    if (url.endsWith(`/git/blobs/${digest(source)}`)) return json({ sha: digest(source), size: source.length, encoding: 'base64', content: source.toString('base64') });
    if (url.endsWith(`/git/blobs/${digest(nextSource)}`)) return json({ sha: digest(nextSource), size: nextSource.length, encoding: 'base64', content: nextSource.toString('base64') });
    if (url.endsWith(`/git/blobs/${digest(license)}`)) return json({ sha: digest(license), size: license.length, encoding: 'base64', content: license.toString('base64') });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, fetch, advance: () => { head = nextCommit; } };
}

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marks-agency-test-')));
  await initSkillsPath(directory);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

it('browses metadata only, excluding scripts, other repo folders and unsafe paths', async () => {
  const github = githubFixture();
  const catalog = await listAgencyAgents();
  expect(catalog).toMatchObject({ repository: 'msitarzewski/agency-agents', license: 'MIT', commit });
  expect(catalog.agents).toEqual([{ id: 'agency-engineering-backend-architect', path: agentFile,
    name: 'Backend Architect', category: 'engineering', commit, sha: digest(source), size: source.length }]);
  expect(github.requests).toHaveLength(2);
  expect(github.requests.every(url => !url.includes('/git/blobs/'))).toBe(true);
  expect(() => agencySkillId('scripts/unsafe.md')).toThrow();
  expect(() => agencySkillId('../secrets.md')).toThrow();
  expect(agencyCatalogFromTree(commit, [{ path: agentFile, type: 'blob', mode: '120000', sha: digest(source), size: source.length }]).agents).toEqual([]);
});

it('imports exactly one pinned agent with MIT attribution and explicit-only invocation', async () => {
  const github = githubFixture();
  expect(await listManagedSkills()).toEqual([]);
  const installed = await importAgencyAgent(agentFile, commit);
  expect(installed).toMatchObject([{ id: 'agency-engineering-backend-architect', name: 'Agency: Backend Architect',
    origin: { kind: 'github', commit, directory: 'engineering' } }]);
  const root = path.join(directory, 'skills', installed[0]!.id);
  const skill = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
  expect(skill).toContain('Review architecture carefully.');
  expect(skill).toContain(`${commit}/${agentFile}`);
  expect(await fs.readFile(path.join(root, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2025 AgentLand Contributors');
  expect(await fs.readFile(path.join(root, 'agents/openai.yaml'), 'utf8')).toContain('allow_implicit_invocation: false');
  expect(github.requests.filter(request => request.includes('/git/blobs/'))).toHaveLength(2);
  await expect(importAgencyAgent(agentFile, commit)).rejects.toThrow(/already exists/);
  await expect(importAgencyAgent('scripts/untrusted.sh', commit)).rejects.toThrow(/catalog entry/);
  expect((await fs.readdir(path.join(directory, 'skills')))).toEqual([installed[0]!.id]);
});

it('fails closed on an incomplete tree and a mismatching source digest', async () => {
  const github = githubFixture();
  const base = github.fetch.getMockImplementation()!;
  github.fetch.mockImplementation(async input => String(input).includes('/git/trees/')
    ? json({ truncated: true, tree: entries }) : base(input));
  await expect(importAgencyAgent(agentFile, commit)).rejects.toThrow(/incomplete/);
  github.fetch.mockImplementation(async input => String(input).endsWith(`/git/blobs/${digest(source)}`)
    ? json({ sha: digest(source), size: source.length, encoding: 'base64', content: Buffer.alloc(source.length, 0).toString('base64') })
    : base(input));
  await expect(importAgencyAgent(agentFile, commit)).rejects.toThrow(/digest differs/);
  expect(await listManagedSkills()).toEqual([]);
});

it('refreshes catalog metadata without blobs, then updates only selected changed skill with a recoverable backup', async () => {
  const github = githubFixture();
  await importAgencyAgent(agentFile, commit);
  const first = await listAgencyAgents();
  expect(first.installed).toMatchObject([{ id: 'agency-engineering-backend-architect', state: 'current',
    installedCommit: commit, availableCommit: commit, installedSha: digest(source) }]);
  github.advance();
  const before = github.requests.length;
  const catalog = await listAgencyAgents();
  expect(github.requests.slice(before).every(url => !url.includes('/git/blobs/'))).toBe(true);
  expect(catalog.installed).toMatchObject([{ state: 'available', installedCommit: commit,
    availableCommit: nextCommit, installedSha: digest(source), availableSha: digest(nextSource) }]);
  expect(await fs.readFile(path.join(directory, 'skills/agency-engineering-backend-architect/SKILL.md'), 'utf8'))
    .not.toContain('cite the assumptions');
  const trash = path.join(directory, 'previous-agency');
  let removed = 0;
  const moveToTrash = async (folder: string) => { removed++; await fs.rename(folder, trash); };
  const result = await updateAgencyAgent(agentFile, nextCommit, digest(nextSource), moveToTrash);
  expect(result.status).toBe('updated');
  expect(removed).toBe(1);
  const newFile = path.join(directory, 'skills/agency-engineering-backend-architect/SKILL.md');
  expect(await fs.readFile(newFile, 'utf8')).toContain('cite the assumptions');
  expect(await fs.readFile(path.join(trash, 'SKILL.md'), 'utf8')).not.toContain('cite the assumptions');
  expect((await listAgencyAgents()).installed).toMatchObject([{ state: 'current', installedCommit: nextCommit, installedSha: digest(nextSource) }]);
  const requestsBeforeRepeat = github.requests.length;
  expect((await updateAgencyAgent(agentFile, nextCommit, digest(nextSource), moveToTrash)).status).toBe('current');
  expect(removed).toBe(1);
  expect(github.requests).toHaveLength(requestsBeforeRepeat);
});

it('blocks locally edited skills and stale catalog SHA without replacing the original', async () => {
  const github = githubFixture();
  await importAgencyAgent(agentFile, commit);
  github.advance();
  await expect(updateAgencyAgent(agentFile, nextCommit, digest(source), async () => {
    throw new Error('should never reach Trash');
  })).rejects.toThrow(/catalog changed/);
  const file = path.join(directory, 'skills/agency-engineering-backend-architect/SKILL.md');
  await fs.appendFile(file, '\nImportant local customization.\n');
  expect((await listAgencyAgents()).installed).toMatchObject([{ state: 'modified' }]);
  await expect(updateAgencyAgent(agentFile, nextCommit, digest(nextSource), async () => {
    throw new Error('should never reach Trash');
  })).rejects.toThrow(/customizations/);
  expect(await fs.readFile(file, 'utf8')).toContain('Important local customization.');
  const license = path.join(directory, 'skills/agency-engineering-backend-architect/LICENSE');
  await fs.appendFile(license, '\nLocal notice.\n');
  expect((await listAgencyAgents()).installed).toMatchObject([{ state: 'modified' }]);
});

it('recognizes the previous MVP format as legacy and requires a manual recoverable reimport', async () => {
  githubFixture();
  await importAgencyAgent(agentFile, commit);
  const folder = path.join(directory, 'skills/agency-engineering-backend-architect');
  await fs.rm(path.join(folder, '.marks-agency.json'));
  await fs.rm(path.join(folder, '.cos-github.json'));
  await initSkillsPath(directory);
  expect((await listAgencyAgents()).installed).toMatchObject([{ state: 'legacy', installedCommit: commit }]);
  await expect(updateAgencyAgent(agentFile, nextCommit, digest(nextSource), async () => {
    throw new Error('should not move legacy files');
  })).rejects.toThrow();
  expect(await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8')).toContain('Review architecture carefully.');
});
