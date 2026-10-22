/** Native chat surface for external CLI backends; no ChatGPT message attribution. */
import type { AppApi } from '../preload/index.js';
import type { CliChatBackend } from '../main/cli-chat-protocol.js';
import type { CliChatThread } from '../main/cli-chat.js';

export function initCliChatUi(api: AppApi, hooks: { workspace(): string | null }) {
  const header = document.querySelector<HTMLElement>('.chat-head')!;
  const panel = document.querySelector<HTMLElement>('.card.is-session')!;
  const body = document.getElementById('chatBody')!;
  const composer = document.getElementById('composer')!;
  const select = document.createElement('select');
  select.id = 'cliChatBackend'; select.className = 'cli-chat-backend'; select.setAttribute('aria-label', 'Chat backend');
  select.title = 'Choose a conversation backend';
  // MarksCode is retired: its headless backend is no longer offered (it would run the fork).
  for (const [id, label] of [['chatgpt', 'ChatGPT'], ['codex', 'Codex'], ['claude', 'Claude']] as const) {
    const option = document.createElement('option'); option.value = id; option.textContent = label; select.append(option);
  }
  header.prepend(select);
  const view = document.createElement('div'); view.id = 'cliChatView'; view.className = 'cli-chat-history'; view.setAttribute('role', 'log');
  view.setAttribute('aria-label', 'Local CLI conversation'); body.append(view);
  const form = document.createElement('form'); form.id = 'cliChatComposer'; form.className = 'cli-chat-composer';
  const input = document.createElement('textarea'); input.rows = 2; input.maxLength = 32000; input.id = 'cliChatInput';
  input.placeholder = 'Message the selected coding CLI…'; input.setAttribute('aria-label', 'CLI message');
  const send = document.createElement('button'); send.type = 'submit'; send.className = 'btn'; send.textContent = 'Send';
  const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'btn'; stop.textContent = 'Stop'; stop.disabled = true;
  const status = document.createElement('p'); status.className = 'cli-chat-status'; status.setAttribute('role', 'status');
  const controls = document.createElement('div'); controls.className = 'cli-chat-actions'; controls.append(stop, send);
  form.append(input, controls, status);
  composer.parentElement!.append(form);
  const drafts = new Map<string, string>();
  let selected: CliChatBackend | null = null;
  let project: string | null = null;
  let showing: CliChatThread | null = null;
  let generation = 0;
  let submitting = false;
  const scope = (): string => `${selected}:${project ?? 'home'}`;
  const render = (): void => {
    view.replaceChildren();
    const thread = showing;
    if (!thread) return;
    for (const message of thread.messages) {
      const bubble = document.createElement('article'); bubble.className = `cli-chat-message cli-chat-${message.role}`;
      const author = document.createElement('b'); author.textContent = message.role === 'user' ? 'You' : select.selectedOptions[0]?.textContent ?? 'CLI';
      const content = document.createElement('pre'); content.textContent = message.text || (message.state === 'running' ? 'Working…' : '');
      bubble.append(author, content);
      if (message.state !== 'completed') {
        const state = document.createElement('small'); state.textContent = message.state; bubble.append(state);
      }
      view.append(bubble);
    }
    const busy = thread.messages.some(message => message.role === 'assistant' && message.state === 'running');
    send.disabled = busy || submitting;
    stop.disabled = !busy;
    view.scrollTop = view.scrollHeight;
    body.scrollTop = body.scrollHeight;
  };

  async function open(): Promise<void> {
    if (!selected) return;
    const token = ++generation;
    project = hooks.workspace();
    const backend = selected;
    const reply = await api.cliChatOpen(backend, project);
    if (token !== generation || selected !== backend || project !== hooks.workspace()) return;
    if (!reply.ok) { status.textContent = reply.error; showing = null; render(); return; }
    status.textContent = project ? 'Using the selected workspace' : 'Using the home workspace';
    showing = reply.data; render();
  }
  select.addEventListener('change', () => {
    if (selected) drafts.set(scope(), input.value);
    generation++;
    selected = select.value === 'chatgpt' ? null : select.value as CliChatBackend;
    project = hooks.workspace();
    panel.classList.toggle('cli-chat-active', !!selected);
    if (!selected) { showing = null; return; }
    input.value = drafts.get(scope()) ?? '';
    status.textContent = 'Loading CLI conversation…';
    void open();
  });
  async function sendMessage(): Promise<void> {
    if (!selected || submitting) return;
    const backend = selected;
    if (project !== hooks.workspace()) await open();
    const prompt = input.value.trim();
    if (!prompt || !selected) return;
    submitting = true; send.disabled = true;
    const projectId = hooks.workspace();
    const token = generation;
    const reply = await api.cliChatSend(backend, projectId, prompt);
    submitting = false;
    if (token !== generation || backend !== selected || projectId !== hooks.workspace()) return;
    if (!reply.ok) { status.textContent = reply.error; send.disabled = false; return; }
    input.value = ''; drafts.set(scope(), '');
    status.textContent = reply.data.messages.at(-1)?.state === 'failed'
      ? 'CLI could not start this message' : 'CLI accepted the message';
    showing = reply.data; render();
  }
  form.addEventListener('submit', event => { event.preventDefault(); void sendMessage(); });
  input.addEventListener('input', () => { if (selected) drafts.set(scope(), input.value); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && (!event.altKey)) {
      event.preventDefault(); void sendMessage();
    }
  });
  input.addEventListener('focus', () => { if (selected && project !== hooks.workspace()) void open(); });
  // Session selection is owned by the original ChatGPT renderer; observe the
  // existing header projection so the local CLI never retains another chat's
  // workspace when the selected conversation changes.
  if (typeof MutationObserver !== 'undefined') {
    const contextObserver = new MutationObserver(() => {
      if (selected && project !== hooks.workspace()) void open();
    });
    contextObserver.observe(document.getElementById('chatTitle') ?? header, { subtree: true, childList: true, characterData: true });
  }
  stop.addEventListener('click', async () => {
    if (!selected) return;
    const reply = await api.cliChatCancel(selected, hooks.workspace());
    status.textContent = reply.ok ? 'Cancellation requested' : reply.error;
  });
  api.onCliChatEvent(thread => {
    if (!selected || thread.backend !== selected || thread.key !== showing?.key) return;
    showing = thread; render();
  });
  return { selected: () => selected, open };
}
