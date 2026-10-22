/** Chat Marks: durable, opt-in Brain settings. */
import { brainSettingsSchema, type BrainSettings } from '../../shared/brain.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { logInfo } from '../logger.js';

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
/**
 * Zod 4 fills defaults inside `.partial()`, so a parsed patch would reset every omitted setting.
 * Only the keys the caller actually sent are merged; providers merge one level deeper.
 */
function mergePatch(current: BrainSettings, input: unknown): BrainSettings {
  const parsed = brainSettingsSchema.partial().strict().parse(input) as Partial<BrainSettings>;
  const raw = input as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  for (const key of Object.keys(raw)) {
    if (key !== 'providers') { next[key] = (parsed as Record<string, unknown>)[key]; continue; }
    const sent = raw.providers as Record<string, Record<string, unknown>>;
    const providers: Record<string, unknown> = { ...current.providers };
    for (const id of Object.keys(sent ?? {})) {
      const value = (parsed.providers as Record<string, Record<string, unknown>>)[id]!;
      providers[id] = { ...(current.providers as Record<string, Record<string, unknown>>)[id], ...Object.fromEntries(Object.keys(sent[id] ?? {}).map(field => [field, value[field]])) };
    }
    next.providers = providers;
  }
  return brainSettingsSchema.parse(next);
}
export async function setBrainSettings(input: unknown): Promise<BrainSettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Brain settings');
  const raw = input as Record<string, unknown>;
  const result = writes.then(async () => {
    const previous = settings;
    const next = mergePatch(settings, input);
    await writeDurableNow('marks-brain-settings', next);
    settings = next;
    logInfo(`brain: settings changed (${Object.keys(raw).join(', ')})`);
    if (next.chatgptTools !== previous.chatgptTools) {
      const { refreshPluginPublication } = await import('../connection.js');
      refreshPluginPublication('core');
    }
    return getBrainSettings();
  });
  writes = result.catch(() => undefined);
  return result;
}
