/**
 * Chat Marks: versions, install and one-click update of an upstream module (OpenCode, ZeroClaw)
 * inside its card in Settings > Modules, like the CLIProxyAPI card, and OpenCode's background
 * service (state, Start / Stop / Restart). Main downloads the official release (npm registry for
 * OpenCode, GitHub for ZeroClaw), checks its checksum and version and swaps the binary; this only
 * asks and shows. The user confirms the exact version; a different latest release is refused by main.
 */
import type { AppApi } from '../preload/index.js';
import type { OpenCodeServiceAction, UpstreamInstallProgress, UpstreamModuleId, UpstreamModuleStatus } from '../shared/upstream-module.js';
import { t, ui } from './i18n.js';

const NAMES: Readonly<Record<UpstreamModuleId, string>> = { opencode: 'OpenCode', zeroclaw: 'ZeroClaw' };
/** Where each module's official release comes from, as the confirmation names it. */
const SOURCES: Readonly<Record<UpstreamModuleId, () => string>> = { opencode: () => t('the npm registry'), zeroclaw: () => 'GitHub' };

/** Main's error codes, translated; anything else is shown as main wrote it. */
export function upstreamErrorText(code: string | undefined): string {
  switch (code) {
    case undefined: case '': return '';
    case 'unsupported_platform': return t('Automatic installation is available on Linux x64 and arm64, and on Windows through WSL.');
    case 'unsupported_version': return t('This version is not supported by this version of Chat Marks yet.');
    case 'release_unavailable': return t('Could not read the latest release.');
    case 'version_changed': return t('A newer release appeared. Check the versions and try again.');
    case 'download_failed': return t('The download failed.');
    case 'checksum_mismatch': return t('The download did not match the published checksum, so nothing was installed.');
    case 'archive_unexpected': case 'extract_failed': return t('The release archive did not contain the expected program.');
    case 'version_mismatch': return t('The downloaded program did not report the expected version, so nothing was installed.');
    case 'install_failed': return t('The installation did not complete.');
    case 'install_running': return t('An installation is already running.');
    default: return code;
  }
}

export interface UpstreamManageUi {
  refresh(refresh?: boolean): Promise<void>;
  readonly status: UpstreamModuleStatus | null;
}

