import type { AppApi } from '../preload/index.js';
import type { CliSession } from '../main/cli-modules.js';
import { createWorkspaceTerminal, type TerminalTransport } from './workspace-terminal.js';
import { openRowMenu, type RowMenuItem } from './row-menu.js';
import { t, ui } from './i18n.js';
import { chatTypeIcon, chatTypeMark, moduleMark } from './chat-types.js';
import { createUpstreamManageUi, type UpstreamManageUi } from './upstream-manage-ui.js';
import type { CliModuleStatus } from '../main/cli-modules.js';

/** cli-modules' CLI_IDS order. MarksCode and MarksClaw are retired: shown only while active or running. */
const IDS = ['opencode', 'codex', 'claude', 'zeroclaw', 'markscode', 'marksclaw'] as const;
type Id = typeof IDS[number];
type Status = CliModuleStatus;
const NAMES: Readonly<Record<Id, string>> = {
  opencode: 'OpenCode', codex: 'Codex', claude: 'Claude', zeroclaw: 'ZeroClaw', markscode: 'MarksCode', marksclaw: 'MarksClaw'
};
const LEGACY: ReadonlySet<Id> = new Set(['markscode', 'marksclaw']);
const UPSTREAM = (id: Id): id is 'opencode' | 'zeroclaw' => id === 'opencode' || id === 'zeroclaw';
/**
 * Modules that are terminal types (New chat, the project's New terminal, the sidebar Terminals).
 * ZeroClaw is not: it is an autonomous agent the user configures from its own Settings page,
 * whose Configure agent terminal opens there and is never listed as a terminal.
 */
export const TERMINAL_MODULE = (id: string): boolean => IDS.includes(id as Id) && !LEGACY.has(id as Id) && id !== 'zeroclaw';
export type CliModuleSummary = { id: string; name: string; enabled: boolean };

