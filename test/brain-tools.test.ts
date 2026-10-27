import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import { createRegistrar } from '../src/main/mcp/kernel.js';
import { registerBrainTools } from '../src/main/brain/tools.js';
import { toolSchemaJson } from '../src/main/mcp/tool-declarations.js';
import { getBrainSettings } from '../src/main/brain/settings.js';

vi.mock('../src/main/brain/settings.js', () => ({
  getBrainSettings: vi.fn(() => ({ chatgptTools: false, apiChatTools: false, askBeforeSaving: true }))
}));

function registrar(readOnly = false) {
  const caps = defaultConfig('linux').capabilities;
  return createRegistrar(null, { roots: [], caps, readOnly, privacyScreenshots: false,
    sessionTools: false, agentTools: false }, 'core');
}
describe('Brain model tool admission', () => {
  it('does not advertise tools until the corresponding chat kind is opted in', () => {
    const settings = vi.mocked(getBrainSettings);
    settings.mockReturnValue({ chatgptTools: false, apiChatTools: false, askBeforeSaving: true } as ReturnType<typeof getBrainSettings>);
    const core = registrar(); registerBrainTools(core);
    expect(core.registered()).toEqual([]);
    const api = registrar(); registerBrainTools(api, 'api');
    expect(api.registered()).toEqual([]);
  });
  it('exposes search only in Read-only mode and requires owner for model save', async () => {
    vi.mocked(getBrainSettings).mockReturnValue({ chatgptTools: true, apiChatTools: false, askBeforeSaving: true } as ReturnType<typeof getBrainSettings>);
    const readOnly = registrar(true); registerBrainTools(readOnly);
    expect(readOnly.registered()).toEqual(['memory_search']);
    const writer = registrar(); registerBrainTools(writer);
    expect(writer.registered()).toEqual(['memory_search', 'memory_save']);
    const response = await writer.invokeNested('memory_save', { content: 'A user fact' }, {
      caller: { transportKey: null, requestId: null, conversationId: null }, startedAt: Date.now(),
      transportKey: null, agent: null, outcome: null
    } as never);
    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({ type: 'text' });
  });
  it('maintains a bounded JSON schema for the search contract', () => {
    vi.mocked(getBrainSettings).mockReturnValue({ chatgptTools: true, apiChatTools: false, askBeforeSaving: true } as ReturnType<typeof getBrainSettings>);
    const recorded: Record<string, unknown>[] = [];
    const source = registrar();
    registerBrainTools({ ...source, register(name, config, handler) {
      recorded.push({ name, schema: toolSchemaJson(config.inputSchema) });
      source.register(name, config, handler);
    } });
    expect(recorded.map(row => row.name)).toEqual(['memory_search', 'memory_save']);
    expect(JSON.stringify(recorded)).toContain('maxLength');
  });
});
