/** Chat Marks Brain H2: selective search and confirmed import of old MarksCode/OpenCode/MarksClaw history. */
import { z } from 'zod';

export { BRAIN_IMPORT_ACTIONS, type BrainImportAction } from './brain-import-actions.js';

export const stagingIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** A conversation is addressed by where it is (a staged copy or the archive) and its dedupe key. */
export const historyRefSchema = z.union([
  z.object({ stagingId: stagingIdSchema, key: z.string().min(1).max(260) }).strict(),
  z.object({ archive: z.literal(true), key: z.string().min(1).max(260) }).strict()
]);
export type HistoryRef = z.infer<typeof historyRefSchema>;

export interface HistoryHit {
  ref: HistoryRef;
  source: string;
  family: string;
  title: string;
  project: string | null;
  directory: string | null;
  created: number;
  updated: number;
  messages: number;
  hits: number;
  /** Redacted; \u0001 and \u0002 surround a matched term. */
  snippet: string;
  /** Present when the match was in a sub-agent session folded under this conversation. */
  subagentHits?: number;
  archived: boolean;
}
export interface HistorySearchResult { query: string; conversations: number; matches: number; hits: HistoryHit[] }

export interface HistoryTool { name: string; summary: string; output: string }
export interface HistoryMessage { role: string; time: number; text: string; tools: HistoryTool[] }
export interface HistoryConversation {
  ref: HistoryRef;
  key: string;
  source: string;
  family: string;
  sessionId: string;
  parentKey: string | null;
  title: string;
  project: string | null;
  directory: string | null;
  model: string | null;
  created: number;
  updated: number;
  messages: HistoryMessage[];
  /** Messages or characters left out by the per-conversation limits. */
  truncated: boolean;
  /** Sub-agent sessions started from this conversation (staged copies only). */
  children?: Array<{ ref: HistoryRef; title: string }>;
}

export interface StagingSourceView { id: string; family: string; kind: string; status: string; unchanged: boolean | null; sessions: number; bytes: number }
export interface StagingView {
  id: string;
  kind: 'admin' | 'user' | 'unknown';
  createdAt: number;
  complete: boolean;
  bytes: number;
  sources: StagingSourceView[];
  memories: number;
  index: { state: 'none' | 'partial' | 'complete' | 'running'; conversations: number; chunks: number };
}
export interface BrainImportStatus {
  stagingRoot: string;
  stagings: StagingView[];
  archive: { available: boolean; conversations: number; bytes: number };
  running: { stagingId: string; phase: string } | null;
}
export interface BrainImportProgress { jobId: string; stagingId: string; phase: 'copy' | 'verify' | 'index' | 'done' | 'error'; source: string; done: number; total: number }

export interface MemoryPreviewItem { index: number; file: string; content: string; title: string | null; type: string; tags: string[]; duplicate: boolean }
