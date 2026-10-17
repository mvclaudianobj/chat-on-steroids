import type { AppApi } from '../preload/index.js';
import type { CliSession } from '../main/cli-modules.js';
import { createWorkspaceTerminal, type TerminalTransport } from './workspace-terminal.js';
import { openRowMenu } from './row-menu.js';

const IDS = ['markscode', 'codex', 'claude', 'marksclaw'] as const;
type Id = typeof IDS[number];
type Status = { id: Id; name: string; installed: boolean; enabled: boolean; running: boolean; supported: boolean; version: string | null; detail: string };
export type CliModuleSummary = { id: string; name: string; enabled: boolean };

export function createCliModulesUi(api: AppApi, hooks: { showTab(name: string): void; openChatView(name: string): void; workspace(): string | null }) {
  const nav = document.getElementById('moduleCliNav')!;
  const tabs = nav.parentElement!;
  const parent = document.querySelector('[data-panel="modules"] .appearance-content')!;
  const panels = document.querySelector('[data-panel="modules"]')!.parentElement!;
  const sidebar = document.getElementById('cliModuleChats')!;
  const sidebarPrimary = document.getElementById('sidebarPrimary')!;
  const newChatBtn = document.getElementById('newChat')!;
  let lastSidebarBtn: Element = newChatBtn;
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
  const rows = new Map<Id, { navigation: HTMLButtonElement; panel: HTMLElement; row: HTMLElement; active: HTMLInputElement; detail: HTMLElement; output: HTMLElement; project: HTMLSelectElement }>();
  const current = new Map<Id, Status>();
  const sessions = new Map<string, CliSession>();
  const terminalManagers = new Map<string, ReturnType<typeof createWorkspaceTerminal>>();
  const terminalMounts = new Map<string, HTMLElement>();
  const sidebarButtons = new Map<Id, HTMLButtonElement>();
  const sessionButtons = new Map<string, HTMLButtonElement>();
  let selectedSessionId: string | null = null;

  for (const id of IDS) {
    const name = id === 'markscode' ? 'MarksCode' : id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude' : 'MarksClaw';
    const navigation = document.createElement('button');
    navigation.type = 'button'; navigation.className = 'modules-subnav'; navigation.dataset.modulePage = `module-${id}`;
    navigation.textContent = name; navigation.hidden = true;
    tabs.insertBefore(navigation, nav.nextSibling);
    const sidebarButton = document.createElement('button');
    sidebarButton.type = 'button';
    sidebarButton.className = 'btn sidebar-primary-link cli-module-chat';
    sidebarButton.innerHTML = '<i class="ico ph ph-terminal-window" aria-hidden="true"></i>';
    sidebarButton.append(document.createTextNode(`Novo ${name}`));
    sidebarButton.hidden = true;
    sidebarButton.addEventListener('click', () => void createSession(id, hooks.workspace()));
    sidebarPrimary.insertBefore(sidebarButton, lastSidebarBtn.nextSibling); lastSidebarBtn = sidebarButton;
    sidebarButtons.set(id, sidebarButton);
    const row = document.createElement('section'); row.className = 'appearance-section';
    row.append(text('h2', name));
    const surface = document.createElement('div'); surface.className = 'settings-surface modules-service';
    const enableLabel = document.createElement('label'); enableLabel.className = 'setting modules-toggle';
    enableLabel.append(text('span', 'Activate module', 'setting-text'));
    const activeCheck = document.createElement('input'); activeCheck.type = 'checkbox'; enableLabel.append(activeCheck);
    const detail = text('p', 'Checking installation…', 'modules-detail');
    const actions = document.createElement('div'); actions.className = 'modules-service-actions';
    for (const action of ['install', 'update', 'stop'] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn';
      button.textContent = action === 'install' ? 'Install / instructions' : action === 'update' ? 'Update' : 'Stop session';
      button.addEventListener('click', () => void operate(id, action)); actions.append(button);
    }
    surface.append(enableLabel, detail, actions); row.append(surface); parent.append(row);

    const panel = document.createElement('section'); panel.className = 'panel appearance-panel modules-panel scroll';
    panel.dataset.panel = `module-${id}`;
    const content = document.createElement('div'); content.className = 'appearance-content settings-page-content';
    content.append(text('h1', name));
    const project = document.createElement('select'); project.className = 'btn'; project.setAttribute('aria-label', 'Workspace');
    const create = document.createElement('button'); create.className = 'btn'; create.textContent = 'Open / reconnect terminal';
    create.addEventListener('click', () => void createSession(id, project.value || hooks.workspace()));
    const detach = document.createElement('button'); detach.className = 'btn'; detach.textContent = 'Disconnect view';
    detach.addEventListener('click', () => { if (selectedSessionId) void disconnect(selectedSessionId); });
    const controls = document.createElement('div'); controls.className = 'modules-service-actions'; controls.append(project, create, detach);
    const output = text('p', 'This terminal can reconnect to the same tmux session when Chat Marks reopens.', 'modules-detail');
    content.append(controls, output); panel.append(content); panels.append(panel);
    rows.set(id, { navigation, panel, row, active: activeCheck, detail, output, project });
    activeCheck.addEventListener('change', () => void operate(id, activeCheck.checked ? 'enable' : 'disable'));
  }

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
        row.navigation.hidden = !status.enabled;
        const sidebarButton = sidebarButtons.get(status.id);
        if (sidebarButton) sidebarButton.hidden = !status.enabled;
        row.detail.textContent = `${status.version ?? 'Not installed'} · ${status.running ? 'Running · ' : ''}${status.detail}`;
      }
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
      const wrapper = document.createElement('div');
      wrapper.className = 'sidebar-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn sidebar-primary-link cli-module-chat';
      button.textContent = session.title;
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
      sidebar.append(wrapper);
      sessionButtons.set(session.id, button);
    }
  }
  function managerFor(session: CliSession): ReturnType<typeof createWorkspaceTerminal> {
    const existing = terminalManagers.get(session.id);
    if (existing) return existing;
    const mount = document.createElement('div');
    mount.className = 'marks-cli-terminal';
    mount.hidden = true;
    moduleTerminal.append(mount);
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
  async function createSession(moduleId: string, projectId: string | null): Promise<void> {
    const id = IDS.find(candidate => candidate === moduleId);
    if (!id) return;
    const row = rows.get(id)!;
    if (!current.get(id)?.enabled) { row.output.textContent = 'Enable this module first.'; return; }
    row.output.textContent = 'Criando sessão CLI…';
    const reply = await api.cliCreateSession(id, projectId || null);
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
    for (const button of sidebarButtons.values()) button.classList.remove('is-sel');
    for (const [buttonId, button] of sessionButtons) button.classList.toggle('is-sel', buttonId === sessionId);
    const manager = managerFor(session);
    const mount = terminalMounts.get(sessionId)!;
    mount.hidden = false;
    manager.show(mount, true);
  }
  void refresh();
  return {
    createSession,
    cliModules: (): ReadonlyArray<CliModuleSummary> => [...current.values()].map(status => ({
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
        for (const button of sidebarButtons.values()) button.classList.remove('is-sel');
        for (const button of sessionButtons.values()) button.classList.remove('is-sel');
      }
    },
    onTabShown: (name: string) => {
      const id = IDS.find(id => name === `module-${id}`);
      if (id) { void refresh(); void setProjects(id); }
    },
    paintNavigation: (name: string) => {
      for (const [id, row] of rows) row.navigation.classList.toggle('is-sel', name === `module-${id}`);
    },
    modulePage: (button: HTMLElement | null | undefined) => button?.dataset.modulePage && IDS.some(id => button.dataset.modulePage === `module-${id}`) ? button.dataset.modulePage : null
  };
}
