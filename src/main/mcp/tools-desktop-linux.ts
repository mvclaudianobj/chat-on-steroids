/** Linux has Electron's text clipboard, without a native mouse/keyboard backend. */
import { clipboard } from 'electron';
import { z } from 'zod';
import { fail, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

const MAX_READ_CHARS = 64_000;
const MAX_WRITE_CHARS = 100_000;

export function registerLinuxClipboardTools(reg: SurfaceRegistrar): void {
  if (reg.exposedCaps.clipboardRead) {
    reg.register('read_clipboard', toolDeclaration('read_clipboard', () => ({
      description: 'Read this computer’s clipboard text.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    })), () => reg.guarded('clipboardRead', 'read_clipboard', async () => {
      let value: string;
      try { value = await clipboard.readText(); }
      catch { return fail('CLIPBOARD_UNAVAILABLE: Linux clipboard text could not be read.'); }
      if (value.length > MAX_READ_CHARS) return fail('CLIPBOARD_TOO_LARGE: clipboard text exceeds the response limit.');
      // The recorder redacts both text content and structured value for read_clipboard.
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { value } };
    }));
  }

  if (reg.exposedCaps.clipboardWrite) {
    reg.register('write_clipboard', toolDeclaration('write_clipboard', () => ({
      description: 'Replace this computer’s clipboard text.',
      inputSchema: z.object({ text: z.string().max(MAX_WRITE_CHARS) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    })), ({ text }) => reg.guarded('clipboardWrite', 'write_clipboard', async () => {
      try { await clipboard.writeText(text); }
      catch { return fail('CLIPBOARD_UNAVAILABLE: Linux clipboard text could not be replaced.'); }
      return { content: [{ type: 'text', text: 'Clipboard text replaced.' }], structuredContent: { value: null } };
    }));
  }
}
