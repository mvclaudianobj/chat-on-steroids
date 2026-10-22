import type { AppApi } from '../preload/index.js';
import type { VmAction, VmJob, VmView } from '../shared/vms.js';
import { t, onLanguageChange } from './i18n.js';

/** VM actions are delegated to a fixed IPC allowlist; no path, command or shell input is accepted. */
export function createVmsUi(api: AppApi, parent: Element): { refresh(): Promise<void> } {
  const section = document.createElement('section');
  section.className = 'appearance-section vms-module';
  section.dataset.module = 'vms';
  const title = document.createElement('h2');
  const description = document.createElement('p');
  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'btn';
  const head = document.createElement('header');
  head.className = 'settings-section-head';
  const heading = document.createElement('div');
  heading.append(title, description);
  head.append(heading, refreshButton);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const doctor = document.createElement('div');
  doctor.className = 'settings-surface vms-doctor';
  const form = document.createElement('form');
  form.className = 'settings-surface vms-create';
  const name = document.createElement('input');
  const box = document.createElement('input');
  const memory = document.createElement('input');
  const cpus = document.createElement('input');
  name.name = 'vm-name';
  name.pattern = '[a-z][a-z0-9-]*';
  name.maxLength = 40;
  name.required = true;
  box.value = 'bento/ubuntu-24.04';
  box.required = true;
  memory.type = 'number'; memory.min = '512'; memory.max = '32768'; memory.value = '2048'; memory.required = true;
  cpus.type = 'number'; cpus.min = '1'; cpus.max = '16'; cpus.value = '2'; cpus.required = true;
  const add = document.createElement('button');
  add.type = 'submit'; add.className = 'btn';
  const fields: Array<[HTMLElement, string]> = [[name, 'VM name'], [box, 'Vagrant box'], [memory, 'Memory (MiB)'], [cpus, 'CPUs']];
  const labelTexts: Text[] = [];
  for (const [field] of fields) {
    const label = document.createElement('label');
    const text = document.createTextNode('');
    label.append(text, field);
    form.append(label);
    labelTexts.push(text);
  }
  form.append(add);
  const simulateLabel = document.createElement('label');
  const simulate = document.createElement('input');
  simulate.type = 'checkbox';
  simulate.checked = false;
  simulateLabel.append(simulate);
  const list = document.createElement('div');
  list.className = 'vms-list';
  section.append(head, status, doctor, form, simulateLabel, list);
  parent.append(section);
  let view: VmView | null = null;
  let busy = false;
  let error = '';
  let doctorBusy = false;
  const rowText = (text: string): HTMLElement => {
    const p = document.createElement('p');
    p.textContent = text;
    return p;
  };
  function paint(): void {
    title.textContent = t('Virtual machines');
    description.textContent = t('Manage isolated Vagrant and Ansible VM profiles on this computer.');
    refreshButton.textContent = t('Refresh status');
    add.textContent = t('Create profile');
    simulateLabel.replaceChildren(simulate, document.createTextNode(' ' + t('Dry run (simulation only)')));
    fields.forEach(([, label], i) => { labelTexts[i]!.textContent = t(label) + ' '; });
    status.textContent = error || (busy ? t('Working…') : '');
    doctor.replaceChildren();
    doctor.append(rowText(t('Host prerequisites')));
    if (!view || doctorBusy) doctor.append(rowText(t('Checking status…')));
    else for (const check of view.doctor.checks) {
      const message = check.available ? t('Available') : t('Missing — install this tool on the host');
      doctor.append(rowText(`${check.id === 'virtualbox' ? 'VirtualBox' : check.id === 'ansible' ? 'Ansible' : 'Vagrant'}: ${message}`));
    }
    list.replaceChildren();
    if (!view) return;
    if (!view.labs.length) list.append(rowText(t('No VM profiles yet.')));
    for (const lab of view.labs) {
      const card = document.createElement('section');
      card.className = 'settings-surface vms-lab';
      const heading = document.createElement('h3');
      heading.textContent = lab.name;
      card.append(heading, rowText(lab.valid ? `${lab.box} · ${lab.memory} MiB · ${lab.cpus} CPUs` : t('Profile invalid — inspect locally')));
      const job = view.jobs.find(j => j.name === lab.name);
      if (lab.valid) {
        const buttons = document.createElement('div');
        buttons.className = 'modules-service-actions';
        for (const op of ['status', 'up', 'halt', 'provision', 'destroy'] as VmAction[]) {
          const button = document.createElement('button');
          button.className = 'btn'; button.type = 'button';
          button.textContent = t(op === 'status' ? 'Status' : op === 'up' ? 'Start VM' : op === 'halt' ? 'Stop VM' : op === 'provision' ? 'Provision' : 'Destroy VM');
          button.disabled = busy || !!job?.running || (!simulate.checked && op !== 'status' && op !== 'destroy' && !view.doctor.ready);
          button.addEventListener('click', () => void act(lab.name, op));
          buttons.append(button);
        }
        if (job?.running) {
          const cancel = document.createElement('button');
          cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = t('Cancel operation');
          cancel.addEventListener('click', () => void api.vmsCancel(lab.name).then(reply => { if (!reply.ok) { error = reply.error; paint(); } }));
          buttons.append(cancel);
        }
        card.append(buttons);
      }
      if (job) {
        card.append(rowText(job.running ? t('Running') : `${t('Exit code')}: ${job.exitCode ?? '-'}`));
        const log = document.createElement('pre');
        log.className = 'vms-log';
        log.textContent = job.log.join('\n');
        log.setAttribute('aria-label', t('VM logs'));
        card.append(log);
      }
      list.append(card);
    }
  }
  async function refresh(): Promise<void> {
    if (doctorBusy) return;
    doctorBusy = true; error = ''; paint();
    try {
      const reply = await api.vmsView();
      if (!reply.ok) throw new Error(reply.error);
      view = reply.data;
    } catch (cause) { error = (cause as Error).message; }
    finally { doctorBusy = false; paint(); }
  }
  async function act(vm: string, op: VmAction): Promise<void> {
    let confirmation: string | undefined;
    if (op === 'destroy') {
      confirmation = window.prompt(t('Type the exact VM name to destroy: {0}', [vm])) ?? undefined;
      if (confirmation !== vm) return;
    }
    busy = true; paint();
    try {
      const reply = await api.vmsRun(vm, op, confirmation, simulate.checked);
      if (!reply.ok) throw new Error(reply.error);
      if (view) view.jobs = [...view.jobs.filter(job => job.name !== vm), reply.data];
    } catch (cause) { error = (cause as Error).message; }
    finally { busy = false; paint(); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    void (async () => {
      busy = true; paint();
      try {
        const reply = await api.vmsInit(name.value, box.value, Number(memory.value), Number(cpus.value));
        if (!reply.ok) throw new Error(reply.error);
        view = reply.data;
        name.value = '';
      } catch (cause) { error = (cause as Error).message; }
      finally { busy = false; paint(); }
    })();
  });
  refreshButton.addEventListener('click', () => void refresh());
  simulate.addEventListener('change', paint);
  api.onVmsEvent((job: VmJob) => {
    if (!view) return;
    view.jobs = [...view.jobs.filter(item => item.name !== job.name), job];
    paint();
  });
  onLanguageChange(paint);
  paint();
  return { refresh };
}
