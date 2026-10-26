/** Restore an already-registered WA session once for each new green Core transition. */
export function watchWhatsAppResumeOnGreen(
  current: () => { state: string },
  subscribe: (listener: (status: { state: string }) => void) => () => void,
  resume: () => Promise<void>,
  alive: () => boolean
): () => void {
  let previous = current().state === 'connected';
  return subscribe(status => {
    const connected = status.state === 'connected';
    if (connected && !previous && alive()) void resume().catch(() => undefined);
    previous = connected;
  });
}