export function createUpstreamManageUi(api: AppApi, id: UpstreamModuleId, host: HTMLElement, onInstalled: () => void): UpstreamManageUi {
  const name = NAMES[id];
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
    Object.assign(document.createElement(tag), props);
  const box = el('div', { className: 'cliproxy-versions upstream-versions' });
  box.id = `${id}Versions`;
  box.dataset.module = id;
  const installedLine = el('p', { className: 'modules-detail' });
  installedLine.id = `${id}InstalledVersion`;
  const latestLine = el('p', { className: 'modules-detail' });
  latestLine.id = `${id}LatestVersion`;
  const badge = el('span', { className: 'modules-status', hidden: true });
  badge.id = `${id}UpdateBadge`;
  badge.dataset.state = 'update';
  ui(badge, 'textContent', () => t('Update available'));
  const note = el('p', { className: 'modules-detail cliproxy-warning', hidden: true });
  note.id = `${id}Note`;
  const serviceLine = el('p', { className: 'modules-detail', hidden: true });
  serviceLine.id = `${id}Service`;
  const serviceButtons = new Map<OpenCodeServiceAction, HTMLButtonElement>();
  const serviceActions = el('div', { className: 'modules-service-actions', hidden: true });
  serviceActions.id = `${id}ServiceActions`;
  for (const op of ['start', 'stop', 'restart'] as const) {
    const button = el('button', { type: 'button', className: 'btn' });
    button.id = `${id}Service${op[0]!.toUpperCase()}${op.slice(1)}`;
    button.dataset.op = op;
    ui(button, 'textContent', () => op === 'start' ? t('Start service') : op === 'stop' ? t('Stop service') : t('Restart service'));
    serviceButtons.set(op, button);
    serviceActions.append(button);
  }
  const progressLine = el('p', { className: 'modules-detail', hidden: true });
  progressLine.id = `${id}Progress`;
  progressLine.setAttribute('role', 'status');
  const action = el('button', { type: 'button', className: 'btn primary', hidden: true });
  action.id = `${id}Install`;
  const actions = el('div', { className: 'modules-service-actions' });
  actions.append(action);
  box.append(installedLine, latestLine, badge, note, serviceLine, serviceActions, progressLine, actions);
  host.append(box);

  let status: UpstreamModuleStatus | null = null;
  let busy = false;
  let progress: UpstreamInstallProgress | null = null;
  let message = '';

  const progressText = (value: UpstreamInstallProgress): string =>
    value.phase === 'downloading' ? t('Downloading {0}…', [value.version])
      : value.phase === 'verifying' ? t('Verifying checksum…')
        : value.phase === 'extracting' ? t('Extracting…')
          : value.phase === 'checking' || value.phase === 'installing' ? t('Installing {0}…', [value.version])
            : value.phase === 'done' ? t('Installed {0}.', [value.version])
              : upstreamErrorText(value.error);

  function paint(): void {
    const v = status?.versions;
    installedLine.textContent = `${t('Installed version')}: ${v?.installed ?? (v?.unmanaged ? `${v.unmanaged} (${t('not installed by Chat Marks')})` : t('Not installed'))}`;
    latestLine.textContent = `${t('Latest release')}: ${v?.latest ?? (v?.latestError ? upstreamErrorText(v.latestError) : '—')}`;
    badge.hidden = !v?.updateAvailable;
    const notes = [
      v?.support === 'newer' ? t('This version is newer than the one Chat Marks was tested with.') : '',
      v?.support === 'unsupported' ? t('This version is not supported by this version of Chat Marks yet.') : '',
      v?.latestUnsupported ? t('Version {0} is not supported by this version of Chat Marks yet.', [v.latest ?? '']) : ''
    ].filter(Boolean);
    note.textContent = notes.join(' ');
    note.hidden = !notes.length;
    const service = status?.service;
    const usable = !!(v?.installed || v?.unmanaged);
    serviceLine.hidden = !service;
    serviceActions.hidden = !service || !usable;
    if (service) {
      serviceLine.dataset.state = service.state;
      serviceLine.textContent = service.state === 'running'
        ? `${t('Background service running on port {0}', [String(service.port ?? '')])}${service.version ? ` · ${service.version}` : ''}${service.restartPending ? ` · ${t('Restarts with the new version when nothing is running')}` : ''}`
        : service.state === 'foreign'
          ? t('The background service runs another OpenCode program{0}. Restart it to use the one Chat Marks installed.', [service.version ? ` (${service.version})` : ''])
          : t('Background service stopped; it starts when an OpenCode chat or terminal needs it.');
      serviceButtons.get('start')!.hidden = service.state === 'running';
      serviceButtons.get('stop')!.hidden = service.state !== 'running';
      serviceButtons.get('restart')!.hidden = service.state === 'stopped';
      for (const button of serviceButtons.values()) button.disabled = busy;
    }
    const shown = busy && progress ? progressText(progress) : message;
    progressLine.textContent = shown;
    progressLine.hidden = !shown;
    const mode = v?.installed ? (v.updateAvailable ? 'update' : null) : (v?.latest && !v.latestUnsupported ? 'install' : null);
    action.hidden = !mode || !v?.installable;
    action.disabled = busy;
    action.dataset.mode = mode ?? '';
    action.textContent = mode === 'update' ? t('Update to {0}', [v!.latest ?? '']) : t('Install {0}', [v?.latest ?? '']);
  }

  async function refresh(force = false): Promise<void> {
    // A preload without the upstream channel (an older window, a partial test double) shows nothing.
    if (typeof api.upstreamStatus !== 'function') return;
    const reply = await api.upstreamStatus(id, force);
    if (reply.ok) status = reply.data;
    else message = reply.error;
    paint();
  }

  action.addEventListener('click', () => void (async () => {
    const v = status?.versions;
    const mode = action.dataset.mode as 'install' | 'update' | '';
    if (!v?.latest || !mode || busy) return;
    const question = mode === 'update'
      ? t('Update {0} to {1}? The official release is downloaded from {2} and checked against its published checksum. Running chats keep working; the new version is used from the next start.', [name, v.latest, SOURCES[id]()])
      : t('Install {0} {1}? The official release is downloaded from {2}, checked against its published checksum and installed for your user only.', [name, v.latest, SOURCES[id]()]);
    if (!window.confirm(question)) return;
    busy = true;
    message = '';
    paint();
    try {
      const reply = await api.upstreamInstall(id, mode, v.latest);
      if (reply.ok) { status = reply.data; message = t('Installed {0}.', [v.latest]); onInstalled(); }
      else message = upstreamErrorText(reply.error);
    } finally {
      busy = false;
      progress = null;
      paint();
    }
  })());

  for (const [op, button] of serviceButtons) button.addEventListener('click', () => void (async () => {
    if (busy || typeof api.upstreamService !== 'function') return;
    if (op !== 'start' && !window.confirm(op === 'stop'
      ? t('Stop the OpenCode background service? Running OpenCode answers and terminals lose their connection.')
      : t('Restart the OpenCode background service with the OpenCode Chat Marks uses? Running OpenCode answers are interrupted.'))) return;
    busy = true;
    message = '';
    paint();
    try {
      const reply = await api.upstreamService(op);
      if (reply.ok) { status = reply.data; onInstalled(); }
      else message = reply.error;
    } finally {
      busy = false;
      paint();
    }
  })());

  if (typeof api.onUpstreamProgress === 'function') api.onUpstreamProgress(next => {
    if (next.module !== id) return;
    progress = next;
    paint();
  });
  paint();
  return { refresh, get status() { return status; } };
}
