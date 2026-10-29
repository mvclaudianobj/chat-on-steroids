import { COO_HOST_APPROVAL_DEFAULT_RISKS, type CompanySnapshot, type CooHostApprovalAudit } from '../shared/company.js';
import { t } from './i18n.js';

/** The policy change the section asks for; main confirms an enable natively and revokes at once. */
export type CooHostPolicyChange = { action: 'cooHostPolicy'; payload: { enabled: boolean; riskTerms: string[] } };

const decisionLabels: Record<CooHostApprovalAudit['decision'], string> = {
  allowed: 'Allowed by marks-coo', clicked: 'Pressed on the page', dismissed: 'Card dismissed', unconfirmed: 'Not confirmed by the page',
  'held-risk': 'Held for the CEO: risk', 'held-unattributed': 'Held for the CEO: ownership not exact',
  'held-unavailable': 'Held for the CEO: Allow unavailable', revoked: 'Withdrawn by revocation'
};

/** Toggle, CEO risk list and audit of marks-coo's host approvals, inside Company settings. */
export function mountCooHostApproval(host: HTMLElement, snapshot: CompanySnapshot, change: (request: CooHostPolicyChange) => void): void {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => {
    const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item;
  };
  const policy = snapshot.cooHostApproval;
  host.replaceChildren();
  const heading = node('h3', t('COO host approvals')); heading.id = 'companyCooHostTitle';
  host.setAttribute('role', 'region'); host.setAttribute('aria-labelledby', heading.id);
  host.dataset.cooHostApproval = policy.enabled ? 'on' : 'off';
  host.append(heading, node('p', t('Let marks-coo press Allow once on ChatGPT tool approval cards in chats the Company provably owns. Off by default.'), 'company-dialog-hint'));
  if (snapshot.demo) { host.append(node('p', t('A real company is required for COO host approvals.'), 'company-dialog-hint')); return; }
  host.append(node('p', policy.enabled ? t('COO host approvals are on') : t('COO host approvals are off'), 'company-dialog-hint'));
  const toggleLabel = node('label', '', 'company-field');
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = policy.enabled; toggle.id = 'companyCooHostToggle';
  toggleLabel.append(toggle, node('span', t('Allow marks-coo to answer host approvals')));
  const termsLabel = node('label', '', 'company-field');
  const terms = document.createElement('textarea'); terms.id = 'companyCooHostTerms'; terms.value = policy.riskTerms.join('\n'); terms.rows = 8;
  termsLabel.append(node('span', t('CEO risk list (one term per line). Matching cards always stay for you.')), terms);
  const read = (): string[] => [...new Set(terms.value.split('\n').map(term => term.trim().toLowerCase()).filter(term => term.length >= 2 && term.length <= 80))].slice(0, 64);
  const button = (text: string, fn: () => void, className = 'btn'): HTMLButtonElement => {
    const item = node('button', t(text), className); item.type = 'button'; item.addEventListener('click', fn); return item;
  };
  const row = node('div', '', 'company-dialog-actions');
  row.append(button('Restore default risk list', () => { terms.value = COO_HOST_APPROVAL_DEFAULT_RISKS.join('\n'); }),
    button('Save COO host approval', () => change({ action: 'cooHostPolicy', payload: { enabled: toggle.checked, riskTerms: read() } }), 'btn btn-solid'));
  // Revocation never waits for the rest of the form: one click, effective at once.
  if (policy.enabled) row.append(button('Revoke COO host approvals now', () => change({ action: 'cooHostPolicy', payload: { enabled: false, riskTerms: policy.riskTerms } })));
  host.append(toggleLabel, termsLabel, row, node('h4', t('Host approval audit')));
  const audit = document.createElement('ol'); audit.className = 'company-history'; audit.setAttribute('aria-label', t('Host approval audit'));
  for (const entry of policy.audit.slice(0, 30)) {
    const item = node('li', `${new Date(entry.at).toLocaleString()} · ${t(decisionLabels[entry.decision])} · ${entry.tool} · ${entry.seat ?? entry.conversationId} · ${entry.reason} · #${entry.fingerprint}`);
    item.dataset.decision = entry.decision;
    audit.append(item);
  }
  host.append(policy.audit.length ? audit : node('p', t('No host approval decisions yet'), 'company-dialog-hint'));
}
