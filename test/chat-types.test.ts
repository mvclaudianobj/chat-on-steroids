import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AGENT_ENGINE_IDS } from '../src/shared/agent-engine.js';
import { chatTypeIcon, chatTypeMark, chatTypeOf, moduleIcon, moduleMark, type ChatType } from '../src/renderer/chat-types.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const vocabulary = new Map([...read('../src/renderer/dom.ts').matchAll(/'(i-[a-z0-9-]+)': '([^']+)'/g)].map(match => [match[1]!, match[2]!]));
const iconsCss = read('../src/renderer/icons.css');

const dom = new JSDOM('<!doctype html><body></body>');
const old = globalThis.document;
beforeAll(() => { Object.assign(globalThis, { document: dom.window.document }); });
afterAll(() => { Object.assign(globalThis, { document: old }); });

/** Engines drawn with their project's own simple mark (licence permitting) instead of a line drawing. */
const PROJECT_MARKS = new Set(['opencode']);
/** Engines drawn with the Phosphor glyph their Settings entry already shows. */
const PHOSPHOR = new Map([['cliproxy', 'plug']]);

it('gives every registered engine its own icon: a Chat Marks line glyph, or its project\'s own simple mark', () => {
  const icons = AGENT_ENGINE_IDS.map(chatTypeIcon);
  expect(new Set(icons).size).toBe(AGENT_ENGINE_IDS.length);
  for (const [index, id] of AGENT_ENGINE_IDS.entries()) {
    const glyph = vocabulary.get(icons[index]!);
    if (PHOSPHOR.has(id)) { expect(glyph, id).toBe(PHOSPHOR.get(id)); continue; }
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

it('draws CLIProxy with the plug everywhere, and every module\'s management entry with its own icon', () => {
  expect(chatTypeIcon('cliproxy')).toBe('i-plug');
  expect(vocabulary.get('i-plug')).toBe('plug');
  // The routing-arrows drawing CLIProxy used before is gone.
  expect(iconsCss).not.toContain('.cm-glyph-route');
  expect([...vocabulary.values()]).not.toContain('cm:route');
  // Settings: the CLIProxyAPI sub-nav item, its card and its page heading show the plug.
  const html = read('../src/renderer/index.html');
  for (const id of ['moduleCliNav', 'cliProxyTitle', 'moduleCliPageTitle']) {
    expect(new RegExp(`id="${id}"[^>]*>\\s*<i class="ico ph ph-plug[^"]*"`).test(html), id).toBe(true);
  }
  // The modules' own entries use the same drawing as their chats; ZeroClaw and MarksClaw the claw.
  expect(moduleIcon('opencode')).toBe(chatTypeIcon('opencode'));
  expect(moduleIcon('codex')).toBe(chatTypeIcon('codex'));
  expect(moduleIcon('claude')).toBe(chatTypeIcon('claude'));
  expect(moduleIcon('markscode')).toBe(chatTypeIcon('markscode'));
  expect(moduleIcon('cliproxy')).toBe('i-plug');
  expect(moduleIcon('zeroclaw')).toBe('i-module-zeroclaw');
  expect(moduleIcon('marksclaw')).toBe('i-module-zeroclaw');
  expect(vocabulary.get('i-module-zeroclaw')).toBe('cm:claw');
  const mark = moduleMark('zeroclaw');
  expect(mark.getAttribute('aria-hidden')).toBe('true');
  expect(mark.className).toContain('cm-glyph-claw');
  expect(mark.dataset.module).toBe('zeroclaw');
});
