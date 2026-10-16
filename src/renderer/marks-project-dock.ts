/**
 * Marks workspace picker for project-scoped right-side tools. A ChatGPT chat can
 * remain unassigned while a user explicitly chooses a local project to inspect.
 * This is presentation only: the backend still validates project IDs and roots.
 */
import type { LocalProject } from '../shared/projects.js';
import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';

export function showMarksProjectDockPicker(
  mount: HTMLElement,
  projects: readonly LocalProject[],
  choose: (projectId: string) => void,
  addProject?: () => void
): HTMLElement {
  const picker = el('section', 'marks-project-dock-picker');
  ui(picker, 'aria-label', () => t('Projects'));
  picker.append(
    el('h2', '', () => t('Open a project to use Files and Review')),
    el('p', '', () => t('Choose a local project for this panel. Your conversation stays where it is.'))
  );
  const list = el('div', 'marks-project-dock-list');
  for (const project of projects.filter(row => !row.ungrouped)) {
    const button = el('button', 'btn marks-project-dock-choice') as HTMLButtonElement;
    button.type = 'button';
    button.append(icon('i-folder'), el('span', '', project.name));
    button.title = project.path;
    button.addEventListener('click', () => choose(project.id));
    list.append(button);
  }
  picker.append(list);
  if (!list.childElementCount) {
    picker.append(el('p', '', () => t('No projects yet.')));
    if (addProject) {
      const add = el('button', 'btn btn-solid', () => t('Add a project folder')) as HTMLButtonElement;
      add.type = 'button';
      add.addEventListener('click', addProject);
      picker.append(add);
    }
  }
  mount.append(picker);
  return picker;
}
