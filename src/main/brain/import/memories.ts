/**
 * Chat Marks Brain H2: the MarksCode Hybrid/Memvid memory files (`hybrid.jsonl`,
 * `hybrid.markscode-memvid.jsonl`) from a staged copy. Preview first; only the items the user
 * ticked are saved, through the normal Brain save with `provenance.source = 'import'`.
 * Dedupe: Brain's content hash, plus (source file, source_id) of earlier imports.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrainSaveInput } from '../../../shared/brain.js';
import type { MemoryPreviewItem } from '../../../shared/brain-import.js';
import { brainList, brainSave } from '../store.js';
import { MEMORY_FILES } from './sources.js';
import { redact } from './reader.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 5000;

/** The same normalization as `store.ts`; a test keeps them equal. */
export const memoryContentHash = (content: string): string =>
  createHash('sha256').update(content.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()).digest('hex');

interface Candidate { index: number; file: string; sourceId: string; save: BrainSaveInput }

function candidates(folder: string): Candidate[] {
  const out: Candidate[] = [];
  for (const name of MEMORY_FILES) {
    const file = path.join(folder, 'memory', name);
    let text: string;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      text = readFileSync(file, 'utf8');
    } catch { continue; }
    text.split('\n').forEach((line, number) => {
      if (!line.trim() || out.length >= MAX_ITEMS) return;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (!row || typeof row !== 'object' || typeof row.content !== 'string' || !row.content.trim()) return;
      const content = redact(row.content).trim().slice(0, 4000);
      const title = typeof row.title === 'string' ? row.title : typeof row.subject === 'string' ? row.subject : undefined;
      const tags = Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()).map(tag => tag.trim().slice(0, 60)).slice(0, 11) : [];
      const sourceId = typeof row.source_id === 'string' && row.source_id ? row.source_id.slice(0, 160) : typeof row.id === 'string' ? row.id.slice(0, 160) : `line:${number + 1}`;
      out.push({ index: out.length, file: name, sourceId, save: {
        content, title: title ? redact(title).slice(0, 200) : undefined,
        subject: typeof row.subject === 'string' ? redact(row.subject).slice(0, 200) : undefined,
        tags: [...tags, 'markscode-import'],
        type: row.type === 'episodic' || row.type === 'procedural' ? row.type : 'semantic',
        mode: row.memory_mode === 'short_term' ? 'short_term' : 'long_term',
        importance: typeof row.importance === 'number' && row.importance >= 0 && row.importance <= 1 ? row.importance : 0.5,
        provenance: { source: 'import', importedFrom: { source: `markscode:${name}`, sourceId } }
      } });
    });
  }
  return out;
}

async function known(): Promise<{ hashes: Set<string>; imported: Set<string> }> {
  const memories = await brainList(10000);
  return {
    hashes: new Set(memories.map(memory => memory.contentHash)),
    imported: new Set(memories.flatMap(memory => memory.provenance.importedFrom ? [`${memory.provenance.importedFrom.source}\u0000${memory.provenance.importedFrom.sourceId}`] : []))
  };
}

export async function previewMemories(folder: string): Promise<MemoryPreviewItem[]> {
  const seen = await known();
  return candidates(folder).map(item => ({
    index: item.index, file: item.file, content: item.save.content, title: item.save.title ?? null, type: item.save.type ?? 'semantic',
    tags: item.save.tags ?? [],
    duplicate: seen.hashes.has(memoryContentHash(item.save.content)) || seen.imported.has(`markscode:${item.file}\u0000${item.sourceId}`)
  }));
}

/** Saves exactly the selected preview items; duplicates are skipped, never saved twice. */
export async function importMemories(folder: string, indexes: readonly number[]): Promise<{ saved: number; skipped: number }> {
  const wanted = new Set(indexes);
  const seen = await known();
  let saved = 0, skipped = 0;
  for (const item of candidates(folder)) {
    if (!wanted.has(item.index)) continue;
    const pair = `markscode:${item.file}\u0000${item.sourceId}`;
    if (seen.hashes.has(memoryContentHash(item.save.content)) || seen.imported.has(pair)) { skipped++; continue; }
    const memory = await brainSave(item.save);
    seen.hashes.add(memory.contentHash); seen.imported.add(pair);
    saved++;
  }
  return { saved, skipped };
}
