/**
 * Chat Marks: the Claude Code Router card in Settings > Modules (main/ccr/). Versions (Chat Marks'
 * own copy, or the one the user installed), the latest npm release with its update badge and one
 * confirmed Install/Update button, the router's state with Start / Stop / Restart, and Open router
 * UI (main opens CCR's own web UI in the browser; its address never reaches this page). Main
 * downloads and verifies the release; this only asks and shows.
 */
import type { AppApi } from '../preload/index.js';
import type { CcrInstallMode, CcrInstallProgress, CcrServiceAction, CcrStatus } from '../shared/ccr-module.js';
import { moduleMark } from './chat-types.js';
import { t, ui } from './i18n.js';
import { upstreamErrorText } from './upstream-manage-ui.js';

const NAME = 'Claude Code Router';

/** Main's CCR-specific error codes, translated; the shared install codes come from the upstream card. */
export function ccrErrorText(code: string | undefined): string {
  switch (code) {
    case 'node_missing': return t('Claude Code Router needs Node.js 22 or newer, and none was found.');
    case 'node_too_old': return t('Claude Code Router needs Node.js 22 or newer.');
    case 'npm_missing': return t('Claude Code Router is installed with npm, and npm was not found.');
    case 'npm_failed': return t('npm could not install Claude Code Router or its dependencies.');
    case 'native_failed': return t('The native part of Claude Code Router (better-sqlite3) did not load, so nothing was changed.');
    case 'external_not_writable': return t('The installed copy cannot be updated without administrator rights. Update it yourself, or install the copy Chat Marks manages.');
    case 'not_installed': return t('Claude Code Router is not installed.');
    case 'start_failed': return t('Claude Code Router did not start. Open a terminal and run "ccr start" to see why.');
    case 'stop_failed': return t('Claude Code Router did not stop.');
    case 'ui_unavailable': return t('The router UI is not available. Start Claude Code Router first.');
    case 'unsupported_platform': return t('Automatic installation of Claude Code Router is available on Linux.');
    default: return upstreamErrorText(code);
  }
}

export interface CcrManageUi {
  refresh(force?: boolean): Promise<void>;
  readonly status: CcrStatus | null;
}

