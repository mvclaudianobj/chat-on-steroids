type Reply = { ok: boolean; pending?: boolean; code?: string; retryAfterMs?: number; message: string };
type Client = { password(email: string, password: string): Promise<Reply>; start(): Promise<Reply>; poll(): Promise<Reply> };
export {};
declare global { interface Window { markspanelAuth: Client } }
const button = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement;
const notice = document.getElementById('notice') as HTMLElement;
const form = document.getElementById('passwordForm') as HTMLFormElement;
const device = document.getElementById('devicePanel') as HTMLElement;
const code = document.getElementById('deviceCode') as HTMLElement;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function show(message: string): void { notice.textContent = message; }
function retryDelay(result: Reply): number {
  return typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs)
    ? Math.max(1000, Math.min(35_000, result.retryAfterMs)) : 5000;
}
function switchTo(method: 'password' | 'device'): void {
  attempt += 1;
  if (timer) clearTimeout(timer);
  form.hidden = method !== 'password';
  device.hidden = method !== 'device';
  if (method === 'device') (document.getElementById('password') as HTMLInputElement).value = '';
  code.textContent = '—';
  button('passwordTab').classList.toggle('selected', method === 'password');
  button('deviceTab').classList.toggle('selected', method === 'device');
  show('');
}
button('passwordTab').addEventListener('click', () => switchTo('password'));
button('deviceTab').addEventListener('click', () => switchTo('device'));
form.addEventListener('submit', event => {
  event.preventDefault();
  const generation = ++attempt;
  if (timer) clearTimeout(timer);
  button('submit').disabled = true;
  show('Verificando sua conta…');
  const passwordInput = document.getElementById('password') as HTMLInputElement;
  const password = passwordInput.value;
  passwordInput.value = '';
  void window.markspanelAuth.password((document.getElementById('email') as HTMLInputElement).value, password)
    .then(result => { if (generation === attempt) show(result.message); })
    .catch(() => { if (generation === attempt) show('Não foi possível conectar ao MarksPanel'); })
    .finally(() => { button('submit').disabled = false; });
});
button('start').addEventListener('click', () => {
  const generation = ++attempt;
  if (timer) clearTimeout(timer);
  button('start').disabled = true;
  show('Preparando autorização…');
  void window.markspanelAuth.start().then(result => {
    if (generation !== attempt) return;
    show(result.message);
    if (!result.ok) return;
    code.textContent = result.code ?? '—';
    const poll = (): void => {
      if (generation !== attempt) return;
      void window.markspanelAuth.poll().then(answer => {
        if (generation !== attempt) return;
        show(answer.message);
        if (answer.ok && answer.pending) timer = setTimeout(poll, retryDelay(answer));
      }).catch(() => { if (generation === attempt) timer = setTimeout(poll, 5000); });
    };
    timer = setTimeout(poll, retryDelay(result));
  }).catch(() => show('Não foi possível iniciar a autorização')).finally(() => { button('start').disabled = false; });
});
