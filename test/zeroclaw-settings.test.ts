import { afterEach, expect, it } from 'vitest';
import { AGENT_PATHS, GLOBAL_PATHS, parseAgentList, parseConfigValue, setZeroClawHostForTests, zeroclawFacts } from '../src/main/zeroclaw/settings.js';

afterEach(() => setZeroClawHostForTests(null));

it('parses the real 0.8.6 `agents list` and `config get --json` outputs', () => {
  expect(parseAgentList('(no entries under agents)\n')).toEqual([]);
  expect(parseAgentList('helper\nresearch_bot\n')).toEqual(['helper', 'research_bot']);
  // Anything that is not an alias (a banner, a path, an option-like word) is not one.
  expect(parseAgentList('Error: daemon unavailable\n-rf\n../x\nok_1\n')).toEqual(['ok_1']);
  expect(parseConfigValue('{\n  "path": "memory.backend",\n  "value": "sqlite"\n}')).toBe('sqlite');
  expect(parseConfigValue('{ "path": "gateway.port", "value": "42617" }')).toBe('42617');
  expect(parseConfigValue('{ "code": "path_not_found", "message": "Unknown property", "path": "agents" }')).toBeNull();
  expect(parseConfigValue('not json')).toBeNull();
});

it('runs nothing until ZeroClaw has a configuration (its commands would write a default one), then reads only the fixed non-secret paths', async () => {
  const calls: string[][] = [];
  const values: Record<string, string> = {
    [AGENT_PATHS('helper').provider]: 'anthropic.default', [AGENT_PATHS('helper').memory]: 'sqlite', [AGENT_PATHS('helper').enabled]: 'true',
    [GLOBAL_PATHS.runtime]: 'native', [GLOBAL_PATHS.gatewayHost]: '127.0.0.1', [GLOBAL_PATHS.gatewayPort]: '42617',
    [GLOBAL_PATHS.daily]: '10.0', [GLOBAL_PATHS.monthly]: '100.0'
  };
  let configured = false;
  setZeroClawHostForTests({
    binary: async () => ({ binary: '/m/zeroclaw/bin/zeroclaw', windows: false }),
    configured: async () => configured,
    run: async (_binary, args) => {
      calls.push(args);
      if (args[0] === 'agents') return 'helper\n';
      const key = args.at(-1)!;
      return key in values ? JSON.stringify({ path: key, value: values[key] }) : JSON.stringify({ code: 'path_not_found', path: key });
    }
  });
  expect(await zeroclawFacts()).toEqual({ configured: false, agents: [], runtime: null, gateway: null, dailyLimitUsd: null, monthlyLimitUsd: null });
  expect(calls).toEqual([]);
  configured = true;
  expect(await zeroclawFacts()).toEqual({
    configured: true, agents: [{ alias: 'helper', provider: 'anthropic.default', memory: 'sqlite', enabled: true }],
    runtime: 'native', gateway: '127.0.0.1:42617', dailyLimitUsd: 10, monthlyLimitUsd: 100
  });
  // Only `agents list` and `config get --json` of the fixed paths: never `config list`, `--secrets`, `set` or `status`.
  expect(calls.every(args => (args[0] === 'agents' && args[1] === 'list') || (args[0] === 'config' && args[1] === 'get' && args[2] === '--json'))).toBe(true);
  expect(calls.map(args => args.at(-1)).filter(key => /secret|token|key|password/i.test(key!))).toEqual([]);
  setZeroClawHostForTests({ binary: async () => null });
  expect(await zeroclawFacts()).toMatchObject({ configured: false, error: 'not_installed' });
});
