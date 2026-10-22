/** Chat Marks H1a: local-only memory administration and explicit composer recall. */
import type { AppApi } from '../preload/index.js';
import type { BrainMemory, BrainSettings } from '../shared/brain.js';
import { onLanguageChange, t, ui } from './i18n.js';
import { toast } from './dom.js';

type Reply = { ok: true; data: unknown } | { ok: false; error: string };
const brain = (api: AppApi, action: string, payload?: unknown): Promise<Reply> => api.brain(action, payload) as Promise<Reply>;
async function request<T>(api: AppApi, action: string, payload?: unknown): Promise<T> {
  const reply = await brain(api, action, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as T;
}
const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const button = (caption: string, onClick: () => void): HTMLButtonElement => {
  const node = document.createElement('button');
  node.className = 'btn'; node.type = 'button'; node.textContent = t(caption);
  node.addEventListener('click', onClick); return node;
};
const plain = (text: string): HTMLElement => { const node = document.createElement('p'); node.textContent = text; return node; };

function bindStaticText(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT; also works in jsdom */);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const original = node.textContent ?? '';
    const source = original.trim();
    if (!source) continue;
    const prefix = original.slice(0, original.indexOf(source));
    const suffix = original.slice(original.indexOf(source) + source.length);
    ui(node, 'textContent', () => `${prefix}${t(source)}${suffix}`);
  }
  for (const node of root.querySelectorAll<HTMLElement>('[placeholder],[aria-label]')) {
    for (const attr of ['placeholder', 'aria-label'] as const) {
      const value = node.getAttribute(attr);
      if (value) ui(node, attr, () => t(value));
    }
  }
}

