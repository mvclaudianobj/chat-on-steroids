/** Chat Marks: model-authored memories require explicit, chat-scoped consent. */
import { randomUUID } from 'node:crypto';

type Pending = { id: string; chat: string; content: string; resolve: (accepted: boolean) => void; timeout: NodeJS.Timeout };
const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();
const changed = (): void => { for (const listener of listeners) listener(); };
/** The main window owns presentation; a proposal becomes visible the moment it is filed. */
export function onBrainApprovalsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function brainPendingApprovals(): Array<{ id: string; chat: string; content: string }> {
  return [...pending.values()].map(({ id, chat, content }) => ({ id, chat, content }));
}

export function requestBrainSaveApproval(chat: string, content: string): Promise<boolean> {
  if (!chat || !content) return Promise.resolve(false);
  return new Promise(resolve => {
    const id = randomUUID();
    const timeout = setTimeout(() => { pending.delete(id); resolve(false); changed(); }, 120_000);
    timeout.unref?.();
    pending.set(id, { id, chat, content: content.slice(0, 4000), resolve, timeout });
    changed();
  });
}

export function decideBrainSaveApproval(id: string, accepted: boolean): boolean {
  const item = pending.get(id);
  if (!item) return false;
  pending.delete(id);
  clearTimeout(item.timeout);
  item.resolve(accepted);
  changed();
  return true;
}

export function revokeBrainApprovals(chat?: string): void {
  for (const item of [...pending.values()]) {
    if (chat && item.chat !== chat) continue;
    pending.delete(item.id);
    clearTimeout(item.timeout);
    item.resolve(false);
  }
  changed();
}
