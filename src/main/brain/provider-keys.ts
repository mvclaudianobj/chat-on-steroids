/**
 * Chat Marks H1b: provider credentials live in the K vault, bound to the provider's exact origin.
 * Values go from the Brain page (or a MarksCode config the user chose to import) straight into
 * the vault; replies only say whether it worked. Saving requires the vault master password.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrainProviderId } from '../../shared/brain.js';
import { putVault } from '../marks-vault.js';
import { logInfo } from '../logger.js';
import { getBrainSettings } from './settings.js';

const HEADERS: Record<BrainProviderId, string> = { aiMemory: 'Authorization', openviking: 'Authorization', marksApi: 'X-API-Key' };

export async function storeProviderKey(id: BrainProviderId, raw: string, password: string): Promise<void> {
  const config = getBrainSettings().providers[id];
  const url = new URL(config.url);
  const value = raw.trim().replace(/^Bearer\s+/i, '');
  if (!value || /\s/.test(value)) throw new Error('The key must be one token without spaces');
  await putVault({ name: config.secret, value, origin: url.origin, header: HEADERS[id], ...(url.protocol === 'http:' ? { insecureHttp: true } : {}) }, password);
  logInfo(`brain: stored ${id} credential in the vault (${config.secret})`);
}

/** MarksCode config homes, the user's own first. A root-only file is reported as unreadable. */
export function markscodeConfigDirs(home = os.homedir()): string[] {
  return [...new Set([path.join(home, '.config', 'markscode'), '/root/.config/markscode'])];
}
async function readJson(file: string): Promise<any> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('not a config file');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
/** Reads only the one credential the provider needs; never returns it. */
export async function findMarksCodeCredential(id: 'aiMemory' | 'marksApi', dirs = markscodeConfigDirs()): Promise<string | null> {
  for (const dir of dirs) {
    try {
      if (id === 'aiMemory') {
        const config = await readJson(path.join(dir, 'markscode.json'));
        const headers = config?.mcp?.['ai-memory']?.headers ?? {};
        const header = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
        if (typeof header === 'string' && header.trim()) return header.trim().replace(/^Bearer\s+/i, '');
      } else {
        const access = await readJson(path.join(dir, 'access.json'));
        if (typeof access?.memories_api_key === 'string' && access.memories_api_key.trim()) return access.memories_api_key.trim();
      }
    } catch { /* missing or not readable by this user: try the next home */ }
  }
  return null;
}
export async function importMarksCodeCredential(id: 'aiMemory' | 'marksApi', password: string): Promise<boolean> {
  const value = await findMarksCodeCredential(id);
  if (!value) throw new Error('No readable MarksCode credential was found for this provider');
  await storeProviderKey(id, value, password);
  logInfo(`brain: imported ${id} credential from MarksCode config`);
  return true;
}
