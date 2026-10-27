import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brainSettingsSchema, type BrainSettings } from '../src/shared/brain.js';

let settings: BrainSettings = brainSettingsSchema.parse({});
vi.mock('../src/main/brain/settings.js', () => ({ getBrainSettings: () => settings }));
vi.mock('../src/main/markspanel-auth.js', () => ({ markspanelBrainSession: async () => ({ access: 'panel-bearer-value', id: 'panel-user-1' }) }));

const { configureVaultForTests, createVault, putVault, listVault } = await import('../src/main/marks-vault.js');
const { configureBrainForTests, brainSave, brainGet } = await import('../src/main/brain/store.js');
const { combinedRecall, mergeRecall, providerStatuses, syncSavedMemory, formatRecall } = await import('../src/main/brain/recall.js');
const { findMarksCodeCredential } = await import('../src/main/brain/provider-keys.js');

const MASTER = 'correct horse battery staple';
const folders: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'brain-providers-')); folders.push(dir); return dir; };
type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: any };
const seen: Record<string, Seen[]> = { ai: [], ov: [], marks: [] };
const servers: Server[] = [];
const base: Record<string, string> = {};
async function readBody(request: IncomingMessage): Promise<any> {
  let text = ''; for await (const chunk of request) text += chunk;
  try { return text ? JSON.parse(text) : undefined; } catch { return text; }
}
async function serve(name: string, handler: (seen: Seen) => { status?: number; body?: unknown; headers?: Record<string, string | undefined>; raw?: string } | null): Promise<void> {
  const server = createServer(async (request, response) => {
    const entry: Seen = { method: request.method!, url: request.url!, headers: request.headers, body: await readBody(request) };
    seen[name]!.push(entry);
    const reply = handler(entry);
    if (!reply) return; // never answers: exercises the provider timeout
    response.writeHead(reply.status ?? 200, Object.fromEntries(Object.entries({ 'content-type': 'application/json', ...reply.headers }).filter(([, v]) => v !== undefined)) as Record<string, string>);
    response.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  base[name] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const aiWrites: any[] = [];
let marksHang = false;

beforeAll(async () => {
  await serve('ai', ({ headers, body }) => {
    if (headers.authorization !== 'Bearer ai-token-value') return { status: 401 };
    if (!body?.id) return { status: 202, raw: '' };
    const result = body.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
      : body.method === 'tools/list' ? { tools: [{ name: 'memory_query', inputSchema: { properties: { query: {}, project: {} } } }, { name: 'memory_write_page', inputSchema: { properties: { path: {}, body: {} } } }] }
      : body.params.name === 'memory_query' ? { content: [{ type: 'text', text: JSON.stringify({ hits: [{ id: 'p1', path: 'decisions/pnpm.md', title: 'Package manager', snippet: 'The project uses pnpm' }, { id: 'p2', path: 'notes/dup.md', snippet: 'Shared fact about Brain' }] }) }] }
      : (aiWrites.push(body.params.arguments), { content: [{ type: 'text', text: '{"ok":true}' }] });
    // Exercise the event-stream answer the streamable HTTP transport may choose.
    return body.method === 'tools/call' ? { headers: { 'content-type': 'text/event-stream' }, raw: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n` }
      : { body: { jsonrpc: '2.0', id: body.id, result }, headers: { 'mcp-session-id': 'fake-session' } };
  });
  await serve('ov', ({ url }) => url === '/api/v1/system/status' ? { body: { status: 'ok', result: { user: 'marcos' } } }
    : { body: { status: 'ok', result: { memories: [{ uri: 'viking://user/marcos/memories/editor.md', abstract: 'Editor is neovim', score: 0.8 }], resources: [], skills: [] } } });
  await serve('marks', ({ url, headers }) => {
    if (marksHang && url !== '/health') return null;
    if (url === '/health') return { body: { ok: true } };
    if (headers['x-api-key'] !== 'marks-api-key-value') return { status: 401 };
    if (url === '/memories/human/recall') return { body: { memories: [{ id: 'm1', content: 'Deploys go through MarksPanel' }, { id: 'm2', content: 'shared fact about brain' }], scores: [0.9, 0.5] } };
    if (url === '/memories/human') return { body: { id: 'remote-77' } };
    return { status: 404 };
  });
  const dir = temp();
  configureVaultForTests(path.join(dir, 'vault.json'), { getKey: async () => localKey, setKey: async value => { localKey = value; } });
  await createVault(MASTER);
  await putVault({ name: 'brain.ai-memory', value: 'ai-token-value', origin: base.ai!, header: 'Authorization', insecureHttp: true }, MASTER);
  await putVault({ name: 'brain.marks-memories', value: 'marks-api-key-value', origin: base.marks!, header: 'X-API-Key', insecureHttp: true }, MASTER);
  configureBrainForTests(path.join(dir, 'brain.sqlite'));
  await brainSave({ content: 'Shared fact about Brain' });
  await brainSave({ content: 'Local note: the project uses pnpm workspaces' });
});
let localKey: string | null = null;
afterEach(() => { for (const list of Object.values(seen)) list.length = 0; aiWrites.length = 0; marksHang = false; });
afterAll(async () => {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});
function configure(overrides: { remoteRecall?: boolean; remoteSync?: boolean; ai?: object; ov?: object; marks?: object } = {}): void {
  settings = brainSettingsSchema.parse({
    remoteRecall: overrides.remoteRecall ?? true, remoteSync: overrides.remoteSync ?? false,
    providers: {
      aiMemory: { enabled: true, url: `${base.ai}/mcp`, timeoutMs: 2000, ...overrides.ai },
      openviking: { enabled: true, url: base.ov, timeoutMs: 2000, ...overrides.ov },
      marksApi: { enabled: true, url: base.marks, timeoutMs: 2000, ...overrides.marks }
    }
  });
}

describe('Brain H1b providers', () => {
  it('keeps recall local, with no request, until remote recall is on', async () => {
    configure({ remoteRecall: false });
    const result = await combinedRecall('pnpm');
    expect(result.remote).toBe(false);
    expect(result.items.every(item => item.source === 'local')).toBe(true);
    expect(seen.ai!.length + seen.ov!.length + seen.marks!.length).toBe(0);
  });

  it('merges every enabled source, labels and de-duplicates results', async () => {
    configure();
    const result = await combinedRecall('brain pnpm', { limit: 12 });
    expect(result.errors).toEqual([]);
    const sources = new Set(result.items.map(item => item.source));
    expect([...sources].sort()).toEqual(['aiMemory', 'local', 'marksApi', 'openviking']);
    // "Shared fact about Brain" exists locally, on ai-memory and (case-folded) on the Marks API: once.
    expect(result.items.filter(item => item.content.toLowerCase() === 'shared fact about brain')).toHaveLength(1);
    expect(formatRecall(result.items)).toContain('[OpenViking] editor.md: Editor is neovim');
    // ai-memory: discovered tools and called the search tool with the vault bearer; MCP session kept.
    expect(seen.ai!.map(row => row.body?.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(seen.ai!.at(-1)!.headers['mcp-session-id']).toBe('fake-session');
    expect(seen.ai!.at(-1)!.body.params).toMatchObject({ name: 'memory_query', arguments: { query: 'brain pnpm', limit: 12 } });
    // OpenViking: find against the memories target, no credential needed on loopback.
    expect(seen.ov!.at(-1)).toMatchObject({ url: '/api/v1/search/find', body: { query: 'brain pnpm', target_uri: 'viking://~/memories', score_threshold: 0 } });
    expect(seen.ov!.at(-1)!.headers.authorization).toBeUndefined();
    // Marks API: X-API-Key from the vault; Markspanel bearer is not sent in apiKey mode.
    const marks = seen.marks!.at(-1)!;
    expect(marks).toMatchObject({ url: '/memories/human/recall', body: { cue: 'brain pnpm', limit: 12, user_id: 'marks-local' } });
    expect(marks.headers.authorization).toBeUndefined();
  });

  it('sends the Markspanel bearer and org headers only when that auth is chosen', async () => {
    configure({ ai: { enabled: false }, ov: { enabled: false }, marks: { auth: 'both', orgId: 'org-1', customerId: 'cust-1' } });
    await combinedRecall('deploy');
    const headers = seen.marks!.at(-1)!.headers;
    expect(headers).toMatchObject({ 'x-api-key': 'marks-api-key-value', authorization: 'Bearer panel-bearer-value', 'x-org-id': 'org-1', 'x-customer-id': 'cust-1' });
    expect(seen.marks!.at(-1)!.body.user_id).toBe('panel-user-1');
  });

  it('reports each provider error separately: stopped, timeout, missing key, insecure', async () => {
    configure({ ai: { secret: 'brain.missing' }, ov: { url: 'http://127.0.0.1:9' }, marks: { timeoutMs: 1000 } });
    marksHang = true;
    const result = await combinedRecall('brain');
    // Local results survive every remote failure.
    expect(result.items.map(item => item.source)).toEqual(['local']);
    const errors = Object.fromEntries(result.errors.map(row => [row.source, row.error]));
    expect(errors.aiMemory).toMatch(/Add vault entry brain\.missing/);
    expect(seen.ai!).toHaveLength(0); // no key: nothing was sent
    expect(errors.openviking).toMatch(/not running.*openviking-server --config/);
    expect(errors.marksApi).toMatch(/Timed out/);
    configure({ ai: { enabled: false }, ov: { enabled: false }, marks: { url: 'http://memories.example.invalid:8689' } });
    const insecure = await combinedRecall('anything');
    expect(insecure.errors).toEqual([{ source: 'marksApi', error: expect.stringMatching(/insecure HTTP is acknowledged/) }]);
  });

  it('refuses a vault entry bound to another origin', async () => {
    configure({ ov: { enabled: false }, marks: { enabled: false }, ai: { secret: 'brain.marks-memories' } });
    const result = await combinedRecall('pnpm');
    expect(result.errors).toEqual([{ source: 'aiMemory', error: expect.stringMatching(/bound to another origin/) }]);
    expect(seen.ai!).toHaveLength(0);
  });

  it('redacts vault values from the query before it leaves the machine', async () => {
    configure({ ai: { enabled: false }, ov: { enabled: false } });
    await combinedRecall('my key is marks-api-key-value ok');
    expect(JSON.stringify(seen.marks!.at(-1)!.body)).not.toContain('marks-api-key-value');
    expect(seen.marks!.at(-1)!.body.cue).toContain('[secret:brain.marks-memories]');
  });

  it('syncs a saved memory only with remote sync on, and records the remote id', async () => {
    configure({ remoteSync: false });
    const memory = await brainSave({ content: 'Sync candidate memory' });
    expect(await syncSavedMemory(memory)).toEqual([]);
    expect(aiWrites).toHaveLength(0);
    configure({ remoteSync: true });
    const results = await syncSavedMemory(memory);
    expect(results).toEqual([{ source: 'aiMemory', ok: true }, { source: 'marksApi', ok: true }]);
    expect(aiWrites[0]).toMatchObject({ path: `notes/chat-marks-${memory.contentHash.slice(0, 16)}.md`, body: '# Sync candidate memory\n\nSync candidate memory\n' });
    expect(seen.marks!.find(row => row.url === '/memories/human')!.body).toMatchObject({ content: 'Sync candidate memory', source_name: 'chat-marks', type: 'semantic' });
    expect((await brainGet(memory.id))!.remote).toMatchObject({ provider: 'marksApi', remoteId: 'remote-77' });
    // Imported memories never leave the machine.
    const imported = await brainSave({ content: 'Imported memory', provenance: { source: 'import' } });
    expect(await syncSavedMemory(imported)).toEqual([]);
  });

  it('shows provider status for Doctor and Sources with the OpenViking start hint', async () => {
    configure({ ov: { url: 'http://127.0.0.1:9' } });
    const rows = await providerStatuses(true);
    const by = Object.fromEntries(rows.map(row => [row.id, row]));
    expect(by.local).toMatchObject({ state: 'ok', enabled: true });
    expect(by.aiMemory).toMatchObject({ state: 'ok', hasKey: true, detail: '2 tools; search memory_query, save memory_write_page' });
    expect(by.openviking).toMatchObject({ state: 'stopped', hasKey: false });
    expect(by.openviking!.detail).toMatch(/openviking-server --config ~\/\.openviking\/ov\.conf/);
    expect(by.marksApi).toMatchObject({ state: 'ok', hasKey: true });
    configure({ remoteRecall: false, ai: { enabled: false }, ov: { enabled: false }, marks: { enabled: false } });
    expect((await providerStatuses(false)).filter(row => row.id !== 'local').map(row => row.state)).toEqual(['disabled', 'disabled', 'disabled']);
  });

  it('shows a persisted key even when the provider URL changes, without claiming it can authenticate', async () => {
    configure({ ai: { secret: 'brain.marks-memories' }, ov: { enabled: false }, marks: { enabled: false } });
    const row = (await providerStatuses(false)).find(item => item.id === 'aiMemory');
    expect(row?.hasKey).toBe(true);
    expect(row?.state).toBe('disabled');
  });

  it('does not mistake an unreadable persisted vault for absent Brain credentials', async () => {
    configure();
    const existingKey = localKey;
    localKey = null; // Simulate a missing OS key, leaving the synthetic vault file intact.
    try {
      const rows = await providerStatuses(false);
      for (const id of ['aiMemory', 'openviking', 'marksApi']) {
        expect(rows.find(item => item.id === id)?.hasKey).toBeUndefined();
      }
    } finally { localKey = existingKey; }
    expect((await providerStatuses(false)).find(row => row.id === 'aiMemory')?.hasKey).toBe(true);
  });

  it('budgets merged recall by count and characters, round-robin across sources', () => {
    const item = (source: 'local' | 'aiMemory', n: number) => ({ source, id: `${source}:${n}`, content: 'x'.repeat(400), contentHash: `${source}${n}`.padEnd(64, '0') });
    const merged = mergeRecall([[item('local', 1), item('local', 2), item('local', 3)], [item('aiMemory', 1)]], 3, 1000);
    expect(merged.map(row => row.id)).toEqual(['local:1', 'aiMemory:1', 'local:2']);
    expect(merged.reduce((total, row) => total + row.content.length, 0)).toBeLessThanOrEqual(1000);
  });
});

describe('Brain H1b credentials', () => {
  it('stores plain-HTTP vault origins only with the explicit insecure flag', async () => {
    await expect(putVault({ name: 'plain', value: 'v', origin: 'http://api.example.test:8689', header: 'X-API-Key' }, MASTER)).rejects.toThrow(/HTTPS/);
    await putVault({ name: 'plain', value: 'v', origin: 'http://api.example.test:8689', header: 'X-API-Key', insecureHttp: true }, MASTER);
    expect((await listVault()).find(row => row.name === 'plain')).toEqual({ name: 'plain', origin: 'http://api.example.test:8689', header: 'X-API-Key', insecureHttp: true });
  });

  it('finds MarksCode credentials in config homes without exposing other fields', async () => {
    const home = temp();
    mkdirSync(path.join(home, 'markscode'));
    writeFileSync(path.join(home, 'markscode', 'markscode.json'), JSON.stringify({ mcp: { 'ai-memory': { type: 'remote', url: 'https://memory.example/mcp', headers: { Authorization: 'Bearer abc123' } } } }));
    writeFileSync(path.join(home, 'markscode', 'access.json'), JSON.stringify({ username: 'u', memories_api_key: 'k-456' }));
    expect(await findMarksCodeCredential('aiMemory', [path.join(home, 'missing'), path.join(home, 'markscode')])).toBe('abc123');
    expect(await findMarksCodeCredential('marksApi', [path.join(home, 'markscode')])).toBe('k-456');
    expect(await findMarksCodeCredential('marksApi', [path.join(home, 'missing')])).toBeNull();
  });
});
