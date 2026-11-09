/** AI Hero's published engineering/productivity catalog: links only, no bundled third-party code.
 * Metadata from mattpocock/skills (MIT), revision 49dd158d1076134a641b33efb035946536778336.
 * Every install fetches the selected folder through the existing validated GitHub importer.
 */
import { parseGitHubSkillUrl, type GitHubSkillOrigin } from './skills.js';

export const AIHERO_CATALOG_REVISION = '49dd158d1076134a641b33efb035946536778336';
export const AIHERO_SITE = 'https://www.aihero.dev/skills';
export const AIHERO_REPOSITORY = 'https://github.com/mattpocock/skills';
export type AiHeroSkill = { id: string; category: 'engineering' | 'productivity'; description: string };
export const AIHERO_SKILLS: readonly AiHeroSkill[] = [
  {
    "id": "ask-matt",
    "category": "engineering",
    "description": "Ask which skill or flow fits your situation. A router over the skills in this repo."
  },
  {
    "id": "code-review",
    "category": "engineering",
    "description": "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what…"
  },
  {
    "id": "codebase-design",
    "category": "engineering",
    "description": "Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a seam goes, make code more testable or…"
  },
  {
    "id": "diagnosing-bugs",
    "category": "engineering",
    "description": "Diagnosis loop for hard bugs and performance regressions. Use when the user says \"diagnose\"/\"debug this\", or reports something broken/throwing/failing/slow."
  },
  {
    "id": "domain-modeling",
    "category": "engineering",
    "description": "Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing a GLOSSARY.md, or recording or editing an ADR."
  },
  {
    "id": "grill-with-docs",
    "category": "engineering",
    "description": "A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go."
  },
  {
    "id": "implement",
    "category": "engineering",
    "description": "Implement a piece of work based on a spec or set of tickets."
  },
  {
    "id": "implement-spec",
    "category": "engineering",
    "description": "Implement the result of /to-spec and /to-tickets in code."
  },
  {
    "id": "improve-codebase-architecture",
    "category": "engineering",
    "description": "Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick."
  },
  {
    "id": "pr",
    "category": "engineering",
    "description": "Use when writing a PR body."
  },
  {
    "id": "prototype",
    "category": "engineering",
    "description": "Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like."
  },
  {
    "id": "research",
    "category": "engineering",
    "description": "Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading…"
  },
  {
    "id": "retro",
    "category": "engineering",
    "description": "Conduct a retrospective on a coding session."
  },
  {
    "id": "setup-matt-pocock-skills",
    "category": "engineering",
    "description": "Configure this repo for the engineering skills: set up its issue tracker, triage label vocabulary, and domain doc layout. Run once before first use of the other engineering skills."
  },
  {
    "id": "tdd",
    "category": "engineering",
    "description": "Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions \"red-green-refactor\", or wants integration tests."
  },
  {
    "id": "to-spec",
    "category": "engineering",
    "description": "Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed."
  },
  {
    "id": "to-tickets",
    "category": "engineering",
    "description": "Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker (edges as text in one file per ticket…"
  },
  {
    "id": "triage",
    "category": "engineering",
    "description": "Move issues and external PRs through a state machine of triage roles, categorise, verify, grill if needed, and write agent-ready briefs."
  },
  {
    "id": "wayfinder",
    "category": "engineering",
    "description": "Plan a huge chunk of work (more than one agent session can hold) as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear."
  },
  {
    "id": "wizard",
    "category": "engineering",
    "description": "Generate an interactive bash wizard that walks a human through steps only they can perform. Use when provisioning infrastructure, setting up credentials or CI secrets, walking an unfamiliar third-party…"
  },
  {
    "id": "grill-me",
    "category": "productivity",
    "description": "A relentless interview to sharpen a plan or design."
  },
  {
    "id": "grilling",
    "category": "productivity",
    "description": "Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases."
  },
  {
    "id": "handoff",
    "category": "productivity",
    "description": "Compact the current conversation into a handoff document for another agent to pick up."
  },
  {
    "id": "teach",
    "category": "productivity",
    "description": "Teach the user a new skill or concept, within this workspace."
  },
  {
    "id": "to-questionnaire",
    "category": "productivity",
    "description": "Turn a decision you can't fully answer into a questionnaire for someone else to fill in."
  },
  {
    "id": "wait-what",
    "category": "productivity",
    "description": "Stop. That last message did not land: re-pitch it."
  },
  {
    "id": "writing-for-agents",
    "category": "productivity",
    "description": "Writing documents for agents. Use when creating or editing skills, or modifying AGENTS.md or CLAUDE.md."
  }
];

export function aiheroSkillUrl(skill: AiHeroSkill): string {
  return `${AIHERO_REPOSITORY}/tree/main/skills/${skill.category}/${skill.id}`;
}

/** The brand follows an actual GitHub origin, never just a colliding local skill ID. */
export function isAiheroSkillOrigin(origin: GitHubSkillOrigin | null): boolean {
  if (!origin) return false;
  try {
    const location = parseGitHubSkillUrl(origin.url);
    return location.owner.toLowerCase() === 'mattpocock' && location.repository.toLowerCase() === 'skills' &&
      AIHERO_SKILLS.some(skill => origin.directory === `skills/${skill.category}/${skill.id}`);
  } catch { return false; }
}
