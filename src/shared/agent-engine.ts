/**
 * Chat Marks agent engines: what runs the model behind one API chat. `cliproxy` is the
 * OpenAI-compatible endpoint (the executor in main/api-chat); the others are reserved for the
 * coding CLIs that will run as backends of the same chat screen (MarksCode, Codex, Claude Code).
 *
 * A chat's engine is fixed when it is created and stored in its ledger record; a record without
 * one is a `cliproxy` chat, which is every chat created before engines existed.
 */
export const AGENT_ENGINE_IDS = ['cliproxy', 'markscode', 'codex', 'claude'] as const;
export type AgentEngineId = typeof AGENT_ENGINE_IDS[number];
export const DEFAULT_AGENT_ENGINE: AgentEngineId = 'cliproxy';

/** Brand names: shown as they are, never translated. */
export const AGENT_ENGINE_LABELS: Readonly<Record<AgentEngineId, string>> = {
  cliproxy: 'CLIProxy',
  markscode: 'MarksCode',
  codex: 'Codex',
  claude: 'Claude Code'
};

export function isAgentEngineId(value: unknown): value is AgentEngineId {
  return typeof value === 'string' && (AGENT_ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * How a chat's backend session can be opened in a terminal: `live` attaches to the same running
 * session (Codex `--remote`, MarksCode `-s`), `handover` stops the app's host first and resumes
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
}

/**
 * A Claude Code chat's send while its hand-over terminal is attached. The renderer recognises
 * these exact texts and offers "Close the terminal and continue here", which sends again with
 * `takeBackTerminal`; nothing closes the terminal without that action.
 */
export const ENGINE_TERMINAL_OPEN_IN_APP = 'This chat is open in a Claude Code terminal. Close the terminal to continue here.';
export const ENGINE_TERMINAL_OPEN_ELSEWHERE = 'This chat is open in a Claude Code terminal outside the app. Closing it ends that terminal too.';
