/** Ephemeral, exact-chat authorization. Never stored in history or log. */
import { randomUUID } from 'node:crypto';
import { logInfo } from './logger.js';
interface Request { id: string; chat: string; name: string; operation: string; resolve: (ok: boolean) => void; timeout: NodeJS.Timeout }
const waiting = new Map<string, Request>();
const sessionGrants = new Set<string>();
/** The pending list changed: the window's banner reads it again instead of polling it. */
const changeListeners = new Set<() => void>();
export function onVaultApprovalsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
function changed(): void { for (const listener of changeListeners) listener(); }
function key(chat: string, name: string): string { return `${chat}\u0000${name}`; }
export function vaultApprovals(): Array<{ id: string; chat: string; name: string; operation: string }> {
  return [...waiting.values()].map(({ id, chat, name, operation }) => ({ id, chat, name, operation }));
}
export function requestVaultApproval(chat: string, name: string, operation: string): Promise<boolean> {
  if (!chat || !name) { logInfo('vault approval refused: missing verified chat or secret name'); return Promise.resolve(false); }
  if (sessionGrants.has(key(chat, name))) { logInfo('vault operation admitted: active chat-scoped grant'); return Promise.resolve(true); }
  logInfo('vault operation held: awaiting user approval');
  return new Promise(resolve => {
    const id = randomUUID();
    const timeout = setTimeout(() => { waiting.delete(id); logInfo('vault operation refused: approval timed out'); resolve(false); changed(); }, 120_000);
    timeout.unref?.();
    waiting.set(id, { id, chat, name, operation, resolve, timeout });
    changed();
  });
}
export function decideVaultApproval(id: string, choice: 'once' | 'session' | 'deny'): boolean {
  const entry = waiting.get(id);
  if (!entry) { logInfo('vault approval refused: request no longer pending'); return false; }
  waiting.delete(id); clearTimeout(entry.timeout);
  if (choice === 'session') sessionGrants.add(key(entry.chat, entry.name));
  logInfo(choice === 'deny' ? 'vault operation refused by user' : choice === 'once' ? 'vault operation approved once' : 'vault operation granted until chat/app termination');
  entry.resolve(choice !== 'deny');
  changed();
  return true;
}
/** A deleted or retired chat cannot retain its approval in this running process. */
export function revokeVaultChat(chat: string): void {
  for (const grant of sessionGrants) if (grant.startsWith(`${chat}\u0000`)) sessionGrants.delete(grant);
  for (const request of [...waiting.values()]) {
    if (request.chat !== chat) continue;
    waiting.delete(request.id);
    clearTimeout(request.timeout);
    request.resolve(false);
  }
  logInfo('vault chat authority revoked: chat deleted or retired');
  changed();
}
export function resetVaultApprovals(): void {
  for (const request of waiting.values()) { clearTimeout(request.timeout); request.resolve(false); }
  waiting.clear(); sessionGrants.clear();
  changed();
}
