/**
 * Claude Code Router (CCR, a third-party local proxy on 127.0.0.1:3456) as a chat route.
 *
 * CCR configures itself into the user's own CLI files: `~/.claude/settings.json` `env`
 * (`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, …, plus an `apiKeyHelper`) and `~/.codex/config.toml`
 * (`model_provider = "claude-code-router"`, its `[model_providers.claude-code-router]` table and a
 * `model_catalog_json` of its own). Every Codex and Claude Code process then talks to the router,
 * not to the account the CLI is signed in with.
 *
 * A Codex or Claude Code chat therefore has a route (ledger `route`):
 * - `direct` (the default for new chats): the CLI's own account. Only when a router is detected,
 *   the process the app starts gets overrides that neutralize it; the user's files are never
 *   written. Claude Code: a `--settings` layer (above user settings, whose `env` beats the
 *   process environment) that sets the router's variables to "" and `apiKeyHelper` to "", both of
 *   which Claude Code treats as unset (checked against 2.1.306: base URL unset, token source
 *   `none` without a login of its own; `null` is refused and drops the whole layer). Codex: its
 *   built-in `openai` provider (`-c model_provider="openai"`) and, when the router replaced the
 *   model catalog, Codex's own cached catalog of the account (`<CODEX_HOME>/models_cache.json`).
 * - `router`: the CLI exactly as the user configured it (every chat created before routes).
 * Without a detected router both routes are the same process (no override): `effectiveRoute`.
 *
 * Detection reads only these two files (and the existence of CCR's own backup next to
 * settings.json). Windows runs the CLIs inside WSL, whose files are not read here: no router is
 * detected there (untested).
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AgentEngineRoute } from '../../shared/agent-engine.js';

/** Shown as it is (a product name), never translated. */
export const ROUTER_LABEL = 'Claude Code Router';

export interface RouterDetection {
  /** The user's CLI files are set up for the router (CCR configured itself into them). */
  detected: boolean;
  /**
   * Set only when the router is configured but cannot answer now (main/ccr: the program is not
   * installed, or its gateway does not answer). The router route then falls back (`effectiveRoute`).
   */
  unavailable?: RouterUnavailable;
}

/** Why a configured router cannot take a chat now. */
export type RouterUnavailable = 'not_installed' | 'stopped';

/**
 * Whether the router program can take routed chats now: the Claude Code Router module
 * (main/ccr/service.ts) registers its cached answer here (null: installed and answering, or not
 * known yet). Without a registered provider (tests, or before the module loads) nothing changes.
 */
let availability: (() => RouterUnavailable | null) | null = null;
let availabilityRefresh: (() => Promise<void>) | null = null;
export function registerRouterAvailability(read: (() => RouterUnavailable | null) | null, refresh: (() => Promise<void>) | null = null): void {
  availability = read;
  availabilityRefresh = refresh;
}
/** Re-checks the router program (bounded, cached by the module) before a send, status or view. */
export async function refreshRouterAvailability(): Promise<void> {
  try { await availabilityRefresh?.(); } catch { /* the last answer stays */ }
}
function withAvailability<T extends RouterDetection>(detection: T): T {
  if (!detection.detected || !availability) return detection;
  let reason: RouterUnavailable | null = null;
  try { reason = availability(); } catch { reason = null; }
  return reason ? { ...detection, unavailable: reason } : detection;
}

/** The router route can be chosen and used now: configured, installed and answering. */
export const routerUsable = (detection: RouterDetection): boolean => detection.detected && !detection.unavailable;

/**
 * What a chat whose route is `router` is told while the router is configured but unavailable
 * (engine status, the chat view's `routeNotice`). The renderer translates the code.
 */
export const ROUTER_UNAVAILABLE_TEXT: Readonly<Record<RouterUnavailable, string>> = {
  not_installed: 'Claude Code Router is not installed. Install it from Settings > Modules > Claude Code Router.',
  stopped: 'Claude Code Router is not running. Start it from Settings > Modules > Claude Code Router.'
};

/**
 * Busy probes of the engines: whether a turn that runs through the router is answering now, so
 * the module restarts the router (after an update, or a Restart) only when none is.
 */
