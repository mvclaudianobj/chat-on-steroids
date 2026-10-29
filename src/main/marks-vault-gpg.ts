/** GPG importer: bounded, no shell, no secret in argv/env/renderer/logs. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { VaultEntry } from './marks-vault.js';
const MAX_ENCRYPTED = 3 * 1024 * 1024;
const MAX_PLAINTEXT = 1024 * 1024;
/**
 * The orchestrator can export a JSON catalog ({entries: [...]}, or a named `secrets`
 * map). Entries without an origin remain available for later local integrations, but
 * model-facing HTTP use is blocked until an origin is explicitly configured.
 */
export function parseGpgVault(plaintext: string): VaultEntry[] {
  const parsed: unknown = JSON.parse(plaintext);
  const root = parsed as Record<string, unknown>;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('Unsupported GPG vault data');
  const input = Array.isArray(root.entries) ? root.entries : root.secrets;
  let candidates: unknown[];
  if (Array.isArray(input)) candidates = input;
  else if (input && typeof input === 'object') candidates = Object.entries(input).map(([name, value]) =>
    typeof value === 'string' ? { name, value } : { ...value as object, name });
  else throw new Error('Unsupported GPG vault catalog');
  if (candidates.length > 1000) throw new Error('Too many GPG credentials');
  return candidates.map(candidate => {
    const item = candidate as Record<string, unknown>;
    if (!item || typeof item !== 'object') throw new Error('Unsupported GPG entry');
    const value = item.value ?? item.secret ?? item.password ?? item.token;
    if (typeof item.name !== 'string' || typeof value !== 'string') throw new Error('GPG entry requires a name and secret');
    return { name: item.name, value, origin: typeof item.origin === 'string' ? item.origin : '', header: typeof item.header === 'string' ? item.header : 'Authorization' };
  });
}
export async function decryptGpgVault(filename: string, password: string): Promise<VaultEntry[]> {
  if (typeof password !== 'string' || password.length > 1024) throw new Error('Invalid GPG passphrase');
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > MAX_ENCRYPTED) throw new Error('GPG file exceeds import limit');
  return new Promise((resolve, reject) => {
    const child = spawn('gpg', ['--no-options', '--batch', '--yes', '--no-tty', '--pinentry-mode', 'loopback',
      '--passphrase-fd', '0', '--decrypt', '--', filename], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = []; let count = 0; let aborted = false;
    const timer = setTimeout(() => { aborted = true; child.kill(); }, 15_000);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      count += chunk.length;
      if (count > MAX_PLAINTEXT) { aborted = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('GPG is unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (aborted || code !== 0) return reject(new Error('GPG decrypt failed or exceeded resource limit'));
      try { resolve(parseGpgVault(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('GPG data does not have a supported catalog structure')); }
      finally { chunks.forEach(chunk => chunk.fill(0)); }
    });
    child.stdin.end(password + '\n');
  });
}
