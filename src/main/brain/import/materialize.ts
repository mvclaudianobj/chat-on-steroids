/**
 * Chat Marks Brain H2: "Open as read-only chat". One confirmed conversation becomes a `cosapi-`
 * session whose ledger engine is the retired `markscode` (view-only, `retiredEngine`), with its
 * user and assistant messages; tool calls are summarized inside the answer. If a MarksCode chat
 * with the same backend session id already exists, that chat is reused instead.
 */
import { randomUUID } from 'node:crypto';
import { API_CONVERSATION_PREFIX } from '../../../shared/api-chat.js';
import type { HistoryConversation } from '../../../shared/brain-import.js';
import type { NewSessionEvent, SessionSummary } from '../../../shared/session.js';

export interface MaterializeDeps {
  records(): Promise<Readonly<Record<string, { engine?: string; backendSessionId?: string }>>>;
  exists(sessionId: string): Promise<boolean>;
  createSession(options: { title: string; titleSource: SessionSummary['titleSource']; conversationId: string }): Promise<{ id: string }>;
  setRecord(sessionId: string, record: { engine: 'markscode'; backendSessionId: string; model: string | null; effort: null }): Promise<void>;
  upsertMessage(sessionId: string, event: NewSessionEvent): Promise<void>;
  append(sessionId: string, event: NewSessionEvent): Promise<void>;
  changed(sessionId: string): void;
}

async function defaultDeps(): Promise<MaterializeDeps> {
  const [{ chatRecords, updateChatRecord }, store, { notifyChanged }] = await Promise.all([
    import('../../agent-engine/ledger.js'), import('../../session/store.js'), import('../../session/recorder.js')
  ]);
  return {
    records: chatRecords,
    exists: async id => !!(await store.getSession(id)),
    createSession: options => store.createSession(options),
    setRecord: (id, record) => updateChatRecord(id, () => record),
    upsertMessage: async (id, event) => { await store.upsertMessageEvent(id, event as Parameters<typeof store.upsertMessageEvent>[1]); },
    append: async (id, event) => { await store.appendEvent(id, event); },
    changed: id => notifyChanged(id)
  };
}

export const backendIdFor = (conversation: HistoryConversation): string =>
  (conversation.family === 'opencode' ? conversation.sessionId : `${conversation.family}:${conversation.sessionId}`).slice(0, 200);

export async function materializeConversation(conversation: HistoryConversation, prefix = API_CONVERSATION_PREFIX, deps?: MaterializeDeps): Promise<{ sessionId: string; created: boolean }> {
  const use = deps ?? await defaultDeps();
  const backendSessionId = backendIdFor(conversation);
  for (const [sessionId, record] of Object.entries(await use.records())) {
    if (record.engine === 'markscode' && record.backendSessionId === backendSessionId && await use.exists(sessionId)) return { sessionId, created: false };
  }
  const summary = await use.createSession({ title: conversation.title.slice(0, 200) || 'MarksCode chat', titleSource: 'manual', conversationId: `${prefix}${randomUUID()}` });
  await use.setRecord(summary.id, { engine: 'markscode', backendSessionId, model: conversation.model ? conversation.model.slice(0, 200) : null, effort: null });
  let turn = 0, open = false, step = 0;
  const time = (value: number): number => Number.isFinite(value) && value > 0 ? value : conversation.created || Date.now();
  const end = async (at: number): Promise<void> => {
    if (!open) return;
    await use.append(summary.id, { time: at, source: 'app', kind: 'turn_end', turnId: `import-${turn}`, outcome: 'completed' } as NewSessionEvent);
    open = false;
  };
  for (const message of conversation.messages) {
    const at = time(message.time);
    if (message.role === 'user') {
      await end(at);
      turn++; step = 0; open = true;
      await use.upsertMessage(summary.id, { time: at, source: 'app', kind: 'user_message', messageId: `api-user:import-${turn}`,
        message: { text: message.text, truncated: false, chars: message.text.length } } as NewSessionEvent);
      await use.append(summary.id, { time: at, source: 'app', kind: 'turn_start', turnId: `import-${turn}` } as NewSessionEvent);
      continue;
    }
    if (!open) { turn++; step = 0; open = true; await use.append(summary.id, { time: at, source: 'app', kind: 'turn_start', turnId: `import-${turn}` } as NewSessionEvent); }
    const tools = message.tools.map(tool => `- ${tool.name}${tool.summary ? `: ${tool.summary.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
    const text = [message.role === 'summary' ? `Summary:\n${message.text}` : message.text, tools.length ? `Tools used:\n${tools.join('\n')}` : ''].filter(part => part.trim()).join('\n\n');
    if (!text) continue;
    await use.upsertMessage(summary.id, { time: at, source: 'app', kind: 'assistant_message', turnId: `import-${turn}`,
      messageId: step ? `api-assistant:import-${turn}:${step}` : `api-assistant:import-${turn}`,
      message: { text, truncated: false, chars: text.length }, state: 'final', final: true } as NewSessionEvent);
    step++;
  }
  await end(time(conversation.updated));
  use.changed(summary.id);
  return { sessionId: summary.id, created: true };
}
