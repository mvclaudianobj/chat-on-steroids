import { effectiveCapabilities, getConfig } from './config.js';
import { getBrainSettings } from './brain/settings.js';
import { generateMarksSystemPrompt, type MarksPromptKind } from '../shared/marks-system-prompt.js';

/** Main owns the live setting/capability snapshot that is frozen into each opening. */
export function currentMarksSystemPrompt(kind: MarksPromptKind, names?: readonly string[]): string {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  const memory = getBrainSettings();
  const tools = names ?? (kind === 'chatgpt' ? [
    ...(memory.chatgptTools && caps.read ? ['memory_search'] : []),
    ...(memory.chatgptTools && caps.edit && !config.readOnly ? ['memory_save'] : []),
    ...(caps.command ? ['vault_use', 'remote_exec'] : []),
    ...(config.multiAgent.enabled ? ['agents'] : [])
  ] : []);
  return generateMarksSystemPrompt({ kind, preferredName: config.ui.marksPreferredName,
    enabled: config.ui.marksSystemPromptEnabled !== false, availableTools: tools });
}
