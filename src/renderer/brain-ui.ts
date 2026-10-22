/** Chat Marks H1a: local-only memory administration and explicit composer recall. */
import type { AppApi } from '../preload/index.js';
import type { BrainMemory, BrainProviderId, BrainProviderStatus, BrainRecallItem, BrainRecallResult, BrainSettings } from '../shared/brain.js';
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
        request<{ available: boolean; count: number; bytes: number; chatgptRefresh?: string | null }>(api, 'status'),
        request<BrainProviderStatus[]>(api, 'sources')
      ]);
      element('brainStatus').textContent = status.available ? t('Local memory available') : t('Local memory unavailable');
      element('brainCount').textContent = `${t('Memories')}: ${status.count}`;
      element('brainSize').textContent = `${t('Storage')}: ${Math.round(status.bytes / 1024)} KiB`;
      paintSources(sources);
      paintRefreshWarning(status.chatgptRefresh ?? null);
    } catch { element('brainStatus').textContent = t('Local memory unavailable'); }
    try {
      const settings = await request<BrainSettings>(api, 'settings.get');
      element<HTMLInputElement>('brainChatgptTools').checked = settings.chatgptTools;
      element<HTMLInputElement>('brainApiChatTools').checked = settings.apiChatTools;
      element<HTMLInputElement>('brainAskBeforeSave').checked = settings.askBeforeSaving;
      element<HTMLInputElement>('brainRemoteRecall').checked = settings.remoteRecall;
      element<HTMLInputElement>('brainRemoteSync').checked = settings.remoteSync;
      providers.paint(settings);
      element<HTMLInputElement>('brainEngineTools').checked = settings.enginesEnabled;
      element<HTMLInputElement>('brainAutoInject').checked = settings.autoInject;
    } catch { /* No setting is silently changed when its saved file cannot be read. */ }
    await Promise.all([search(), paintPending()]);
  }
  function paintSources(sources: BrainProviderStatus[]): void {
    element('brainSources').replaceChildren(...sources.map(source => plain(`${source.label}: ${providerStateText(source)}${source.count !== undefined ? ` · ${t('Memories')}: ${source.count}` : ''}`)));
    providers.statuses(sources);
  }
  function paintRefreshWarning(state: string | null): void {
    const warning = element('brainRefreshWarning');
    // `current` means ChatGPT confirmed the Core declaration that includes the memory tools.
    warning.hidden = !state || state === 'current';
    warning.textContent = state === 'unpublished' ? t('The Core plugin is not connected, so ChatGPT cannot use the memory tools yet.')
      : t('ChatGPT has not refreshed the Core plugin yet, so it cannot use the memory tools. Refresh the Core plugin in ChatGPT, then start a new chat.');
  }
  const providers = providerPanel(api, () => void refresh());
  async function paintPending(): Promise<void> {
    const host = element('brainPending');
    host.replaceChildren();
    approvalBanner.replaceChildren();
    try {
      const pending = await request<Array<{ id: string; chat: string; content: string }>>(api, 'pending.list');
      approvalBanner.hidden = pending.length === 0;
      element('brainApprovalsSection').classList.toggle('has-pending', pending.length > 0);
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
      element('brainDoctor').textContent = t('Checking…');
      const doctor = await request<{ available: boolean; quickCheck: boolean; fts: boolean; providers?: BrainProviderStatus[]; chatgptRefresh?: string | null }>(api, 'doctor');
      const lines = [`${t('Database')}: ${doctor.available ? 'OK' : t('Unavailable')}  ·  SQLite: ${doctor.quickCheck ? 'OK' : 'FAIL'}  ·  FTS5: ${doctor.fts ? 'OK' : 'FAIL'}`];
      for (const provider of (doctor.providers ?? []).filter(row => row.id !== 'local'))
        lines.push(`${provider.label}: ${providerStateText(provider)}${provider.detail ? ` (${provider.detail})` : ''}`);
      element('brainDoctor').replaceChildren(...lines.map(plain));
      if (doctor.providers) paintSources(doctor.providers);
      paintRefreshWarning(doctor.chatgptRefresh ?? null);
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
  for (const [id, key] of [ ['brainChatgptTools', 'chatgptTools'], ['brainApiChatTools', 'apiChatTools'], ['brainAskBeforeSave', 'askBeforeSaving'], ['brainRemoteRecall', 'remoteRecall'], ['brainRemoteSync', 'remoteSync'], ['brainEngineTools', 'enginesEnabled'], ['brainAutoInject', 'autoInject'] ] as const) {
    const control = element<HTMLInputElement>(id);
    control.addEventListener('change', async () => {
      try { await request(api, 'settings.set', { [key]: control.checked }); if (key === 'chatgptTools') void refresh(); }
      catch (error) { control.checked = !control.checked; toast((error as Error).message); }
    });
  }
  onLanguageChange(() => { void search(); });
  void refresh();
  return { refresh };
}

const SOURCE_LABELS: Record<BrainRecallItem['source'], string> = { local: 'Local', aiMemory: 'ai-memory', openviking: 'OpenViking', marksApi: 'Marks API' };
function providerStateText(status: BrainProviderStatus): string {
  const labels: Record<BrainProviderStatus['state'], string> = { ok: 'OK', disabled: 'Off', stopped: 'Stopped', 'needs-key': 'Needs key', insecure: 'Insecure HTTP refused', unauthorized: 'Credential rejected', error: 'Error' };
  return t(labels[status.state]);
}

/** /recall is a user-selected, unsent draft operation; remote sources only with remote recall on. */
export function openBrainRecall(api: AppApi, draft: HTMLTextAreaElement, initialQuery = ''): void {
  const dialog = document.createElement('dialog'); dialog.className = 'brain-recall-dialog';
  const title = document.createElement('h2'); title.textContent = t('Recall memories');
  const description = plain(t('Choose which memories to insert as background context into the message. Nothing is sent automatically.'));
  const form = document.createElement('form'); form.method = 'dialog';
  const query = document.createElement('input'); query.type = 'search'; query.placeholder = t('Search saved memories…'); query.maxLength = 400;
  query.value = initialQuery.slice(0, 400);
  const find = button('Search', () => void search());
  form.addEventListener('submit', event => { event.preventDefault(); void search(); });
  form.append(query, find);
  const results = document.createElement('div'); results.className = 'brain-recall-results';
  const hint = plain(''); hint.className = 'brain-recall-hint'; hint.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'brain-recall-actions';
  const cancel = button('Cancel', () => dialog.close());
  const checked = () => [...results.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')];
  const insert = button('Insert into message', () => {
    const selected = checked().map(box => box.dataset.text ?? '').filter(Boolean);
    if (!selected.length) { updateInsert(); return; }
    const block = `<memory-context>\n${selected.join('\n\n').replaceAll('</memory-context>', '&lt;/memory-context&gt;')}\n</memory-context>`;
    draft.value = draft.value.trim() ? `${block}\n\n${draft.value}` : block;
    draft.dispatchEvent(new Event('input', { bubbles: true })); draft.focus(); dialog.close();
  });
  insert.dataset.action = 'insert';
  /** Never a silent button: disabled with a reason until at least one memory is chosen. */
  function updateInsert(): void {
    const count = checked().length;
    const any = results.querySelector('input[type="checkbox"]') !== null;
    insert.disabled = count === 0;
    hint.textContent = count === 0 && any ? t('Select at least one memory to insert.') : '';
  }
  results.addEventListener('change', updateInsert);
  actions.append(cancel, insert); dialog.append(title, description, form, results, hint, actions); document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  let epoch = 0;
  async function search(): Promise<void> {
    const mine = ++epoch;
    insert.disabled = true; hint.textContent = '';
    results.replaceChildren(plain(t('Searching local memories…')));
    try {
      const text = query.value.trim();
      let items: BrainRecallItem[]; let errors: BrainRecallResult['errors'] = [];
      if (text) ({ items, errors } = await request<BrainRecallResult>(api, 'recall', { query: text, limit: 12 }));
      else items = (await request<BrainMemory[]>(api, 'memories.list')).slice(0, 12).map(memory => ({ source: 'local', id: memory.id, content: memory.content, ...(memory.title ? { title: memory.title } : {}), contentHash: memory.contentHash }));
      if (mine !== epoch) return;
      results.replaceChildren();
      for (const item of items.slice(0, 12)) {
        const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox';
        const source = SOURCE_LABELS[item.source];
        box.dataset.text = `[${source}] ${item.title ? `${item.title}: ` : ''}${item.content}`;
        const badge = document.createElement('span'); badge.className = 'brain-recall-source'; badge.textContent = item.source === 'local' ? t('Local') : source;
        const body = document.createElement('span'); body.textContent = item.title ? `${item.title}: ${item.content}` : item.content;
        label.append(box, badge, body); results.append(label);
      }
      // One result is the obvious choice; preselect it so Insert works at once.
      const boxes = results.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      if (boxes.length === 1) boxes[0]!.checked = true;
      if (!items.length) results.append(plain(text ? t('No memories found.') : t('No memories yet: use /remember or the Brain page.')));
      if (errors.length) results.append(plain(t('Some sources were unavailable: {0}', [errors.map(row => `${SOURCE_LABELS[row.source]} (${row.error})`).join(', ')])));
      updateInsert();
    } catch (error) { if (mine === epoch) { results.replaceChildren(plain((error as Error).message)); updateInsert(); } }
  }
  updateInsert();
  dialog.showModal(); query.focus(); void search();
}

/** Brain page provider cards: enable, URL, auth, vault key, MarksCode import and a live test. */
function providerPanel(api: AppApi, changed: () => void): { paint: (settings: BrainSettings) => void; statuses: (rows: BrainProviderStatus[]) => void } {
  const host = element('brainProviders');
  const stateNodes = new Map<string, HTMLElement>();
  const keyNodes = new Map<string, HTMLElement>();
  let painted = false;
  const save = async (id: BrainProviderId, patch: Record<string, unknown>): Promise<boolean> => {
    try { await request(api, 'settings.set', { providers: { [id]: patch } }); changed(); return true; }
    catch (error) { toast((error as Error).message); return false; }
  };
  const checkbox = (caption: string, value: boolean, onChange: (value: boolean, box: HTMLInputElement) => void): HTMLLabelElement => {
    const label = document.createElement('label'); label.className = 'brain-provider-row';
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = value;
    box.addEventListener('change', () => onChange(box.checked, box));
    const text = document.createElement('span'); text.textContent = t(caption);
    label.append(box, text); return label;
  };
  const field = (caption: string, value: string, type: string, onChange?: (value: string) => void): { row: HTMLLabelElement; input: HTMLInputElement } => {
    const row = document.createElement('label'); row.className = 'brain-provider-row';
    const text = document.createElement('span'); text.textContent = t(caption);
    const input = document.createElement('input'); input.type = type; input.value = value; input.maxLength = type === 'password' ? 16384 : 300;
    input.autocomplete = 'off'; input.spellcheck = false;
    if (onChange) input.addEventListener('change', () => onChange(input.value.trim()));
    row.append(text, input); return { row, input };
  };
  function card(id: BrainProviderId, settings: BrainSettings): HTMLElement {
    const config = settings.providers[id] as Record<string, any>;
    const node = document.createElement('div'); node.className = 'brain-provider'; node.dataset.provider = id;
    const head = document.createElement('div'); head.className = 'brain-provider-head';
    const name = document.createElement('strong'); name.textContent = SOURCE_LABELS[id];
    const state = document.createElement('span'); state.className = 'brain-provider-state'; state.dataset.state = config.enabled ? 'unknown' : 'disabled';
    state.textContent = config.enabled ? '' : t('Off'); stateNodes.set(id, state);
    head.append(name, state);
    node.append(head, checkbox('Enabled', config.enabled, (value, box) => void save(id, { enabled: value }).then(done => { if (!done) box.checked = !value; })));
    node.append(field('Server URL', config.url, 'url', value => void save(id, { url: value })).row);
    if (id === 'aiMemory') node.append(field('Project (optional)', config.project, 'text', value => void save(id, { project: value })).row);
    if (id === 'marksApi') {
      const warning = plain(t('This server only speaks plain HTTP: queries, memories and credentials cross the network unencrypted.'));
      warning.className = 'brain-warning'; warning.hidden = !String(config.url).startsWith('http:');
      node.append(warning, checkbox('Allow insecure HTTP', config.insecureHttp, value => void save(id, { insecureHttp: value })));
      const row = document.createElement('label'); row.className = 'brain-provider-row';
      const text = document.createElement('span'); text.textContent = t('Authentication');
      const select = document.createElement('select');
      for (const [value, caption] of [['apiKey', 'API key'], ['markspanel', 'Markspanel session'], ['both', 'API key and Markspanel session']] as const) {
        const option = document.createElement('option'); option.value = value; option.textContent = t(caption); select.append(option);
      }
      select.value = config.auth;
      select.addEventListener('change', () => void save(id, { auth: select.value }));
      row.append(text, select); node.append(row);
    }
    if (id === 'openviking') node.append(plain(t('Without a key, OpenViking must run in trusted mode on this computer. Start it with: openviking-server --config ~/.openviking/ov.conf')));
    const key = document.createElement('p'); key.className = 'brain-provider-state'; keyNodes.set(id, key);
    const password = field('Vault master password', '', 'password');
    const value = field('Key or token', '', 'password');
    const actions = document.createElement('div'); actions.className = 'brain-provider-row';
    const run = async (action: string, payload: Record<string, unknown>, done: string): Promise<void> => {
      if (!password.input.value) { toast(t('Enter the vault master password first.')); password.input.focus(); return; }
      try { await request(api, action, { id, password: password.input.value, ...payload }); toast(t(done)); password.input.value = value.input.value = ''; changed(); }
      catch (error) { toast((error as Error).message); }
    };
    actions.append(button('Save key to vault', () => { if (!value.input.value.trim()) { value.input.focus(); return; } void run('providers.setKey', { value: value.input.value }, 'Key saved in the vault'); }));
    if (id !== 'openviking') actions.append(button('Import from MarksCode', () => void run('providers.importMarksCode', {}, 'Key saved in the vault')));
    actions.append(button('Test connection', async () => {
      state.textContent = t('Checking…');
      try { const row = await request<BrainProviderStatus | undefined>(api, 'providers.test', { id }); if (row) paintState(row); }
      catch (error) { state.textContent = (error as Error).message; }
    }));
    node.append(key, password.row, value.row, actions);
    return node;
  }
  function paintState(row: BrainProviderStatus): void {
    const state = stateNodes.get(row.id); const key = keyNodes.get(row.id);
    if (state) { state.dataset.state = row.state; state.textContent = `${providerStateText(row)}${row.detail ? ` · ${row.detail}` : ''}`; }
    if (key) key.textContent = row.hasKey ? t('Key in vault') : t('No key');
  }
  return {
    paint(settings) {
      // Repaint only once per page load so typing in a field is never replaced underneath.
      if (painted && host.childElementCount) return;
      painted = true;
      host.replaceChildren(...(['aiMemory', 'openviking', 'marksApi'] as const).map(id => card(id, settings)));
    },
    statuses(rows) { for (const row of rows) if (row.id !== 'local') paintState(row); }
  };
}

/** /remember only persists what the human explicitly selected or left in the composer. */
export async function rememberBrainSelection(api: AppApi, draft: HTMLTextAreaElement, options: { clearOnSave?: boolean } = {}): Promise<boolean> {
  const start = draft.selectionStart ?? 0, end = draft.selectionEnd ?? 0;
  const text = (end > start ? draft.value.slice(start, end) : draft.value).trim();
  if (!text) { toast(t('Select or type text to remember.')); return false; }
  try {
    const saved = await request<{ synced?: Array<{ source: BrainRecallItem['source']; ok: boolean }> }>(api, 'memories.save', { content: text.slice(0, 4000) });
    const synced = (saved?.synced ?? []).filter(row => row.ok).map(row => SOURCE_LABELS[row.source]);
    toast(synced.length ? t('Memory saved and synced to {0}', [synced.join(', ')]) : t('Memory saved'));
    // A typed `/remember <text>` leaves nothing behind that could be sent by mistake.
    if (options.clearOnSave && draft.value.trim() === text) { draft.value = ''; draft.dispatchEvent(new Event('input', { bubbles: true })); }
    return true;
  }
  catch (error) { toast((error as Error).message); return false; }
}
