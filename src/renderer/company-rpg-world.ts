/**
 * Read-only, event-driven visualization. Motion is decoration; authority stays
 * in main's bound broker/Company observation, never in CSS or a browser timer.
 * Inspired by office simulations, but all elements here are original artwork.
 */
export type CompanyRpgState =
  'working' | 'shell-wait' | 'needs-ceo' | 'review' | 'available-confirmed' |
  'meeting-present' | 'disconnected' | 'unverified';
export type CompanyRpgRoom = 'desks' | 'meeting' | 'rest' | 'attention' | 'offline';
export interface CompanyRpgObservation {
  seat: string;
  state: string;
  source: string;
  error: boolean;
}
export function companyRpgRoom(state: CompanyRpgState): CompanyRpgRoom {
  if (state === 'meeting-present') return 'meeting';
  if (state === 'available-confirmed') return 'rest';
  if (state === 'needs-ceo') return 'attention';
  if (state === 'working' || state === 'shell-wait' || state === 'review') return 'desks';
  return 'offline';
}
const definitions: Array<[CompanyRpgRoom, string]> = [
  ['desks', 'Work desks'], ['meeting', 'Meeting room'], ['rest', 'Rest room'],
  ['attention', 'Needs CEO'], ['offline', 'Unverified / disconnected']
];
const valid = new Set<CompanyRpgState>([
  'working', 'shell-wait', 'needs-ceo', 'review', 'available-confirmed',
  'meeting-present', 'disconnected', 'unverified'
]);
function safeState(observation: CompanyRpgObservation | undefined, demo: boolean): CompanyRpgState {
  if (!observation || demo || observation.error || !valid.has(observation.state as CompanyRpgState)) return 'unverified';
  const state = observation.state as CompanyRpgState;
  if (state === 'working' && observation.source !== 'broker') return 'unverified';
  if (state === 'meeting-present' && observation.source !== 'meeting') return 'unverified';
  if (state === 'available-confirmed' && observation.source !== 'company') return 'unverified';
  return state;
}
type Motion = (element: HTMLElement, from: DOMRect, to: DOMRect) => void;
function animateMovement(element: HTMLElement, from: DOMRect, to: DOMRect): void {
  const dx = from.left - to.left, dy = from.top - to.top;
  if (!Number.isFinite(dx + dy) || (!dx && !dy) || typeof element.animate !== 'function') return;
  element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
    { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)' });
}
export function createCompanyRpgWorld(
  root: HTMLElement,
  translate: (key: string) => string,
  reducedMotion: () => boolean = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  move: Motion = animateMovement,
  openInspector: (seat: string) => void = () => undefined
): { update(seats: string[], observations: CompanyRpgObservation[], demo: boolean): void } {
  const title = document.createElement('h2'); title.className = 'company-rpg-heading';
  const hint = document.createElement('p'); hint.className = 'company-muted';
  const rooms = document.createElement('div'); rooms.className = 'company-rpg-rooms';
  const containers = new Map<CompanyRpgRoom, HTMLElement>();
  const actors = new Map<string, HTMLElement>();
  for (const [room, heading] of definitions) {
    const section = document.createElement('section'); section.className = `company-rpg-room company-rpg-${room}`;
    const headingElement = document.createElement('h3'); headingElement.textContent = translate(heading);
    const group = document.createElement('ul'); group.className = 'company-rpg-actors';
    group.setAttribute('aria-label', translate(heading)); section.append(headingElement, group);
    rooms.append(section); containers.set(room, group);
  }
  root.replaceChildren(title, rooms, hint);
  return { update(seats, observations, demo): void {
    title.textContent = translate('Company RPG · live states only');
    for (const [room, name] of definitions) {
      const label=containers.get(room)?.parentElement?.querySelector('h3');
      if (label) label.textContent=translate(name);
    }
    hint.textContent = demo ? translate('Synthetic example · not live worker status') :
      translate('Only broker-confirmed transitions move workers; unknown states remain unverified.');
    const bySeat = new Map(observations.map(item => [item.seat, item]));
    const included = new Set(seats.slice(0, 10));
    for (const [seat, element] of actors) if (!included.has(seat)) { element.remove(); actors.delete(seat); }
    for (const seat of included) {
      const observation = bySeat.get(seat);
      const state = safeState(observation, demo);
      const room = companyRpgRoom(state);
      let actor = actors.get(seat);
      if (!actor) {
        actor = document.createElement('li'); actor.className = 'company-rpg-actor';
        actor.dataset.seat = seat;
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'company-rpg-agent'; button.addEventListener('click', () => openInspector(seat));
        const pixel = document.createElement('span'); pixel.className = 'company-rpg-pixel';
        pixel.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span'); name.className = 'company-rpg-name';
        const stateLabel = document.createElement('span'); stateLabel.className = 'company-rpg-state';
        button.append(pixel, name, stateLabel); actor.append(button); actors.set(seat, actor);
      }
      const priorRoom = actor.parentElement;
      const destination = containers.get(room)!;
      const changedRoom = !!priorRoom && priorRoom !== destination;
      const priorRect = changedRoom ? actor.getBoundingClientRect() : null;
      if (priorRoom !== destination) destination.append(actor);
      actor.dataset.state = state;
      actor.dataset.source = demo ? 'demo' : (observation?.source ?? 'unverified');
      actor.querySelector<HTMLElement>('.company-rpg-name')!.textContent = seat;
      actor.querySelector<HTMLElement>('.company-rpg-state')!.textContent = translate(state);
      const button = actor.querySelector<HTMLButtonElement>('button')!;
      button.setAttribute('aria-label', `${seat} · ${translate(state)}`);
      if (changedRoom && priorRect && !reducedMotion()) move(actor, priorRect, actor.getBoundingClientRect());
    }
  } };
}
