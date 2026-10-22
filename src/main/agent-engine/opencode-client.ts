/**
 * The HTTP API of an upstream OpenCode server (`opencode serve`, v1.19) as the `opencode` engine
 * uses it: the routes the OpenCode TUI itself uses (`/session…`, `/permission…`, `/global/event`),
 * so the chat and an attached TUI see one session. Shapes were read from upstream at v1.19.3
 * (`packages/opencode/src/server/…`, `schema/v1/*`) and checked against the real 1.19.3 binary.
 *
 * Auth is HTTP Basic `opencode:<password>`; the password is the one the app gave the server it
 * started (`OPENCODE_SERVER_PASSWORD`). The header is built per request and never appears in an
 * error, a log line or a returned value.
 *
 * Every request except the global ones carries `directory=<project folder>`: the server loads one
 * instance per folder and routes by it.
 *
 * `/global/event` is SSE: `data: {"directory"?, "project"?, "payload": {"id","type","properties"}}`,
 * first `server.connected`, then a `server.heartbeat` every 10 s. It is volatile: whatever happens
 * while disconnected is missed, so the engine reconciles after every reconnect.
 */

export interface OpenCodeEndpoint {
  url: string;
  password: string | null;
}

/** `PermissionV1.Rule`: the last matching rule wins (`findLast`), `*` also matches `/`. */
export interface OpenCodeRule { permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }

/** One model of `/config/providers`, the fields the engine reads. */
export interface OpenCodeModel {
  id: string;
  providerID: string;
  name?: string;
  status?: string;
  variants?: Record<string, unknown>;
}

export interface OpenCodeProviders {
  providers: Array<{ id: string; name?: string; models: Record<string, OpenCodeModel> }>;
  /** providerID → its default modelID. */
  default: Record<string, string>;
}

/** `PermissionV1.Request`. */
export interface OpenCodePermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID: string; callID: string };
}

/** One `/session/:id/message` entry. */
export interface OpenCodeMessage {
  info: Record<string, unknown> & { id: string; role: string };
  parts: Array<Record<string, unknown>>;
}

/** One `/global/event` record's payload. */
export interface OpenCodeEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
}

export class OpenCodeHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** One SSE line, and one record's data, are bounded: a longer record is dropped, not buffered. */
export const MAX_SSE_LINE_CHARS = 1024 * 1024;
export const MAX_SSE_RECORD_CHARS = 4 * 1024 * 1024;

export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

async function boundedText(response: Response, max = MAX_BODY_BYTES): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) { await reader.cancel().catch(() => undefined); throw new Error('The OpenCode answer is too large'); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A short reason from an error body (`{ message }`, `{ data: { message } }`, `{ error: { message } }` or text), bounded. */
function reason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; data?: { message?: unknown }; error?: { message?: unknown } };
    const message = [parsed.message, parsed.data?.message, parsed.error?.message].find(item => typeof item === 'string');
    if (typeof message === 'string' && message) return message.slice(0, 200);
  } catch { /* not JSON */ }
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}

const enc = encodeURIComponent;

export class OpenCodeClient {
  constructor(
    readonly endpoint: OpenCodeEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
    private readonly idleMs = 45_000
  ) {}

