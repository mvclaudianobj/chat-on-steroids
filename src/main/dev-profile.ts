import path from 'node:path';
import { app } from 'electron';
import { preferDevProfileBridgePorts } from './bridge-ports.js';

/**
 * `npm run dev` keeps its own profile, so a checkout under test never shares the installed
 * Chat Marks config, sessions, tunnels, connectors or single-instance lock (and both can run).
 * A packaged app, an explicit `--user-data-dir`, or a script that already chose its own folder
 * keeps that choice. The dev profile's bridge also tries 18765-18769 first, leaving the
 * installed app its usual 8765 when both run (bridge-ports.ts).
 */
export const DEV_PROFILE = 'chat-marks-dev';

export function devUserDataDir(input: {
  packaged: boolean;
  explicitSwitch: boolean;
  appData: string;
  current: string;
  name: string;
}): string | null {
  if (input.packaged || input.explicitSwitch) return null;
  if (path.resolve(input.current) !== path.resolve(input.appData, input.name)) return null;
  return path.join(input.appData, DEV_PROFILE);
}

const devDir = devUserDataDir({
  packaged: app.isPackaged,
  explicitSwitch: app.commandLine.hasSwitch('user-data-dir'),
  appData: app.getPath('appData'),
  current: app.getPath('userData'),
  name: app.getName()
});
if (devDir) {
  app.setPath('userData', devDir);
  preferDevProfileBridgePorts();
}
