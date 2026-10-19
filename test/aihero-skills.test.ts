import { describe, expect, it } from 'vitest';
import { AIHERO_SKILLS, AIHERO_SITE, aiheroSkillUrl, isAiheroSkillOrigin } from '../src/shared/aihero-skills.js';
import { parseGitHubSkillUrl, type GitHubSkillOrigin } from '../src/shared/skills.js';

describe('AI Hero public Skills catalog', () => {
  it('names unique bounded skill folders in the vetted mattpocock/skills repository', () => {
    expect(AIHERO_SITE).toBe('https://www.aihero.dev/skills');
    expect(AIHERO_SKILLS.length).toBeGreaterThan(20);
    expect(new Set(AIHERO_SKILLS.map(skill => skill.id)).size).toBe(AIHERO_SKILLS.length);
    for (const skill of AIHERO_SKILLS) {
      expect(skill.id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      expect(skill.description.length).toBeGreaterThan(5);
      expect(['engineering', 'productivity']).toContain(skill.category);
      const url = aiheroSkillUrl(skill);
      expect(parseGitHubSkillUrl(url)).toEqual({ owner: 'mattpocock', repository: 'skills', ref: 'main',
        directory: `skills/${skill.category}/${skill.id}` });
    }
  });

  it('badges actual AI Hero imports, never a same-name local or foreign GitHub skill', () => {
    const item = AIHERO_SKILLS.find(skill => skill.id === 'diagnosing-bugs')!;
    const source: GitHubSkillOrigin = {
      kind: 'github', url: aiheroSkillUrl(item), ref: 'main', directory: `skills/${item.category}/${item.id}`,
      commit: 'a'.repeat(40), revision: 'b'.repeat(64), skillSha256: 'c'.repeat(64)
    };
    expect(isAiheroSkillOrigin(source)).toBe(true);
    expect(isAiheroSkillOrigin(null)).toBe(false);
    expect(isAiheroSkillOrigin({ ...source, url: 'https://github.com/other/skills/tree/main/skills/engineering/diagnosing-bugs' })).toBe(false);
    expect(isAiheroSkillOrigin({ ...source, directory: 'skills/engineering/not-in-catalog' })).toBe(false);
  });
});
