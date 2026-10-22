/** Chat Marks: durable, opt-in Brain settings. */
import { brainSettingsSchema, type BrainSettings } from '../../shared/brain.js';
import { readDurable, writeDurableNow } from '../durable.js';

let settings: BrainSettings = brainSettingsSchema.parse({});
let writes: Promise<unknown> = Promise.resolve();
export function initBrainSettings(_userData: string): void {
  settings = brainSettingsSchema.parse({});
}
/** Read after durable.init, before exposing models or interactive settings. */
export async function loadBrainSettings(): Promise<BrainSettings> {
  const loaded = await readDurable<unknown>('marks-brain-settings', { strict: true });
  settings = brainSettingsSchema.parse(loaded ?? {});
  return getBrainSettings();
}
export function getBrainSettings(): BrainSettings { return { ...settings }; }
export async function setBrainSettings(input: unknown): Promise<BrainSettings> {
  const patch = brainSettingsSchema.partial().strict().parse(input);
  const result = writes.then(async () => {
    const previous = settings;
    const next = brainSettingsSchema.parse({ ...settings, ...patch });
    await writeDurableNow('marks-brain-settings', next);
    settings = next;
    if (next.chatgptTools !== previous.chatgptTools) {
      const { refreshPluginPublication } = await import('../connection.js');
      refreshPluginPublication('core');
    }
    return getBrainSettings();
  });
  writes = result.catch(() => undefined);
  return result;
}
