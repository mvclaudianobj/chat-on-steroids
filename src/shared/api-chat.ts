/**
 * Chat Marks API chats: local sessions whose model runs through an OpenAI-compatible endpoint
 * (CLIProxyAPI by default) instead of a ChatGPT tab.
 *
 * Their conversation ids are minted by the app in a namespace no ChatGPT conversation uses, so
 * every ChatGPT-only owner (bridge, extension, Compact & Resume, Goal/Loop) can refuse them by id.
 */
export const API_CONVERSATION_PREFIX = 'cosapi-';
export const DEFAULT_API_CHAT_ENDPOINT = 'http://127.0.0.1:18081/v1';
export const API_CHAT_EFFORTS = ['low', 'medium', 'high'] as const;
export type ApiChatEffort = typeof API_CHAT_EFFORTS[number];

export function isApiConversationId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(API_CONVERSATION_PREFIX);
}

export interface ApiChatModel {
  id: string;
  /** `owned_by` as the endpoint lists it, e.g. "openai" or "anthropic". */
  ownedBy: string | null;
}

export interface ApiChatSettings {
  endpoint: string;
  /** The model a new API chat starts with; each chat keeps its own afterwards. */
  model: string | null;
  /** Sent as `reasoning_effort`; null leaves the model's default. */
  effort: ApiChatEffort | null;
}

/** What the renderer may know: never the key, only whether one is stored. */
export interface ApiChatStatus extends ApiChatSettings {
  hasKey: boolean;
}

/**
 * Models that cannot hold a tool-calling chat: image, audio and embedding endpoints share the
 * listing with chat models (CLIProxyAPI lists gpt-image-* beside gpt-*).
 */
export function isChatModelId(id: string): boolean {
  return !/(^|[-_/])(image|dall-e|tts|whisper|transcribe|embedding|embed|moderation)([-_.]|$)/i.test(id);
}
