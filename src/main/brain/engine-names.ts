/** Chat Marks: the Brain MCP server's names as each engine spells them (H1c); no dependencies. */
export const BRAIN_MCP_SERVER = 'chat-marks-brain';
/** Codex `-c` dotted keys are kept to `[A-Za-z0-9_]`. */
export const BRAIN_CODEX_SERVER = 'chat_marks_brain';
export const BRAIN_MCP_TOOLS = ['memory_search', 'memory_save'] as const;
export type BrainTool = typeof BRAIN_MCP_TOOLS[number];

/**
 * A Brain tool from any engine spelling: Claude `mcp__chat-marks-brain__memory_save` (shown as
 * `chat-marks-brain/memory_save`), Codex `chat_marks_brain/memory_save`, OpenCode `chat-marks-brain_memory_save`.
 */
export function brainToolOf(name: string): BrainTool | null {
  const match = /^(?:mcp__|mcp:)?chat[-_]marks[-_]brain(?:__|\/|_|\.)(memory_search|memory_save)$/.exec(name.trim());
  return match ? match[1] as BrainTool : null;
}
