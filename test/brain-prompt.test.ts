import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import path from 'node:path';

const settings = vi.hoisted(() => ({ autoInject: true }));
vi.mock('../src/main/brain/settings.js', () => ({ getBrainSettings: () => ({ enginesEnabled: false, askBeforeSaving: true, chatgptTools: false, apiChatTools: false, ...settings }) }));

import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { prepareSessionPrompt, prepareSkillFollowup } from '../src/main/session/prompt.js';
import { brainSave, configureBrainForTests } from '../src/main/brain/store.js';
import { MAX_CHATGPT_MESSAGE_CHARS, userPromptText } from '../src/shared/user-prompt.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => {
  settings.autoInject = true;
  directory = await makeTempDir('cos-brain-prompt-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  configureBrainForTests(path.join(directory, 'brain.sqlite'));
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: directory }] });
  await brainSave({ content: 'The release train leaves every Thursday', title: 'release' });
});
afterEach(async () => {
  resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('puts Brain context in the opening COS_CONTEXT only when asked, never in a follow-up', async () => {
  const opening = await prepareSessionPrompt('When is the release train?', { brainContext: true });
  expect(userPromptText(opening)).toBe('When is the release train?');
  const context = opening.slice(0, opening.indexOf('[[/COS_CONTEXT]]'));
  expect(context).toContain('<memory-context>');
  expect(context).toContain('release: The release train leaves every Thursday');
  // Worker bootstraps and other callers that do not ask get none.
  expect(await prepareSessionPrompt('When is the release train?')).not.toContain('<memory-context>');
  expect(await prepareSkillFollowup('When is the release train?', 'When is the release train?')).not.toContain('<memory-context>');
  settings.autoInject = false;
  expect(await prepareSessionPrompt('When is the release train?', { brainContext: true })).not.toContain('<memory-context>');
});

it('drops the optional block instead of failing when the opening is at the 96k ceiling', async () => {
  const plain = await prepareSessionPrompt('release', {});
  const task = `release ${'x'.repeat(MAX_CHATGPT_MESSAGE_CHARS - plain.length - 'release '.length + 'release'.length)}`;
  const fitted = await prepareSessionPrompt(task, { brainContext: true });
  expect(fitted.length).toBeLessThanOrEqual(MAX_CHATGPT_MESSAGE_CHARS);
  expect(fitted).not.toContain('<memory-context>');
  expect(userPromptText(fitted)).toBe(task);
});
