/**
 * Chat Marks Brain H2: "Search old history" on the Brain page. Copies of old MarksCode, OpenCode
 * and MarksClaw history are made on request, indexed, searched by topic and read here; each
 * import (memory, archive, read-only chat, selected hybrid memories) needs the user's confirmation.
 */
import type { AppApi } from '../preload/index.js';
import type { BrainImportProgress, BrainImportStatus, HistoryConversation, HistoryHit, HistoryRef, HistorySearchResult, MemoryPreviewItem, StagingView } from '../shared/brain-import.js';
import { onLanguageChange, t } from './i18n.js';
import { toast } from './dom.js';

type Reply = { ok: true; data: unknown } | { ok: false; error: string };
export interface BrainImportHost { showTab(name: string): void; selectChat(id: string): Promise<void> }

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const formatDate = (time: number): string => time > 0 ? new Date(time).toLocaleDateString() : '';
const roleLabel = (role: string): string => role === 'user' ? t('User') : role === 'summary' ? t('Summary') : t('Assistant');

/** Text with \u0001…\u0002 match markers, rendered without HTML parsing. */
function highlighted(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  text.split('\u0001').forEach((piece, index) => {
    if (index === 0) { fragment.append(piece); return; }
    const [match = '', rest = ''] = piece.split('\u0002');
    fragment.append(node('mark', undefined, match), rest);
  });
  return fragment;
}

