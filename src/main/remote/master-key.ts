import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, promises as fs } from 'node:fs';
import { spawn as spawnPty } from 'node-pty';
import { putVaultLocal } from '../marks-vault.js';

const exec = promisify(execFile);
const rootKey = '/root/.ssh/marks-key-mestra';
const userKey = () => path.join(os.homedir(), '.ssh', 'marks-key-mestra');
const fileExists = async (file: string): Promise<boolean> => {
  try { const s = await fs.lstat(file); return s.isFile() && !s.isSymbolicLink(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
};

type KeyRunner = (program: string, args: string[]) => Promise<{ stdout: string }>;
const run: KeyRunner = async (program, args) => {
  try { const response = await exec(program, args, { timeout: 30000, maxBuffer: 65536 }); return { stdout: response.stdout }; }
  catch { throw new Error('Master key operation was not authorized or failed'); }
};
/** Returns only presence, never private key bytes. Root checks always require polkit. */
export async function masterKeyPresence(deps: { run?: KeyRunner; local?: string } = {}): Promise<{ user: boolean; root: boolean }> {
  const key = deps.local ?? userKey();
  const user = await fileExists(key);
  if (key === rootKey) return { user, root: user };
  const result = await (deps.run ?? run)('pkexec', ['/bin/sh', '-c', 'if test -f /root/.ssh/marks-key-mestra; then printf present; else printf absent; fi']);
  if (result.stdout !== 'present' && result.stdout !== 'absent') throw new Error('Could not verify root key');
  const root = result.stdout === 'present';
  return { user, root };
}

/** Run only after a native confirmation. Copy only a validated keypair, never arbitrary paths. */
export async function prepareMasterKeyPair(options: {
  confirmed: boolean; passphrase?: string; local?: string; run?: KeyRunner;
  generate?: (file: string, passphrase?: string) => Promise<void>;
}): Promise<'created' | 'copied-to-user' | 'copied-to-root' | 'ready'> {
  if (!options.confirmed) throw new Error('Master key operation requires approval');
  if (options.passphrase && /[\r\n\0]/.test(options.passphrase)) throw new Error('Invalid passphrase');
  const key = options.local ?? userKey();
  const runner = options.run ?? run;
  const presence = await masterKeyPresence({ local: key, run: runner });
  if (presence.user && presence.root) {
    const localPublic = (await fs.readFile(`${key}.pub`, 'utf8')).trim();
    const rootPublic = (await runner('pkexec', ['/bin/cat', `${rootKey}.pub`])).stdout.trim();
    if (!localPublic || localPublic !== rootPublic) throw new Error('Master keys differ; review before using either key');
    return 'ready';
  }
  const directory = path.dirname(key);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (presence.root && !presence.user) {
    for (const [from, to, mode] of [[rootKey, key, 0o600], [`${rootKey}.pub`, `${key}.pub`, 0o644]] as const) {
      const { stdout } = await runner('pkexec', ['/bin/cat', from]);
      if (!stdout || stdout.length > 16384 || (mode === 0o600 && !stdout.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'))) throw new Error('Invalid root master key');
      const handle = await fs.open(to, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
      try { await handle.writeFile(stdout, 'utf8'); } finally { await handle.close(); }
    }
    return 'copied-to-user';
  }
  if (!presence.user) {
    if (options.generate) await options.generate(key, options.passphrase);
    else {
    // Run ssh-keygen in a private PTY so an optional passphrase never enters argv or logs.
    await new Promise<void>((resolve, reject) => {
      const pty = spawnPty('ssh-keygen', ['-q', '-t', 'ed25519', '-f', key], { name: 'xterm', cols: 80, rows: 24, cwd: directory, env: { ...process.env, TERM: 'xterm' } });
      let entered = 0, ended = false, tail = '';
      const timer = setTimeout(() => finish(new Error('Master key generation timed out')), 30000);
      const finish = (error?: Error) => {
        if (ended) return; ended = true; clearTimeout(timer);
        if (error) { try { pty.kill(); } catch { /* exited */ } reject(error); } else resolve();
      };
      pty.onData(chunk => {
        tail = (tail + chunk).slice(-200);
        if (entered < 2 && /(?:Enter passphrase|Enter same passphrase again)[^:\r\n]*:\s*$/i.test(tail)) {
          entered++; pty.write((options.passphrase ?? '') + '\r'); tail = '';
        }
      });
      pty.onExit(({ exitCode }) => finish(exitCode === 0 && entered === 2 ? undefined : new Error('Master key generation failed')));
    });
    }
    if (options.passphrase) await putVaultLocal({ name: 'ssh/marks-key-mestra', value: options.passphrase, origin: '', header: 'Authorization' });
  }
  if (!(await fileExists(key)) || !(await fileExists(`${key}.pub`))) throw new Error('Master key missing after generation');
  // Install is made with two exact paths only, no shell and no private key in arguments.
  await runner('pkexec', ['/usr/bin/install', '-d', '-m', '700', '/root/.ssh']);
  await runner('pkexec', ['/usr/bin/install', '-m', '600', key, rootKey]);
  await runner('pkexec', ['/usr/bin/install', '-m', '644', `${key}.pub`, `${rootKey}.pub`]);
  return presence.user ? 'copied-to-root' : 'created';
}
