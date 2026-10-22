import type { SessionSummary } from '../shared/session.js';
import { queueOutboundNotice } from './notification-center.js';
import { notificationSettings } from './notification-center.js';

/** The session ledger is the authority; old/restored endings never generate outbound mail. */
export function createOutboundTurnWatcher(
  getSession: (id: string) => Promise<SessionSummary | null>,
  send = queueOutboundNotice,
  options: { projectName?: (id: string) => Promise<string>; excerpt?: (id: string) => Promise<string | null> } = {}
) {
  const seen = new Map<string, number>();
  return {
    seed(sessions: readonly SessionSummary[]): void {
      for (const session of sessions) seen.set(session.id, session.lastTurnEndAt ?? 0);
    },
    async changed(ids: readonly string[]): Promise<void> {
      for (const id of ids) {
        const session = await getSession(id).catch(() => null);
        if (!session) continue;
        const ending = session.lastTurnEndAt ?? 0;
        const prior = seen.get(id) ?? 0;
        seen.set(id, Math.max(ending, prior));
        if (!ending || ending <= prior || session.activeTurnId || session.origin?.kind === 'helper') continue;
        const event = session.lastTurnOutcome === 'completed' ? 'turn-completed'
          : ['failed', 'stopped', 'stalled', 'interrupted'].includes(session.lastTurnOutcome ?? '') ? 'turn-failed' : null;
        if (!event) continue;
        const prefs = await notificationSettings();
        const includeExcerpt = Object.values(prefs.channels).some(channel => channel.enabled && channel.events[event] && channel.includeExcerpt);
        await send({ event, title: session.title || 'Chat Marks',
          project: session.projectId ? (await options.projectName?.(session.projectId).catch(() => 'Chat Marks')) ?? 'Chat Marks' : 'Chat Marks',
          ...(includeExcerpt && event === 'turn-completed' ? { excerpt: (await options.excerpt?.(id).catch(() => null))?.slice(0, 160) ?? '' } : {})
        });
      }
    }
  };
}
