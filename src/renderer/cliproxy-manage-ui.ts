/**
 * Chat Marks CLIProxyAPI management inside Modules > CLIProxyAPI: versions with a verified
 * install/update, the write-only management password and the API keys (masked) with
 * Create/Revoke. Main owns every secret and privileged step; this only asks and shows.
 */
import type { AppApi } from '../preload/index.js';
import type { CliProxyInstallProgress, CliProxyManageStatus } from '../shared/cliproxy.js';
import type { MarksModuleState } from '../shared/modules.js';
import { t, ui } from './i18n.js';

export interface CliProxyManageUi {
  refresh(refresh?: boolean): Promise<void>;
  /** Handles Install/Update itself when this platform has a verified installer. */
  installOrUpdate(action: 'install' | 'update'): Promise<boolean>;
  /** Repaints the service-dependent controls after a module status change. */
  paint(): void;
}

/** Main's error codes, translated; anything else is shown as main wrote it. */
export function cliProxyErrorText(code: string | undefined): string {
  switch (code) {
    case undefined: case '': return '';
    case 'management_key_missing': return t('Save the management password to manage API keys.');
    case 'management_key_invalid': return t('CLIProxyAPI rejected the management password.');
    case 'management_unreachable': return t('Start CLIProxyAPI to use its management API.');
    case 'management_disabled': return t('The management API is disabled in the CLIProxyAPI configuration.');
    case 'management_banned': return t('CLIProxyAPI blocked management requests after too many wrong passwords. Try again later.');
    case 'management_save_failed': return t('CLIProxyAPI could not save its configuration. Check that the service can write its config file.');
    case 'key_not_found': return t('That key is no longer in the list.');
    case 'unsupported_platform': return t('Automatic installation is available on Linux x64 and arm64 only.');
    case 'release_unavailable': return t('Could not read the latest release from GitHub.');
    case 'version_changed': return t('A newer release appeared. Check the versions and try again.');
    case 'download_failed': return t('The download from GitHub failed.');
    case 'checksum_mismatch': return t('The download did not match the published checksum, so nothing was installed.');
    case 'extract_failed': return t('The release archive did not contain the expected program.');
    case 'install_cancelled': return t('Administrator authorization was cancelled.');
    case 'install_failed': return t('The installation did not complete.');
    case 'install_running': return t('An installation is already running.');
    default: return code;
  }
}

/**
 * `repaint` repaints the whole card (the module adapter resets the shared Install/Update buttons
 * first, then calls `paint`), so every change here goes through it.
 */
