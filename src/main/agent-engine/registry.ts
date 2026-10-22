/**
 * Which engine runs which API chat. IPC `marksApiChat:request` asks here for every chat
 * action: a new chat names its engine (default `cliproxy`), an existing chat is routed by its
 * ledger record. Only an engine whose status is available can create a chat. OpenCode
 * (`opencode.ts`) is available while its module is enabled and its upstream binary is in the
 * version gate; Codex (`codex.ts`) and Claude Code (`claude.ts`) once their module, binary,
 * version and sign-in are. MarksCode is retired (`retiredEngine`): its chats stay readable.
 * The list names every engine with its status; New chat offers each enabled one (unavailable ones
 * disabled, with their reason) except the hidden ones.
 */
import { AGENT_ENGINE_IDS, AGENT_ENGINE_LABELS, DEFAULT_AGENT_ENGINE, ROUTED_AGENT_ENGINES, type AgentEngineId, type AgentEngineInfo, type AgentEngineTerminalMode } from '../../shared/agent-engine.js';
import type { ApiChatView } from '../../shared/api-chat.js';
import { logWarn } from '../logger.js';
import { claudeEngine } from './claude.js';
import { cliProxyEngine } from './cliproxy.js';
import { codexEngine } from './codex.js';
import { openCodeEngine } from './opencode.js';
import { chatEngine, storedChatRecord } from './ledger.js';
import { getSession } from '../session/store.js';
import type { AgentEngine, EngineCreateOptions } from './types.js';

/** A known engine that this version cannot run yet: listed unavailable, refuses every action. */
export function reservedEngine(id: AgentEngineId, terminalMode: AgentEngineTerminalMode | null): AgentEngine {
  const label = AGENT_ENGINE_LABELS[id];
  const refuse = (): never => { throw new Error(`${label} chats are not available in this version`); };
  return {
    id, label, terminalMode,
    status: async () => ({ available: false, detail: `${label} chats are not available in this version` }),
    models: async () => refuse(), create: async () => refuse(), view: async () => refuse(), send: async () => refuse(),
    stop: async () => false, approve: async () => refuse(), setChatSettings: async () => refuse(),
    recover: async () => undefined
  };
}

/**
 * An engine whose chats exist but which no longer runs (MarksCode, replaced by upstream OpenCode):
 * never offered for a new chat, its history stays readable (it is in the app's own store), and
 * every action that would run it is refused. It claims no recovery, so `recoverApiChats` closes a
 * turn the last MarksCode run left open as interrupted. Its data folders are never touched.
 */
export function retiredEngine(id: AgentEngineId, replacement: string): AgentEngine {
  const label = AGENT_ENGINE_LABELS[id];
  const detail = `${label} chats are read-only. New chats use ${replacement}.`;
  const refuse = (): never => { throw new Error(detail); };
  return {
    id, label, terminalMode: null,
    status: async () => ({ available: false, detail }),
    models: async () => ({ models: [], total: 0 }),
    create: async () => refuse(),
    async view(sessionId) {
      const session = await getSession(sessionId);
      const chat = await storedChatRecord(sessionId);
      if (!session?.conversationId || chat?.engine !== id) throw new Error('This chat runs on another engine');
      return { sessionId, conversationId: session.conversationId, engine: id, model: chat.model, effort: chat.effort,
        running: false, approval: chat.approval ?? 'ask', pending: null };
    },
    send: async () => refuse(), stop: async () => false, approve: async () => refuse(), setChatSettings: async () => refuse(),
    recover: async () => undefined
  };
}

/**
 * Not offered for new chats and not probed: the retired MarksCode (`retiredEngine` above). Its
 * existing chats keep routing to it, so their history stays readable; `createChat` refuses it.
 */
const HIDDEN_ENGINES: ReadonlySet<AgentEngineId> = new Set<AgentEngineId>(['markscode']);
const hiddenDetail = (id: AgentEngineId): string => `${AGENT_ENGINE_LABELS[id]} chats are read-only. New chats use ${AGENT_ENGINE_LABELS.opencode}.`;

