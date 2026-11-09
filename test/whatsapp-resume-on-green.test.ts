import { expect, it, vi } from 'vitest';
import { watchWhatsAppResumeOnGreen } from '../src/main/whatsapp-resume-on-green.js';

it('retries registered WA session on each new green Core transition, never on repeated green status updates', async () => {
  const resume = vi.fn(async () => undefined);
  let callback = (_status: { state: string }) => {};
  const stop = watchWhatsAppResumeOnGreen(() => ({ state: 'disconnected' }), listener => { callback = listener; return () => {}; }, resume, () => true);
  callback({ state: 'starting-server' }); callback({ state: 'connected' }); callback({ state: 'connected' });
  expect(resume).toHaveBeenCalledTimes(1);
  callback({ state: 'disconnected' }); callback({ state: 'connected' });
  expect(resume).toHaveBeenCalledTimes(2);
  stop();
});
it('does not schedule reconnection after app shutdown or when already green on subscribe', () => {
  const resume = vi.fn(async () => undefined);
  let callback = (_status: { state: string }) => {};
  let alive = true;
  watchWhatsAppResumeOnGreen(() => ({ state: 'connected' }), listener => { callback = listener; return () => {}; }, resume, () => alive);
  callback({ state: 'connected' });
  alive = false;
  callback({ state: 'disconnected' }); callback({ state: 'connected' });
  expect(resume).not.toHaveBeenCalled();
});
