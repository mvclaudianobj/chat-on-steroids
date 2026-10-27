import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';
import {
  CLAUDE_DIRECT_SETTINGS, CLAUDE_FLAG_SETTINGS, CLAUDE_ROUTER_ENV_KEYS, claudeRouteSettings, codexRouteOverrides, detectClaudeRouter,
  detectCodexRouter, effectiveRoute, type RoutingEnvironment
} from '../src/main/agent-engine/router.js';

// Synthetic copies of what Claude Code Router writes into the user's files (no real key or home).
const CCR_CLAUDE_SETTINGS = JSON.stringify({
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456', ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:3456', ANTHROPIC_MODEL: 'Local/router-model', CCR_CLAUDE_CODE_MODEL: 'Local/router-model' },
  apiKeyHelper: '/bin/echo synthetic', theme: 'dark'
});
const CCR_CODEX_CONFIG = [
  '# BEGIN CCR managed profile',
  'model_provider = "claude-code-router"',
  'model = "router-model"',
  'model_catalog_json = "/somewhere/ccr-model-catalog.json"',
  '# END CCR managed profile',
  'model_reasoning_effort = "medium"',
  '',
  '[projects."/work"]',
  'trust_level = "trusted"',
  '',
  '# BEGIN CCR managed Codex provider',
  '[model_providers.claude-code-router]',
  'name = "Claude Code Router"',
  'base_url = "http://127.0.0.1:3456/v1"',
  'wire_api = "responses"',
  '# END CCR managed Codex provider',
  ''
].join('\n');

let home: string;
const environment = (env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'linux'): RoutingEnvironment => ({ home, env, platform });

beforeEach(async () => { home = await makeTempDir('cos-router-'); });
afterEach(async () => { await removeTempDir(home); });

describe('Claude Code Router detection: Claude Code', () => {
  it('detects CCR in settings.json env and reads nothing secret', async () => {
    await writeTree(home, { '.claude/settings.json': CCR_CLAUDE_SETTINGS });
    expect(detectClaudeRouter(environment())).toEqual({ detected: true, model: 'Local/router-model' });
  });

  it('detects CCR on another port only by its marks, and never a remote gateway or a plain local proxy', async () => {
    await writeTree(home, { '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' } }) });
    expect(detectClaudeRouter(environment()).detected).toBe(false);
    await writeTree(home, { '.claude/settings.json.ccr-original': '{}' });
    expect(detectClaudeRouter(environment()).detected).toBe(true);
    await writeTree(home, { '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }) });
    expect(detectClaudeRouter(environment()).detected).toBe(false);
    await writeTree(home, { '.claude/settings.json': JSON.stringify({ env: {} }) });
    expect(detectClaudeRouter(environment()).detected).toBe(false);
    await writeTree(home, { '.claude/settings.json': 'not json' });
    expect(detectClaudeRouter(environment()).detected).toBe(false);
  });

  it('detects an inherited CCR base URL, honours CLAUDE_CONFIG_DIR and reads nothing on Windows', async () => {
    expect(detectClaudeRouter(environment({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456' })).detected).toBe(true);
    // The settings' own (empty) value wins over the inherited one, as in Claude Code.
    await writeTree(home, { '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: '' } }) });
    expect(detectClaudeRouter(environment({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456' })).detected).toBe(false);
    await writeTree(home, { 'other/settings.json': CCR_CLAUDE_SETTINGS });
    expect(detectClaudeRouter(environment({ CLAUDE_CONFIG_DIR: path.join(home, 'other') })).detected).toBe(true);
    await writeTree(home, { '.claude/settings.json': CCR_CLAUDE_SETTINGS });
    expect(detectClaudeRouter(environment({}, 'win32')).detected).toBe(false);
  });

  it('gives the direct route a settings layer that unsets every router variable and the key helper', () => {
    const direct = JSON.parse(CLAUDE_DIRECT_SETTINGS) as { env: Record<string, string>; apiKeyHelper: string; permissions: unknown };
    expect(Object.keys(direct.env).sort()).toEqual([...CLAUDE_ROUTER_ENV_KEYS].sort());
    expect(Object.values(direct.env).every(value => value === '')).toBe(true);
    expect(direct).toMatchObject({ apiKeyHelper: '', permissions: { disableBypassPermissionsMode: 'disable' } });
    expect(claudeRouteSettings('direct', { detected: true })).toBe(CLAUDE_DIRECT_SETTINGS);
    expect(claudeRouteSettings('router', { detected: true })).toBe(CLAUDE_FLAG_SETTINGS);
    // Without a router nothing is overridden: a user's own gateway or key helper keeps working.
    expect(claudeRouteSettings('direct', { detected: false })).toBe(CLAUDE_FLAG_SETTINGS);
  });
});

describe('Claude Code Router detection: Codex', () => {
  it('detects CCR as the provider and uses the built-in provider and Codex\'s own catalog directly', async () => {
    await writeTree(home, { '.codex/config.toml': CCR_CODEX_CONFIG, '.codex/models_cache.json': '{"models":[]}' });
    const detection = detectCodexRouter(environment());
    expect(detection).toEqual({
      detected: true, provider: 'claude-code-router',
      directOverrides: ['model_provider="openai"', `model_catalog_json=${JSON.stringify(path.join(home, '.codex', 'models_cache.json'))}`]
    });
    expect(codexRouteOverrides('direct', detection)).toEqual(detection.directOverrides);
    expect(codexRouteOverrides('router', detection)).toEqual([]);
    // No cached catalog of its own: only the provider is switched.
    await fs.rm(path.join(home, '.codex', 'models_cache.json'));
    expect(detectCodexRouter(environment()).directOverrides).toEqual(['model_provider="openai"']);
  });

  it('leaves Codex alone with the built-in provider, another provider of the user, a broken file or none, and on Windows', async () => {
    expect(detectCodexRouter(environment()).detected).toBe(false);
    await writeTree(home, { '.codex/config.toml': 'model_provider = "openai"\n' });
    expect(detectCodexRouter(environment()).detected).toBe(false);
    await writeTree(home, { '.codex/config.toml': 'model_provider = "azure"\n[model_providers.azure]\nname = "Azure"\nbase_url = "https://example.openai.azure.com/openai"\n' });
    expect(detectCodexRouter(environment())).toEqual({ detected: false, provider: null, directOverrides: [] });
    await writeTree(home, { '.codex/config.toml': 'model_provider = = broken' });
    expect(detectCodexRouter(environment()).detected).toBe(false);
    await writeTree(home, { '.codex/config.toml': CCR_CODEX_CONFIG });
    expect(detectCodexRouter(environment({}, 'win32')).detected).toBe(false);
    expect(detectCodexRouter(environment({ CODEX_HOME: path.join(home, 'nowhere') })).detected).toBe(false);
  });

  it('runs one process for both routes without a router', () => {
    expect(effectiveRoute('router', { detected: false })).toBe('direct');
    expect(effectiveRoute('router', { detected: true })).toBe('router');
    expect(codexRouteOverrides('direct', { detected: false, provider: null, directOverrides: [] })).toEqual([]);
  });
});