const routedProbes = new Set<() => boolean>();
export function registerRoutedTurnProbe(probe: () => boolean): () => void {
  routedProbes.add(probe);
  return () => { routedProbes.delete(probe); };
}
export function routedTurnsRunning(): boolean {
  for (const probe of routedProbes) { try { if (probe()) return true; } catch { /* a broken probe is not busy */ } }
  return false;
}

export interface ClaudeRouterDetection extends RouterDetection {
  /** The router's own model, when its settings name one (`ANTHROPIC_MODEL`). */
  model: string | null;
}

export interface CodexRouterDetection extends RouterDetection {
  /** The router's provider id in config.toml. */
  provider: string | null;
  /** Direct-route `-c` overrides (empty when nothing is detected). */
  directOverrides: string[];
}

export interface RoutingEnvironment {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

const realEnvironment = (): RoutingEnvironment => ({ home: os.homedir(), env: process.env, platform: process.platform });

/**
 * Every variable a router (CCR or another proxy setup) puts into Claude Code's environment. The
 * direct route sets each of them to "" in its flag settings, so neither the user's settings `env`
 * nor an inherited variable can send the chat elsewhere; the CLI then uses its own login.
 */
export const CLAUDE_ROUTER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_BASE_URL', 'CLAUDE_AGENT_API_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'
] as const;

/** The flag settings every Claude Code chat process gets: bypass mode can never be entered. */
const CLAUDE_HARDENING = { permissions: { disableBypassPermissionsMode: 'disable' } } as const;

/** The router route (or no router): hardening only; user, project and local settings apply as they are. */
export const CLAUDE_FLAG_SETTINGS = JSON.stringify(CLAUDE_HARDENING);

/** The direct route with a router detected: hardening plus the router's variables and key helper unset. */
export const CLAUDE_DIRECT_SETTINGS = JSON.stringify({
  ...CLAUDE_HARDENING,
  env: Object.fromEntries(CLAUDE_ROUTER_ENV_KEYS.map(key => [key, ''])),
  apiKeyHelper: ''
});

/**
 * Without a usable router both routes run the same process; the chat keeps the route the user
 * chose. A configured router that is not installed or not answering falls back to the direct
 * route (with its overrides, so the CLI does not try the dead router address).
 */
export const effectiveRoute = (route: AgentEngineRoute, detection: RouterDetection): AgentEngineRoute =>
  routerUsable(detection) ? route : 'direct';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Claude Code is routed by CCR when its base URL (settings `env`, else the inherited environment)
 * is a loopback address and CCR left its mark: its port 3456, its `settings.json.ccr-original`
 * backup or a `CCR_` variable. Any other gateway is the user's own setup and is never overridden.
 */
export function detectClaudeRouter(environment: RoutingEnvironment = realEnvironment()): ClaudeRouterDetection {
  const none = { detected: false, model: null };
  if (environment.platform === 'win32') return none;
  const dir = environment.env.CLAUDE_CONFIG_DIR?.trim() || path.join(environment.home, '.claude');
  const settings = readJson(path.join(dir, 'settings.json'));
  const env = isRecord(settings) && isRecord(settings.env) ? settings.env : {};
  const value = (key: string): string | null => {
    const own = env[key];
    if (typeof own === 'string') return own.trim() || null;
    return environment.env[key]?.trim() || null;
  };
  const base = value('ANTHROPIC_BASE_URL') ?? value('ANTHROPIC_API_BASE_URL');
  if (!base) return none;
  let url: URL;
  try { url = new URL(base); } catch { return none; }
  if (!LOOPBACK.has(url.hostname)) return none;
  const marked = url.port === '3456' || existsSync(path.join(dir, 'settings.json.ccr-original'))
    || Object.keys(env).some(key => key.startsWith('CCR_'));
  if (!marked) return none;
  const model = value('ANTHROPIC_MODEL');
  return withAvailability({ detected: true, model: model && model.length <= 200 ? model : null });
}

const CCR_PROVIDER = /claude[-_ ]?code[-_ ]?router/i;

/**
 * Codex is routed by CCR when config.toml's top-level `model_provider` is CCR's provider (by its
 * id, its table's `name`, or CCR's managed-block marker). The direct route then selects Codex's
 * built-in `openai` provider and, when CCR replaced the model catalog, Codex's own cached catalog.
 */
