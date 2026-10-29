/**
 * Chat Marks agent engines: what runs the model behind one API chat. `cliproxy` is the
 * OpenAI-compatible endpoint (the executor in main/api-chat); the others are coding CLIs that run
 * as backends of the same chat screen (upstream OpenCode, Codex, Claude Code). `markscode` is
 * retired: its chats stay readable, no new one is created and none runs.
 *
 * A chat's engine is fixed when it is created and stored in its ledger record; a record without
 * one is a `cliproxy` chat, which is every chat created before engines existed.
 */
export const AGENT_ENGINE_IDS = ['cliproxy', 'opencode', 'codex', 'claude', 'markscode'] as const;
export type AgentEngineId = typeof AGENT_ENGINE_IDS[number];
export const DEFAULT_AGENT_ENGINE: AgentEngineId = 'cliproxy';

/** Brand names: shown as they are, never translated. */
export const AGENT_ENGINE_LABELS: Readonly<Record<AgentEngineId, string>> = {
  cliproxy: 'CLIProxy',
  opencode: 'OpenCode',
  codex: 'Codex',
  claude: 'Claude Code',
  markscode: 'MarksCode'
};

/**
 * Which way a Codex or Claude Code chat reaches its model (main/agent-engine/router.ts):
 * `direct` uses the CLI's own account, overriding a detected Claude Code Router for the processes
 * the app starts (never the user's files); `router` runs the CLI exactly as configured, through the
 * router when one is set up. New chats are `direct`; a chat stored without a route is `router`
 * (every chat created before routes ran with the user's configuration as it was).
 */
export const AGENT_ENGINE_ROUTES = ['direct', 'router'] as const;
export type AgentEngineRoute = typeof AGENT_ENGINE_ROUTES[number];
export const DEFAULT_AGENT_ENGINE_ROUTE: AgentEngineRoute = 'direct';
/** The engines whose chats have a route. */
export const ROUTED_AGENT_ENGINES: ReadonlySet<AgentEngineId> = new Set<AgentEngineId>(['codex', 'claude']);

export function isAgentEngineId(value: unknown): value is AgentEngineId {
  return typeof value === 'string' && (AGENT_ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * How a chat's backend session can be opened in a terminal: `live` attaches to the same running
 * session (Codex `--remote`, OpenCode `attach`), `handover` stops the app's host first and resumes
 * the session there (Claude Code `--resume`).
 */
export type AgentEngineTerminalMode = 'live' | 'handover';

/** One engine as the renderer may know it: no paths, binaries or secrets. */
export interface AgentEngineInfo {
  id: AgentEngineId;
  label: string;
  /** Whether a new chat can be created with it now. */
  available: boolean;
  /**
   * Whether the user switched its module on (CLIProxy: its endpoint is set). New chat lists every
   * enabled engine; an unavailable one is a disabled item that shows `detail`, so the user sees why.
   */
  enabled: boolean;
  /** Not offered for new chats in this version (MarksCode in 2.1.43.3); its existing chats still work. */
  hidden: boolean;
  /** Short, one-line reason or location, e.g. the endpoint or why it is unavailable. */
  detail: string;
  terminal: AgentEngineTerminalMode | null;
  /** Codex and Claude Code: whether a Claude Code Router is configured for this CLI, installed and answering (the router route is offered). */
  router?: boolean;
}

/**
 * A Claude Code chat's send while its hand-over terminal is attached. The renderer recognises
 * these exact texts and offers "Close the terminal and continue here", which sends again with
 * `takeBackTerminal`; nothing closes the terminal without that action.
 */
export const ENGINE_TERMINAL_OPEN_IN_APP = 'This chat is open in a Claude Code terminal. Close the terminal to continue here.';
export const ENGINE_TERMINAL_OPEN_ELSEWHERE = 'This chat is open in a Claude Code terminal outside the app. Closing it ends that terminal too.';
