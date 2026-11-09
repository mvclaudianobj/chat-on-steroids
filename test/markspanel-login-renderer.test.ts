import { promises as fs } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Reply = { ok: boolean; message: string; pending?: boolean; code?: string; retryAfterMs?: number };
type AuthBridge = {
  password: ReturnType<typeof vi.fn<(email: string, password: string) => Promise<Reply>>>;
  start: ReturnType<typeof vi.fn<() => Promise<Reply>>>;
  poll: ReturnType<typeof vi.fn<() => Promise<Reply>>>;
};

let dom: JSDOM | null = null;

async function loginUi(bridge: AuthBridge): Promise<Document> {
  const html = await fs.readFile(new URL('../src/renderer/markspanel-login.html', import.meta.url), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.example/' });
  Object.defineProperty(dom.window, 'markspanelAuth', { configurable: true, value: bridge });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  await import('../src/renderer/markspanel-login.js');
  return dom.window.document;
}

function bridge(): AuthBridge {
  return {
    password: vi.fn<(email: string, password: string) => Promise<Reply>>(),
    start: vi.fn<() => Promise<Reply>>(),
    poll: vi.fn<() => Promise<Reply>>()
  };
}

afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('MarksPanel login renderer', () => {
  it('uses the Marks artwork and the app scrollbar styling', async () => {
    const html = await fs.readFile(new URL('../src/renderer/markspanel-login.html', import.meta.url), 'utf8');
    const css = await fs.readFile(new URL('../src/renderer/markspanel-login.css', import.meta.url), 'utf8');
    expect(html).toContain('<img class="symbol" src="./browser-icons/cos.png" alt="Marks" />');
    expect(html).not.toContain('<div class="symbol">M</div>');
    expect(css).toContain('body::-webkit-scrollbar { width: 10px; height: 10px; }');
    expect(css).toContain('body::-webkit-scrollbar-thumb:hover');
    expect(css).toContain('background: #181818');
  });

  it('scrubs the password after submit and ignores a late reply after switching login methods', async () => {
    const auth = bridge();
    let respond!: (reply: Reply) => void;
    auth.password.mockImplementation(() => new Promise<Reply>(resolve => { respond = resolve; }));
    const page = await loginUi(auth);
    (page.getElementById('email') as HTMLInputElement).value = 'owner@example.com';
    (page.getElementById('password') as HTMLInputElement).value = 'secret-password';
    (page.getElementById('passwordForm') as HTMLFormElement)
      .dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(auth.password).toHaveBeenCalledWith('owner@example.com', 'secret-password');
    expect((page.getElementById('password') as HTMLInputElement).value).toBe('');
    (page.getElementById('deviceTab') as HTMLButtonElement).click();
    respond({ ok: false, message: 'Credenciais incorretas' });
    await Promise.resolve();
    await Promise.resolve();
    expect(page.getElementById('notice')?.textContent).toBe('');
  });

  it('honors server device polling intervals without calling the server prematurely', async () => {
    const auth = bridge();
    auth.start.mockResolvedValue({ ok: true, code: 'ABCD-42', message: 'Autorize no navegador', retryAfterMs: 11_000 });
    auth.poll.mockResolvedValue({ ok: true, pending: true, message: 'Aguardando autorização', retryAfterMs: 30_000 });
    const page = await loginUi(auth);
    vi.useFakeTimers();
    (page.getElementById('deviceTab') as HTMLButtonElement).click();
    (page.getElementById('start') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.getElementById('deviceCode')?.textContent).toBe('ABCD-42');
    await vi.advanceTimersByTimeAsync(10_999);
    expect(auth.poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(auth.poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(auth.poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(auth.poll).toHaveBeenCalledTimes(2);
  });

  it('inserts server messages as text and does not execute HTML', async () => {
    const auth = bridge();
    auth.password.mockResolvedValue({ ok: false, message: '<img src=x onerror=alert(1)>' });
    const page = await loginUi(auth);
    (page.getElementById('email') as HTMLInputElement).value = 'owner@example.com';
    (page.getElementById('password') as HTMLInputElement).value = 'secret-password';
    (page.getElementById('passwordForm') as HTMLFormElement)
      .dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(page.getElementById('notice')?.textContent).toContain('<img'));
    expect(page.getElementById('notice')?.querySelector('img')).toBeNull();
  });
});
