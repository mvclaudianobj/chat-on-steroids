import { randomBytes } from 'node:crypto';
import { durableRevision, readDurable, writeDurableNow } from './durable.js';
import { logWarn } from './logger.js';

/**
 * Which app profile answers on this bridge, reported by `/hello` as `instance`.
 *
 * An installed app and `npm run dev` (its own profile) can both run, each on one of the Auto
 * ports. The extension scans those ports in order, so without this it attached to whichever
 * answered first, not to the app it was paired with. Random, persisted per profile in
 * `state/bridge-instance.json`; not a secret and says nothing about the person or the machine.
 */
const STATE = 'bridge-instance';
const INSTANCE = /^[0-9a-f]{32}$/;
let cached: { revision: number; value: Promise<string> } | null = null;

export function bridgeInstance(): Promise<string> {
  // A new durable store (another profile, or a test's fresh folder) reads its own file.
  const revision = durableRevision(STATE);
  if (cached && cached.revision === revision) return cached.value;
  const value = (async () => {
    const saved = await readDurable<{ instance?: unknown }>(STATE);
    if (saved && typeof saved.instance === 'string' && INSTANCE.test(saved.instance)) return saved.instance;
    const instance = randomBytes(16).toString('hex');
    // An unwritable profile still answers one stable id for this process.
    await writeDurableNow(STATE, { instance }).catch(err => logWarn(`bridge: could not save its instance id: ${(err as Error).message}`));
    return instance;
  })();
  // Our own write bumps the revision; the next read finds the same id on disk.
  cached = { revision, value };
  void value.then(() => { if (cached?.value === value) cached = { revision: durableRevision(STATE), value }; });
  return value;
}
