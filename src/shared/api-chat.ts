/**
 * Chat Marks API chats: local sessions whose model runs through an OpenAI-compatible endpoint
 * (CLIProxyAPI by default) instead of a ChatGPT tab. A native conversation provider, not a
 * terminal module.
 *
 * Their conversation ids are minted by the app in a namespace no ChatGPT conversation uses, so
 * every ChatGPT-only owner (bridge, extension, Compact & Resume, Goal/Loop) can refuse them by id.
 */
export const API_CONVERSATION_PREFIX = 'cosapi-';
export const DEFAULT_API_CHAT_ENDPOINT = 'http://127.0.0.1:18081/v1';
export const API_CHAT_EFFORTS = ['low', 'medium', 'high'] as const;
export type ApiChatEffort = typeof API_CHAT_EFFORTS[number];
export const MAX_FAVORITE_MODELS = 50;
export const MAX_RECENT_MODELS = 10;

export function isApiConversationId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(API_CONVERSATION_PREFIX);
}

/**
 * What a listed model is for. The listing mixes them (CLIProxyAPI lists gpt-image-* beside
 * gpt-*) and only `chat` models can hold a conversation; the others stay classified, not
 * dropped, for the multimodal steps that come later.
 */
export type ApiModelModality = 'chat' | 'image' | 'audio' | 'embedding' | 'moderation';

export function modelModality(id: string): ApiModelModality {
  const has = (words: string): boolean => new RegExp(`(^|[-_/])(${words})([-_.]|$)`, 'i').test(id);
  if (has('image|dall-e')) return 'image';
  if (has('tts|whisper|transcribe|audio|speech')) return 'audio';
  if (has('embedding|embed')) return 'embedding';
  if (has('moderation')) return 'moderation';
  return 'chat';
}

export function isChatModelId(id: string): boolean {
  return modelModality(id) === 'chat';
}

/** The last real request this app made with a model: a listed model is not proof it answers. */
export interface ApiModelAvailability {
  ok: boolean;
  at: number;
  /** Short, one-line reason when it failed. */
  error?: string;
}

export interface ApiChatModel {
  /** Exactly as the endpoint lists it; never renamed. */
  id: string;
  /** `owned_by` as listed, e.g. "openai" or "anthropic". */
  ownedBy: string | null;
  modality: ApiModelModality;
  favorite: boolean;
  recent: boolean;
  availability: ApiModelAvailability | null;
}

export interface ApiChatSettings {
  endpoint: string;
  /** The model a new API chat starts with; each chat keeps its own afterwards. */
  model: string | null;
  /** Sent as `reasoning_effort`; null leaves the model's default. */
  effort: ApiChatEffort | null;
  favorites: string[];
  /** Most recent first. */
  recents: string[];
}

/** What the renderer may know: never the key, only whether one is stored or needed. */
export interface ApiChatStatus extends ApiChatSettings {
  hasKey: boolean;
  /** Whether the endpoint answered its model list on the last check; null before any check. */
  detected: boolean | null;
  /** True once the endpoint refused a request for lacking a key. */
  keyRequired: boolean;
}

/** One API chat as the renderer sees it: its own model and effort, and whether a turn runs now. */
export interface ApiChatView {
  sessionId: string;
  conversationId: string;
  model: string | null;
  effort: ApiChatEffort | null;
  running: boolean;
}
