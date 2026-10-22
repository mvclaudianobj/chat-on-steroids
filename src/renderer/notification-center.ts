import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS } from '../shared/notification-center.js';
import type { NotificationChannel, NotificationCenterSettings, NotificationCenterView, NotificationEvent } from '../shared/notification-center.js';
import type { AppApi } from '../preload/index.js';
import { el } from './dom.js';
import { t, ui } from './i18n.js';

type FieldSpec = { key: string; label: string; placeholder?: string; type?: string };
const CHANNELS: Record<NotificationChannel, { name: string; description: string; destination: string; secret: string; fields: FieldSpec[] }> = {
  smtp: {
    name: 'Email (SMTP)', description: 'Send messages to email addresses.', destination: 'Recipient email addresses',
    secret: 'SMTP password', fields: [
      { key: 'host', label: 'SMTP host', placeholder: 'smtp.example.com' },
      { key: 'port', label: 'SMTP port', placeholder: '587', type: 'number' },
      { key: 'username', label: 'SMTP username' },
      { key: 'security', label: 'Connection security', type: 'security' },
      { key: 'from', label: 'Sender email address', placeholder: 'notifications@example.com' }
    ]
  },
  telegram: {
    name: 'Telegram', description: 'Send bot messages to chats, groups or channels.', destination: 'Chat IDs',
    secret: 'Bot token', fields: [{ key: 'apiBase', label: 'Telegram API base (optional)', placeholder: 'https://api.telegram.org' }]
  },
  'whatsapp-cloud': {
    name: 'WhatsApp Cloud (Meta)', description: 'Send WhatsApp messages through the Meta Cloud API.', destination: 'Phone numbers',
    secret: 'Meta access token', fields: [
      { key: 'apiBase', label: 'Graph API URL', placeholder: 'https://graph.facebook.com/v23.0' },
      { key: 'phoneId', label: 'Phone number ID' },
      { key: 'template', label: 'Approved message template' },
      { key: 'language', label: 'Template language', placeholder: 'en_US' },
      { key: 'parameters', label: 'Template body fields (comma separated)', placeholder: 'title,body' }
    ]
  },
  'whatsapp-evolution': {
    name: 'WhatsApp Evolution', description: 'Send messages through an Evolution API instance.', destination: 'Phone numbers',
    secret: 'Evolution API key', fields: [
      { key: 'baseUrl', label: 'Evolution API URL', placeholder: 'https://evolution.example.com' },
      { key: 'instance', label: 'Evolution instance' }
    ]
  }
};
const EVENT_LABELS: Record<NotificationEvent, string> = {
  'turn-completed': 'Chat completed', 'turn-failed': 'Chat failed',
  'approval-pending': 'Approval pending', 'module-update': 'Module update', 'app-release': 'App release'
};

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
type Service = Pick<AppApi, 'notificationCenterGet' | 'notificationCenterSave' | 'notificationCenterSetCredential' | 'notificationCenterTest'>;

function settingLabel(title: string, detail: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'setting';
  const copy = el('span', 'setting-text');
  copy.append(el('b', '', () => t(title)), el('em', '', () => t(detail)));
  label.append(copy, control);
  return label;
}
function field(label: string, control: HTMLElement): HTMLElement {
  const box = el('div', 'field notification-center-field');
  const caption = el('label', '', () => t(label)) as HTMLLabelElement;
  caption.htmlFor = control.id;
  box.append(caption, control);
  return box;
}
function input(id: string, type = 'text', placeholder?: string): HTMLInputElement {
  const node = document.createElement('input');
  node.id = id;
  node.type = type;
  node.autocomplete = 'off';
  if (placeholder) ui(node, 'placeholder', () => t(placeholder));
  return node;
}
function textarea(id: string, rows = 2): HTMLTextAreaElement {
  const node = document.createElement('textarea');
  node.id = id;
  node.rows = rows;
  node.spellcheck = false;
  return node;
}
function number(id: string, minimum: number, maximum: number): HTMLInputElement {
  const node = input(id, 'number');
  node.min = String(minimum);
  node.max = String(maximum);
  node.step = '1';
  return node;
}
function button(label: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'btn';
  ui(node, 'textContent', () => t(label));
  return node;
}
function destinations(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map(item => item.trim()).filter(Boolean))];
}
function clone(settings: NotificationCenterSettings): NotificationCenterSettings {
  return {
    ...settings,
    channels: Object.fromEntries(NOTIFICATION_CHANNELS.map(channel => {
      const item = settings.channels[channel];
      return [channel, { ...item, events: { ...item.events }, destinations: [...item.destinations], config: { ...item.config } }];
    })) as NotificationCenterSettings['channels']
  };
}

