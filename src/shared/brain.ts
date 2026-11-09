/** Chat Marks: local-first Brain memory contract (H1a). */
import { z } from 'zod';

export const brainProvenanceSchema = z.object({
  source: z.enum(['user', 'chat', 'import']),
  sessionId: z.string().max(120).optional(),
  engine: z.string().max(80).optional(),
  importedFrom: z.object({ source: z.string().max(80), sourceId: z.string().max(200) }).strict().optional()
}).strict();
export const brainSaveSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  title: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  type: z.enum(['episodic', 'semantic', 'procedural']).default('semantic'),
  mode: z.enum(['short_term', 'long_term']).default('long_term'),
  importance: z.number().min(0).max(1).default(0.5),
  scope: z.string().max(150).default('global'),
  provenance: brainProvenanceSchema.default({ source: 'user' })
}).strict();
export type BrainSaveInput = z.input<typeof brainSaveSchema>;
export const brainMemorySchema = brainSaveSchema.extend({
  id: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  deletedAt: z.number().int().nonnegative().optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  remote: z.object({ provider: z.string().max(80), remoteId: z.string().max(200), syncedAt: z.number().int().nonnegative() }).strict().optional()
});
export type BrainMemory = z.infer<typeof brainMemorySchema>;

/** Chat Marks H1b: optional remote recall providers, all off by default. */
export const BRAIN_PROVIDER_IDS = ['aiMemory', 'openviking', 'marksApi'] as const;
export type BrainProviderId = typeof BRAIN_PROVIDER_IDS[number];
const timeoutMs = z.number().int().min(1000).max(30000).default(8000);
export const brainAiMemorySchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().url().max(300).default('https://memory.marks.ia.br/mcp'),
  secret: z.string().max(80).default('brain.ai-memory'),
  project: z.string().max(200).default(''),
  timeoutMs
}).strict();
export const brainOpenVikingSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().url().max(300).default('http://127.0.0.1:1933'),
  secret: z.string().max(80).default('brain.openviking'),
  targetUri: z.string().max(300).default('viking://~/memories'),
  timeoutMs
}).strict();
export const brainMarksApiSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().url().max(300).default('http://api.marks.ia.br:8689'),
  /** The Marks memory API is plain HTTP today; credentials cross the network only after this acknowledgement. */
  insecureHttp: z.boolean().default(false),
  auth: z.enum(['apiKey', 'markspanel', 'both']).default('apiKey'),
  secret: z.string().max(80).default('brain.marks-memories'),
  userId: z.string().max(200).default(''),
  orgId: z.string().max(200).default(''),
  customerId: z.string().max(200).default(''),
  timeoutMs
}).strict();
export const brainProvidersSchema = z.object({
  aiMemory: brainAiMemorySchema.prefault({}),
  openviking: brainOpenVikingSchema.prefault({}),
  marksApi: brainMarksApiSchema.prefault({})
}).strict();
export type BrainProviders = z.infer<typeof brainProvidersSchema>;
export interface BrainProviderStatus {
  id: BrainProviderId | 'local';
  label: string;
  enabled: boolean;
  /** ok | disabled | stopped | needs-key | insecure | unauthorized | error */
  state: 'ok' | 'disabled' | 'stopped' | 'needs-key' | 'insecure' | 'unauthorized' | 'error';
  detail?: string;
  count?: number;
  hasKey?: boolean;
  url?: string;
}
/** One recalled memory, labelled with the source that returned it. */
export interface BrainRecallItem {
  source: BrainProviderId | 'local';
  id: string;
  content: string;
  title?: string;
  score?: number;
  contentHash: string;
}
export interface BrainRecallResult {
  items: BrainRecallItem[];
  errors: Array<{ source: BrainProviderId; error: string }>;
  remote: boolean;
}

export const brainSettingsSchema = z.object({
  chatgptTools: z.boolean().default(false),
  apiChatTools: z.boolean().default(false),
  askBeforeSaving: z.boolean().default(true),
  autoInject: z.boolean().default(false),
  remoteRecall: z.boolean().default(false),
  remoteSync: z.boolean().default(false),
  enginesEnabled: z.boolean().default(false),
  historySearch: z.boolean().default(false),
  providers: brainProvidersSchema.prefault({})
}).strict();
export type BrainSettings = z.infer<typeof brainSettingsSchema>;
