/**
 * Chat Marks Brain H2: `import.*`, `history.*` and `archive.*` actions of `marksBrain:request`.
 * Every import writes only after an explicit `confirmed: true` from the user's own click; there is
 * no bulk import. Long work reports `marksBrain:progress` (throttled to 4 per second).
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { BRAIN_IMPORT_ACTIONS, historyRefSchema, stagingIdSchema, type BrainImportAction, type BrainImportProgress, type BrainImportStatus } from '../../../shared/brain-import.js';
import { brainSave } from '../store.js';
import { manualExportCommand, runAdminExport, type ExportRunner } from './admin-export.js';
import { archiveConversation, archiveStatus, configureArchive, removeArchived } from './archive.js';
import { materializeConversation, type MaterializeDeps } from './materialize.js';
import { importMemories, previewMemories } from './memories.js';
import { readHistory, searchHistory } from './search.js';
import { defaultStagingRoot, userSources, type ImportSource } from './sources.js';
import { deleteStaging, listStagings, readManifest, stagedOutput, stagingPath } from './staging.js';
import { exportUserSources } from './user-export.js';
import { startIndexWorker, type IndexHandle } from './worker.js';
import type { IndexSource } from './indexer.js';

interface Config { stagingRoot: string; archivePath: string; userSources: readonly ImportSource[]; runner?: ExportRunner; materialize?: MaterializeDeps }
let config: Config | null = null;
let job: { id: string; stagingId: string; phase: string; handle?: IndexHandle } | null = null;

export function configureBrainImport(next: Partial<Config> & { archivePath: string }): void {
  config = { stagingRoot: next.stagingRoot ?? defaultStagingRoot(), archivePath: next.archivePath, userSources: next.userSources ?? userSources(),
    ...(next.runner ? { runner: next.runner } : {}), ...(next.materialize ? { materialize: next.materialize } : {}) };
  configureArchive(config.archivePath);
}
async function current(): Promise<Config> {
  if (!config) {
    const { app } = await import('electron');
    configureBrainImport({ archivePath: path.join(app.getPath('userData'), 'brain', 'archive.sqlite') });
  }
  return config!;
}

const confirmed = z.literal(true);
const schemas = {
  empty: z.object({}).strict(),
  confirm: z.object({ confirmed }).strict(),
  staging: z.object({ stagingId: stagingIdSchema }).strict(),
  stagingConfirm: z.object({ stagingId: stagingIdSchema, confirmed }).strict(),
  memory: z.object({ ref: historyRefSchema, content: z.string().trim().min(1).max(4000), title: z.string().max(200).optional(), confirmed }).strict(),
  refConfirm: z.object({ ref: historyRefSchema, confirmed }).strict(),
  ref: z.object({ ref: historyRefSchema }).strict(),
  memories: z.object({ stagingId: stagingIdSchema, indexes: z.array(z.number().int().min(0).max(5000)).min(1).max(5000), confirmed }).strict(),
  search: z.object({ query: z.string().trim().min(1).max(400), limit: z.number().int().min(1).max(200).optional() }).strict(),
  archiveRemove: z.object({ key: z.string().min(1).max(260), confirmed }).strict()
};

function progressSender(send: (event: BrainImportProgress) => void): (event: BrainImportProgress) => void {
  let last = 0;
  return event => {
    const now = Date.now();
    if (event.phase === 'done' || event.phase === 'error' || event.done === event.total || now - last >= 250) { last = now; send(event); }
  };
}

function indexSources(folder: string): IndexSource[] {
  const manifest = readManifest(folder);
  if (!manifest) throw new Error('This staged copy is incomplete');
  const out: IndexSource[] = [];
  for (const source of manifest.sources) {
    if (source.status !== 'copied' || !source.output) continue;
    if (source.kind !== 'opencode-db' && source.kind !== 'marksclaw-db' && source.kind !== 'legacy-json') continue;
    const file = stagedOutput(folder, source.output);
    if (!file) continue;
    out.push({ id: source.id, family: source.family, kind: source.kind, path: file, rel: source.output });
  }
  return out;
}

export async function status(): Promise<BrainImportStatus> {
  const { stagingRoot } = await current();
  const stagings = listStagings(stagingRoot).map(view => job?.stagingId === view.id && job.phase === 'index' ? { ...view, index: { ...view.index, state: 'running' as const } } : view);
  return { stagingRoot, stagings, archive: archiveStatus(), running: job ? { stagingId: job.stagingId, phase: job.phase } : null };
}

export async function handleBrainImport(action: BrainImportAction, payload: unknown, send: (event: BrainImportProgress) => void): Promise<unknown> {
  const settings = await current();
  const root = settings.stagingRoot;
  const progress = progressSender(send);
  switch (action) {
    case 'import.status': schemas.empty.parse(payload ?? {}); return status();
    case 'import.adminCommand': {
      schemas.empty.parse(payload ?? {});
      const { mkdir } = await import('node:fs/promises');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const stagingId = randomUUID();
      return { stagingId, command: manualExportCommand(stagingId) };
    }
    case 'import.adminExport': case 'import.userExport': {
      schemas.confirm.parse(payload);
      if (job) throw new Error('Another import job is running');
      const id = randomUUID();
      job = { id, stagingId: '', phase: 'copy' };
      try {
        const report = (phase: string, source: string): void => progress({ jobId: id, stagingId: '', phase: phase === 'verify' ? 'verify' : 'copy', source, done: 0, total: 0 });
        const result = action === 'import.adminExport'
          ? await runAdminExport(root, report, settings.runner)
          : await exportUserSources(root, settings.userSources, report);
        progress({ jobId: id, stagingId: result.stagingId, phase: 'done', source: '', done: 1, total: 1 });
        return { stagingId: result.stagingId };
      } finally { job = null; }
    }
    case 'import.index': {
      const { stagingId } = schemas.staging.parse(payload);
      if (job) throw new Error('Another import job is running');
      const folder = stagingPath(root, stagingId);
      const sources = indexSources(folder);
      const id = randomUUID();
      const handle = startIndexWorker({ indexPath: path.join(folder, 'index.sqlite'), sources },
        event => progress({ jobId: id, stagingId, phase: 'index', source: event.source, done: event.done, total: event.total }));
      job = { id, stagingId, phase: 'index', handle };
      handle.promise.then(result => {
        progress({ jobId: id, stagingId, phase: 'done', source: result.cancelled ? 'cancelled' : 'complete', done: result.conversations, total: result.conversations });
      }, () => {
        progress({ jobId: id, stagingId, phase: 'error', source: '', done: 0, total: 0 });
      }).finally(() => { if (job?.id === id) job = null; });
      return { jobId: id };
    }
    case 'import.cancel': schemas.empty.parse(payload ?? {}); job?.handle?.cancel(); return !!job?.handle;
    case 'import.deleteStaging': {
      const { stagingId } = schemas.stagingConfirm.parse(payload);
      if (job?.stagingId === stagingId) throw new Error('This staged copy is being indexed');
      await deleteStaging(root, stagingId);
      return true;
    }
    case 'history.search': { const input = schemas.search.parse(payload); return searchHistory(root, input.query, input.limit ?? 50); }
    case 'history.read': return readHistory(root, schemas.ref.parse(payload).ref);
    case 'import.memory': {
      const input = schemas.memory.parse(payload);
      return brainSave({ content: input.content, title: input.title, tags: ['markscode-import'],
        provenance: { source: 'import', importedFrom: { source: 'markscode-history', sourceId: input.ref.key.slice(0, 200) } } });
    }
    case 'import.archive': {
      const { ref } = schemas.refConfirm.parse(payload);
      if ('archive' in ref) return { key: ref.key, added: false };
      return archiveConversation(readHistory(root, ref));
    }
    case 'import.openChat': {
      const { ref } = schemas.refConfirm.parse(payload);
      return materializeConversation(readHistory(root, ref), undefined, settings.materialize);
    }
    case 'import.memories.preview': return previewMemories(stagingPath(root, schemas.staging.parse(payload).stagingId));
    case 'import.memories.import': {
      const input = schemas.memories.parse(payload);
      return importMemories(stagingPath(root, input.stagingId), input.indexes);
    }
    case 'archive.remove': return removeArchived(schemas.archiveRemove.parse(payload).key);
  }
}

/** The `marksBrain:request` hook: own messages are shown, validation and file errors are not. */
export async function runBrainImport(action: BrainImportAction, payload: unknown, send: (event: BrainImportProgress) => void): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try { return { ok: true, data: await handleBrainImport(action, payload, send) }; }
  catch (error) {
    if (error instanceof z.ZodError) return { ok: false, error: 'Brain request failed or input was invalid' };
    if (typeof (error as { code?: unknown }).code === 'string') return { ok: false, error: 'A staged file could not be read or written' };
    return { ok: false, error: String((error as Error).message ?? 'Brain import failed').slice(0, 200) };
  }
}
export const isBrainImportAction = (action: string): action is BrainImportAction => (BRAIN_IMPORT_ACTIONS as readonly string[]).includes(action);
