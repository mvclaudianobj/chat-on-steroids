import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ value: null as unknown, broken: false, failWrite: false }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: vi.fn(async () => {
    if (state.broken) throw new Error('corrupt fixture');
    return state.value;
  }),
  writeDurableNow: vi.fn(async (_key: string, value: unknown) => {
    if (state.failWrite) throw new Error('unavailable fixture');
    state.value = value;
  })
}));

beforeEach(() => { state.value = null; state.broken = false; state.failWrite = false; vi.resetModules(); });

it('defaults to denied, persists an app-wide grant after reinitialization, and revokes it', async () => {
  let consent = await import('../src/main/jarvis-microphone-consent.js');
  await consent.restoreJarvisMicrophoneConsent();
  expect(consent.jarvisMicrophoneConsented()).toBe(false);
  await consent.setJarvisMicrophoneConsent(true);
  expect(consent.jarvisMicrophoneConsented()).toBe(true);
  vi.resetModules();
  consent = await import('../src/main/jarvis-microphone-consent.js');
  await consent.restoreJarvisMicrophoneConsent();
  expect(consent.jarvisMicrophoneConsented()).toBe(true);
  const revoked = consent.setJarvisMicrophoneConsent(false);
  expect(consent.jarvisMicrophoneConsented()).toBe(false);
  await revoked;
  vi.resetModules();
  consent = await import('../src/main/jarvis-microphone-consent.js');
  await consent.restoreJarvisMicrophoneConsent();
  expect(consent.jarvisMicrophoneConsented()).toBe(false);
});

it('fails closed for invalid state and failed writes', async () => {
  state.broken = true;
  const consent = await import('../src/main/jarvis-microphone-consent.js');
  await consent.restoreJarvisMicrophoneConsent();
  expect(consent.jarvisMicrophoneConsented()).toBe(false);
  state.failWrite = true;
  await expect(consent.setJarvisMicrophoneConsent(true)).rejects.toThrow();
  expect(consent.jarvisMicrophoneConsented()).toBe(false);
});
