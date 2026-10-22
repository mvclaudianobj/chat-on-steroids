/** Vault administration stays in a human-only Settings section. */
import type { AppApi } from '../preload/index.js';
import { toast } from './dom.js';

interface VaultResult { ok: boolean; data?: unknown; error?: string }
export function initMarksVaultUi(api: AppApi): void {
  const root = document.getElementById('marksVault');
  if (!root) return;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const pass = () => ($('vaultMaster') as HTMLInputElement).value;
  const entry = (id: string) => ($(`vault${id}`) as HTMLInputElement).value;
  const call = async (action: string, data?: unknown): Promise<VaultResult> => api.vault(action, data) as Promise<VaultResult>;
  const status = $('vaultStatus');
  const rows = $('vaultEntries');
  const pending = $('vaultPending');
  const floating = document.createElement('aside');
  floating.id = 'marksVaultApprovalBanner';
  floating.setAttribute('role', 'alert');
  floating.setAttribute('aria-label', 'Secret approval required');
  floating.style.cssText = 'position:fixed;z-index:1200;right:16px;bottom:16px;max-width:min(500px,90vw);padding:16px;border:1px solid var(--border, #777);border-radius:12px;background:var(--surface, #202027);color:inherit;box-shadow:0 4px 24px #0005;';
  floating.hidden = true;
  document.body.append(floating);
  const action = async (fn: () => Promise<VaultResult>, refreshAfter = true): Promise<void> => {
    try {
      const result = await fn();
      if (!result.ok) throw new Error('Operation failed');
      toast('Vault operation completed.');
      if (refreshAfter) await refresh();
    } catch { toast('Vault action failed. Verify master password and permissions.'); }
    finally { ($('vaultMaster') as HTMLInputElement).value = ''; ($('vaultGpgPassword') as HTMLInputElement).value = ''; ($('vaultNewPassword') as HTMLInputElement).value = ''; }
  };
  async function refresh(): Promise<void> {
    const state = await call('status');
    if (state.ok && state.data && typeof state.data === 'object') {
      const s = state.data as { created: boolean; ready: boolean; count: number | null };
      status.textContent = !s.created ? 'Vault not created.' : s.ready ? `${s.count} secret(s) stored securely.` : 'Vault requires master password recovery on this computer.';
    } else status.textContent = 'Vault unavailable.';
    const listed = await call('list');
    rows.replaceChildren();
    if (listed.ok && Array.isArray(listed.data)) for (const item of listed.data as Array<{ name: string; origin: string; header: string }>) {
      const row = document.createElement('p');
      row.textContent = `${item.name} · ${item.origin || 'Local only'} · ${item.header}`;
      rows.append(row);
    }
    await refreshPending();
  }
  async function refreshPending(): Promise<void> {
    const response = await call('pending');
    if (!response.ok || !Array.isArray(response.data)) return;
    pending.replaceChildren();
    floating.replaceChildren();
    const requests = response.data as Array<{ id: string; chat: string; name: string; operation: string }>;
    floating.hidden = requests.length === 0;
    for (const request of requests) {
      const block = document.createElement('div'); block.className = 'setting';
      const caption = document.createElement('span'); caption.className = 'setting-text';
      // Opaque identifiers and names only; no secret value is ever shown here.
      caption.textContent = `Chat ${request.chat} requests [secret:${request.name}] · ${request.operation}`;
      block.append(caption);
      for (const [choice, label] of [['once','Allow once'], ['session','Allow for this chat until app exits'], ['deny','Deny']] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = label;
        button.addEventListener('click', () => void action(() => call('decide', { id: request.id, choice })));
        block.append(button);
      }
      pending.append(block);
    }
    if (requests.length > 0) {
      const text = document.createElement('p'); text.textContent = `${requests.length} chat secret request(s) awaiting approval. No value will be shown to the model.`;
      const review = document.createElement('button'); review.type = 'button'; review.className = 'btn'; review.textContent = 'Review and approve';
      review.addEventListener('click', () => document.querySelector<HTMLButtonElement>('[data-tab="general"]')?.click());
      floating.append(text, review);
    }
  }
  const buttons: Record<string, () => Promise<VaultResult>> = {
    vaultCreate: () => call('create', { password: pass() }),
    vaultRecover: () => call('recover', { password: pass() }),
    vaultSave: () => call('put', { password: pass(), name: entry('Name'), value: entry('Value'), origin: entry('Origin'), header: entry('Header') }),
    vaultRemove: () => call('remove', { password: pass(), name: entry('Name') }),
    vaultImport: () => call('import', { password: pass() }),
    vaultImportGpg: () => call('importGpg', { password: pass(), gpgPassword: entry('GpgPassword') }),
    vaultExport: () => call('export', { password: pass() }),
    vaultChangePassword: () => call('changePassword', { oldPassword: pass(), newPassword: entry('NewPassword') })
  };
  for (const [id, fn] of Object.entries(buttons)) $(id).addEventListener('click', () => void action(fn));
  $('vaultReveal').addEventListener('click', () => void action(async () => {
    const result = await call('reveal', { password: pass(), name: entry('Name') });
    if (result.ok) {
      const text = String(result.data);
      // Deliberate admin reveal; never enter console, a toast, the timeline or app state.
      ($('vaultValue') as HTMLInputElement).value = text;
      ($('vaultValue') as HTMLInputElement).type = 'password';
      toast('Secret loaded into the protected password input.');
    }
    return result;
  }, false));
  $('vaultPendingRefresh').addEventListener('click', () => void refreshPending());
  // Only poll while General Settings is open, and never store value fields in state.
  const interval = setInterval(() => {
    const section = root.closest('[data-panel]');
    if (section?.classList.contains('is-active')) void refreshPending();
  }, 2500);
  void interval;
  void refresh();
}