export function createCliProxyManageUi(api: AppApi, card: HTMLElement, moduleState: () => MarksModuleState | null,
  afterInstall: () => Promise<void>, repaint: () => void): CliProxyManageUi {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
    Object.assign(document.createElement(tag), props);
  const withId = <T extends HTMLElement>(node: T, id: string): T => { node.id = id; return node; };
  const button = (id: string, text: () => string): HTMLButtonElement => {
    const node = withId(el('button', { type: 'button', className: 'btn' }), id);
    ui(node, 'textContent', text);
    return node;
  };
  const heading = (text: () => string, hint: () => string): HTMLElement => {
    const head = el('span', { className: 'setting-text' });
    const bold = el('b'), em = el('em');
    ui(bold, 'textContent', text);
    ui(em, 'textContent', hint);
    head.append(bold, em);
    return head;
  };

  // Versions, under the status line.
  const versions = withId(el('div', { className: 'cliproxy-versions' }), 'cliProxyVersions');
  const installedLine = withId(el('p', { className: 'modules-detail' }), 'cliProxyInstalledVersion');
  const latestLine = withId(el('p', { className: 'modules-detail' }), 'cliProxyLatestVersion');
  const updateBadge = withId(el('span', { className: 'modules-status', hidden: true }), 'cliProxyUpdateBadge');
  updateBadge.dataset.state = 'update';
  const localWarning = withId(el('p', { className: 'modules-detail cliproxy-warning', hidden: true }), 'cliProxyLocalBuild');
  const progressLine = withId(el('p', { className: 'modules-detail', hidden: true }), 'cliProxyProgress');
  progressLine.setAttribute('role', 'status');
  versions.append(installedLine, latestLine, updateBadge, localWarning, progressLine);
  card.querySelector('.modules-service-overview')!.append(versions);

  // Management password and API keys, before the console row.
  const password = withId(el('input', { type: 'password', autocomplete: 'off', spellcheck: false }), 'cliProxyManagementKey');
  const savePassword = button('cliProxySaveManagementKey', () => t('Save password'));
  const passwordState = withId(el('span', { className: 'modules-detail' }), 'cliProxyManagementKeyState');
  const passwordRow = el('span', { className: 'api-chat-key' });
  passwordRow.append(password, savePassword, passwordState);
  const passwordField = el('div', { className: 'setting cliproxy-field' });
  passwordField.append(heading(() => t('Management password'), () => t('Stored encrypted on this computer. The console opens signed in with it.')), passwordRow);

  const keyList = withId(el('ul', { className: 'cliproxy-keys' }), 'cliProxyKeys');
  const createKey = button('cliProxyCreateKey', () => t('Create API key'));
  const keysField = el('div', { className: 'setting cliproxy-field' });
  const keysHead = heading(() => t('API keys'), () => t('Programs use these keys to call CLIProxyAPI. Only the last four characters are shown.'));
  keysField.append(keysHead, createKey);
  const repair = button('cliProxyRepairConfig', () => t('Allow CLIProxyAPI to save its settings'));
  const repairField = withId(el('div', { className: 'setting cliproxy-field', hidden: true }), 'cliProxyRepair');
  repairField.append(heading(() => t('Settings cannot be saved'),
    () => t('The service can read its configuration but not save it, so API keys cannot be created or revoked.')), repair);
  const message = withId(el('p', { className: 'modules-detail cliproxy-message' }), 'cliProxyMessage');
  message.setAttribute('role', 'status');
  const manage = withId(el('div', { className: 'cliproxy-manage' }), 'cliProxyManage');
  manage.append(passwordField, repairField, keysField, keyList, message);
  card.querySelector('.modules-console')!.before(manage);

  let status: CliProxyManageStatus | null = null;
  let busy = false;
  let progress: CliProxyInstallProgress | null = null;
  let note = '', noteError = false;
  const say = (text: string, error = false): void => { note = text; noteError = error; repaint(); };

  const progressText = (value: CliProxyInstallProgress): string =>
    value.phase === 'downloading' ? t('Downloading {0}…', [value.version])
      : value.phase === 'verifying' ? t('Verifying checksum…')
        : value.phase === 'extracting' ? t('Extracting…')
          : value.phase === 'installing' ? t('Waiting for administrator authorization…')
            : value.phase === 'done' ? t('Installed {0}.', [value.version])
              : cliProxyErrorText(value.error);

  function paint(): void {
    const module = moduleState();
    const running = !!module?.supported && module.installed && module.running && module.consoleAvailable !== false;
    const v = status?.versions;
    installedLine.textContent = `${t('Installed version')}: ${v?.installed ?? (module?.installed === false ? t('Not installed') : '—')}`;
    latestLine.textContent = `${t('Latest release')}: ${v?.latest ?? (v?.latestError ? cliProxyErrorText(v.latestError) : '—')}`;
    updateBadge.hidden = !v?.updateAvailable;
    updateBadge.textContent = t('Update available');
    localWarning.hidden = !v?.installed || v.installedOfficial;
    localWarning.textContent = t('Local build: updating replaces it with the official release.');
    progressLine.hidden = !progress;
    progressLine.textContent = progress ? progressText(progress) : '';
    progressLine.classList.toggle('modules-error', progress?.phase === 'failed');

    const installButton = document.getElementById('moduleCliInstall') as HTMLButtonElement | null;
    const updateButton = document.getElementById('moduleCliUpdate') as HTMLButtonElement | null;
    if (v?.installable && installButton && updateButton) {
      installButton.textContent = v.latest ? t('Install {0}', [v.latest]) : t('Install');
      updateButton.textContent = v.latest ? t('Update to {0}', [v.latest]) : t('Update');
      installButton.disabled ||= busy || !v.latest;
      updateButton.disabled ||= busy || !v.latest || (!v.updateAvailable && v.installedOfficial);
    }

    password.disabled = busy || !running;
    savePassword.disabled = busy || !running;
    passwordState.textContent = !status?.hasManagementKey ? t('No password saved')
      : status.managementKeyValid === false ? t('The saved password was rejected') : t('A password is saved');
    passwordState.classList.toggle('modules-error', status?.managementKeyValid === false);

    repairField.hidden = !status?.configRepair;
    repair.disabled = busy || !module?.installed;

    const keys = status?.keys ?? null;
    createKey.disabled = busy || !running || keys === null;
    keyList.hidden = keys === null;
    keyList.replaceChildren(...(keys ?? []).map(key => {
      const item = el('li');
      const label = el('span', { className: 'cliproxy-key', textContent: `•••• ${key.last4}` });
      label.setAttribute('translate', 'no');
      item.append(label);
      if (key.chat) item.append(el('span', { className: 'modules-detail', textContent: t('Used by Chat with CLIProxy') }));
      const revoke = el('button', { type: 'button', className: 'btn', textContent: t('Revoke'), disabled: busy || !running });
      revoke.dataset.keyId = key.id;
      revoke.addEventListener('click', () => void revokeKey(key.id, key.last4));
      item.append(revoke);
      return item;
    }));
    if (keys && keys.length === 0) keyList.append(el('li', { className: 'modules-detail', textContent: t('No API keys') }));
    const keysError = cliProxyErrorText(status?.keysError === 'management_key_missing' && !running ? 'management_unreachable' : status?.keysError);
    message.textContent = note || keysError;
    message.classList.toggle('modules-error', note ? noteError : !!keysError && status?.keysError !== 'management_key_missing');
  }

  const accept = (reply: Awaited<ReturnType<AppApi['cliProxyStatus']>>): boolean => {
    if (!reply?.ok) { if (reply) say(cliProxyErrorText(reply.error), true); return false; }
    status = reply.data;
    if (status.install && !progress) progress = status.install;
    repaint();
    return true;
  };

  /** A failed key write may have found that the service cannot save: re-read the status for the repair offer. */
  function afterWrite(ok: boolean): boolean {
    if (!ok) void api.cliProxyStatus().then(reply => { if (reply?.ok) { status = reply.data; repaint(); } });
    return ok;
  }

  async function act(work: () => Promise<boolean>): Promise<void> {
    if (busy) return;
    busy = true;
    note = '';
    repaint();
    try { await work(); } finally { busy = false; repaint(); }
  }

  async function revokeKey(id: string, last4: string): Promise<void> {
    if (!window.confirm(t('Revoke the key ending in {0}? Programs using it lose access to CLIProxyAPI.', [last4]))) return;
    await act(async () => afterWrite(accept(await api.cliProxyRevokeKey(id))) && (say(t('Key revoked.')), true));
  }

  savePassword.addEventListener('click', () => {
    const value = password.value;
    password.value = '';
    void act(async () => accept(await api.cliProxySetManagementKey(value)) &&
      (say(value.trim() ? t('Password saved.') : t('Password removed.')), true));
  });
  password.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); savePassword.click(); } });
  createKey.addEventListener('click', () => void act(async () =>
    afterWrite(accept(await api.cliProxyCreateKey())) && (say(t('API key created and saved for Chat with CLIProxy.')), true)));
  repair.addEventListener('click', () => {
    if (!window.confirm(t('Allow CLIProxyAPI to save its settings? After administrator authorization, a systemd drop-in lets the service write /etc/cli-proxy-api, the folder and its config file are given to the service user, and a running service restarts. The service unit itself is not changed.'))) return;
    void act(async () => accept(await api.cliProxyRepairConfig()) && (say(t('CLIProxyAPI can now save its settings.')), true));
  });
  api.onCliProxyProgress?.(next => { progress = next; repaint(); });

  return {
    paint,
    async refresh(refresh = false) {
      try { accept(await api.cliProxyStatus(refresh)); }
      catch (error) { say(error instanceof Error ? error.message : String(error), true); }
    },
    async installOrUpdate(action) {
      const v = status?.versions;
      if (!v?.installable) return false;
      if (busy || !v.latest) return true;
      const question = action === 'install'
        ? t('Install CLIProxyAPI {0}? The official release is downloaded from GitHub, checked against its published checksum and installed as a system service after administrator authorization.', [v.latest])
        : t('Update CLIProxyAPI to {0}? The official release is downloaded from GitHub, checked against its published checksum and installed after administrator authorization. A running service restarts.', [v.latest]);
      const local = action === 'update' && v.installed && !v.installedOfficial
        ? `\n\n${t('The installed program ({0}) is a local build; updating replaces it.', [v.installed])}` : '';
      if (!window.confirm(question + local)) return true;
      progress = null;
      await act(async () => {
        const ok = accept(await api.cliProxyInstall(action, v.latest!));
        await afterInstall();
        return ok;
      });
      return true;
    }
  };
}
