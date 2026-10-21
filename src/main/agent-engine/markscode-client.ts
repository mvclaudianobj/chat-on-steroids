/**
 * The MarksCode (opencode v2 fork) HTTP API of its shared background service, as the MarksCode
 * engine uses it. Shapes follow MarksCode 2.0.25 `packages/protocol/src/groups/*` and
 * `packages/schema/src/*`; the endpoint and password come from the service's own registration
 * file (`client/src/effect/service.ts` `Info`, `<XDG_STATE_HOME>/markscode/service.json`).
 *
 * Auth is HTTP Basic `opencode:<password>` (`client/src/service-probe.ts` `headers`). The header
 * is built per request and never appears in an error, a log line or a returned value.
 *
 * `/api/event` is SSE (`server/src/event-feed.ts`: `data: <json>\n\n`, `: heartbeat` every 15 s)
 * and volatile by contract: whatever happens while disconnected is missed, so the engine
 * reconciles from messages and pending permissions after every reconnect.
 */

/** Where the service listens and its private password (never sent anywhere but that URL). */
export interface MarksCodeEndpoint {
  url: string;
  password: string | null;
  /** The registered server pid; `/api/info` must answer the same one. */
  pid?: number;
}

/** `Permission.Rule`: the last matching rule wins (`core/src/permission.ts` `evaluate`). */
export interface MarksCodeRule { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }

/** `Model.Ref`. */
export interface MarksCodeModelRef { id: string; providerID: string; variant?: string }

/** `Model.Info`, the fields the engine reads. */
export interface MarksCodeModel {
  id: string;
  providerID: string;
  name?: string;
  enabled?: boolean;
  variants?: Array<{ id: string }>;
}

/** `Permission.Request`. */
export interface MarksCodePermission {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: 'tool'; messageID: string; id: string };
  message?: string;
}

/** One `/api/event` record: `{ id, created, type, data, location?, durable? }`. */
export interface MarksCodeEvent {
  id?: string;
  type: string;
  data: Record<string, unknown>;
}

