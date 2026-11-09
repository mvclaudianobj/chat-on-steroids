/** Discover AI Hero Skills in the Book; installation stays with the managed GitHub importer. */
import type { ManagedSkill } from '../shared/skills.js';
import {
  AIHERO_SKILLS, AIHERO_SITE, AIHERO_CATALOG_REVISION,
  aiheroSkillUrl, isAiheroSkillOrigin, type AiHeroSkill
} from '../shared/aihero-skills.js';
import { el, icon, toast } from './dom.js';
import { t } from './i18n.js';

type Category = 'all' | AiHeroSkill['category'];

export interface AiheroSkillsHooks {
  getSkills(): ManagedSkill[];
  importSkill(url: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export function initAiheroSkills(hooks: AiheroSkillsHooks): { render(): void } {
  const parent = document.getElementById('skillsInstalled')?.parentElement;
  if (!parent) return { render() {} };

  const section = document.createElement('section');
  section.id = 'skillsAiheroSection';
  section.className = 'plugin-section';
  const heading = el('div', 'plugin-section-head');
  const title = el('h2', '', 'AI Hero');
  const count = el('span', 'plugin-count');
  title.append(' ', count);
  const link = el('a', 'muted', 'aihero.dev') as HTMLAnchorElement;
  link.href = AIHERO_SITE;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  heading.append(title, link);
  const intro = el('p', 'muted', 'Engineering and productivity skills by Matt Pocock. Import a selected GitHub folder after reviewing its source.');
  intro.title = `Catalog revision ${AIHERO_CATALOG_REVISION}`;
  const filters = el('div', 'skill-aihero-filters');
  const grid = el('div', 'pet-library-grid');
  grid.id = 'skillsAihero';
  section.append(heading, intro, filters, grid);
  parent.append(section);

  let category: Category = 'all';
  let importing: string | null = null;
  const errors = new Map<string, string>();
  const search = document.getElementById('skillsSearch') as HTMLInputElement;
  const categories: ReadonlyArray<{ id: Category; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'engineering', label: 'Engineering' },
    { id: 'productivity', label: 'Productivity' }
  ];

  const confirmedImport = (skill: AiHeroSkill): void => {
    if (importing) return;
    document.getElementById('skillAiheroConfirm')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'skillAiheroConfirm'; dialog.className = 'plugin-dialog pet-delete-dialog';
    const head = el('div', 'plugin-dialog-head');
    const title = el('h2', '', `Import ${skill.id}?`);
    title.id = 'skillAiheroConfirmTitle'; dialog.setAttribute('aria-labelledby', title.id);
    const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
    close.type = 'button'; close.addEventListener('click', () => dialog.close());
    head.append(title, close);
    const body = el('div', 'plugin-dialog-body');
    body.append(el('p', '', `Source: mattpocock/skills (${skill.category}) · aihero.dev`));
    body.append(el('p', 'skill-source-url', aiheroSkillUrl(skill)));
    body.append(el('p', 'muted', 'The public GitHub folder is checked for safe paths, file sizes and content hashes before import. Its files are saved to your Skills library; no scripts are executed during import. Review the Skill before using it.'));
    const actions = el('div', 'pet-delete-actions');
    const cancel = el('button', 'btn pet-delete-cancel', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
    const accept = el('button', 'btn btn-solid skill-aihero-confirm', () => t('Import skill')) as HTMLButtonElement;
    accept.type = 'button';
    accept.addEventListener('click', () => void (async () => {
      if (importing) return;
      importing = skill.id;
      errors.delete(skill.id);
      dialog.close();
      render();
      try {
        const result = await hooks.importSkill(aiheroSkillUrl(skill));
        if (result.ok) toast(t('Skill added to your library'));
        else errors.set(skill.id, result.error);
      } catch {
        errors.set(skill.id, t('Could not reach GitHub. Try again.'));
      } finally {
        importing = null;
        render();
      }
    })());
    actions.append(cancel, accept); body.append(actions); dialog.append(head, body);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('cancel', event => { if (importing) event.preventDefault(); });
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  };

  const render = (): void => {
    filters.replaceChildren();
    for (const option of categories) {
      const button = el('button', 'btn', option.label) as HTMLButtonElement;
      button.type = 'button'; button.dataset.aiheroCategory = option.id;
      button.setAttribute('aria-pressed', String(category === option.id));
      button.addEventListener('click', () => { category = option.id; render(); });
      filters.append(button);
    }
    const query = search?.value.trim().toLocaleLowerCase() ?? '';
    const matching = AIHERO_SKILLS.filter(skill =>
      (category === 'all' || skill.category === category) &&
      `${skill.id} ${skill.category} ${skill.description} aihero.dev Matt Pocock`.toLocaleLowerCase().includes(query));
    count.textContent = `${matching.length}/${AIHERO_SKILLS.length}`;
    grid.replaceChildren();
    if (!matching.length) {
      grid.append(el('p', 'plugin-no-results muted', () => t('No skills match your search.')));
      return;
    }
    const installed = new Map(hooks.getSkills().map(skill => [skill.id, skill]));
    for (const skill of matching) {
      const card = el('article', 'plugin-card pet-library-card skill-aihero-card');
      card.dataset.aiheroSkillId = skill.id;
      const entry = el('div', 'plugin-entry pet-library-entry');
      const artwork = el('div', 'skill-library-icon'); artwork.append(icon('i-skill'));
      const body = el('div', 'plugin-card-title');
      body.append(el('h2', '', skill.id.replaceAll('-', ' ')), el('p', 'muted', skill.description));
      const foot = el('div', 'plugin-card-foot');
      foot.append(el('span', 'skill-library-id', `/${skill.id}`), el('span', 'skill-library-source', `aihero.dev · ${skill.category}`));
      const installedSkill = installed.get(skill.id);
      const owned = installedSkill?.origin?.directory === `skills/${skill.category}/${skill.id}` &&
        isAiheroSkillOrigin(installedSkill.origin);
      const button = el('button', 'btn skill-aihero-install') as HTMLButtonElement;
      button.type = 'button';
      button.textContent = owned ? 'Installed' : installedSkill ? 'Name in use'
        : importing === skill.id ? 'Importing…' : errors.has(skill.id) ? 'Retry' : t('Install');
      button.disabled = Boolean(installedSkill || importing);
      button.addEventListener('click', () => confirmedImport(skill));
      foot.append(button);
      body.append(foot);
      const error = errors.get(skill.id);
      if (error && !installedSkill) {
        const alert = el('p', 'plugin-error', error);
        alert.setAttribute('role', 'alert');
        body.append(alert);
      }
      entry.append(artwork, body); card.append(entry); grid.append(card);
    }
  };

  return { render };
}
