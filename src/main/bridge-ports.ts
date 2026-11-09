import { BROWSER_BRIDGE_AUTO_PORTS, BROWSER_BRIDGE_FALLBACK_PORTS, BROWSER_BRIDGE_PORTS, type BrowserBridgePort } from '../shared/browser-bridge.js';

/**
 * Auto's order for a `npm run dev` profile (dev-profile.ts): the first fallback range before the
 * primary one, so an installed app started later still gets its usual 8765. The extension scans
 * every Auto port and tells the two apart by their `/hello` instance.
 */
export const DEV_PROFILE_AUTO_PORTS = [
  ...BROWSER_BRIDGE_FALLBACK_PORTS.slice(0, 5), ...BROWSER_BRIDGE_PORTS, ...BROWSER_BRIDGE_FALLBACK_PORTS.slice(5)
] as const;
let devProfileOrder = false;
/** Set once by dev-profile.ts when it moved this process to the dev profile. */
export function preferDevProfileBridgePorts(on = true): void { devProfileOrder = on; }

/** Keep the existing environment/test override, including OS-assigned port 0. */
export function bridgePortSelection(choice: BrowserBridgePort = 'auto', raw = process.env.CLF_BRIDGE_PORTS): {
  candidates: readonly number[]; overridden: boolean;
} {
  const parsed = (raw ?? '').split(',').map(part => Number.parseInt(part.trim(), 10))
    .filter(value => Number.isInteger(value) && value >= 0 && value <= 65535);
  if (parsed.length) return { candidates: parsed, overridden: true };
  if (choice !== 'auto') return { candidates: [choice], overridden: false };
  return { candidates: devProfileOrder ? DEV_PROFILE_AUTO_PORTS : BROWSER_BRIDGE_AUTO_PORTS, overridden: false };
}
