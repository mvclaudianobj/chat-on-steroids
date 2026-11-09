import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { companySnapshotSchema, emptyCompany } from '../src/shared/company.js';
import { getCompany, initCompanyStore, mutateCompany, resetCompanyStoreForTests } from '../src/main/company-store.js';

describe('Company persisted state compatibility', () => {
  it.skipIf(!process.env.MARKS_COMPANY_COMPAT_FILE)('reads the existing Company state without touching disk', () => {
    const raw = JSON.parse(readFileSync(process.env.MARKS_COMPANY_COMPAT_FILE!, 'utf8'));
    const result = companySnapshotSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Company schema rejection: ${JSON.stringify(result.error.issues.map(issue => ({
        path: issue.path, code: issue.code, message: issue.message
      })))}`);
    }
    expect(result.data.requests.length).toBe(raw.requests.length);
    expect(result.data.activities.length).toBe(raw.activities.length);
  });
  it('retains historical project and engine selections through a save round trip', () => {
    const historical = {
      ...emptyCompany(),
      company: {
        ...emptyCompany().company,
        executionProfiles: { projectA: { engine: 'codex', model: 'example' } },
        projectCoordinators: { projectA: 'marks1' },
        projectCoordinatorModes: { projectA: 'manual' }
      },
      projectChatBindings: [{
        projectId: 'projectA', principal: 'marks1', sessionId: 'sessionA', openingEngine: 'chatgpt'
      }]
    };
    const loaded = companySnapshotSchema.parse(historical);
    const saved = companySnapshotSchema.parse(JSON.parse(JSON.stringify(loaded)));
    expect(saved.company.executionProfiles).toEqual(historical.company.executionProfiles);
    expect(saved.company.projectCoordinators).toEqual(historical.company.projectCoordinators);
    expect(saved.company.projectCoordinatorModes).toEqual(historical.company.projectCoordinatorModes);
    expect(saved.projectChatBindings).toEqual(historical.projectChatBindings);
  });

  it('reads and saves a historical snapshot when unrelated Company settings change', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'marks-company-compat-'));
    const initial = {
      ...emptyCompany(),
      company: {
        ...emptyCompany().company,
        executionProfiles: { projectA: { engine: 'codex', model: 'legacy-model' } },
        projectCoordinators: { projectA: 'marks2' },
        projectCoordinatorModes: { projectA: 'manual' }
      },
      projectChatBindings: [{ projectId: 'projectA', principal: 'marks2', sessionId: 'sessionA', openingEngine: 'chatgpt' }]
    };
    try {
      await fs.mkdir(path.join(dir, 'company'));
      await fs.writeFile(path.join(dir, 'company', 'company.json'), JSON.stringify(initial));
      initCompanyStore(dir);
      expect((await getCompany()).projectChatBindings).toEqual(initial.projectChatBindings);
      await mutateCompany('configure', { name: 'Recovered Company', seatCount: initial.company.seatCount });
      const reloaded = JSON.parse(await fs.readFile(path.join(dir, 'company', 'company.json'), 'utf8'));
      expect(reloaded.company.name).toBe('Recovered Company');
      expect(reloaded.company.executionProfiles).toEqual(initial.company.executionProfiles);
      expect(reloaded.company.projectCoordinators).toEqual(initial.company.projectCoordinators);
      expect(reloaded.company.projectCoordinatorModes).toEqual(initial.company.projectCoordinatorModes);
      expect(reloaded.projectChatBindings).toEqual(initial.projectChatBindings);
    } finally {
      resetCompanyStoreForTests();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('continues rejecting invalid Company authority and unexpected top-level fields', () => {
    const valid = emptyCompany();
    expect(companySnapshotSchema.safeParse({ ...valid, unexpected: 'authority' }).success).toBe(false);
    expect(companySnapshotSchema.safeParse({ ...valid, confirmedChatBindings: { marks1: { confirmedBy: 'api' } } }).success).toBe(false);
  });
});
