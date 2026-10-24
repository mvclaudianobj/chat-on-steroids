import type { AppApi } from '../preload/index.js';
import type { CompanyLocalGrantsView } from '../main/company-local-grants.js';
import { t } from './i18n.js';

/** Manage local grants; authorization is offered only when main attests the exact principal. */
export function mountCompanyLocalGrants(host: HTMLElement, api: Pick<AppApi, 'companyLocalGrants' | 'revokeCompanyLocalGrant' | 'requestCompanyLocalGrant'>): () => Promise<void> {
  const line = (tag: 'p' | 'h3' | 'h4' | 'span', value: string): HTMLElement => {
    const node = document.createElement(tag); node.textContent = t(value); return node;
  };
  async function refresh(): Promise<void> {
    const result = await api.companyLocalGrants();
    host.replaceChildren();
    const heading = line('h3', 'Local Company permissions'); heading.id = 'companyLocalGrantsTitle';
    host.setAttribute('role', 'region');
    host.setAttribute('aria-labelledby', heading.id);
    host.append(heading);
    if (!result.ok) {
      const error = line('p', result.error); error.setAttribute('role', 'alert'); host.append(error);
      return;
    }
    const view: CompanyLocalGrantsView = result.data;
    host.append(line('p', 'Local grants never bypass ChatGPT host approvals or operating-system permissions.'));
    const help = document.createElement('p');
    help.textContent = t('Configure recurring approvals in ChatGPT settings; local grants cannot change host approval policy.');
    host.append(help);
    const state = line('p', view.authority.verified ? 'Locally attested identity' : 'Local authorization unavailable');
    state.dataset.grantsAuthority = view.authority.verified ? 'verified' : 'blocked';
    host.append(state);
    if (!view.authority.verified) {
      const reason = line('p', view.authority.reason || 'External broker identity is not locally attested.');
      reason.id = 'companyLocalGrantBlockedReason'; host.append(reason);
    }
    host.append(line('p', `Epoch: ${view.epoch}`));
    const grants = document.createElement('ul');
    grants.setAttribute('aria-label', t('Active local grants'));
    for (const grant of view.grants) {
      const item = document.createElement('li');
      item.dataset.grantId = grant.id;
      const identity = grant.subject.kind === 'coo' ? 'COO' :
        `${grant.subject.workerId} · ${grant.subject.ownerId} · ${grant.subject.runId} · ${grant.subject.conversationId}`;
      item.append(line('span', `${identity} · ${grant.scope} · Epoch: ${grant.epoch}`));
      const revoke = document.createElement('button');
      revoke.type = 'button'; revoke.textContent = t('Revoke local grant');
      revoke.setAttribute('aria-label', `${t('Revoke local grant')}: ${identity} · ${grant.scope}`);
      revoke.addEventListener('click', () => {
        revoke.disabled = true;
        void api.revokeCompanyLocalGrant(grant.id).then(async response => {
          if (!response.ok) throw new Error(response.error);
          await refresh();
        }).catch(error => {
          revoke.disabled = false;
          const alert = line('p', String(error)); alert.setAttribute('role', 'alert'); item.append(alert);
        });
      });
      item.append(revoke); grants.append(item);
    }
    host.append(grants);
    if (!view.grants.length) host.append(line('p', 'No active local grants'));
    const controls = document.createElement('div');
    controls.setAttribute('aria-label', t('Local grant authorization options'));
    const scopeLabel = document.createElement('label');
    scopeLabel.textContent = t('Selected local scope');
    const scopeSelect = document.createElement('select');
    scopeSelect.setAttribute('aria-label', t('Selected local scope'));
    for (const scope of ['company-local-read', 'company-local-triage', 'company-local-review'] as const) {
      const option = document.createElement('option'); option.value = scope; option.textContent = scope;
      scopeSelect.append(option);
    }
    scopeSelect.disabled = !view.authority.verified;
    scopeLabel.append(scopeSelect);
    controls.append(scopeLabel);
    const options = [
      ['task', 'Authorize this task'],
      ['agent', 'Always authorize THIS agent for selected local scope'],
      ['coo', 'Always authorize COO for all LOCAL scopes']
    ] as const;
    for (const [mode, label] of options) {
      const control = document.createElement('button');
      control.type = 'button'; control.textContent = t(label);
      control.disabled = !view.authority.verified || !view.authority.subject ||
        (mode === 'coo' && view.authority.subject.kind !== 'coo') ||
        (mode === 'agent' && view.authority.subject.kind !== 'worker');
      if (control.disabled) control.title = t('A locally attested broker identity is required.');
      control.setAttribute('aria-describedby', view.authority.verified ? heading.id : 'companyLocalGrantBlockedReason');
      control.addEventListener('click', () => {
        if (!view.authority.subject || control.disabled) return;
        control.disabled = true;
        void api.requestCompanyLocalGrant({ mode, scope: scopeSelect.value as 'company-local-read' | 'company-local-triage' | 'company-local-review',
          subject: view.authority.subject, requestId: crypto.randomUUID() }).then(async response => {
          if (!response.ok) throw new Error(response.error);
          await refresh();
        }).catch(error => {
          control.disabled = false;
          const alert = line('p', String(error)); alert.setAttribute('role', 'alert'); controls.append(alert);
        });
      });
      controls.append(control);
    }
    host.append(controls);
    const history = document.createElement('ol'); history.setAttribute('aria-label', t('Local grant audit'));
    for (const entry of view.audit.slice(-30).reverse()) {
      const item = document.createElement('li');
      item.textContent = `${new Date(entry.at).toLocaleString()} · ${entry.action} · ${entry.scope} · Epoch: ${entry.epoch}`;
      history.append(item);
    }
    host.append(line('h4', 'Local grant audit'), history);
    const repeats = view.requests.filter(request => view.requests.filter(other =>
      other.scope === request.scope && JSON.stringify(other.subject) === JSON.stringify(request.subject)).length >= 3);
    if (repeats.length) host.append(line('p', 'Three equivalent requests detected. You may request broader consent; nothing is approved automatically.'));
  }
  void refresh();
  return refresh;
}
