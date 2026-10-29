/** Optional third-party clients. Neither a VPN route nor a remote session is started on navigation. */
import type { AppApi } from '../preload/index.js';
import type { MarksModuleId, MarksModuleState } from '../shared/modules.js';
import { t } from './i18n.js';

const external = ['firefox-vpn', 'twindesk'] as const;
export function createExternalModulesUi(api: AppApi, parent: Element): { refresh(): Promise<void> } {
  const elements = new Map<string, { badge: HTMLElement; detail: HTMLElement; buttons: HTMLButtonElement[]; error: HTMLElement }>();
  let busy = false;
  let statuses: MarksModuleState[] = [];
  for (const id of external) {
    const section = document.createElement('section');
    section.className = 'appearance-section';
    section.dataset.module = id;
    const heading = document.createElement('header');
    heading.className = 'settings-section-head';
    const title = document.createElement('h2');
    title.textContent = id === 'twindesk' ? 'TwinDesk' : 'Firefox VPN';
    const explanation = document.createElement('p');
    explanation.textContent = id === 'twindesk'
      ? 'Acesso visual remoto assistido. O aplicativo separado exige pareamento próprio; nenhum dispositivo recebe acesso ao Chat Marks automaticamente.'
      : 'VPN e proxy independentes. O aplicativo separado gerencia contas, DNS, conexões e rotas; o Chat Marks não modifica a rede.';
    const label = document.createElement('div');
    label.append(title, explanation); heading.append(label);
    const surface = document.createElement('div'); surface.className = 'settings-surface modules-service';
    const badge = document.createElement('span'); badge.className = 'modules-status'; badge.setAttribute('role', 'status');
    badge.textContent = t('Checking status…');
    const detail = document.createElement('p'); detail.className = 'modules-detail';
    const actions = document.createElement('div'); actions.className = 'modules-service-actions';
    const buttons: HTMLButtonElement[] = [];
    for (const [name, action] of [['Installation guide', 'install'], ['Update from GitHub', 'update'], ['Open application', 'open']] as const) {
      const button = document.createElement('button'); button.className = 'btn'; button.type = 'button';
      button.textContent = t(name); button.disabled = true; button.dataset.action = action;
      button.addEventListener('click', async () => {
        if (busy) return;
        if (action === 'open' && !window.confirm(id === 'twindesk'
          ? 'Abrir o TwinDesk instalado? Qualquer pareamento ou acesso remoto exige sua autorização no próprio TwinDesk.'
          : 'Abrir o painel local do Firefox VPN? Alterações de rota ou conexão são feitas no próprio cliente.')) return;
        busy = true; paint();
        try {
          const response = await api.moduleAction(id as MarksModuleId, action);
          if (!response.ok) throw new Error(response.error);
          statuses = response.data;
          error.hidden = true;
        } catch (cause) {
          error.textContent = cause instanceof Error ? cause.message : 'Operation failed.';
          error.hidden = false;
        } finally { busy = false; paint(); }
      });
      buttons.push(button); actions.append(button);
    }
    const error = document.createElement('p'); error.className = 'modules-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    surface.append(badge, detail, actions, error); section.append(heading, surface); parent.append(section);
    elements.set(id, { badge, detail, buttons, error });
  }
  function paint(): void {
    for (const id of external) {
      const view = elements.get(id)!;
      const state = statuses.find(item => item.id === id);
      view.badge.dataset.state = !state ? 'unknown' : !state.installed ? 'missing' : 'stopped';
      view.badge.textContent = !state ? t('Status unavailable') : state.installed ? t('Installed') : t('Not installed');
      view.detail.textContent = state?.detail ?? '';
      for (const button of view.buttons) {
        button.disabled = busy || (button.dataset.action === 'open' && (!state?.supported || !state.installed));
      }
    }
  }
  async function refresh(): Promise<void> {
    if (busy) return;
    const reply = await api.modulesStatus();
    if (reply.ok) { statuses = reply.data; paint(); }
  }
  paint();
  return { refresh };
}