export function installNotificationCenter(api: Service): void {
  const container = document.getElementById('notificationCenterSettings');
  const status = document.getElementById('notificationCenterStatus');
  if (!container || !status) return;
  let draft: NotificationCenterSettings | null = null;
  let credentials: NotificationCenterView['credentials'] | null = null;
  let busy = false;
  const controls: Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement> = [];
  const channelStatus = new Map<NotificationChannel, HTMLElement>();
  const credentialStatus = new Map<NotificationChannel, HTMLElement>();
  const secrets = new Map<NotificationChannel, HTMLInputElement>();
  const tests = new Map<NotificationChannel, HTMLButtonElement>();

  function state(message: string, error = false): void {
    ui(status!, 'textContent', () => t(message));
    status!.classList.toggle('is-error', error);
  }
  function setBusy(value: boolean): void {
    busy = value;
    for (const control of controls) control.disabled = value;
    for (const control of tests.values()) control.disabled = value;
  }
  async function request<T>(
    perform: () => Promise<Reply<T>>, onSuccess: (data: T) => void, errorTarget: HTMLElement = status!,
    errorText: (error: string) => string = error => t('Could not save notification settings: {0}', [error])
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      const reply = await perform();
      if (!reply.ok) {
        errorTarget.textContent = errorText(reply.error);
        errorTarget.classList.add('is-error');
        return false;
      }
      onSuccess(reply.data);
      errorTarget.classList.remove('is-error');
      return true;
    } catch {
      errorTarget.textContent = t('Notification service unavailable.');
      errorTarget.classList.add('is-error');
      return false;
    } finally { setBusy(false); }
  }
  function credentialState(channel: NotificationChannel): void {
    credentialStatus.get(channel)!.textContent = t(credentials?.[channel] ? 'Credential stored securely. Enter a new value to replace it.' : 'No credential stored.');
  }
  function build(): void {
    if (!draft) return;
    controls.length = 0;
    channelStatus.clear();
    credentialStatus.clear();
    secrets.clear();
    tests.clear();
    container!.replaceChildren();
    const timing = el('div', 'notification-center-timing');
    const throttle = number('notificationThrottleMinutes', 0, 1440);
    throttle.value = String(draft.throttleMinutes);
    throttle.addEventListener('input', () => { if (draft && throttle.validity.valid) draft.throttleMinutes = Number(throttle.value); });
    const batch = number('notificationBatchSeconds', 0, 300);
    batch.value = String(draft.batchWindowSeconds);
    batch.addEventListener('input', () => { if (draft && batch.validity.valid) draft.batchWindowSeconds = Number(batch.value); });
    controls.push(throttle, batch);
    timing.append(field('Minimum minutes between notifications', throttle), field('Batch window (seconds)', batch));
    container!.append(timing);

    for (const channel of NOTIFICATION_CHANNELS) {
      const spec = CHANNELS[channel];
      const entry = draft.channels[channel];
      const section = el('section', 'notification-channel');
      const head = el('div', 'notification-channel-head');
      const summary = el('div');
      const title = el('h3', '', () => t(spec.name));
      title.id = 'notificationTitle-' + channel;
      section.setAttribute('aria-labelledby', title.id);
      summary.append(title, el('p', '', () => t(spec.description)));
      const enabled = input('notificationEnabled-' + channel, 'checkbox');
      enabled.checked = entry.enabled;
      enabled.setAttribute('aria-label', t('Enable {0}', [t(spec.name)]));
      enabled.addEventListener('change', () => { entry.enabled = enabled.checked; });
      controls.push(enabled);
      head.append(summary, settingLabel('Enabled', 'Allow this channel to send notifications.', enabled));
      section.append(head);

      const fields = el('div', 'notification-channel-fields');
      for (const item of spec.fields) {
        let control: HTMLInputElement | HTMLSelectElement;
        if (item.type === 'security') {
          const security = document.createElement('select');
          security.id = 'notification-' + channel + '-' + item.key;
          for (const [value, label] of [['starttls', 'STARTTLS'], ['tls', 'TLS']] as const) {
            const option = document.createElement('option');
            option.value = value; option.textContent = t(label); security.append(option);
          }
          control = security;
        } else {
          control = input('notification-' + channel + '-' + item.key, item.type ?? 'text', item.placeholder);
          if (item.type === 'number') { control.min = '1'; control.max = '65535'; }
        }
        control.value = entry.config[item.key] ?? '';
        control.addEventListener('input', () => { entry.config[item.key] = control.value.trim(); });
        controls.push(control);
        fields.append(field(item.label, control));
      }
      const targets = textarea('notificationDestinations-' + channel);
      targets.value = entry.destinations.join('\n');
      targets.placeholder = t('One per line or separated by commas');
      targets.addEventListener('input', () => { entry.destinations = destinations(targets.value); });
      controls.push(targets);
      fields.append(field(spec.destination, targets));
      const heading = input('notificationHeading-' + channel);
      heading.value = entry.titleTemplate;
      heading.addEventListener('input', () => { entry.titleTemplate = heading.value; });
      const body = textarea('notificationBody-' + channel, 3);
      body.value = entry.bodyTemplate;
      body.addEventListener('input', () => { entry.bodyTemplate = body.value; });
      controls.push(heading, body);
      fields.append(field('Title template', heading), field('Message template', body));
      section.append(fields);

      const eventGroup = document.createElement('fieldset');
      eventGroup.className = 'notification-channel-events';
      eventGroup.append(el('legend', '', () => t('Events to notify')));
      for (const event of NOTIFICATION_EVENTS) {
        const checkbox = input('notification-' + channel + '-' + event, 'checkbox');
        checkbox.checked = entry.events[event];
        checkbox.addEventListener('change', () => { entry.events[event] = checkbox.checked; });
        controls.push(checkbox);
        eventGroup.append(settingLabel(EVENT_LABELS[event], '', checkbox));
      }
      const excerpt = input('notificationExcerpt-' + channel, 'checkbox');
      excerpt.checked = entry.includeExcerpt;
      excerpt.addEventListener('change', () => { entry.includeExcerpt = excerpt.checked; });
      controls.push(excerpt);
      section.append(eventGroup, settingLabel('Include message excerpt', 'Include a short excerpt of the chat response when available.', excerpt));

      const secretRow = el('div', 'notification-secret-row');
      const secret = input('notificationCredential-' + channel, 'password');
      secret.placeholder = t('Enter a new credential');
      secrets.set(channel, secret);
      controls.push(secret);
      const store = button('Save credential');
      controls.push(store);
      secretRow.append(secret, store);
      fields.append(field(spec.secret, secretRow));
      const credentialNote = el('p', 'notification-channel-note');
      credentialNote.setAttribute('role', 'status');
      credentialStatus.set(channel, credentialNote);
      section.append(credentialNote);
      credentialState(channel);
      store.addEventListener('click', async () => {
        if (!secret.value || busy) return;
        const value = secret.value;
        secret.value = '';
        await request(() => api.notificationCenterSetCredential(channel, value), view => {
          credentials = view.credentials;
          credentialState(channel);
          credentialNote.textContent = t('Credential saved.');
        }, credentialNote);
      });
      const actions = el('div', 'notification-channel-actions');
      const test = button('Send test');
      tests.set(channel, test);
      const result = el('p', 'notification-channel-note');
      result.setAttribute('role', 'status');
      channelStatus.set(channel, result);
      test.addEventListener('click', async () => {
        if (!draft || busy) return;
        if (controls.some(control => 'validity' in control && !control.validity.valid)) {
          result.textContent = t('Check the notification fields before sending a test.');
          result.classList.add('is-error');
          return;
        }
        const payload = clone(draft);
        let sending = false;
        result.textContent = t('Saving notification settings…');
        await request(async () => {
          const saved = await api.notificationCenterSave(payload);
          if (!saved.ok) return saved;
          credentials = saved.data.credentials;
          for (const name of NOTIFICATION_CHANNELS) credentialState(name);
          sending = true;
          result.textContent = t('Sending test notification…');
          return api.notificationCenterTest(channel);
        }, outcome => {
          result.textContent = t('Test delivered to {0} destination(s).', [outcome.delivered]);
        }, result, error => sending
          ? t('Could not send test notification: {0}', [error])
          : t('Could not save notification settings: {0}', [error]));
      });
      actions.append(test, result);
      section.append(actions);
      container!.append(section);
    }
    const footer = el('div', 'notification-center-footer');
    const save = button('Save notification settings');
    controls.push(save);
    save.addEventListener('click', async () => {
      if (!draft || busy) return;
      if (controls.some(control => 'validity' in control && !control.validity.valid)) {
        state('Check the notification fields before saving.', true); return;
      }
      const payload = clone(draft);
      state('Saving notification settings…');
      await request(() => api.notificationCenterSave(payload), view => {
        credentials = view.credentials;
        // The local draft remains authoritative if a user changed values in flight.
        state('Notification settings saved.');
        for (const channel of NOTIFICATION_CHANNELS) credentialState(channel);
      });
    });
    footer.append(save);
    container!.append(footer);
  }
  void api.notificationCenterGet().then(reply => {
    if (!reply.ok) { state(t('Could not load notification settings: {0}', [reply.error]), true); return; }
    draft = clone(reply.data.settings);
    credentials = reply.data.credentials;
    state('');
    build();
  }).catch(() => state('Notification service unavailable.', true));
}
