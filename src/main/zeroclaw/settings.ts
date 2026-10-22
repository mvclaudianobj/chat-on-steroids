/**
 * Chat Marks: read-only key facts of the user's ZeroClaw setup for its Settings page (agent
 * aliases, each one's model provider and memory, the runtime, the gateway address and the cost
 * limits). ZeroClaw is an autonomous agent the user configures (`zeroclaw quickstart`), not a
 * chat or terminal type; this page grows with settings over time.
 *
 * Only ZeroClaw itself reads its folder (`~/.zeroclaw`, shared with the retired MarksClaw fork):
 * the app runs `zeroclaw agents list` and `zeroclaw config get --json <path>` for a fixed list of
 * non-secret paths. Checked against 0.8.6: those commands write a default `config.toml` (and
 * `data/`, `shared/`) when none exists, so nothing runs until ZeroClaw has been configured
 * (`~/.zeroclaw/config.toml` exists); the page then says "Not configured yet". No secret path is
 * ever read (the list is fixed; secrets live in their own `🔒` fields).
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ZeroClawFacts } from '../../shared/upstream-module.js';

const run = promisify(execFile);
/** ZeroClaw's agent alias rule (`agents create`: lowercase alphanumeric + single underscore). */
const ALIAS = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const MAX_AGENTS = 8;

export interface ZeroClawHost {
  /** The binary the module uses, or null when it is not installed or not enabled. */
  binary(): Promise<{ binary: string; windows: boolean } | null>;
  /** Whether ZeroClaw has a configuration (its own `~/.zeroclaw/config.toml`). */
  configured(windows: boolean): Promise<boolean>;
  run(binary: string, args: string[], windows: boolean): Promise<string>;
}

const defaultHost: ZeroClawHost = {
  async binary() {
    const { cliModuleState } = await import('../cli-modules.js');
    const state = await cliModuleState('zeroclaw');
    return state.enabled && state.command && state.binary ? { binary: state.binary, windows: process.platform === 'win32' } : null;
  },
  async configured(windows) {
    if (windows) return run('wsl.exe', ['--exec', 'sh', '-c', 'test -f "$HOME/.zeroclaw/config.toml"'], { timeout: 8_000 }).then(() => true, () => false);
    return access(path.join(os.homedir(), '.zeroclaw', 'config.toml')).then(() => true, () => false);
  },
  async run(binary, args, windows) {
    const env: NodeJS.ProcessEnv = { ...process.env, LANG: 'C', NO_COLOR: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = windows
      ? await run('wsl.exe', ['--exec', binary, ...args], { timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true })
      : await run(binary, args, { env, timeout: 15_000, maxBuffer: 256 * 1024 });
    return String(stdout);
  }
};

let host: ZeroClawHost = defaultHost;
export function setZeroClawHostForTests(next: Partial<ZeroClawHost> | null): void {
  host = next ? { ...defaultHost, ...next } : defaultHost;
}

/** `zeroclaw agents list`: one alias per line, `(no entries under agents)` when empty. */
export function parseAgentList(output: string): string[] {
  return output.split(/\r?\n/).map(line => line.trim()).filter(line => ALIAS.test(line)).slice(0, MAX_AGENTS);
}

/** `config get --json <path>` → `{ path, value }` (or `{ code: 'path_not_found' }`): the value as text, bounded. */
export function parseConfigValue(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { value?: unknown };
    if (typeof parsed.value === 'string') return parsed.value.slice(0, 200);
    if (typeof parsed.value === 'number' || typeof parsed.value === 'boolean') return String(parsed.value);
    return null;
  } catch { return null; }
}

/** The fixed, non-secret paths this page shows (per agent and global). */
export const AGENT_PATHS = (alias: string) => ({ provider: `agents.${alias}.model_provider`, memory: `agents.${alias}.memory.backend`, enabled: `agents.${alias}.enabled` });
export const GLOBAL_PATHS = {
  runtime: 'runtime.kind', gatewayHost: 'gateway.host', gatewayPort: 'gateway.port', daily: 'cost.daily_limit_usd', monthly: 'cost.monthly_limit_usd'
} as const;

export async function zeroclawFacts(): Promise<ZeroClawFacts> {
  const resolved = await host.binary();
  if (!resolved) return { configured: false, agents: [], runtime: null, gateway: null, dailyLimitUsd: null, monthlyLimitUsd: null, error: 'not_installed' };
  if (!(await host.configured(resolved.windows))) {
    return { configured: false, agents: [], runtime: null, gateway: null, dailyLimitUsd: null, monthlyLimitUsd: null };
  }
  const get = async (key: string): Promise<string | null> =>
    parseConfigValue(await host.run(resolved.binary, ['config', 'get', '--json', key], resolved.windows).catch(() => ''));
  try {
    const aliases = parseAgentList(await host.run(resolved.binary, ['agents', 'list'], resolved.windows));
    const agents = [];
    for (const alias of aliases) {
      const paths = AGENT_PATHS(alias);
      const [provider, memory, enabled] = [await get(paths.provider), await get(paths.memory), await get(paths.enabled)];
      agents.push({ alias, provider: provider || null, memory, enabled: enabled === null ? null : enabled === 'true' });
    }
    const [runtime, gatewayHost, gatewayPort, daily, monthly] = [
      await get(GLOBAL_PATHS.runtime), await get(GLOBAL_PATHS.gatewayHost), await get(GLOBAL_PATHS.gatewayPort), await get(GLOBAL_PATHS.daily), await get(GLOBAL_PATHS.monthly)
    ];
    const number = (value: string | null): number | null => value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
    return {
      configured: true, agents, runtime, gateway: gatewayHost && gatewayPort ? `${gatewayHost}:${gatewayPort}` : null,
      dailyLimitUsd: number(daily), monthlyLimitUsd: number(monthly)
    };
  } catch {
    return { configured: true, agents: [], runtime: null, gateway: null, dailyLimitUsd: null, monthlyLimitUsd: null, error: 'read_failed' };
  }
}
