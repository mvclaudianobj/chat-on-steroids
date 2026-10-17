import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  command: true,
  project: '/approved/project',
  commands: [] as string[][],
  handle: null as null | ((event: any, payload: unknown) => Promise<any>),
  blockHasSession: false,
  resumeHasSession: null as null | (() => void),
  pty: { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn() },
  durable: ['codex'] as unknown,
  save: vi.fn()
}));
vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'home' ? '/home/test' : '/home/test/.config/chat-marks', on: vi.fn() },
  ipcMain: { handle: (_name: string, callback: typeof fixture.handle) => { fixture.handle = callback; } }
}));
vi.mock('node-pty', () => ({ spawn: vi.fn(() => fixture.pty) }));
vi.mock('node:child_process', () => {
  const execFile = (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    fixture.commands.push([file, ...args]);
    if (fixture.blockHasSession && args.includes('has-session')) {
      fixture.blockHasSession = false;
      fixture.resumeHasSession = () => callback(null, '', '');
      return;
    }
    if (file === 'wsl.exe') {
      if (args.includes('printenv')) callback(null, '/home/test\n', '');
      else if (args.includes('wslpath')) callback(null, '/mnt/c/approved/project\n', '');
      else if (args.includes('-V')) callback(null, 'tmux 3.3\n', '');
      else if (args.includes('--version')) callback(null, 'codex-cli 1.0\n', '');
      else callback(null, '', '');
      return;
    }
    if (file === '/usr/bin/env' && args[0] === 'which') {
      if (args[1] === 'tmux') callback(null, '/usr/bin/tmux\n', '');
      else if (args[1] === 'codex') callback(null, '/usr/local/bin/codex\n', '');
      else callback(new Error('missing'), '', '');
    } else if (file === '/usr/local/bin/codex') callback(null, 'codex-cli 1.0\n', '');
    else callback(null, '', '');
  };
  (execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = (file: string, args: string[], options: unknown) => new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  return { execFile };
});
vi.mock('../src/main/projects.js', () => ({ projectWorkspace: async () => ({ real: fixture.project }) }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({}), effectiveCapabilities: () => ({ command: fixture.command }) }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: async () => fixture.durable,
  writeDurableNow: async (name: string, value: unknown) => {
    fixture.durable = value;
    return fixture.save(name, value);
  }
}));
vi.mock('../src/main/cli-source-install.js', () => ({ installFork: vi.fn() }));

import { cliAction, cliChatRuntime, cliCreateSession, cliOpen, cliSessions, cliStatus, registerCliModuleIpc, registerCliModuleStopHook } from '../src/main/cli-modules.js';

beforeEach(() => { fixture.command = true; fixture.project = '/approved/project'; fixture.durable = ['codex']; fixture.blockHasSession = false; fixture.resumeHasSession = null; fixture.commands.length = 0; vi.clearAllMocks(); });

