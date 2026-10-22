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
  /** Whether a new chat can be created with it now. Only available engines are offered. */
  available: boolean;
  /** Short, one-line reason or location, e.g. the endpoint or why it is unavailable. */
  detail: string;
  terminal: AgentEngineTerminalMode | null;
}
