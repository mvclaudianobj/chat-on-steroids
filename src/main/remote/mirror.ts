import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { getConfig } from '../config.js';
import { getProject } from '../projects.js';
import { resolvePath } from '../sandbox.js';
import { listRemoteHosts } from './hosts.js';
import { parseRemote, sftpFor } from './ssh.js';
import type { SftpClient } from './sftp.js';

const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_SINGLE_BYTES = 8 * 1024 * 1024;
/** Credentials from Cofre K are never imported, exported or materialized by the mirror. */
const excluded = (name: string): boolean => /^(?:\.env(?:\..*)?|\.ssh|\.git|\.private|\.npmrc|\.netrc|\.aws|\.kube|\.gnupg|node_modules|secrets?\.(?:json|ya?ml|txt)|credentials?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(name);

/** Explicit one-way SFTP operation, bounded and non-destructive (never removes destination files). */
export async function syncRemoteProfileProject(projectId: string, direction: 'pull' | 'push', deps: {
  connect?: typeof sftpFor;
} = {}): Promise<{ files: number; bytes: number; skipped: number }> {
  const project = await getProject(projectId);
  if (!project?.remoteProfile || project.remote || project.ungrouped) throw new Error('Not a local remote-profile project');
  const profile = (await listRemoteHosts()).find(row => row.id === project.remoteProfile!.profileId && row.type === 'ssh');
  if (!profile) throw new Error('SSH profile not found');
  const localRoot = (await resolvePath(getConfig().roots, project.path)).real;
  if (localRoot !== project.path || !(await fs.stat(localRoot)).isDirectory()) throw new Error('Mirror folder is no longer approved');
  const remote = parseRemote(`${profile.user}@${profile.host}:${profile.port}`, project.remoteProfile.folder);
  const client: SftpClient = await (deps.connect ?? sftpFor)(remote);
  const query = remote.path === '~' ? '.' : remote.path.startsWith('~/') ? remote.path.slice(2) : remote.path;
  const remoteRoot = await client.realpath(query);
  if (!(await client.stat(remoteRoot)).isDirectory) throw new Error('Remote mirror folder is not a directory');
  let files = 0, bytes = 0, skipped = 0;
  const assertBudget = (size: number): void => {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SINGLE_BYTES || files >= MAX_FILES || bytes + size > MAX_TOTAL_BYTES)
      throw new Error('Mirror sync limit reached (300 files, 8 MiB each, 32 MiB total)');
  };
  const withinLocal = async (parts: string[]): Promise<string> => {
    const target = path.join(localRoot, ...parts);
    const checked = await resolvePath(getConfig().roots, target, { allowMissing: true });
    if (checked.real !== target || !target.startsWith(`${localRoot}${path.sep}`)) throw new Error('Unsafe local mirror path');
    return target;
  };
  const ensureRemoteFolder = async (target: string): Promise<void> => {
    const stats = await client.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats) await client.mkdir(target);
    else if (!stats.isDirectory || stats.isSymbolicLink) throw new Error('Unsafe remote mirror folder');
  };
  const visit = async (parts: string[], depth: number): Promise<void> => {
    if (depth > 12) throw new Error('Mirror sync depth exceeded');
    const localFolder = parts.length ? await withinLocal(parts) : localRoot;
    const remoteFolder = path.posix.join(remoteRoot, ...parts);
    if (direction === 'pull' && parts.length) {
      const previous = await fs.lstat(localFolder).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error('Unsafe local mirror folder');
      if (!previous) await fs.mkdir(localFolder);
    }
    if (direction === 'push' && parts.length) await ensureRemoteFolder(remoteFolder);
    const names = direction === 'push'
      ? (await fs.readdir(localFolder, { withFileTypes: true })).map(row => ({ name: row.name, directory: row.isDirectory(), file: row.isFile(), link: row.isSymbolicLink() }))
      : (await client.readdir(remoteFolder)).map(row => ({ name: row.name, directory: row.isDirectory, file: row.isFile, link: row.isSymbolicLink }));
    for (const item of names) {
      if (item.name === '.' || item.name === '..' || item.name.includes('/') || item.name.includes('\\') || excluded(item.name) || item.link) { skipped++; continue; }
      if (!item.directory && !item.file) { skipped++; continue; }
      const next = [...parts, item.name];
      const target = await withinLocal(next);
      const remoteTarget = path.posix.join(remoteRoot, ...next);
      if (item.directory) { await visit(next, depth + 1); continue; }
      const sourceStats = direction === 'push' ? await fs.lstat(target) : await client.lstat(remoteTarget);
      if (direction === 'push' ? !(sourceStats as import('node:fs').Stats).isFile() || (sourceStats as import('node:fs').Stats).isSymbolicLink() : !(sourceStats as import('./sftp.js').SftpStats).isFile || (sourceStats as import('./sftp.js').SftpStats).isSymbolicLink) {
        skipped++; continue;
      }
      assertBudget(sourceStats.size);
      if (direction === 'pull') {
        const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('Unsafe local mirror file');
        const data = await client.readFile(remoteTarget, { maxBytes: MAX_SINGLE_BYTES + 1 });
        assertBudget(data.length);
        const temp = path.join(path.dirname(target), `.marks-sync-${randomUUID()}.tmp`);
        try { await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, target); }
        finally { await fs.rm(temp, { force: true }); }
      } else {
        const existing = await client.lstat(remoteTarget).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (existing && (!existing.isFile || existing.isSymbolicLink)) throw new Error('Unsafe remote mirror file');
        const data = await fs.readFile(target);
        assertBudget(data.length);
        await client.writeFile(remoteTarget, data);
      }
      files++; bytes += sourceStats.size;
    }
  };
  await visit([], 0);
  const latest = (await listRemoteHosts()).find(row => row.id === profile.id);
  if (!latest || JSON.stringify(latest) !== JSON.stringify(profile)) throw new Error('Remote profile changed during sync');
  return { files, bytes, skipped };
}
