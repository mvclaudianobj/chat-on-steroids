/**
 * Chat Marks API chats in the normal chat screen. An API chat is an ordinary session: the
 * sidebar lists it and the timeline paints its events. This module owns only what differs:
 * New chat's CLIProxy item, sending and stopping through the executor instead of the ChatGPT
 * outbox, the chat's own model and effort, and hiding the ChatGPT-only controls (`is-api-chat`
 * on the chat panel, styled in settings.css).
 */
import type { AppApi } from '../preload/index.js';
import { isApiConversationId, type ApiChatEffort, type ApiChatModel, type ApiChatView } from '../shared/api-chat.js';
import { toast } from './dom.js';
import { t, ui } from './i18n.js';
import type { RowMenuItem } from './row-menu.js';

export interface ApiChatUiHooks {
  showTab(name: string): void;
  workspace(): string | null;
  /** The chat the timeline shows, or null for a new chat. */
  selectedChat?(): { id: string; conversationId: string | null } | null;
  /** Shows that session in the normal chat view. */
  selectChat?(id: string): void | Promise<void>;
}

export interface ApiChatUi {
  /** New chat's menu items: CLIProxy once its settings answered. */
  newChatItems(): RowMenuItem[];
  /** Follows the selected chat: called whenever the chat list or selection repaints. */
  sync(): void;
  create(): Promise<void>;
  refresh(): Promise<void>;
}

