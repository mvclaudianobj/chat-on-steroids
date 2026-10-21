/**
 * Chat Marks API chats in the normal chat screen. An API chat is an ordinary session: the
 * sidebar lists it and the timeline paints its events. This module owns only what differs:
 * New chat's CLIProxy item, sending and stopping through the executor instead of the ChatGPT
 * outbox, the chat's own model and effort, and hiding the ChatGPT-only controls (`is-api-chat`
 * on the chat panel, styled in settings.css). D4 adds the chat's approval mode and the card that
 * answers a paused edit or command (main owns the pending call; this only shows and answers it).
 * Engines: the New chat and project menu items come from main's engine registry: every enabled,
 * not hidden engine, an unavailable one disabled with its reason. The chat's own engine names the
 * header and chooses which model list to load. A Claude Code chat whose hand-over terminal is still
 * attached offers "Close the terminal and continue here" instead of only refusing the send.
 */
import type { AppApi } from '../preload/index.js';
import { isApiConversationId, type ApiChatApprovalDecision, type ApiChatApprovalMode, type ApiChatEffort, type ApiChatModel, type ApiChatView } from '../shared/api-chat.js';
import {
  AGENT_ENGINE_IDS, AGENT_ENGINE_LABELS, DEFAULT_AGENT_ENGINE, ENGINE_TERMINAL_OPEN_ELSEWHERE, ENGINE_TERMINAL_OPEN_IN_APP,
  type AgentEngineId, type AgentEngineInfo, type AgentEngineTerminalMode
} from '../shared/agent-engine.js';
import { setIcon, toast } from './dom.js';
import { chatTypeIcon, chatTypeMark, chatTypeOf } from './chat-types.js';
import { t, ui } from './i18n.js';
import type { RowMenuItem } from './row-menu.js';

export interface ApiChatUiHooks {
  showTab(name: string): void;
  workspace(): string | null;
  /** The chat the timeline shows, or null for a new chat. */
  selectedChat?(): { id: string; conversationId: string | null; engine?: AgentEngineId } | null;
  /** Shows that session in the normal chat view. */
  selectChat?(id: string): void | Promise<void>;
  /** Shows that module terminal (an engine chat's live or hand-over terminal), by its id. */
  openCliSession?(id: string): void | Promise<void>;
}

export interface ApiChatUi {
  /** New chat's menu items: one per offered engine (`new-chat-engine-<id>`), unavailable ones disabled. */
  newChatItems(): RowMenuItem[];
  /** A project's menu items: a chat of each offered engine that belongs to that project. */
  projectChatItems(projectId: string): RowMenuItem[];
  /** Follows the selected chat: called whenever the chat list or selection repaints. */
  sync(): void;
  create(projectId?: string | null, engine?: AgentEngineId): Promise<void>;
  refresh(): Promise<void>;
}

/** The menu wording of each engine. */
const ENGINE_MENU: Readonly<Record<AgentEngineId, { title(): string; project(): string }>> = {
  cliproxy: { title: () => t('Chat with CLIProxy'), project: () => t('New CLIProxy chat in this project') },
  markscode: { title: () => t('Chat with {0}', [AGENT_ENGINE_LABELS.markscode]), project: () => t('New {0} chat in this project', [AGENT_ENGINE_LABELS.markscode]) },
  codex: { title: () => t('Chat with {0}', [AGENT_ENGINE_LABELS.codex]), project: () => t('New {0} chat in this project', [AGENT_ENGINE_LABELS.codex]) },
  claude: { title: () => t('Chat with {0}', [AGENT_ENGINE_LABELS.claude]), project: () => t('New {0} chat in this project', [AGENT_ENGINE_LABELS.claude]) }
};

/** New chat's engine item ids: their own namespace, never a terminal module's (`new-terminal-<id>`). */
export const engineMenuAction = (id: AgentEngineId): string => `new-chat-engine-${id}`;

export interface OfferedEngine { id: AgentEngineId; available: boolean; detail: string }

/**
 * The engines New chat lists, in the registry's fixed order: every one whose module is enabled
 * (or that is available), except the hidden ones. An unavailable one keeps its reason.
 */
