/**
 * Settings for Chat Marks API chats, inside the CLIProxyAPI module card. The key field only
 * writes: the main process answers whether a key is stored or needed, never the key.
 */
import type { AppApi } from '../preload/index.js';
import type { ApiChatModel, ApiChatStatus } from '../shared/api-chat.js';
import { t, ui } from './i18n.js';

export function createApiChatSettingsUi(api: AppApi, after: HTMLElement): { refresh(): Promise<void> } {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
    Object.assign(document.createElement(tag), props);
  const button = (id: string, text: () => string): HTMLButtonElement => {
    const node = el('button', { type: 'button', className: 'btn' });
    node.id = id;
    ui(node, 'textContent', text);
    return node;
  };
  const label = (text: () => string, control: HTMLElement): HTMLLabelElement => {
    const wrap = el('label', { className: 'setting api-chat-field' });
    const name = el('span', { className: 'setting-text' });
    const bold = el('b');
    ui(bold, 'textContent', text);
    name.append(bold);
    wrap.append(name, control);
    return wrap;
  };

  const surface = el('div', { className: 'settings-surface modules-service api-chat-settings' });
  surface.id = 'apiChatSettings';
  const head = el('div', { className: 'setting-text' });
  const title = el('b');
  ui(title, 'textContent', () => t('Chat with CLIProxy'));
  const hint = el('em');
  ui(hint, 'textContent', () => t("Use CLIProxyAPI models in Chat Marks chats, with this app's local tools."));
  const detection = el('span', { className: 'modules-detail' });
  detection.id = 'apiChatDetection';
  detection.setAttribute('role', 'status');
  head.append(title, hint, detection);

  const endpoint = el('input', { type: 'url', spellcheck: false, autocomplete: 'off' });
  endpoint.id = 'apiChatEndpoint';
  endpoint.setAttribute('translate', 'no');
  const key = el('input', { type: 'password', autocomplete: 'off', spellcheck: false });
  key.id = 'apiChatKey';
  const saveKey = button('apiChatSaveKey', () => t('Save key'));
  const keyState = el('span', { className: 'modules-detail' });
  keyState.id = 'apiChatKeyState';
  const keyRow = el('span', { className: 'api-chat-key' });
  keyRow.append(key, saveKey, keyState);
  const keyNeeded = el('p', { className: 'modules-error api-chat-key-needed', hidden: true });
  keyNeeded.id = 'apiChatKeyNeeded';
  ui(keyNeeded, 'textContent', () => t('CLIProxy asked for an API key. Paste it above to use its models.'));

  const search = el('input', { type: 'search', spellcheck: false, autocomplete: 'off' });
  search.id = 'apiChatModelSearch';
  ui(search, 'placeholder', () => t('Search models'));
  const model = el('select', { className: 'btn' });
  model.id = 'apiChatModel';
  model.setAttribute('translate', 'no');
  const favorite = el('button', { type: 'button', className: 'btn' });
  favorite.id = 'apiChatFavorite';
  const reload = button('apiChatReload', () => t('Refresh list'));
  const modelRow = el('span', { className: 'api-chat-model' });
  modelRow.append(search, model, favorite, reload);
  const effort = el('select', { className: 'btn' });
  effort.id = 'apiChatEffort';
  for (const [value, text] of [['', () => t('Default')], ['low', () => t('Low')], ['medium', () => t('Medium')], ['high', () => t('High')]] as const) {
    const option = el('option', { value });
    ui(option, 'textContent', text);
    effort.append(option);
  }
  const test = button('apiChatTest', () => t('Test connection'));
  const result = el('p', { className: 'modules-detail' });
  result.id = 'apiChatResult';
  result.setAttribute('role', 'status');

  surface.append(head,
    label(() => t('API address'), endpoint),
    label(() => t('API key'), keyRow),
    keyNeeded,
    label(() => t('Default model'), modelRow),
    label(() => t('Reasoning'), effort),
    test, result);
  after.after(surface);

  let status: ApiChatStatus | null = null;
  let models: ApiChatModel[] = [];
  let listError = '';
  const say = (text: string, error = false): void => {
    result.textContent = text;
    result.classList.toggle('modules-error', error);
  };
  const paintStatus = (): void => {
    ui(keyState, 'textContent', () => status?.hasKey ? t('A key is saved') : t('No key saved'));
    keyNeeded.hidden = !status?.keyRequired;
    ui(detection, 'textContent', () => !status || status.detected === null ? ''
      : status.detected ? t('Found at {0} · {1} chat models', [status.endpoint, models.length])
        : listError || t('Nothing answered at {0}', [status.endpoint]));
    detection.classList.toggle('modules-error', status?.detected === false);
    const selected = models.find(item => item.id === status?.model);
    favorite.disabled = !status?.model;
    ui(favorite, 'textContent', () => selected?.favorite ? t('Remove from favorites') : t('Add to favorites'));
  };
  /** ✓ answered on its last real request, ⚠ failed; nothing until a request proves either. */
  const mark = (item: ApiChatModel): string => item.availability ? (item.availability.ok ? ' ✓' : ' ⚠') : '';
  const paintModels = (): void => {
    const needle = search.value.trim().toLowerCase();
    const selected = status?.model ?? '';
    const visible = models.filter(item => !needle || item.id.toLowerCase().includes(needle) || (item.ownedBy ?? '').toLowerCase().includes(needle) || item.id === selected);
    const groups = new Map<string, HTMLOptGroupElement>();
    const group = (name: string): HTMLOptGroupElement => {
      let found = groups.get(name);
      if (!found) groups.set(name, found = el('optgroup', { label: name }));
      return found;
    };
    for (const item of visible) {
      const option = el('option', { value: item.id, textContent: `${item.favorite ? '★ ' : ''}${item.id}${mark(item)}` });
      if (item.availability && !item.availability.ok && item.availability.error) option.title = item.availability.error;
      group(item.favorite ? t('Favorites') : item.recent ? t('Recent') : item.ownedBy ?? t('Other')).append(option);
    }
    const children: HTMLElement[] = [...groups.values()];
    if (selected && !visible.some(item => item.id === selected)) children.unshift(el('option', { value: selected, textContent: selected }));
    if (!selected) children.unshift(el('option', { value: '', textContent: '—' }));
    model.replaceChildren(...children);
    model.value = selected;
    paintStatus();
  };
  const accept = (reply: Awaited<ReturnType<AppApi['apiChatStatus']>>): boolean => {
    if (!reply?.ok) { if (reply) say(reply.error, true); return false; }
    if (!reply.data || typeof reply.data.endpoint !== 'string') return false;
    status = reply.data;
    if (document.activeElement !== endpoint) endpoint.value = status.endpoint;
    effort.value = status.effort ?? '';
    paintModels();
    return true;
  };
  const loadModels = async (refresh = false): Promise<void> => {
    const reply = await api.apiChatModels('', 0, 200, refresh);
    listError = reply?.ok === false ? reply.error : '';
    if (reply?.ok && Array.isArray(reply.data?.models)) models = reply.data.models;
    else if (reply?.ok === false) models = [];
    // Detection is learned from that answer; read it back with the rest of the status.
    accept(await api.apiChatStatus());
  };
  const save = async (settings: Parameters<AppApi['apiChatSetSettings']>[0]): Promise<void> => {
    say('');
    if (accept(await api.apiChatSetSettings(settings)) && 'endpoint' in settings) await loadModels(true);
  };

  endpoint.addEventListener('change', () => void save({ endpoint: endpoint.value }));
  model.addEventListener('change', () => void save({ model: model.value || null }));
  effort.addEventListener('change', () => void save({ effort: (effort.value || null) as ApiChatStatus['effort'] }));
  search.addEventListener('input', paintModels);
  reload.addEventListener('click', () => void loadModels(true));
  favorite.addEventListener('click', async () => {
    if (!status?.model) return;
    if (accept(await api.apiChatToggleFavorite(status.model))) await loadModels();
  });
  saveKey.addEventListener('click', async () => {
    const value = key.value;
    key.value = '';
    say('');
    if (accept(await api.apiChatSetKey(value))) await loadModels(true);
  });
  key.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); saveKey.click(); } });
  test.addEventListener('click', async () => {
    test.disabled = true;
    say(t('Testing…'));
    try {
      const reply = await api.apiChatTest();
      if (reply.ok) say(t('{0} answered.', [reply.data.model])); else say(reply.error, true);
      await loadModels();
      if (status?.keyRequired) key.focus();
    } finally {
      test.disabled = false;
    }
  });

  return {
    async refresh() {
      try {
        if (accept(await api.apiChatStatus())) await loadModels();
      } catch (error) {
        say(error instanceof Error ? error.message : String(error), true);
      }
    }
  };
}
