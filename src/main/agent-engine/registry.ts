/**
 * Which engine runs which API chat. IPC `marksApiChat:request` asks here for every chat
 * action: a new chat names its engine (default `cliproxy`), an existing chat is routed by its
 * ledger record. Only an engine whose status is available can create a chat; the reserved
 * engines (MarksCode, Codex) are registered unavailable until their PRs plug in. Claude Code
 * (`claude.ts`) is available once its module, binary and sign-in are.
 */
import { AGENT_ENGINE_IDS, AGENT_ENGINE_LABELS, DEFAULT_AGENT_ENGINE, type AgentEngineId, type AgentEngineInfo, type AgentEngineTerminalMode } from '../../shared/agent-engine.js';
import type { ApiChatView } from '../../shared/api-chat.js';
import { logWarn } from '../logger.js';
import { claudeEngine } from './claude.js';
import { cliProxyEngine } from './cliproxy.js';
import { chatEngine } from './ledger.js';
import type { AgentEngine } from './types.js';

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

const defaults = (): AgentEngine[] => [
  cliProxyEngine,
  reservedEngine('markscode', 'live'),
  reservedEngine('codex', 'live'),
  claudeEngine
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

/** Every registered engine with its status, in the fixed order; a failing status is unavailable. */
export async function listAgentEngines(): Promise<AgentEngineInfo[]> {
  return Promise.all(AGENT_ENGINE_IDS.filter(id => engines.has(id)).map(async id => {
    const engine = engines.get(id)!;
    const status = await engine.status().catch((error: unknown) => ({
      available: false, detail: error instanceof Error ? error.message.slice(0, 200) : 'Status unavailable'
    }));
    return { id, label: engine.label, available: status.available, detail: status.detail.slice(0, 200), terminal: engine.terminalMode };
  }));
}

/** A new chat on that engine; refused while the engine is unavailable. */
export async function createAgentChat(id: AgentEngineId, options: { projectId: string | null; model?: string }): Promise<ApiChatView> {
  const engine = agentEngine(id);
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
