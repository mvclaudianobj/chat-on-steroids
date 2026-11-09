/**
 * Regression contract for external ChatGPT approvals, entirely synthetic.
 * The Chat Marks Internal Grants UI may add persistent local scopes, but that
 * must never manufacture an external host "Always allow" decision.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { parseApprovalCard } from '../src/main/approval-wait.js';

const languages = readdirSync('src/renderer/locales').filter(name => name.endsWith('.json')).sort();
const source = readFileSync('extension/chatgpt-dom.js', 'utf8');
const requiredKeys = [
  'Deny', 'Allow once',
  'For other approval options, continue in ChatGPT if they are available there.',
  'ChatGPT button was pressed, but the approval card is still visible. Confirm in the browser if it does not disappear.',
  'ChatGPT did not confirm the answer in the app. Open this chat in the browser to finish approval.',
  'This is separate from the plugin’s permissions, and this reminder does not approve a tool call.',
  'Where the plugin offers permissions: allow all tools'
];

describe('host consent is distinct from persistent internal grants in 12 locales', () => {
  it('tests the complete 12 shipped translations', () => {
    expect(languages).toEqual(['de.json', 'es.json', 'fr.json', 'ja.json', 'ko.json',
      'pt-BR.json', 'pt-PT.json', 'ru.json', 'tr.json', 'vi.json', 'zh-CN.json', 'zh-TW.json']);
  });

  it.each(languages)('%s: only external Allow once is exposed; host Always allow remains a host setting', async filename => {
    const catalog = JSON.parse(readFileSync(`src/renderer/locales/${filename}`, 'utf8')) as Record<string, string>;
    for (const key of requiredKeys) expect(catalog[key], `${filename}: ${key}`).toBeTruthy();

    const dom = new JSDOM(`<main><div data-codex-approval-surface="true"><div role="alert">Synthetic tool request</div>
      <button id="deny"><kbd>Esc</kbd></button>
      <button id="allow"><kbd>⏎</kbd></button>
      <button id="host-settings" aria-haspopup="menu">Host options</button>
      </div></main>`, { url:'https://chatgpt.com/c/synthetic', runScripts:'outside-only', pretendToBeVisual:true });
    try {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
        value() { return [{ width:10, height:10 }]; }
      });
      dom.window.document.getElementById('deny')!.prepend(catalog.Deny!);
      dom.window.document.getElementById('allow')!.prepend(catalog['Allow once']!);
      dom.window.eval(source);
      const detector = (dom.window as unknown as { CLF_DOM: {
        approvalCard(): { node: Element; allow: boolean } | null;
        answerApprovalCard(node: Element, choice: string): Promise<string>;
      } }).CLF_DOM;
      const card = detector.approvalCard();
      expect(card).not.toBeNull();
      expect(card?.allow).toBe(true);
      let optionsClicks = 0;
      dom.window.document.getElementById('host-settings')!.addEventListener('click', () => { optionsClicks++; });
      expect(await detector.answerApprovalCard(card!.node, 'always')).toBe('unavailable');
      expect(optionsClicks).toBe(0);
      // The IPC contract has only 'allow' and 'deny'. It cannot convey a persistent grant.
      const payload = parseApprovalCard(JSON.stringify({ id:'synthetic-card-12', lines:['Prompt'], allow:true }));
      expect(payload).toMatchObject({ id:'synthetic-card-12', allow:true });
      expect(JSON.stringify(payload)).not.toMatch(/always|granted|persistent/i);
    } finally { dom.window.close(); }
  });
});