export function initBrainUi(api: AppApi): { refresh: () => Promise<void> } {
  const root = element('brainSettings');
  bindStaticText(root);
  const approvalBanner = document.createElement('aside');
  approvalBanner.className = 'brain-approval-banner';
  approvalBanner.setAttribute('role', 'alertdialog');
  approvalBanner.setAttribute('aria-label', t('Pending memory saves'));
  approvalBanner.hidden = true;
  document.body.append(approvalBanner);
  const results = element('brainResults');
  const editor = element<HTMLFormElement>('brainEditor');
  const fields = {
    id: element<HTMLInputElement>('brainMemoryId'),
    title: element<HTMLInputElement>('brainMemoryTitle'),
    content: element<HTMLTextAreaElement>('brainMemoryContent'),
    type: element<HTMLSelectElement>('brainMemoryType'),
    mode: element<HTMLSelectElement>('brainMemoryMode'),
    tags: element<HTMLInputElement>('brainMemoryTags')
  };
  const input = element<HTMLInputElement>('brainQuery');
  let selected: string | null = null;
  let generation = 0;

  function clearEditor(): void {
    selected = null;
    fields.id.value = fields.title.value = fields.content.value = fields.tags.value = '';
    fields.type.value = 'semantic'; fields.mode.value = 'long_term';
    element('brainEditorTitle').textContent = t('New memory');
    element('brainDelete').hidden = true;
    element('brainEditorStatus').textContent = '';
  }
  function edit(memory: BrainMemory): void {
    selected = memory.id; fields.id.value = memory.id;
    fields.title.value = memory.title ?? ''; fields.content.value = memory.content;
    fields.type.value = memory.type; fields.mode.value = memory.mode;
    fields.tags.value = memory.tags.join(', ');
    element('brainEditorTitle').textContent = t('Edit memory');
    element('brainDelete').hidden = false;
    fields.content.focus();
  }
  function paintRows(rows: BrainMemory[]): void {
    results.replaceChildren();
    if (!rows.length) { results.append(plain(t('No memories found.'))); return; }
    for (const memory of rows) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'brain-memory-row';
      row.setAttribute('aria-pressed', String(selected === memory.id));
      const body = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = memory.title || memory.content.slice(0, 90);
      const description = document.createElement('small'); description.textContent = memory.content;
      body.append(title, description); row.append(body);
      row.addEventListener('click', () => { edit(memory); paintRows(rows); });
      results.append(row);
    }
  }
  async function search(): Promise<void> {
    const epoch = ++generation;
    try {
      const text = input.value.trim();
      const memories = text ? await request<BrainMemory[]>(api, 'memories.search', { query: text, limit: 100 }) : await request<BrainMemory[]>(api, 'memories.list');
      if (epoch === generation) paintRows(memories);
    } catch (error) {
      if (epoch === generation) results.replaceChildren(plain((error as Error).message));
    }
  }
  async function refresh(): Promise<void> {
    try {
      const [status, sources] = await Promise.all([
        request<{ available: boolean; count: number; bytes: number }>(api, 'status'),
        request<Array<{id: string; enabled: boolean; type: string}>>(api, 'sources')
      ]);
      element('brainStatus').textContent = status.available ? t('Local memory available') : t('Local memory unavailable');
      element('brainCount').textContent = `${t('Memories')}: ${status.count}`;
      element('brainSize').textContent = `${t('Storage')}: ${Math.round(status.bytes / 1024)} KiB`;
      element('brainSources').replaceChildren(plain(sources.map(source => `${source.id}: ${source.type}`).join(', ')));
    } catch { element('brainStatus').textContent = t('Local memory unavailable'); }
    try {
      const settings = await request<BrainSettings>(api, 'settings.get');
      element<HTMLInputElement>('brainChatgptTools').checked = settings.chatgptTools;
      element<HTMLInputElement>('brainApiChatTools').checked = settings.apiChatTools;
      element<HTMLInputElement>('brainAskBeforeSave').checked = settings.askBeforeSaving;
    } catch { /* No setting is silently changed when its saved file cannot be read. */ }
    await Promise.all([search(), paintPending()]);
  }
  async function paintPending(): Promise<void> {
    const host = element('brainPending');
    host.replaceChildren();
    approvalBanner.replaceChildren();
    try {
      const pending = await request<Array<{ id: string; chat: string; content: string }>>(api, 'pending.list');
      approvalBanner.hidden = pending.length === 0;
      if (!pending.length) { host.append(plain(t('No pending memory approvals.'))); return; }
      const heading = document.createElement('strong'); heading.textContent = t('Approve saving a memory?');
      approvalBanner.append(heading);
      for (const entry of pending) {
        const line = document.createElement('div'); line.className = 'brain-pending-row';
        const description = plain(entry.content);
        const actions = document.createElement('div');
        const decide = async (accepted: boolean): Promise<void> => {
          try { await request(api, 'pending.decide', { id: entry.id, accepted }); await paintPending(); }
          catch (error) { toast((error as Error).message); }
        };
        actions.append(button('Approve', () => void decide(true)), button('Deny', () => void decide(false)));
        line.append(description, actions); host.append(line);
        const bannerLine = line.cloneNode(true) as HTMLElement;
        const bannerActions = bannerLine.querySelector('div')!;
        bannerActions.replaceChildren(button('Approve', () => void decide(true)), button('Deny', () => void decide(false)));
        approvalBanner.append(bannerLine);
      }
    } catch {
      approvalBanner.hidden = true;
      host.append(plain(t('Could not load pending memory approvals.')));
    }
  }
  api.onBrainApprovalsChanged(() => { void paintPending(); });
  root.querySelector('#brainRefresh')?.addEventListener('click', () => void refresh());
  root.querySelector('#brainPendingRefresh')?.addEventListener('click', () => void paintPending());
  root.querySelector('#brainDoctorRun')?.addEventListener('click', async () => {
    try {
      const doctor = await request<{ available: boolean; quickCheck: boolean; fts: boolean }>(api, 'doctor');
      element('brainDoctor').textContent = `${t('Database')}: ${doctor.available ? 'OK' : t('Unavailable')}  ·  SQLite: ${doctor.quickCheck ? 'OK' : 'FAIL'}  ·  FTS5: ${doctor.fts ? 'OK' : 'FAIL'}`;
    } catch { element('brainDoctor').textContent = t('Diagnosis unavailable'); }
  });
  root.querySelector('#brainSearchForm')?.addEventListener('submit', event => { event.preventDefault(); void search(); });
  root.querySelector('#brainClear')?.addEventListener('click', () => { input.value = ''; void search(); });
  root.querySelector('#brainNew')?.addEventListener('click', clearEditor);
  editor.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const memory = {
        content: fields.content.value, title: fields.title.value || undefined,
        type: fields.type.value, mode: fields.mode.value,
        tags: fields.tags.value.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 12)
      };
      const saved = await request<BrainMemory>(api, selected ? 'memories.update' : 'memories.save', selected ? { ...memory, id: selected } : memory);
      edit(saved); element('brainEditorStatus').textContent = t('Memory saved');
      await search(); await refreshStatus();
    } catch (error) { element('brainEditorStatus').textContent = (error as Error).message; }
  });
  async function refreshStatus(): Promise<void> {
    try {
      const status = await request<{count:number}>(api, 'status');
      element('brainCount').textContent = `${t('Memories')}: ${status.count}`;
    } catch { /* existing status remains visible */ }
  }
  root.querySelector('#brainDelete')?.addEventListener('click', async () => {
    if (!selected || !confirm(t('Delete this memory?'))) return;
    try { await request(api, 'memories.delete', { id: selected }); clearEditor(); await search(); await refreshStatus(); }
    catch (error) { toast((error as Error).message); }
  });
  root.querySelector('#brainExport')?.addEventListener('click', async () => {
    try { const done = await request<boolean>(api, 'memories.export'); if (done) toast(t('Memory export saved')); }
    catch (error) { toast((error as Error).message); }
  });
  for (const [id, key] of [ ['brainChatgptTools', 'chatgptTools'], ['brainApiChatTools', 'apiChatTools'], ['brainAskBeforeSave', 'askBeforeSaving'] ] as const) {
    const control = element<HTMLInputElement>(id);
    control.addEventListener('change', async () => {
      try { await request(api, 'settings.set', { [key]: control.checked }); }
      catch (error) { control.checked = !control.checked; toast((error as Error).message); }
    });
  }
  onLanguageChange(() => { void search(); });
  void refresh();
  return { refresh };
}