  private headers(json: boolean): Record<string, string> {
    return {
      accept: 'application/json',
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.endpoint.password ? { authorization: basicAuth(this.endpoint.password) } : {})
    };
  }

  url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path, this.endpoint.url.endsWith('/') ? this.endpoint.url : `${this.endpoint.url}/`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    return url.toString();
  }

  /** One JSON request; an error names the method, path and status, never the credentials. */
  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, options: { body?: unknown; query?: Record<string, string | undefined>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, options.query), {
        method, headers: this.headers(options.body !== undefined), signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
      });
    } catch (error) {
      if (options.signal?.aborted) throw new Error('Stopped');
      throw new Error(timeout.aborted ? 'The OpenCode server did not answer in time' : 'The OpenCode server is not reachable', { cause: error });
    }
    const text = await boundedText(response);
    const route = path.replace(/ses_[A-Za-z0-9]+/g, ':id').replace(/per_[A-Za-z0-9]+/g, ':request');
    if (!response.ok) {
      if (response.status === 401) throw new OpenCodeHttpError(401, 'The OpenCode server refused the password Chat Marks gave it');
      throw new OpenCodeHttpError(response.status, `OpenCode ${method} ${route} answered ${response.status}${text ? `: ${reason(text)}` : ''}`);
    }
    if (!text.trim()) return undefined as T;
    try { return JSON.parse(text) as T; } catch { throw new Error(`OpenCode ${method} ${route} answered something that is not JSON`); }
  }

  /** `GET /global/health`: `{ healthy, version }`. */
  health(timeoutMs = 3_000): Promise<{ healthy?: boolean; version?: string }> {
    return this.request('GET', '/global/health', { timeoutMs });
  }

  /** `GET /config/providers`: the configured providers with their models, and each provider's default model. */
  async providers(directory: string): Promise<OpenCodeProviders> {
    const reply = await this.request<Partial<OpenCodeProviders>>('GET', '/config/providers', { query: { directory } });
    return {
      providers: Array.isArray(reply?.providers) ? reply.providers.filter(item => item && typeof item.id === 'string' && item.models && typeof item.models === 'object') : [],
      default: reply?.default && typeof reply.default === 'object' ? reply.default : {}
    };
  }

  /** `POST /session` (`Session.CreateInput`): the reply is `Session.Info` itself. */
  async createSession(directory: string, payload: { title?: string; permission: OpenCodeRule[] }): Promise<{ id: string }> {
    const reply = await this.request<{ id?: unknown }>('POST', '/session', { query: { directory }, body: payload });
    if (typeof reply?.id !== 'string' || !reply.id) throw new Error('OpenCode did not return a session id');
    return { id: reply.id };
  }

  /** `GET /session/status`: `{ [sessionID]: { type: idle|busy|retry } }` of that folder's instance; absent = idle. */
  async busy(directory: string, sessionId: string): Promise<boolean> {
    const reply = await this.request<Record<string, { type?: string }>>('GET', '/session/status', { query: { directory } });
    const type = reply?.[sessionId]?.type;
    return type === 'busy' || type === 'retry';
  }

  /** `GET /session/:id/message?limit=n`: the newest n messages, oldest first, each `{ info, parts }`. */
  async messages(directory: string, sessionId: string, limit = 50): Promise<OpenCodeMessage[]> {
    const reply = await this.request<unknown>('GET', `/session/${enc(sessionId)}/message`, { query: { directory, limit: String(limit) } });
    return Array.isArray(reply) ? (reply as OpenCodeMessage[]).filter(item => item?.info && typeof item.info.id === 'string' && Array.isArray(item.parts)) : [];
  }

  /** `GET /permission`: every pending request of that folder's instance. */
  async permissions(directory: string, sessionId: string): Promise<OpenCodePermission[]> {
    const reply = await this.request<unknown>('GET', '/permission', { query: { directory } });
    return Array.isArray(reply) ? (reply as OpenCodePermission[]).filter(item => item?.sessionID === sessionId) : [];
  }

  /** `POST /permission/:requestID/reply` `{ reply: once|always|reject, message? }`. */
  async reply(directory: string, requestId: string, reply: 'once' | 'reject', message?: string): Promise<void> {
    await this.request('POST', `/permission/${enc(requestId)}/reply`, { query: { directory }, body: { reply, ...(message ? { message } : {}) } });
  }

  /** `POST /session/:id/prompt_async` (`SessionPrompt.PromptInput`): 204; failures are published as `session.error`. */
  async prompt(directory: string, sessionId: string, input: { text: string; model?: { providerID: string; modelID: string }; variant?: string }): Promise<void> {
    await this.request('POST', `/session/${enc(sessionId)}/prompt_async`, { query: { directory }, body: {
      parts: [{ type: 'text', text: input.text }], ...(input.model ? { model: input.model } : {}), ...(input.variant ? { variant: input.variant } : {})
    } });
  }

  /** `POST /session/:id/abort`: a boolean. */
  async abort(directory: string, sessionId: string): Promise<boolean> {
    return (await this.request<unknown>('POST', `/session/${enc(sessionId)}/abort`, { query: { directory } })) === true;
  }

  /** `PATCH /session/:id` `{ permission }`: APPENDS the rules to the session's ruleset (`Permission.merge`). */
  async appendPermissions(directory: string, sessionId: string, permission: OpenCodeRule[]): Promise<void> {
    await this.request('PATCH', `/session/${enc(sessionId)}`, { query: { directory }, body: { permission } });
  }

  /**
   * One `/global/event` connection: resolves when the server ends it, rejects when it fails or is
   * aborted. Every payload is handed over in order; `onEvent` may be async and is awaited.
   */
  async events(signal: AbortSignal, onEvent: (event: OpenCodeEvent) => void | Promise<void>, onOversized: () => void = () => undefined): Promise<void> {
    let response: Response;
    // The timeout covers connecting only: the stream itself lives as long as `signal` allows.
    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(), this.timeoutMs);
    try {
      response = await this.fetchImpl(this.url('/global/event'), {
        method: 'GET', headers: { ...this.headers(false), accept: 'text/event-stream' }, signal: AbortSignal.any([signal, connect.signal])
      });
    } catch (error) {
      throw new Error(signal.aborted ? 'Stopped' : 'The OpenCode event stream is not reachable', { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenCodeHttpError(response.status, response.status === 401 ? 'The OpenCode server refused the password Chat Marks gave it' : `OpenCode event stream answered ${response.status}`);
    }
    const parser = new SseParser(onOversized);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const abort = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    // The server sends a heartbeat every 10 s: a stream silent for longer is dead, not idle.
    let idle: NodeJS.Timeout | null = null;
    let stalled = false;
    const watch = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { stalled = true; abort(); }, this.idleMs);
    };
    try {
      for (;;) {
        watch();
        const { done, value } = await reader.read();
        if (signal.aborted) throw new Error('Stopped');
        if (stalled) throw new Error('The OpenCode event stream went silent');
        if (done) break;
        for (const record of parser.push(decoder.decode(value, { stream: true }))) {
          let parsed: unknown;
          try { parsed = JSON.parse(record); } catch { continue; }
          const envelope = parsed as { directory?: unknown; payload?: { id?: unknown; type?: unknown; properties?: unknown } };
          const payload = envelope?.payload;
          if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') continue;
          await onEvent({
            type: payload.type,
            ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
            ...(typeof envelope.directory === 'string' ? { directory: envelope.directory } : {}),
            properties: payload.properties && typeof payload.properties === 'object' ? payload.properties as Record<string, unknown> : {}
          });
        }
      }
    } finally {
      if (idle) clearTimeout(idle);
      signal.removeEventListener('abort', abort);
    }
  }
}

