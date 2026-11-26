import {editEvent, leaves, describeRule, removeCause, triggers, fullEvent, fullState} from './editor.js';

import {pathLabel} from './routes.js';
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
let stateCanvas=null;
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
function pathTo(id,start=null) {
  const nested=new Set(Object.values(p.entities).flatMap(e=>e.children));
  const paths=start?[start]:Object.keys(p.entities).filter(k=>!nested.has(k)).map(k=>[k]), seen=new Set();
  for(const route of paths){
    const key=route.at(-1);
    if(key===id)return route;
    if(seen.has(key))continue;
    seen.add(key);
    for(const child of p.entities[key].children)paths.push([...route,child]);
  }
  return [id];
}
function eventInBranch(event,branch){
  if(!event.ownerPath)return descendants(branch.at(-1)).has(event.owner);
  const anchor=event.ownerPath[0], index=branch.indexOf(anchor);
  if(index<0)return descendants(branch.at(-1)).has(anchor);
  return branch.slice(index).every((key,i)=>event.ownerPath[i]===key);
}
function go(id, route) {
  picked=null;
  stateCanvas=null;
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
  if(type!=='entities'){
    for(const entity of Object.values(next.entities)){
      delete entity.layers?.[type]?.[id];delete entity.layerSizes?.[type]?.[id];
    }
  }
  if(type==='entities') for(const ent of Object.values(next.entities)) {
    ent.children=ent.children.filter(c=>c!==id);
    clearPlacement(ent,id);
  }
  if(type==='events') for(const evt of Object.values(next.events)) removeCause(evt.causes,id);
  save(next,()=>{if(type==='states' && stateCanvas===id)stateCanvas=null;if(type==='entities' && path.includes(id))path=['root'];});
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
function branchLayout(parent,view){
  if(view==='entities')return parent;
  const views=parent.views??={};
  return views[view]??={positions:{},sizes:{}};
}
function clearPlacement(parent,id){
  for(const layout of [parent,...Object.values(parent.views || {})]){
    delete layout.positions?.[id];delete layout.sizes?.[id];
  }
}
function prepareCard(card,id,kind){
  const parent=p.entities[here()];
  const sizes=kind==='entities'?branchLayout(parent,tab).sizes:parent.layerSizes?.[kind];
  if(sizes?.[id]){
    card.style.width=sizes[id][0]+'px';card.style.minHeight=sizes[id][1]+'px';
  }
  for(const edge of ['n','e','s','w','nw','ne','sw','se']){
    const grip=el('span',{class:'resize-grip grip-'+edge,title:'Изменить размер'});
    grip.dataset.edge=edge;card.append(grip);
  }
  enableCardDrag(card,id,kind);
}
function enableCardDrag(card,id,kind) {
  let suppressClick=false;
  card.addEventListener('click',e=>{
    if(suppressClick && e.detail!==0){e.preventDefault();e.stopImmediatePropagation();}
  },true);
  card.addEventListener('pointerdown',e=>{
    if(!e.isPrimary || e.button!==0)return;
    suppressClick=false;
    const resizing=e.target.closest('.resize-grip');
    if(busy || (!resizing && e.target.closest('button,input,textarea,form,.child-list,.event-relation')))return;
    const target=e.target;
    const start=[e.clientX,e.clientY], rect=card.getBoundingClientRect();
    const boardRect=$('#board').getBoundingClientRect();
    const offset=[e.clientX-boardRect.left-parseFloat(card.style.left),e.clientY-boardRect.top-parseFloat(card.style.top)];
    const previous=[card.style.left,card.style.top,card.style.width,card.style.minHeight];
    const edge=resizing?.dataset.edge || '';
    const origin=[parseFloat(card.style.left),parseFloat(card.style.top)];
    const fixedRight=origin[0]+rect.width, fixedBottom=origin[1]+rect.height;
    const snap=v=>Math.round(v/gridStep)*gridStep;
    let size,position;
    const controller=new AbortController(), options={signal:controller.signal};
    let moving=false, frame=0, pointer=e;
    target.setPointerCapture(e.pointerId);
    function update(){
      if(resizing){
        const canvas=$('#board').getBoundingClientRect();
        const dx=pointer.clientX-start[0]+boardRect.left-canvas.left;
        const dy=pointer.clientY-start[1]+boardRect.top-canvas.top;
        let width=snap(rect.width+(edge.includes('e')?dx:edge.includes('w')?-dx:0));
        if(edge.includes('w'))width=Math.min(width,snap(fixedRight));
        width=Math.max(220,Math.min(10000,width));
        card.style.width=width+'px';
        card.style.minHeight='0px';
        const naturalHeight=Math.ceil(card.getBoundingClientRect().height/gridStep)*gridStep;
        let height=snap(rect.height+(edge.includes('s')?dy:edge.includes('n')?-dy:0));
        if(edge.includes('n'))height=Math.min(height,snap(fixedBottom));
        height=Math.max(100,naturalHeight,Math.min(10000,height));
        card.style.minHeight=height+'px';
        size=[width,Math.min(10000,height)];
        position=[edge.includes('w')?Math.max(0,snap(fixedRight-width)):origin[0],
          edge.includes('n')?Math.max(0,snap(fixedBottom-height)):origin[1]];
        positionCard(card,position);
      }else positionCard(card,pointFor(pointer,offset));
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
      const rollback=()=>{[card.style.left,card.style.top,card.style.width,card.style.minHeight]=previous;};
      if(!commit || !card.isConnected || busy){rollback();return;}
      const point=pointFor(pointer,offset);
      update();
      const next=structuredClone(p),parent=next.entities[here()];
      const finalPoint=resizing?position:point;
      if(kind==='entities'){
        const layout=branchLayout(parent,tab);
        (layout.positions??={})[id]=finalPoint;
        if(size)(layout.sizes??={})[id]=size;
      }else{
        setLayerPoint(next,here(),kind,id,finalPoint);
        if(size)((parent.layerSizes??={})[kind]??={})[id]=size;
      }
      const pending=save(next);
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
    if(tab==='events' && !eventInBranch(obj,path))continue;
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
function stateDetail(id,route){openStateCanvas(id,route);}
export function outbound(id,project=p) {
  return entries(project.events).filter(([,e])=>triggers(e.causes).includes(id)).map(([key])=>key);
}
function eventDetail(id) {
  const e=p.events[id];
  modal(e.name,btn(e.ownerPath?pathLabel(p,e.ownerPath):p.entities[e.owner].name,()=>go(e.owner,e.ownerPath),'link'),el('p',{},e.desc),
    el('h3',{},'Условия'),describeRule(e.conditions,e),el('h3',{},'Причины'),describeRule(e.causes,e),
    el('h3',{},'Последствия'),...e.effects.map((s,i)=>btn(fullState(s,e.effectPaths?.[i]),()=>stateDetail(s,e.effectPaths?.[i]),'effect')),
    ...outbound(id).map(k=>btn('Вызвать событие → '+fullEvent(k),()=>eventDetail(k),'effect')),
    e.effects.length+outbound(id).length?el('span'):blank('Последствий пока нет'),
    footer(btn('Редактировать правило',()=>editEvent(e.owner,id),'primary')));
}
export {eventDetail,stateDetail};
function showRelations() {
  const edges=new Map();
  function add(source,target,eventId,reason){
    const [from,fromRoute]=source, [to,toRoute]=target;
    if(from===to && (fromRoute || []).join('/')===(toRoute || []).join('/'))return;
    if(!eventInBranch({owner:from,ownerPath:fromRoute},path) && !eventInBranch({owner:to,ownerPath:toRoute},path))return;
    const key=JSON.stringify([source,target]);
    const format=(id,route)=>route?pathLabel(p,route):p.entities[id].name;
    if(!edges.has(key)){
      const links=[source,target].filter(([owner,route])=>!eventInBranch({owner,ownerPath:route},path))
        .map(([owner,route])=>btn('Открыть '+format(owner,route)+' ↗',()=>go(owner,route),'link'));
      edges.set(key,{name:format(from,fromRoute)+' → '+format(to,toRoute),rules:[],links});
    }
    edges.get(key).rules.push(btn(reason,()=>eventDetail(eventId),'link'));
  }
  for(const [id,event] of entries(p.events)){
    const emitter=[event.owner,event.ownerPath];
    for(const n of leaves(event.causes)){
      const source=p.events[n.ref];
      add([source.owner,source.ownerPath],emitter,id,source.name+' · в причинах «'+event.name+'»');
    }
    for(const n of leaves(event.conditions))n.refs.forEach((s,i)=>
      add([p.states[s].owner,n.paths?.[i]],emitter,id,p.states[s].name+' · условие для «'+event.name+'»'));
    event.effects.forEach((s,i)=>add(emitter,[p.states[s].owner,event.effectPaths?.[i]],id,event.name+' → '+p.states[s].name));
  }
  modal('Связи систем',...(edges.size?[...edges.values()].map(edge=>
    el('details',{class:'relation'},el('summary',{},edge.name),...edge.rules,...edge.links)):[blank('Между сущностями в этом разделе пока нет связей.')]));
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

export function setLayerPoint(project,owner,kind,key,point){
  const layers=project.entities[owner].layers??={};
  (layers[kind]??={})[key]=point;
}
function scopePath(owner){
  return owner===here()?path.slice():p.entities[here()].children.includes(owner)?[...path,owner]:pathTo(owner);
}
export function currentOwnerPath(owner){return scopePath(owner);}
function editCardFields(container,type,id,focusField='name',owner=here(),point=null){
  const obj=id?p[type][id]:{name:'',desc:''};
  container.querySelector('.inline-fields')?.remove();
  for(const hidden of container.querySelectorAll('[data-edit-hidden]')){hidden.hidden=false;delete hidden.dataset.editHidden;}
  const values={};
  for(const field of (id?[focusField]:['name','desc'])){
    values[field]=el('textarea',{name:field,value:obj[field],rows:field==='name'?1:2,
      required:field==='name',placeholder:field==='name'?'Название':'Описание'});
  }
  const form=el('form',{class:'inline-fields',onsubmit:e=>{
    e.preventDefault();if(busy)return;
    const next=structuredClone(p), key=id || uid();
    if(!id){next.states[key]={owner};if(point)setLayerPoint(next,owner,'states',key,point);}
    for(const [field,input] of entries(values)){
      if(field==='name' && !input.value.trim()){input.focus();return;}
      next[type][key][field]=input.value;
    }
    save(next);
  }},...Object.values(values));
  if(!id)form.append(el('button',{type:'submit',class:'primary'},'Создать состояние'));
  form.onkeydown=e=>{
    if(e.isComposing)return;
    if(e.key==='Enter' && !e.shiftKey){e.preventDefault();form.requestSubmit();}
    if(e.key==='Escape'){e.stopPropagation();render();}
  };
  const activeField=id && container.querySelector('[data-field="'+focusField+'"]');
  if(activeField){
    activeField.after(form);
    activeField.hidden=true;activeField.dataset.editHidden='1';
  }else container.append(form);
  values[focusField].focus();values[focusField].select();
}
function fieldButton(text,container,type,id,field,cls){
  const button=btn(text,()=>editCardFields(container,type,id,field),cls+' editable');
  button.dataset.field=field;return button;
}
function cardText(container,type,id){
  const obj=p[type][id];
  container.append(fieldButton(obj.name,container,type,id,'name','cardtitle'),
    fieldButton(obj.desc || 'Добавить описание',container,type,id,'desc','carddesc'));
}
function addObject(owner=here(),point=null,host=null) {
  if(stateCanvas)go(owner,scopePath(owner));
  if(tab==='events')return editEvent(owner,null,point);
  if(tab==='entities')return openBasic(tab,null,owner);
  if(!host){
    const board=$('#board'), view=$('#content');
    const old=board.querySelector('.state-draft');
    if(old){old.querySelector('textarea')?.focus();return;}
    point??=[view.scrollLeft+25,view.scrollTop+25].map(v=>Math.round(v/5)*5);
    host=el('article',{class:'spacecard owncard states state-draft'});
    positionCard(host,point);board.append(host);
  }
  editCardFields(host,'states',null,'name',owner,point);
}
function openStateCanvas(id,ownerRoute){
  const owner=p.states[id].owner;
  go(owner,ownerRoute || scopePath(owner));
  tab='states';stateCanvas=id;render();
}
function drawActions() {
  const bar=$('#actions'); bar.replaceChildren();
  if(tab==='entities') {
    if(picked)bar.append(el('span',{class:'placementbar'},'Куда поставить «'+p.entities[picked].name+'»?'),btn('Отмена',()=>{picked=null;render();}));
    else bar.append(btn('＋ Сущность в пул',()=>addObject()),el('small',{},'Перетащите из пула или выберите сущность и нажмите на холст.'));
    return;
  }
  bar.append(btn(tab==='states'?'＋ Состояние':'＋ Событие',()=>addObject(),'primary'));
  if(tab==='events')bar.append(btn('Глобальные события',globalEvents),btn('Связи систем',showRelations));

}
function globalEvents(){
  const list=entries(p.events).filter(([,event])=>event.scope==='global');
  modal('Глобальные события',...list.map(([id,e])=>btn(e.name,()=>editEvent(e.owner,id),'effect')),
    footer(btn('＋ Глобальное событие',()=>editEvent('root',null,null,'global'),'primary')));
}
function canvasCard(id,owners,point) {
  const entity=p.entities[id], card=el('article',{class:'spacecard '+(tab==='entities'?'entity':tab)});
  card.style.left=point[0]+'px';card.style.top=point[1]+'px';
  const enter=()=>go(id,[...path,id]);
  const body=el('div',{class:'card-body'});
  const open=btn('↗',enter,'open-canvas corner-open');
  open.title='Открыть холст';open.setAttribute('aria-label','Открыть холст '+entity.name);
  if(tab==='entities')cardText(body,'entities',id);
  else body.append(el('strong',{class:'branch-title'},entity.name));
  if(tab==='entities') {
    const unlink=btn('×',()=>{
      const next=structuredClone(p), parent=next.entities[here()];
      parent.children=parent.children.filter(key=>key!==id);
      clearPlacement(parent,id);
      save(next);
    },'unlink'); unlink.title='Убрать отсюда';unlink.setAttribute('aria-label','Убрать '+entity.name+' отсюда');
    body.append(unlink);
    body.append(el('div',{class:'meta'},'Состояний '+count(p.states,id)+' · Событий '+count(p.events,id)));
    if(entity.children.length){
      const key=here()+'/'+id;
      const list=el('ul',{class:'child-list'},...entity.children.map(child=>
        el('li',{},p.entities[child].name)));
      const toggle=btn('',()=>{
        if(expandedCards.has(key))expandedCards.delete(key);else expandedCards.add(key);
        showChildren();
      },'children-toggle');
      function showChildren(){
        const open=expandedCards.has(key);
        toggle.setAttribute('aria-expanded',String(open));
        toggle.textContent=(open?'▾ ':'▸ ')+'Сущности';
        list.hidden=!open;
      }
      showChildren();body.append(toggle,list);
    }
  } else if(tab==='events'){
    const branch=[...path,id];
    body.append(el('div',{class:'meta'},'Событий '+Object.values(p.events).filter(e=>eventInBranch(e,branch)).length),
      btn('+ Событие',()=>addObject(id,null,body)));
  } else {
    const byOwner=new Map(owners.map(key=>[key,[]]));
    const branch=[...path,id];
    for(const [key,obj] of entries(p.states)){
      if(!byOwner.has(obj.owner))continue;
      const mini=el('div',{class:'mini-state'});
      cardText(mini,'states',key);mini.append(btn('Открыть холст ↗',()=>openStateCanvas(key,pathTo(obj.owner,branch)),'open-canvas'));
      byOwner.get(obj.owner).push(mini);
    }
    for(const [owner,items] of byOwner)if(items.length)body.append(el('section',{},
      owner===id?null:el('small',{},p.entities[owner].name),el('div',{class:'chips'},items)));
    body.append(el('footer',{},btn(tab==='states'?'+ Состояние':'+ Событие',()=>addObject(id,null,body))));
  }
  body.append(open);card.append(body);prepareCard(card,id,'entities');
  return card;
}
function eventLinks(card,id,event){
  const sources=new Set(leaves(event.causes).map(node=>node.ref));
  const destinations=outbound(id);
  function panel(kind,title,rows){
    card.append(el('section',{class:'event-relation '+kind,ariaLabel:title},
      el('strong',{class:'relation-heading'},title),...rows));
  }
  function nameLink(key){
    const link=btn(p.events[key].name,()=>eventDetail(key),'relation-name');
    link.title=fullEvent(key);return link;
  }
  if(sources.size){
    card.classList.add('has-causes');
    const positive=new Set(triggers(event.causes));
    panel('incoming','Причины',Array.from(sources,source=>{
      const remove=btn('×',()=>{
        if(busy)return;
        const next=structuredClone(p);removeCause(next.events[id].causes,source);save(next);
      },'remove-cause');
      remove.setAttribute('aria-label','Убрать причину «'+p.events[source].name+'»');
      return el('div',{class:'relation-row'},positive.has(source)?null:el('small',{},'НЕ'),nameLink(source),remove);
    }));
  }
  if(event.effects.length)panel('state-effects','Смена состояний',event.effects.map((s,i)=>{
    const route=event.effectPaths?.[i];
    const link=btn(p.entities[p.states[s].owner].name+' → '+p.states[s].name,()=>stateDetail(s,route),'relation-name');
    link.title=fullState(s,route);return el('div',{class:'relation-row'},link);
  }));
  if(destinations.length)panel('event-effects','Вызывает события',destinations.map(key=>el('div',{class:'relation-row'},nameLink(key))));
}
function objectCard(id,obj,point){
  const card=el('article',{class:'spacecard owncard '+tab},el('small',{},tab==='states'?'Состояние':'Событие'));
  positionCard(card,point);
  if(tab==='states'){
    cardText(card,'states',id);
    const open=btn('↗',()=>openStateCanvas(id),'open-canvas corner-open');
    open.title='Открыть холст состояния';open.setAttribute('aria-label',open.title);card.append(open);
  }else{
    card.classList.add('event-node');
    card.append(btn(obj.name,()=>eventDetail(id),'cardtitle'),el('small',{class:'event-owner'},obj.ownerPath?pathLabel(p,obj.ownerPath):p.entities[obj.owner].name),el('p',{},obj.desc));
    eventLinks(card,id,obj);
    card.onclick=e=>{if(!e.target.closest('button,.event-relation,.resize-grip'))eventDetail(id);};
  }
  prepareCard(card,id,tab);
  return card;
}
function renderBoard() {
  const board=$('#board'),parent=p.entities[here()], ids=parent.children, groups=branchOwners(ids);
  board.classList.toggle('placing',Boolean(picked));
  const availableWidth=$('#content').clientWidth;
  const columns=Math.max(1,Math.floor((availableWidth-24)/254));
  const cards=ids.map((id,i)=>{
    const point=branchLayout(parent,tab).positions?.[id] || [25+i%columns*255,25+Math.floor(i/columns)*240];
    return {point,card:canvasCard(id,groups.get(id),point)};
  });
  if(tab==='events'){
    renderEventBoard(board,cards);
    return;
  }
  if(tab==='states'){
    let slot=0;
    const positions=parent.layers?.[tab] || {};
    const own=entries(p[tab]).filter(([,obj])=>obj.owner===here() && (tab!=='events' || eventInBranch(obj,path)));
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
  for(const {point,card} of cards){width=Math.max(width,point[0]+(parseInt(card.style.width)||250)+300);height=Math.max(height,point[1]+(parseInt(card.style.minHeight)||250)+300);}
  board.style.width=width+'px';board.style.height=height+'px';
  board.replaceChildren(...cards.map(item=>item.card));
  if(!cards.length)board.append(el('div',{class:'boardhint'},el('strong',{},'Пустой холст'),
    tab==='entities'?'Поставьте сюда первую сущность.':'Добавьте '+(tab==='states'?'состояние':'событие')+' двойным щелчком по холсту.'));
}
function renderEventBoard(board,cards){
  const positions=p.entities[here()].layers?.events || {};
  for(const [id,event] of entries(p.events)){
    if(!eventInBranch(event,path))continue;
    const point=positions[id] || [0,0];
    cards.push({point,auto:!positions[id],card:objectCard(id,event,point)});
  }
  board.replaceChildren(...cards.map(item=>item.card));
  const origin=board.getBoundingClientRect(), occupied=[];
  function footprint(item){
    const boxes=[item.card,...item.card.querySelectorAll('.event-relation')].map(node=>node.getBoundingClientRect());
    const left=Math.floor(Math.min(...boxes.map(b=>b.left))-origin.left);
    const top=Math.floor(Math.min(...boxes.map(b=>b.top))-origin.top);
    return {x:left,y:top,w:Math.ceil(Math.max(...boxes.map(b=>b.right))-origin.left-left),
      h:Math.ceil(Math.max(...boxes.map(b=>b.bottom))-origin.top-top)};
  }
  for(const item of cards.filter(item=>!item.auto))occupied.push(footprint(item));
  const viewWidth=$('#content').clientWidth;
  for(const item of cards.filter(item=>item.auto)){
    const box=footprint(item);let x=25,y=25;
    for(;;){
      const hits=occupied.filter(b=>x<b.x+b.w+25 && x+box.w+25>b.x && y<b.y+b.h+25 && y+box.h+25>b.y);
      if(!hits.length)break;
      const right=5*Math.ceil(Math.max(...hits.map(b=>b.x+b.w+25))/5);
      if(right+box.w<=viewWidth){x=right;continue;}
      y=5*Math.ceil(Math.min(...hits.map(b=>b.y+b.h+25))/5);x=25;
    }
    positionCard(item.card,[x,y]);occupied.push({x,y,w:box.w,h:box.h});
  }
  let width=Math.max(1200,viewWidth+480),height=Math.max(900,$('#content').clientHeight+300);
  for(const b of occupied){width=Math.max(width,b.x+b.w+200);height=Math.max(height,b.y+b.h+200);}
  board.style.width=width+'px';board.style.height=height+'px';
  if(!cards.length)board.append(el('div',{class:'boardhint'},'Двойной щелчок по холсту создаст событие.'));
}
function render() {
  const id=here(),entity=p.entities[id];
  const current=stateCanvas?p.states[stateCanvas]:entity;
  const header=$('.context>div');
  header.querySelector('.inline-fields')?.remove();
  const type=stateCanvas?'states':'entities', key=stateCanvas || id;
  $('#title').replaceChildren(fieldButton(current.name,header,type,key,'name','header-field'));
  $('#description').replaceChildren(fieldButton(current.desc || 'Добавить описание',header,type,key,'desc','header-field'));
  $('#topproject').textContent=p.entities.root.name;
  $('#crumbs').replaceChildren(...path.flatMap((key,i)=>[...(i?[' / ']:[]),btn(p.entities[key].name,()=>go(key,path.slice(0,i+1)),'crumb')]));
  if(stateCanvas)$('#crumbs').append(' / ',current.name);
  $('#up').disabled=!stateCanvas && path.length<2;
  $('#up').onclick=()=>stateCanvas?go(id,path.slice()):go(path.at(-2),path.slice(0,-1));
  $('#tabs').replaceChildren(...entries(tabs).map(([key,name])=>{
    const b=btn(name,()=>{stateCanvas=null;tab=key;picked=null;$('#search').value='';render();},key===tab?'selected':'');
    b.setAttribute('aria-pressed',String(key===tab));return b;
  }));
  if(stateCanvas){
    const stateId=stateCanvas;
    $('#actions').replaceChildren(btn('Удалить состояние',()=>deleteObj('states',stateId),'danger'));
    const detail=el('section',{class:'state-workspace'});
    const matches=(ids,routes)=>ids.some((s,i)=>s===stateId && (!routes?.[i] || path.slice(-routes[i].length).join('/')===routes[i].join('/')));
    for(const [title,match] of [['Проверяется в условиях',e=>leaves(e.conditions).some(n=>matches(n.refs,n.paths))],
      ['Устанавливается событиями',e=>matches(e.effects,e.effectPaths)]]){
      detail.append(el('h3',{},title));
      const related=entries(p.events).filter(([,e])=>match(e));
      detail.append(...(related.length?related.map(([key,e])=>btn(e.name,()=>eventDetail(key),'chip')):[blank('Пока нет связей')]));
    }
    const board=$('#board');board.replaceChildren(detail);board.style.width='100%';board.style.height='100%';
  }else{drawActions();renderBoard();}
  renderPool();
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
  stateCanvas=null;$('#home').hidden=!id;$('#studio').hidden=true;$('#poolToggle').hidden=true;$('#library').hidden=Boolean(id);
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
$('#search').oninput=renderPool;$('#edit').onclick=()=>stateCanvas?editCardFields($('.context>div'),'states',stateCanvas):openBasic('entities',here());

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
board.ondblclick=e=>{if(!stateCanvas && e.target===board && tab!=='entities')addObject(here(),pointFor(e));};
document.addEventListener('keydown',e=>{if(e.key==='Escape' && picked && !$('dialog').open){picked=null;render();}});
window.addEventListener('hashchange',route);
route();
