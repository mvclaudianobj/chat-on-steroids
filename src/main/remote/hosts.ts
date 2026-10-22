/** Named remote hosts. Profiles contain addresses only; credentials belong to the vault. */
import { promises as fs, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { parseRemote, sshArgs, sshProgram, sshFailure } from './ssh.js';
import { redactVaultText } from '../marks-vault-redaction.js';
import { useVault } from '../marks-vault.js';

export type HostType = 'ssh' | 'winrm' | 'powershell' | 'whm' | 'custom';
export interface HostProfile { id: string; name: string; type: HostType; host: string; port: number; user: string; credential?: string }
const TYPES: HostType[] = ['ssh', 'winrm', 'powershell', 'whm', 'custom'];
const execFileAsync = promisify(execFile);
let filename = '';
let serial: Promise<unknown> = Promise.resolve();
export function initRemoteHosts(userData: string): void { filename = path.join(userData, 'remote-hosts.json'); }
export function remoteHostsFileForTests(file: string): void { filename = file; serial = Promise.resolve(); }
export function normalizeHost(input: unknown): HostProfile {
  const row = input as Partial<HostProfile>;
  if (!row || !TYPES.includes(row.type!) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80 ||
    typeof row.host !== 'string' || typeof row.user !== 'string' || !Number.isInteger(row.port) || row.port! < 1 || row.port! > 65535 ||
    (row.credential !== undefined && (typeof row.credential !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$/.test(row.credential)))) throw new Error('Invalid host profile');
  // Reuse the existing SSH address validator, including the guard against option injection.
  parseRemote(`${row.user}@${row.host}`, '/');
  if (row.type === 'ssh' && row.credential) throw new Error('SSH profiles use a key or agent');
  return { id: typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id) ? row.id : randomUUID(),
    name: row.name.trim(), type: row.type!, host: row.host, port: row.port!, user: row.user, ...(row.credential ? { credential: row.credential } : {}) };
}
async function read(): Promise<HostProfile[]> {
  if (!filename) throw new Error('Host catalog is not initialized');
  let handle: import('node:fs/promises').FileHandle;
  try { handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Host catalog too large');
    const rows: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!Array.isArray(rows) || rows.length > 200) throw new Error('Invalid host catalog');
    return rows.map(normalizeHost);
  } finally { await handle.close(); }
}
async function write(rows: HostProfile[]): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(rows), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, filename); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
export function listRemoteHosts(): Promise<HostProfile[]> { return serial.then(() => read()); }
export function saveRemoteHost(input: unknown): Promise<HostProfile> {
  const operation = serial.then(async () => {
    const host = normalizeHost(input), rows = await read();
    if (rows.some(row => row.name.toLowerCase() === host.name.toLowerCase() && row.id !== host.id)) throw new Error('Host name already exists');
    const next = rows.filter(row => row.id !== host.id);
    if (next.length >= 200) throw new Error('Host limit reached');
    await write([...next, host]); return host;
  }); serial = operation.catch(() => undefined); return operation;
}
export function deleteRemoteHost(id: string): Promise<void> {
  const operation = serial.then(async () => { const rows = await read(); await write(rows.filter(row => row.id !== id)); });
  serial = operation.catch(() => undefined); return operation;
}
/** Publish the reviewed catalog in one write; a collision must not leave a partial import. */
export function importRemoteHosts(input: readonly HostProfile[]): Promise<HostProfile[]> {
  const operation = serial.then(async () => {
    const incoming = input.map(normalizeHost), rows = await read();
    if (rows.length + incoming.length > 200) throw new Error('Host limit reached');
    const names = new Set(rows.map(row => row.name.toLowerCase()));
    for (const row of incoming) {
      if (names.has(row.name.toLowerCase())) throw new Error('Host name already exists');
      names.add(row.name.toLowerCase());
      row.id = randomUUID();
    }
    await write([...rows, ...incoming]);
    return incoming;
  });
  serial = operation.catch(() => undefined); return operation;
}
export async function remoteHostByName(name: string): Promise<HostProfile> {
  const found = (await listRemoteHosts()).find(row => row.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error('Unknown remote host'); return found;
}
/** Import only the non-secret metadata. A preview never returns encrypted_password or metadata. */
export function parseRemoteTargets(text: string): HostProfile[] {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Import too large');
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length > 200) throw new Error('Invalid remote targets catalog');
  const profiles = parsed.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote target');
    const item = value as Record<string, unknown>;
    const type = item.type ?? item.protocol ?? 'ssh';
    if (!TYPES.includes(type as HostType)) throw new Error('Unsupported remote type');
    return normalizeHost({ name: item.name, type, host: item.host, user: item.user,
      port: item.port ?? (type === 'whm' ? 2087 : type === 'ssh' || type === 'custom' ? 22 : 5986) });
  });
  if (new Set(profiles.map(row => row.name.toLowerCase())).size !== profiles.length) throw new Error('Duplicate host names');
  return profiles;
}
export async function previewRemoteTargets(source: string): Promise<HostProfile[]> {
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid import file');
    return parseRemoteTargets(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
export function buildSshHostArgs(profile: HostProfile, command: string): string[] {
  normalizeHost(profile);
  if (!command.trim() || command.length > 8192 || command.includes('\0')) throw new Error('Invalid remote command');
  if (profile.type !== 'ssh') throw new Error('This remote type is not available yet');
  return sshArgs({ host: `${profile.user}@${profile.host}`, port: profile.port, path: '/' },
    ['-T', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-i', path.join(os.homedir(), '.ssh', 'marks-key-mestra')], [command]);
}
/** Read the system trust store first. A scan is untrusted until the person confirms its fingerprint. */
export async function hostKeyCandidate(profile: HostProfile): Promise<{ fingerprint: string; keys: string; known: boolean }> {
  if (profile.type !== 'ssh') throw new Error('SSH only');
  const address = profile.port === 22 ? profile.host : `[${profile.host}]:${profile.port}`;
  const knownHosts = path.join(os.homedir(), '.ssh', 'known_hosts');
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-F', address, '-f', knownHosts], { timeout: 5000, maxBuffer: 16384 });
    if (stdout.trim()) return { known: true, fingerprint: '', keys: '' };
  } catch { /* No matching key, or no known_hosts file. */ }
  const { stdout: keys } = await execFileAsync('ssh-keyscan', ['-T', '5', '-p', String(profile.port), profile.host], { timeout: 10000, maxBuffer: 32768 });
  const lines = keys.split('\n').filter(line => line && !line.startsWith('#'));
  if (!lines.length || lines.some(line => !line.startsWith(`${address} `) || !/^\S+ (?:ssh-ed25519|ecdsa-sha2-nistp256|rsa-sha2-\d+|ssh-rsa) [A-Za-z0-9+/=]+$/.test(line))) throw new Error('Invalid server key');
  const fingerprints = await Promise.all(lines.map(line => new Promise<string>((resolve, reject) => {
    const child = spawn('ssh-keygen', ['-lf', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 4096) child.kill(); });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); if (code === 0 && output.length <= 4096) resolve(output.trim()); else reject(new Error('Invalid server key')); });
    child.stdin.end(line + '\n');
  })));
  return { fingerprint: fingerprints.join('\n'), keys: lines.join('\n') + '\n', known: false };
}
export async function trustHostKeys(keys: string): Promise<void> {
  const directory = path.join(os.homedir(), '.ssh');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.appendFile(path.join(directory, 'known_hosts'), keys, { mode: 0o600 });
}
/** Install the public half only; the private master key never leaves this computer. */
export async function masterPublicKey(): Promise<string> {
  const source = path.join(os.homedir(), '.ssh', 'marks-key-mestra.pub');
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid master public key');
    const value = (await handle.readFile('utf8')).trim();
    if (!/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(value)) throw new Error('Invalid master public key');
    return value;
  } finally { await handle.close(); }
}
export function installKeyCommand(publicKey: string): string {
  const quoted = `'${publicKey.replace(/'/g, `'\\''`)}'`;
  return `umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && { grep -qxF -- ${quoted} ~/.ssh/authorized_keys || printf '%s\\n' ${quoted} >> ~/.ssh/authorized_keys; }`;
}
/** Password bootstrap through a private PTY. The password is never persisted or returned. */
export async function installMasterKeyWithPassword(profile: HostProfile, password: string): Promise<void> {
  if (profile.type !== 'ssh') throw new Error('SSH only');
  if (!password || password.length > 4096 || /[\r\n\0]/.test(password)) throw new Error('Invalid server password');
  const command = installKeyCommand(await masterPublicKey());
  const args = [
    '-tt', '-p', String(profile.port), '-o', 'BatchMode=no', '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'PubkeyAuthentication=no',
    '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'NumberOfPasswordPrompts=1', '--', `${profile.user}@${profile.host}`, command
  ];
  await new Promise<void>((resolve, reject) => {
    const pty = spawnPty(sshProgram(), args, { name: 'xterm', cols: 80, rows: 24, cwd: os.homedir(), env: { ...process.env, TERM: 'xterm' } });
    let seenPrompt = false, finished = false, tail = '';
    const timer = setTimeout(() => end(new Error('SSH password installation timed out')), 30_000);
    const end = (error?: Error): void => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) { try { pty.kill(); } catch { /* exited */ } reject(error); }
      else resolve();
    };
    pty.onData(chunk => {
      tail = (tail + chunk).slice(-1024);
      if (!seenPrompt && /(?:password|passwort|senha|contrase(?:ñ|n)a)\s*:\s*$/i.test(tail.replace(/\x1b\[[0-9;]*[a-z]/gi, ''))) {
        seenPrompt = true;
        pty.write(password + '\r');
      }
    });
    pty.onExit(({ exitCode }) => end(exitCode === 0 && seenPrompt ? undefined : new Error('SSH refused the server password or key installation failed')));
  });
}
/** The secret stays in the main process; ssh-add receives it through a private PTY. */
export async function unlockMasterKeyFromVault(): Promise<void> {
  await useVault('ssh/marks-key-mestra', async entry => {
    const key = path.join(os.homedir(), '.ssh', 'marks-key-mestra');
    const stat = await fs.stat(key);
    if (!stat.isFile()) throw new Error('SSH master key unavailable');
    await new Promise<void>((resolve, reject) => {
      const executable = process.platform === 'win32' ? path.join(path.dirname(sshProgram()), 'ssh-add.exe') : 'ssh-add';
      const pty = spawnPty(executable, ['-t', '1h', key], {
        name: 'xterm', cols: 80, rows: 24, cwd: os.homedir(), env: { ...process.env, TERM: 'xterm' }
      });
      let prompted = false, finished = false, tail = '';
      const timer = setTimeout(() => end(new Error('SSH agent unlock timed out')), 20_000);
      const end = (error?: Error): void => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (error) { try { pty.kill(); } catch { /* already exited */ } reject(error); }
        else resolve();
      };
      pty.onData(chunk => {
        tail = (tail + chunk).slice(-256);
        if (!prompted && /passphrase[^:\r\n]*:\s*$/i.test(tail.replace(/\x1b\[[0-9;]*[a-z]/gi, ''))) {
          prompted = true;
          pty.write(entry.value + '\r');
        }
      });
      pty.onExit(({ exitCode }) => end(exitCode === 0 ? undefined : new Error('SSH agent refused the master key')));
    });
    return 'unlocked';
  });
}
/** Bounded process: output is redacted before any result or error reaches the caller. */
export async function executeRemoteHost(profile: HostProfile, command: string): Promise<string> {
  if (!command || command.length > 8192) throw new Error('Invalid remote command');
  if (profile.type !== 'ssh') throw new Error('This remote type is not available yet');
  const args = buildSshHostArgs(profile, command);
  return new Promise((resolve, reject) => {
    const child = spawn(sshProgram(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '', error = '', size = 0, stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill(); }, 30_000);
    const collect = (chunk: Buffer, stderr: boolean) => {
      size += chunk.length; if (size > 65536) { stopped = true; child.kill(); return; }
      if (stderr) error += chunk.toString('utf8'); else output += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
    child.once('error', () => { clearTimeout(timer); reject(new Error('System SSH unavailable')); });
    child.once('close', code => { clearTimeout(timer);
      if (stopped) reject(new Error('Remote command exceeded its time or output limit'));
      else if (code !== 0) reject(new Error(redactVaultText(sshFailure(error))));
      else resolve(redactVaultText(output + error));
    });
  });
}
