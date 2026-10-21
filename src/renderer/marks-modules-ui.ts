/** Chat Marks CLIProxyAPI renderer integration. Optional UI, separate from the systemd service. */
import type { AppApi } from '../preload/index.js';
import type { MarksModuleAction, MarksModuleState } from '../shared/modules.js';
import { $, toast } from './dom.js';
import { t, onLanguageChange } from './i18n.js';
import { createCliModulesUi, type CliModuleSummary } from './cli-modules-ui.js';
import { createApiChatSettingsUi } from './api-chat-settings-ui.js';
import { createApiChatUi } from './api-chat-ui.js';
import type { RowMenuItem } from './row-menu.js';
import { createCliProxyManageUi } from './cliproxy-manage-ui.js';

export interface MarksModulesUiHooks {
  showTab(name: string): void;
  openChatView(name: string): void;
  workspace(): string | null;
  /** The chat the timeline shows; API chats take over its composer. */
  selectedChat?(): { id: string; conversationId: string | null } | null;
  /** Shows a session in the normal chat view. */
  selectChat?(id: string): void | Promise<void>;
}

/** Only the sidebar hooks are visible to upstream-owned main.ts. */
export interface MarksModulesUiController {
  createSession(moduleId: string, projectId: string | null): Promise<void>;
  cliModules(): ReadonlyArray<CliModuleSummary>;
  /** A project's menu items for a CLIProxy chat in that project. */
  projectChatItems(projectId: string): RowMenuItem[];
  normalizeTab(name: string): string;
  onTabOpening(name: string): void;
  onTabShown(name: string): void;
  paintNavigation(name: string): void;
  modulePage(button: HTMLElement | null | undefined): string | null;
  repaintSessions(): void;
}

