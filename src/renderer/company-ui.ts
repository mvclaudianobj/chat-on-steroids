import type { AppApi } from '../preload/index.js';
import { COMPANY_AREAS, COMPANY_ROLES, COMPANY_STATES, companyRestingSeats, companySeatView, type CompanyRequest, type CompanySeatState, type CompanySnapshot } from '../shared/company.js';
import { t, onLanguageChange } from './i18n.js';

const names: Record<string, string> = { inbox: 'Inbox', assigned: 'Assigned', working: 'Working', review: 'Review', 'needs-ceo': 'Needs CEO', done: 'Done' };
const roleNames = ['Operations', 'Engineering', 'Infrastructure', 'Product', 'Knowledge', 'Quality', 'Communications'];
const $ = (id: string): HTMLElement => document.getElementById(id)!;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = content; return node;
}
function button(text: string, fn: () => void, className = 'btn'): HTMLButtonElement {
  const node = el('button', className, t(text)); node.type = 'button'; node.addEventListener('click', fn); return node;
}
const fmt = (n: number) => new Intl.NumberFormat().format(n);
function date(value: number | null): string { return value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(value) : '—'; }
function priority(status: string): number { return ({ working: 5, 'needs-ceo': 4, review: 3, assigned: 2, inbox: 1, done: 0 } as Record<string,number>)[status] ?? 0; }
function roleLabel(role: string): string { return t(roleNames[COMPANY_ROLES.indexOf(role as typeof COMPANY_ROLES[number])] ?? role); }
const seatStateLabels: Record<CompanySeatState, string> = {
  'rest-free': 'Free · no tasks', 'rest-confirmed': 'Completed · COO confirmed',
  'meeting-invited': 'Meeting invitation pending', 'meeting-accepted': 'Meeting accepted',
  'meeting-present': 'In meeting · confirmed', busy: 'Working', review: 'Awaiting review',
  'needs-ceo': 'Waiting for CEO', unverified: 'Completion not verified'
};

