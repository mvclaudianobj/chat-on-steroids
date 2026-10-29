import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mock = vi.hoisted(() => ({
  root: '',
  handler: null as null | ((event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>),
  sender: { isDestroyed: () => false },
  frame: { id: 1 }
}));
vi.mock('electron', () => ({
  app: { getPath: () => mock.root },
  ipcMain: { handle: (_channel: string, handler: typeof mock.handler) => { mock.handler = handler; } }
}));
vi.mock('../src/main/markspanel-auth.js', () => ({ markspanelAccessBlocked: () => false }));
const { registerVmsIpc } = await import('../src/main/vms.js');

describe('VM IPC boundary (synthetic / dry-run only)', () => {
  beforeAll(async () => {
    mock.root = await fs.mkdtemp(path.join(os.tmpdir(), 'marks-vms-ipc-'));
    registerVmsIpc(() => ({
      isDestroyed: () => false,
      webContents: Object.assign(mock.sender, { mainFrame: mock.frame, send: () => undefined })
    } as never));
  });
  afterAll(async () => { await fs.rm(mock.root, { recursive: true, force: true }); });
  const request = async (payload: unknown, authorized = true) => {
    const event = { sender: authorized ? mock.sender : {}, senderFrame: mock.frame };
    return mock.handler!(event, payload);
  };
  it('refuses untrusted windows and arbitrary commands', async () => {
    expect((await request({ action: 'run', name: 'test', op: 'exec' })).ok).toBe(false);
    expect((await request({ action: 'view', command: '/bin/sh' })).ok).toBe(false);
    expect((await request({ action: 'view' }, false)).ok).toBe(false);
  });
  it('validates names, resources, collision and destroy confirmation', async () => {
    expect((await request({ action: 'init', name: '../bad', box: 'bento/ubuntu-24.04', memory: 2048, cpus: 2 })).ok).toBe(false);
    expect((await request({ action: 'init', name: 'demo', box: 'bento/ubuntu-24.04', memory: 2048, cpus: 2 })).ok).toBe(true);
    expect((await request({ action: 'init', name: 'demo', box: 'bento/ubuntu-24.04', memory: 2048, cpus: 2 })).ok).toBe(false);
    expect((await request({ action: 'run', name: 'demo', op: 'destroy', dryRun: true, confirmation: 'wrong' })).ok).toBe(false);
    expect((await request({ action: 'run', name: 'demo', op: 'status', dryRun: true })).ok).toBe(true);
    expect((await request({ action: 'run', name: 'demo', op: 'destroy', dryRun: true, confirmation: 'demo' })).ok).toBe(true);
    expect(await fs.readdir(path.join(mock.root, 'vms', 'demo'))).toContain('Vagrantfile');
  });
  it('rejects modified profiles and symlink templates', async () => {
    const target = path.join(mock.root, 'vms', 'demo', 'site.yml');
    await fs.writeFile(target, 'changed');
    expect((await request({ action: 'run', name: 'demo', op: 'up', dryRun: true })).ok).toBe(false);
  });
});
