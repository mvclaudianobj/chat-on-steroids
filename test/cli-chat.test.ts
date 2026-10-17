import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  handles: new Map<string, (event: any, args: unknown) => Promise<any>>(),
  calls: [] as string[][],
  saved: null as unknown,
  emit: vi.fn(),
  allowed: true,
  cwd: '/project/a'
}));
vi.mock('electron', () => ({
  app: { getPath: (_name: string) => process.cwd(), on: vi.fn() },
  ipcMain: { handle: (name: string, callback: (event: any, args: unknown) => Promise<any>) => harness.handles.set(name, callback) }
}));
vi.mock('../src/main/cli-modules.js', () => ({
  registerCliModuleStopHook: () => () => undefined,
  cliChatRuntime: async (_backend: string, projectId: string | null) => ({
    bin: process.execPath, cwd: projectId ? harness.cwd : process.cwd(),
    argsPrefix: ['-e', `let stdin='';process.stdin.on('data',x=>stdin+=x);process.stdin.on('end',()=>{
      const id='0199a213-81c0-7800-8aa1-bbab2a035a53';
      console.log(JSON.stringify({type:'thread.started',thread_id:id}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ANSWER:'+stdin.trim()}}));
    });`]
  })
}));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({}), effectiveCapabilities: () => ({ command: harness.allowed }) }));
vi.mock('../src/main/projects.js', () => ({ projectWorkspace: async () => ({ real: harness.cwd }) }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: async () => structuredClone(harness.saved),
  writeDurableNow: async (_name: string, value: unknown) => { harness.saved = structuredClone(value); }
}));
vi.mock('../src/main/env.js', () => ({ normalizeEnvironment: () => ({ ...process.env }), deleteEnvValue: (env: Record<string, string>, key: string) => { delete env[key]; } }));

const { registerCliChatIpc } = await import('../src/main/cli-chat.js');
const contents = { mainFrame: {}, send: harness.emit, isDestroyed: () => false };
const window = { webContents: contents, isDestroyed: () => false } as any;
registerCliChatIpc(() => window);
const request = (args: unknown, authorized = true): Promise<any> => harness.handles.get('cliChat:request')!({ sender: authorized ? contents : {}, senderFrame: contents.mainFrame }, args);

beforeEach(() => { harness.allowed = true; harness.cwd = '/project/a'; harness.emit.mockClear(); });

describe('CLI chat isolation and durable replies', () => {
  it('writes accepted input, processes structured events and resumes the exact conversation', async () => {
    const first = await request({ action: 'send', backend: 'codex', projectId: null, prompt: 'test first' });
    expect(first.ok).toBe(true);
    await vi.waitFor(async () => {
      const read = await request({ action: 'open', backend: 'codex', projectId: null });
      expect(read.data.messages.at(-1)).toMatchObject({ state: 'completed', text: 'ANSWER:test first' });
    }, { timeout: 5_000 });
    const previous = await request({ action: 'open', backend: 'codex', projectId: null });
    expect(previous.data.remoteSessionId).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
    expect(previous.data.messages.at(-1).text).toBe('ANSWER:test first');
    expect(harness.saved).toBeTruthy();
    const again = await request({ action: 'send', backend: 'codex', projectId: null, prompt: 'second' });
    expect(again.ok).toBe(true);
    await vi.waitFor(async () => {
      const read = await request({ action: 'open', backend: 'codex', projectId: null });
      expect(read.data.messages.at(-1).state).toBe('completed');
    }, { timeout: 5_000 });
    const finished = await request({ action: 'open', backend: 'codex', projectId: null });
    expect(finished.data.messages).toHaveLength(4);
    expect(finished.data.messages.at(-1).text).toBe('ANSWER:second');
  });

  it('separates backends and workspace scopes and requires current window ownership', async () => {
    const other = await request({ action: 'open', backend: 'markscode', projectId: null });
    const codex = await request({ action: 'open', backend: 'codex', projectId: null });
    expect(other.data.key).not.toBe(codex.data.key);
    expect(other.data.messages).toHaveLength(0);
    harness.cwd = '/project/b';
    const secondWorkspace = await request({ action: 'open', backend: 'codex', projectId: '11111111-1111-4111-8111-111111111111' });
    expect(secondWorkspace.data.cwd).toBe('/project/b');
    expect(secondWorkspace.data.key).not.toBe(codex.data.key);
    expect((await request({ action: 'open', backend: 'codex', projectId: null }, false)).ok).toBe(false);
  });

  it('rejects forbidden execution and invalid/unbounded IPC input', async () => {
    harness.allowed = false;
    expect((await request({ action: 'send', backend: 'codex', projectId: null, prompt: 'nope' })).ok).toBe(false);
    harness.allowed = true;
    expect((await request({ action: 'send', backend: 'codex', projectId: null, prompt: 'a'.repeat(33_000) })).ok).toBe(false);
    expect((await request({ action: 'open', backend: 'other', projectId: null })).ok).toBe(false);
    expect((await request({ action: 'send', backend: 'codex', projectId: null, prompt: 'yes', shell: '/bin/sh' })).ok).toBe(false);
  });
});