export function createApiChatUi(api: AppApi, hooks: ApiChatUiHooks, onAvailability: () => void = () => undefined): ApiChatUi {
  const host = document.querySelector<HTMLElement>('[data-panel="chat"]') ?? document.body;
  const composer = document.getElementById('composer') as HTMLFormElement | null;
  const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
  const send = document.getElementById('chatSend') as HTMLButtonElement | null;

  const controls = document.createElement('div');
  controls.className = 'api-chat-controls';
  controls.id = 'apiChatControls';
  controls.hidden = true;
  const model = document.createElement('select');
  model.id = 'apiChatComposerModel';
  model.setAttribute('translate', 'no');
  ui(model, 'aria-label', () => t('CLIProxy model'));
  ui(model, 'title', () => t('CLIProxy model'));
  const effort = document.createElement('select');
  effort.id = 'apiChatComposerEffort';
  ui(effort, 'aria-label', () => t('Reasoning'));
  ui(effort, 'title', () => t('Reasoning'));
  for (const [value, text] of [['', () => t('Default')], ['low', () => t('Low')], ['medium', () => t('Medium')], ['high', () => t('High')]] as const) {
    const option = document.createElement('option');
    option.value = value;
    ui(option, 'textContent', text);
    effort.append(option);
  }
  controls.append(model, effort);
  const modelMenu = document.getElementById('modelMenu');
  if (modelMenu?.parentElement) modelMenu.before(controls);
  else composer?.querySelector('.composer-toolbar')?.append(controls);

  const label = document.createElement('span');
  label.className = 'api-chat-label';
  label.id = 'apiChatLabel';
  label.hidden = true;
  label.setAttribute('translate', 'no');
  // The chat's header names its provider and model, where a ChatGPT chat shows its project.
  const head = document.querySelector('.is-session .chat-head');
  const anchor = head?.querySelector('#chatProjectContext') ?? head?.querySelector('#chatTitle');
  if (anchor) anchor.after(label); else head?.prepend(label);

  /** Sessions this window created before the chat list carried their summary. */
  const created = new Set<string>();
  let available = false;
  let shownFor: string | null = null;
  let view: ApiChatView | null = null;
  let models: ApiChatModel[] = [];
  let modelsLoaded = false;
  let busy = false;

  const selectedApiChat = (): string | null => {
    const selected = hooks.selectedChat?.() ?? null;
    return selected && (created.has(selected.id) || isApiConversationId(selected.conversationId)) ? selected.id : null;
  };

  function paint(): void {
    const id = shownFor;
    host.classList.toggle('is-api-chat', !!id);
    controls.hidden = !id;
    label.hidden = !id;
    if (!id) return;
    label.textContent = `CLIProxy · ${view?.model ?? '—'}`;
    const current = view?.model ?? '';
    const options: HTMLOptionElement[] = [];
    const option = (value: string, text: string): HTMLOptionElement => Object.assign(document.createElement('option'), { value, textContent: text });
    if (!current) options.push(option('', '—'));
    if (current && !models.some(item => item.id === current)) options.push(option(current, current));
    // Favorites and recents first, as the catalog returns them.
    for (const item of models) options.push(option(item.id, `${item.favorite ? '★ ' : ''}${item.id}`));
    model.replaceChildren(...options);
    model.value = current;
    effort.value = view?.effort ?? '';
    model.disabled = !view || busy;
    effort.disabled = !view || busy;
  }

  async function loadView(id: string): Promise<void> {
    const reply = await api.apiChatChatSettings(id).catch(() => null);
    if (shownFor !== id) return;
    if (reply?.ok) view = reply.data;
    paint();
  }

  async function loadModels(): Promise<void> {
    if (modelsLoaded) return;
    modelsLoaded = true;
    const reply = await api.apiChatModels('', 0, 200, false).catch(() => null);
    if (reply?.ok && Array.isArray(reply.data?.models)) models = reply.data.models.filter(item => item.modality === 'chat');
    else modelsLoaded = false;
    paint();
  }

  function sync(): void {
    const id = selectedApiChat();
    if (id !== shownFor) {
      shownFor = id;
      view = null;
      if (id) { void loadView(id); void loadModels(); }
    }
    paint();
  }

  async function change(settings: { model?: string; effort?: ApiChatEffort | null }): Promise<void> {
    const id = shownFor;
    if (!id) return;
    busy = true;
    paint();
    try {
      const reply = await api.apiChatSetChatSettings(id, settings);
      if (!reply.ok) toast(t(reply.error));
      else if (shownFor === id) view = reply.data;
    } finally {
      busy = false;
      paint();
    }
  }
  model.addEventListener('change', () => { if (model.value) void change({ model: model.value }); });
  effort.addEventListener('change', () => void change({ effort: (effort.value || null) as ApiChatEffort | null }));

  function openSettings(message: string): void {
    toast(message);
    hooks.showTab('modules');
    document.getElementById('apiChatSettings')?.scrollIntoView?.({ block: 'start' });
  }

  async function create(): Promise<void> {
    const status = await api.apiChatStatus().catch(() => null);
    if (!status?.ok) { openSettings(status?.error ?? t('CLIProxy is not set up yet.')); return; }
    if (status.data.keyRequired && !status.data.hasKey) { openSettings(t('CLIProxy needs an API key. Add it in Settings > Modules.')); return; }
    if (!status.data.model) { openSettings(t('Choose a default CLIProxy model in Settings > Modules first.')); return; }
    const reply = await api.apiChatCreate({ projectId: hooks.workspace() });
    if (!reply.ok) { toast(t(reply.error)); return; }
    created.add(reply.data.sessionId);
    hooks.showTab('chat');
    await hooks.selectChat?.(reply.data.sessionId);
    shownFor = reply.data.sessionId;
    view = reply.data;
    void loadModels();
    paint();
    input?.focus();
  }

  // The composer belongs to the selected chat: an API chat sends and stops through its executor,
  // never the ChatGPT outbox (which refuses it). This listens before the composer's own handler.
  document.addEventListener('submit', event => {
    if (event.target !== composer) return;
    const id = selectedApiChat();
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    const stop = (event as SubmitEvent).submitter === send && send?.dataset.action === 'stop';
    if (stop) { void api.apiChatStop(id).then(reply => { if (!reply.ok) toast(t(reply.error)); }); return; }
    const text = input?.value.trim() ?? '';
    if (!text) return;
    if (document.querySelector('#composerImages > *')) { toast(t('Attachments are not available in CLIProxy chats yet.')); return; }
    void (async () => {
      const reply = await api.apiChatSend(id, text).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
      if (!reply.ok) { toast(t(reply.error)); return; }
      if (input && selectedApiChat() === id && input.value.trim() === text) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })();
  }, { capture: true });

  // Skills and @file mentions are ChatGPT tools, and their menu is hidden here: Enter must not
  // pick an invisible choice when a message starts with "/" or contains "@".
  document.addEventListener('keydown', event => {
    if (event.target !== input || event.key !== 'Enter' || event.shiftKey || event.isComposing || !selectedApiChat()) return;
    if (document.getElementById('skillPicker')?.hidden !== false) return;
    event.preventDefault();
    event.stopPropagation();
    composer?.requestSubmit();
  }, { capture: true });

  api.onSessionChanged?.(notice => {
    if (shownFor && (!notice?.sessionIds || notice.sessionIds.includes(shownFor))) void loadView(shownFor);
  });

  async function refresh(): Promise<void> {
    const reply = await api.apiChatStatus?.().catch(() => null);
    const next = !!reply?.ok && !!reply.data?.endpoint;
    if (next !== available) { available = next; onAvailability(); }
  }
  void refresh();

  return {
    newChatItems: () => available ? [{
      action: 'new-chat-cliproxy', icon: 'i-chat', label: () => 'CLIProxy', title: () => t('Chat with CLIProxy'),
      run: () => void create()
    }] : [],
    sync,
    create,
    refresh
  };
}
