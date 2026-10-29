import type { AppApi } from '../preload/index.js';
import { t, onLanguageChange, ui } from './i18n.js';
import { createWorkspaceTerminal } from './workspace-terminal.js';
import type { LocalProject } from '../shared/projects.js';

interface Host { id: string; name: string; type: string; host: string; port: number; user: string }
interface Reply { ok: boolean; data?: unknown; error?: string }
export function initRemoteHostsUi(api: AppApi): void {
  const root = document.getElementById('remoteHosts'); if (!root) return;
  const walker = document.createTreeWalker(root, 4);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, original = node.textContent ?? '', source = original.trim();
    if (source) ui(node, 'textContent', () => original.replace(source, t(source)));
  }
  const input = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
  const call = (action: string, payload?: unknown) => api.remoteHosts(action, payload) as Promise<Reply>;
  const message = root.querySelector<HTMLElement>('#remoteMessage')!;
  const rows = root.querySelector<HTMLElement>('#remoteRows')!;
  const previewRows = root.querySelector<HTMLElement>('#remotePreviewRows')!;
  const pending = root.querySelector<HTMLElement>('#remotePending')!;
  const terminalMount = root.querySelector<HTMLElement>('#remoteTerminalMount')!;
  let terminal: ReturnType<typeof createWorkspaceTerminal> | null = null;
  const floating = document.createElement('aside');
  floating.id = 'remoteApprovalBanner'; floating.setAttribute('role', 'alert'); floating.hidden = true;
  floating.style.cssText = 'position:fixed;z-index:1201;right:16px;top:64px;max-width:min(640px,90vw);max-height:70vh;overflow:auto;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--page);color:var(--ink);box-shadow:0 4px 24px #0005;';
  document.body.append(floating);
  const action = async (fn: () => Promise<Reply>): Promise<void> => {
    try { const result = await fn(); message.textContent = result.ok ? t('Remote operation completed.') : t('Remote operation failed. Check SSH trust and key.'); await refresh(); }
    catch { message.textContent = t('Remote operation failed. Check SSH trust and key.'); }
  };
  const button = (label: string, callback: () => void): HTMLButtonElement => {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'btn'; node.textContent = t(label); node.addEventListener('click', callback); return node;
  };
  async function refresh(): Promise<void> {
    const list = await call('list'); rows.replaceChildren();
    if (list.ok && Array.isArray(list.data)) for (const host of list.data as Host[]) {
      const row = document.createElement('div'); row.className = 'setting';
      const label = document.createElement('span'); label.className = 'setting-text';
      label.textContent = `${host.name} · ${host.type.toUpperCase()} · ${host.user}@${host.host}:${host.port}`;
      row.append(label);
      if (host.type === 'ssh') {
        row.append(button('Test connection', () => void action(() => call('test', { name: host.name }))));
        row.append(button('Trust host fingerprint', () => void (async () => {
          const result = await call('fingerprint', { name: host.name });
          if (!result.ok) { message.textContent = t('Could not read the server fingerprint.'); return; }
          const candidate = result.data as { known: boolean; fingerprint: string };
          if (candidate.known) { message.textContent = t('This host is already trusted.'); return; }
          if (!window.confirm(t('Confirm the host fingerprint for {0}?\n{1}', [`${host.host}:${host.port}`, candidate.fingerprint]))) return;
          await action(() => call('trust', { name: host.name, fingerprint: candidate.fingerprint }));
        })()));
        row.append(button('Install master key on this host', () => {
          const passwordInput = input('remotePassword');
          const password = passwordInput.value;
          passwordInput.value = '';
          if (!password) { message.textContent = t('Enter the server password for one-time key installation.'); return; }
          void action(() => call('install', { name: host.name, password }));
        }));
        row.append(button('Open as project', () => void action(() => call('project', { name: host.name, folder: input('remoteFolder').value }))));
        row.append(button('Open terminal on this host', () => void (async () => {
          const result = await call('project', { name: host.name, folder: input('remoteFolder').value || '~' });
          if (!result.ok || !result.data) { message.textContent = t('Remote operation failed. Check SSH trust and key.'); return; }
          if (!terminal) terminal = createWorkspaceTerminal(() => undefined, terminalMount, { id: 'remoteHostsTerminal' });
          terminalMount.hidden = false;
          terminal.update(result.data as LocalProject);
          terminal.show(terminalMount, false);
          if (!terminal.newTab()) message.textContent = t('Close a terminal before opening another (maximum 8)');
        })()));
      }
      row.append(button('Remove host', () => void action(() => call('delete', { id: host.id })))); rows.append(row);
    }
    await refreshPending();
  }
  async function refreshPending(): Promise<void> {
    const approvals = await call('pending');
    if (!approvals.ok || !Array.isArray(approvals.data)) return;
    const signature = JSON.stringify(approvals.data);
    if (pending.dataset.signature === signature) return;
    pending.dataset.signature = signature;
    pending.replaceChildren(); floating.replaceChildren(); floating.hidden = approvals.data.length === 0;
    if (approvals.ok && Array.isArray(approvals.data)) for (const request of approvals.data as Array<{ id: string; chat: string; host: string; command: string }>) {
      const row = document.createElement('div'); row.className = 'settings-surface pane';
      const label = document.createElement('span'); label.className = 'setting-text';
      label.textContent = `${t('Chat')} ${request.chat} · ${request.host}`;
      const command = document.createElement('pre'); command.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; command.textContent = request.command;
      row.append(label, command);
      for (const [choice, caption] of [['once','Allow once'], ['session','Allow in this chat until app exits'], ['deny','Deny']] as const)
        row.append(button(caption, () => void action(() => call('decide', { id: request.id, choice }))));
      floating.append(row);
    }
    pending.textContent = approvals.data.length ? t('Remote command approvals') : '';
  }
  root.querySelector('#remoteSave')!.addEventListener('click', () => void action(() => call('save', {
    name: input('remoteName').value, type: input('remoteType').value, host: input('remoteAddress').value,
    port: Number(input('remotePort').value), user: input('remoteUser').value
  })));
  root.querySelector('#remoteUnlock')!.addEventListener('click', () => void action(() => call('unlock')));
  root.querySelector('#remotePreview')!.addEventListener('click', () => void (async () => {
    const response = await call('preview'); previewRows.replaceChildren();
    input('remoteImport').disabled = !response.ok || !Array.isArray(response.data) || response.data.length === 0;
    if (!response.ok) { message.textContent = t('Cannot read the original catalog. Copy remote-targets.json to a readable location and select the copy.'); return; }
    for (const host of response.data as Host[]) {
      const row = document.createElement('p'); row.textContent = `${host.name} · ${host.type} · ${host.user}@${host.host}:${host.port}`; previewRows.append(row);
    }
  })());
  root.querySelector('#remoteImport')!.addEventListener('click', () => void action(async () => {
    const response = await call('import'); previewRows.replaceChildren(); input('remoteImport').disabled = true; return response;
  }));
  root.querySelector('#remoteTerminalClose')!.addEventListener('click', () => {
    terminal?.hide(); terminalMount.hidden = true;
  });
  onLanguageChange(() => { delete pending.dataset.signature; void refresh(); });
  const unsubscribe = api.onRemoteApprovalsChanged(() => { void refreshPending(); });
  window.addEventListener('beforeunload', unsubscribe, { once: true });
  void refresh();
}
