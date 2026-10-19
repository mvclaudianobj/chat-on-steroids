/** A fast, fail-early tripwire for future merges from the community repository.
 * Presence checks never replace focused behavior tests, but they catch an upstream
 * merge that silently erases an exclusive Marks entry point before packaging.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

it('keeps the mandatory MarksPanel boundary and seven-day, non-sliding login', () => {
  const main = source('src/main/index.ts');
  const auth = source('src/main/markspanel-auth.ts');
  expect(main).toContain('requireMarkspanelLogin(');
  expect(main).toContain('startMarkspanelSessionMonitor(');
  expect(auth).toContain('const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000');
  expect(auth).toContain('authenticatedAt: previous?.authenticatedAt ?? Date.now()');
  expect(auth).toContain('loginStillCurrent(data)');
  for (const file of ['src/main/cli-modules.ts', 'src/main/cli-chat.ts', 'src/main/ipc.ts']) {
    expect(source(file), file).toContain('markspanelAccessBlocked');
  }
});

it('preserves desktop modules, projects and the Marks Agency Skills catalog', () => {
  const renderer = source('src/renderer/main.ts');
  expect(renderer).toContain('initMarksModulesUi(');
  expect(renderer).toContain('marksModulesUi.paintNavigation(');
  expect(source('src/renderer/skills-library.ts')).toContain('initMarksAgencySkills(');
  expect(source('src/main/marks-agency-agents.ts')).toContain("const REPOSITORY = 'msitarzewski/agency-agents'");
  expect(source('src/main/cli-modules.ts')).toContain('MarksClaw');
  expect(source('src/renderer/workspace-terminal.ts')).toContain('project');
});

it('preserves app identity, executable artwork and Marks-only update origin', () => {
  const icons = source('scripts/make-icon.mjs');
  expect(icons).toContain("'icon_marks.png'");
  expect(source('src/main/index.ts')).toContain('browserWindowIconPath(');
  expect(source('src/main/index.ts')).toContain('window.setIcon?.(icon)');
  expect(source('src/main/window-icon.ts')).toContain('runtime-icon.png');
  expect(source('src/main/update.ts')).toContain("const REPO = 'mvclaudianobj/chat-on-steroids'");
  expect(source('src/main/version.ts')).toContain('mvclaudianobj/chat-on-steroids');
});
