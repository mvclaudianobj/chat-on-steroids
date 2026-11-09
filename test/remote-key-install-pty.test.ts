import { expect, it } from 'vitest';
import { installMasterKeyWithPassword, normalizeHost } from '../src/main/remote/hosts.js';

it('installs the public half using fake SSH PTY, without putting password in process args', async () => {
  const profile = normalizeHost({ name: 'marks1', type: 'ssh', host: 'example.test', port: 22, user: 'worker' });
  const password = 'synthetic-test-password';
  let args: string[] = [], supplied = '';
  const spawn = ((_program: string, argv: string[]) => {
    args = argv;
    let data: ((chunk: string) => void) | undefined;
    let exit: ((event: { exitCode: number }) => void) | undefined;
    queueMicrotask(() => data?.('worker@example.test password:'));
    return {
      onData: (callback: (chunk: string) => void) => { data = callback; },
      onExit: (callback: (event: { exitCode: number }) => void) => { exit = callback; },
      write: (chunk: string) => { supplied = chunk; queueMicrotask(() => exit?.({ exitCode: 0 })); },
      kill: () => undefined
    };
  }) as unknown as typeof import('node-pty').spawn;
  await installMasterKeyWithPassword(profile, password, {
    publicKey: async () => 'ssh-ed25519 AAAA synthetic-public-key', spawn
  });
  expect(supplied).toBe(`${password}\r`);
  expect(JSON.stringify(args)).not.toContain(password);
  expect(args.join(' ')).toContain('StrictHostKeyChecking=yes');
  expect(args.join(' ')).toContain('authorized_keys');
  expect(args.join(' ')).not.toContain('BEGIN OPENSSH PRIVATE KEY');
});
