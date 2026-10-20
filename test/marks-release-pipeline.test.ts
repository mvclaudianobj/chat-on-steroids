import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';
// @ts-expect-error Release planner is an ESM Node script without a declaration file.
import { releaseTargets } from '../scripts/release-targets.mjs';
// @ts-expect-error Release artifact verification is an ESM Node script without types.
import { RELEASE_FILES } from '../scripts/verify-release-assets.mjs';
import { stagedArtifact, manualDownloadName, manualDownloadUrl } from '../src/main/update.js';
import { extensionDownloadUrl } from '../src/main/version.js';

const read = (filename: string): string => readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8');

it('checks only the Marks GitHub release and downloads its platform-specific binaries', () => {
  const update = read('src/main/update.ts');
  expect(update).toContain("const REPO = 'mvclaudianobj/chat-on-steroids'");
  expect(update).not.toContain("const REPO = 'totec448-spec/chat-on-steroids'");
  expect(stagedArtifact('win32', 'x64', undefined, true)?.name).toBe('Chat-Marks-Setup-x64.exe');
  expect(stagedArtifact('linux', 'x64', '/opt/marks.AppImage', true)?.name).toBe('Chat-Marks-Linux-x64.AppImage');
  // The generic packaged-Linux case is deliberately not classified as a Debian install.
  expect(stagedArtifact('linux', 'arm64', undefined, true)?.name).not.toBe('Chat-Marks-Linux-arm64.deb');
  expect(manualDownloadName('linux', 'arm64', undefined, true)).toBeNull();
  expect(manualDownloadUrl('2.1.37', 'Chat-Marks-Linux-arm64.deb')).toBe(
    'https://github.com/mvclaudianobj/chat-on-steroids/releases/download/v2.1.37/Chat-Marks-Linux-arm64.deb'
  );
  expect(extensionDownloadUrl('2.1.37')).toBe(
    'https://github.com/mvclaudianobj/chat-on-steroids/releases/download/v2.1.37/Chat-Marks-Extension.zip'
  );
});

it('makes the published file list exactly match the release planner and the packager', () => {
  const planned = releaseTargets('all').files as string[];
  // The four enabled platforms (macOS is declared but disabled for now) produce 8 core assets;
  // the tag-only Mozilla signing job adds the signed Firefox add-on and update manifest.
  expect(planned).toHaveLength(8);
  const targets = JSON.parse(read('.github/release-targets.json')) as Array<{ platform: string; enabled?: boolean }>;
  expect(targets.filter(target => target.platform === 'darwin').map(target => target.enabled)).toEqual([false, false]);
  expect(planned.some(name => name.includes('macOS'))).toBe(false);
  expect(RELEASE_FILES).toEqual([...planned, 'Chat-Marks-Firefox.xpi', 'firefox-updates.json']);
  expect(planned.every(name => name.startsWith('Chat-Marks-'))).toBe(true);
  const builder = loadYaml(read('electron-builder.yml')) as any;
  expect(builder.nsis.artifactName).toBe('Chat-Marks-Setup-${arch}.${ext}');
  expect(builder.mac.artifactName).toBe('Chat-Marks-macOS-${arch}.${ext}');
  expect(builder.linux.artifactName).toBe('Chat-Marks-Linux-${env.COS_PACKAGE_ARCH}.${ext}');
  expect(read('scripts/package-native-sources.mjs')).toContain('Chat-Marks-Native-Sources.tar.gz');
});