/**
 * Incremental SSE parsing (`data:` lines joined by newlines, a blank line ends the record,
 * comments and other fields ignored). A line or a record over its bound is dropped whole.
 */
export class SseParser {
  private line = '';
  private data: string[] = [];
  private dataChars = 0;
  private skippingLine = false;
  private skippingRecord = false;

  constructor(private readonly onOversized: () => void = () => undefined) {}

  push(chunk: string): string[] {
    const records: string[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index];
      if (char !== '\n' && char !== '\r') continue;
      this.append(chunk.slice(start, index));
      start = index + 1;
      if (char === '\r' && chunk[index + 1] === '\n') { index++; start = index + 1; }
      const record = this.endLine();
      if (record !== null) records.push(record);
    }
    this.append(chunk.slice(start));
    return records;
  }

  private append(text: string): void {
    if (!text || this.skippingLine) return;
    if (this.line.length + text.length > MAX_SSE_LINE_CHARS) {
      this.line = '';
      this.skippingLine = true;
      this.skippingRecord = true;
      this.onOversized();
      return;
    }
    this.line += text;
  }

  private endLine(): string | null {
    const line = this.line;
    this.line = '';
    if (this.skippingLine) { this.skippingLine = false; return null; }
    if (line === '') {
      const record = this.skippingRecord || !this.data.length ? null : this.data.join('\n');
      this.data = [];
      this.dataChars = 0;
      this.skippingRecord = false;
      return record;
    }
    if (this.skippingRecord || line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return null;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.dataChars += value.length + 1;
    if (this.dataChars > MAX_SSE_RECORD_CHARS) {
      this.data = [];
      this.dataChars = 0;
      this.skippingRecord = true;
      this.onOversized();
      return null;
    }
    this.data.push(value);
    return null;
  }
}
