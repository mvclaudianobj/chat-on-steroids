/**
 * Streaming OpenAI-compatible chat completions for Chat Marks API chats, with tool calls.
 *
 * Modeled on the Goal driver's reader in goal.ts (bounded SSE records, `[DONE]` ends the
 * completion, an error inside a 200 stream fails it) but separate: the Goal reader caps replies
 * for a decision and has no tool calls.
 */

export type ApiChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ApiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ApiToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ApiCompletionRequest {
  model: string;
  messages: ApiChatMessage[];
  tools?: ApiToolDefinition[];
  reasoningEffort?: string | null;
}

export interface ApiCompletion {
  text: string;
  toolCalls: ApiToolCall[];
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
}

const MAX_SSE_RECORD_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 400_000;
const MAX_TOOL_CALLS = 32;
const MAX_TOOL_ARGUMENT_CHARS = 512_000;
const MAX_ERROR_BODY_BYTES = 16_384;

/**
 * Base URL checked at use time, like resolveGoalBaseUrl: https, or http on loopback only, and
 * never with credentials, a query or a fragment.
 */
export function resolveApiChatBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/\/+$/, ''));
  } catch {
    throw new Error('The API chat address is not a valid URL');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('The API chat address must be https, or http on this computer');
  }
  return url.toString().replace(/\/+$/, '');
}

export class ApiChatHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
  }
}

function oneLine(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '';
}

function errorDetail(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const error = (parsed as { error?: unknown }).error;
  if (typeof error === 'string') return oneLine(error);
  if (error && typeof error === 'object') return oneLine((error as { message?: unknown }).message);
  return '';
}

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= MAX_ERROR_BODY_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return errorDetail(JSON.parse(text)) || oneLine(text);
  } catch {
    return oneLine(text);
  }
}

/** Accumulates one streamed completion: text deltas and tool-call fragments by index. */
export class CompletionAccumulator {
  text = '';
  finishReason: string | null = null;
  usage: ApiCompletion['usage'] = null;
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();

  constructor(private readonly onText?: (text: string) => void) {}

  /** Applies one parsed `data:` record. */
  apply(record: unknown): void {
    if (!record || typeof record !== 'object') return;
    const detail = errorDetail(record);
    if ('error' in record && (record as { error?: unknown }).error) throw new Error(`The API reported an error${detail ? `: ${detail}` : ''}`);
    const usage = (record as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
    if (usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      this.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
    }
    const choices = (record as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || !choices.length) return;
    const choice = choices[0] as { delta?: Record<string, unknown>; finish_reason?: unknown };
    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      if (this.text.length + delta.content.length > MAX_TEXT_CHARS) throw new Error('The answer is longer than this app accepts');
      this.text += delta.content;
      this.onText?.(this.text);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
        const index = typeof raw.index === 'number' ? raw.index : this.calls.size;
        let call = this.calls.get(index);
        if (!call) {
          if (this.calls.size >= MAX_TOOL_CALLS) throw new Error('The model asked for more tool calls than this app accepts in one step');
          call = { id: '', name: '', arguments: '' };
          this.calls.set(index, call);
        }
        if (typeof raw.id === 'string' && raw.id) call.id = raw.id;
        const fn = raw.function as { name?: unknown; arguments?: unknown } | undefined;
        if (typeof fn?.name === 'string' && fn.name) call.name = call.name || fn.name;
        if (typeof fn?.arguments === 'string') {
          if (call.arguments.length + fn.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw new Error('A tool call is larger than this app accepts');
          call.arguments += fn.arguments;
        }
      }
    }
  }

  result(): ApiCompletion {
    const toolCalls: ApiToolCall[] = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({ id: call.id || `call_${index}`, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }));
    return { text: this.text, toolCalls, finishReason: this.finishReason, usage: this.usage };
  }
}

/** One streamed completion. Throws on HTTP errors, malformed records and in-stream errors. */
export async function streamCompletion(options: {
  baseUrl: string;
  key: string | null;
  request: ApiCompletionRequest;
  signal: AbortSignal;
  onText?: (text: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<ApiCompletion> {
  const { request } = options;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (request.tools?.length) {
    body.tools = request.tools;
    body.tool_choice = 'auto';
  }
  if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;
  const response = await (options.fetchImpl ?? fetch)(`${resolveApiChatBaseUrl(options.baseUrl)}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(options.key ? { authorization: `Bearer ${options.key}` } : {})
    },
    body: JSON.stringify(body),
    signal: options.signal
  });
  if (!response.ok) throw new ApiChatHttpError(response.status, await readErrorBody(response));
  if (!response.body) throw new Error('The API returned no answer');
  const accumulator = new CompletionAccumulator(options.onText);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  /** True once the stream declared the completion finished. */
  const consume = (rawLine: string): boolean => {
    if (rawLine.length > MAX_SSE_RECORD_CHARS) throw new Error('The API sent a record larger than this app accepts');
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new Error('The API sent a record this app could not read');
    }
    accumulator.apply(parsed);
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let cut = buffered.indexOf('\n');
      while (cut >= 0) {
        const line = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 1);
        if (consume(line)) {
          await reader.cancel().catch(() => undefined);
          return accumulator.result();
        }
        cut = buffered.indexOf('\n');
      }
      if (buffered.length > MAX_SSE_RECORD_CHARS) throw new Error('The API sent a record larger than this app accepts');
    }
    buffered += decoder.decode();
    if (buffered) consume(buffered);
    return accumulator.result();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}