/** /recall is always a local, unsent, user-selected draft operation. */
export function openBrainRecall(api: AppApi, draft: HTMLTextAreaElement, initialQuery = ''): void {
  const dialog = document.createElement('dialog'); dialog.className = 'brain-recall-dialog';
  const title = document.createElement('h2'); title.textContent = t('Recall memories');
  const description = plain(t('Choose which memories to insert as background context into the message. Nothing is sent automatically.'));
  const form = document.createElement('form'); form.method = 'dialog';
  const query = document.createElement('input'); query.type = 'search'; query.placeholder = t('Search saved memories…'); query.maxLength = 400;
  query.value = initialQuery.slice(0, 400);
  const find = button('Search', () => void search());
  form.append(query, find);
  const results = document.createElement('div'); results.className = 'brain-recall-results';
  const actions = document.createElement('div'); actions.className = 'brain-recall-actions';
  const cancel = button('Cancel', () => dialog.close());
  const insert = button('Insert into message', () => {
    const selected = [...results.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map(box => box.dataset.text ?? '').filter(Boolean);
    if (!selected.length) return;
    const block = `<memory-context>\n${selected.join('\n\n').replaceAll('</memory-context>', '&lt;/memory-context&gt;')}\n</memory-context>`;
    draft.value = draft.value.trim() ? `${block}\n\n${draft.value}` : block;
    draft.dispatchEvent(new Event('input', { bubbles: true })); draft.focus(); dialog.close();
  });
  actions.append(cancel, insert); dialog.append(title, description, form, results, actions); document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  async function search(): Promise<void> {
    results.replaceChildren(plain(t('Searching local memories…')));
    try {
      const found = await request<BrainMemory[]>(api, query.value.trim() ? 'recall' : 'memories.list', query.value.trim() ? { query: query.value.trim(), limit: 12 } : undefined);
      results.replaceChildren();
      for (const memory of found.slice(0, 12)) {
        const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.dataset.text = memory.content;
        const text = document.createElement('span'); text.textContent = memory.title ? `${memory.title}: ${memory.content}` : memory.content;
        label.append(box, text); results.append(label);
      }
      if (!found.length) results.append(plain(t('No memories found.')));
    } catch (error) { results.replaceChildren(plain((error as Error).message)); }
  }
  dialog.showModal(); query.focus(); void search();
}

/** /remember only persists what the human explicitly selected or left in the composer. */
export async function rememberBrainSelection(api: AppApi, draft: HTMLTextAreaElement): Promise<void> {
  const start = draft.selectionStart ?? 0, end = draft.selectionEnd ?? 0;
  const text = (end > start ? draft.value.slice(start, end) : draft.value).trim();
  if (!text) { toast(t('Select or type text to remember.')); return; }
  try { await request(api, 'memories.save', { content: text.slice(0, 4000) }); toast(t('Memory saved')); }
  catch (error) { toast((error as Error).message); }
}
