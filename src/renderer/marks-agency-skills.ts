/** Marks-owned optional Agency catalog and per-skill controls, isolated from the upstream Skills page. */
import type { AppApi } from '../preload/index.js';
import type { ManagedSkill } from '../shared/skills.js';
import type { MarksAgencyCatalog, MarksAgencyAgent, MarksAgencyInstalled } from '../shared/marks-agency-agents.js';
import { $, el, icon, toast } from './dom.js';
import { t } from './i18n.js';

/** Bridges the existing managed-skills owner without maintaining a second skills list. */
export interface MarksAgencySkillsHooks {
  getSkills(): ManagedSkill[];
  setSkills(next: ManagedSkill[]): void;
  updateSkills(request: ReturnType<AppApi['importAgencyAgent']>): Promise<boolean>;
}

export interface MarksAgencySkillsController {
  render(): void;
  refresh(force: boolean): Promise<void>;
  isAgencySkill(skill: ManagedSkill): boolean;
  paintSource(skill: ManagedSkill): boolean;
  appendCardActions(skill: ManagedSkill, actions: HTMLElement, menu: HTMLDetailsElement): boolean;
}

export function initMarksAgencySkills(api: AppApi, hooks: MarksAgencySkillsHooks): MarksAgencySkillsController {
  let agencyCatalog: MarksAgencyCatalog | null = null;
  let agencyLoading: Promise<void> | null = null;
  let agencyError = '';
  let agencyCategory = 'all';
  let agencyUpdatesOnly = false;
  const agencySection = typeof api.listAgencyAgents === 'function' ? document.createElement('section') : null;
  if (agencySection) {
    agencySection.id = 'skillsAgencySection';
    agencySection.className = 'plugin-section';
    const host = $('skillsInstalled').parentElement;
    if (host) host.append(agencySection);
  }

  const confirmAgencyImport = (agent: MarksAgencyAgent): void => {
    if (!agencyCatalog || typeof api.importAgencyAgent !== 'function') return;
    document.getElementById('skillAgencyConfirm')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'skillAgencyConfirm'; dialog.className = 'plugin-dialog pet-delete-dialog';
    const head = el('div', 'plugin-dialog-head');
    const title = el('h2', '', `Import ${agent.name}?`);
    const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
    close.type = 'button'; close.addEventListener('click', () => dialog.close());
    head.append(title, close);
    const body = el('div', 'plugin-dialog-body');
    body.append(el('p', '', 'Source: msitarzewski/agency-agents (MIT License).'));
    body.append(el('p', 'muted', `Pinned commit: ${agent.commit.slice(0, 12)}. Only this agent's Markdown is imported as a managed SKILL.md. No scripts are downloaded or executed. Imported agents require explicit invocation.`));
    const actions = el('div', 'pet-delete-actions');
    const cancel = el('button', 'btn pet-delete-cancel', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
    const importButton = el('button', 'btn btn-solid skill-agency-confirm', () => t('Import skill')) as HTMLButtonElement;
    importButton.type = 'button';
    importButton.addEventListener('click', () => void (async () => {
      importButton.disabled = cancel.disabled = close.disabled = true;
      try {
        if (await hooks.updateSkills(api.importAgencyAgent(agent.path, agent.commit))) {
          dialog.close(); toast(t('Skill added to your library'));
        }
      } finally { if (importButton.isConnected) importButton.disabled = cancel.disabled = close.disabled = false; }
    })());
    actions.append(cancel, importButton); body.append(actions);
    dialog.append(head, body); dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  };

  const confirmAgencyUpdate = (agent: MarksAgencyAgent, installed: MarksAgencyInstalled): void => {
    if (typeof api.updateAgencyAgent !== 'function' || installed.state === 'modified') return;
    document.getElementById('skillAgencyUpdateConfirm')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'skillAgencyUpdateConfirm'; dialog.className = 'plugin-dialog pet-delete-dialog';
    const header = el('div', 'plugin-dialog-head');
    header.append(el('h2', '', `Atualizar ${agent.name}?`));
    const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
    close.type = 'button'; close.addEventListener('click', () => dialog.close()); header.append(close);
    const body = el('div', 'plugin-dialog-body');
    body.append(el('p', '', `Versão instalada: ${installed.installedCommit.slice(0, 12)} · versão disponível: ${agent.commit.slice(0, 12)}`));
    body.append(el('p', 'muted', 'Apenas este agente .md será baixado do commit oficial verificado. As edições locais impedem a substituição; a versão anterior será preservada na Lixeira do sistema. Nenhum script será executado.'));
    const error = el('p', 'muted'); error.hidden = true; error.setAttribute('role', 'alert'); body.append(error);
    const actions = el('div', 'pet-delete-actions');
    const cancel = el('button', 'btn pet-delete-cancel', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
    const confirm = el('button', 'btn btn-solid skill-agency-update-confirm', 'Confirmar atualização') as HTMLButtonElement;
    confirm.type = 'button'; confirm.addEventListener('click', () => void (async () => {
      confirm.disabled = cancel.disabled = close.disabled = true;
      error.hidden = true;
      try {
        const response = await api.updateAgencyAgent(agent.path, agent.commit, agent.sha);
        if (!response.ok) { error.textContent = response.error; error.hidden = false; return; }
        hooks.setSkills(response.data.skills);
        dialog.close();
        toast(response.data.warning ? t(response.data.warning) : response.data.status === 'current' ? 'A skill já está atualizada.' : 'Skill Agency atualizada.');
        await loadAgency(true);
      } catch { error.textContent = 'A atualização falhou. Seus arquivos foram preservados.'; error.hidden = false; }
      finally { if (confirm.isConnected) confirm.disabled = cancel.disabled = close.disabled = false; }
    })());
    actions.append(cancel, confirm); body.append(actions);
    dialog.append(header, body); dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  };

  const renderAgency = (): void => {
    if (!agencySection) return;
    agencySection.replaceChildren();
    const header = el('div', 'plugin-page-head');
    const caption = el('div');
    caption.append(el('h2', '', 'Agency Agents / Skills Marks'),
      el('p', 'muted', 'Community roles by msitarzewski/agency-agents · MIT. Browse and import one at a time.'));
    const reload = el('button', 'btn skill-agency-catalog-refresh', 'Atualizar repositório Marks Agency Skills · catálogo') as HTMLButtonElement;
    reload.type = 'button'; reload.disabled = !!agencyLoading;
    reload.addEventListener('click', () => void loadAgency(true));
    const updates = el('button', 'btn skill-agency-updates-filter', agencyUpdatesOnly ? 'Mostrar catálogo completo' : 'Atualizar skills instaladas') as HTMLButtonElement;
    updates.type = 'button';
    updates.addEventListener('click', () => { agencyUpdatesOnly = !agencyUpdatesOnly; renderAgency(); });
    const actions = el('div', 'plugin-search-actions'); actions.append(reload, updates);
    header.append(caption, actions); agencySection.append(header);
    if (agencyError) agencySection.append(el('p', 'muted', agencyError));
    if (!agencyCatalog) {
      agencySection.append(el('p', 'muted', agencyLoading ? 'Loading Agency Agents catalog…' : 'Open Skills to browse the Agency Agents catalog.'));
      return;
    }
    const selector = el('select', 'btn skill-agency-category') as HTMLSelectElement;
    selector.setAttribute('aria-label', 'Agency Agents category');
    for (const category of ['all', ...new Set(agencyCatalog.agents.map(agent => agent.category))]) {
      const option = document.createElement('option'); option.value = category;
      option.textContent = category === 'all' ? 'All categories' : category.replaceAll('-', ' ');
      selector.append(option);
    }
    selector.value = agencyCategory;
    selector.addEventListener('change', () => { agencyCategory = selector.value; renderAgency(); });
    agencySection.append(selector);
    const query = $<HTMLInputElement>('skillsSearch').value.trim().toLocaleLowerCase();
    const statuses = new Map((agencyCatalog.installed ?? []).map(status => [status.id, status]));
    const visible = agencyCatalog.agents.filter(agent => (agencyCategory === 'all' || agencyCategory === agent.category) &&
      (!agencyUpdatesOnly || (statuses.has(agent.id) && statuses.get(agent.id)!.state !== 'current')) &&
      `${agent.id} ${agent.name} ${agent.path} ${agent.category}`.toLocaleLowerCase().includes(query));
    agencySection.append(el('p', 'muted', `${visible.length} de ${agencyCatalog.agents.length} agentes · ${agencyCatalog.commit.slice(0, 12)} · Atualizar catálogo consulta somente metadados; atualizar skills exige confirmação individual.`));
    const grid = el('div', 'plugin-card-grid');
    const installed = new Set(hooks.getSkills().map(skill => skill.id));
    for (const agent of visible.slice(0, 60)) {
      const card = el('article', 'plugin-card pet-library-card skill-library-card');
      card.dataset.agencyAgent = agent.path;
      const entry = el('div', 'plugin-entry pet-library-entry');
      const artwork = el('div', 'skill-library-icon'); artwork.append(icon('i-agents'));
      const text = el('div', 'plugin-card-title');
      text.append(el('h2', '', agent.name), el('p', 'muted', agent.category.replaceAll('-', ' ')));
      const foot = el('div', 'plugin-card-foot');
      foot.append(el('span', 'skill-library-id', `/${agent.id}`));
      const status = statuses.get(agent.id);
      if (status) {
        const textStatus = status.state === 'current' ? 'Atualizada' : status.state === 'available' ? 'Nova versão'
          : status.state === 'legacy' ? 'Instalação antiga: remover e importar novamente' : status.state === 'modified' ? 'Customizações locais' : 'Removida da origem';
        text.append(el('p', 'muted', `${textStatus} · instalada ${status.installedCommit.slice(0, 12)} → oficial ${agent.commit.slice(0, 12)}`));
      }
      const button = el('button', 'btn skill-agency-import', status
        ? status.state === 'available' ? 'Revisar atualização' : 'Instalada'
        : installed.has(agent.id) ? 'Installed' : 'Import') as HTMLButtonElement;
      button.type = 'button'; button.disabled = status ? status.state !== 'available' : installed.has(agent.id);
      button.addEventListener('click', () => status ? confirmAgencyUpdate(agent, status) : confirmAgencyImport(agent));
      foot.append(button); text.append(foot); entry.append(artwork, text); card.append(entry); grid.append(card);
    }
    agencySection.append(grid);
    const removed = (agencyCatalog.installed ?? []).filter(item => item.state === 'missing');
    if (removed.length) agencySection.append(el('p', 'muted', `${removed.length} skill(s) instaladas não constam mais do catálogo oficial; serão mantidas sem substituição.`));
    if (visible.length > 60) agencySection.append(el('p', 'muted', 'Showing the first 60 matches. Search or select a category to narrow the catalog.'));
  };

  const loadAgency = (force: boolean): Promise<void> => {
    if (!agencySection || typeof api.listAgencyAgents !== 'function') return Promise.resolve();
    if (agencyLoading) return agencyLoading;
    if (agencyCatalog && !force) return Promise.resolve();
    agencyError = '';
    agencyLoading = (async () => {
      try {
        const response = await api.listAgencyAgents();
        if (response.ok) agencyCatalog = response.data;
        else agencyError = response.error;
      } catch { agencyError = 'Could not load Agency Agents from GitHub.'; }
    })().finally(() => { agencyLoading = null; renderAgency(); });
    renderAgency();
    return agencyLoading;
  };
  const isAgencySkill = (skill: ManagedSkill): boolean => skill.id.startsWith('agency-');

  const paintSource = (skill: ManagedSkill): boolean => {
    if (!isAgencySkill(skill)) return false;
    const source = document.querySelector<HTMLElement>(`[data-skill-id="${skill.id}"] .skill-library-source`);
    if (source) {
      source.className = 'skill-library-source is-local';
      source.replaceChildren(icon('i-agents'), el('span', '', 'Agency Agents · Marks'));
      source.title = 'Use the Agency Agents catalog to review and update this skill explicitly.';
    }
    return true;
  };

  const appendCardActions = (skill: ManagedSkill, actions: HTMLElement, menu: HTMLDetailsElement): boolean => {
    if (!isAgencySkill(skill)) return false;
    const browse = el('button', 'btn', 'Review in Agency Agents') as HTMLButtonElement;
    browse.type = 'button';
    browse.addEventListener('click', () => {
      menu.open = false;
      agencyUpdatesOnly = true;
      renderAgency();
      agencySection?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    });
    actions.append(browse);
    return true;
  };

  return { render: renderAgency, refresh: loadAgency, isAgencySkill, paintSource, appendCardActions };
}
