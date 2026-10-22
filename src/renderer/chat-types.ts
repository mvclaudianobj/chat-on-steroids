/**
 * Chat Marks: every chat shows the icon of its type wherever chats are listed or opened — the
 * sidebar's chat rows (projects, loose chats and the Inbox), its Terminals, the New chat and
 * project menus, and the chat header beside the engine label. This module alone decides which
 * icon a type draws: an engine id added to `AGENT_ENGINE_IDS` does not compile until it has an
 * icon here, and test/chat-types.test.ts checks that each one resolves through dom.ts.
 *
 * The icons are decorative (`icon()` hides them from assistive technology); the chat's title or
 * the engine's name stays the text that labels it.
 */
import type { AgentEngineId } from '../shared/agent-engine.js';
import { isApiConversationId } from '../shared/api-chat.js';
import { icon } from './dom.js';

/** `chatgpt` is a native ChatGPT chat, `api` an API chat whose engine this version cannot read. */
export type ChatType = 'chatgpt' | 'terminal' | 'api' | AgentEngineId;

/**
 * One drawing per engine (icons.css `.cm-glyph-*`): a line drawing, or the project's own simple
 * mark when its licence allows it (OpenCode's MIT `mark.svg`); never a company's brand logo.
 * CLIProxy is the plug its Settings item has always shown (Phosphor `plug`), wherever it appears.
 */
const ENGINE_ICONS: Readonly<Record<AgentEngineId, string>> = {
  cliproxy: 'i-plug',
  opencode: 'i-engine-opencode',
  markscode: 'i-engine-markscode',
  codex: 'i-engine-codex',
  claude: 'i-engine-claude'
};

/** The icon name (dom.ts vocabulary) of a chat type. */
export function chatTypeIcon(type: ChatType): string {
  if (type === 'chatgpt') return 'i-chat-chatgpt';
  if (type === 'terminal') return 'i-terminal';
  if (type === 'api') return 'i-chat';
  return ENGINE_ICONS[type];
}

/**
 * A listed session's type: an API chat by the engine main projected onto its summary, any other
 * chat with a conversation a ChatGPT chat. The unattributed stream (no conversation) is no chat.
 */
export function chatTypeOf(summary: { conversationId: string | null; engine?: AgentEngineId }): ChatType | null {
  if (isApiConversationId(summary.conversationId)) return summary.engine ?? 'api';
  return summary.conversationId ? 'chatgpt' : null;
}

/**
 * A module's own icon in its management entries (the Settings sub-nav item, the Modules card and
 * its page heading): the same drawing its chats and engine use. ZeroClaw (and the retired
 * MarksClaw fork) draw the claw; CLIProxyAPI the plug.
 */
export type ManagedModuleId = 'cliproxy' | 'opencode' | 'codex' | 'claude' | 'zeroclaw' | 'markscode' | 'marksclaw';
export function moduleIcon(id: ManagedModuleId): string {
  if (id === 'zeroclaw' || id === 'marksclaw') return 'i-module-zeroclaw';
  return ENGINE_ICONS[id];
}

/** The decorative icon element of a module's management entry. */
export function moduleMark(id: ManagedModuleId, className = 'module-mark'): HTMLElement {
  const node = icon(moduleIcon(id), `ico chat-type-icon ${className}`);
  node.dataset.module = id;
  return node;
}

/** The decorative icon element of a chat type. */
export function chatTypeMark(type: ChatType, className = ''): HTMLElement {
  const node = icon(chatTypeIcon(type), `ico chat-type-icon${className ? ` ${className}` : ''}`);
  node.dataset.chatType = type;
  return node;
}
