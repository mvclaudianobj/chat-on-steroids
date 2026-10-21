/**
 * A bounded JSON-RPC peer over a pair of byte streams, one JSON message per line, as the Codex
 * app-server speaks it on stdio (`codex app-server proxy` carries the same lines to its socket).
 * Codex omits the `"jsonrpc": "2.0"` member, so this peer neither sends nor requires it.
 *
 * - Framing: `\n`-terminated lines; a line longer than `maxLineBytes` closes the peer (a server
 *   that never ends a line cannot grow memory without bound). Blank and non-JSON lines are skipped.
 * - Requests time out (`requestTimeoutMs`, per call overridable) and every pending one is rejected
 *   when the peer closes. Responses to unknown ids are ignored.
 * - The other side's requests reach `onRequest` with their exact id; the owner answers each one
 *   with `respond`/`respondError` (an unanswered request is the owner's decision, e.g. an approval
 *   left to the Codex TUI).
 */
import type { Readable, Writable } from 'node:stream';

export type JsonRpcId = string | number;

export interface JsonRpcPeerOptions {
  input: Readable;
  output: Writable;
  onNotification?(method: string, params: unknown): void;
  onRequest?(id: JsonRpcId, method: string, params: unknown): void;
  onClose?(reason: Error): void;
  maxLineBytes?: number;
  maxOutgoingBytes?: number;
  requestTimeoutMs?: number;
}

export class JsonRpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTGOING_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private chunks: Buffer[] = [];
  private buffered = 0;
  private closedWith: Error | null = null;
  private readonly maxLineBytes: number;
  private readonly maxOutgoingBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: JsonRpcPeerOptions) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxOutgoingBytes = options.maxOutgoingBytes ?? DEFAULT_MAX_OUTGOING_BYTES;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    options.input.on('data', (chunk: Buffer | string) => this.receive(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    options.input.on('end', () => this.close(new Error('The connection closed')));
    options.input.on('error', error => this.close(error instanceof Error ? error : new Error(String(error))));
    options.output.on('error', error => this.close(error instanceof Error ? error : new Error(String(error))));
  }

  get closed(): boolean { return this.closedWith !== null; }

  request<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, options.timeoutMs ?? this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer });
      try {
        this.write({ id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params !== undefined ? { params } : {}) });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  close(reason: Error = new Error('The connection closed')): void {
    if (this.closedWith) return;
    this.closedWith = reason;
    this.chunks = [];
    this.buffered = 0;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(reason);
    }
    this.options.onClose?.(reason);
  }

  private write(message: Record<string, unknown>): void {
    if (this.closedWith) throw this.closedWith;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > this.maxOutgoingBytes) throw new Error('The message is too large to send');
    this.options.output.write(line);
  }

  private receive(chunk: Buffer): void {
    if (this.closedWith) return;
    let start = 0;
    for (let index = chunk.indexOf(0x0a); index >= 0; index = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, index);
      if (this.buffered + piece.length > this.maxLineBytes) { this.close(new Error('The server sent a message that is too large')); return; }
      const line = this.chunks.length ? Buffer.concat([...this.chunks, piece]).toString('utf8') : piece.toString('utf8');
      this.chunks = [];
      this.buffered = 0;
      start = index + 1;
      this.dispatch(line);
      if (this.closedWith) return;
    }
    const rest = chunk.subarray(start);
    if (!rest.length) return;
    if (this.buffered + rest.length > this.maxLineBytes) { this.close(new Error('The server sent a message that is too large')); return; }
    this.chunks.push(Buffer.from(rest));
    this.buffered += rest.length;
  }

  private dispatch(line: string): void {
    const text = line.trim();
    if (!text) return;
    let message: unknown;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const value = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    const id = typeof value.id === 'string' || typeof value.id === 'number' ? value.id : undefined;
    if (typeof value.method === 'string') {
      if (id === undefined) this.options.onNotification?.(value.method, value.params);
      else this.options.onRequest?.(id, value.method, value.params);
      return;
    }
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (value.error !== undefined) {
      const error = value.error as { code?: unknown; message?: unknown; data?: unknown };
      const message = typeof error?.message === 'string' ? error.message.slice(0, 500) : `${pending.method} failed`;
      pending.reject(new JsonRpcError(message, typeof error?.code === 'number' ? error.code : -32000, error?.data));
    } else {
      pending.resolve(value.result);
    }
  }
}