export function detectCodexRouter(environment: RoutingEnvironment = realEnvironment()): CodexRouterDetection {
  const none = { detected: false, provider: null, directOverrides: [] };
  if (environment.platform === 'win32') return none;
  const home = environment.env.CODEX_HOME?.trim() || path.join(environment.home, '.codex');
  let text: string;
  try { text = readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return none; }
  let config: Record<string, unknown>;
  try { config = parseToml(text) as Record<string, unknown>; } catch { return none; }
  const provider = typeof config.model_provider === 'string' ? config.model_provider : null;
  if (!provider || provider === 'openai') return none;
  const table = isRecord(config.model_providers) && isRecord(config.model_providers[provider]) ? config.model_providers[provider] as Record<string, unknown> : {};
  const name = typeof table.name === 'string' ? table.name : '';
  if (!CCR_PROVIDER.test(provider) && !CCR_PROVIDER.test(name) && !/^# BEGIN CCR managed/m.test(text)) return none;
  const overrides = ['model_provider="openai"'];
  const ownCatalog = path.join(home, 'models_cache.json');
  if (typeof config.model_catalog_json === 'string' && existsSync(ownCatalog)) overrides.push(`model_catalog_json=${JSON.stringify(ownCatalog)}`);
  return withAvailability({ detected: true, provider: provider.slice(0, 100), directOverrides: overrides });
}

/** The `-c` values of one route's app-server, after the safe overrides. */
export const codexRouteOverrides = (route: AgentEngineRoute, detection: CodexRouterDetection): string[] =>
  effectiveRoute(route, detection) === 'direct' ? [...detection.directOverrides] : [];

/** The `--settings` layer of one route's Claude Code process. */
export const claudeRouteSettings = (route: AgentEngineRoute, detection: RouterDetection): string =>
  detection.detected && effectiveRoute(route, detection) === 'direct' ? CLAUDE_DIRECT_SETTINGS : CLAUDE_FLAG_SETTINGS;

/**
 * The routes a chat can switch between now, and what it is told: both while the router is usable;
 * none without a configured router (both routes are the same process); with a configured router
 * that is unavailable, only `direct` (so a chat stored on `router` can move away) plus the reason.
 */
export function chatRoutes(stored: AgentEngineRoute, detection: RouterDetection): { routes: AgentEngineRoute[]; routeNotice?: RouterUnavailable } {
  if (routerUsable(detection)) return { routes: ['direct', 'router'] };
  if (!detection.detected || !detection.unavailable) return { routes: [] };
  return stored === 'router' ? { routes: ['direct'], routeNotice: detection.unavailable } : { routes: [] };
}

/**
 * The CCR gateway address the user's CLI files point at (Claude settings' loopback base URL, else
 * Codex's CCR provider `base_url`), read-only; null when neither names a loopback port.
 */
export function routerAddressFromCliFiles(environment: RoutingEnvironment = realEnvironment()): { host: string; port: number } | null {
  if (environment.platform === 'win32') return null;
  const fromUrl = (raw: unknown): { host: string; port: number } | null => {
    if (typeof raw !== 'string') return null;
    try {
      const url = new URL(raw);
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      return LOOPBACK.has(url.hostname) && Number.isInteger(port) && port > 0 && port < 65536 ? { host: url.hostname.replace(/^\[|\]$/g, ''), port } : null;
    } catch { return null; }
  };
  const dir = environment.env.CLAUDE_CONFIG_DIR?.trim() || path.join(environment.home, '.claude');
  const settings = readJson(path.join(dir, 'settings.json'));
  const env = isRecord(settings) && isRecord(settings.env) ? settings.env : {};
  const claude = fromUrl(env.ANTHROPIC_BASE_URL) ?? fromUrl(env.ANTHROPIC_API_BASE_URL);
  if (claude) return claude;
  const home = environment.env.CODEX_HOME?.trim() || path.join(environment.home, '.codex');
  try {
    const config = parseToml(readFileSync(path.join(home, 'config.toml'), 'utf8')) as Record<string, unknown>;
    const providers = isRecord(config.model_providers) ? config.model_providers : {};
    for (const [id, table] of Object.entries(providers)) {
      if (!isRecord(table) || (!CCR_PROVIDER.test(id) && !CCR_PROVIDER.test(String(table.name ?? '')))) continue;
      const found = fromUrl(table.base_url);
      if (found) return found;
    }
  } catch { /* none */ }
  return null;
}
