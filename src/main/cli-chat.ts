/** Workspace-scoped local CLI conversations. Separate durable owner from ChatGPT sessions. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { cliChatRuntime, registerCliModuleStopHook } from './cli-modules.js';
import { getConfig, effectiveCapabilities } from './config.js';
import { projectWorkspace } from './projects.js';
import { normalizeEnvironment, deleteEnvValue } from './env.js';
import { readDurable, writeDurableNow } from './durable.js';
import { cliEvent, headlessArgs, type CliChatBackend } from './cli-chat-protocol.js';
import { markspanelAccessBlocked } from './markspanel-auth.js';

const STORE = 'marks-cli-chat';
const BACKENDS = ['markscode', 'codex', 'claude'] as const;
const MAX_REPLY_CHARS = 64_000;
const MAX_LEDGER_CHARS = 5_000_000;
export type CliChatMessage = { id: string; role: 'user' | 'assistant'; text: string; state: 'completed' | 'running' | 'failed' | 'cancelled'; created: number };
export type CliChatThread = { key: string; backend: CliChatBackend; projectId: string | null; cwd: string; remoteSessionId: string | null; messages: CliChatMessage[] };
type Store = { threads: CliChatThread[] };
type Running = { child: ChildProcessWithoutNullStreams; messageId: string; cancelled: boolean; timer: NodeJS.Timeout };
const active = new Map<string, Running>();
const starting = new Set<string>();
const cancelledBeforeSpawn = new Set<string>();
const moduleEpoch = new Map<CliChatBackend, number>();
let store: Store | null = null;
let operation = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = operation.then(work);
  operation = result.then(() => undefined, () => undefined);
  return result;
}
function allowed(): void {
  if (markspanelAccessBlocked()) throw new Error('MarksPanel is signing out');
  if (!effectiveCapabilities(getConfig()).command) throw new Error('Command execution is disabled');
}
async function initialized(): Promise<Store> {
  if (!store) {
    const fromDisk = await readDurable<unknown>(STORE);
    const parsed = z.object({ threads: z.array(z.object({
      key: z.string().max(100), backend: z.enum(BACKENDS), projectId: z.string().uuid().nullable(), cwd: z.string().max(4096),
      remoteSessionId: z.string().max(128).nullable(), messages: z.array(z.object({
        id: z.string().uuid(), role: z.enum(['user', 'assistant']), text: z.string().max(MAX_REPLY_CHARS),
        state: z.enum(['completed', 'running', 'failed', 'cancelled']), created: z.number().finite()
      }).strict()).max(120)
    }).strict()).max(100) }).strict().safeParse(fromDisk);
    store = parsed.success ? parsed.data : { threads: [] };
    // A process cannot survive an app crash; no old progress claim may remain live.
    let recovered = false;
    for (const thread of store.threads) {
      for (const msg of thread.messages) if (msg.state === 'running') {
        msg.state = 'failed'; if (msg.role === 'assistant') msg.text = `${msg.text}\n[CLI session interrupted by app restart]`.trim();
        recovered = true;
      }
    }
    if (recovered) await writeDurableNow(STORE, store);
  }
  return store;
}
async function saved(): Promise<void> {
  const ledger = await initialized();
  // A renderer summary or a small event chunk is not a bound on disk/history.
  // Keep the newest messages from every scoped conversation while enforcing a
  // shared 5 MB ceiling across all backend workspaces.
  for (let i = 0; i < 10_000 && Buffer.byteLength(JSON.stringify(ledger), 'utf8') > MAX_LEDGER_CHARS; i++) {
    const oldest = ledger.threads.filter(thread => thread.messages.length > 2)
      .sort((a, b) => a.messages[0]!.created - b.messages[0]!.created)[0];
    if (oldest) { oldest.messages.shift(); continue; }
    const previous = ledger.threads.filter(thread => !active.has(thread.key) && !starting.has(thread.key))
      .sort((a, b) => (a.messages.at(-1)?.created ?? 0) - (b.messages.at(-1)?.created ?? 0))[0];
    if (!previous || ledger.threads.length <= 1) throw new Error('CLI history exceeds the storage limit');
    ledger.threads.splice(ledger.threads.indexOf(previous), 1);
  }
  await writeDurableNow(STORE, ledger);
}
function snapshot(thread: CliChatThread): CliChatThread { return structuredClone(thread); }
async function scope(backend: CliChatBackend, projectId: string | null): Promise<{ key: string; cwd: string }> {
  const cwd = projectId ? (await projectWorkspace(projectId)).real : app.getPath('home');
  const key = `${backend}:${createHash('sha256').update(projectId ?? '').update('\0').update(cwd).digest('hex').slice(0, 32)}`;
  return { key, cwd };
}
function notify(window: BrowserWindow | null, thread: CliChatThread): void {
  if (window && !window.isDestroyed()) window.webContents.send('cliChat:event', snapshot(thread));
}
async function open(backend: CliChatBackend, projectId: string | null): Promise<CliChatThread> {
  const { key, cwd } = await scope(backend, projectId);
  const ledger = await initialized();
  let thread = ledger.threads.find(row => row.key === key);
  if (!thread) {
    thread = { key, cwd, backend, projectId, remoteSessionId: null, messages: [] };
    if (ledger.threads.length >= 100) throw new Error('Too many local CLI conversations');
    ledger.threads.push(thread);
    await saved();
  }
  return thread;
}

function validateRemoteId(id: string | undefined): string | null {
  return id && /^[\w-]{8,128}$/.test(id) ? id : null;
}

async function finish(key: string, messageId: string, outcome: 'completed' | 'failed' | 'cancelled', text: string, remoteId: string | null,
  window: () => BrowserWindow | null): Promise<void> {
  await serial(async () => {
    const thread = (await initialized()).threads.find(row => row.key === key);
    const msg = thread?.messages.find(row => row.id === messageId);
    if (!thread || !msg || msg.state !== 'running') return;
    msg.state = outcome;
    msg.text = text.slice(0, MAX_REPLY_CHARS) || (outcome === 'completed' ? '(The CLI returned no text)' : 'CLI execution ended without a response.');
    // A failed/cancelled first response never acquires an unverified remote session.
    if (remoteId && outcome === 'completed') thread.remoteSessionId = remoteId;
    await saved();
    notify(window(), thread);
  });
}

async function send(backend: CliChatBackend, projectId: string | null, prompt: string, window: () => BrowserWindow | null): Promise<CliChatThread> {
  allowed();
  const epoch = moduleEpoch.get(backend) ?? 0;
  const runtime = await cliChatRuntime(backend, projectId);
  allowed();
  const resolved = await scope(backend, projectId);
  if (runtime.cwd !== resolved.cwd) throw new Error('Workspace identity changed');
  const thread = await serial(() => open(backend, projectId));
  if (active.has(thread.key) || starting.has(thread.key)) throw new Error('The CLI is already answering this conversation');
  if (active.size + starting.size >= 3) throw new Error('Maximum three concurrent CLI conversations');
  starting.add(thread.key);
  const remote = thread.remoteSessionId;
  const messageId = randomUUID();
  try { await serial(async () => {
    thread.messages.push({ id: randomUUID(), role: 'user', text: prompt, state: 'completed', created: Date.now() });
    thread.messages.push({ id: messageId, role: 'assistant', text: '', state: 'running', created: Date.now() });
    if (thread.messages.length > 120) thread.messages.splice(0, thread.messages.length - 120);
    await saved();
  }); } catch (error) { starting.delete(thread.key); cancelledBeforeSpawn.delete(thread.key); throw error; }
  notify(window(), thread);
  // Disable/Stop can interleave any preceding durable/project await. Recheck
  // the backend and its ownership immediately before spawning, and fence a
  // stop that happened in flight even if the user reenabled it in between.
  let current: typeof runtime;
  try {
    current = await cliChatRuntime(backend, projectId);
    if (current.cwd !== resolved.cwd || epoch !== (moduleEpoch.get(backend) ?? 0)) throw new Error('CLI module was stopped while opening this message');
    allowed();
  } catch (error) {
    starting.delete(thread.key);
    cancelledBeforeSpawn.delete(thread.key);
    await finish(thread.key, messageId, 'failed', 'CLI module is unavailable. Enable it and retry.', null, window);
    return snapshot(thread);
  }
  if (cancelledBeforeSpawn.delete(thread.key)) {
    starting.delete(thread.key);
    await finish(thread.key, messageId, 'cancelled', 'Request cancelled before CLI startup.', null, window);
    return snapshot(thread);
  }
  const args = [...current.argsPrefix, ...headlessArgs(backend, remote)];
  const env = normalizeEnvironment(); deleteEnvValue(env, 'ELECTRON_RUN_AS_NODE');
  let child: ChildProcessWithoutNullStreams;
  try { child = spawn(current.bin, args, { cwd: current.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
  catch { starting.delete(thread.key); cancelledBeforeSpawn.delete(thread.key); await finish(thread.key, messageId, 'failed', 'Cannot start this CLI.', null, window); return snapshot(thread); }
  let text = '';
  let session = remote;
  let failure = false;
  let partial = '';
  let totalBytes = 0;
  const consume = (line: string): void => {
    const projected = cliEvent(backend, line);
    if (projected.sessionId) session = validateRemoteId(projected.sessionId) ?? session;
    if (projected.failure) failure = true;
    if (projected.text) {
      // Claude's assistant event and result may describe the same final text.
      const next = projected.text.trim();
      if (backend === 'claude' && next === text.trim()) return;
      text = (backend === 'claude' && !text ? next : `${text}${text ? '\n\n' : ''}${next}`).slice(0, MAX_REPLY_CHARS);
      const msg = thread.messages.find(item => item.id === messageId);
      if (msg && msg.state === 'running') msg.text = text;
      notify(window(), thread);
    }
  };
  child.stdout.on('data', (data: Buffer) => {
    totalBytes += data.length;
    if (totalBytes > 8 * 1024 * 1024) { failure = true; child.kill(); return; }
    partial += data.toString('utf8');
    if (partial.length > 1_048_576) { failure = true; child.kill(); return; }
    let cut: number;
    while ((cut = partial.indexOf('\n')) !== -1) {
      consume(partial.slice(0, cut)); partial = partial.slice(cut + 1);
    }
  });
  let errorCode = false;
  child.on('error', () => { errorCode = true; });
  const timer = setTimeout(() => { failure = true; child.kill(); }, 20 * 60_000);
  const running: Running = { child, messageId, cancelled: false, timer };
  active.set(thread.key, running);
  starting.delete(thread.key);
  child.stdin.on('error', () => undefined);
  child.stdin.end(prompt + '\n');
  child.stderr.on('data', () => undefined); // Never forward credentials, raw tools or private logs.
  child.once('close', code => {
    clearTimeout(timer);
    if (active.get(thread.key) === running) active.delete(thread.key);
    if (partial.trim()) consume(partial.trim());
    const outcome = running.cancelled ? 'cancelled' : failure || errorCode || code !== 0 ? 'failed' : 'completed';
    void finish(thread.key, messageId, outcome, text || (outcome === 'failed' ? `CLI exited with code ${code ?? 'unknown'}. Check its account and configuration.` : ''), session, window);
  });
  return snapshot(thread);
}

export function registerCliChatIpc(getWindow: () => BrowserWindow | null): void {
  const stopModules = registerCliModuleStopHook(id => {
    if (id === 'markscode' || id === 'codex' || id === 'claude') moduleEpoch.set(id, (moduleEpoch.get(id) ?? 0) + 1);
    for (const [key, running] of active) if (key.startsWith(`${id}:`)) {
      running.cancelled = true; running.child.kill();
    }
  });
  const backend = z.enum(BACKENDS);
  const projectId = z.string().uuid().nullable();
  const schema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('open'), backend, projectId }).strict(),
    z.object({ action: z.literal('send'), backend, projectId, prompt: z.string().trim().min(1).max(32_000) }).strict(),
    z.object({ action: z.literal('cancel'), backend, projectId }).strict()
  ]);
  ipcMain.handle('cliChat:request', async (event, payload: unknown) => {
    try {
      const window = getWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Window not authorized');
      const input = schema.parse(payload);
      allowed();
      let thread: CliChatThread;
      if (input.action === 'send') thread = await send(input.backend, input.projectId, input.prompt, getWindow);
      else if (input.action === 'cancel') {
        thread = await serial(() => open(input.backend, input.projectId));
        if (starting.has(thread.key)) cancelledBeforeSpawn.add(thread.key);
        const running = active.get(thread.key);
        if (running) { running.cancelled = true; running.child.kill(); }
      } else thread = await serial(() => open(input.backend, input.projectId));
      return { ok: true, data: snapshot(thread) };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'CLI request failed' }; }
  });
  app.on('before-quit', () => {
    stopModules();
    for (const running of active.values()) { running.cancelled = true; clearTimeout(running.timer); running.child.kill(); }
  });
}
