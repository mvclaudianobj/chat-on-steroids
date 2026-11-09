/** Strict allowlisted projection of headless CLI events: never forward tools or credentials. */
export type CliChatBackend = 'markscode' | 'codex' | 'claude';
export type ParsedCliEvent = { sessionId?: string; text?: string; failure?: string };
const bounded = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 256_000 ? value : undefined;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function cliEvent(backend: CliChatBackend, raw: string): ParsedCliEvent {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return {}; }
  const event = record(data);
  if (!event) return {};
  const kind = event.type;
  if (backend === 'codex') {
    if (kind === 'thread.started') {
      const id = bounded(event.thread_id);
      return id && /^[\w-]{12,80}$/.test(id) ? { sessionId: id } : {};
    }
    if (kind === 'item.completed') {
      const item = record(event.item);
      return item?.type === 'agent_message' ? { text: bounded(item.text) } : {};
    }
    return kind === 'turn.failed' || kind === 'error' ? { failure: 'Codex reported a failed turn.' } : {};
  }
  if (backend === 'markscode') {
    const sessionId = bounded(event.sessionID);
    const session = sessionId && /^[\w-]{8,128}$/.test(sessionId) ? sessionId : undefined;
    if (kind === 'text') {
      const part = record(event.part);
      return { sessionId: session, text: part?.type === 'text' ? bounded(part.text) : undefined };
    }
    return { sessionId: session, ...(kind === 'error' ? { failure: 'MarksCode reported a failed turn.' } : {}) };
  }
  if (kind === 'system' && event.subtype === 'init') {
    const id = bounded(event.session_id);
    return id && /^[\w-]{12,80}$/.test(id) ? { sessionId: id } : {};
  }
  if (kind === 'result') {
    const id = bounded(event.session_id);
    const sessionId = id && /^[\w-]{12,80}$/.test(id) ? id : undefined;
    return {
      sessionId,
      text: event.is_error === true ? undefined : bounded(event.result),
      ...(event.is_error === true ? { failure: 'Claude reported a failed turn.' } : {})
    };
  }
  // Stream-json assistant messages can include multiple content blocks; never
  // forward tool_use, tool_result, reasoning, metadata or hidden state.
  if (kind === 'assistant') {
    const message = record(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content.map(record).filter(item => item?.type === 'text').map(item => bounded(item?.text) ?? '').join('\n').slice(0, 256_000);
    return text ? { text } : {};
  }
  return {};
}

export function headlessArgs(backend: CliChatBackend, threadId: string | null): string[] {
  if (backend === 'codex') {
    // Stdin contains the prompt. Never add bypass-approvals flags.
    return threadId ? ['exec', 'resume', '--json', threadId, '-'] : ['exec', '--json', '--skip-git-repo-check', '-'];
  }
  if (backend === 'markscode') return ['run', '--format', 'json', '--standalone', ...(threadId ? ['--session', threadId] : [])];
  return ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'default', ...(threadId ? ['--resume', threadId] : [])];
}
