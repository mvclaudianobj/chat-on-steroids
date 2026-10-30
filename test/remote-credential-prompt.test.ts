import { afterEach, expect, it } from 'vitest';
import { onRemoteCredentialNeeded, requestRemoteCredential, answerRemoteCredential, resetRemoteCredentialsForTests } from '../src/main/remote/credential-prompt.js';

afterEach(() => resetRemoteCredentialsForTests());

it('emits metadata only and returns SSH password to exactly one pending request', async () => {
  const received: Array<{ id: string; profileId: string; profileName: string }> = [];
  onRemoteCredentialNeeded(value => received.push(value));
  const promise = requestRemoteCredential('a-profile-id', 'marks1');
  expect(received).toHaveLength(1);
  expect(JSON.stringify(received)).not.toContain('synthetic-private-password');
  expect(answerRemoteCredential('not-the-request', { password: 'synthetic-private-password' })).toBe(false);
  expect(answerRemoteCredential(received[0]!.id, { password: 'synthetic-private-password', remember: true })).toBe(true);
  expect(await promise).toEqual({ password: 'synthetic-private-password', remember: true });
  expect(answerRemoteCredential(received[0]!.id, { password: 'another' })).toBe(false);
});

it('cancel is explicit and does not return a credential', async () => {
  let id = '';
  onRemoteCredentialNeeded(value => { id = value.id; });
  const result = requestRemoteCredential('id', 'marks2');
  expect(answerRemoteCredential(id, { cancel: true })).toBe(true);
  expect(await result).toBeNull();
});
