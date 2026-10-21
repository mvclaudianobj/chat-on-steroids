import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM build script without type declarations
import { extensionStamp, STAMP_FILE } from '../scripts/write-extension-stamp.mjs';

/**
 * Marks contracts a community merge can undo without any upstream test noticing. Each one comes
 * from a regression that reached a Marks build; see the marks-community-merge skill.
 */
const root = path.join(__dirname, '..');

describe('extension build stamp', () => {
  // 2026-10-20: the merge changed extension/ and nothing rewrote the ignored stamp, so the app run
  // from the checkout called its own extension outdated and refused its work (stale_extension_build).
  it('is rewritten by every command that runs or bundles the app', () => {
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const name of ['dev', 'build']) expect(scripts[name], name).toMatch(/^node scripts\/write-extension-stamp\.mjs && /);
    expect(readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8')).toContain("'scripts/write-extension-stamp.mjs'");
  });

  it('matches the extension folder whenever a checkout holds one', () => {
    const file = path.join(root, 'extension', STAMP_FILE);
    if (!existsSync(file)) return;
    expect(readFileSync(file, 'utf8').trim(), 'run: node scripts/write-extension-stamp.mjs').toBe(extensionStamp(path.join(root, 'extension')));
  });
});

describe('Chat Marks brand', () => {
  // The fork renames connectors to "Chat Marks …" (src/shared/connector-names.ts), so UI text that
  // names "Chat On Steroids" sends people looking for plugins that do not exist. Older strings are
  // listed until rebranded; a merge may only shrink the list, never add to it.
  it('lets no new community UI string name the upstream brand', () => {
    const baselineFile = path.join(root, 'test', 'fixtures', 'marks-legacy-brand-strings.json');
    const baseline = new Set(JSON.parse(readFileSync(baselineFile, 'utf8')) as string[]);
    const found = new Set<string>();
    const dir = path.join(root, 'src', 'renderer', 'locales');
    for (const file of readdirSync(dir)) {
      for (const key of Object.keys(JSON.parse(readFileSync(path.join(dir, file), 'utf8')))) {
        if (key.includes('Chat On Steroids')) found.add(key);
      }
    }
    expect([...found].filter(key => !baseline.has(key)), 'new UI text: say "Chat Marks" and translate it').toEqual([]);
    expect([...baseline].filter(key => !found.has(key)), 'rebranded: remove these from the baseline file').toEqual([]);
  });
});

describe('Chat Marks API chat fences', () => {
  // An API chat is a real session whose `cosapi-` id has no ChatGPT tab. A merge that rewrites these
  // upstream owners must keep refusing that id, or Stop/Goal/Compact would drive a page that does
  // not exist. The outbox and Goal setters are covered by test/api-chat-executor.test.ts.
  const source = (file: string) => readFileSync(path.join(root, 'src', 'main', file), 'utf8');
  const body = (text: string, start: string) => text.slice(text.indexOf(start), text.indexOf('\n}', text.indexOf(start)));

  it('keeps the bridge controls and tool-call attribution off API chats', () => {
    const bridge = source('bridge.ts');
    expect(body(bridge, 'async function controlledConversation(')).toContain("if (isApiConversationId(id)) throw new Error('api_chat_session');");
    expect(body(bridge, 'function noteCallAttribution(')).toContain('if (isApiConversationId(conversationId)) return;');
  });

  it('never opens an API chat as a ChatGPT page', () => {
    expect(body(source('ipc.ts'), 'export async function openSessionChat(')).toContain('isApiConversationId(conversationId)');
  });

  it('never lets browser observations or request proof reach an API chat', () => {
    const recorder = source('session/recorder.ts');
    expect(body(recorder, 'export async function sessionForConversation(')).toContain('if (isApiConversationId(conversationId)) return null;');
    expect(body(recorder, 'export async function recordRequestEvidence(')).toContain('if (isApiConversationId(conversationId)) return null;');
  });

  it('keeps the kernel local dispatch that runs API chat tools without connector proof', () => {
    const kernel = source('mcp/kernel.ts');
    expect(kernel).toContain('options: { local?: boolean } = {}');
    expect(kernel).toContain('if (!local) noteTransportIdentity(transportKey);');
    expect(source('api-chat/tools.ts')).toContain('{ local: true }');
  });
});

describe('Chat Marks bridge instance', () => {
  // 2026-10-21: `npm run dev` took 8765 before the installed app, and the installed app's
  // extensions attached to the dev app because discovery took the first port that answered.
  const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), 'utf8');

  it('keeps the extension discovery checking the app instance it paired with', () => {
    const background = read('extension', 'background.js');
    const discover = background.slice(background.indexOf('async function discoverNow('), background.indexOf('/** Forgets that the app was ever confirmed'));
    expect(discover).toContain('const wanted = await wantedInstance();');
    expect(discover).toContain('return !wanted || !reported || reported === wanted;');
    expect(discover).toContain('if (!matches(body)) {');
    expect(background).toContain("globalThis.__cosBrowserWorker.call('app.bridgeInstance', [])");
    expect(background).toContain('await chrome.storage.local.set({ port, token, appInstance, disconnected });');
  });

  it('keeps the bridge naming its instance and the dev profile off the installed app\'s port', () => {
    expect(read('src', 'main', 'bridge.ts')).toContain('instance: await bridgeInstance()');
    expect(read('src', 'main', 'cos-browser', 'host.ts')).toContain("if (name === 'app.bridgeInstance') return { ok: true, value: await bridgeInstance() };");
    expect(read('src', 'main', 'dev-profile.ts')).toContain('preferDevProfileBridgePorts();');
  });
});
