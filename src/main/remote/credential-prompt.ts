import { randomUUID } from 'node:crypto';

interface Reply { password: string; remember: boolean }
interface Pending { profileId: string; resolve: (answer: Reply | null) => void; timeout: NodeJS.Timeout }
const pending = new Map<string, Pending>();
const listeners = new Set<(request: { id: string; profileId: string; profileName: string }) => void>();
const keyPending = new Map<string, { resolve: (result: { confirmed: boolean; passphrase?: string }) => void; timeout: NodeJS.Timeout }>();
const keyListeners = new Set<(request: { id: string; profileName: string }) => void>();

export function onRemoteMasterKeyNeeded(listener: (request: { id: string; profileName: string }) => void): () => void {
  keyListeners.add(listener); return () => { keyListeners.delete(listener); };
}
/** Ask for explicit user consent before creating/synchronizing a private key. */
export function requestRemoteMasterKey(profileName: string): Promise<{ confirmed: boolean; passphrase?: string }> {
  if (!keyListeners.size || keyPending.size >= 8) return Promise.resolve({ confirmed: false });
  return new Promise(resolve => {
    const id = randomUUID();
    const timeout = setTimeout(() => { keyPending.delete(id); resolve({ confirmed: false }); }, 120000);
    timeout.unref?.(); keyPending.set(id, { resolve, timeout });
    for (const listener of keyListeners) listener({ id, profileName });
  });
}
export function answerRemoteMasterKey(id: string, response: { confirmed?: boolean; passphrase?: string }): boolean {
  const request = keyPending.get(id);
  if (!request) return false;
  keyPending.delete(id); clearTimeout(request.timeout);
  const passphrase = response.passphrase;
  request.resolve(response.confirmed === true && (!passphrase || (passphrase.length <= 1024 && !/[\r\n\0]/.test(passphrase)))
    ? { confirmed: true, ...(passphrase ? { passphrase } : {}) } : { confirmed: false });
  return true;
}

/** Only metadata is emitted. The password returns to the main process through exact-window IPC. */
export function onRemoteCredentialNeeded(listener: (request: { id: string; profileId: string; profileName: string }) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function requestRemoteCredential(profileId: string, profileName: string): Promise<Reply | null> {
  if (!listeners.size || pending.size >= 8) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = randomUUID();
    const timeout = setTimeout(() => { pending.delete(id); resolve(null); }, 120000);
    timeout.unref?.();
    pending.set(id, { profileId, resolve, timeout });
    for (const listener of listeners) listener({ id, profileId, profileName });
  });
}
export function answerRemoteCredential(id: string, value: { password?: string; remember?: boolean; cancel?: boolean }): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id); clearTimeout(entry.timeout);
  const password = value.password;
  if (value.cancel || !password || password.length > 4096 || /[\r\n\0]/.test(password)) entry.resolve(null);
  else entry.resolve({ password, remember: value.remember === true });
  return true;
}
export function resetRemoteCredentialsForTests(): void {
  for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.resolve(null); }
  pending.clear(); listeners.clear();
  for (const entry of keyPending.values()) { clearTimeout(entry.timeout); entry.resolve({ confirmed: false }); }
  keyPending.clear(); keyListeners.clear();
}