describe('Persistent coding CLI terminal', () => {
  it('creates independent durable sessions and reopens each stable tmux identity', async () => {
    const firstSession = await cliCreateSession('codex', 'a-workspace');
    const secondSession = await cliCreateSession('codex', 'a-workspace');
    expect(firstSession.id).not.toBe(secondSession.id);
    expect(firstSession.tmuxSession).not.toBe(secondSession.tmuxSession);
    expect(await cliSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstSession.id, tmuxSession: firstSession.tmuxSession }),
      expect.objectContaining({ id: secondSession.id, tmuxSession: secondSession.tmuxSession })
    ]));
    const info = await cliOpen(firstSession.id, 90, 30, 'first');
    expect(info.cwd).toBe(process.platform === 'win32' ? '/mnt/c/approved/project' : '/approved/project');
    expect(info.session).toBe(firstSession.tmuxSession);
    expect(fixture.commands.some(args => args.includes('has-session') && args.includes(`=${info.session}`))).toBe(true);
    const pty = (await import('node-pty')).spawn;
    expect(pty).toHaveBeenCalledWith('tmux', expect.arrayContaining(['attach-session', '-t', `=${info.session}`]), expect.objectContaining({ cwd: '/approved/project', cols: 90, rows: 30 }));
    expect(await cliOpen(secondSession.id, 80, 20, 'second')).toMatchObject({ session: secondSession.tmuxSession });
    expect(await cliOpen(firstSession.id, 80, 20, 'third')).toMatchObject({ session: info.session });
    expect(fixture.commands.some(args => args.includes('kill-session'))).toBe(false);
  });

  it('rejects disabled command authority and wrong renderer callers', async () => {
    const session = await cliCreateSession('codex', null);
    fixture.command = false;
    await expect(cliOpen(session.id, 80, 24, 'deny')).rejects.toThrow('disabled');
    fixture.command = true;
    const contents = { mainFrame: {}, send: vi.fn(), once: vi.fn(), isDestroyed: () => false };
    registerCliModuleIpc(() => ({ webContents: contents, isDestroyed: () => false } as any));
    const result = await fixture.handle!({ sender: {}, senderFrame: {} }, { action: 'status' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not authorized');
  });

  it('keeps module activation durable before publishing new state', async () => {
    fixture.save.mockResolvedValue(undefined);
    const result = await cliAction('codex', 'enable');
    expect(result.find(item => item.id === 'codex')).toMatchObject({ enabled: true, installed: true });
    expect(fixture.save).toHaveBeenCalledWith('marks-cli-modules', expect.objectContaining({ enabled: expect.arrayContaining(['codex']), sessions: expect.any(Array) }));
    expect((await cliStatus()).find(item => item.id === 'codex')?.version).toBe('codex-cli 1.0');
  });

  it('uses Windows WSL2 tmux with the converted approved workspace and detached session', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      fixture.project = 'C:\\approved\\project';
      const contents = { mainFrame: {}, send: vi.fn(), once: vi.fn(), isDestroyed: () => false };
      registerCliModuleIpc(() => ({ webContents: contents, isDestroyed: () => false } as any));
      await fixture.handle!({ sender: contents, senderFrame: contents.mainFrame }, { action: 'status' });
      const attachmentId = '00000000-0000-4000-8000-000000000006';
      const session = await cliCreateSession('codex', 'project-a');
      const info = await cliOpen(session.id, 80, 25, attachmentId);
      expect(info.cwd).toBe('/mnt/c/approved/project');
      expect(fixture.commands.some(args => args[0] === 'wsl.exe' && args.includes('wslpath'))).toBe(true);
      const spawn = (await import('node-pty')).spawn;
      expect(spawn).toHaveBeenCalledWith('wsl.exe', expect.arrayContaining(['--exec', 'tmux', 'attach-session']), expect.objectContaining({ cwd: 'C:\\approved\\project', useConpty: true }));
      const reply = await fixture.handle!({ sender: contents, senderFrame: contents.mainFrame }, { action: 'write', attachmentId, data: 'help\n' });
      expect(reply.ok).toBe(true);
      expect(fixture.pty.write).toHaveBeenCalledWith('help\n');
      const runtime = await cliChatRuntime('codex', 'project-a');
      expect(runtime).toEqual({ bin: 'wsl.exe', cwd: 'C:\\approved\\project', argsPrefix: ['--cd', '/mnt/c/approved/project', '--exec', '/home/test/.local/share/chat-marks-modules/codex/bin/codex'] });
    } finally { vi.restoreAllMocks(); }
  });

  it('serializes opening against Stop, detaches the attachment and tells headless consumers to cancel', async () => {
    const session = await cliCreateSession('codex', 'project-a');
    fixture.blockHasSession = true;
    const terminal = cliOpen(session.id, 80, 25, 'pending-open');
    await vi.waitFor(() => expect(fixture.resumeHasSession).not.toBeNull());
    const signal = vi.fn();
    const unsubscribe = registerCliModuleStopHook(signal);
    const stop = cliAction('codex', 'stop');
    expect(fixture.commands.some(args => args.includes('list-sessions'))).toBe(false);
    fixture.resumeHasSession!();
    await terminal;
    await stop;
    expect(signal).toHaveBeenCalledWith('codex');
    expect(fixture.pty.kill).toHaveBeenCalled();
    unsubscribe();
  });

  it('keeps macOS on the host tmux path without WSL mappings', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    try {
      const runtime = await cliChatRuntime('codex', 'project-a');
      expect(runtime).toMatchObject({ bin: '/usr/local/bin/codex', argsPrefix: [], cwd: '/approved/project' });
      const session = await cliCreateSession('codex', 'project-a');
      const opened = await cliOpen(session.id, 80, 24, 'darwin-attachment');
      expect(opened.cwd).toBe('/approved/project');
      expect(fixture.commands.some(args => args[0] === 'wsl.exe')).toBe(false);
    } finally { vi.restoreAllMocks(); }
  });
});
