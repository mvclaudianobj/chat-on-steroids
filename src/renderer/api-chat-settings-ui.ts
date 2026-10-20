/**
 * Settings for Chat Marks API chats, inside the CLIProxyAPI module card. The key field only
 * writes: the main process answers whether a key is stored, never the key.
 */
import type { AppApi } from '../preload/index.js';
import type { ApiChatModel, ApiChatStatus } from '../shared/api-chat.js';
import { t, ui } from './i18n.js';

export function createApiChatSettingsUi(api: AppApi, after: HTMLElement): { refresh(): Promise<void> } {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
    Object.assign(document.createElement(tag), props);
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
  head.append(title, hint);

  const endpoint = el('input', { type: 'url', spellcheck: false, autocomplete: 'off' });
  endpoint.id = 'apiChatEndpoint';
  endpoint.setAttribute('translate', 'no');
  const key = el('input', { type: 'password', autocomplete: 'off', spellcheck: false });
  key.id = 'apiChatKey';
  const saveKey = el('button', { type: 'button', className: 'btn' });
  saveKey.id = 'apiChatSaveKey';
  ui(saveKey, 'textContent', () => t('Save key'));
  const keyState = el('span', { className: 'modules-detail' });
  keyState.id = 'apiChatKeyState';
  const keyRow = el('span', { className: 'api-chat-key' });
  keyRow.append(key, saveKey, keyState);

  const search = el('input', { type: 'search', spellcheck: false, autocomplete: 'off' });
  search.id = 'apiChatModelSearch';
  ui(search, 'placeholder', () => t('Search models'));
  const model = el('select', { className: 'btn' });
  model.id = 'apiChatModel';
  const modelRow = el('span', { className: 'api-chat-model' });
  modelRow.append(search, model);
  const effort = el('select', { className: 'btn' });
  effort.id = 'apiChatEffort';
  for (const [value, text] of [['', () => t('Default')], ['low', () => t('Low')], ['medium', () => t('Medium')], ['high', () => t('High')]] as const) {
    const option = el('option', { value });
    ui(option, 'textContent', text);
    effort.append(option);
  }
  const test = el('button', { type: 'button', className: 'btn' });
  test.id = 'apiChatTest';
  ui(test, 'textContent', () => t('Test connection'));
  const result = el('p', { className: 'modules-detail' });
  result.id = 'apiChatResult';
  result.setAttribute('role', 'status');

  surface.append(head,
    label(() => t('API address'), endpoint),
    label(() => t('API key'), keyRow),
    label(() => t('Default model'), modelRow),
    label(() => t('Reasoning'), effort),
    test, result);
  after.after(surface);

  let status: ApiChatStatus | null = null;
  let models: ApiChatModel[] = [];
  const say = (text: string, error = false): void => {
    result.textContent = text;
    result.classList.toggle('modules-error', error);
  };
  const paintKey = (): void => {
    ui(keyState, 'textContent', () => status?.hasKey ? t('A key is saved') : t('No key saved'));
  };
  const paintModels = (): void => {
    const needle = search.value.trim().toLowerCase();
    const selected = status?.model ?? '';
    const visible = models.filter(item => !needle || item.id.toLowerCase().includes(needle) || item.id === selected);
    const options = visible.map(item => el('option', { value: item.id, textContent: item.ownedBy ? `${item.id} · ${item.ownedBy}` : item.id }));
    if (selected && !visible.some(item => item.id === selected)) options.unshift(el('option', { value: selected, textContent: selected }));
    if (!selected) options.unshift(el('option', { value: '', textContent: '—' }));
    model.replaceChildren(...options);
    model.value = selected;
  };
  const accept = (reply: Awaited<ReturnType<AppApi['apiChatStatus']>>): boolean => {
    if (!reply?.ok) { if (reply) say(reply.error, true); return false; }
    if (!reply.data || typeof reply.data.endpoint !== 'string') return false;
    status = reply.data;
    if (document.activeElement !== endpoint) endpoint.value = status.endpoint;
    effort.value = status.effort ?? '';
    paintKey();
    paintModels();
    return true;
  };
  const loadModels = async (): Promise<void> => {
    const reply = await api.apiChatModels('', 0, 200);
    if (!reply?.ok) { if (reply) say(reply.error, true); return; }
    if (!Array.isArray(reply.data?.models)) return;
    models = reply.data.models;
    paintModels();
  };
  const save = async (settings: Parameters<AppApi['apiChatSetSettings']>[0]): Promise<void> => {
    say('');
    if (accept(await api.apiChatSetSettings(settings)) && 'endpoint' in settings) await loadModels();
  };

  endpoint.addEventListener('change', () => void save({ endpoint: endpoint.value }));
  model.addEventListener('change', () => void save({ model: model.value || null }));
  effort.addEventListener('change', () => void save({ effort: (effort.value || null) as ApiChatStatus['effort'] }));
  search.addEventListener('input', paintModels);
  saveKey.addEventListener('click', async () => {
    const value = key.value;
    key.value = '';
    say('');
    accept(await api.apiChatSetKey(value));
  });
  key.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); saveKey.click(); } });
  test.addEventListener('click', async () => {
    test.disabled = true;
    say(t('Testing…'));
    try {
      const reply = await api.apiChatTest();
      if (reply.ok) say(t('{0} answered.', [reply.data.model])); else say(reply.error, true);
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
