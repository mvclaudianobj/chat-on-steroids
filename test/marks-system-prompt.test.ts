import { expect, it } from 'vitest';
import { generateMarksSystemPrompt } from '../src/shared/marks-system-prompt.js';
import { MAX_CHATGPT_MESSAGE_CHARS, prependUserPrompt, userPromptText } from '../src/shared/user-prompt.js';

it('keeps a short Portuguese identity with a neutral default and a configured form of address', () => {
  const prompt = generateMarksSystemPrompt({ kind: 'chatgpt', availableTools: ['agents', 'remote_exec'] });
  expect(prompt).toContain('Você é Marks');
  expect(prompt).toContain('tratamento neutro');
  expect(prompt).toContain('remote_exec');
  expect(prompt).toContain('agents');
  expect(prompt).not.toContain('vault_use');
  expect(prompt).not.toContain('memory_save');
  expect(prompt.split(/\s+/).length).toBeLessThan(350);
  const named = generateMarksSystemPrompt({ kind: 'chatgpt', preferredName: 'Senhor Marcos' });
  expect(named).toContain('"Senhor Marcos"');
  expect(named).not.toContain('tratamento neutro');
  expect(generateMarksSystemPrompt({ kind: 'chatgpt', enabled: false })).toBe('');
});

it('restricts API tools and does not claim CLI native engine tools by name', () => {
  const api = generateMarksSystemPrompt({ kind: 'cliproxy', availableTools: ['read', 'memory_search'] });
  expect(api).toContain('memory_search');
  expect(api).not.toContain('memory_save');
  expect(api).not.toContain('vault_use');
  expect(api).not.toContain('remote_exec');
  expect(api).not.toContain('agents');
  for (const kind of ['claude', 'codex', 'opencode'] as const) {
    const prompt = generateMarksSystemPrompt({ kind });
    expect(prompt).toContain('ferramentas nativas');
    expect(prompt).not.toContain('vault_use');
  }
});

it('fits the native opening framing and preserves resume provenance', () => {
  const prompt = generateMarksSystemPrompt({ kind: 'chatgpt' });
  const content = 'Tarefa original';
  const framed = prependUserPrompt(content, prompt);
  expect(userPromptText(framed)).toBe(content);
  expect(framed.length).toBeLessThan(MAX_CHATGPT_MESSAGE_CHARS);
});