export function mountBrainImport(api: AppApi, host: BrainImportHost): { refresh: () => Promise<void> } {
  const root = document.getElementById('brainImport');
  if (!root) return { refresh: async () => undefined };
  async function request<T>(action: string, payload?: unknown): Promise<T> {
    const reply = await api.brain(action, payload) as Reply;
    if (!reply.ok) throw new Error(reply.error);
    return reply.data as T;
  }
  const button = (caption: string, onClick: () => void, className = 'btn'): HTMLButtonElement => {
    const element = node('button', className, t(caption)); element.type = 'button';
    element.addEventListener('click', onClick); return element;
  };

  const head = node('header', 'settings-section-head');
  const intro = node('div');
  const title = node('h2'), description = node('p');
  intro.append(title, description); head.append(intro);
  const surface = node('div', 'settings-surface brain-import');
  const actions = node('div', 'brain-actions brain-import-copy');
  const copies = node('div', 'brain-import-copies');
  copies.setAttribute('role', 'region');
  const progress = node('p', 'brain-import-progress'); progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite');
  const form = node('form', 'brain-search');
  const label = node('label'); label.htmlFor = 'brainHistoryQuery';
  const query = node('input'); query.id = 'brainHistoryQuery'; query.type = 'search'; query.maxLength = 400; query.autocomplete = 'off'; query.spellcheck = false;
  const find = node('button', 'btn'); find.type = 'submit';
  form.append(label, query, find);
  const summary = node('p', 'brain-import-summary'); summary.setAttribute('role', 'status');
  const results = node('div', 'brain-results brain-history-results'); results.setAttribute('role', 'region');
  surface.append(actions, copies, progress, form, summary, results);
  root.replaceChildren(head, surface);

  let status: BrainImportStatus | null = null;
  let lastResult: HistorySearchResult | null = null;
  let busy = false;
  function paintStatic(): void {
    title.textContent = t('Old history');
    description.textContent = t('Search conversations copied from MarksCode, OpenCode and MarksClaw. Originals are never opened or changed; nothing is imported until you confirm it.');
    label.textContent = t('Search old history');
    query.placeholder = t('Search a topic…');
    find.textContent = t('Search');
    results.setAttribute('aria-label', t('Search old history'));
    copies.setAttribute('aria-label', t('Copies of old history'));
    actions.replaceChildren(
      button('Copy my readable history', () => void runExport('import.userExport', 'Copy the MarksCode 2.0.25 and MarksClaw history of this account? Stop the MarksCode service first for a consistent copy.')),
      button('Export from administrator account', () => void runExport('import.adminExport', 'Copy MarksCode and OpenCode history from the administrator account? Only conversation tables and memory files are copied; credentials and accounts are never read. You will be asked for your password.')),
      button('Show commands for a root terminal', () => void showCommand()),
      button('Refresh', () => void refresh()));
  }

  async function runExport(action: string, question: string): Promise<void> {
    if (busy || !confirm(t(question))) return;
    busy = true;
    try { await request(action, { confirmed: true }); progress.textContent = ''; }
    catch (error) { toast((error as Error).message); }
    finally { busy = false; await refresh(); }
  }

  async function showCommand(): Promise<void> {
    try {
      const { command } = await request<{ stagingId: string; command: string }>('import.adminCommand', {});
      const dialog = node('dialog', 'brain-import-dialog');
      const text = node('textarea'); text.readOnly = true; text.rows = 8; text.value = command;
      const row = node('div', 'brain-actions');
      row.append(button('Copy command', () => { void navigator.clipboard.writeText(command).then(() => toast(t('Copied'))); }), button('Close', () => dialog.close()));
      dialog.append(node('h2', undefined, t('Show commands for a root terminal')), node('p', undefined, t('Run this in a terminal as an administrator, then press Refresh.')), text, row);
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      document.body.append(dialog); dialog.showModal(); text.select();
    } catch (error) { toast((error as Error).message); }
  }

  function indexLabel(view: StagingView): string {
    if (view.index.state === 'running') return t('Indexing…');
    if (view.index.state === 'complete') return t('Index ready: {0} conversations', [view.index.conversations]);
    if (view.index.state === 'partial') return t('Index incomplete: {0} conversations', [view.index.conversations]);
    return t('Not indexed');
  }
  function paintCopies(): void {
    copies.replaceChildren();
    if (!status?.stagings.length) { copies.append(node('p', undefined, t('No copies yet. Make a copy first, then build its search index.'))); }
    for (const view of status?.stagings ?? []) {
      const row = node('div', 'brain-import-row');
      const text = node('span');
      const sessions = view.sources.reduce((sum, source) => sum + source.sessions, 0);
      text.append(node('strong', undefined, `${view.kind === 'admin' ? t('Administrator copy') : t('This account')} · ${formatDate(view.createdAt)}`),
        node('small', undefined, `${t('{0} conversations', [sessions])} · ${Math.round(view.bytes / 1048576)} MB · ${indexLabel(view)}`));
      if (view.sources.some(source => source.unchanged === false)) text.append(node('small', 'brain-import-warning', t('Some sources changed while they were copied.')));
      const controls = node('div', 'brain-actions');
      const running = status?.running?.stagingId === view.id;
      if (running) controls.append(button('Stop', () => void request('import.cancel', {}).catch(error => toast((error as Error).message))));
      else if (view.complete && view.index.state !== 'complete') controls.append(button(view.index.state === 'none' ? 'Build search index' : 'Resume indexing', () => void startIndex(view.id)));
      if (view.memories) controls.append(button('Review memories', () => void reviewMemories(view.id)));
      if (!running) controls.append(button('Delete copy', () => void removeCopy(view.id)));
      row.append(text, controls); copies.append(row);
    }
    if (status?.archive.available) copies.append(node('p', 'brain-import-archive', t('Archive: {0} conversations', [status.archive.conversations])));
  }

  async function startIndex(stagingId: string): Promise<void> {
    try { await request('import.index', { stagingId }); } catch (error) { toast((error as Error).message); }
    await refresh();
  }
  async function removeCopy(stagingId: string): Promise<void> {
    if (!confirm(t('Delete this copy and its search index? The original files are not affected.'))) return;
    try { await request('import.deleteStaging', { stagingId, confirmed: true }); } catch (error) { toast((error as Error).message); }
    await refresh();
  }

  async function reviewMemories(stagingId: string): Promise<void> {
    let items: MemoryPreviewItem[];
    try { items = await request<MemoryPreviewItem[]>('import.memories.preview', { stagingId }); } catch (error) { toast((error as Error).message); return; }
    const dialog = node('dialog', 'brain-import-dialog');
    const list = node('div', 'brain-recall-results');
    for (const item of items) {
      const row = node('label'), box = node('input'); box.type = 'checkbox'; box.value = String(item.index); box.disabled = item.duplicate;
      row.append(box, node('span', undefined, `${item.title ? `${item.title}: ` : ''}${item.content}${item.duplicate ? ` (${t('Already in Brain')})` : ''}`));
      list.append(row);
    }
    const row = node('div', 'brain-actions');
    row.append(button('Cancel', () => dialog.close()), button('Import selected', async () => {
      const indexes = [...list.querySelectorAll<HTMLInputElement>('input:checked')].map(box => Number(box.value));
      if (!indexes.length) return;
      try {
        const done = await request<{ saved: number; skipped: number }>('import.memories.import', { stagingId, indexes, confirmed: true });
        toast(t('Memories imported: {0}, skipped: {1}', [done.saved, done.skipped])); dialog.close();
      } catch (error) { toast((error as Error).message); }
    }));
    dialog.append(node('h2', undefined, t('Review memories')), list, row);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal();
  }

  function paintResults(): void {
    results.replaceChildren();
    if (!lastResult) return;
    summary.textContent = t('{0} conversations · {1} matches', [lastResult.conversations, lastResult.matches]);
    if (!lastResult.hits.length) { results.append(node('p', undefined, t('No matching conversations.'))); return; }
    for (const hit of lastResult.hits) results.append(hitRow(hit));
  }
  function hitRow(hit: HistoryHit): HTMLElement {
    const row = node('button', 'brain-memory-row'); row.type = 'button';
    const body = node('span');
    const meta = [hit.source, hit.project ?? hit.directory ?? '', formatDate(hit.updated), t('{0} messages', [hit.messages]),
      hit.subagentHits ? t('Sub-agent matches: {0}', [hit.subagentHits]) : '', hit.archived ? t('In archive') : ''].filter(Boolean).join(' · ');
    const snippet = node('small'); snippet.append(highlighted(hit.snippet));
    body.append(node('strong', undefined, hit.title), node('small', undefined, meta), snippet);
    row.append(body);
    row.addEventListener('click', () => void openConversation(hit.ref));
    return row;
  }

  async function search(): Promise<void> {
    const text = query.value.trim();
    if (!text) return;
    summary.textContent = t('Searching…');
    try { lastResult = await request<HistorySearchResult>('history.search', { query: text, limit: 100 }); paintResults(); }
    catch (error) { summary.textContent = (error as Error).message; }
  }

  async function openConversation(ref: HistoryRef): Promise<void> {
    let conversation: HistoryConversation;
    try { conversation = await request<HistoryConversation>('history.read', { ref }); } catch (error) { toast((error as Error).message); return; }
    const dialog = node('dialog', 'brain-import-dialog brain-history-viewer');
    const header = node('header');
    header.append(node('h2', undefined, conversation.title),
      node('p', undefined, [conversation.source, conversation.project ?? conversation.directory ?? '', formatDate(conversation.created), conversation.model ?? ''].filter(Boolean).join(' · ')));
    const transcript = node('div', 'brain-history-transcript');
    for (const message of conversation.messages) {
      const item = node('article', `brain-history-message ${message.role}`);
      item.append(node('b', undefined, `${roleLabel(message.role)} · ${message.time ? new Date(message.time).toLocaleString() : ''}`), node('p', undefined, message.text));
      for (const tool of message.tools) item.append(node('small', undefined, `[${tool.name}] ${tool.summary}`));
      transcript.append(item);
    }
    if (conversation.truncated) transcript.append(node('p', 'brain-import-warning', t('Some messages were left out by the size limits.')));
    if (conversation.children?.length) {
      const children = node('div', 'brain-actions');
      children.append(node('b', undefined, t('Sub-agent sessions')));
      for (const child of conversation.children) {
        const open = node('button', 'btn', child.title); open.type = 'button';
        open.addEventListener('click', () => { dialog.close(); void openConversation(child.ref); });
        children.append(open);
      }
      transcript.append(children);
    }
    const editor = node('div', 'brain-editor'); editor.hidden = true;
    const memoryText = node('textarea'); memoryText.rows = 5; memoryText.maxLength = 4000;
    const memoryTitle = node('input'); memoryTitle.type = 'text'; memoryTitle.maxLength = 160; memoryTitle.value = conversation.title.slice(0, 160);
    const saveRow = node('div', 'brain-actions');
    saveRow.append(button('Save as memory', async () => {
      if (!memoryText.value.trim()) return;
      try { await request('import.memory', { ref, content: memoryText.value.trim(), title: memoryTitle.value.trim() || undefined, confirmed: true }); toast(t('Memory saved')); editor.hidden = true; }
      catch (error) { toast((error as Error).message); }
    }), button('Cancel', () => { editor.hidden = true; }));
    editor.append(node('p', undefined, t('Write the memory in your own words. It is saved with a link to this conversation.')),
      node('label', undefined, t('Title')), memoryTitle, node('label', undefined, t('Memory text')), memoryText, saveRow);
    const bar = node('div', 'brain-actions');
    bar.append(
      button('Save as memory', () => { memoryText.value = (window.getSelection()?.toString() ?? '').trim().slice(0, 4000); editor.hidden = false; memoryText.focus(); }),
      'archive' in ref
        ? button('Remove from archive', async () => {
          if (!confirm(t('Remove this conversation from the archive?'))) return;
          try { await request('archive.remove', { key: ref.key, confirmed: true }); dialog.close(); await refresh(); } catch (error) { toast((error as Error).message); }
        })
        : button('Keep in archive', async () => {
          if (!confirm(t('Keep this conversation in the Brain archive?'))) return;
          try { const done = await request<{ added: boolean }>('import.archive', { ref, confirmed: true }); toast(done.added ? t('Kept in archive') : t('Already in archive')); await refresh(); }
          catch (error) { toast((error as Error).message); }
        }),
      button('Open as read-only chat', async () => {
        if (!confirm(t('Open this conversation as a read-only chat?'))) return;
        try {
          const { sessionId } = await request<{ sessionId: string }>('import.openChat', { ref, confirmed: true });
          dialog.close(); host.showTab('chat'); await host.selectChat(sessionId);
        } catch (error) { toast((error as Error).message); }
      }),
      button('Close', () => dialog.close()));
    dialog.append(header, transcript, editor, bar);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal();
  }

  async function refresh(): Promise<void> {
    try { status = await request<BrainImportStatus>('import.status', {}); } catch { status = null; }
    paintCopies();
  }

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  api.onBrainProgress((event: BrainImportProgress) => {
    if (event.phase === 'index') progress.textContent = t('Indexing {0}: {1} of {2}', [event.source, event.done, event.total]);
    else if (event.phase === 'copy' || event.phase === 'verify') progress.textContent = t('Copying {0}…', [event.source]);
    else if (event.phase === 'error') progress.textContent = t('The index could not be built.');
    else progress.textContent = '';
    if (event.phase === 'done' || event.phase === 'error') void refresh();
    else if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 3000);
  });
  form.addEventListener('submit', event => { event.preventDefault(); void search(); });
  paintStatic();
  onLanguageChange(() => { paintStatic(); paintCopies(); paintResults(); });
  void refresh();
  return { refresh };
}