export function offeredEngines(list: unknown): OfferedEngine[] {
  if (!Array.isArray(list)) return [];
  const byId = new Map<AgentEngineId, OfferedEngine>();
  for (const item of list as Partial<AgentEngineInfo>[]) {
    if (!item || typeof item.id !== 'string' || !AGENT_ENGINE_IDS.includes(item.id) || item.hidden === true) continue;
    const available = item.available === true;
    if (!available && item.enabled !== true) continue;
    byId.set(item.id, { id: item.id, available, detail: typeof item.detail === 'string' ? item.detail.slice(0, 200) : '' });
  }
  return AGENT_ENGINE_IDS.flatMap(id => byId.get(id) ?? []);
}

/** An engine listed but not usable now: a disabled item that says why (main's redacted, short detail). */
const unavailable = (detail: string): Pick<RowMenuItem, 'disabled' | 'detail' | 'title'> => {
  const reason = (): string => detail ? t(detail) : t('Not available right now');
  return { disabled: true, detail: reason, title: reason };
};

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
  const approval = document.createElement('select');
  approval.id = 'apiChatComposerApproval';
  ui(approval, 'aria-label', () => t('Edits and commands'));
  ui(approval, 'title', () => t('Edits and commands'));
  for (const [value, text] of [['ask', () => t('Ask before edits and commands')], ['auto', () => t('Run edits and commands automatically')]] as const) {
    const option = document.createElement('option');
    option.value = value;
    ui(option, 'textContent', text);
    approval.append(option);
  }
  // Engines with a terminal: Codex and MarksCode attach their TUI live to the same session,
  // Claude Code hands its session over. One button; its wording and whether it waits for the turn follow the mode.
  const terminal = document.createElement('button');
  terminal.type = 'button';
  terminal.id = 'apiChatTerminal';
  terminal.className = 'btn api-chat-terminal';
  terminal.hidden = true;
  ui(terminal, 'textContent', () => t('Open in terminal'));
  terminal.addEventListener('click', () => void openTerminal());
  controls.append(model, effort, approval, terminal);

  // The paused call of the running turn: tool, readable arguments and the three answers.
  const card = document.createElement('section');
  card.className = 'api-chat-approval';
  card.id = 'apiChatApproval';
  card.hidden = true;
  card.setAttribute('role', 'alertdialog');
  ui(card, 'aria-label', () => t('Approve this action?'));
  const cardTitle = document.createElement('strong');
  const cardTool = document.createElement('code');
  cardTool.setAttribute('translate', 'no');
  const cardSummary = document.createElement('pre');
  cardSummary.setAttribute('translate', 'no');
  const cardFiles = document.createElement('ul');
  cardFiles.setAttribute('translate', 'no');
  const actions = document.createElement('div');
  actions.className = 'api-chat-approval-actions';
  const answer = (decision: ApiChatApprovalDecision, text: () => string, primary = false): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.decision = decision;
    if (primary) button.className = 'primary';
    ui(button, 'textContent', text);
    button.addEventListener('click', () => void decide(decision));
    return button;
  };
  actions.append(answer('approve', () => t('Approve'), true), answer('deny', () => t('Deny')), answer('always', () => t('Approve and don\'t ask again in this chat')));
  // A send refused because the chat's hand-over terminal is attached: the explicit way back.
  const takeBack = document.createElement('section');
  takeBack.className = 'api-chat-approval api-chat-take-back';
  takeBack.id = 'apiChatTakeBack';
  takeBack.hidden = true;
  takeBack.setAttribute('role', 'alertdialog');
  const takeBackText = document.createElement('p');
  takeBackText.className = 'api-chat-take-back-text';
  const takeBackActions = document.createElement('div');
  takeBackActions.className = 'api-chat-approval-actions';
  const takeBackConfirm = document.createElement('button');
  takeBackConfirm.type = 'button';
  takeBackConfirm.className = 'primary';
  takeBackConfirm.id = 'apiChatTakeBackConfirm';
  ui(takeBackConfirm, 'textContent', () => t('Close the terminal and continue here'));
  const takeBackCancel = document.createElement('button');
  takeBackCancel.type = 'button';
  ui(takeBackCancel, 'textContent', () => t('Cancel'));
  takeBackActions.append(takeBackConfirm, takeBackCancel);
  takeBack.append(takeBackText, takeBackActions);
  ui(takeBack, 'aria-label', () => t('Close the terminal and continue here'));
  const head = document.createElement('div');
  head.className = 'api-chat-approval-head';
  head.append(cardTitle, cardTool);
  card.append(head, cardSummary, cardFiles, actions);
  ui(cardTitle, 'textContent', () => t('Approve this action?'));
  // A row of the composer dock, like the queue and plan rows: directly above the composer.
  const dockBody = document.querySelector('#composerDock .composer-dock-body');
  if (dockBody) dockBody.append(card, takeBack);
  else if (composer) composer.before(card, takeBack);
  else host.append(card, takeBack);
  const modelMenu = document.getElementById('modelMenu');
  if (modelMenu?.parentElement) modelMenu.before(controls);
  else composer?.querySelector('.composer-toolbar')?.append(controls);

  const label = document.createElement('span');
  label.className = 'api-chat-label';
  label.id = 'apiChatLabel';
  label.hidden = true;
  label.setAttribute('translate', 'no');
  // The engine's type icon, then its name and the model; the name stays the label's text.
  const labelIcon = chatTypeMark(DEFAULT_AGENT_ENGINE, 'api-chat-label-icon');
  const labelText = document.createElement('span');
  label.append(labelIcon, labelText);
  // The chat's header names its provider and model, where a ChatGPT chat shows its project.
  const chatHead = document.querySelector('.is-session .chat-head');
  const anchor = chatHead?.querySelector('#chatProjectContext') ?? chatHead?.querySelector('#chatTitle');
  if (anchor) anchor.after(label); else chatHead?.prepend(label);
  // An opened ChatGPT chat shows its own type icon before its title (an API chat's is in the label).
  const nativeMark = chatTypeMark('chatgpt', 'chat-head-type');
  nativeMark.hidden = true;
  chatHead?.querySelector('#chatTitle')?.before(nativeMark);

  /** Sessions this window created before the chat list carried their summary. */
  const created = new Set<string>();
  let engines: OfferedEngine[] = [];
  /** The message a refused send left, while the take-back offer shows for that chat. */
  let offer: { sessionId: string; text: string; elsewhere: boolean } | null = null;
  /** Engines whose chats can open a terminal, as main's registry reports them. */
  let terminalEngines = new Map<AgentEngineId, AgentEngineTerminalMode>();
  let shownFor: string | null = null;
  let view: ApiChatView | null = null;
  /** Each engine's chat models, loaded once per engine. */
  const modelsBy = new Map<AgentEngineId, ApiChatModel[]>();
  const modelsLoading = new Set<AgentEngineId>();
  // Before the chat's view answers, the engine the chat list projected for it.
  const engineOf = (): AgentEngineId => view?.engine ?? (shownFor ? hooks.selectedChat?.()?.engine : undefined) ?? DEFAULT_AGENT_ENGINE;
  let busy = false;
  let answering = false;

  const selectedApiChat = (): string | null => {
    const selected = hooks.selectedChat?.() ?? null;
    return selected && (created.has(selected.id) || isApiConversationId(selected.conversationId)) ? selected.id : null;
  };

  function paint(): void {
    const id = shownFor;
    host.classList.toggle('is-api-chat', !!id);
    controls.hidden = !id;
    label.hidden = !id;
    const selected = id ? null : hooks.selectedChat?.() ?? null;
    nativeMark.hidden = !!id || !selected || chatTypeOf(selected) !== 'chatgpt';
    paintApproval(id ? view?.pending ?? null : null);
    paintTakeBack();
    if (!id) return;
    setIcon(labelIcon, chatTypeIcon(engineOf()), 'ico chat-type-icon api-chat-label-icon');
    labelIcon.dataset.chatType = engineOf();
    labelText.textContent = `${AGENT_ENGINE_LABELS[engineOf()] ?? AGENT_ENGINE_LABELS.cliproxy} · ${view?.model ?? '—'}`;
    const models = modelsBy.get(engineOf()) ?? [];
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
    approval.value = view?.approval ?? 'ask';
    model.disabled = !view || busy;
    effort.disabled = !view || busy;
    approval.disabled = !view || busy;
    // A CLI engine lists each model's own efforts; the ones that model lacks are not offered.
    const efforts = models.find(item => item.id === current)?.efforts;
    for (const choice of effort.options) choice.disabled = !!choice.value && !!efforts?.length && !efforts.includes(choice.value);
    const mode = terminalEngines.get(engineOf()) ?? null;
    terminal.hidden = !view || !mode;
    // A hand-over stops the app's own session, so it waits for the turn; a live attach does not.
    terminal.disabled = !view || busy || (mode === 'handover' && view.running);
    terminal.title = mode === 'live'
      ? t("Open this chat's {0} session in a terminal", [AGENT_ENGINE_LABELS[engineOf()]])
      : t('Continue this chat in a terminal. The app stops its own session first; your next message here resumes it.');
  }

  async function openTerminal(): Promise<void> {
    const id = shownFor;
    if (!id || busy) return;
    busy = true;
    paint();
    try {
      const reply = await api.apiChatTerminal(id);
      if (!reply.ok) toast(t(reply.error));
      else await hooks.openCliSession?.(reply.data.cliSessionId);
    } finally {
      busy = false;
      paint();
    }
  }

  function paintTakeBack(): void {
    const shown = !!offer && offer.sessionId === shownFor;
    takeBack.hidden = !shown;
    if (!shown) return;
    takeBackText.textContent = t(offer!.elsewhere ? ENGINE_TERMINAL_OPEN_ELSEWHERE : ENGINE_TERMINAL_OPEN_IN_APP);
    takeBackConfirm.disabled = busy;
    takeBackCancel.disabled = busy;
  }

  /** Sends the chat's message; a refusal for an attached hand-over terminal becomes the offer. */
  async function sendText(id: string, text: string, takeBackTerminal = false): Promise<void> {
    const reply = await (takeBackTerminal ? api.apiChatSend(id, text, { takeBackTerminal: true }) : api.apiChatSend(id, text))
      .catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    if (!reply.ok) {
      const elsewhere = reply.error === ENGINE_TERMINAL_OPEN_ELSEWHERE;
      if (elsewhere || reply.error === ENGINE_TERMINAL_OPEN_IN_APP) { offer = { sessionId: id, text, elsewhere }; paint(); return; }
      toast(t(reply.error));
      return;
    }
    if (offer?.sessionId === id) offer = null;
    if (input && selectedApiChat() === id && input.value.trim() === text) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    paint();
  }

  // Only this explicit action closes the terminal: main detaches the app's view, ends the
  // terminal's Claude Code (the session is saved) and resumes the chat with the message.
  takeBackConfirm.addEventListener('click', () => {
    const pending = offer;
    if (!pending || busy) return;
    busy = true;
    paint();
    // The composer's text as it is now (it may have been edited since), else the refused message.
    const text = (selectedApiChat() === pending.sessionId ? input?.value.trim() : '') || pending.text;
    void sendText(pending.sessionId, text, true).finally(() => { busy = false; paint(); });
  });
  takeBackCancel.addEventListener('click', () => { offer = null; paint(); input?.focus(); });

  function paintApproval(pending: ApiChatView['pending'] | null): void {
    card.hidden = !pending;
    if (!pending) { delete card.dataset.approvalId; return; }
    card.dataset.approvalId = pending.approvalId;
    cardTool.textContent = pending.tool;
    cardSummary.textContent = pending.summary;
    cardFiles.replaceChildren(...pending.files.map(file => Object.assign(document.createElement('li'), { textContent: file })));
    cardFiles.hidden = !pending.files.length;
    for (const button of actions.querySelectorAll('button')) button.disabled = answering;
  }

  /** Answers exactly the call the card shows; main refuses a stale id. */
  async function decide(decision: ApiChatApprovalDecision): Promise<void> {
    const id = shownFor;
    const approvalId = card.dataset.approvalId;
    if (!id || !approvalId || answering) return;
    answering = true;
    paint();
    try {
      const reply = await api.apiChatApprove(id, approvalId, decision);
      if (!reply.ok) toast(t(reply.error));
      else if (shownFor === id) view = reply.data;
    } finally {
      answering = false;
      paint();
    }
  }

  async function loadView(id: string): Promise<void> {
    const reply = await api.apiChatChatSettings(id).catch(() => null);
    if (shownFor !== id) return;
    if (reply?.ok) view = reply.data;
    void loadModels(engineOf());
    paint();
  }

  /** The chat's own engine decides which list its model select shows. */
  async function loadModels(engine: AgentEngineId): Promise<void> {
    if (modelsBy.has(engine) || modelsLoading.has(engine)) return;
    modelsLoading.add(engine);
    const reply = await api.apiChatModels('', 0, 200, false, engine).catch(() => null);
    modelsLoading.delete(engine);
    if (reply?.ok && Array.isArray(reply.data?.models)) modelsBy.set(engine, reply.data.models.filter(item => item.modality === 'chat'));
    paint();
  }

  function sync(): void {
    const id = selectedApiChat();
    if (id !== shownFor) {
      shownFor = id;
      view = null;
      if (id) void loadView(id);
    }
    paint();
  }

  async function change(settings: { model?: string; effort?: ApiChatEffort | null; approval?: ApiChatApprovalMode }): Promise<void> {
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
  approval.addEventListener('change', () => void change({ approval: approval.value === 'auto' ? 'auto' : 'ask' }));

  function openSettings(message: string): void {
    toast(message);
    hooks.showTab('modules');
    document.getElementById('apiChatSettings')?.scrollIntoView?.({ block: 'start' });
  }

  /** `projectId` is the project whose menu was used; New chat uses the selected workspace. */
  async function create(projectId?: string | null, engine: AgentEngineId = DEFAULT_AGENT_ENGINE): Promise<void> {
    if (engine === 'cliproxy') {
      // CLIProxy's own setup: a missing key or default model is fixed in Settings > Modules.
      const status = await api.apiChatStatus().catch(() => null);
      if (!status?.ok) { openSettings(status?.error ?? t('CLIProxy is not set up yet.')); return; }
      if (status.data.keyRequired && !status.data.hasKey) { openSettings(t('CLIProxy needs an API key. Add it in Settings > Modules.')); return; }
      if (!status.data.model) { openSettings(t('Choose a default CLIProxy model in Settings > Modules first.')); return; }
    }
    const target = projectId === undefined ? hooks.workspace() : projectId;
    const reply = await api.apiChatCreate(engine === 'cliproxy' ? { projectId: target } : { projectId: target, engine });
    if (!reply.ok) { toast(t(reply.error)); return; }
    created.add(reply.data.sessionId);
    hooks.showTab('chat');
    await hooks.selectChat?.(reply.data.sessionId);
    shownFor = reply.data.sessionId;
    view = reply.data;
    void loadModels(engineOf());
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
    void sendText(id, text);
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

  /** Main's registry says which engines a new chat can use; nothing is offered until it answers. */
  async function refresh(): Promise<void> {
    const reply = await api.apiChatEngines?.().catch(() => null);
    const next = reply?.ok ? offeredEngines(reply.data) : [];
    terminalEngines = new Map(reply?.ok && Array.isArray(reply.data) ? reply.data.filter(item => item?.terminal).map(item => [item.id, item.terminal!] as const) : []);
    if (JSON.stringify(next) !== JSON.stringify(engines)) { engines = next; onAvailability(); }
    paint();
  }
  void refresh();

  return {
    newChatItems: () => engines.map(({ id, available, detail }): RowMenuItem => ({
      action: engineMenuAction(id), icon: chatTypeIcon(id), label: () => AGENT_ENGINE_LABELS[id],
      ...(available ? { title: ENGINE_MENU[id].title } : unavailable(detail)),
      run: () => void create(undefined, id)
    })),
    projectChatItems: projectId => engines.map(({ id, available, detail }): RowMenuItem => ({
      action: engineMenuAction(id), icon: chatTypeIcon(id), label: ENGINE_MENU[id].project,
      ...(available ? {} : unavailable(detail)),
      run: () => void create(projectId, id)
    })),
    sync,
    create,
    refresh
  };
}
