/** Public catalog metadata only; agent instructions are downloaded only after an explicit import. */
export interface MarksAgencyAgent {
  id: string;
  path: string;
  name: string;
  category: string;
  commit: string;
  /** SHA of the exact source Markdown blob, pinned at the catalog commit. */
  sha: string;
  size: number;
}

export interface MarksAgencyInstalled {
  id: string;
  path: string;
  /** Whether the current catalog has different content from the installed agent. */
  state: 'current' | 'available' | 'modified' | 'legacy' | 'missing';
  installedCommit: string;
  availableCommit: string;
  installedSha: string | null;
  availableSha: string | null;
  reason?: string;
}

export interface MarksAgencyCatalog {
  repository: 'msitarzewski/agency-agents';
  license: 'MIT';
  commit: string;
  agents: MarksAgencyAgent[];
  installed?: MarksAgencyInstalled[];
}
