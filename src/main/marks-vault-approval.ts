/** Ephemeral, exact-chat authorization. Never stored in history or log. */
import { randomUUID } from 'node:crypto';
interface Request { id: string; chat: string; name: string; operation: string; resolve: (ok: boolean) => void; timeout: NodeJS.Timeout }
const waiting = new Map<string, Request>();
const sessionGrants = new Set<string>();
function key(chat: string, name: string): string { return `${chat}\u0000${name}`; }
export function vaultApprovals(): Array<{ id: string; chat: string; name: string; operation: string }> {
  return [...waiting.values()].map(({ id, chat, name, operation }) => ({ id, chat, name, operation }));
}
export function requestVaultApproval(chat: string, name: string, operation: string): Promise<boolean> {
  if (!chat || !name) return Promise.resolve(false);
  if (sessionGrants.has(key(chat, name))) return Promise.resolve(true);
  return new Promise(resolve => {
    const id = randomUUID();
    const timeout = setTimeout(() => { waiting.delete(id); resolve(false); }, 120_000);
    timeout.unref?.();
    waiting.set(id, { id, chat, name, operation, resolve, timeout });
  });
}
export function decideVaultApproval(id: string, choice: 'once' | 'session' | 'deny'): boolean {
  const entry = waiting.get(id);
  if (!entry) return false;
  waiting.delete(id); clearTimeout(entry.timeout);
  if (choice === 'session') sessionGrants.add(key(entry.chat, entry.name));
  entry.resolve(choice !== 'deny');
  return true;
}
export function resetVaultApprovals(): void {
  for (const request of waiting.values()) { clearTimeout(request.timeout); request.resolve(false); }
  waiting.clear(); sessionGrants.clear();
}
