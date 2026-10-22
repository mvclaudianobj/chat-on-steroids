import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  command: true,
  project: '/approved/project',
  commands: [] as string[][],
  handle: null as null | ((event: any, payload: unknown) => Promise<any>),
  blockHasSession: false,
  missingSession: false,
  resumeHasSession: null as null | (() => void),
  pty: { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn() },
  durable: ['codex'] as unknown,
  probes: [] as string[][],
  tmuxCreated: 0,
  save: vi.fn()
}));
vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'home' ? '/home/test' : '/home/test/.config/chat-marks', on: vi.fn() },
  ipcMain: { handle: (_name: string, callback: typeof fixture.handle) => { fixture.handle = callback; } }
}));
vi.mock('node-pty', () => ({ spawn: vi.fn(() => fixture.pty) }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  // Upstream binaries "exist" on PATH for the version probe's stat; everything else is real.
  const fake = (file: unknown) => typeof file === 'string' && /^\/usr\/local\/bin\/(opencode|zeroclaw)$/.test(file);
  return { ...real, stat: async (file: string, ...rest: unknown[]) => fake(file) ? { isFile: () => true, size: 1, mtimeMs: 1 } : (real.stat as any)(file, ...rest) };
});
vi.mock('node:child_process', () => {
  const execFile = (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    fixture.commands.push([file, ...args]);
    if (fixture.missingSession && args.includes('has-session')) {
      callback(Object.assign(new Error("can't find session"), { code: 1 }), '', "can't find session");
      return;
    }
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
      else if (args[1] === 'claude') callback(null, '/usr/local/bin/claude\n', '');
      else if (args[1] === 'markscode') callback(null, '/usr/local/bin/markscode\n', '');
      else if (args[1] === 'opencode') callback(null, '/usr/local/bin/opencode\n', '');
      else if (args[1] === 'zeroclaw') callback(null, '/usr/local/bin/zeroclaw\n', '');
      else callback(new Error('missing'), '', '');
    } else if (file === '/usr/bin/env' && args[0] === '-i') {
      // An upstream module's private-HOME version probe.
      fixture.probes.push(args);
      callback(null, args.at(-2)!.endsWith('opencode') ? '1.19.3\n' : 'zeroclaw 0.8.6 (c473221)\n', '');
    } else if (args.includes('display-message')) {
      callback(null, `${fixture.tmuxCreated}\n`, '');
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
vi.mock('../src/main/cli-source-install.js', () => ({ installPublishedCli: vi.fn() }));

import {
  cliAction, cliChatRuntime, cliCreateSession, cliEngineRuntime, cliEngineTerminal, cliEngineTerminalRefresh, cliEngineTerminalState, cliModuleState, cliOpen, cliSessions, cliStatus,
  OPENCODE_ATTACH_SCRIPT, registerCliEngineOpenHook, registerCliEngineRegistration, registerCliModuleIpc, registerCliModuleStopHook
} from '../src/main/cli-modules.js';

beforeEach(() => { fixture.command = true; fixture.project = '/approved/project'; fixture.durable = ['codex']; fixture.blockHasSession = false; fixture.missingSession = false; fixture.resumeHasSession = null; fixture.commands.length = 0; vi.clearAllMocks(); });

describe('Persistent coding CLI terminal', () => {
  it('creates independent durable sessions and reopens each stable tmux identity', async () => {
    try {
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
      if (process.platform === 'win32') {
        expect(pty).toHaveBeenCalledWith('wsl.exe', expect.arrayContaining(['--exec', 'tmux', 'attach-session']), expect.objectContaining({ cwd: '/approved/project', cols: 90, rows: 30 }));
      } else {
        expect(pty).toHaveBeenCalledWith('tmux', expect.arrayContaining(['attach-session', '-t', `=${info.session}`]), expect.objectContaining({ cwd: '/approved/project', cols: 90, rows: 30 }));
      }
      expect(await cliOpen(secondSession.id, 80, 20, 'second')).toMatchObject({ session: secondSession.tmuxSession });
      expect(await cliOpen(firstSession.id, 80, 20, 'third')).toMatchObject({ session: info.session });
      expect(fixture.commands.some(args => args.includes('kill-session'))).toBe(false);
    } finally {
      await cliAction('codex', 'stop');
    }
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

  it('opens an engine chat\'s hand-over terminal with its exact resume arguments, only after the engine lets go', async () => {
    if (process.platform === 'win32') return;
    await cliAction('claude', 'enable');
    const id = '3f2b8c1e-0d4a-4c3b-9e2f-1a2b3c4d5e6f';
    try {
      await expect(cliEngineTerminal('claude', { sessionId: 'session-0001', projectId: null, args: ['--dangerously-skip-permissions', id], title: 'x' })).rejects.toThrow('Invalid terminal arguments');
      const session = await cliEngineTerminal('claude', { sessionId: 'session-0001', projectId: null, args: ['--session-id', id], title: 'Claude Code · Chat' });
      expect(session).toMatchObject({ module: 'claude', engineChat: 'session-0001', args: ['--session-id', id], title: 'Claude Code · Chat' });
      // The same chat reuses its terminal with the new arguments.
      const again = await cliEngineTerminal('claude', { sessionId: 'session-0001', projectId: null, args: ['--resume', id], title: 'ignored' });
      expect(again).toMatchObject({ id: session.id, args: ['--resume', id] });
      expect((await cliSessions()).filter(item => item.engineChat === 'session-0001')).toHaveLength(1);

      fixture.missingSession = true;
      const hook = vi.fn(async (_session: unknown): Promise<void> => { throw new Error('Claude Code is still answering in this chat.'); });
      registerCliEngineOpenHook('claude', hook);
      await expect(cliOpen(session.id, 80, 24, 'engine-busy')).rejects.toThrow('still answering');
      expect(fixture.commands.some(args => args.includes('new-session'))).toBe(false);
      hook.mockImplementation(async () => undefined);
      await cliOpen(session.id, 80, 24, 'engine-open');
      expect(hook).toHaveBeenLastCalledWith(expect.objectContaining({ engineChat: 'session-0001' }));
      const created = fixture.commands.find(args => args.includes('new-session'))!;
      expect(created.slice(created.indexOf('sh'))).toEqual(['sh', '-c', 'exec "$@"', 'marks-cli', '/usr/local/bin/claude', '--resume', id]);
      fixture.missingSession = false;
      expect(await cliEngineTerminalState('session-0001')).toBe('attached');
      expect(await cliEngineTerminalState('session-other')).toBe('none');
    } finally {
      registerCliEngineOpenHook('claude', null);
      await cliAction('claude', 'stop');
      await cliAction('claude', 'disable');
    }
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
  it('attaches a Codex chat\'s live terminal with its exact remote arguments, starting the server first', async () => {
    if (process.platform === 'win32') return;
    expect(await cliEngineRuntime('codex')).toEqual({ ok: true, binary: '/usr/local/bin/codex', windows: false });
    const args = ['resume', 'thread-1', '--remote', 'unix:///home/test/.config/chat-marks/codex/0123.sock'];
    try {
      for (const bad of [['resume', 'thread-1', '--remote', 'ws://evil:1'], ['resume', 'thread-1', '--dangerously-bypass-approvals-and-sandbox', 'unix:///s.sock'], ['--resume', '3f2b8c1e-0d4a-4c3b-9e2f-1a2b3c4d5e6f']]) {
        await expect(cliEngineTerminal('codex', { sessionId: 'chat-session-1', projectId: null, args: bad, title: 'x' })).rejects.toThrow('Invalid terminal arguments');
      }
      const session = await cliEngineTerminal('codex', { sessionId: 'chat-session-1', projectId: null, args, title: 'Codex · My chat' });
      expect(session).toMatchObject({ module: 'codex', projectId: null, cwd: '/home/test', title: 'Codex · My chat', engineChat: 'chat-session-1', args });
      const again = await cliEngineTerminal('codex', { sessionId: 'chat-session-1', projectId: null, args, title: 'other' });
      expect(again.id).toBe(session.id);
      expect((await cliSessions()).filter(row => row.engineChat === 'chat-session-1')).toHaveLength(1);
      fixture.missingSession = true;
      // A live engine needs no hand-over: without a hook it still opens; with one, the hook runs first.
      const hook = vi.fn(async (_session: unknown): Promise<void> => undefined);
      registerCliEngineOpenHook('codex', hook);
      await cliOpen(session.id, 80, 24, 'engine-terminal');
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ engineChat: 'chat-session-1' }));
      expect(fixture.commands.find(command => command.includes('new-session'))).toEqual([
        'tmux', '-L', expect.any(String), 'new-session', '-d', '-s', session.tmuxSession, '-c', '/home/test', 'sh', '-c', 'exec "$@"', 'marks-cli', '/usr/local/bin/codex', ...args
      ]);
    } finally {
      registerCliEngineOpenHook('codex', null);
      fixture.missingSession = false;
    }
  });
  it('attaches an OpenCode chat\'s live terminal through the fixed launcher with only `--dir <cwd> -s <session>`', async () => {
    if (process.platform === 'win32') return;
    const args = ['--dir', '/approved/project', '-s', 'ses_e9fa19daaffebP7AerPiuan5CM'];
    try {
      await cliAction('opencode', 'enable');
      expect(await cliModuleState('opencode')).toEqual({ enabled: true, command: true, binary: '/usr/local/bin/opencode', managed: false });
      for (const bad of [['--dir', '/approved/project', '-s', '--fork'], ['--dir', 'relative', '-s', 'ses_1'], ['--dir', '/a/../b', '-s', 'ses_1'],
        ['-s', 'ses_1', '--dir', '/approved'], ['--dir', '/approved', '-s', 'ses_1', '--password'], ['--dir', '/approved', '-s', 'ses 1'],
        ['-s', 'ses_123', '.'], ['--dir', '/approved\u0000', '-s', 'ses_1']]) {
        await expect(cliEngineTerminal('opencode', { sessionId: 'chat-session-o', projectId: null, args: bad, title: 'x' })).rejects.toThrow('Invalid terminal arguments');
      }
      await expect(cliEngineTerminal('codex', { sessionId: 'chat-session-o', projectId: null, args, title: 'x' })).rejects.toThrow('Invalid terminal arguments');
      const session = await cliEngineTerminal('opencode', { sessionId: 'chat-session-o', projectId: null, args, title: 'OpenCode · My chat' });
      expect(session).toMatchObject({ module: 'opencode', engineChat: 'chat-session-o', args });
      fixture.missingSession = true;
      const hook = vi.fn(async (_session: unknown): Promise<void> => undefined);
      registerCliEngineOpenHook('opencode', hook);
      // Without a running server's registration the terminal is refused before tmux starts.
      await expect(cliOpen(session.id, 80, 24, 'opencode-no-server')).rejects.toThrow('not running');
      expect(fixture.commands.some(command => command.includes('new-session'))).toBe(false);
      registerCliEngineRegistration('opencode', async () => '/home/test/.config/chat-marks/opencode/server');
      await cliOpen(session.id, 80, 24, 'opencode-terminal');
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ engineChat: 'chat-session-o' }));
      // The URL and password are read from the 0600 file when the TUI starts: never in tmux's argv or environment.
      const created = fixture.commands.find(command => command.includes('new-session'))!;
      expect(created).toEqual([
        'tmux', '-L', expect.any(String), 'new-session', '-d', '-s', session.tmuxSession, '-c', '/home/test',
        'sh', '-c', OPENCODE_ATTACH_SCRIPT, 'marks-cli', '/home/test/.config/chat-marks/opencode/server', '/usr/local/bin/opencode', ...args
      ]);
      expect(OPENCODE_ATTACH_SCRIPT).toContain('exec "$b" attach "$u" "$@"');
      expect(created.join(' ')).not.toMatch(/OPENCODE_SERVER_PASSWORD=[^$]|http:\/\//);
      // A terminal older than the running server is ended, so the next open recreates it.
      fixture.missingSession = false;
      fixture.commands.length = 0;
      fixture.tmuxCreated = 1_000;
      await cliEngineTerminalRefresh('chat-session-o', 2_000_000);
      expect(fixture.commands.some(command => command.includes('kill-session'))).toBe(true);
      fixture.commands.length = 0;
      await cliEngineTerminalRefresh('chat-session-o', 500_000);
      expect(fixture.commands.some(command => command.includes('kill-session'))).toBe(false);
    } finally {
      registerCliEngineOpenHook('opencode', null);
      registerCliEngineRegistration('opencode', null);
      fixture.missingSession = false;
      await cliAction('opencode', 'disable');
    }
  });

  it('probes upstream versions with a private HOME and runs ZeroClaw\'s zerocode TUI or its quickstart', async () => {
    if (process.platform === 'win32') return;
    try {
      await cliAction('zeroclaw', 'enable');
      const status = (await cliStatus()).find(item => item.id === 'zeroclaw')!;
      expect(status).toMatchObject({ version: '0.8.6', upstream: true, legacy: false, managed: false });
      // Probed once per binary (cached by path, size and mtime), always under the private folder.
      const probe = fixture.probes.find(item => item.at(-2) === '/usr/local/bin/zeroclaw')!;
      expect(probe.slice(-2)).toEqual(['/usr/local/bin/zeroclaw', '--version']);
      expect(probe).toContain('HOME=/home/test/.config/chat-marks/modules/zeroclaw/.probe');
      expect(probe.some(arg => /markscode|\.zeroclaw/.test(arg))).toBe(false);
      fixture.missingSession = true;
      const terminal = await cliCreateSession('zeroclaw', null);
      await cliOpen(terminal.id, 80, 24, 'zeroclaw-terminal');
      expect(fixture.commands.find(command => command.includes('new-session'))!.slice(-4)).toEqual(['sh', '-c', 'exec "$@"', 'marks-cli', '/usr/local/bin/zerocode'].slice(-4));
      fixture.commands.length = 0;
      const quickstart = await cliCreateSession('zeroclaw', null, 'quickstart');
      expect(quickstart).toMatchObject({ args: ['quickstart'], title: 'ZeroClaw quickstart' });
      await cliOpen(quickstart.id, 80, 24, 'zeroclaw-quickstart');
      expect(fixture.commands.find(command => command.includes('new-session'))!.slice(-3)).toEqual(['marks-cli', '/usr/local/bin/zeroclaw', 'quickstart']);
      await expect(cliCreateSession('codex', null, 'quickstart')).rejects.toThrow('Only ZeroClaw');
      await expect(cliAction('zeroclaw', 'install')).rejects.toThrow('Settings > Modules');
    } finally {
      fixture.missingSession = false;
      await cliAction('zeroclaw', 'disable');
    }
  });

  it('never resolves, probes, installs or opens the retired MarksCode and MarksClaw, but still stops their sessions', async () => {
    if (process.platform === 'win32') return;
    try {
      await cliAction('markscode', 'enable');
      expect(await cliModuleState('markscode')).toEqual({ enabled: true, command: true, binary: null, managed: false });
      fixture.commands.length = 0;
      const status = (await cliStatus()).find(item => item.id === 'markscode')!;
      expect(status).toMatchObject({ legacy: true, installed: false, version: null });
      expect(fixture.commands.some(command => command.join(' ').includes('markscode'))).toBe(false);
      await expect(cliAction('markscode', 'install')).rejects.toThrow('retired');
      await expect(cliAction('marksclaw', 'update')).rejects.toThrow('retired');
      await expect(cliCreateSession('markscode', null)).rejects.toThrow('retired');
      await expect(cliChatRuntime('markscode', null)).rejects.toThrow('not installed');
      await cliAction('markscode', 'stop');
      expect(fixture.commands.some(command => command.includes('list-sessions'))).toBe(true);
    } finally {
      await cliAction('markscode', 'disable');
    }
  });
});