type ModuleEngineId = Exclude<AgentEngineId, 'cliproxy'>;
const cliModuleEnabled = async (id: ModuleEngineId): Promise<boolean> => (await (await import('../cli-modules.js')).cliModuleState(id)).enabled;
let moduleEnabledOf = cliModuleEnabled;

/** Whether the CLI module behind an engine is switched on; CLIProxy has none (its endpoint decides). */
async function moduleEnabled(id: AgentEngineId): Promise<boolean> {
  if (id === 'cliproxy') return false;
  try { return await moduleEnabledOf(id); }
  catch { return false; }
}

/** Tests: which CLI modules are switched on, without cli-modules' durable state. */
export function setAgentEngineModulesForTests(enabled: ((id: ModuleEngineId) => Promise<boolean>) | null): void {
  moduleEnabledOf = enabled ?? cliModuleEnabled;
}

const defaults = (): AgentEngine[] => [
  cliProxyEngine,
  openCodeEngine,
  codexEngine(),
  claudeEngine,
  retiredEngine('markscode', AGENT_ENGINE_LABELS.opencode)
];

const engines = new Map<AgentEngineId, AgentEngine>(defaults().map(engine => [engine.id, engine]));

/** Replaces the engine registered under its id (an engine PR registers its real one here). */
export function registerAgentEngine(engine: AgentEngine): void {
  engines.set(engine.id, engine);
}

export function agentEngine(id: AgentEngineId = DEFAULT_AGENT_ENGINE): AgentEngine {
  const engine = engines.get(id);
  if (!engine) throw new Error('Unknown chat engine');
  return engine;
}

/** The engine of an existing chat, by its ledger record. */
export async function engineForChat(sessionId: string): Promise<AgentEngine> {
  const id = await chatEngine(sessionId);
  if (!id) throw new Error('This chat was created by a newer version of Chat Marks');
  return agentEngine(id);
}

/**
 * Every registered engine with its status, in the fixed order; a failing status is unavailable.
 * A hidden engine is listed (its chats keep their terminal button) without probing its status.
 */
export async function listAgentEngines(): Promise<AgentEngineInfo[]> {
  return Promise.all(AGENT_ENGINE_IDS.filter(id => engines.has(id)).map(async (id): Promise<AgentEngineInfo> => {
    const engine = engines.get(id)!;
    const base = { id, label: engine.label, terminal: engine.terminalMode };
    if (HIDDEN_ENGINES.has(id)) return { ...base, available: false, enabled: false, hidden: true, detail: hiddenDetail(id) };
    const status = await engine.status().catch((error: unknown) => ({
      available: false, detail: error instanceof Error ? error.message.slice(0, 200) : 'Status unavailable'
    }));
    const enabled = status.available || await moduleEnabled(id);
    return { ...base, available: status.available, enabled, hidden: false, detail: status.detail.slice(0, 200),
      ...('router' in status && typeof status.router === 'boolean' ? { router: status.router } : {}) };
  }));
}

/** A new chat on that engine; refused while the engine is unavailable or hidden. */
export async function createAgentChat(id: AgentEngineId, options: EngineCreateOptions): Promise<ApiChatView> {
  const engine = agentEngine(id);
  if (HIDDEN_ENGINES.has(id)) throw new Error(hiddenDetail(id));
  if (options.route && !ROUTED_AGENT_ENGINES.has(id)) throw new Error(`${engine.label} chats have no route`);
  const status = await engine.status();
  if (!status.available) throw new Error(status.detail || `${engine.label} is not available`);
  return engine.create(options);
}

/** Startup: each engine closes what the previous process left open. */
export async function recoverAgentEngines(): Promise<void> {
  for (const engine of engines.values()) {
    await engine.recover().catch(error => logWarn(`${engine.label} chat recovery failed: ${(error as Error).message}`));
  }
}

export function resetAgentEnginesForTests(): void {
  engines.clear();
  for (const engine of defaults()) engines.set(engine.id, engine);
}
