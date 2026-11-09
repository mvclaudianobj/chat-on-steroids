import { expect, it, vi } from 'vitest';

const written: unknown[] = [];
vi.mock('../src/main/durable.js', () => ({ readDurable: async () => null, writeDurableNow: async (_name: string, value: unknown) => { written.push(value); } }));
vi.mock('../src/main/connection.js', () => ({ refreshPluginPublication: vi.fn() }));
const { getBrainSettings, setBrainSettings } = await import('../src/main/brain/settings.js');

it('changes only the sent settings, one provider field at a time', async () => {
  await setBrainSettings({ apiChatTools: true });
  await setBrainSettings({ askBeforeSaving: false });
  await setBrainSettings({ providers: { marksApi: { enabled: true } } });
  await setBrainSettings({ providers: { marksApi: { insecureHttp: true }, aiMemory: { project: 'chat-marks' } } });
  const settings = getBrainSettings();
  // Zod 4 fills defaults inside partial(); an omitted key must never be reset by a later patch.
  expect(settings).toMatchObject({ apiChatTools: true, askBeforeSaving: false, chatgptTools: false });
  expect(settings.providers.marksApi).toMatchObject({ enabled: true, insecureHttp: true, url: 'http://api.marks.ia.br:8689', auth: 'apiKey' });
  expect(settings.providers.aiMemory).toMatchObject({ enabled: false, project: 'chat-marks', url: 'https://memory.marks.ia.br/mcp' });
  expect(settings.providers.openviking.enabled).toBe(false);
  await expect(setBrainSettings({ providers: { marksApi: { url: 'not a url' } } })).rejects.toThrow();
  await expect(setBrainSettings({ unknown: true })).rejects.toThrow();
  expect(written).toHaveLength(4);
});
