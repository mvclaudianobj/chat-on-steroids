import { randomUUID } from 'node:crypto';
interface Request { id: string; chat: string; host: string; command: string; resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }
const pending = new Map<string, Request>();
const grants = new Set<string>();
const listeners = new Set<() => void>();
const changed = (): void => { for (const listener of listeners) listener(); };
export function onRemoteApprovalsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function remoteApprovals(): Array<{ id: string; chat: string; host: string; command: string }> {
  return [...pending.values()].map(({ id, chat, host, command }) => ({ id, chat, host, command }));
}
export function requestRemoteApproval(chat: string, host: string, command: string): Promise<boolean> {
  if (!chat || !host || !command || pending.size >= 32) return Promise.resolve(false);
  if (grants.has(chat)) return Promise.resolve(true);
  return new Promise(resolve => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); resolve(false); changed(); }, 120_000);
    timer.unref?.(); pending.set(id, { id, chat, host, command, resolve, timer }); changed();
  });
}
export function decideRemoteApproval(id: string, choice: 'once' | 'session' | 'deny'): boolean {
  const request = pending.get(id); if (!request) return false;
  pending.delete(id); clearTimeout(request.timer);
  if (choice === 'session') grants.add(request.chat);
  request.resolve(choice !== 'deny'); changed(); return true;
}
export function resetRemoteApprovals(): void {
  for (const request of pending.values()) { clearTimeout(request.timer); request.resolve(false); }
  pending.clear(); grants.clear(); changed();
}
export function revokeRemoteChat(chat: string): void {
  grants.delete(chat);
  for (const request of [...pending.values()]) {
    if (request.chat !== chat) continue;
    pending.delete(request.id); clearTimeout(request.timer); request.resolve(false);
  }
  changed();
}
