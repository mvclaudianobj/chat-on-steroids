/** Chat Marks H2: dependency-free (preload-safe) list of Brain import IPC actions. */
/** Brain IPC actions owned by `main/brain/import/`. The preload allowlist and the main schema share this list. */
export const BRAIN_IMPORT_ACTIONS = [
  'import.status', 'import.adminExport', 'import.adminCommand', 'import.userExport', 'import.index', 'import.cancel',
  'import.deleteStaging', 'import.memory', 'import.archive', 'import.openChat',
  'import.memories.preview', 'import.memories.import',
  'history.search', 'history.read', 'archive.remove'
] as const;
export type BrainImportAction = typeof BRAIN_IMPORT_ACTIONS[number];
