import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({
  userData: '', home: '', project: '', calls: [] as string[],
  durable: ['codex', 'claude'] as unknown,
  handler: null as null | ((event: any, request: unknown) => Promise<any>)
}));
vi.mock('electron', () => ({
  app: { getPath: (kind: string) => kind === 'userData' ? state.userData : state.home, on: vi.fn() },
  ipcMain: { handle: (_name: string, handler: typeof state.handler) => { state.handler = handler; } }
}));
vi.mock('../src/main/projects.js', () => ({ projectWorkspace: async () => ({ real: state.project }) }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({}), effectiveCapabilities: () => ({ command: true }) }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: async () => state.durable,
  writeDurableNow: async (_key: string, value: unknown) => { state.durable = value; }
}));
// The real version probe; only installing is replaced, and no registry is asked.
vi.mock('../src/main/cli-source-install.js', async importOriginal => ({ ...(await importOriginal<typeof import('../src/main/cli-source-install.js')>()), installPublishedCli: vi.fn(), publishedLatest: vi.fn(async () => null) }));

import { cliAction, cliCreateSession, cliOpen, cliStatus, registerCliModuleIpc } from '../src/main/cli-modules.js';

function tmuxSocket(): string {
  return `chat-marks-${createHash('sha256').update(state.userData).digest('hex').slice(0, 16)}`;
}
function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-L', tmuxSocket(), ...args], { encoding: 'utf8', timeout: 8_000 }).trim();
}
function hasSession(name: string): boolean {
  return spawnSync('tmux', ['-L', tmuxSocket(), 'has-session', '-t', `=${name}`], { stdio: 'ignore', timeout: 8_000 }).status === 0;
}
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting for real tmux CLI');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

const linux = process.platform === 'linux' && (() => { try { execFileSync('tmux', ['-V'], { timeout: 1_000 }); return true; } catch { return false; } })();
describe.skipIf(!linux)('real Linux tmux terminal lifecycle', () => {
  const firstProject = '00000000-0000-4000-8000-000000000001';
  const secondProject = '00000000-0000-4000-8000-000000000002';
  let temporary = '';
  let previousPath: string | undefined;
  let mainFrame: object;
  let sender: any;
  async function request(action: unknown): Promise<any> {
    return state.handler!({ sender, senderFrame: mainFrame }, action);
  }

  beforeAll(() => {
    temporary = mkdtempSync(path.join(os.tmpdir(), 'marks-cli-tmux-'));
    state.userData = path.join(temporary, 'userData');
    state.home = path.join(temporary, 'home');
    state.project = path.join(temporary, 'project with spaces');
    const binDir = path.join(temporary, 'bin with spaces');
    for (const folder of [state.userData, state.home, state.project, binDir]) mkdirSync(folder, { recursive: true });
    for (const id of ['codex', 'claude']) {
      const binary = path.join(binDir, id);
      writeFileSync(binary, `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '${id === 'codex' ? 'codex-cli 0.163.0' : id === 'claude' ? '2.1.306 (Claude Code)' : `${id} probe-1`}\\n'; exit 0; fi\nprintf 'ready\\n' > ready-${id}.txt\nexec /bin/sh -i\n`, { mode: 0o755 });
    }
    previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
    mainFrame = {};
    sender = { mainFrame, once: vi.fn(), send: vi.fn(), isDestroyed: () => false };
    registerCliModuleIpc(() => ({ webContents: sender, isDestroyed: () => false } as any));
  });
  afterAll(() => {
    spawnSync('tmux', ['-L', tmuxSocket(), 'kill-server'], { stdio: 'ignore', timeout: 8_000 });
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  });

  it('executes CLI in the exact project, survives a view detach, and reconnects the original session', async () => {
    const session = await cliCreateSession('codex', firstProject);
    const firstId = randomUUID();
    const first = await cliOpen(session.id, 80, 24, firstId);
    await until(() => existsSync(path.join(state.project, 'ready-codex.txt')));
    expect(tmux('list-panes', '-t', `=${first.session}`, '-F', '#{pane_current_path}')).toBe(state.project);
    expect(await request({ action: 'detach', attachmentId: firstId })).toMatchObject({ ok: true });
    expect(hasSession(first.session)).toBe(true);
    vi.resetModules();
    const restarted = await import('../src/main/cli-modules.js');
    restarted.registerCliModuleIpc(() => ({ webContents: sender, isDestroyed: () => false } as any));
    expect((await request({ action: 'status' })).ok).toBe(true);
    const secondId = randomUUID();
    const second = await restarted.cliOpen(session.id, 80, 24, secondId);
    expect(second.session).toBe(first.session);
    const writeResult = await request({ action: 'write', attachmentId: secondId, data: 'echo reopened > reopened.txt\n' });
    expect(writeResult.ok).toBe(true);
    await until(() => existsSync(path.join(state.project, 'reopened.txt')));
    await request({ action: 'detach', attachmentId: secondId });
  });

  it('isolates two project IDs pointing to the same directory, and Stop/Disable kill only their module', async () => {
    const codexSession = await cliCreateSession('codex', secondProject);
    const claudeSession = await cliCreateSession('claude', firstProject);
    const codexOtherSession = await cliCreateSession('codex', firstProject);
    const codex = await cliOpen(codexSession.id, 80, 24, randomUUID());
    const claude = await cliOpen(claudeSession.id, 80, 24, randomUUID());
    const codexOther = await cliOpen(codexOtherSession.id, 80, 24, randomUUID());
    expect(codex.session).not.toBe(codexOther.session);
    expect(codex.session).not.toBe(claude.session);
    expect((await cliStatus()).find(item => item.id === 'codex')).toMatchObject({ installed: true, running: true, version: '0.163.0' });
    await cliAction('codex', 'stop');
    expect(hasSession(codex.session)).toBe(false);
    expect(hasSession(codexOther.session)).toBe(false);
    expect(hasSession(claude.session)).toBe(true);
    const restarted = await cliOpen(codexSession.id, 80, 24, randomUUID());
    expect(restarted.session).toBe(codex.session);
    expect(hasSession(restarted.session)).toBe(true);
    await cliAction('claude', 'disable');
    expect(hasSession(claude.session)).toBe(false);
    await expect(cliOpen(claudeSession.id, 80, 24, randomUUID())).rejects.toThrow('disabled');
  });
});
