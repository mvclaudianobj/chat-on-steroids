import { beforeEach, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/shared/types.js';

const electronClipboard = vi.hoisted(() => ({ readText: vi.fn(), writeText: vi.fn() }));
vi.mock('electron', () => ({ clipboard: electronClipboard }));
import { registerLinuxClipboardTools } from '../src/main/mcp/tools-desktop-linux.js';

function surface(exposed: Partial<Capabilities> = { clipboardRead: true, clipboardWrite: true }) {
  const caps = { clipboardRead: true, clipboardWrite: true, ...exposed } as Capabilities;
  const tools = new Map<string, { schema: any; call: (args: any) => Promise<any> }>();
  registerLinuxClipboardTools({ caps, exposedCaps: { ...caps }, register: (name: string, config: any, call: any) => {
    tools.set(name, { schema: config.inputSchema, call });
  }, guarded: async (cap: keyof Capabilities, _name: string, fn: () => Promise<any>) =>
    caps[cap] ? fn() : { isError: true, content: [{ type: 'text', text: 'TOOL_DISABLED' }] } } as never);
  return { caps, names: [...tools.keys()], call: (name: string, args: unknown) => {
    const tool = tools.get(name)!;
    return tool.call(tool.schema.parse(args));
  } };
}

beforeEach(() => { vi.resetAllMocks(); electronClipboard.readText.mockReturnValue('fixture'); });

it('reads and writes text with the same independent permissions as Windows', async () => {
  const api = surface();
  expect(api.names).toEqual(['read_clipboard', 'write_clipboard']);
  expect(await api.call('read_clipboard', {})).toMatchObject({ structuredContent: { value: 'fixture' } });
  expect(await api.call('write_clipboard', { text: 'line 1\nline 2' })).toMatchObject({ structuredContent: { value: null } });
  expect(electronClipboard.writeText).toHaveBeenCalledWith('line 1\nline 2');
  api.caps.clipboardRead = false;
  expect(await api.call('read_clipboard', {})).toMatchObject({ isError: true });
  expect(electronClipboard.readText).toHaveBeenCalledTimes(1);
  api.caps.clipboardWrite = false;
  expect(await api.call('write_clipboard', { text: 'blocked' })).toMatchObject({ isError: true });
  expect(electronClipboard.writeText).toHaveBeenCalledTimes(1);
});

it('bounds reads and writes and never echoes the replacement text', async () => {
  const api = surface();
  electronClipboard.readText.mockReturnValue('s'.repeat(64_001));
  expect(await api.call('read_clipboard', {})).toMatchObject({ isError: true });
  expect(() => api.call('write_clipboard', { text: 'x'.repeat(100_001) })).toThrow();
  expect(electronClipboard.writeText).not.toHaveBeenCalled();
  const result = await api.call('write_clipboard', { text: 'private fixture text' });
  expect(JSON.stringify(result)).not.toContain('private fixture text');
});