it('builds and publishes Marks tag releases, with checksums and post-release verification', () => {
  const publish = loadYaml(read('.github/workflows/publish.yml')) as any;
  const workflow = loadYaml(read('.github/workflows/release.yml')) as any;
  const verification = loadYaml(read('.github/workflows/verify-release.yml')) as any;
  // YAML 1.1 parsers can parse `on` as boolean true; require it in the source as well.
  expect(read('.github/workflows/publish.yml')).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:/);
  expect(publish.jobs.candidate.uses).toBe('./.github/workflows/release.yml');
  expect(publish.jobs.publish.permissions.contents).toBe('write');
  const publishScript = publish.jobs.publish.steps.find((step: any) => step.name === 'Publish the release').run;
  for (const name of RELEASE_FILES) expect(publishScript).toContain(`publish/${name}`);
  expect(publishScript).toContain('publish/SHA256SUMS.txt');
  const assembly = workflow.jobs.assemble.steps.find((step: any) => step.name === 'Create SHA-256 checksums').run;
  expect(assembly).toContain('sha256sum');
  expect(verification.jobs.verify.if).toBe("github.repository == 'mvclaudianobj/chat-on-steroids'");
  expect(read('.github/workflows/release.yml')).toContain('release/Chat-Marks-Extension.zip');
  const preflight = publish.jobs.preflight.steps.find((step: any) => step.name === 'Verify tag and release metadata agree');
  expect(preflight.run).toContain('node scripts/verify-release-version.mjs');
  // Complete platform suites run alongside packaging but still gate assembly. No architecture
  // gets to publish when any OS suite fails, and the slow Intel Mac can package immediately.
  expect(workflow.jobs.assemble.needs).toContain('contracts');
  const contractJobs = workflow.jobs.contracts.strategy.matrix.include;
  expect(contractJobs.map(({ platform, runner }: any) => [platform, runner])).toEqual([
    ['win32', 'windows-2025'], ['linux', 'ubuntu-24.04']
  ]);
  expect(workflow.jobs.contracts.steps.find((step: any) => step.name === 'Verify OS contracts').run).toBe('npm run verify:ci');
  expect(workflow.jobs.contracts.steps.find((step: any) => step.name === 'Verify OS contracts').env.COS_TEST_RETRY).toContain("matrix.platform == 'win32'");
  expect(workflow.jobs.package.needs).toBe('plan');
  expect(workflow.jobs.package.steps.some((step: any) => step.run === 'npm run verify:ci')).toBe(false);
  const cache = workflow.jobs.package.steps.find((step: any) => step.name === 'Reuse Electron packaging downloads');
  expect(cache.uses).toMatch(/^actions\/cache@[a-f0-9]{40}$/);
  expect(cache.with.key).toContain('matrix.arch');
  expect(cache.with.key).toContain("hashFiles('package-lock.json')");
  expect(cache.with.path).toContain('ELECTRON_CACHE');
  expect(cache.with.path).toContain('ELECTRON_BUILDER_CACHE');
  expect(workflow.jobs.package.steps.find((step: any) => step.name === 'Verify package metadata').run)
    .toContain('node scripts/verify-release-version.mjs --package-only');
  // Separating the full suite into parallel jobs must not drop the source/license
  // checks that ran on the three secondary native architectures before acceleration.
  const secondary = workflow.jobs.package.steps.find((step: any) => step.name === 'Verify source contracts (secondary architecture)');
  expect(secondary.if).toContain("matrix.platform == 'win32' && matrix.arch == 'arm64'");
  expect(secondary.if).toContain("matrix.platform == 'darwin' && matrix.arch == 'x64'");
  expect(secondary.if).toContain("matrix.platform == 'linux' && matrix.arch == 'arm64'");
  expect(secondary.run).toContain('npm run typecheck');
  expect(secondary.run).toContain('npm run verify:notices');
  expect(workflow.jobs.package.steps.indexOf(secondary)).toBeLessThan(
    workflow.jobs.package.steps.findIndex((step: any) => step.name === 'Package')
  );
  for (const name of ['Prove native runner target', 'Package', 'Smoke packaged runtime natively',
    'Audit packaged macOS bundle metadata and Mach-O payloads', 'Verify generated macOS archives',
    'Launch packaged macOS app normally', 'Install generated DEB on target distro',
    'Launch installed DEB normally under Xvfb', 'Execute generated static-runtime AppImage']) {
    expect(workflow.jobs.package.steps.some((step: any) => step.name === name), name).toBe(true);
  }
  const native = workflow.jobs.package.steps.find((step: any) => step.name === 'Verify tag matches package version');
  expect(native.run).toContain('node scripts/verify-release-version.mjs');
  const linuxScript = workflow.jobs.package.steps.find((step: any) => step.name === 'Install generated DEB on target distro').run;
  expect(linuxScript).toContain('node scripts/release-version.mjs --deb');
  const extensionScript = workflow.jobs.assemble.steps.find((step: any) => step.name === 'Package standalone extension').run;
  expect(extensionScript).toContain('node scripts/verify-release-version.mjs --package-only');
});
