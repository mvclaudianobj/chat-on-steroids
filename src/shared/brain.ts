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

export const brainSettingsSchema = z.object({
  chatgptTools: z.boolean().default(false),
  apiChatTools: z.boolean().default(false),
  askBeforeSaving: z.boolean().default(true),
  autoInject: z.boolean().default(false),
  remoteRecall: z.boolean().default(false),
  remoteSync: z.boolean().default(false),
  enginesEnabled: z.boolean().default(false),
  historySearch: z.boolean().default(false)
}).strict();
export type BrainSettings = z.infer<typeof brainSettingsSchema>;
