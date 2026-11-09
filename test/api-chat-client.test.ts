import { describe, expect, it, vi } from 'vitest';
import { ApiChatHttpError, resolveApiChatBaseUrl, streamCompletion } from '../src/main/api-chat/client';
import { isApiConversationId, isChatModelId } from '../src/shared/api-chat';

const sse = (records: unknown[], { done = true, split = 7 } = {}): Response => {
  const text = records.map(record => `data: ${typeof record === 'string' ? record : JSON.stringify(record)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(text);
  // Deliver in small chunks so records and UTF-8 sequences are split across reads.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += split) controller.enqueue(bytes.slice(at, at + split));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const delta = (value: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });

describe('API chat client', () => {
  it('streams text and assembles tool calls split across records', async () => {
    const fetchImpl = vi.fn(async () => sse([
      delta({ role: 'assistant', content: 'Vou ler ' }),
      delta({ content: 'o arquivo ✓' }),
      delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"targets":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '[{"path":"a.ts"}]}' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'find', arguments: '{"pattern":"x"}' } }] }),
      delta({}, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }
    ]));
    const seen: string[] = [];
    const result = await streamCompletion({
      baseUrl: 'http://127.0.0.1:18081/v1/',
      key: 'secret-key',
      request: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'oi' }], tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }], reasoningEffort: 'high' },
      signal: new AbortController().signal,
      onText: text => seen.push(text),
      fetchImpl
    });
    expect(result.text).toBe('Vou ler o arquivo ✓');
    expect(seen.at(-1)).toBe('Vou ler o arquivo ✓');
    expect(result.toolCalls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"targets":[{"path":"a.ts"}]}' } },
      { id: 'call_b', type: 'function', function: { name: 'find', arguments: '{"pattern":"x"}' } }
    ]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 5 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:18081/v1/chat/completions');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'claude-sonnet-5', stream: true, tool_choice: 'auto', reasoning_effort: 'high' });
    expect(body.tools).toHaveLength(1);
  });

  it('sends no tools, tool choice, effort or authorization when there are none', async () => {
    const fetchImpl = vi.fn(async () => sse([delta({ content: 'OK' }, 'stop')]));
    await streamCompletion({ baseUrl: 'http://localhost:18081/v1', key: null, request: { model: 'm', messages: [] }, signal: new AbortController().signal, fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('fails on an error inside a 200 stream, a malformed record and an HTTP error with its message', async () => {
    const run = (response: Response) => streamCompletion({ baseUrl: 'http://127.0.0.1:1/v1', key: 'k', request: { model: 'm', messages: [] }, signal: new AbortController().signal, fetchImpl: async () => response });
    await expect(run(sse([delta({ content: 'meia ' }), { error: { message: 'upstream\nfailed' } }]))).rejects.toThrow('The API reported an error: upstream failed');
    await expect(run(sse(['{not json'], { done: false }))).rejects.toThrow('could not read');
    const http = run(new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }));
    await expect(http).rejects.toBeInstanceOf(ApiChatHttpError);
    await expect(run(new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }))).rejects.toThrow('HTTP 401: Invalid API key');
  });

  it('keeps a completion whose stream ends without [DONE] or a trailing newline', async () => {
    const body = new Response(`data: ${JSON.stringify(delta({ content: 'fim' }, 'stop'))}`, { status: 200 });
    const result = await streamCompletion({ baseUrl: 'http://127.0.0.1:1/v1', key: null, request: { model: 'm', messages: [] }, signal: new AbortController().signal, fetchImpl: async () => body });
    expect(result).toMatchObject({ text: 'fim', finishReason: 'stop', toolCalls: [] });
  });

  it('accepts https anywhere and http only on this computer, never credentials or queries', () => {
    expect(resolveApiChatBaseUrl('http://127.0.0.1:18081/v1/')).toBe('http://127.0.0.1:18081/v1');
    expect(resolveApiChatBaseUrl('https://proxy.example.com/v1')).toBe('https://proxy.example.com/v1');
    for (const bad of ['http://192.168.0.5:18081/v1', 'https://user:pw@example.com/v1', 'https://example.com/v1?key=1', 'ftp://127.0.0.1/v1', 'nonsense']) {
      expect(() => resolveApiChatBaseUrl(bad), bad).toThrow();
    }
  });

  it('names API conversations apart from ChatGPT ones and keeps image models out of chat', () => {
    expect(isApiConversationId('cosapi-0f8b3c1e-1111-4222-8333-444455556666')).toBe(true);
    expect(isApiConversationId('6ad6ccc7-ac28-83e9-a19c-e5c8a45c8bac')).toBe(false);
    expect(isApiConversationId(null)).toBe(false);
    for (const id of ['gpt-image-2', 'gpt-image-2.5-flare', 'dall-e-3', 'text-embedding-3-small', 'whisper-1', 'tts-1']) expect(isChatModelId(id), id).toBe(false);
    for (const id of ['gpt-6-sol', 'claude-opus-5-5', 'codex-auto-review', 'claude-3-5-haiku-20241022']) expect(isChatModelId(id), id).toBe(true);
  });
});