export function initMarksModulesUi(api: AppApi, hooks: MarksModulesUiHooks): MarksModulesUiController {
  // CLIProxy API chats: New chat's item after ChatGPT, and their composer in the chat view.
  let repaintNewChat = (): void => undefined;
  const apiChatChats = createApiChatUi(api, hooks, () => repaintNewChat());
  const cli = createCliModulesUi(api, { ...hooks, newChatItems: apiChatChats.newChatItems });
  repaintNewChat = cli.repaintNewChat;
  const apiChat = createApiChatSettingsUi(api, $('moduleCliError').closest<HTMLElement>('.modules-service')!);
  // Versions, verified install/update, management password and API keys inside the same card.
  const manage = createCliProxyManageUi(api, $('moduleCliError').closest<HTMLElement>('.modules-service')!,
    () => cliProxyModule, async () => { await refreshModules(); void apiChat.refresh(); }, () => paintModules());
  let cliProxyModule: MarksModuleState | null = null;
  let moduleChecked = false;
  let moduleLoading = false;
  let modulePendingRefresh: Promise<void> | null = null;
  let moduleBusy = false;
  let moduleError = '';
  let consoleUrlEdited = false;
  let moduleConsoleLaunching = false;
  // UI activation is independent from systemd enable/disable. Never elevate or start a
  // service when merely showing its entry in Settings; the backend owns those actions.
  const MODULE_CLI_ACTIVE_KEY = 'cos.modules.cli-proxy-api.active';
  let moduleUiActive = false;
  try { moduleUiActive = window.localStorage.getItem(MODULE_CLI_ACTIVE_KEY) === 'true'; }
  catch { /* Read-only storage still allows toggling the current window. */ }

  function paintModuleNavigation(): void {
    $<HTMLInputElement>('moduleCliActive').checked = moduleUiActive;
    $('moduleCliNav').hidden = !moduleUiActive;
  }

  function setModuleUiActive(active: boolean): void {
    moduleUiActive = active;
    try { window.localStorage.setItem(MODULE_CLI_ACTIVE_KEY, String(active)); }
    catch { /* Optional local UI preference; the service remains untouched. */ }
    paintModuleNavigation();
    if (!active && document.querySelector<HTMLElement>('[data-panel="module-cli-proxy"]')?.classList.contains('is-active')) {
      hooks.showTab('modules');
    }
    paintModules();
  }
  paintModuleNavigation();

  function paintModules(): void {
    const current = cliProxyModule;
    const status = $('moduleCliStatus');
    const state = moduleLoading ? 'checking' : !moduleChecked ? moduleError ? 'error' : 'unknown'
      : !current?.supported ? 'unsupported' : !current.installed ? 'missing'
        : current.running ? 'running' : 'stopped';
    status.dataset.state = state;
    status.textContent = t(state === 'checking' ? 'Checking status…'
      : state === 'error' ? 'Status unavailable'
        : state === 'unsupported' ? 'Unsupported system'
          : state === 'missing' ? 'Not installed'
            : state === 'running' ? 'Running'
              : state === 'stopped' ? 'Stopped' : 'Status unavailable');
    $('moduleCliDetail').textContent = current
      ? `${current.detail}${current.installed ? ` · ${t(current.enabled ? 'Enabled at startup' : 'Manual start')}` : ''}`
      : t('Connect to the local module service to see its status.');
    $('moduleCliConsoleStatus').dataset.state = state;
    $('moduleCliConsoleStatus').textContent = status.textContent;
    $('moduleCliConsoleDetail').textContent = $('moduleCliDetail').textContent;
    $('moduleCliVerifiedAddress').textContent = current?.consoleAvailable === false ? '' : (current?.managementUrl ?? '');
    $('moduleCliError').textContent = moduleError;
    $('moduleCliError').hidden = !moduleError;
    $('moduleCliConsoleError').textContent = moduleError;
    $('moduleCliConsoleError').hidden = !moduleError;
    const blocked = moduleLoading || moduleBusy || !moduleChecked;
    $<HTMLButtonElement>('moduleRefresh').disabled = moduleLoading || moduleBusy;
    $<HTMLButtonElement>('moduleCliInstall').disabled = blocked || !!current?.installed;
    $<HTMLButtonElement>('moduleCliUpdate').disabled = blocked || !current?.installed;
    $<HTMLButtonElement>('moduleCliStart').disabled = blocked || !current?.supported || !current.installed || current.running;
    $<HTMLButtonElement>('moduleCliStop').disabled = blocked || !current?.supported || !current.installed || !current.running;
    $<HTMLButtonElement>('moduleCliRestart').disabled = blocked || !current?.supported || !current.installed || !current.running;
    $<HTMLButtonElement>('moduleCliEnable').disabled = blocked || !current?.supported || !current.installed || current.enabled;
    $<HTMLButtonElement>('moduleCliDisable').disabled = blocked || !current?.supported || !current.installed || !current.enabled;
    $<HTMLButtonElement>('moduleCliOpen').disabled = blocked || !moduleUiActive || !current?.supported || !current.installed ||
      !current.running || current.consoleAvailable === false || !$<HTMLInputElement>('moduleCliConsoleUrl').value.trim();
    $<HTMLButtonElement>('moduleCliReopen').disabled = blocked || !moduleUiActive || !current?.supported || !current.installed ||
      !current.running || current.consoleAvailable === false || !current.managementUrl;
    manage.paint();
  }

  function readModuleReply(modules: MarksModuleState[]): MarksModuleState {
    if (!Array.isArray(modules)) throw new Error('Module status response is unavailable.');
    const current = modules.find(item => item?.id === 'cli-proxy-api');
    if (!current || typeof current.installed !== 'boolean' || typeof current.enabled !== 'boolean' ||
        typeof current.running !== 'boolean' || typeof current.supported !== 'boolean' ||
        typeof current.detail !== 'string' || typeof current.managementUrl !== 'string') {
      throw new Error('CLIProxyAPI status is incomplete.');
    }
    return current;
  }

  function acceptModuleStatus(modules: MarksModuleState[]): void {
    cliProxyModule = readModuleReply(modules);
    moduleChecked = true;
    if (!consoleUrlEdited) $<HTMLInputElement>('moduleCliConsoleUrl').value = cliProxyModule.managementUrl;
  }

  function refreshModules(): Promise<void> {
    // Join a running check (e.g. a fast click on the subitem just after Modules).
    // Otherwise the subitem could use a stale or absent status and fail to open.
    if (modulePendingRefresh) return modulePendingRefresh;
    if (moduleBusy) return Promise.resolve();
    const request = (async () => {
      moduleLoading = true;
      moduleError = '';
      paintModules();
      try {
        const reply = await api.modulesStatus();
        if (!reply.ok) throw new Error(reply.error);
        acceptModuleStatus(reply.data);
      } catch (error) {
        moduleChecked = false;
        cliProxyModule = null;
        moduleError = (error as Error).message || 'Could not check module status.';
      } finally {
        moduleLoading = false;
        paintModules();
      }
    })();
    modulePendingRefresh = request;
    void request.finally(() => { if (modulePendingRefresh === request) modulePendingRefresh = null; });
    return request;
  }

  async function actOnModule(action: MarksModuleAction): Promise<void> {
    if (moduleBusy || moduleLoading || !moduleChecked) return;
    moduleBusy = true;
    moduleError = '';
    paintModules();
    try {
      const url = action === 'open' ? $<HTMLInputElement>('moduleCliConsoleUrl').value.trim() : undefined;
      const reply = await api.moduleAction('cli-proxy-api', action, url);
      if (!reply.ok) throw new Error(reply.error);
      acceptModuleStatus(reply.data);
      if (action !== 'open') void manage.refresh();
      if (action === 'install') {
        // The backend opens the official instructions; installation itself is user-managed.
        toast(t('Installation guide opened. Follow the instructions to install CLIProxyAPI.'));
      }
      if (action === 'update') {
        toast(t('Official CLIProxyAPI releases opened. Follow the publisher instructions to update the separately installed service.'));
      }
    } catch (error) {
      moduleError = (error as Error).message || 'Could not complete the module action.';
    } finally {
      moduleBusy = false;
      paintModules();
    }
  }

  /**
   * Selecting the CLIProxyAPI subitem opens the actual management UI in the
   * backend's sandboxed Electron BrowserWindow, never an embedded iframe/webview.
   * The fresh status must identify the running service and its verified URL; the
   * UI toggle alone never starts systemd, opens a window or grants privileges.
   */
  async function openSelectedModuleConsole(): Promise<void> {
    if (moduleConsoleLaunching) return;
    moduleConsoleLaunching = true;
    try {
      await refreshModules();
      if (!moduleUiActive || !document.querySelector<HTMLElement>('[data-panel="module-cli-proxy"]')?.classList.contains('is-active')) return;
      const current = cliProxyModule;
      if (!current?.supported || !current.installed || !current.running ||
          current.consoleAvailable === false || !current.managementUrl) return;
      // Override an edited address on automatic entry: only the backend-discovered,
      // validated console is opened without a second explicit button press.
      moduleBusy = true;
      paintModules();
      const reply = await api.moduleAction('cli-proxy-api', 'open', current.managementUrl);
      if (!reply.ok) throw new Error(reply.error);
      acceptModuleStatus(reply.data);
      moduleError = '';
    } catch (error) {
      moduleError = (error as Error).message || 'Could not open CLIProxyAPI.';
    } finally {
      moduleBusy = false;
      moduleConsoleLaunching = false;
      paintModules();
    }
  }

  $('moduleRefresh').addEventListener('click', () => { void refreshModules().then(() => manage.refresh(true)); void apiChat.refresh(); void apiChatChats.refresh(); });
  $('moduleCliReopen').addEventListener('click', () => void actOnModule('open'));
  $<HTMLInputElement>('moduleCliActive').addEventListener('change', () =>
    setModuleUiActive($<HTMLInputElement>('moduleCliActive').checked));
  for (const [button, action] of [
    ['moduleCliInstall', 'install'], ['moduleCliUpdate', 'update'], ['moduleCliStart', 'start'],
    ['moduleCliStop', 'stop'], ['moduleCliRestart', 'restart'],
    ['moduleCliEnable', 'enable'], ['moduleCliDisable', 'disable'],
    ['moduleCliOpen', 'open']
  ] as const) {
    $(button).addEventListener('click', () => {
      if (action === 'install' || action === 'update') {
        void manage.installOrUpdate(action).then(handled => { if (!handled) void actOnModule(action); });
      } else void actOnModule(action);
    });
  }
  $('moduleCliConsoleUrl').addEventListener('input', () => {
    consoleUrlEdited = true;
    paintModules();
  });
  onLanguageChange(paintModules);
  return {
    createSession: cli.createSession,
    cliModules: cli.cliModules,
    projectChatItems: apiChatChats.projectChatItems,
    normalizeTab: name => cli.normalizeTab(name === 'module-cli-proxy' && !moduleUiActive ? 'modules' : name),
    onTabOpening: name => {
      if (name === 'modules') { void refreshModules().then(() => manage.refresh()); void apiChat.refresh(); }
      if (name === 'chat') void apiChatChats.refresh();
      cli.onTabOpening(name);
    },
    onTabShown: name => { if (name === 'module-cli-proxy') void openSelectedModuleConsole(); cli.onTabShown(name); },
    paintNavigation: name => {
      cli.paintNavigation(name);
      // Keep the parent Modules page visibly selected while its subitem is open.
      if (name === 'module-cli-proxy') {
        document.querySelector<HTMLElement>('nav [data-tab="modules"]')?.classList.add('is-sel');
      }
      for (const item of document.querySelectorAll<HTMLElement>('nav [data-module-page]')) {
        const selected = item.dataset.modulePage === name;
        item.classList.toggle('is-sel', selected);
        if (selected) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
    },
    modulePage: button => cli.modulePage(button) ?? (button?.dataset.modulePage === 'module-cli-proxy' && moduleUiActive ? button.dataset.modulePage : null),
    // The chat list repaints on every selection and session change: API chats follow it.
    repaintSessions: () => { cli.repaintSessions(); apiChatChats.sync(); }
  };
}
