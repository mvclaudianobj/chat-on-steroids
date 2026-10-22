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
  detected: boolean;
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

/** Without a router both routes run the same process; the chat keeps the route the user chose. */
export const effectiveRoute = (route: AgentEngineRoute, detection: RouterDetection): AgentEngineRoute =>
  detection.detected ? route : 'direct';

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
  return { detected: true, model: model && model.length <= 200 ? model : null };
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
  return { detected: true, provider: provider.slice(0, 100), directOverrides: overrides };
}

/** The `-c` values of one route's app-server, after the safe overrides. */
export const codexRouteOverrides = (route: AgentEngineRoute, detection: CodexRouterDetection): string[] =>
  effectiveRoute(route, detection) === 'direct' ? [...detection.directOverrides] : [];

/** The `--settings` layer of one route's Claude Code process. */
export const claudeRouteSettings = (route: AgentEngineRoute, detection: RouterDetection): string =>
  detection.detected && route === 'direct' ? CLAUDE_DIRECT_SETTINGS : CLAUDE_FLAG_SETTINGS;