export function initCompanyUi(api: AppApi): { refresh: () => Promise<void> } {
  let snapshot: CompanySnapshot | null = null;
  let view: 'board' | 'office' = 'board';
  let loading = false;
  const dialog = $('companyDialog') as HTMLDialogElement;
  const content = $('companyDialogContent');
  const actions = $('companyDialogActions');
  const title = $('companyDialogTitle');
  function close(): void { dialog.close(); }
  $('companyClose').addEventListener('click', close);
  function open(heading: string): void { title.textContent = t(heading); content.replaceChildren(); actions.replaceChildren(); dialog.showModal(); }
  async function send(request: Parameters<AppApi['company']>[0]): Promise<void> {
    const reply = await api.company(request);
    if (!reply.ok) throw new Error(reply.error);
    snapshot = reply.data; paint();
  }
  async function change(request: Parameters<AppApi['company']>[0]): Promise<void> {
    if (loading) return;
    loading = true;
    try { await send(request); close(); }
    catch (error) { const notice = el('p', 'company-error', (error as Error).message); content.append(notice); }
    finally { loading = false; }
  }
  function field(label: string, node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): HTMLElement {
    const wrapper = el('label', 'company-field'); wrapper.append(el('span', '', t(label)), node); return wrapper;
  }
  function input(value = '', type = 'text'): HTMLInputElement { const node = el('input'); node.type = type; node.value = value; return node; }
  function select(options: readonly string[], value: string, format: (name: string) => string = name => name): HTMLSelectElement {
    const node = el('select'); for (const name of options) { const option = el('option', '', format(name)); option.value = name; node.append(option); } node.value = value; return node;
  }
  function newRequest(): void {
    open('New request');
    const requestTitle = input(); requestTitle.required = true;
    const project = input('General');
    const owner = select(COMPANY_ROLES, 'marks-coo', roleLabel);
    const engine = select(['chatgpt', 'codex', 'claude', 'opencode', 'cliproxy', 'zeroclaw'], 'chatgpt');
    const model = input('gpt-6');
    const acceptance = el('textarea'); acceptance.value = 'Deliver a reviewable result with acceptance evidence.';
    const tokens = input('10000', 'number'); tokens.min = '0'; tokens.max = '10000000';
    const minutes = input('120', 'number'); minutes.min = '0'; minutes.max = '525600';
    content.append(field('Request title', requestTitle), field('Project', project), field('Responsible role', owner), field('Engine', engine), field('Model', model), field('Acceptance criteria', acceptance), field('Token budget', tokens), field('Time budget (minutes)', minutes));
    const save = button('Create request', () => {
      if (!requestTitle.value.trim() || !project.value.trim() || !acceptance.value.trim()) { requestTitle.reportValidity(); return; }
      void change({ action: 'create', payload: { title: requestTitle.value.trim(), project: project.value.trim(), owner: owner.value as typeof COMPANY_ROLES[number], origin: 'ceo', engine: engine.value, model: model.value.trim(), acceptance: acceptance.value.trim(), tokenBudget: Number(tokens.value), timeBudgetMinutes: Number(minutes.value), dueAt: null } });
    }, 'btn btn-solid'); actions.append(save);
    requestTitle.focus();
  }
  function settings(): void {
    if (!snapshot) return;
    open('Company settings');
    const name = input(snapshot.company.name);
    const count = input(String(snapshot.company.seatCount), 'number'); count.min = '1'; count.max = String(Math.max(10, snapshot.company.seatCount));
    content.append(field('Company name', name), field('Employee seats', count), el('p', 'company-dialog-hint', t('Management roles stay fixed. Employee seats are named marks1 through marksN.')));
    actions.append(button('Save settings', () => void change({ action: 'configure', payload: { name: name.value.trim(), seatCount: Number(count.value) } }), 'btn btn-solid'));
  }
  function detail(id: string): void {
    const request = snapshot?.requests.find(row => row.id === id); if (!request || !snapshot) return;
    open('Request details');
    content.append(el('h3', 'company-detail-title', request.title), el('p', 'company-dialog-hint', `${request.project} · ${roleLabel(request.owner)} · ${request.engine}/${request.model}`));
    const state = select(COMPANY_STATES, request.status, state => t(names[state]!));
    const seat = select(['', ...snapshot.company.seats], request.seat ?? '', name => name || t('Unassigned'));
    content.append(field('Status', state), field('Employee seat', seat));
    content.append(el('h4', '', t('Acceptance criteria')), el('p', '', request.acceptance));
    content.append(el('p', 'company-dialog-hint', `${t('Token budget')}: ${fmt(request.tokensUsed)} / ${fmt(request.tokenBudget)} · ${t('Time budget (minutes)')}: ${request.minutesUsed} / ${request.timeBudgetMinutes}`));
    content.append(el('h4', '', 'RACI'), el('p', 'company-dialog-hint', `R: ${request.raci.responsible} · A: ${request.raci.accountable} · C: ${request.raci.consulted.join(', ')} · I: ${request.raci.informed.join(', ')}`));
    if (request.execution) content.append(el('p','company-dialog-hint',`Execution: ${request.execution.phase} · ${request.execution.workerId ?? 'unbound'} · ${request.execution.evidence ?? 'No verified report'}`));
    if (request.cooConfirmation) content.append(el('p', 'company-dialog-hint', `${t('COO confirmation')}: ${request.cooConfirmation.reportId} · ${date(request.cooConfirmation.at)}`));
    content.append(el('h4', '', t('History')));
    const history = el('div', 'company-history'); for (const item of request.history.slice(-10).reverse()) history.append(el('p', '', `${date(item.at)} · ${item.actor}: ${item.note}`)); content.append(history);
    actions.append(button('Save assignment', () => void change({ action: 'seat', payload: { id, seat: seat.value || null } })));
    if (!snapshot.demo && request.status === 'assigned' && request.seat && !request.execution) {
      actions.append(button('Authorize real worker', () => void change({action:'dispatch',payload:{id,consent:true}}),'btn btn-solid'));
    }
    if (!snapshot.demo && request.execution && ['admitted','running','awaiting-authorization'].includes(request.execution.phase)) {
      actions.append(button('Check broker progress', () => void change({action:'refreshBroker',payload:{id}})));
    }
    if (!snapshot.demo && request.status === 'review' && request.execution?.reportId) {
      const evidence = input('Review accepted by COO');
      content.append(field('COO review evidence',evidence));
      actions.append(button('Approve verified completion', () => void change({action:'reviewBroker',payload:{id,evidence:evidence.value.trim(),consent:true}}),'btn btn-solid'));
    }
    actions.append(button('Move request', () => void change({ action: 'move', payload: { id, status: state.value as CompanyRequest['status'] } }), 'btn btn-solid'));
  }
  function chip(text: string, className = ''): HTMLElement { return el('span', `company-chip ${className}`, text); }
  function card(request: CompanyRequest): HTMLElement {
    const node = el('button', 'company-ticket'); node.type = 'button'; node.draggable = true; node.dataset.requestId = request.id;
    node.append(el('span', 'company-ticket-project', request.project), el('strong', '', request.title));
    const meta = el('div', 'company-ticket-meta'); meta.append(chip(request.origin.toUpperCase()), chip(request.seat ?? t('Queue'))); node.append(meta);
    const foot = el('div', 'company-ticket-foot'); foot.append(el('span', '', `${request.engine} · ${request.model}`), el('span', '', date(request.dueAt))); node.append(foot);
    const bar = el('div', 'company-progress'); const fill = el('span'); fill.style.width = `${Math.min(100, request.tokenBudget ? request.tokensUsed / request.tokenBudget * 100 : 0)}%`; bar.append(fill); node.append(bar);
    const cost = el('div', 'company-ticket-cost', `${fmt(request.tokensUsed)} / ${fmt(request.tokenBudget)} ${t('tokens')}`); node.append(cost);
    node.addEventListener('click', () => detail(request.id));
    node.addEventListener('dragstart', event => { event.dataTransfer?.setData('text/plain', request.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; });
    return node;
  }
  function paintBoard(): void {
    const board = $('companyBoard'); board.replaceChildren(); if (!snapshot) return;
    for (const status of COMPANY_STATES) {
      const column = el('section', 'company-column'); column.dataset.status = status;
      const rows = snapshot.requests.filter(row => row.status === status);
      const head = el('div', 'company-column-head'); head.append(el('span', `company-state-dot state-${status}`), el('h2', '', t(names[status]!)), chip(String(rows.length))); column.append(head);
      const list = el('div', 'company-column-list'); for (const request of rows) list.append(card(request)); if (!rows.length) list.append(el('p', 'company-column-empty', t('Drop a request here'))); column.append(list);
      column.addEventListener('dragover', event => { event.preventDefault(); column.classList.add('is-over'); });
      column.addEventListener('dragleave', () => column.classList.remove('is-over'));
      column.addEventListener('drop', event => { event.preventDefault(); column.classList.remove('is-over'); const id = event.dataTransfer?.getData('text/plain'); if (id && snapshot?.requests.some(r => r.id === id)) void change({ action: 'move', payload: { id, status } }); });
      board.append(column);
    }
  }
  function newMeeting(): void {
    if (!snapshot) return;
    open('Convene all workers');
    const meetingTitle = input('Coordination meeting');
    const agenda = el('textarea'); agenda.value = 'Review priorities, dependencies and next actions.';
    const minutes = input('30','number'); minutes.min='1'; minutes.max='480';
    content.append(field('Meeting title',meetingTitle),field('Agenda',agenda),field('Duration (minutes)',minutes),el('p','company-dialog-hint',`${snapshot.company.seats.length} seats will be invited. Invitation does not imply attendance.`));
    actions.append(button('Send invitations',()=>void change({action:'meeting',payload:{title:meetingTitle.value.trim(),agenda:agenda.value.trim(),durationMinutes:Number(minutes.value)}}),'btn btn-solid'));
  }
  function meetingDetail(id:string):void {
    const meeting = snapshot?.meetings.find(item=>item.id===id); if(!meeting) return;
    open('Meeting room');
    content.append(el('h3','',meeting.title),el('p','company-dialog-hint',meeting.agenda ?? '' ));
    for (const invite of meeting.invitations ?? []) content.append(el('p','company-dialog-hint',`${invite.seat} · ${invite.state} ${invite.confirmedAt ? '✓' : ''} ${invite.contribution}`));
    content.append(el('p','company-dialog-hint','Presence requires independent worker acknowledgement; no invitation is attendance.'));
    const notes=el('textarea');notes.value=meeting.minutes;notes.rows=4; content.append(field('Minutes',notes));
    const decisions=el('textarea'); decisions.value=meeting.decisions.join('\n');content.append(field('Decisions (one per line)',decisions));
    if (!snapshot?.demo) {
      actions.append(button('Send authorized invitations',()=>void change({action:'sendInvitations',payload:{id,consent:true}})));
      actions.append(button('Check verified attendance',()=>void change({action:'reconcileMeeting',payload:{id}})));
    }
    actions.append(button('Save minutes',()=>void change({action:'minutes',payload:{id,minutes:notes.value,decisions:decisions.value.split('\n').map(x=>x.trim()).filter(Boolean)}}),'btn btn-solid'));
  }
  function paintOffice(): void {
    const office = $('companyOffice'); office.replaceChildren(); if (!snapshot) return;
    const current = Date.now();
    const resting = companyRestingSeats(snapshot, current);
    const restIds = new Set(resting.map(entry => entry.seat));
    COMPANY_ROLES.forEach((role, index) => {
      const room = el('section', 'company-room');
      const heading = el('div', 'company-room-head'); heading.append(el('span', 'company-room-icon', String.fromCharCode(65 + index)), el('div'));
      heading.lastElementChild!.append(el('h2', '', t(COMPANY_AREAS[index]!)), el('p', '', `${role} · ${t('Manager')}`)); room.append(heading);
      const desks = el('div', 'company-desks');
      const managed = snapshot!.requests.filter(r => r.owner === role && r.status !== 'done');
      const manager = button(role, () => { if (managed[0]) detail(managed[0].id); }, 'company-desk manager');
      manager.prepend(el('span', 'company-desk-avatar', role.slice(-3).toUpperCase())); manager.append(chip(managed.some(r => r.status === 'needs-ceo') ? t('Waiting for CEO') : managed.length ? t('Working') : t('Available'))); desks.append(manager);
      for (const seat of snapshot!.company.seats.filter((seat, i) => {
        if (restIds.has(seat)) return false;
        const assigned = snapshot!.requests.filter(r => r.seat === seat && r.status !== 'done').sort((a, b) => priority(b.status) - priority(a.status))[0];
        return (assigned?.owner ?? COMPANY_ROLES[i % COMPANY_ROLES.length]) === role;
      })) {
        const work = snapshot!.requests.filter(r => r.seat === seat && r.status !== 'done').sort((a, b) => priority(b.status) - priority(a.status))[0];
        const desk = button(seat, () => { if (work) detail(work.id); }, 'company-desk');
        const state = companySeatView(snapshot!, seat, current).state;
        const label = t(seatStateLabels[state]);
        desk.dataset.seat = seat; desk.dataset.state = state;
        desk.setAttribute('aria-label', `${seat}: ${label}`);
        desk.prepend(el('span', 'company-desk-avatar', seat.slice(5))); desk.append(chip(label));
        desk.addEventListener('dragover', event => event.preventDefault());
        desk.addEventListener('drop', event => { event.preventDefault(); const id = event.dataTransfer?.getData('text/plain'); if (id) void change({ action: 'seat', payload: { id, seat } }); });
        desks.append(desk);
      }
      room.append(desks); office.append(room);
    });
    const lounge = el('section', 'company-room company-rest-room');
    lounge.id = 'companyRestRoom';
    lounge.setAttribute('role', 'region');
    lounge.setAttribute('aria-labelledby', 'companyRestTitle');
    const restHeader = el('div', 'company-room-head');
    const restSymbol = el('span', 'company-room-icon', '☕'); restSymbol.setAttribute('aria-hidden', 'true');
    const restHeadText = el('div');
    const restTitle = el('h2', '', t('Rest room')); restTitle.id = 'companyRestTitle';
    restHeadText.append(restTitle, el('p', '', t('Available employees with no pending work or meeting')));
    restHeader.append(restSymbol, restHeadText); lounge.append(restHeader);
    const restList = el('ul', 'company-rest-list'); restList.setAttribute('aria-label', t('Resting employees'));
    for (const entry of resting) {
      const label = t(seatStateLabels[entry.state]);
      const li = el('li', 'company-rest-worker'); li.dataset.seat = entry.seat; li.dataset.restKind = entry.state;
      li.setAttribute('aria-label', `${entry.seat}: ${label}`);
      const avatar = el('span', 'company-desk-avatar', entry.seat.slice(5)); avatar.setAttribute('aria-hidden','true');
      const details = el('div', 'company-rest-worker-body'); details.append(el('strong', '', entry.seat), el('span', 'company-rest-worker-state', label));
      li.append(avatar, details);
      if (entry.completedRequestId) {
        li.append(button('View report', () => detail(entry.completedRequestId!), 'company-rest-review'));
      }
      restList.append(li);
    }
    lounge.append(restList);
    if (!resting.length) lounge.append(el('p', 'company-rest-empty', t('No employees are eligible for rest right now.')));
    if (snapshot.demo) lounge.append(el('p', 'company-rest-demo', t('Synthetic example · not live worker status')));
    office.append(lounge);
    if (snapshot.meetings.length) { const meeting = el('section', 'company-room company-meeting'); meeting.append(el('h2', '', t('Meeting room'))); for (const row of snapshot.meetings) { meeting.append(button(row.title,()=>meetingDetail(row.id),'company-ceo-action'), el('p', '', `${row.participants.join(' · ')} · ${row.durationMinutes} min`), el('p', '', row.minutes)); for (const decision of row.decisions) meeting.append(el('p', 'company-dialog-hint', `• ${decision}`)); } office.append(meeting); }
  }
  function paint(): void {
    if (!snapshot) return;
    $('companyTitle').textContent = snapshot.company.name;
    $('companyBoard').hidden = view !== 'board'; $('companyOffice').hidden = view !== 'office';
    $('companyBoardTab').classList.toggle('is-sel', view === 'board'); $('companyOfficeTab').classList.toggle('is-sel', view === 'office');
    $('companyBoardTab').setAttribute('aria-pressed', String(view === 'board')); $('companyOfficeTab').setAttribute('aria-pressed', String(view === 'office'));
    const empty = snapshot.requests.length === 0; $('companyEmpty').hidden = !empty || view === 'office'; $('companyBoard').hidden ||= empty;
    const working = snapshot.requests.filter(r => r.status === 'working').length;
    const attention = snapshot.requests.filter(r => r.status === 'needs-ceo').length;
    const metrics = $('companyMetrics'); metrics.replaceChildren();
    for (const [label, number, description] of [[t('Open requests'), snapshot.requests.filter(r => r.status !== 'done').length, t('Across all projects')], [t('In progress'), working, t('Assigned to employees')], [t('Needs your decision'), attention, t('CEO attention required')], [t('Tokens recorded'), snapshot.requests.reduce((sum, r) => sum + r.tokensUsed, 0), t('Synthetic estimates in demo')]] as const) {
      const metric = el('div', 'company-metric'); metric.append(el('span', '', label), el('strong', '', fmt(number)), el('small', '', description)); metrics.append(metric);
    }
    paintBoard(); paintOffice();
    const ceo = $('companyCeo'); ceo.replaceChildren();
    const requests = snapshot.requests.filter(r => r.status === 'needs-ceo');
    if (!requests.length) ceo.append(el('p', 'company-muted', t('All clear. Nothing needs your decision.')));
    for (const item of requests) ceo.append(button(`◉ ${item.title}  →`, () => detail(item.id), 'company-ceo-action'));
    const spent = snapshot.requests.reduce((n,r) => n+r.tokensUsed,0); ceo.append(el('p', 'company-ceo-foot', `${fmt(spent)} ${t('tokens')} · ${snapshot.company.seatCount} ${t('employee seats')}`));
    const activity = $('companyActivity'); activity.replaceChildren();
    for (const item of snapshot.activities.slice(0, 6)) { const row = el('div', 'company-event'); row.append(el('span', 'company-event-icon', '↗'), el('div')); row.lastElementChild!.append(el('strong', '', item.actor), el('p', '', item.message)); activity.append(row); }
    if (!snapshot.activities.length) activity.append(el('p', 'company-muted', t('No activity yet.')));
  }
  async function refresh(): Promise<void> {
    try { const reply = await api.company({ action: 'get' }); if (!reply.ok) throw new Error(reply.error); snapshot = reply.data; paint(); }
    catch (error) { $('companyEmpty').hidden = false; $('companyEmpty').append(el('p', 'company-error', (error as Error).message)); }
  }
  $('companyNewRequest').addEventListener('click', newRequest);
  $('companyMeetingCreate').addEventListener('click', newMeeting);
  $('companySettings').addEventListener('click', settings);
  $('companyLoadDemo').addEventListener('click', () => void change({ action: 'demo' }));
  $('companyBoardTab').addEventListener('click', () => { view = 'board'; paint(); });
  $('companyOfficeTab').addEventListener('click', () => { view = 'office'; paint(); });
  onLanguageChange(() => { if (snapshot) paint(); });
  return { refresh };
}
