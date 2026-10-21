/**
 * A bounded JSON-RPC peer over a WebSocket, one JSON message per text frame, as the Codex
 * app-server speaks it on its unix socket (codex-cli 0.163 upgrades the socket to WebSocket;
 * `codex app-server proxy` only relays the raw bytes, so the handshake and frames run over the
 * proxy's stdio, see `connectWebSocket`). Codex omits the `"jsonrpc": "2.0"` member, so this peer
 * neither sends nor requires it.
 *
 * - Framing: one message per frame; a frame larger than `maxMessageBytes` closes the connection
 *   (`ws` refuses it before buffering it). Binary and non-JSON frames are skipped.
 * - Requests time out (`requestTimeoutMs`, per call overridable) and every pending one is rejected
 *   when the peer closes (the socket closed or errored, or `close`). Responses to unknown ids are
 *   ignored.
 * - The other side's requests reach `onRequest` with their exact id; the owner answers each one
 *   with `respond`/`respondError` (an unanswered request is the owner's decision, e.g. an approval
 *   left to the Codex TUI).
 */
import { Duplex, type Readable, type Writable } from 'node:stream';
import { WebSocket } from 'ws';

export type JsonRpcId = string | number;

export interface JsonRpcPeerOptions {
  socket: WebSocket;
  onNotification?(method: string, params: unknown): void;
  onRequest?(id: JsonRpcId, method: string, params: unknown): void;
  onClose?(reason: Error): void;
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

/** Codex's own frame limit (`x-codex-websocket-max-unfragmented-message-bytes`). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTGOING_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const TOO_LARGE = 'The server sent a message that is too large';

/**
 * A WebSocket client over a pair of byte streams (a child's stdout/stdin), open once the server
 * answered the upgrade. The host name is never resolved: `createConnection` hands `ws` the streams.
 */
export function connectWebSocket(input: Readable, output: Writable, options: { maxMessageBytes?: number; timeoutMs?: number } = {}): Promise<WebSocket> {
  const stream = Duplex.from({ readable: input, writable: output }) as Duplex & { setTimeout(): void; setNoDelay(): void; setKeepAlive(): void };
  // `ws` and the HTTP client tune the socket they get; a pipe has nothing to tune.
  stream.setTimeout = stream.setNoDelay = stream.setKeepAlive = () => undefined;
  const socket = new WebSocket('ws://localhost/', { createConnection: () => stream as never, maxPayload: options.maxMessageBytes ?? MAX_MESSAGE_BYTES, perMessageDeflate: false });
  return new Promise((resolve, reject) => {
    // Our own deadline: `ws`'s handshake timeout needs a socket timer, which a pipe does not have.
    const timer = setTimeout(() => fail(new Error('The WebSocket handshake timed out')), options.timeoutMs ?? 20_000);
    timer.unref?.();
    function fail(error: Error): void { clearTimeout(timer); socket.terminate(); reject(error); }
    socket.once('open', () => { clearTimeout(timer); resolve(socket); });
    // Kept after open until the peer listens: an error then still ends the socket, never the app.
    socket.on('error', fail);
    socket.once('close', () => fail(new Error('The connection closed')));
  });
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private closedWith: Error | null = null;
  private readonly maxOutgoingBytes: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: JsonRpcPeerOptions) {
    this.maxOutgoingBytes = options.maxOutgoingBytes ?? DEFAULT_MAX_OUTGOING_BYTES;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { socket } = options;
    socket.on('message', (data, isBinary) => { if (!isBinary) this.dispatch((data as Buffer).toString('utf8')); });
    socket.on('close', () => this.close(new Error('The connection closed')));
    socket.on('error', (error: Error & { code?: string }) => this.close(error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? new Error(TOO_LARGE) : error));
    if (socket.readyState !== WebSocket.OPEN) this.close(new Error('The connection closed'));
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
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(reason);
    }
    this.options.socket.terminate();
    this.options.onClose?.(reason);
  }

  private write(message: Record<string, unknown>): void {
    if (this.closedWith) throw this.closedWith;
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > this.maxOutgoingBytes) throw new Error('The message is too large to send');
    this.options.socket.send(text);
  }

  private dispatch(frame: string): void {
    const text = frame.trim();
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
