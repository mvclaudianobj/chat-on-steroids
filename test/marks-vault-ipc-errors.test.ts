import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('electron', () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: { handle: vi.fn() } }));
const { vaultFailure } = await import('../src/main/marks-vault-ipc.js');

describe('vault refusal codes (a cleared password field once read as a wrong password)', () => {
  it('names an empty or short master password instead of calling it wrong', () => {
    const empty = z.object({ password: z.string().min(12) }).safeParse({ password: '' });
    expect(vaultFailure(empty.error)).toEqual({ code: 'password_required', field: 'password' });
  });
  it('names the field a secret is missing', () => {
    const bad = z.object({ name: z.string().min(1) }).safeParse({ name: '' });
    expect(vaultFailure(bad.error)).toEqual({ code: 'invalid_field', field: 'name' });
  });
  it('maps the vault module refusals to fixed codes, never to the input', () => {
    expect(vaultFailure(new Error('Vault already exists'))).toEqual({ code: 'vault_exists' });
    expect(vaultFailure(new Error('Invalid master password or damaged vault'))).toEqual({ code: 'wrong_password' });
    expect(vaultFailure(new Error('Vault needs recovery with the master password'))).toEqual({ code: 'needs_recovery' });
    expect(vaultFailure(new Error('Invalid secret origin'))).toEqual({ code: 'invalid_field', field: 'origin' });
    expect(vaultFailure(new Error('Error while encrypting the text provided to safeStorage.encryptString'))).toEqual({ code: 'keyring_unavailable' });
    expect(vaultFailure(new Error('super-secret-value leaked?'))).toEqual({ code: 'vault_failed' });
  });
});