export function createCliModulesUi(api: AppApi, hooks: {
  showTab(name: string): void; openChatView(name: string): void; workspace(): string | null; newChatItems?(): RowMenuItem[];
  /** After an upstream module (OpenCode) was installed or updated: the chat engines are listed again. */
  onEngineService?(): void;
}) {
  const nav = document.getElementById('moduleCliNav')!;
  const tabs = nav.parentElement!;
  const parent = document.querySelector('[data-panel="modules"] .appearance-content')!;
  const panels = document.querySelector('[data-panel="modules"]')!.parentElement!;
  const sidebar = document.getElementById('cliModuleChats')!;
  const sidebarPrimary = document.getElementById('sidebarPrimary')!;
  const newChatBtn = document.getElementById('newChat')!;
  const chatBody = document.getElementById('chatBody')!;
  const composer = document.getElementById('composer');
  const composerDock = document.getElementById('composerDock');
  const subhead = document.querySelector<HTMLElement>('.is-session .subhead');
  const chatHead = document.querySelector<HTMLElement>('.is-session .chat-head');
  const text = (tag: string, content: string, className = ''): HTMLElement => {
    const el = document.createElement(tag); el.textContent = content; el.className = className; return el;
  };
  const moduleView = document.createElement('div');
  moduleView.className = 'view cli-module-view';
  moduleView.dataset.view = 'cli-module';
  moduleView.hidden = true;
  const moduleTerminal = document.createElement('div');
  moduleTerminal.className = 'marks-cli-terminal';
  moduleView.append(moduleTerminal);
  chatBody.append(moduleView);
  const rows = new Map<Id, { navigation: HTMLButtonElement; panel: HTMLElement; row: HTMLElement; active: HTMLInputElement; detail: HTMLElement; output: HTMLElement; project: HTMLSelectElement; manage: UpstreamManageUi | null }>();
  const current = new Map<Id, Status>();
  const sessions = new Map<string, CliSession>();
  const terminalManagers = new Map<string, ReturnType<typeof createWorkspaceTerminal>>();
  const terminalMounts = new Map<string, HTMLElement>();
  const sessionButtons = new Map<string, HTMLButtonElement>();
  let selectedSessionId: string | null = null;
  let zeroclaw: { status: HTMLElement; versions: HTMLElement; output: HTMLElement; terminal: HTMLElement; facts: HTMLElement; close: HTMLButtonElement } | null = null;

  /** ZeroClaw's Settings page: an area that grows with its settings over time. */
  function zeroclawPage(content: HTMLElement): void {
    const section = (titleText: () => string, intro: () => string): { box: HTMLElement; surface: HTMLElement } => {
      const box = document.createElement('section'); box.className = 'appearance-section';
      const head = document.createElement('header'); head.className = 'settings-section-head';
      const wrap = document.createElement('div');
      const h2 = document.createElement('h2'); ui(h2, 'textContent', titleText);
      const p = document.createElement('p'); ui(p, 'textContent', intro);
      wrap.append(h2, p); head.append(wrap);
      const surface = document.createElement('div'); surface.className = 'settings-surface modules-service';
      box.append(head, surface); content.append(box);
      return { box, surface };
    };
    const lead = document.createElement('p'); lead.className = 'modules-detail';
    ui(lead, 'textContent', () => t('An autonomous agent you configure here. It is not a chat or a terminal type.'));
    content.append(lead);
    const status = section(() => t('Status'), () => t('Installed version and the module\'s state. Install and update it in Settings > Modules.'));
    const statusLine = text('p', '', 'modules-detail'); statusLine.id = 'zeroclawPageStatus';
    const versions = text('p', '', 'modules-detail'); versions.id = 'zeroclawPageVersions';
    status.surface.append(statusLine, versions);
    const agent = section(() => t('Agent'), () => t('Create or change your agent with ZeroClaw\'s own guided setup (zeroclaw quickstart).'));
    const configure = document.createElement('button'); configure.type = 'button'; configure.className = 'btn primary'; configure.id = 'zeroclawConfigure';
    ui(configure, 'textContent', () => t('Configure agent'));
    configure.addEventListener('click', () => void openZeroClawSetup());
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn'; close.id = 'zeroclawConfigureClose'; close.hidden = true;
    ui(close, 'textContent', () => t('Close setup view'));
    close.addEventListener('click', () => { for (const session of sessions.values()) if (session.module === 'zeroclaw') void disconnect(session.id); terminal.hidden = true; close.hidden = true; });
    const controls = document.createElement('div'); controls.className = 'modules-service-actions'; controls.append(configure, close);
    const output = text('p', '', 'modules-detail'); output.id = 'zeroclawConfigureStatus'; output.setAttribute('role', 'status');
    const terminal = document.createElement('div'); terminal.className = 'marks-cli-terminal zeroclaw-setup-terminal'; terminal.id = 'zeroclawSetupTerminal'; terminal.hidden = true;
    agent.surface.append(controls, output, terminal);
    const settings = section(() => t('Settings'), () => t('Key facts of your ZeroClaw setup, read from ZeroClaw itself. More settings will appear here over time.'));
    const facts = document.createElement('dl'); facts.className = 'zeroclaw-facts'; facts.id = 'zeroclawFacts';
    const refreshFacts = document.createElement('button'); refreshFacts.type = 'button'; refreshFacts.className = 'btn'; refreshFacts.id = 'zeroclawFactsRefresh';
    ui(refreshFacts, 'textContent', () => t('Refresh'));
    refreshFacts.addEventListener('click', () => void paintZeroClawFacts());
    const factsActions = document.createElement('div'); factsActions.className = 'modules-service-actions'; factsActions.append(refreshFacts);
    settings.surface.append(facts, factsActions);
    zeroclaw = { status: statusLine, versions, output, terminal, facts, close };
  }

  async function paintZeroClawFacts(): Promise<void> {
    if (!zeroclaw || typeof api.upstreamZeroClawFacts !== 'function') return;
    const reply = await api.upstreamZeroClawFacts();
    const list = zeroclaw.facts;
    list.replaceChildren();
    const add = (term: string, value: string): void => {
      const dt = document.createElement('dt'); dt.textContent = term;
      const dd = document.createElement('dd'); dd.textContent = value; dd.translate = false;
      list.append(dt, dd);
    };
    if (!reply.ok) { add(t('Settings'), reply.error); return; }
    const facts = reply.data;
    if (facts.error === 'not_installed') { add(t('Settings'), t('Install and enable ZeroClaw to see its settings.')); return; }
    if (!facts.configured) { add(t('Settings'), t('Not configured yet. Use Configure agent to create your first agent.')); return; }
    if (facts.error) { add(t('Settings'), t('ZeroClaw did not answer; try Refresh.')); return; }
    const none = '—';
    add(t('Agents'), facts.agents.length ? facts.agents.map(agent => agent.alias).join(', ') : t('None yet'));
    for (const agent of facts.agents) {
      add(t('Agent {0}', [agent.alias]), [
        `${t('Model provider')}: ${agent.provider ?? t('not set')}`,
        `${t('Memory')}: ${agent.memory ?? none}`,
        agent.enabled === false ? t('Disabled') : ''
      ].filter(Boolean).join(' · '));
    }
    add(t('Runtime'), facts.runtime ?? none);
    add(t('Gateway'), facts.gateway ?? none);
    add(t('Cost limits'), facts.dailyLimitUsd !== null || facts.monthlyLimitUsd !== null
      ? t('{0} per day, {1} per month', [facts.dailyLimitUsd !== null ? `$${facts.dailyLimitUsd.toFixed(2)}` : none, facts.monthlyLimitUsd !== null ? `$${facts.monthlyLimitUsd.toFixed(2)}` : none]) : none);
  }

  function paintZeroClawStatus(): void {
    if (!zeroclaw) return;
    const status = current.get('zeroclaw');
    zeroclaw.status.textContent = status ? `${status.version ?? t('Not installed')} · ${status.detail}` : '';
    const versions = rows.get('zeroclaw')?.manage?.status?.versions;
    zeroclaw.versions.textContent = versions
      ? `${t('Installed version')}: ${versions.installed ?? versions.unmanaged ?? t('Not installed')} · ${t('Latest release')}: ${versions.latest ?? '—'}${versions.updateAvailable ? ` · ${t('Update available')}` : ''}`
      : '';
  }

  /** Configure agent: ZeroClaw's quickstart in a terminal inside its page (one, reused), never listed under Terminals. */
  async function openZeroClawSetup(): Promise<void> {
    if (!zeroclaw) return;
    if (!current.get('zeroclaw')?.enabled) { zeroclaw.output.textContent = t('Enable this module first.'); return; }
    let session = [...sessions.values()].find(candidate => candidate.module === 'zeroclaw' && candidate.args?.[0] === 'quickstart');
    if (!session) {
      const reply = await api.cliCreateSession('zeroclaw', null, 'quickstart');
      if (!reply.ok) { zeroclaw.output.textContent = reply.error; return; }
      session = reply.data;
      sessions.set(session.id, session);
    }
    zeroclaw.output.textContent = '';
    zeroclaw.terminal.hidden = false;
    zeroclaw.close.hidden = false;
    const manager = managerFor(session, zeroclaw.terminal);
    const mount = terminalMounts.get(session.id)!;
    mount.hidden = false;
    manager.show(mount, true);
  }

  for (const id of IDS) {
    const name = NAMES[id];
    const navigation = document.createElement('button');
    navigation.type = 'button'; navigation.className = 'modules-subnav'; navigation.dataset.modulePage = `module-${id}`;
    navigation.setAttribute('aria-label', name); navigation.translate = false;
    // Every module's management entry shows its own icon, like CLIProxyAPI's plug.
    navigation.append(moduleMark(id), text('span', name)); navigation.hidden = true;
    tabs.insertBefore(navigation, nav.nextSibling);
    const row = document.createElement('section'); row.className = 'appearance-section';
    row.dataset.cliModule = id;
    // Retired forks stay out of sight unless still active or running (refresh below).
    row.hidden = LEGACY.has(id);
    const title = text('h2', name);
    title.prepend(moduleMark(id));
    row.append(title);
    const surface = document.createElement('div'); surface.className = 'settings-surface modules-service';
    const enableLabel = document.createElement('label'); enableLabel.className = 'setting modules-toggle';
    enableLabel.append(text('span', 'Activate module', 'setting-text'));
    const activeCheck = document.createElement('input'); activeCheck.type = 'checkbox'; enableLabel.append(activeCheck);
    const detail = text('p', 'Checking installation…', 'modules-detail');
    const actions = document.createElement('div'); actions.className = 'modules-service-actions';
    // Upstream modules install and update their official release from their own versions block;
    // the retired forks only keep Stop.
    const operations = LEGACY.has(id) || UPSTREAM(id) ? ['stop'] as const : ['install', 'update', 'stop'] as const;
    for (const action of operations) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn';
      button.textContent = action === 'install' ? 'Install / instructions' : action === 'update' ? 'Update' : 'Stop session';
      button.addEventListener('click', () => void operate(id, action)); actions.append(button);
    }
    surface.append(enableLabel, detail, actions); row.append(surface); parent.append(row);
    const manage = UPSTREAM(id) ? createUpstreamManageUi(api, id, surface, () => { void refresh(); hooks.onEngineService?.(); }) : null;

    const panel = document.createElement('section'); panel.className = 'panel appearance-panel modules-panel scroll';
    panel.dataset.panel = `module-${id}`;
    const content = document.createElement('div'); content.className = 'appearance-content settings-page-content';
    const pageTitle = text('h1', name);
    pageTitle.prepend(moduleMark(id));
    content.append(pageTitle);
    if (id === 'zeroclaw') {
      // ZeroClaw's own area: status, Configure agent (its terminal opens here) and its settings.
      zeroclawPage(content);
      panel.append(content); panels.append(panel);
      rows.set(id, { navigation, panel, row, active: activeCheck, detail, output: zeroclaw!.output, project: document.createElement('select'), manage });
      activeCheck.addEventListener('change', () => void operate(id, activeCheck.checked ? 'enable' : 'disable'));
      continue;
    }
    const project = document.createElement('select'); project.className = 'btn'; project.setAttribute('aria-label', 'Workspace');
    const create = document.createElement('button'); create.className = 'btn'; create.textContent = 'Open / reconnect terminal';
    create.addEventListener('click', () => void createSession(id, project.value || hooks.workspace()));
    const detach = document.createElement('button'); detach.className = 'btn'; detach.textContent = 'Disconnect view';
    detach.addEventListener('click', () => { if (selectedSessionId) void disconnect(selectedSessionId); });
    const controls = document.createElement('div'); controls.className = 'modules-service-actions'; controls.append(project, create, detach);
    const output = text('p', 'This terminal can reconnect to the same tmux session when Chat Marks reopens.', 'modules-detail');
    content.append(controls, output); panel.append(content); panels.append(panel);
    rows.set(id, { navigation, panel, row, active: activeCheck, detail, output, project, manage });
    activeCheck.addEventListener('change', () => void operate(id, activeCheck.checked ? 'enable' : 'disable'));
  }

  // One "New chat" for every kind of chat: with CLIProxy or a CLI module available it opens a menu whose first
  // item is the app's own ChatGPT chat; without one it stays the plain ChatGPT button. Both
  // upstream buttons keep their handlers: the Projects sidebar's #newChat and the Inbox
  // layout's compose button, which the Inbox repaints. This listens before them, on the document.
  const NEW_CHAT_BUTTONS = '#newChat, [data-inbox-control="compose"]';
  const enabledModules = (): Id[] => IDS.filter(id => current.get(id)?.enabled && TERMINAL_MODULE(id));
  // Native providers beside ChatGPT (CLIProxy API chats) come right after it, before the terminals.
  const providerItems = (): RowMenuItem[] => hooks.newChatItems?.() ?? [];
  const hasMenu = (): boolean => enabledModules().length > 0 || providerItems().length > 0;
  const paintNewChat = (): void => {
    if (hasMenu()) newChatBtn.setAttribute('aria-haspopup', 'menu');
    else newChatBtn.removeAttribute('aria-haspopup');
  };
  document.addEventListener('click', event => {
    const source = (event.target as Element | null)?.closest?.<HTMLElement>(NEW_CHAT_BUTTONS);
    // A ChatGPT pick replays the click on its button, marked so it reaches the upstream handler.
    // A sidebar that is no longer on screen belongs to a replaced view and answers nothing.
    if (!source || source.dataset.newChatPassThrough === 'true' || !sidebarPrimary.isConnected || !hasMenu()) return;
    event.stopPropagation();
    event.preventDefault();
    const inbox = source !== newChatBtn;
    // The Inbox repaints its compose button; find the one on screen now, not the one clicked.
    const button = (): HTMLElement | null => inbox ? document.querySelector<HTMLElement>('[data-inbox-control="compose"]') : newChatBtn;
    openRowMenu({
      owner: 'new-chat',
      anchor: button,
      label: () => t('New chat'),
      items: () => [
        {
          action: 'new-chat-chatgpt', icon: chatTypeIcon('chatgpt'), label: () => 'ChatGPT',
          run: () => {
            const target = button();
            if (!target) return;
            target.dataset.newChatPassThrough = 'true';
            try { target.click(); } finally { delete target.dataset.newChatPassThrough; }
          }
        },
        ...providerItems(),
        ...enabledModules().map((id, index) => ({
          // Terminal modules have their own namespace: an engine of the same name is `new-chat-engine-<id>`.
          action: `new-terminal-${id}`, icon: chatTypeIcon('terminal'), label: () => current.get(id)?.name ?? id, separated: index === 0,
          run: () => void createSession(id, hooks.workspace())
        }))
      ]
    });
  }, { capture: true });

  async function refresh(): Promise<void> {
    try {
      const reply = await api.cliStatus();
      if (!reply?.ok || !Array.isArray(reply.data)) {
        const message = !reply?.ok && reply?.error ? reply.error : 'Não foi possível consultar o estado dos módulos.';
        for (const row of rows.values()) {
          row.detail.classList.add('modules-error');
          row.detail.textContent = message;
        }
        return;
      }
      for (const status of reply.data) {
        const row = rows.get(status?.id);
        if (!row || typeof status.enabled !== 'boolean' || typeof status.detail !== 'string') continue;
        current.set(status.id, status);
        row.detail.classList.remove('modules-error');
        row.active.checked = status.enabled;
        row.navigation.hidden = !status.enabled || status.legacy;
        if (status.legacy) row.row.hidden = !status.enabled && !status.running;
        row.detail.textContent = status.legacy ? status.detail
          : `${status.version ?? 'Not installed'}${status.upstream && status.installed && !status.managed ? ` (${t('not installed by Chat Marks')})` : ''} · ${status.running ? 'Running · ' : ''}${status.detail}`;
        void row.manage?.refresh().then(() => { if (status.id === 'zeroclaw') paintZeroClawStatus(); });
      }
      paintZeroClawStatus();
      paintNewChat();
      const catalog = await api.cliSessions();
      if (catalog.ok && Array.isArray(catalog.data)) {
        sessions.clear();
        for (const session of catalog.data) sessions.set(session.id, session);
        paintSessions();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível consultar o estado dos módulos.';
      for (const row of rows.values()) {
        row.detail.classList.add('modules-error');
        row.detail.textContent = message || 'Não foi possível consultar o estado dos módulos.';
      }
    }
  }
  async function operate(id: Id, action: 'enable' | 'disable' | 'install' | 'update' | 'stop'): Promise<void> {
    const row = rows.get(id)!;
    const reply = await api.cliAction(id, action);
    if (!reply.ok) row.detail.textContent = reply.error;
    if (action === 'disable') for (const session of sessions.values()) if (session.module === id) void disconnect(session.id);
    await refresh();
  }
  async function setProjects(id: Id): Promise<void> {
    const select = rows.get(id)!.project;
    const previous = select.value;
    select.replaceChildren();
    const home = document.createElement('option'); home.value = ''; home.textContent = 'Home directory'; select.append(home);
    const result = await api.listProjects();
    if (result.ok) for (const p of result.data) {
      const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; select.append(option);
    }
    const target = hooks.workspace() ?? previous;
    if ([...select.options].some(opt => opt.value === target)) select.value = target;
  }
  let renamingSessionId: string | null = null;
  function startCliRename(session: CliSession, wrapper: HTMLDivElement): void {
    renamingSessionId = session.id;
    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'sess-rename';
    field.maxLength = 120;
    field.dir = 'auto';
    field.value = session.title;
    const finish = (save: boolean): void => {
      if (renamingSessionId !== session.id) return;
      renamingSessionId = null;
      const value = field.value.trim();
      if (save && value && value !== session.title) {
        void api.cliRenameSession(session.id, value).then(() => {
          const existing = sessions.get(session.id);
          if (existing) sessions.set(session.id, { ...existing, title: value });
          paintSessions();
        });
      } else {
        paintSessions();
      }
    };
    for (const type of ['click', 'dblclick', 'pointerdown', 'mousedown']) {
      field.addEventListener(type, (ev) => ev.stopPropagation());
    }
    field.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    field.addEventListener('blur', () => { setTimeout(() => { if (renamingSessionId === session.id && document.activeElement !== field) finish(true); }, 0); });
    wrapper.prepend(field);
    queueMicrotask(() => { if (field.isConnected) { field.focus({ preventScroll: true }); field.select(); } });
  }
  function paintSessions(): void {
    for (const button of sessionButtons.values()) button.parentElement?.remove();
    sessionButtons.clear();
    for (const session of [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      // ZeroClaw's setup terminal lives in its Settings page, not under Terminals.
      if (!TERMINAL_MODULE(session.module)) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'sidebar-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn sidebar-primary-link cli-module-chat';
      // Chat Marks: a terminal session shows the terminal type icon, like every chat shows its type.
      const title = document.createElement('span');
      title.className = 'cli-module-chat-title';
      title.textContent = session.title;
      button.replaceChildren(chatTypeMark('terminal', 'sess-type'), title);
      button.hidden = !current.get(session.module)?.enabled;
      button.classList.toggle('is-sel', session.id === selectedSessionId);
      button.addEventListener('click', () => void showSession(session.id));
      if (renamingSessionId === session.id) { button.hidden = true; startCliRename(session, wrapper); }
      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'btn row-menu-btn';
      menuBtn.setAttribute('aria-label', 'Session actions');
      menuBtn.textContent = '⋯';
      menuBtn.setAttribute('data-row-menu', `cli-session:${session.id}`);
      menuBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openRowMenu({
          owner: `cli-session:${session.id}`,
          anchor: () => document.querySelector<HTMLElement>(`[data-row-menu="cli-session:${session.id}"]`),
          label: () => session.title,
          items: () => [
            {
              action: 'rename',
              label: () => 'Rename',
              run: () => {
                renamingSessionId = session.id;
                paintSessions();
              }
            },
            {
              action: 'delete',
              label: () => 'Delete',
              danger: true,
              run: () => {
                void api.cliDeleteSession(session.id).then(() => {
                  sessions.delete(session.id);
                  if (selectedSessionId === session.id) selectedSessionId = null;
                  terminalManagers.get(session.id)?.hide();
                  terminalMounts.get(session.id)?.remove();
                  terminalManagers.delete(session.id);
                  terminalMounts.delete(session.id);
                  paintSessions();
                });
              }
            }
          ]
        });
      });
      wrapper.append(button, menuBtn);
      wrapper.hidden = !current.get(session.module)?.enabled;
      if (session.projectId) {
        const projectGroup = document.querySelector<HTMLElement>(`.project-group[data-project-id="${CSS.escape(session.projectId)}"]`);
        if (projectGroup) {
          projectGroup.append(wrapper);
        } else {
          sidebar.append(wrapper);
        }
      } else {
        sidebar.append(wrapper);
      }
      sessionButtons.set(session.id, button);
    }
  }
  function managerFor(session: CliSession, parent: HTMLElement = moduleTerminal): ReturnType<typeof createWorkspaceTerminal> {
    const existing = terminalManagers.get(session.id);
    if (existing) return existing;
    const mount = document.createElement('div');
    mount.className = 'marks-cli-terminal';
    mount.hidden = true;
    parent.append(mount);
    terminalMounts.set(session.id, mount);
    const transport: TerminalTransport = {
      create: async (attachmentId, _projectId, cols, rows) => {
        const result = await api.cliOpen(session.id, attachmentId, cols, rows);
        return result.ok ? { ok: true, data: { cwd: result.data.cwd, shell: result.data.session } } : result;
      },
      write: (attachmentId, data) => api.cliWrite(attachmentId, data),
      resize: (attachmentId, cols, rows) => api.cliResize(attachmentId, cols, rows),
      ack: (attachmentId, count) => api.cliAck(attachmentId, count),
      close: attachmentId => api.cliDetach(attachmentId),
      onEvent: listener => api.onCliEvent(listener)
    };
    const manager = createWorkspaceTerminal(() => undefined, mount, { id: `cliTerminal-${session.id}`, onEmpty: () => undefined, transport });
    manager.update(session.projectId ? { id: session.projectId, name: session.title, path: '', createdAt: session.createdAt } : null);
    terminalManagers.set(session.id, manager);
    return manager;
  }
  async function createSession(moduleId: string, projectId: string | null, kind?: 'quickstart'): Promise<void> {
    const id = IDS.find(candidate => candidate === moduleId);
    if (!id || LEGACY.has(id)) return;
    if (id === 'zeroclaw') { hooks.showTab('module-zeroclaw'); await openZeroClawSetup(); return; }
    const row = rows.get(id)!;
    if (!current.get(id)?.enabled) { row.output.textContent = 'Enable this module first.'; return; }
    row.output.textContent = 'Criando sessão CLI…';
    const reply = kind ? await api.cliCreateSession(id, projectId || null, kind) : await api.cliCreateSession(id, projectId || null);
    if (!reply.ok) { row.output.textContent = reply.error; return; }
    sessions.set(reply.data.id, reply.data);
    paintSessions();
    row.output.textContent = 'Sessão CLI criada.';
    await showSession(reply.data.id);
  }
  async function disconnect(sessionId: string): Promise<void> {
    const manager = terminalManagers.get(sessionId);
    if (!manager) return;
    for (const tab of manager.tabs()) manager.closeTab(tab.id);
    manager.hide();
  }
  async function showSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session || !current.get(session.module)?.enabled) return;
    if (!TERMINAL_MODULE(session.module)) { hooks.showTab(`module-${session.module}`); if (session.module === 'zeroclaw') await openZeroClawSetup(); return; }
    hooks.showTab('chat');
    hooks.openChatView('cli-module');
    selectedSessionId = sessionId;
    for (const [otherId, manager] of terminalManagers) {
      if (otherId !== sessionId) manager.hide();
      const mount = terminalMounts.get(otherId);
      if (mount) mount.hidden = otherId !== sessionId;
    }
    for (const view of chatBody.querySelectorAll<HTMLElement>(':scope > .view')) view.hidden = view !== moduleView;
    if (composer) composer.hidden = true;
    if (composerDock) composerDock.hidden = true;
    if (subhead) subhead.hidden = true;
    if (chatHead) chatHead.hidden = true;
    for (const [buttonId, button] of sessionButtons) button.classList.toggle('is-sel', buttonId === sessionId);
    const manager = managerFor(session);
    const mount = terminalMounts.get(sessionId)!;
    mount.hidden = false;
    manager.show(mount, true);
  }
  /** Shows a terminal main just created or updated (an engine chat's live or hand-over terminal), after reloading the list. */
  async function openSession(sessionId: string): Promise<void> {
    await refresh();
    await showSession(sessionId);
  }
  void refresh();
  return {
    createSession,
    openSession,
    // The retired forks never open a terminal, so no menu lists them.
    cliModules: (): ReadonlyArray<CliModuleSummary> => [...current.values()].filter(status => TERMINAL_MODULE(status.id)).map(status => ({
      id: status.id,
      name: status.name,
      enabled: status.enabled
    })),
    normalizeTab: (name: string) => IDS.some(id => name === `module-${id}` && !current.get(id)?.enabled) ? 'modules' : name,
    onTabOpening: (name: string) => {
      if (name === 'modules') void refresh();
      if (name === 'chat') {
        moduleView.hidden = true;
        if (composer) composer.hidden = false;
        if (composerDock) composerDock.hidden = false;
        if (subhead) subhead.hidden = false;
        if (chatHead) chatHead.hidden = false;
        for (const button of sessionButtons.values()) button.classList.remove('is-sel');
      }
    },
    onTabShown: (name: string) => {
      const id = IDS.find(id => name === `module-${id}`);
      if (id === 'zeroclaw') { void refresh(); void paintZeroClawFacts(); }
      else if (id) { void refresh(); void setProjects(id); }
    },
    paintNavigation: (name: string) => {
      for (const [id, row] of rows) row.navigation.classList.toggle('is-sel', name === `module-${id}`);
    },
    modulePage: (button: HTMLElement | null | undefined) => button?.dataset.modulePage && IDS.some(id => button.dataset.modulePage === `module-${id}`) ? button.dataset.modulePage : null,
    repaintSessions: paintSessions,
    repaintNewChat: paintNewChat
  };
}
