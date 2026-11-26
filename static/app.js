import {editEvent, leaves, describeRule, removeCause, triggers} from './editor.js';

const $ = s => document.querySelector(s);
export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), val);
    else if (key === 'class') node.className = val;
    else if (val !== undefined && val !== null) node[key] = val;
  }
  node.append(...kids.flat().filter(k => k !== null && k !== undefined));
  return node;
}
export const btn = (label, action, cls = '') => el('button', {type:'button', class:cls, onclick:action}, label);
export const option = (value, name) => el('option', {value}, name);
export const label = (name, control) => el('label', {class:'field'}, name, control);
export const entries = obj => Object.entries(obj);
export const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
export let p;
let version, projectId, busy=false, path=['root'], tab='entities', picked=null;
let clipboardDrag=null, loadSequence=0;
const gridStep=5;
const expandedCards=new Set();
const here = () => path.at(-1);
export function descendants(id) {
  const seen = new Set(), queue = [id];
  for (const key of queue) {
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(...p.entities[key].children);
  }
  return seen;
}
function pathTo(id) {
  const paths=[['root']], seen=new Set();
  for (const route of paths) {
    const key=route.at(-1);
    if (key===id) return route;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const child of p.entities[key].children) paths.push([...route,child]);
  }
  return [id];
}
function go(id, route) {
  picked=null;
  path=route || pathTo(id);
  $('#content').scrollTo(0,0);
  if ($('dialog').open) $('dialog').close();
  document.body.classList.remove('openpool');
  render();
}
export function notice(message) {
  const t=$('#toast');
  ($('dialog').open ? $('dialog') : document.body).append(t);
  t.textContent=message; t.classList.add('visible');
  clearTimeout(t.timer); t.timer=setTimeout(()=>t.classList.remove('visible'),4200);
}
export async function save(next, after) {
  if (busy) return;
  const ticket=loadSequence;
  busy=true; document.body.classList.add('saving'); $('#status').textContent='Сохранение…';
  try {
    const r=await fetch('/api/projects/'+projectId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version,project:next})});
    const result=await r.json();
    if(ticket!==loadSequence)return;
    if (!r.ok) throw Error(result.error || 'Не удалось сохранить');
    p=next; version=result.version;
    $('#status').textContent='Сохранено';
    if ($('dialog').open) $('dialog').close();
    if(after) after();
    render();
  } catch(err) { $('#status').textContent='Ошибка сохранения'; notice(err.message); }
  finally { busy=false; document.body.classList.remove('saving'); }
}
export function modal(title,...kids) {
  $('#modal').replaceChildren(el('div',{class:'modalhead'},el('h2',{},title),btn('×',()=>$('dialog').close(),'close')), ...kids);
  if (!$('dialog').open) $('dialog').showModal();
}
export function fields(obj) {
  const name=el('input',{value:obj.name,required:true,placeholder:'Название',oninput:e=>obj.name=e.target.value});
  return [label('Название',name),label('Описание',el('textarea',{value:obj.desc,rows:3,oninput:e=>obj.desc=e.target.value}))];
}
export const footer = (...kids)=>el('div',{class:'footer'},...kids);
const blank=msg=>el('p',{class:'empty'},msg);
const count=(obj,id)=>entries(obj).filter(([,o])=>o.owner===id).length;
function openBasic(type,id,owner=here(),point=null) {
  const next=structuredClone(p), key=id || uid(), obj=next[type][key] || {name:'',desc:''};
  if(!id) {
    next[type][key]=obj;
    if(type==='entities')obj.children=[];
    else {
      obj.owner=owner;
      if(point)setLayerPoint(next,owner,type,key,point);
    }
  }
  const actions=[];
  if(id && id!=='root') actions.push(btn('Удалить '+(type==='entities'?'из пула':'состояние'),()=>deleteObj(type,id),'danger'));
  const form=el('form',{onsubmit:e=>{e.preventDefault();save(next,()=>{if(!id && type==='entities'){picked=key;document.body.classList.remove('openpool');}});}},...fields(obj),
    footer(...actions,el('button',{type:'submit',class:'primary'},'Сохранить')));
  modal(type==='entities'?(id?'Редактировать сущность':'Новая сущность'):(id?'Редактировать состояние':'Новое состояние'),form);
}
export function deleteObj(type,id) {
  const next=structuredClone(p), obj=next[type][id];
  if(type==='entities' && (count(p.events,id)||count(p.states,id))) return notice('Сначала удалите собственные состояния и события этой сущности.');
  if(type==='states' && entries(p.events).some(([,e])=>e.effects.includes(id)||leaves(e.conditions).some(n=>n.refs.includes(id)))) return notice('Состояние используется в правилах. Сначала измените связанные события.');
  if(!confirm('Удалить «'+obj.name+'»'+(type==='entities'?' из пула и всех вложений':'')+'?')) return;
  delete next[type][id];
  if(type!=='entities')delete next.entities[obj.owner].layers?.[type]?.[id];
  if(type==='entities') for(const ent of Object.values(next.entities)) {
    ent.children=ent.children.filter(c=>c!==id);
    if(ent.positions)delete ent.positions[id];
  }
  if(type==='events') for(const evt of Object.values(next.events)) removeCause(evt.causes,id);
  save(next,()=>{if(type==='entities' && path.includes(id))path=['root'];});
}
const tabs={entities:'Сущности',states:'Состояния',events:'События'};
const poolTitles={entities:'Пул сущностей',states:'Состояния раздела',events:'События раздела'};
function pointFor(event,offset=[0,0]){
  const rect=$('#board').getBoundingClientRect();
  return [event.clientX-rect.left-offset[0],event.clientY-rect.top-offset[1]]
    .map(n=>Math.max(0,Math.min(2000000,Math.round(n/gridStep)*gridStep)));
}
function place(id,point) {
  if(busy || tab!=='entities' || !Object.hasOwn(p.entities,id))return;
  if(descendants(id).has(here()))return notice('Такое вложение создаёт цикл.');
  const next=structuredClone(p), parent=next.entities[here()];
  if(!parent.children.includes(id))parent.children.push(id);
  (parent.positions??={})[id]=point;
  return save(next,()=>{picked=null;});
}
function beginDrag(e,id) {
  clipboardDrag={id,owner:here(),project:projectId};
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain',id);
}
function clearPoolDrag(){
  clipboardDrag=null;
  $('#board .drop-preview')?.remove();
}
function positionCard(card,[x,y]){
  card.style.left=x+'px';
  card.style.top=y+'px';
}
function enableCardDrag(card,id,kind) {
  let suppressClick=false;
  card.addEventListener('click',e=>{
    if(suppressClick && e.detail!==0){e.preventDefault();e.stopImmediatePropagation();}
  },true);
  card.addEventListener('pointerdown',e=>{
    if(!e.isPrimary || e.button!==0)return;
    suppressClick=false;
    if(busy || e.target.closest('button:not(.cardtitle),.child-list'))return;
    const target=e.target;
    const start=[e.clientX,e.clientY], rect=card.getBoundingClientRect();
    const offset=[e.clientX-rect.left,e.clientY-rect.top];
    const previous=[card.style.left,card.style.top];
    const controller=new AbortController(), options={signal:controller.signal};
    let moving=false, frame=0, pointer=e;
    target.setPointerCapture(e.pointerId);
    function update(){
      positionCard(card,pointFor(pointer,offset));
    }
    function scrollAtEdge(){
      if(!card.isConnected){finish(false);return;}
      const view=$('#content'), bounds=view.getBoundingClientRect();
      const speed=(value,low,high)=>value<low+24?-10:value>high-24?10:0;
      view.scrollBy(speed(pointer.clientX,bounds.left,bounds.right),speed(pointer.clientY,bounds.top,bounds.bottom));
      update();frame=requestAnimationFrame(scrollAtEdge);
    }
    function finish(commit){
      controller.abort();cancelAnimationFrame(frame);
      if(target.hasPointerCapture(e.pointerId))target.releasePointerCapture(e.pointerId);
      if(!moving)return;
      card.classList.remove('moving');
      const rollback=()=>{[card.style.left,card.style.top]=previous;};
      if(!commit || !card.isConnected || busy){rollback();return;}
      const point=pointFor(pointer,offset);
      positionCard(card,point);
      let pending;
      if(kind==='entities')pending=place(id,point);
      else{
        const next=structuredClone(p);
        setLayerPoint(next,here(),kind,id,point);pending=save(next);
      }
      Promise.resolve(pending).then(()=>{if(card.isConnected)rollback();});
    }
    target.addEventListener('pointermove',event=>{
      if(event.pointerId!==e.pointerId)return;
      pointer=event;
      if(!moving){
        if(Math.hypot(event.clientX-start[0],event.clientY-start[1])<4)return;
        moving=true;suppressClick=true;card.classList.add('moving');
        frame=requestAnimationFrame(scrollAtEdge);
      }
      update();
    },options);
    target.addEventListener('pointerup',event=>{
      if(event.pointerId===e.pointerId){pointer=event;finish(true);}
    },options);
    target.addEventListener('lostpointercapture',event=>{if(event.pointerId===e.pointerId)finish(false);},options);
    target.addEventListener('pointercancel',event=>{if(event.pointerId===e.pointerId)finish(false);},options);
    window.addEventListener('blur',()=>finish(false),options);
    window.addEventListener('keydown',event=>{if(event.key==='Escape')finish(false);},options);
  });
}
function choose(id) {
  if(descendants(id).has(here()))return notice('Такое вложение создаёт цикл.');
  picked=picked===id?null:id;document.body.classList.remove('openpool');render();
}
function renderPool() {
  $('#pooltitle').textContent=poolTitles[tab];
  const needle=$('#search').value.trim().toLocaleLowerCase();
  const rows=[], scope=descendants(here());
  for(const [id,obj] of entries(p[tab])) {
    if(tab==='entities' ? id==='root' : !scope.has(obj.owner))continue;
    if(!obj.name.toLocaleLowerCase().includes(needle))continue;
    const b=btn(obj.name,()=>tab==='entities'?choose(id):tab==='states'?stateDetail(id):eventDetail(id),'poolitem');
    b.prepend(el('span',{class:'symbol'},tab==='entities'?'◇':tab==='states'?'◉':'↯'));
    if(tab==='entities') {
      b.classList.toggle('picked',picked===id);
      b.draggable=true;b.ondragstart=e=>beginDrag(e,id);b.ondragend=clearPoolDrag;
      const jump=btn('↗',()=>go(id),'jump');jump.title='Открыть '+obj.name;
      rows.push(el('div',{class:'poolrow'},b,jump));
    } else {b.title=p.entities[obj.owner].name;rows.push(b);}
  }
  $('#pool').replaceChildren(...(rows.length?rows:[el('p',{class:'emptyPool'},needle?'Ничего не найдено':'Пока пусто. Нажмите ＋, чтобы добавить объект.')]));
}
function stateDetail(id) {
  const s=p.states[id];
  const related=(title,check)=>{
    const list=entries(p.events).filter(([,ev])=>check(ev));
    return el('section',{},el('h3',{},title),list.length?list.map(([key,e])=>btn(p.entities[e.owner].name+' / '+e.name,()=>eventDetail(key),'link')):blank('Нет связанных событий'));
  };
  modal(s.name,btn(p.entities[s.owner].name,()=>go(s.owner),'link'),el('p',{},s.desc),
    related('Переводят в это состояние',e=>e.effects.includes(id)),
    related('Проверяют это состояние',e=>leaves(e.conditions).some(n=>n.refs.includes(id))),
    footer(btn('Редактировать',()=>openBasic('states',id),'primary')));
}
export function outbound(id,project=p) {
  return entries(project.events).filter(([,e])=>triggers(e.causes).includes(id)).map(([key])=>key);
}
function eventDetail(id) {
  const e=p.events[id];
  modal(e.name,btn(p.entities[e.owner].name,()=>go(e.owner),'link'),el('p',{},e.desc),
    el('h3',{},'Условия'),describeRule(e.conditions),el('h3',{},'Причины'),describeRule(e.causes),
    el('h3',{},'Последствия'),...e.effects.map(s=>btn(p.entities[p.states[s].owner].name+' → '+p.states[s].name,()=>stateDetail(s),'effect')),
    ...outbound(id).map(k=>btn('Вызвать событие → '+p.events[k].name,()=>eventDetail(k),'effect')),
    e.effects.length+outbound(id).length?el('span'):blank('Последствий пока нет'),
    footer(btn('Редактировать правило',()=>editEvent(e.owner,id),'primary')));
}
export {eventDetail,stateDetail};
function showRelations(scope) {

  const edges=new Map();
  function add(from,to,ev,text) {
    if(from===to || (!scope.has(from)&&!scope.has(to)))return;
    const k=from+'/'+to;if(!edges.has(k))edges.set(k,{from,to,details:[]});
    edges.get(k).details.push(btn(text,()=>eventDetail(ev),'link'));
  }
  for(const [id,e] of entries(p.events)) {
    for(const n of leaves(e.causes)) {const source=p.events[n.ref];add(source.owner,e.owner,id,source.name+' · в причинах «'+e.name+'»');}
    for(const n of leaves(e.conditions)) for(const s of n.refs) add(p.states[s].owner,e.owner,id,p.states[s].name+' · условие для «'+e.name+'»');
    for(const s of e.effects) add(e.owner,p.states[s].owner,id,e.name+' → '+p.states[s].name);
  }
  const sections=[];
  if(edges.size) sections.push(el('h3',{class:'subtitle'},'Связи систем'),...Array.from(edges.values(),edge=>
    el('details',{class:'relation'},el('summary',{},p.entities[edge.from].name+' → '+p.entities[edge.to].name),...edge.details,
      ...[edge.from,edge.to].filter(id=>!scope.has(id)).map(id=>btn('Открыть '+p.entities[id].name+' ↗',()=>go(id),'link')))));
  modal('Связи систем',...(sections.length?sections.slice(1):[blank('Между сущностями в этом разделе пока нет связей.')]));
}
function branchOwners(children) {
  // Prefer the nearest visible branch when two branches share a descendant.
  const owners=new Map(children.map(id=>[id,[]])), seen=new Set([here()]);
  const queue=children.map(id=>[id,id]);
  for(const [id,branch] of queue) {
    if(seen.has(id))continue;
    seen.add(id);owners.get(branch).push(id);
    for(const child of p.entities[id].children)queue.push([child,branch]);
  }
  return owners;
}
function openObject(id) { if(tab==='states')stateDetail(id);else eventDetail(id); }
export function setLayerPoint(project,owner,kind,key,point){
  const layers=project.entities[owner].layers??={};
  (layers[kind]??={})[key]=point;
}
function addObject(owner=here(),point=null) {
  if(tab==='events')editEvent(owner,null,point);
  else openBasic(tab,null,owner,point);
}
function drawActions() {
  const bar=$('#actions'); bar.replaceChildren();
  if(tab==='entities') {
    if(picked)bar.append(el('span',{class:'placementbar'},'Куда поставить «'+p.entities[picked].name+'»?'),btn('Отмена',()=>{picked=null;render();}));
    else bar.append(btn('＋ Сущность в пул',()=>addObject()),el('small',{},'Перетащите из пула или выберите сущность и нажмите на холст.'));
    return;
  }
  bar.append(btn(tab==='states'?'＋ Состояние':'＋ Событие',()=>addObject(),'primary'));
  if(tab==='events')bar.append(btn('Связи систем',()=>showRelations(descendants(here()))));

}
function canvasCard(id,owners,point) {
  const entity=p.entities[id], card=el('article',{class:'spacecard '+(tab==='entities'?'entity':tab)});
  card.style.left=point[0]+'px';card.style.top=point[1]+'px';
  const enter=()=>go(id,[...path,id]);
  const title=btn(entity.name,enter,'cardtitle');
  if(tab==='entities') {
    const unlink=btn('×',()=>{
      const next=structuredClone(p), parent=next.entities[here()];
      parent.children=parent.children.filter(key=>key!==id);
      if(parent.positions)delete parent.positions[id];
      save(next);
    },'unlink'); unlink.title='Убрать отсюда';unlink.setAttribute('aria-label','Убрать '+entity.name+' отсюда');
    card.append(el('div',{class:'cardtools'},title,unlink),el('p',{},entity.desc),
      el('div',{class:'meta'},'Вложено '+entity.children.length+' · Состояний '+count(p.states,id)+' · Событий '+count(p.events,id)));
    card.onclick=e=>{if(!e.target.closest('button'))enter();};
    if(entity.children.length){
      const key=here()+'/'+id;
      const list=el('ul',{class:'child-list'},...entity.children.map(child=>
        el('li',{},btn(p.entities[child].name,()=>go(child,[...path,id,child]),'link'))));
      const toggle=btn('',()=>{
        if(expandedCards.has(key))expandedCards.delete(key);else expandedCards.add(key);
        showChildren();
      },'children-toggle');
      function showChildren(){
        const open=expandedCards.has(key);
        toggle.setAttribute('aria-expanded',String(open));
        toggle.textContent=(open?'▾ Скрыть':'▸ Вложения')+' · '+entity.children.length;
        list.hidden=!open;
      }
      showChildren();card.append(toggle,list);
    }
    enableCardDrag(card,id,'entities');
  } else {
    card.append(title);
    const byOwner=new Map(owners.map(key=>[key,[]]));
    for(const [key,obj] of entries(p[tab]))byOwner.get(obj.owner)?.push(btn(obj.name,()=>openObject(key),'chip'));
    for(const [owner,items] of byOwner)if(items.length)card.append(el('section',{},
      owner===id?null:el('small',{},p.entities[owner].name),el('div',{class:'chips'},items)));
    card.append(el('footer',{},btn(tab==='states'?'+ Состояние':'+ Событие',()=>addObject(id))));
  }
  return card;
}
function objectCard(id,obj,point){
  const card=el('article',{class:'spacecard owncard '+tab},
    el('small',{},tab==='states'?'Состояние':'Событие'),
    btn(obj.name,()=>openObject(id),'cardtitle'),obj.desc?el('p',{},obj.desc):null);
  card.style.left=point[0]+'px';card.style.top=point[1]+'px';
  card.onclick=e=>{if(!e.target.closest('button'))openObject(id);};
  enableCardDrag(card,id,tab);
  return card;
}
function renderBoard() {
  const board=$('#board'),parent=p.entities[here()], ids=parent.children, groups=branchOwners(ids);
  board.classList.toggle('placing',Boolean(picked));
  const availableWidth=$('#content').clientWidth;
  const columns=Math.max(1,Math.floor((availableWidth-24)/254));
  const cards=ids.map((id,i)=>{
    const point=parent.positions?.[id] || [25+i%columns*255,25+Math.floor(i/columns)*240];
    return {point,card:canvasCard(id,groups.get(id),point)};
  });
  if(tab!=='entities'){
    let slot=0;
    const positions=parent.layers?.[tab] || {};
    const own=entries(p[tab]).filter(([,obj])=>obj.owner===here());
    const occupied=[...cards.map(x=>x.point),...Object.values(positions)];
    for(const [id,obj] of own){
      let point=positions[id];
      if(!point){
        do {
          point=[25+slot%columns*255,25+Math.floor(slot/columns)*180];slot++;
        }while(occupied.some(([x,y])=>Math.abs(x-point[0])<235 && Math.abs(y-point[1])<165));
        occupied.push(point);
      }
      cards.push({point,card:objectCard(id,obj,point)});
    }
  }
  let width=Math.max(1200,availableWidth+480),height=Math.max(900,$('#content').clientHeight+300);
  for(const {point} of cards){width=Math.max(width,point[0]+550);height=Math.max(height,point[1]+550);}
  board.style.width=width+'px';board.style.height=height+'px';
  board.replaceChildren(...cards.map(item=>item.card));
  if(!cards.length)board.append(el('div',{class:'boardhint'},el('strong',{},'Пустой холст'),
    tab==='entities'?'Поставьте сюда первую сущность.':'Добавьте '+(tab==='states'?'состояние':'событие')+' двойным щелчком по холсту.'));
}
function render() {
  const id=here(),entity=p.entities[id];
  $('#title').textContent=entity.name;$('#description').textContent=entity.desc;$('#topproject').textContent=p.entities.root.name;
  $('#crumbs').replaceChildren(btn('Проекты',home,'crumb'),...path.flatMap((key,i)=>[' / ',btn(p.entities[key].name,()=>go(key,path.slice(0,i+1)),'crumb')]));
  if(path[0]!=='root')$('#crumbs').append(' / ',btn('К корню',()=>go('root'),'crumb'));
  $('#tabs').replaceChildren(...entries(tabs).map(([key,name])=>{
    const b=btn(name,()=>{tab=key;picked=null;$('#search').value='';render();},key===tab?'selected':'');
    b.setAttribute('aria-pressed',String(key===tab));return b;
  }));
  drawActions();renderBoard();renderPool();
}
async function request(url,options) {
  const response=await fetch(url,options), result=await response.json();
  if(!response.ok)throw new Error(result.error || 'Ошибка загрузки');
  return result;
}
function home(){if(location.hash)location.hash='';else route();}
function openProject(id){location.hash='project/'+id;}
function newProject(){
  const draft={name:'',desc:''};
  const submit=el('button',{class:'primary',type:'submit'},'Создать проект');
  modal('Новый проект',el('form',{onsubmit:async e=>{
    e.preventDefault();if(submit.disabled)return;submit.disabled=true;
    try {
      const result=await request('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});
      $('dialog').close();openProject(result.id);
    }catch(err){notice(err.message);submit.disabled=false;}
  }},...fields(draft),footer(submit)));
}
async function route(){
  const ticket=++loadSequence, id=location.hash.match(/^#project\/([1-9]\d*)$/)?.[1];
  expandedCards.clear();
  if($('dialog').open)$('dialog').close();
  document.body.classList.remove('openpool');
  $('#studio').hidden=true;$('#poolToggle').hidden=true;$('#library').hidden=Boolean(id);
  $('#topproject').textContent='';$('#status').textContent='Загрузка…';
  try {
    if(id){
      const data=await request('/api/projects/'+id);if(ticket!==loadSequence)return;
      projectId=data.id;p=data.project;version=data.version;path=['root'];tab='entities';picked=null;clipboardDrag=null;
      $('#search').value='';$('#studio').hidden=false;$('#poolToggle').hidden=false;$('#content').scrollTo(0,0);
      render();$('#status').textContent='Сохранено';
    }else{
      const {projects}=await request('/api/projects');if(ticket!==loadSequence)return;
      projectId=null;p=null;$('#status').textContent='';
      $('#projects').replaceChildren(...(projects.length?projects.map(item=>
        el('button',{class:'projectcard',onclick:()=>openProject(item.id)},el('span',{class:'symbol'},'▦'),el('strong',{},item.name),el('p',{},item.desc))
      ):[el('p',{class:'shelfempty'},'Здесь появятся ваши проекты.')]));
    }
  }catch(err){if(ticket!==loadSequence)return;$('#status').textContent='Ошибка загрузки';notice(err.message);$('#library').hidden=false;$('#projects').replaceChildren(btn('Вернуться к проектам',home));}
}
$('#home').onclick=home;$('#newProject').onclick=newProject;
$('#poolToggle').onclick=()=>document.body.classList.toggle('openpool');
$('#createPool').onclick=()=>addObject();
$('#search').oninput=renderPool;$('#edit').onclick=()=>openBasic('entities',here());
const board=$('#board');
board.ondragover=e=>{
  if(!clipboardDrag || tab!=='entities')return;
  e.preventDefault();e.dataTransfer.dropEffect='move';
  let preview=board.querySelector('.drop-preview');
  if(!preview){
    const entity=p.entities[clipboardDrag.id];
    preview=el('div',{class:'spacecard drop-preview'},el('strong',{},entity.name),el('p',{},entity.desc));
    board.append(preview);
  }
  positionCard(preview,pointFor(e));
};
board.ondragleave=e=>{if(!board.contains(e.relatedTarget))board.querySelector('.drop-preview')?.remove();};
board.ondrop=e=>{
  e.preventDefault();
  const drag=clipboardDrag;clearPoolDrag();
  if(drag && !busy && drag.owner===here() && drag.project===projectId && tab==='entities')place(drag.id,pointFor(e));
};
board.onclick=e=>{if(picked && !busy)place(picked,pointFor(e));};
board.ondblclick=e=>{if(e.target===board && tab!=='entities')addObject(here(),pointFor(e));};
document.addEventListener('keydown',e=>{if(e.key==='Escape' && picked && !$('dialog').open){picked=null;render();}});
window.addEventListener('hashchange',route);
route();
