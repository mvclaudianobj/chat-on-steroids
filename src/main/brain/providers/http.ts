/** Chat Marks H1b: bounded, redirect-free HTTP for optional Brain providers. Main process only. */
import type { BrainProviderStatus } from '../../../shared/brain.js';
import { useVault, vaultStatus } from '../../marks-vault.js';

export type ProviderState = BrainProviderStatus['state'];
export class ProviderError extends Error {
  constructor(readonly state: ProviderState, message: string) { super(message); }
}
/** A query or memory leaving the machine: one hit as returned by a remote provider. */
export interface RemoteHit { remoteId?: string; content: string; title?: string; score?: number }

const MAX_BYTES = 1_048_576;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** HTTPS anywhere, plain HTTP only on loopback or after an explicit per-provider acknowledgement. */
export function checkTransport(raw: string, insecureAcknowledged = false): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProviderError('error', 'Invalid provider URL'); }
  if (url.username || url.password) throw new ProviderError('error', 'Provider URL must not contain credentials');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && (LOOPBACK.has(url.hostname) || insecureAcknowledged)) return url;
  throw new ProviderError('insecure', 'Plain HTTP is refused until insecure HTTP is acknowledged for this provider');
}

export async function boundedRequest(url: string | URL, init: RequestInit, timeoutMs: number): Promise<{ status: number; text: string; headers: Headers }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError('error', `Timed out after ${Math.round(timeoutMs / 1000)} s`);
    throw new ProviderError('stopped', 'Server is not reachable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) { await response.body?.cancel().catch(() => undefined); throw new ProviderError('error', 'Response too large'); }
  let text = '';
  try { text = await response.text(); } catch { throw new ProviderError('error', 'Response could not be read'); }
  if (Buffer.byteLength(text) > MAX_BYTES) throw new ProviderError('error', 'Response too large');
  if (response.status === 401 || response.status === 403) throw new ProviderError('unauthorized', `HTTP ${response.status}: credential rejected`);
  return { status: response.status, text, headers: response.headers };
}

export function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new ProviderError('error', 'Response was not JSON'); }
}

/**
 * The vault entry's value, only when it is bound to exactly this provider origin. A missing vault,
 * entry or key means "no key" and the provider sends nothing that needs one.
 */
export async function vaultCredential(name: string, origin: string): Promise<string | null> {
  if (!name) return null;
  try { if (!(await vaultStatus()).ready) return null; } catch { return null; }
  let value: string | null = null;
  let mismatch = false;
  try {
    await useVault(name, async entry => {
      if (entry.origin !== origin) { mismatch = true; return ''; }
      value = entry.value;
      return '';
    });
  } catch { return null; }
  if (mismatch) throw new ProviderError('needs-key', `Vault entry ${name} is bound to another origin`);
  return value;
}

/** Plain values that look like credentials never appear in provider errors or logs. */
export function errorText(error: unknown): { state: ProviderState; detail: string } {
  if (error instanceof ProviderError) return { state: error.state, detail: error.message };
  return { state: 'error', detail: 'Provider request failed' };
}
