/**
 * Event-driven Company pixel office. World layout and tile graphics are adapted
 * from Habblaud's project-room / elevator / garden vocabulary (MIT, 2026
 * Márcio Junior); Company/broker remains the sole authority on worker state.
 * License and asset credits: company-assets/LICENSE.md.
 */
import { paintCompanyCharacter, paintCompanyRoom } from './company-pixel-art.js';

export type CompanyRpgState =
  'working'|'approval-wait'|'shell-wait'|'needs-ceo'|'review'|'available-confirmed'|
  'meeting-present'|'disconnected'|'unverified';
export type CompanyRpgRoom = 'desks'|'meeting'|'rest'|'attention'|'offline';
export interface CompanyRpgObservation {
  seat: string;
  state: string;
  source: string;
  error: boolean;
  taskTitle?: string|null;
}
export interface CompanyRpgLayout {
  projects: Array<{ id:string; title:string }>;
  /** Only tickets from the existing Company snapshot, not broker claims. */
  assignments: Record<string,string>;
  areas: Array<{ role:string; name:string }>;
  seatRoles: Record<string,string>;
}
type SceneKind = 'project'|'department'|'rest'|'meeting'|'attention'|'offline'|'garden';
interface Room { element:HTMLElement; list:HTMLElement; heading:HTMLElement; kind:SceneKind; }
const statuses = new Set<CompanyRpgState>([
  'working','approval-wait','shell-wait','needs-ceo','review',
  'available-confirmed','meeting-present','disconnected','unverified'
]);
export function companyRpgRoom(state:CompanyRpgState):CompanyRpgRoom {
  if(state==='meeting-present')return 'meeting';
  if(state==='available-confirmed')return 'rest';
  if(state==='needs-ceo'||state==='approval-wait')return 'attention';
  if(state==='working'||state==='shell-wait'||state==='review')return 'desks';
  return 'offline';
}
function safeState(row:CompanyRpgObservation|undefined,demo:boolean):CompanyRpgState {
  if(!row||demo||row.error||!statuses.has(row.state as CompanyRpgState))return 'unverified';
  const state=row.state as CompanyRpgState;
  if(['working','approval-wait','shell-wait'].includes(state)&&row.source!=='broker')return 'unverified';
  if(state==='meeting-present'&&row.source!=='meeting')return 'unverified';
  if(state==='available-confirmed'&&row.source!=='company')return 'unverified';
  if(['needs-ceo','review'].includes(state)&&row.source!=='company')return 'unverified';
  return state;
}
type Motion=(element:HTMLElement,from:DOMRect,to:DOMRect)=>void;
function animateMovement(element:HTMLElement,from:DOMRect,to:DOMRect):void {
  const dx=from.left-to.left,dy=from.top-to.top;
  if(!Number.isFinite(dx+dy)||(!dx&&!dy)||typeof element.animate!=='function')return;
  element.animate([{transform:`translate(${dx}px, ${dy}px)`},{transform:'translate(0, 0)'}],
    {duration:420,easing:'cubic-bezier(.22,1,.36,1)'});
}
const hash=(name:string)=>{let n=2166136261;for(const c of name){n=Math.imul(n^c.charCodeAt(0),16777619);}return n>>>0;};
const defaults:CompanyRpgLayout={projects:[],assignments:{},areas:[],seatRoles:{}};
export function createCompanyRpgWorld(
  root:HTMLElement,
  translate:(key:string)=>string,
  reducedMotion:()=>boolean=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches??false,
  move:Motion=animateMovement,
  openInspector:(seat:string)=>void=()=>undefined,
  openManager:(role:string)=>void=()=>undefined
):{update(seats:string[],observations:CompanyRpgObservation[],demo:boolean,layout?:CompanyRpgLayout):void;setVisible(visible:boolean):void} {
  const header=document.createElement('div');header.className='company-pixel-header';
  const title=document.createElement('h2');title.className='company-pixel-title';
  const hint=document.createElement('p');hint.className='company-muted';
  const legend=document.createElement('p');legend.className='company-pixel-legend';
  header.append(title,hint,legend);
  const building=document.createElement('div');building.className='company-pixel-building';
  const skyline=document.createElement('div');skyline.className='company-pixel-skyline';
  const roof=document.createElement('div');roof.className='company-pixel-roof';
  const lobby=document.createElement('div');lobby.className='company-pixel-lobby';
  const elevator=document.createElement('div');elevator.className='company-pixel-elevator';
  elevator.setAttribute('aria-hidden','true');
  lobby.append(elevator);
  const hallway=document.createElement('div');hallway.className='company-pixel-hallway';
  const roomsElement=document.createElement('div');roomsElement.className='company-rpg-rooms';
  building.append(skyline,roof,lobby,hallway,roomsElement);
  const roomMap=new Map<string,Room>();
  const actors=new Map<string,HTMLElement>();
  root.replaceChildren(header,building);
  let visible=false;
  function setVisible(next:boolean):void {
    visible=next;root.dataset.paused=String(!visible||document.visibilityState==='hidden'||reducedMotion());
  }
  function ensureRoom(key:string,heading:string,kind:SceneKind):Room {
    let row=roomMap.get(key);
    if(row) {
      row.heading.textContent=heading;
      if(row.kind===kind)return row;
      row.element.remove();roomMap.delete(key);
    }
    const section=document.createElement('section');section.className=`company-rpg-room company-rpg-${kind}`;
    section.dataset.roomKey=key;
    const label=document.createElement('h3');label.textContent=heading;
    const stage=document.createElement('div');stage.className='company-pixel-stage';
    const art=document.createElement('canvas');art.className='company-pixel-floor';
    art.setAttribute('aria-hidden','true');
    paintCompanyRoom(art,kind,hash(key));
    const painting=document.createElement('span');painting.className='company-pixel-painting';
    painting.setAttribute('aria-hidden','true');
    const list=document.createElement('ul');list.className='company-rpg-actors';
    list.setAttribute('aria-label',heading);
    stage.append(art,painting,list);section.append(label,stage);
    roomsElement.append(section);
    row={element:section,list,heading:label,kind};roomMap.set(key,row);
    if(visible&&!reducedMotion())section.classList.add('company-pixel-new-room');
    return row;
  }
  function makeActor(seat:string):HTMLElement {
    const li=document.createElement('li');li.className='company-rpg-actor';li.dataset.seat=seat;
    const button=document.createElement('button');button.type='button';button.className='company-rpg-agent';
    button.addEventListener('click',()=>openInspector(seat));
    const sprite=document.createElement('canvas');sprite.className='company-rpg-pixel';
    sprite.setAttribute('aria-hidden','true');paintCompanyCharacter(sprite,hash(seat));
    const name=document.createElement('span');name.className='company-rpg-name';name.textContent=seat;
    const status=document.createElement('span');status.className='company-rpg-state';
    const task=document.createElement('span');task.className='company-rpg-task';
    const badge=document.createElement('span');badge.className='company-rpg-symbol';
    badge.setAttribute('aria-hidden','true');
    button.append(sprite,badge,name,status,task);li.append(button);
    actors.set(seat,li);return li;
  }
  function badgeFor(state:CompanyRpgState):string{
    return state==='working'?'⌨':state==='approval-wait'?'!':state==='needs-ceo'?'!':
      state==='meeting-present'?'♬':state==='available-confirmed'?'☕':state==='review'?'✓':state==='shell-wait'?'⌛':'?';
  }
  return {
    setVisible,
    update(seats,observations,demo,layout=defaults):void {
      title.textContent=translate('Company RPG · live states only');
      hint.textContent=demo?translate('Synthetic example · not live worker status'):
        translate('Only broker-confirmed transitions move workers; unknown states remain unverified.');
      legend.textContent=translate('Choose a character to inspect its verified task and open its chat.');
      roof.textContent=translate('MARKS / PIXEL OFFICE');
      lobby.dataset.label=translate('Elevator');
      hallway.dataset.label=translate('Project corridor');
      const used=new Set<string>();
      const add=(id:string,name:string,kind:SceneKind):Room=>{used.add(id);return ensureRoom(id,name,kind);};
      // Every live project creates its own room. Closing its final ticket tears
      // down this view's room; an actual unassigned lot stays a garden.
      for(const area of layout.areas){
        const roleRoom=add(`area:${area.role}`,area.name,'department');
        if(!roleRoom.element.querySelector('.company-pixel-manager')){
          const manager=document.createElement('button');manager.type='button';manager.className='company-pixel-manager';
          const sprite=document.createElement('canvas');sprite.className='company-pixel-manager-sprite';
          sprite.setAttribute('aria-hidden','true');paintCompanyCharacter(sprite,hash(area.role));
          const label=document.createElement('span');label.textContent=area.role;
          manager.setAttribute('aria-label',`${area.role} · ${translate('Unverified / disconnected')}`);
          manager.append(sprite,label);
          manager.addEventListener('click',()=>openManager(area.role));
          roleRoom.element.append(manager);
        }
      }
      const projectIds=new Set<string>();
      for(const project of layout.projects){
        if(projectIds.has(project.id))continue;projectIds.add(project.id);
        add(`project:${project.id}`,project.title,'project');
      }
      add('common:meeting',translate('Meeting room'),'meeting');
      add('common:rest',translate('Rest room'),'rest');
      add('common:attention',translate('Needs CEO'),'attention');
      add('common:offline',translate('Unverified / disconnected'),'offline');
      add('common:garden',translate('Garden · available project lot'),'garden');
      const bySeat=new Map(observations.map(row=>[row.seat,row]));
      const present=new Set(seats);
      for(const [seat,actor] of actors)if(!present.has(seat)){actor.remove();actors.delete(seat);}
      for(const seat of present){
        const observation=bySeat.get(seat);
        const state=safeState(observation,demo);
        const room=companyRpgRoom(state);
        const projectId=layout.assignments[seat];
        const area=layout.seatRoles[seat];
        const key=room==='desks'
          ?projectId&&projectIds.has(projectId)?`project:${projectId}`
            :area&&layout.areas.some(row=>row.role===area)?`area:${area}`:'common:offline'
          :`common:${room}`;
        const destination=roomMap.get(key)?.list??roomMap.get('common:offline')!.list;
        const actor=actors.get(seat)??makeActor(seat);
        const previous=actor.parentElement;
        const moved=!!previous&&previous!==destination;
        const before=moved?actor.getBoundingClientRect():null;
        if(previous!==destination)destination.append(actor);
        actor.dataset.state=state;actor.dataset.source=demo?'demo':observation?.source??'unverified';
        actor.querySelector<HTMLElement>('.company-rpg-state')!.textContent=translate(state);
        const task=state==='working'&&observation?.source==='broker'&&!demo?observation.taskTitle?.trim().slice(0,160):null;
        actor.querySelector<HTMLElement>('.company-rpg-task')!.textContent=task??'';
        actor.querySelector<HTMLElement>('.company-rpg-symbol')!.textContent=badgeFor(state);
        actor.querySelector<HTMLButtonElement>('button')!.setAttribute('aria-label',`${seat} · ${translate(state)}${task?` · ${task}`:''}`);
        if(moved&&before&&!reducedMotion()&&visible)move(actor,before,actor.getBoundingClientRect());
      }
      for(const [key,room] of roomMap){
        if(used.has(key))continue;
        room.element.remove();roomMap.delete(key);
      }
      // Room order follows current project/department identity; no event loop or
      // autonomous worker simulation is introduced by the visualization.
      const order=[...[...projectIds].map(id=>`project:${id}`),
        ...layout.areas.map(row=>`area:${row.role}`),
        'common:meeting','common:rest','common:attention','common:offline','common:garden'];
      let slot=0;
      for(const key of order){
        const room=roomMap.get(key);if(!room)continue;
        if(roomsElement.children.item(slot)!==room.element)
          roomsElement.insertBefore(room.element,roomsElement.children.item(slot));
        slot++;
      }
      setVisible(visible);
    }
  };
}
