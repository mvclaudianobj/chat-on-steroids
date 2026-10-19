import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ManagedSkill } from '../src/shared/skills.js';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.unstubAllGlobals(); vi.resetModules(); });

async function openBook(initial: ManagedSkill[] = []) {
  dom = new JSDOM(`<!doctype html><body>
    <input id="skillsSearch"><button id="skillsRefresh"></button>
    <details><summary>Import</summary><button id="skillsImportFolder"></button><button id="skillsImportFile"></button><button id="skillsImportGithub"></button></details>
    <dialog id="skillGithubDialog"><h2 id="skillGithubTitle"></h2><p id="skillGithubDescription"></p><button id="skillGithubClose"></button><form id="skillGithubForm"><input id="skillGithubUrl"><p id="skillGithubError"></p><button id="skillGithubCancel"></button><button id="skillGithubSubmit"></button></form></dialog>
    <span id="skillsCount"></span><div id="skillsInstalled"></div>
  </body>`, { url: 'https://skills.test/' });
  const w = dom.window;
  for (const [name, value] of Object.entries({ window: w, document: w.document, HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement, HTMLDialogElement: w.HTMLDialogElement })) vi.stubGlobal(name, value);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };

  let skills = initial;
  const listManagedSkills = vi.fn(async () => ({ ok: true as const, data: skills }));
  const skillsImportGithub = vi.fn<(_url: string) => Promise<{ ok: true; data: ManagedSkill[] } | { ok: false; error: string }>>();
  const { initSkillsLibrary } = await import('../src/renderer/skills-library.js');
  initSkillsLibrary({ listManagedSkills, skillsImportGithub } as any);
  await vi.waitFor(() => expect(w.document.querySelectorAll('[data-aihero-skill-id]')).toHaveLength(27));
  const search = w.document.getElementById('skillsSearch') as HTMLInputElement;
  const find = (id: string) => w.document.querySelector<HTMLElement>(`[data-aihero-skill-id="${id}"]`);
  const input = (value: string) => { search.value = value; search.dispatchEvent(new w.Event('input')); };
  const confirm = (id: string) => {
    find(id)!.querySelector<HTMLButtonElement>('.skill-aihero-install')!.click();
    return w.document.querySelector<HTMLDialogElement>('#skillAiheroConfirm')!;
  };
  const origin = (id: string): ManagedSkill => ({
    id, name: id, description: 'Installed from AI Hero.', path: `/skills/${id}/SKILL.md`, origin: {
      kind: 'github', url: `https://github.com/mattpocock/skills/tree/main/skills/engineering/${id}`,
      ref: 'main', directory: `skills/engineering/${id}`, commit: 'a'.repeat(40),
      revision: 'b'.repeat(64), skillSha256: 'c'.repeat(64)
    }
  });
  return { w, find, input, confirm, origin, skillsImportGithub, getSkills: () => skills, setSkills: (next: ManagedSkill[]) => { skills = next; } };
}

it('shows aihero.dev, searches categories, and imports only after confirmation with a bounded GitHub folder', async () => {
  const { w, find, input, confirm, origin, skillsImportGithub } = await openBook();
  expect(w.document.querySelector<HTMLAnchorElement>('#skillsAiheroSection a')!.href).toBe('https://www.aihero.dev/skills');
  input('diagnosing-bugs');
  expect(w.document.querySelectorAll('[data-aihero-skill-id]')).toHaveLength(1);
  expect(find('diagnosing-bugs')!.textContent).toContain('aihero.dev');
  const dialog = confirm('diagnosing-bugs');
  expect(dialog.textContent).toContain('no scripts are executed');
  expect(skillsImportGithub).not.toHaveBeenCalled();
  (dialog.querySelector('.pet-delete-cancel') as HTMLButtonElement).click();
  expect(skillsImportGithub).not.toHaveBeenCalled();

  let resolve!: (reply: { ok: true; data: ManagedSkill[] }) => void;
  skillsImportGithub.mockImplementationOnce(async () => await new Promise(done => { resolve = done; }));
  (confirm('diagnosing-bugs').querySelector('.skill-aihero-confirm') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(skillsImportGithub).toHaveBeenCalledWith(
    'https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnosing-bugs'));
  expect(find('diagnosing-bugs')!.textContent).toContain('Importing');
  expect(find('diagnosing-bugs')!.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  resolve({ ok: true, data: [origin('diagnosing-bugs')] });
  await vi.waitFor(() => expect(find('diagnosing-bugs')!.textContent).toContain('Installed'));
  expect(w.document.querySelector('[data-skill-id="diagnosing-bugs"] .skill-library-source')!.textContent).toContain('aihero.dev');
  expect(find('diagnosing-bugs')!.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);

  input('');
  w.document.querySelector<HTMLButtonElement>('[data-aihero-category="productivity"]')!.click();
  expect(w.document.querySelectorAll('[data-aihero-skill-id]').length).toBeGreaterThan(0);
  expect(find('diagnosing-bugs')).toBeNull();
  expect(find('handoff')).not.toBeNull();
  expect(w.document.querySelector('[data-aihero-category="productivity"]')!.getAttribute('aria-pressed')).toBe('true');
});

it('shows API failures with retry, and refuses overwriting a same-name local or foreign skill', async () => {
  const { w, find, input, confirm, origin, skillsImportGithub } = await openBook([
    { ...originStub('tdd'), origin: null },
    { ...originStub('code-review'), origin: { ...originStub('code-review').origin!,
      url: 'https://github.com/other/skills/tree/main/skills/engineering/code-review' } }
  ]);
  input('tdd');
  expect(find('tdd')!.textContent).toContain('Name in use');
  expect(find('tdd')!.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  input('code-review');
  expect(find('code-review')!.textContent).toContain('Name in use');
  expect(w.document.querySelector('[data-skill-id="code-review"] .skill-library-source')!.textContent).not.toContain('aihero.dev');
  input('grill-me');
  skillsImportGithub.mockResolvedValueOnce({ ok: false, error: 'GitHub API rate limit reached' });
  (confirm('grill-me').querySelector('.skill-aihero-confirm') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(find('grill-me')!.textContent).toContain('GitHub API rate limit reached'));
  expect(find('grill-me')!.querySelector('[role="alert"]')!.textContent).toContain('rate limit');
  expect(find('grill-me')!.textContent).toContain('Retry');
  const record = { ...origin('grill-me'), origin: {
    ...origin('grill-me').origin!, directory: 'skills/productivity/grill-me',
    url: 'https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me'
  } };
  skillsImportGithub.mockResolvedValueOnce({ ok: true, data: [record] });
  (confirm('grill-me').querySelector('.skill-aihero-confirm') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(find('grill-me')!.textContent).toContain('Installed'));
  expect(skillsImportGithub).toHaveBeenCalledTimes(2);
});

function originStub(id: string): ManagedSkill {
  return { id, name: id, description: 'existing', path: `/skills/${id}/SKILL.md`, origin: {
    kind: 'github', url: `https://github.com/acme/skills/tree/main/${id}`, ref: 'main', directory: id,
    commit: 'a'.repeat(40), revision: 'b'.repeat(64), skillSha256: 'c'.repeat(64)
  } };
}
