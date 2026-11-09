/**
 * Chat Marks H1b: the ai-memory remote MCP server (MarksCode used https://memory.marks.ia.br/mcp).
 * A minimal streamable-HTTP JSON-RPC client: initialize, tools/list, then the discovered
 * search tool (memory_query) for recall and the write tool (memory_write_page) for remote sync.
 */
import type { BrainMemory, BrainProviders } from '../../../shared/brain.js';
import { boundedRequest, checkTransport, parseJson, ProviderError, vaultCredential, type RemoteHit } from './http.js';

type Config = BrainProviders['aiMemory'];
type Tool = { name: string; inputSchema?: { properties?: Record<string, unknown> } };
const SEARCH = ['memory_query', 'memory_search', 'search', 'recall'];
const SAVE = ['memory_write_page', 'memory_save', 'save', 'remember'];

class McpSession {
  private session: string | null = null;
  private id = 0;
  constructor(private readonly url: URL, private readonly token: string, private readonly timeoutMs: number) {}
  async call(method: string, params: unknown, notification = false): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.token}`, 'mcp-protocol-version': '2025-06-18' };
    if (this.session) headers['mcp-session-id'] = this.session;
    const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params };
    const reply = await boundedRequest(this.url, { method: 'POST', headers, body: JSON.stringify(body) }, this.timeoutMs);
    this.session = reply.headers.get('mcp-session-id') ?? this.session;
    if (notification) return null;
    if (reply.status >= 400) throw new ProviderError('error', `HTTP ${reply.status}`);
    const message = parseMessage(reply.text, reply.headers.get('content-type') ?? '');
    if (message?.error) throw new ProviderError('error', `MCP error ${Number(message.error.code) || ''}`.trim());
    return message?.result;
  }
}
function parseMessage(text: string, type: string): any {
  if (!type.includes('text/event-stream')) return parseJson(text);
  // Use the last JSON-RPC response in the event stream.
  const events = text.split(/\r?\n\r?\n/).map(chunk => chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean);
  for (const data of events.reverse()) {
    try { const parsed = JSON.parse(data); if (parsed && ('result' in parsed || 'error' in parsed)) return parsed; } catch { /* next event */ }
  }
  throw new ProviderError('error', 'MCP response had no result');
}
async function connect(config: Config): Promise<{ session: McpSession; tools: Tool[] }> {
  const url = checkTransport(config.url);
  const token = await vaultCredential(config.secret, url.origin);
  if (!token) throw new ProviderError('needs-key', `Add vault entry ${config.secret} for ${url.origin}`);
  const session = new McpSession(url, token.replace(/^Bearer\s+/i, ''), config.timeoutMs);
  await session.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Chat Marks Brain', version: '1' } });
  await session.call('notifications/initialized', {}, true);
  const listed = await session.call('tools/list', {});
  const tools = Array.isArray(listed?.tools) ? listed.tools.filter((tool: Tool) => typeof tool?.name === 'string') : [];
  return { session, tools };
}
const pick = (tools: Tool[], names: string[]) => names.map(name => tools.find(tool => tool.name === name)).find(Boolean);
function textOf(result: any): string {
  if (result?.isError) throw new ProviderError('error', 'ai-memory tool reported an error');
  return (Array.isArray(result?.content) ? result.content : []).filter((part: any) => part?.type === 'text').map((part: any) => String(part.text ?? '')).join('\n');
}
function projectArgs(tool: Tool, config: Config): Record<string, string> {
  return config.project && tool.inputSchema?.properties && 'project' in tool.inputSchema.properties ? { project: config.project } : {};
}

export async function aiMemoryStatus(config: Config): Promise<{ tools: string[]; search?: string; save?: string }> {
  const { tools } = await connect(config);
  return { tools: tools.map(tool => tool.name), search: pick(tools, SEARCH)?.name, save: pick(tools, SAVE)?.name };
}

export async function aiMemoryRecall(config: Config, query: string, limit: number): Promise<RemoteHit[]> {
  const { session, tools } = await connect(config);
  const tool = pick(tools, SEARCH);
  if (!tool) throw new ProviderError('error', 'Server exposes no search tool');
  const text = textOf(await session.call('tools/call', { name: tool.name, arguments: { query, limit, ...projectArgs(tool, config) } }));
  let body: any;
  try { body = JSON.parse(text); } catch { return text.trim() ? [{ content: text.trim().slice(0, 4000) }] : []; }
  const hits: any[] = Array.isArray(body?.hits) ? body.hits : Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];
  return hits.slice(0, limit).flatMap(hit => {
    const content = String(hit?.snippet ?? hit?.content ?? hit?.body ?? hit?.text ?? hit?.title ?? '').trim();
    if (!content) return [];
    const id = hit?.id ?? hit?.path;
    return [{ remoteId: id ? String(id).slice(0, 200) : undefined, content: content.slice(0, 4000),
      title: hit?.title ? String(hit.title).slice(0, 200) : hit?.path ? String(hit.path).slice(0, 200) : undefined,
      score: typeof hit?.score === 'number' ? hit.score : typeof hit?.rank === 'number' ? hit.rank : undefined }];
  });
}

/** Remote sync writes one durable wiki page per memory, keyed by its content hash. */
export async function aiMemorySave(config: Config, memory: BrainMemory): Promise<string> {
  const { session, tools } = await connect(config);
  const tool = pick(tools, SAVE);
  if (!tool) throw new ProviderError('error', 'Server exposes no write tool');
  const path = `notes/chat-marks-${memory.contentHash.slice(0, 16)}.md`;
  const heading = (memory.title || memory.content.split('\n')[0] || 'Chat Marks memory').slice(0, 120).replace(/^#+\s*/, '');
  const args = tool.name === 'memory_write_page'
    ? { path, body: `# ${heading}\n\n${memory.content}\n`, ...projectArgs(tool, config) }
    : { content: memory.content, title: memory.title, tags: memory.tags };
  textOf(await session.call('tools/call', { name: tool.name, arguments: args }));
  return path;
}
