/**
 * Chat Marks agent engines: the contract between the API chat screen (IPC `marksApiChat:request`)
 * and whatever runs a chat's model. `cliproxy` wraps the existing executor; MarksCode, Codex and
 * Claude Code implement the same contract later and write their turns through the projector.
 *
 * Invariants every engine keeps:
 * - A chat is an ordinary `createSession` session with a `cosapi-<uuid>` conversation id that
 *   never changes; every ChatGPT-only fence refuses it by that id.
 * - Its record in `marks-api-chat-sessions` (ledger.ts) names the engine and, once known, the
 *   engine's own session id (`backendSessionId`); the turn is opened there before `turn_start`.
 * - Whether a turn runs is process memory, one per chat. Stop is local and exact.
 * - Approvals are minted by the app (approval.ts); the renderer answers only that exact id.
 */
import type { AgentEngineId, AgentEngineTerminalMode } from '../../shared/agent-engine.js';
import type {
  ApiChatApprovalDecision, ApiChatApprovalMode, ApiChatEffort, ApiChatModel, ApiChatView, ApiModelModality
} from '../../shared/api-chat.js';
import type { TurnOutcome } from '../../shared/session.js';

export interface EngineModelQuery {
  query?: string;
  offset?: number;
  limit?: number;
  modality?: ApiModelModality;
  refresh?: boolean;
}

export interface EngineChatSettingsPatch {
  model?: string;
  effort?: ApiChatEffort | null;
  approval?: ApiChatApprovalMode;
}

/** The chat an engine is asked about: the app's ids and the engine's own session, once it has one. */
export interface EngineChatRef {
  sessionId: string;
  conversationId: string;
  backendSessionId: string | null;
  /** The project's canonical folder, when the chat belongs to one. */
  cwd: string | null;
}

/** How to open the chat's backend session in a durable terminal (cli-modules tmux). */
export interface EngineTerminal {
  argv: string[];
  mode: AgentEngineTerminalMode;
}

export interface AgentEngine {
  readonly id: AgentEngineId;
  readonly label: string;
  readonly terminalMode: AgentEngineTerminalMode | null;
  /** Whether a new chat can be created now, with a short reason. Never throws for "not set up". */
  status(): Promise<{ available: boolean; detail: string }>;
  /** This engine's own model list, in the catalog's row shape. */
  models(query: EngineModelQuery): Promise<{ models: ApiChatModel[]; total: number }>;
  create(options: { projectId: string | null; model?: string }): Promise<ApiChatView>;
  view(sessionId: string): Promise<ApiChatView>;
  /** Resolves once the question is recorded; the turn streams on in main. */
  send(sessionId: string, text: string): Promise<{ turnId: string }>;
  /** False when no turn of that chat runs in this process. */
  stop(sessionId: string): Promise<boolean>;
  approve(sessionId: string, approvalId: string, decision: ApiChatApprovalDecision): Promise<ApiChatView>;
  setChatSettings(sessionId: string, patch: EngineChatSettingsPatch): Promise<ApiChatView>;
  /** Startup: close what the previous process left open. Sends wait for it. */
  recover(): Promise<void>;
  /** The terminal that opens this chat's backend session, or null when it has none yet. */
  terminal?(chat: EngineChatRef): EngineTerminal | null;
  /**
   * The one terminal entry point (IPC `terminal`): opens the chat's backend session in its module
   * terminal (cli-modules tmux, one durable session per chat) and answers that terminal's id.
   * A `live` engine (Codex) attaches to the session the app keeps running; a `handover` engine
   * (Claude Code) stops its own process first and refuses while a turn runs.
   */
  openTerminal?(sessionId: string): Promise<{ cliSessionId: string }>;
}

// ---------------------------------------------------------------- CLI engine event stream

/** What a CLI tool did, for its timeline row: icons, tags and the summary wording follow it. */
export type EngineToolKind = 'command' | 'patch' | 'read' | 'mcp' | 'other';

export interface EngineFileChange {
  path: string;
  kind: 'add' | 'update' | 'delete' | 'move';
  /** A unified diff, when the engine reports one: line counts are taken from it. */
  diff?: string;
  movePath?: string;
}

/**
 * The engine-neutral events a CLI engine's adapter (Codex app-server notifications, Claude
 * stream-json lines, MarksCode SSE) translates its own stream into. The projector writes them
 * into the session store in the shapes the API chat already uses.
 */
export type EngineEvent =
  /** More answer text; appended to the current answer step. */
  | { type: 'text_delta'; delta: string }
  /** The current answer step is complete; `text`, when given, is its authoritative whole text. */
  | { type: 'text_final'; text?: string }
  | {
      type: 'tool_started'; toolId: string; kind: EngineToolKind;
      /** The engine's own tool name (`Bash`, `commandExecution`, `server/tool`). */
      name: string;
      input?: unknown; command?: string; cwd?: string; path?: string; files?: EngineFileChange[];
    }
  | { type: 'tool_output'; toolId: string; chunk: string }
  | {
      type: 'tool_finished'; toolId: string; status: 'ok' | 'failed' | 'declined';
      exitCode?: number | null;
      /** The whole output when the engine reports it at the end (Codex `aggregatedOutput`); otherwise the chunks. */
      output?: string;
      files?: EngineFileChange[];
      error?: string;
    }
  | {
      type: 'approval_requested'; requestId: string; toolId?: string; kind: EngineToolKind; tool: string;
      summary: string; files?: string[];
      /** The exact action the user is asked about; the approval is bound to its hash. */
      action: unknown;
    }
  /** The engine settled its own request elsewhere (its TUI, or withdrawn). */
  | { type: 'approval_resolved'; requestId: string }
  /** The turn's token use so far, as totals (a later event replaces an earlier one). */
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'turn_end'; outcome: TurnOutcome; detail?: string };

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}
