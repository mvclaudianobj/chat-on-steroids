import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AGENT_ENGINE_IDS } from '../src/shared/agent-engine.js';
import { chatTypeIcon, chatTypeMark, chatTypeOf, type ChatType } from '../src/renderer/chat-types.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const vocabulary = new Map([...read('../src/renderer/dom.ts').matchAll(/'(i-[a-z0-9-]+)': '([^']+)'/g)].map(match => [match[1]!, match[2]!]));
const iconsCss = read('../src/renderer/icons.css');

const dom = new JSDOM('<!doctype html><body></body>');
const old = globalThis.document;
beforeAll(() => { Object.assign(globalThis, { document: dom.window.document }); });
afterAll(() => { Object.assign(globalThis, { document: old }); });

/** Engines drawn with their project's own simple mark (licence permitting) instead of a line drawing. */
const PROJECT_MARKS = new Set(['opencode']);

it('gives every registered engine its own icon: a Chat Marks line glyph, or its project\'s own simple mark', () => {
  const icons = AGENT_ENGINE_IDS.map(chatTypeIcon);
  expect(new Set(icons).size).toBe(AGENT_ENGINE_IDS.length);
  for (const [index, id] of AGENT_ENGINE_IDS.entries()) {
    const glyph = vocabulary.get(icons[index]!);
    expect(glyph, id).toMatch(/^cm:[a-z]+$/);
    // A line drawing in the shared stroke, painted through a mask in currentColor (no fixed colour).
    const rule = new RegExp(String.raw`\.cm-glyph-${glyph!.slice(3)} \{[^}]*mask-image: url\("data:image/svg\+xml,([^"]+)"\)`).exec(iconsCss);
    expect(rule, id).not.toBeNull();
    // Painted through a mask in currentColor either way: no fixed colour in the artwork.
    expect(rule![1]).not.toMatch(/fill='#|stroke='#|fill='(?:white|red)/);
    if (PROJECT_MARKS.has(id)) continue;
    expect(rule![1]).toContain("stroke-width='16'");
    expect(rule![1]).toContain("fill='none'");
  }
  // OpenCode's MIT `packages/identity/mark.svg`: the frame and its 40% inner square.
  expect(iconsCss).toContain("d='M384 416H128V96H384V416ZM320 160H192V352H320V160Z'");
});

it('draws ChatGPT chats with the app\'s fox, terminals with the terminal glyph, and an unreadable engine as a chat', () => {
  expect(vocabulary.get(chatTypeIcon('chatgpt'))).toBe('cm:fox');
  expect(iconsCss).toMatch(/\.cm-glyph-fox \{[^}]*mask-image: url\('\.\/browser-icons\/cos\.png'\)/);
  expect(chatTypeIcon('terminal')).toBe('i-terminal');
  expect(chatTypeIcon('api')).toBe('i-chat');
  const all: ChatType[] = ['chatgpt', 'terminal', 'api', ...AGENT_ENGINE_IDS];
  expect(new Set(all.map(chatTypeIcon)).size).toBe(all.length);
  for (const type of all) expect(vocabulary.has(chatTypeIcon(type)), type).toBe(true);
});

it('reads a listed chat\'s type from its conversation and projected engine', () => {
  expect(chatTypeOf({ conversationId: '6a1f0c2e-0000-4000-8000-000000000001' })).toBe('chatgpt');
  expect(chatTypeOf({ conversationId: 'cosapi-1', engine: 'claude' })).toBe('claude');
  expect(chatTypeOf({ conversationId: 'cosapi-1', engine: 'codex' })).toBe('codex');
  expect(chatTypeOf({ conversationId: 'cosapi-1' })).toBe('api');
  expect(chatTypeOf({ conversationId: null })).toBeNull();
});

it('marks the icon decorative, so the chat\'s title or engine name stays its label', () => {
  const mark = chatTypeMark('codex', 'sess-type');
  expect(mark.getAttribute('aria-hidden')).toBe('true');
  expect(mark.textContent).toBe('');
  expect(mark.dataset.chatType).toBe('codex');
  expect(mark.className).toBe('ico chat-type-icon sess-type cm-glyph cm-glyph-codex');
});