export class MarksCodeHttpError extends Error {
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
    if (bytes > max) { await reader.cancel().catch(() => undefined); throw new Error('The MarksCode answer is too large'); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A short reason from an error body (`{ message }`, `{ error: { message } }` or text), bounded. */
function reason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: { message?: unknown } };
    const message = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error?.message === 'string' ? parsed.error.message : '';
    if (message) return message.slice(0, 200);
  } catch { /* not JSON */ }
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export class MarksCodeClient {
  constructor(
    readonly endpoint: MarksCodeEndpoint,
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
      throw new Error(timeout.aborted ? 'The MarksCode service did not answer in time' : 'The MarksCode service is not reachable', { cause: error });
    }
    const text = await boundedText(response);
    if (!response.ok) {
      if (response.status === 401) throw new MarksCodeHttpError(401, 'The MarksCode service refused its saved password');
      throw new MarksCodeHttpError(response.status, `MarksCode ${method} ${path.split('?')[0]} answered ${response.status}${text ? `: ${reason(text)}` : ''}`);
    }
    if (!text.trim()) return undefined as T;
    try { return JSON.parse(text) as T; } catch { throw new Error(`MarksCode ${method} ${path} answered something that is not JSON`); }
  }

  /** `GET /api/info` (`service-probe.ts` health): `{ version, pid }`. */
  info(timeoutMs = 3_000): Promise<{ version?: string; pid?: number }> {
    return this.request('GET', '/api/info', { timeoutMs });
  }

  /** `GET /api/model`: `Location.response(Model.Info[])` = `{ location, data }`. */
  async models(directory?: string): Promise<MarksCodeModel[]> {
    const reply = await this.request<{ data?: unknown }>('GET', '/api/model', { query: { 'location[directory]': directory } });
    return Array.isArray(reply?.data) ? reply.data as MarksCodeModel[] : [];
  }

  /** `GET /api/model/default`: `{ location, data?: Model.Info }`. */
  async defaultModel(directory?: string): Promise<MarksCodeModel | null> {
    const reply = await this.request<{ data?: MarksCodeModel }>('GET', '/api/model/default', { query: { 'location[directory]': directory } });
    return reply?.data && typeof reply.data.id === 'string' ? reply.data : null;
  }

  /** `POST /api/session` (`session.create`): `{ data: Session.Info }`. */
  async createSession(payload: { title?: string; model?: MarksCodeModelRef; location: { directory: string }; permissions: MarksCodeRule[] }): Promise<{ id: string }> {
    const reply = await this.request<{ data?: { id?: unknown } }>('POST', '/api/session', { body: payload });
    if (typeof reply?.data?.id !== 'string' || !reply.data.id) throw new Error('MarksCode did not return a session id');
    return { id: reply.data.id };
  }

  /** `GET /api/session/:id` (`session.get`): `{ data: Session.Info }` (`outcome`, `time.idle`). */
  async session(sessionId: string): Promise<{ id: string; outcome?: 'succeeded' | 'failed' | 'interrupted'; time?: { idle?: number } }> {
    const reply = await this.request<{ data?: { id: string; outcome?: 'succeeded' | 'failed' | 'interrupted'; time?: { idle?: number } } }>('GET', `/api/session/${encodeURIComponent(sessionId)}`);
    if (!reply?.data) throw new Error('MarksCode did not return the session');
    return reply.data;
  }

  /** `GET /api/session/active` (`session.active`): `{ data: Record<sessionID, { type: 'running' }> }`. */
  async running(sessionId: string): Promise<boolean> {
    const reply = await this.request<{ data?: Record<string, { type?: string }> }>('GET', '/api/session/active');
    return reply?.data?.[sessionId]?.type === 'running';
  }

  /** `GET /api/session/:id/message?order=desc&limit=n` (`session.messages`): newest first, returned oldest first. */
  async messages(sessionId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const reply = await this.request<{ data?: unknown }>('GET', `/api/session/${encodeURIComponent(sessionId)}/message`, { query: { order: 'desc', limit: String(limit) } });
    return Array.isArray(reply?.data) ? (reply.data as Array<Record<string, unknown>>).slice().reverse() : [];
  }

  /** `GET /api/session/:id/permission` (`session.permission.list`): pending requests. */
  async permissions(sessionId: string): Promise<MarksCodePermission[]> {
    const reply = await this.request<{ data?: unknown }>('GET', `/api/session/${encodeURIComponent(sessionId)}/permission`);
    return Array.isArray(reply?.data) ? reply.data as MarksCodePermission[] : [];
  }

  /** `GET /api/session/:id/permission/:requestID`; null when it is no longer pending (404). */
  async permission(sessionId: string, requestId: string): Promise<MarksCodePermission | null> {
    try {
      const reply = await this.request<{ data?: MarksCodePermission }>('GET', `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}`);
      return reply?.data ?? null;
    } catch (error) {
      if (error instanceof MarksCodeHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /** `POST /api/session/:id/permission/:requestID/reply` `{ decision: once|always|reject, message? }`. */
  async reply(sessionId: string, requestId: string, decision: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { body: { decision, ...(message ? { message } : {}) } });
  }

  /** `POST /api/session/:id/prompt` `{ text }` (`session.prompt`): `{ data: Session.Inbox.User }` whose `id` is the user message. */
  async prompt(sessionId: string, text: string): Promise<{ id: string | null }> {
    const reply = await this.request<{ data?: { id?: unknown } }>('POST', `/api/session/${encodeURIComponent(sessionId)}/prompt`, { body: { text } });
    return { id: typeof reply?.data?.id === 'string' ? reply.data.id : null };
  }

  /** `POST /api/session/:id/interrupt` (`session.interrupt`): `{ interrupted }`. */
  async interrupt(sessionId: string): Promise<boolean> {
    const reply = await this.request<{ interrupted?: boolean }>('POST', `/api/session/${encodeURIComponent(sessionId)}/interrupt`);
    return reply?.interrupted === true;
  }

  /** `POST /api/session/:id/model` `{ model: Model.Ref }` (`session.switchModel`). */
  async switchModel(sessionId: string, model: MarksCodeModelRef): Promise<void> {
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/model`, { body: { model } });
  }

  /** `PATCH /api/session/:id` `{ permissions }` (`session.update`). */
  async setPermissions(sessionId: string, permissions: MarksCodeRule[]): Promise<void> {
    await this.request('PATCH', `/api/session/${encodeURIComponent(sessionId)}`, { body: { permissions } });
  }

  /**
   * One `/api/event` connection: resolves when the server ends it, rejects when it fails or is
   * aborted. Every record is handed over in order; `onEvent` may be async and is awaited.
   */
  async events(signal: AbortSignal, onEvent: (event: MarksCodeEvent) => void | Promise<void>, onOversized: () => void = () => undefined): Promise<void> {
    let response: Response;
    // The timeout covers connecting only: the stream itself lives as long as `signal` allows.
    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(), this.timeoutMs);
    try {
      response = await this.fetchImpl(this.url('/api/event'), {
        method: 'GET', headers: { ...this.headers(false), accept: 'text/event-stream' }, signal: AbortSignal.any([signal, connect.signal])
      });
    } catch (error) {
      throw new Error(signal.aborted ? 'Stopped' : 'The MarksCode event stream is not reachable', { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new MarksCodeHttpError(response.status, response.status === 401 ? 'The MarksCode service refused its saved password' : `MarksCode event stream answered ${response.status}`);
    }
    const parser = new SseParser(onOversized);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const abort = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    // The server sends a heartbeat every 15 s: a stream silent for longer is dead, not idle.
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
        if (stalled) throw new Error('The MarksCode event stream went silent');
        if (done) break;
        for (const record of parser.push(decoder.decode(value, { stream: true }))) {
          let parsed: unknown;
          try { parsed = JSON.parse(record); } catch { continue; }
          if (!parsed || typeof parsed !== 'object' || typeof (parsed as MarksCodeEvent).type !== 'string') continue;
          const event = parsed as MarksCodeEvent;
          await onEvent({ ...event, data: event.data && typeof event.data === 'object' ? event.data : {} });
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