export function createCcrManageUi(api: AppApi, parent: Element, onChanged: () => void = () => undefined): CcrManageUi {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
    Object.assign(document.createElement(tag), props);
  const row = el('section', { className: 'appearance-section' });
  row.dataset.module = 'ccr';
  row.id = 'ccrModule';
  const title = el('h2', { textContent: NAME });
  title.translate = false;
  title.prepend(moduleMark('ccr'));
  const surface = el('div', { className: 'settings-surface modules-service' });
  const lead = el('p', { className: 'modules-detail' });
  ui(lead, 'textContent', () => t('A local gateway that Codex and Claude Code chats can route through ("Via Claude Code Router"). Claude Code Router configures those CLIs itself; Chat Marks never edits their settings files.'));
  const state = el('span', { className: 'modules-status', id: 'ccrState' });
  const installedLine = el('p', { className: 'modules-detail', id: 'ccrInstalledVersion' });
  const latestLine = el('p', { className: 'modules-detail', id: 'ccrLatestVersion' });
  const badge = el('span', { className: 'modules-status', hidden: true, id: 'ccrUpdateBadge' });
  badge.dataset.state = 'update';
  ui(badge, 'textContent', () => t('Update available'));
  const serviceLine = el('p', { className: 'modules-detail', id: 'ccrService' });
  const configuredLine = el('p', { className: 'modules-detail', id: 'ccrConfigured' });
  const note = el('p', { className: 'modules-detail cliproxy-warning', hidden: true, id: 'ccrNote' });
  const progressLine = el('p', { className: 'modules-detail', hidden: true, id: 'ccrProgress' });
  progressLine.setAttribute('role', 'status');
  const install = el('button', { type: 'button', className: 'btn primary', hidden: true, id: 'ccrInstall' });
  const own = el('button', { type: 'button', className: 'btn', hidden: true, id: 'ccrInstallOwn' });
  const service = new Map<CcrServiceAction, HTMLButtonElement>();
  const actions = el('div', { className: 'modules-service-actions' });
  actions.append(install, own);
  for (const op of ['start', 'stop', 'restart'] as const) {
    const button = el('button', { type: 'button', className: 'btn', id: `ccr${op[0]!.toUpperCase()}${op.slice(1)}` });
    ui(button, 'textContent', () => op === 'start' ? t('Start router') : op === 'stop' ? t('Stop router') : t('Restart router'));
    service.set(op, button);
    actions.append(button);
  }
  const openUi = el('button', { type: 'button', className: 'btn', id: 'ccrOpenUi' });
  ui(openUi, 'textContent', () => t('Open router UI'));
  actions.append(openUi);
  const head = el('div', { className: 'modules-service-head' });
  head.append(state);
  surface.append(head, lead, installedLine, latestLine, badge, serviceLine, configuredLine, note, progressLine, actions);
  row.append(title, surface);
  parent.append(row);

  let status: CcrStatus | null = null;
  let busy = false;
  let progress: CcrInstallProgress | null = null;
  let message = '';

  const progressText = (value: CcrInstallProgress): string =>
    value.phase === 'downloading' ? t('Downloading {0}…', [value.version])
      : value.phase === 'verifying' ? t('Verifying checksum…')
        : value.phase === 'installing' || value.phase === 'checking' ? t('Installing {0}…', [value.version])
          : value.phase === 'done' ? t('Installed {0}.', [value.version])
            : ccrErrorText(value.error);

  /** Which install action the primary button runs now. */
  function installMode(s: CcrStatus | null): CcrInstallMode | null {
    if (!s?.latest || !s.installable) return null;
    if (s.managed) return s.updateAvailable ? 'update' : null;
    if (s.external) return s.updateAvailable && s.external.writable ? 'update-external' : null;
    return s.latestUnsupported ? null : 'install';
  }

  function paint(): void {
    const s = status;
    const running = s?.service.state === 'running';
    const installed = !!s?.inUse;
    const shownState = !s ? 'unknown' : !installed ? 'missing' : running ? 'running' : 'stopped';
    state.dataset.state = shownState;
    state.textContent = shownState === 'running' ? t('Running') : shownState === 'stopped' ? t('Stopped') : shownState === 'missing' ? t('Not installed') : t('Checking status…');
    const managed = s?.managed;
    const external = s?.external;
    installedLine.textContent = managed
      ? `${t('Installed version')}: ${managed.version ?? '—'} (${t('managed by Chat Marks')})`
      : external ? t('Using installed {0} {1}', [external.path, external.version ?? '']) : `${t('Installed version')}: ${t('Not installed')}`;
    latestLine.textContent = `${t('Latest release')}: ${s?.latest ?? (s?.latestError ? ccrErrorText(s.latestError) : '—')}`;
    badge.hidden = !s?.updateAvailable;
    const where = s?.service.from === 'managed' ? t('started from the copy Chat Marks manages')
      : s?.service.from === 'external' ? t('started from the installed copy') : s?.service.from === 'other' ? t('started from another copy') : '';
    serviceLine.textContent = !s ? '' : running
      ? [t('Router running on {0}', [`${s.service.host}:${s.service.port}`]), where,
        s.service.restartPending ? t('Restarts with the new version when no routed chat is answering') : ''].filter(Boolean).join(' · ')
      : installed ? t('Router stopped. Claude Code chats on "Via Claude Code Router" use the CLI account meanwhile; Codex chats wait for it.') : '';
    serviceLine.hidden = !serviceLine.textContent;
    const targets = [s?.configured.claude ? 'Claude Code' : '', s?.configured.codex ? 'Codex' : ''].filter(Boolean);
    configuredLine.textContent = !s ? '' : targets.length
      ? t('Configured for {0}. Their chats can use "Via Claude Code Router".', [targets.join(', ')])
      : installed ? t('Not configured for Claude Code or Codex yet. Set them up in the router UI; the route appears in their chats once it is.') : '';
    configuredLine.hidden = !configuredLine.textContent;
    const notes = [
      s?.support === 'newer' ? t('This version is newer than the one Chat Marks was tested with.') : '',
      s?.support === 'unsupported' ? t('This version is not supported by this version of Chat Marks yet.') : '',
      s?.latestUnsupported ? t('Version {0} is not supported by this version of Chat Marks yet.', [s.latest ?? '']) : '',
      s && !s.installable && s.installBlocked ? ccrErrorText(s.installBlocked) : '',
      external && !managed && s?.updateAvailable && !external.writable ? ccrErrorText('external_not_writable') : ''
    ].filter(Boolean);
    note.textContent = notes.join(' ');
    note.hidden = !notes.length;
    const shown = busy && progress ? progressText(progress) : message;
    progressLine.textContent = shown;
    progressLine.hidden = !shown;
    const mode = installMode(s);
    install.hidden = !mode;
    install.dataset.mode = mode ?? '';
    install.disabled = busy;
    install.textContent = mode === 'update' ? t('Update to {0}', [s!.latest ?? '']) : mode === 'update-external' ? t('Update installed copy to {0}', [s!.latest ?? '']) : t('Install {0}', [s?.latest ?? '']);
    // A copy the user installed is used as it is; Chat Marks can also keep its own (it then takes precedence).
    own.hidden = !(s?.installable && external && !managed && s.latest && !s.latestUnsupported);
    own.disabled = busy;
    own.textContent = t('Install a copy managed by Chat Marks');
    service.get('start')!.hidden = !installed || running;
    service.get('stop')!.hidden = !installed || !running;
    service.get('restart')!.hidden = !installed || !running;
    openUi.hidden = !installed || !running || !s?.service.ui;
    for (const button of [...service.values(), openUi]) button.disabled = busy;
  }

  async function refresh(force = false): Promise<void> {
    if (typeof api.ccrStatus !== 'function') return;
    const reply = await api.ccrStatus(force);
    if (reply.ok) status = reply.data;
    else message = ccrErrorText(reply.error);
    paint();
  }

  async function runInstall(mode: CcrInstallMode): Promise<void> {
    const s = status;
    if (!s?.latest || busy) return;
    const question = mode === 'update-external'
      ? t('Update the Claude Code Router installed at {0} to {1}? npm replaces that copy in place, with the release checked against the registry\'s published checksum. The router restarts when no routed chat is answering.', [s.external?.path ?? '', s.latest])
      : mode === 'update'
        ? t('Update {0} to {1}? The official release is downloaded from {2} and checked against its published checksum. Running chats keep working; the router restarts with it when no routed chat is answering.', [NAME, s.latest, t('the npm registry')])
        : t('Install {0} {1} for your user? The official release is downloaded from {2} and checked against its published checksum; npm installs its dependencies without running their scripts.', [NAME, s.latest, t('the npm registry')]);
    if (!window.confirm(question)) return;
    busy = true;
    message = '';
    paint();
    try {
      const reply = await api.ccrInstall(mode, s.latest);
      if (reply.ok) { status = reply.data; message = t('Installed {0}.', [s.latest]); onChanged(); }
      else message = ccrErrorText(reply.error);
    } finally {
      busy = false;
      progress = null;
      paint();
    }
  }

  install.addEventListener('click', () => { const mode = install.dataset.mode as CcrInstallMode | ''; if (mode) void runInstall(mode); });
  own.addEventListener('click', () => void runInstall('install'));
  for (const [op, button] of service) button.addEventListener('click', () => void (async () => {
    if (busy) return;
    const routed = status?.service.routedTurns;
    if (op !== 'start' && !window.confirm(op === 'stop'
      ? (routed ? t('Stop Claude Code Router? Chats answering through it now are interrupted.') : t('Stop Claude Code Router? Chats on "Via Claude Code Router" cannot answer until it runs again.'))
      : (routed ? t('Restart Claude Code Router? Chats answering through it now are interrupted.') : t('Restart Claude Code Router?')))) return;
    busy = true;
    message = '';
    paint();
    try {
      const reply = await api.ccrService(op);
      if (reply.ok) { status = reply.data; onChanged(); }
      else message = ccrErrorText(reply.error);
    } finally {
      busy = false;
      paint();
    }
  })());
  openUi.addEventListener('click', () => void (async () => {
    if (busy) return;
    const reply = await api.ccrOpenUi();
    if (reply.ok) status = reply.data;
    else message = ccrErrorText(reply.error);
    paint();
  })());
  if (typeof api.onCcrProgress === 'function') api.onCcrProgress(next => { progress = next; paint(); });
  paint();
  return { refresh, get status() { return status; } };
}
