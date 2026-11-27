import {editEvent, leaves, describeRule, removeCause, triggers, ruleReference, parameterRefs, changeReference} from './editor.js';

import {projectGraph, layoutGraph, upstream} from './graph.js';
import {wireLayer} from './wires.js';
import {entityRoutes, pathLabel} from './routes.js';
import {branchText} from './branch-text.js';
import {syncPlacements,migratePlacements,forkPlacement} from './placements.js';
import {parameterTypes, parameterTest, changeText} from './parameters.js';
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
let stateCanvas=null, wires=null;
let selectedNode=null, entityDraft=null;
const backStack=[];
const undoStack=[];
const undoLimit=50;
const graphViewKey=()=>path.join('/');
function graphLayout(project) {
  return ((project.graphLayouts??={})[graphViewKey()]??={positions:{}, sizes:{}, bends:{}});
}
let clipboardDrag=null, loadSequence=0;
const gridStep=5;
const expandedPaths=new Set();
const narrowScope=matchMedia('(max-width: 1000px)');
let scopeOpen=!narrowScope.matches;
const here = () => path.at(-1);
let lastBranch=null;
export function descendants(id) {
  if(lastBranch?.project===p && lastBranch.id===id)return lastBranch.members;
  const seen = new Set(), queue = [id];
  for (const key of queue) {
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(...p.entities[key].children);
  }
  lastBranch={project:p,id,members:seen};
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
function currentView() {
  const canvas=$('#content');
  return {path:[...path],tab,stateCanvas,selectedNode,search:$('#search').value,
    expanded:[...expandedPaths],scroll:[canvas.scrollLeft,canvas.scrollTop],
    scopeQuery:$('#scopeSearch').value,event:$('dialog').open?$('#modal').dataset.event:null};
}
function validView(view){
  return view.path.every((id,i)=>Object.hasOwn(p.entities,id) &&
    (!i || p.entities[view.path[i-1]].children.includes(id))) &&
    (!view.stateCanvas || p.states[view.stateCanvas]?.owner===view.path.at(-1));
}
function go(id,route,viewTab=tab,state=null,revealScope=false) {
  const nextPath=route || pathTo(id);
  const same=path.join('/')===nextPath.join('/') && tab===viewTab && stateCanvas===state;
  if(!same)backStack.push(currentView());
  if(revealScope){
    expandedPaths.add('scope:'+nextPath.join('/'));
    $('#scopeSearch').value='';
    if(narrowScope.matches)scopeOpen=false;
  }
  if(same){if(revealScope)renderScope();return;}
  path=nextPath;tab=viewTab;stateCanvas=state;
  for(let i=1;i<path.length;i++)expandedPaths.add('scope:'+path.slice(0,i).join('/'));
  selectedNode=null;picked=null;entityDraft=null;$('#search').value='';
  if ($('dialog').open) $('dialog').close();
  document.body.classList.remove('openpool');
  render();$('#content').scrollTo(0,0);
}
function goBack(){
  while(backStack.length){
    const previous=backStack.pop();
    if(!validView(previous))continue;
    path=previous.path;tab=previous.tab;stateCanvas=previous.stateCanvas;
    selectedNode=previous.selectedNode;picked=null;entityDraft=null;
    expandedPaths.clear();for(const key of previous.expanded)expandedPaths.add(key);
    $('#search').value=previous.search;
    $('#scopeSearch').value=previous.scopeQuery;
    if($('dialog').open)$('dialog').close();
    render();$('#content').scrollTo(...previous.scroll);
    if(previous.event && p.events[previous.event])eventDetail(previous.event);
    return;
  }
  $('#up').disabled=true;
}
export function notice(message) {
  const t=$('#toast');
  ($('dialog').open ? $('dialog') : document.body).append(t);
  t.textContent=message; t.classList.add('visible');
  clearTimeout(t.timer); t.timer=setTimeout(()=>t.classList.remove('visible'),4200);
}
function topology(project) {
  return JSON.stringify([
    entries(project.entities).map(([id,e])=>[id,e.children]),
    entries(project.states).map(([id,s])=>[id,s.owner]),
    entries(project.events).map(([id,e])=>[id,e.owner,e.ownerPath,e.scope,e.causes,e.conditions,e.effects,e.effectPaths,e.parameterEffects])
  ]);
}
export async function save(next, after, {undo=false,beforePrune}={}) {
  if (busy) return;
  try{syncPlacements(next,uid,beforePrune);}catch(err){notice(err.message);return;}
  // Hand edits belong to this topology. Rebuild after nodes or logical links change.
  if (!undo && next.graphLayouts && topology(p)!==topology(next)) {
    const usedParameters=new Set(Object.values(next.events).flatMap(e=>parameterRefs(e).map(n=>'parameters:'+n.owner+':'+n.ref)));
    for(const [route,layout] of entries(next.graphLayouts)){
      const chain=route.split('/');
      const valid=chain.every((id,i)=>Object.hasOwn(next.entities,id) &&
        (i===0 || next.entities[chain[i-1]].children.includes(id)));
      const sizes=Object.fromEntries(entries(layout.sizes).filter(([key])=>{
        const [kind,id,member]=key.split(':');
        if(kind==='actions')return next.events[id] && leaves(next.events[id].causes).some(n=>n.op==='player' && n.id===member);
        if(kind==='parameters')return usedParameters.has(key);
        return Object.hasOwn(next[kind],id);
      }));
      if(valid && Object.keys(sizes).length)next.graphLayouts[route]={sizes,positions:{},bends:{}};
      else delete next.graphLayouts[route];
    }
    if(!Object.keys(next.graphLayouts).length)delete next.graphLayouts;
  }
  const ticket=loadSequence;
  busy=true; document.body.classList.add('saving'); $('#status').textContent='Сохранение…';
  try {
    const r=await fetch('/api/projects/'+projectId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version,project:next})});
    const result=await r.json();
    if(ticket!==loadSequence)return;
    if (!r.ok) throw Error(result.error || 'Не удалось сохранить');
    if(undo)undoStack.pop();
    else {
      undoStack.push(p);
      if(undoStack.length>undoLimit)undoStack.shift();
    }
    p=next; version=result.version;
    $('#status').textContent='Сохранено';
    if ($('dialog').open) $('dialog').close();
    if(after) after();
    render();
  } catch(err) { $('#status').textContent='Ошибка сохранения'; notice(err.message); }
  finally { busy=false; document.body.classList.remove('saving'); }
}
function undoChange(){
  if(busy)return;
  if(!undoStack.length)return notice('Пока нечего отменять.');
  const previous=undoStack.at(-1);
  // A successful undo is another versioned write. A conflict leaves the stack intact.
  save(structuredClone(previous),()=>{
    while(path.length && !validView({path,stateCanvas:null}))path=path.slice(0,-1);
    if(!path.length)path=['root'];
    if(stateCanvas && p.states[stateCanvas]?.owner!==here())stateCanvas=null;
    picked=null;entityDraft=null;
    notice('Последнее изменение отменено.');
  },{undo:true});
}
export function modal(title,...kids) {
  delete $('#modal').dataset.event;
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
function editEntity(id) {
  const draft={...p.entities[id]};
  if(draft.instanceOf || draft.instanceId)return openBasis(id);
  const form=el('form',{onsubmit:e=>{
    e.preventDefault();
    const next=structuredClone(p);
    Object.assign(next.entities[id],{name:draft.name,desc:draft.desc});
    save(next);
  }},...fields(draft),footer(id!=='root'?btn('Удалить из пула',()=>deleteObj('entities',id),'danger'):null,
    el('button',{type:'submit',class:'primary'},'Сохранить')));
  modal('Редактировать сущность',form);
}
function basis(id){
  while(p.entities[id].instanceOf || p.entities[id].instanceId)id=p.entities[id].instanceOf || p.entities[id].sourceId;
  return id;
}
export function openBasis(id){go(basis(id),null,tab);}
export function pickerRoots(){return path[0]==='root'?[['root']]:[[path[0]],['root']];}
function forkForm(id){
  const input=el('input',{value:p.entities[id].name,required:true});
  modal('Создать отдельную основу',el('form',{onsubmit:e=>{
    e.preventDefault();
    if(!input.value.trim())return input.focus();
    const next=structuredClone(p),source=forkPlacement(next,id,input.value,uid);
    save(next,()=>go(source,[source],'entities'));
  }},label('Название в пуле',input),el('p',{},'Правила и вложенные части копируются один раз. Экземпляр сохранит своё место и связи.'),
  footer(el('button',{class:'primary',type:'submit'},'Создать отдельную основу'))));
  input.select();
}
function beginEntity(){
  if(entityDraft?.target!==null)entityDraft={target:null,name:'',desc:''};
  picked=null;render();$('.entity-draft input')?.focus();
}
function entityDraftForm(){
  const draft=entityDraft;
  if(draft.source)return instanceForm(draft);
  const cancel=()=>{entityDraft=null;render();};
  const form=el('form',{class:'entity-draft',ariaLabel:'Новая сущность',onsubmit:e=>{
    e.preventDefault();
    if(busy)return;
    if(!draft.name.trim()){form.querySelector('input').focus();return;}
    const next=structuredClone(p),id=uid();
    next.entities[id]={name:draft.name.trim(),desc:draft.desc,children:[]};
    save(next,()=>{
      entityDraft=null;
      picked=id;document.body.classList.remove('openpool');
    });
  }},...fields(draft),footer(btn('Отмена',cancel),el('button',{type:'submit',class:'primary'},'Создать')));
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}};
  return form;
}
export function deleteObj(type,id) {
  const next=structuredClone(p), obj=next[type][id];
  if(obj.instanceId)return notice('Элемент унаследован. Его можно удалить в основе.');
  if(type==='entities' && Object.values(p.entities).some(e=>e.instanceOf===id))return notice('У основы есть экземпляры. Сначала уберите их из дерева.');
  if(type==='entities' && (count(p.events,id)||count(p.states,id))) return notice('Сначала удалите собственные состояния и события этой сущности.');
  if(type==='entities' && Object.values(p.events).some(e=>parameterRefs(e).some(n=>n.owner===id)))return notice('Параметры сущности используются в правилах.');
  if(type==='states' && entries(p.events).some(([,e])=>e.effects.includes(id)||leaves(e.conditions).some(n=>n.refs?.includes(id)))) return notice('Состояние используется в правилах. Сначала измените связанные события.');
  if(!confirm('Удалить «'+obj.name+'»'+(type==='entities'?' из пула и всех вложений':'')+'?')) return;
  delete next[type][id];
  if(type!=='entities'){
    for(const entity of Object.values(next.entities)){
      if(type==='events')delete entity.eventLinks?.[id];
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
const poolTitles={entities:'Пул основ',states:'Состояния раздела',events:'События раздела'};
function pointFor(event,offset=[0,0]){
  const rect=$('#board').getBoundingClientRect();
  return [event.clientX-rect.left-offset[0],event.clientY-rect.top-offset[1]]
    .map(n=>Math.max(0,Math.min(2000000,Math.round(n/gridStep)*gridStep)));
}
function attachEntity(id,route) {
  if(busy || tab!=='entities' || !Object.hasOwn(p.entities,id))return;
  const parentId=route.at(-1),owner=basis(parentId);
  if(id===owner || descendants(id).has(parentId))return notice('Такое вложение создаёт цикл.');

  const siblings=p.entities[parentId].children.map(key=>p.entities[key].name);
  let number=1;
  while(siblings.includes(p.entities[id].name+' '+number))number++;
  picked=null;
  const fromPlacement=owner!==parentId;
  if(fromPlacement){go(owner,[owner],'entities');route=[owner];}
  entityDraft={target:route.join('/'),source:id,fromPlacement,name:p.entities[id].name+' '+number};
  expandedPaths.add(entityDraft.target);render();
  const input=$('.entity-draft input');input?.focus();input?.select();
}
function instanceForm(draft){
  const parent=draft.target.split('/').at(-1),source=p.entities[draft.source];
  function commit(){
    if(busy || !draft.name.trim())return;
    const next=structuredClone(p),id=uid();
    next.entities[id]={instanceOf:draft.source,name:draft.name.trim(),desc:source.desc,children:[],slot:id};
    next.entities[parent].children.push(id);
    save(next,finish);
  }
  const input=el('input',{value:draft.name,required:true,oninput:e=>draft.name=e.target.value});
  function finish(){entityDraft=null;if(draft.fromPlacement)goBack();else render();}
  const cancel=finish;
  const form=el('form',{class:'entity-draft',onsubmit:e=>{e.preventDefault();commit();}},
    label('Название экземпляра · '+source.name,input),
    draft.fromPlacement?el('small',{},'Добавится в состав всех экземпляров основы «'+p.entities[basis(parent)].name+'»'):null,
    footer(btn('Отмена',cancel),el('button',{type:'submit',class:'primary'},'Создать экземпляр')));
  form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();cancel();}};
  return form;
}
function beginDrag(e,id) {
  clipboardDrag={id,owner:here(),project:projectId};
  e.dataTransfer.effectAllowed='link';
  e.dataTransfer.setData('text/plain',id);
}
function clearPoolDrag(){
  clipboardDrag=null;$('#board').classList.remove('drop-target');
  $('#board .drop-target')?.classList.remove('drop-target');
}
function positionCard(card,[x,y]){
  card.style.left=x+'px';
  card.style.top=y+'px';
}
function clearPlacement(parent,id){
  for(const layout of [parent,...Object.values(parent.views || {})]){
    delete layout.positions?.[id];delete layout.sizes?.[id];
  }
}
function prepareCard(card,id){
  const size=p.graphLayouts?.[graphViewKey()]?.sizes[id];
  if(size){
    card.style.width=size[0]+'px';card.style.minHeight=size[1]+'px';
  }
  for(const edge of ['n','e','s','w','nw','ne','sw','se']){
    const grip=el('span',{class:'resize-grip grip-'+edge,title:'Изменить размер'});
    grip.dataset.edge=edge;card.append(grip);
  }
  enableCardDrag(card,id);
}
function enableCardDrag(card,id) {
  let suppressClick=false;
  card.addEventListener('click',e=>{
    if(suppressClick && e.detail!==0){e.preventDefault();e.stopImmediatePropagation();}
  },true);
  card.addEventListener('pointerdown',e=>{
    if(!e.isPrimary || e.button!==0)return;
    suppressClick=false;
    const resizing=e.target.closest('.resize-grip');
    if(busy || (!resizing && e.target.closest('button,input,textarea,form,.child-list')))return;
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
      wires?.refresh(card);
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
      const rollback=()=>{[card.style.left,card.style.top,card.style.width,card.style.minHeight]=previous;wires?.refresh(card);};
      if(!commit || !card.isConnected || busy){rollback();return;}
      const point=pointFor(pointer,offset);
      update();
      const next=structuredClone(p),view=graphLayout(next);
      view.positions[id]=resizing?position:point;
      if(size)view.sizes[id]=size;
      const pending=save(next);
      Promise.resolve(pending).then(()=>{if(card.isConnected)rollback();});
    }
    window.addEventListener('pointermove',event=>{
      if(event.pointerId!==e.pointerId)return;
      pointer=event;
      if(!moving){
        if(Math.hypot(event.clientX-start[0],event.clientY-start[1])<4)return;
        moving=true;suppressClick=true;card.classList.add('moving');
        frame=requestAnimationFrame(scrollAtEdge);
      }
      update();
    },options);
    window.addEventListener('pointerup',event=>{
      if(event.pointerId===e.pointerId){pointer=event;finish(true);}
    },options);
    target.addEventListener('lostpointercapture',event=>{if(event.pointerId===e.pointerId)finish(false);},options);
    window.addEventListener('pointercancel',event=>{if(event.pointerId===e.pointerId)finish(false);},options);
    window.addEventListener('blur',()=>finish(false),options);
    window.addEventListener('keydown',event=>{if(event.key==='Escape')finish(false);},options);
  });
}
function choose(id) {
  entityDraft=null;picked=picked===id?null:id;document.body.classList.remove('openpool');render();
}
function renderPool() {
  $('#pooltitle').textContent=poolTitles[tab];
  const draftHost=$('#poolDraft');
  if(tab==='entities' && entityDraft?.target===null){
    if(!draftHost.firstChild)draftHost.append(entityDraftForm());
  }else draftHost.replaceChildren();
  const needle=$('#search').value.trim().toLocaleLowerCase();
  const rows=[], scope=descendants(here());
  for(const [id,obj] of entries(p[tab])) {
    if(tab==='entities' ? id==='root' || obj.privateBasis || obj.instanceId || obj.instanceOf : !scope.has(obj.owner))continue;
    if(tab==='events' && here()!=='root' && !eventInBranch(obj,path))continue;
    if(!obj.name.toLocaleLowerCase().includes(needle))continue;
    const b=btn(obj.name,()=>tab==='entities'?choose(id):tab==='states'?stateDetail(id):eventDetail(id),'poolitem');
    b.prepend(el('span',{class:'symbol'},tab==='entities'?'◇':tab==='states'?'◉':'↯'));
    if(tab==='entities') {
      b.classList.toggle('picked',picked===id);
      b.draggable=true;b.ondragstart=e=>beginDrag(e,id);b.ondragend=clearPoolDrag;
      const jump=btn('↗',()=>go(id),'jump');jump.title='Открыть основу '+obj.name;
      rows.push(el('div',{class:'poolrow'},b,jump));
    } else {
      b.title=p.entities[obj.owner].name;
      if(obj.instanceId || p.entities[obj.owner].instanceOf)b.append(el('small',{},' · '+b.title));
      rows.push(b);
    }
  }
  $('#pool').replaceChildren(...(rows.length?rows:[el('p',{class:'emptyPool'},needle?'Ничего не найдено':'Пока пусто. Нажмите ＋, чтобы добавить объект.')]));
}
function stateDetail(id,route){openStateCanvas(id,route);}
export function outbound(id,project=p) {
  return entries(project.events).filter(([,e])=>triggers(e.causes).includes(id)).map(([key])=>key);
}
function eventDetail(id) {
  const e=p.events[id];
  const targets=outbound(id);
  modal(e.name,...(e.desc?[el('p',{},e.desc)]:[]),
    el('h3',{},'Условия'),describeRule(e.conditions,e),el('h3',{},'Причины'),describeRule(e.causes,e),
    el('h3',{},'Последствия'),e.effects.length+targets.length+(e.parameterEffects?.length || 0)?el('div',{class:'rule-children'},
      ...(e.parameterEffects || []).map(changeReference),
      ...e.effects.map((s,i)=>ruleReference('state',s,e.effectPaths?.[i])),
      ...targets.map(k=>ruleReference('event',k))):blank('Последствий пока нет'),
    footer(btn(e.instanceId?'Редактировать в основе':'Редактировать правило',()=>editEvent(e.owner,id),'primary')));
  $('#modal').dataset.event=id;
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
      if(n.op==='player')continue;
      if(n.op==='change'){
        add([n.owner,n.path],emitter,id,changeText(p,n)+' · причина «'+event.name+'»');continue;
      }
      const source=p.events[n.ref];
      add([source.owner,source.ownerPath],emitter,id,source.name+' · в причинах «'+event.name+'»');
    }
    for(const n of leaves(event.conditions)){
      if(n.op==='parameter')add([n.owner,n.path],emitter,id,parameterTest(p,n)+' · условие для «'+event.name+'»');
      else n.refs.forEach((s,i)=>add([p.states[s].owner,n.paths?.[i]],emitter,id,p.states[s].name+' · условие для «'+event.name+'»'));
    }
    event.effects.forEach((s,i)=>add(emitter,[p.states[s].owner,event.effectPaths?.[i]],id,event.name+' → '+p.states[s].name));
    for(const change of event.parameterEffects || [])add(emitter,[change.owner,change.path],id,event.name+' → '+changeText(p,change));
  }
  modal('Связи систем',...(edges.size?[...edges.values()].map(edge=>
    el('details',{class:'relation'},el('summary',{},edge.name),...edge.rules,...edge.links)):[blank('Между сущностями в этом разделе пока нет связей.')]));
}
function scopePath(owner){
  return descendants(here()).has(owner)?pathTo(owner,path):pathTo(owner);
}
export function currentOwnerPath(owner){return scopePath(owner);}
function editCardFields(container,type,id,focusField='name',owner=here()){
  if(id && (p[type][id].instanceId || p[type][id].instanceOf && focusField==='desc')){
    return notice('Это поле унаследовано. Его можно изменить в основе.');
  }
  const obj=id?p[type][id]:{name:'',desc:''};
  container.querySelector('.inline-fields')?.remove();
  for(const hidden of container.querySelectorAll('[data-edit-hidden]')){hidden.hidden=false;delete hidden.dataset.editHidden;}
  const values={};
  for(const field of (id?[focusField]:['name','desc'])){
    values[field]=el('textarea',{name:field,value:obj[field],rows:field==='name'?1:2,
      required:field==='name',ariaLabel:field==='name'?'Название':'Описание',placeholder:field==='name'?'Название':'Описание'});
  }
  const form=el('form',{class:'inline-fields',onsubmit:e=>{
    e.preventDefault();if(busy)return;
    const next=structuredClone(p), key=id || uid();
    if(!id)next.states[key]={owner};
    for(const [field,input] of entries(values)){
      if(field==='name' && !input.value.trim()){input.focus();return;}
      next[type][key][field]=input.value;
    }
    save(next);
  }},...Object.values(values));
  if(!id)form.append(footer(btn('Отмена',()=>form.remove()),el('button',{type:'submit',class:'primary'},'Создать состояние')));
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
function addObject(owner=here(),host=null) {
  if(tab!=='entities' && basis(owner)!==owner){openBasis(owner);return addObject(basis(owner));}
  if(stateCanvas)go(owner,scopePath(owner));
  if(tab==='events')return editEvent(owner);
  if(tab==='entities')return beginEntity();
  const group=host || $('#board .state-group');
  if(!group)return;
  const ownerToggle=group.querySelector('.state-owner-toggle');
  if(ownerToggle.getAttribute('aria-expanded')==='false')ownerToggle.click();
  editCardFields(group.querySelector('.state-form-slot'),'states',null,'name',owner);
}
function openStateCanvas(id,ownerRoute){
  const owner=p.states[id].owner;
  go(owner,ownerRoute || scopePath(owner),'states',id);
}
function drawActions() {
  const bar=$('#actions'); bar.replaceChildren();
  if(tab==='entities') {
    if(picked)bar.append(el('span',{class:'placementbar'},'Куда вложить «'+p.entities[picked].name+'»?'),
      btn('В текущий раздел',()=>attachEntity(picked,path)),btn('Отмена',()=>{picked=null;render();}));
    else bar.append(btn('Разместить из пула',()=>{document.body.classList.add('openpool');$('#search').focus();}));
    return;
  }
  if(basis(here())===here())bar.append(btn(tab==='states'?'＋ Состояние':'＋ Событие',()=>addObject(),'primary'));
  if(tab==='events'){
    bar.append(btn('Глобальные события',globalEvents),btn('Связи систем',showRelations));
    const children=p.entities[here()].children;
    if(children.length){
      const choose=el('select',{ariaLabel:'Дочерняя сущность'},option('','Дочерняя сущность…'),...children.map(k=>option(k,p.entities[k].name)));
      bar.append(choose,btn('Открыть',()=>choose.value?go(choose.value,[...path,choose.value]):choose.focus()),
        btn('＋ Событие в основе',()=>choose.value?addObject(choose.value):choose.focus()));
    }
  }

}
function globalEvents(){
  const list=entries(p.events).filter(([,event])=>event.scope==='global');
  modal('Глобальные события',...list.map(([id,e])=>btn(e.name,()=>editEvent(e.owner,id),'effect')),
    footer(btn('＋ Глобальное событие',()=>editEvent('root',null,'global'),'primary')));
}
function entityParameters(owner){
  const section=el('section',{class:'entity-parameters',ariaLabel:'Параметры сущности'});
  const parameters=p.entities[owner].parameters || {};
  if(basis(owner)!==owner){
    if(Object.keys(parameters).length)section.append(el('h3',{},'Параметры'),...entries(parameters).map(([,param])=>
      el('div',{class:'parameter-row'},el('span',{},param.name),el('strong',{},parameterTypes[param.type || 'number']))));
    return section;
  }
  function show(editing=null){
    const add=btn('＋ Параметр',()=>show(''));
    add.disabled=editing==='';
    const header=el('div',{class:'parameter-heading'},add);
    if(Object.keys(parameters).length || editing!==null)header.prepend(el('h3',{},'Параметры'));
    section.replaceChildren(header);
    for(const [id,param] of entries(parameters)){
      if(id===editing){section.append(form(id,param));continue;}
      const row=btn('',()=>show(id),'parameter-row');
      row.title='Изменить параметр «'+param.name+'»';
      row.append(el('span',{},param.name),el('strong',{},parameterTypes[param.type || 'number']));
      section.append(row);
    }
    if(editing==='')section.append(form('',{name:'',type:'number'}));
    if(editing!==null)section.querySelector('input').focus();
  }
  function form(id,param){
    const name=el('input',{name:'name',value:param.name,required:true,placeholder:'Например, HP'});
    const type=el('select',{name:'type'},...entries(parameterTypes).map(([k,v])=>option(k,v)));
    type.value=param.type || 'number';
    const usedBy=id && Object.values(p.events).find(e=>parameterRefs(e).some(n=>n.owner===owner && n.ref===id));
    const inUse=()=>notice('Параметр используется в событии «'+usedBy.name+'». Сначала измените правило.');
    const cancel=()=>{show();section.querySelector('.parameter-heading button').focus();};
    const editor=el('form',{class:'parameter-form',onsubmit:e=>{
      e.preventDefault();
      if(busy)return;
      if(!name.value.trim()){name.focus();return;}
      const next=structuredClone(p);
      if(usedBy && type.value!==(param.type || 'number'))return inUse();
      (next.entities[owner].parameters??={})[id || uid()]={name:name.value.trim(),type:type.value};
      save(next);
    }},label('Название',name),label('Тип',type));
    const actions=el('div',{class:'addrow'},el('button',{type:'submit',class:'primary'},'Сохранить'),btn('Отмена',cancel));
    if(id)actions.append(btn('Удалить',()=>{
      if(usedBy)return inUse();
      const next=structuredClone(p),params=next.entities[owner].parameters;
      delete params[id];
      if(!Object.keys(params).length)delete next.entities[owner].parameters;
      save(next);
    },'danger'));
    editor.append(actions);
    editor.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}};
    return editor;
  }
  show();
  return section;
}
function removePlacement(route){
  if(busy || route.length<2)return;
  const id=route.at(-1), parentId=route.at(-2);
  const entity=p.entities[id], parent=p.entities[parentId];
  if(!entity?.instanceOf || !parent?.children.includes(id))return;
  const question=route[0]!=='root'?'Убрать «'+entity.name+'» из состава основы «'+p.entities[route[0]].name+'» и её экземпляров?':
    'Убрать экземпляр «'+entity.name+'» из «'+parent.name+'»?';
  if(!confirm(question))return;
  const next=structuredClone(p),container=next.entities[parentId];
  if(parent.instanceOf)(container.omittedSlots??=[]).push(entity.slot || id);
  container.children=container.children.filter(child=>child!==id);
  function beforePrune(members){
    const linked=Object.values(p.events).find(e=>!members.has(e.owner) && (
      e.effects.some(k=>members.has(p.states[k].owner)) ||
      leaves(e.conditions).some(n=>n.refs?.some(k=>members.has(p.states[k].owner))) ||
      leaves(e.causes).some(n=>n.op==='event' && members.has(p.events[n.ref].owner)) ||
      parameterRefs(e).some(n=>members.has(n.owner))));
    if(linked)throw Error('Экземпляр используется в событии «'+linked.name+'» ('+p.entities[linked.owner].name+'). Сначала измените эту связь.');
    const removedEvents=entries(p.events).filter(([,event])=>members.has(event.owner)).map(([key])=>key);
    for(const [owner,host] of entries(next.entities)){
      if(members.has(owner))continue;
      for(const child of p.entities[owner]?.children || [])if(members.has(child))clearPlacement(host,child);
      for(const key of removedEvents){
        delete host.eventLinks?.[key];
        delete host.layers?.events?.[key];
        delete host.layerSizes?.events?.[key];
      }
    }
  }
  save(next,()=>{
    if(!p.entities[here()])go(parentId,route.slice(0,-1),'entities');
  },{beforePrune});
}
function entityMap(board){
  const root=el('ul',{class:'entity-tree'});
  function branch(route){
    const id=route.at(-1), entity=p.entities[id], key=route.join('/');
    const item=el('li'),row=el('div',{class:'entity-row'});
    row.dataset.route=key;
    const hasChildren=entity.children.length>0;
    const activate=()=>hasChildren?show(!expandedPaths.has(key)):go(id,route);
    const toggle=el('span',{class:hasChildren?'tree-disclosure':'tree-leaf',ariaHidden:'true'});
    const name=btn(entity.name,activate,'tree-name');
    row.onclick=e=>{if(!e.target.closest('button'))activate();};
    const text=el('div',{class:'tree-text'},name);
    if(entity.desc)text.append(el('p',{title:entity.desc},entity.desc));
    row.append(toggle,text);
    if(hasChildren){
      const open=btn('↗',()=>go(id,route),'tree-action');
      open.title='Открыть «'+entity.name+'»';open.setAttribute('aria-label',open.title);
      row.append(open);
    }
    if(picked)row.append(btn('Вложить сюда',()=>attachEntity(picked,route),'tree-attach'));
    else {
      const parentId=route.at(-2);
      const stats=el('div',{class:'tree-stats'});
      const states=count(p.states,id);
      const events=Object.values(p.events).filter(e=>e.owner===id && eventInBranch(e,route)).length;
      function section(kind,total){
        if(!total)return;
        const link=btn(tabs[kind]+' · '+total,()=>{
          go(id,route,kind);
        },'tree-section');
        link.title='Открыть раздел «'+tabs[kind]+'» для «'+entity.name+'»';stats.append(link);
      }
      section('states',states);section('events',events);

      const unlink=btn('×',()=>removePlacement(route),'tree-action');
      unlink.title='Убрать из «'+p.entities[parentId].name+'»';unlink.setAttribute('aria-label',unlink.title);
      row.append(stats,unlink);
    }
    item.append(row);
    if(entityDraft?.target===key)item.append(entityDraftForm());
    function show(open){
      if(open)expandedPaths.add(key);else expandedPaths.delete(key);
      toggle.textContent=open?'▾':'▸';
      name.setAttribute('aria-expanded',String(open));
      name.title=(open?'Свернуть ':'Раскрыть ')+entity.name;
      item.querySelector(':scope > ul')?.remove();
      if(open)item.append(el('ul',{},entity.children.map(child=>branch([...route,child]))));
    }
    if(entity.children.length)show(expandedPaths.has(key));
    return item;
  }
  const children=p.entities[here()].children;
  root.append(...children.map(id=>branch([...path,id])));
  board.style.width='100%';board.style.height='auto';
  board.replaceChildren();
  if(entityDraft?.target===path.join('/'))board.append(entityDraftForm());
  if(children.length)board.append(root);
  else if(!board.childElementCount)board.append(el('p',{class:'tree-empty'},'Пока нет вложенных сущностей. Создайте первую или добавьте из пула.'));
  board.prepend(entityParameters(here()));
}
// Index the project's rules once. A reference with no path applies to every
// placement of the owner. Explicit paths may start below the project root.
function stateReferences(){
  const index=new Map();
  function record(kind,id,event,route){
    if(!index.has(id))index.set(id,{sets:[],checks:[]});
    index.get(id)[kind].push({event,route});
  }
  for(const [key,e] of entries(p.events)){
    e.effects.forEach((id,i)=>record('sets',id,key,e.effectPaths?.[i]));
    for(const leaf of leaves(e.conditions)){
      leaf.refs?.forEach((id,i)=>record('checks',id,key,leaf.paths?.[i]));
    }
  }
  return index;
}
function linksForState(index,id,routes){
  const refs=index.get(id);
  function matches(items){
    return [...new Set((items || []).filter(r=>!r.route || routes.some(route=>
      r.route.length<=route.length && r.route.every((v,i)=>v===route[route.length-r.route.length+i])))
      .map(r=>r.event))];
  }
  return {sets:matches(refs?.sets),checks:matches(refs?.checks)};
}
function stateRules(links){
  const result=el('div',{class:'state-rules'});
  for(const [kind,title] of [['sets','Устанавливают состояние'],['checks','Проверяют в условиях']]){
    const items=links[kind].map(key=>{
      const e=p.events[key],link=btn(e.name,()=>eventDetail(key),'rule-ref ref-event');
      link.title=e.scope==='global'?'Глобальное событие':e.ownerPath?pathLabel(p,e.ownerPath):p.entities[e.owner].name;
      return link;
    });
    result.append(el('section',{},el('h4',{},title),items.length?items:el('span',{class:'state-none'},'Пока нет событий')));
  }
  return result;
}
function stateOverview(board){
  const owners=new Map(),index=stateReferences();
  for(const [id,state] of entries(p.states)){
    if(!owners.has(state.owner))owners.set(state.owner,[]);
    owners.get(state.owner).push([id,state]);
  }
  board.style.width='100%';board.style.height='auto';board.replaceChildren();
  const list=el('div',{class:'state-list'});board.append(list);
  const placements=new Map();
  for(const route of entityRoutes(p,path)){
    const owner=route.at(-1);
    if(!placements.has(owner))placements.set(owner,[]);
    placements.get(owner).push(route);
  }
  const emptyOwners=el('details',{class:'state-empty-owners'});
  let emptyCount=0;
  // Keep the current owner's group first for the toolbar and pool add buttons.
  for(const owner of [here(),...Array.from(placements.keys()).filter(id=>id!==here())]){
    const routes=placements.get(owner);
    const entity=p.entities[owner],route=routes[0],key=route.join('/');
    const group=el('section',{class:'state-group'});group.dataset.route=key;
    const add=btn('＋',()=>addObject(owner,group),'state-add');
    add.title=owner==='root'?'Добавить общее состояние':'Добавить состояние в «'+entity.name+'»';add.setAttribute('aria-label',add.title);
    const states=owners.get(owner) || [];
    if(owner==='root' && !states.length)group.classList.add('empty-project-states');
    const toggle=btn('',()=>setOpen(body.hidden),'state-owner-toggle');
    const arrow=el('span',{ariaHidden:'true'}),count=el('span',{class:'owner-count'},String(states.length));
    count.title='Количество состояний';
    toggle.append(arrow,owner==='root'?'Общие состояния':entity.name,count);
    const label=el('div',{},el('h3',{},toggle));
    if(routes.length>1)label.append(el('small',{},routes.map(r=>pathLabel(p,r.slice(path.length-1,-1).filter(k=>k!=='root'))).filter(Boolean).join(' · ')));
    else if(route.length>path.length+1)label.append(el('small',{},pathLabel(p,route.slice(path.length,-1))));
    const body=el('div',{class:'state-group-body'});
    const head=el('div',{class:'state-group-head'},label,basis(owner)===owner?add:null);
    head.onclick=e=>{if(!e.target.closest('button'))toggle.click();};
    group.append(head,body);
    const expandedKey='owner:'+path.join('/')+':'+owner;
    const defaultOpen=owner===here();
    function setOpen(open){
      if(open===defaultOpen)expandedPaths.delete(expandedKey);else expandedPaths.add(expandedKey);
      toggle.setAttribute('aria-expanded',String(open));
      arrow.textContent=open?'▾':'▸';body.hidden=!open;
      if(!open || body.childElementCount)return;
      body.append(el('div',{class:'state-form-slot'}));
      if(!states.length)body.append(el('p',{class:'state-empty'},'Пока нет состояний'));
      for(const [id,state] of states)body.append(stateRow(id,state));
    }
    function stateRow(id,state){
      const links=linksForState(index,id,routes);
      const recordKey='state:'+key+':'+id,details=el('details',{class:'state-record',open:expandedPaths.has(recordKey)});
      details.dataset.state=id;
      details.ontoggle=()=>{
        if(!details.isConnected)return;
        if(details.open)expandedPaths.add(recordKey);else expandedPaths.delete(recordKey);
      };
      const summary=el('summary',{},el('strong',{},state.name));
      if(!links.sets.length && !links.checks.length)summary.append(el('small',{},'Без связей'));
      const open=routes.map(r=>btn(routes.length===1?'Открыть состояние ↗':pathLabel(p,r.filter(k=>k!=='root'))+' ↗',
        ()=>openStateCanvas(id,r),'link'));
      details.append(summary,el('div',{class:'state-expanded'},state.desc?el('p',{},state.desc):null,stateRules(links),open));
      return details;
    }
    setOpen(defaultOpen!==expandedPaths.has(expandedKey));
    if(states.length || owner===here())list.append(group);
    else {emptyOwners.append(group);emptyCount++;}
  }
  if(emptyCount){
    const key='empty-states:'+path.join('/');
    emptyOwners.prepend(el('summary',{},'Сущности без состояний · '+emptyCount));
    emptyOwners.open=expandedPaths.has(key);
    emptyOwners.ontoggle=()=>{
      if(emptyOwners.isConnected){if(emptyOwners.open)expandedPaths.add(key);else expandedPaths.delete(key);}
    };
    list.append(emptyOwners);
  }
}
function renderEventBoard(board){
  const graph=projectGraph(p,path,eventInBranch);
  const view=p.graphLayouts?.[graphViewKey()];
  const cards=new Map(), lines=new Map();
  board.replaceChildren();
  if(!graph.nodes.length){
    board.style.width='100%'; board.style.height='100%';
    board.append(el('div',{class:'boardhint'},basis(here())===here()?'Двойной щелчок по холсту создаст событие.':'У экземпляра пока нет событий. Откройте основу, чтобы добавить правило.'));
    return;
  }
  function highlight(key){
    selectedNode=key;
    const chain=key && upstream(graph,key);
    for(const [k,card] of cards){
      card.classList.toggle('graph-muted',Boolean(chain && !chain.nodes.has(k)));
      card.classList.toggle('graph-origin',k===key);
      card.querySelector('.graph-title').setAttribute('aria-pressed',String(k===key));
    }
    for(const [k,line] of lines){
      line.classList.toggle('graph-muted',Boolean(chain && !chain.edges.has(k)));
      line.classList.toggle('graph-lit',Boolean(chain && chain.edges.has(k)));
    }
  }
  for(const n of graph.nodes){
    const event=n.kind==='events', parameter=n.kind==='parameters', action=n.kind==='actions';
    const type=event?'Событие':parameter?'Параметр':action?'Действие игрока':'Состояние';
    const owner=n.obj.scope==='global'?'Весь проект':p.entities[n.obj.owner].name;
    const card=el('article',{class:'spacecard owncard graph-card '+n.kind+(n.external?' external':'')});
    const select=()=>highlight(selectedNode===n.key?null:n.key);
    const title=btn(n.obj.name,select,'graph-title');
    const route=n.obj.ownerPath || (n.external?pathTo(n.obj.owner):pathTo(n.obj.owner,path));
    const details=btn('↗',()=>event || action?eventDetail(n.eventId ?? n.id):parameter?go(n.obj.owner,route,'entities'):openStateCanvas(n.id,route),'graph-open');
    details.title=event || action?'Открыть правило':parameter?'Открыть сущность':'Открыть состояние';
    details.setAttribute('aria-label',details.title+' «'+n.obj.name+'»');
    card.dataset.key=n.key;
    card.append(el('small',{},(n.external?'Ярлык · ':'')+type),title,el('span',{class:'graph-owner',title:pathLabel(p,route)},owner),details);
    if(event && n.external){
      const jump=btn(n.obj.scope==='global'?'К глобальному событию':'К сущности ↗',()=>{
        const stored=n.obj.ownerPath || [n.obj.owner],anchor=stored[0];
        // A legacy rule or a partial path may occur under several parents.
        // Follow the nearest shared ancestor when completing its placement.
        let prefix=pathTo(anchor);
        for(let i=path.length;i>0;i--){
          if(descendants(path[i-1]).has(anchor)){prefix=pathTo(anchor,path.slice(0,i));break;}
        }
        const fullRoute=[...prefix,...stored.slice(1)];
        go(n.obj.owner,fullRoute,'events');
        const target=board.querySelector('[data-key="'+CSS.escape(n.key)+'"] .graph-title');
        if(target){
          target.click();target.focus({preventScroll:true});
          target.closest('.graph-card').scrollIntoView({block:'center',inline:'center'});
        }
      },'graph-source');
      jump.title='Показать «'+n.obj.name+'» в разделе «'+owner+'»';card.append(jump);
    }
    card.onclick=e=>{if(!e.target.closest('button,.resize-grip'))select();};
    prepareCard(card,n.key);board.append(card);cards.set(n.key,card);
  }
  const sizes=new Map([...cards].map(([key,card])=>[key,[card.offsetWidth,card.offsetHeight]]));
  const {positions,routes}=layoutGraph(graph,sizes);
  let width=board.parentElement.clientWidth,height=board.parentElement.clientHeight;
  for(const [key,card] of cards){
    const point=view?.positions[key] || positions.get(key);
    positionCard(card,point);
    width=Math.max(width,point[0]+card.offsetWidth+60);height=Math.max(height,point[1]+card.offsetHeight+60);
  }
  wires=wireLayer(board,gridStep);
  for(const e of graph.edges){
    const {port,bends}=routes.get(e.key);
    const points=view?.bends[e.key] || bends;
    for(const [x,y] of points){width=Math.max(width,x+50);height=Math.max(height,y+50);}
    const line=wires.connect(cards.get(e.from),cards.get(e.to),e.role,points,edited=>{
      const next=structuredClone(p);
      graphLayout(next).bends[e.key]=structuredClone(edited);
      return save(next);
    },()=>busy,port,e.labels.join(' / '),e.captions?.join(' / '));
    line.dataset.key=e.key;lines.set(e.key,line);
  }
  board.style.width=width+'px';board.style.height=height+'px';
  board.onclick=e=>{if(e.target===board)highlight(null);};
  highlight(cards.has(selectedNode)?selectedNode:null);
}
const foldedMatches=new Set();
function scopeTree(){
  const query=$('#scopeSearch').value.trim().toLocaleLowerCase();
  const parents=new Map(),visible=new Set();
  for(const [id,entity] of entries(p.entities)){
    for(const child of entity.children){
      if(!parents.has(child))parents.set(child,[]);
      parents.get(child).push(id);
    }
    if(query && entity.name.toLocaleLowerCase().includes(query))visible.add(id);
  }
  // Keep ancestors of matches. Shared entities can have several routes.
  for(const id of visible)for(const parent of parents.get(id) || [])visible.add(parent);
  const tree=$('#scopeTree'), active=path.join('/');
  function branch(route){
    const id=route.at(-1),entity=p.entities[id],key=route.join('/');
    const children=query?entity.children.filter(child=>visible.has(child)):entity.children;
    const open=query?!foldedMatches.has(key):expandedPaths.has('scope:'+key);
    const row=el('div',{class:'scope-row'}),item=el('li',{},row);
    row.dataset.route=key;
    if(children.length){
      const toggle=btn(open?'▾':'▸',()=>{
        if(query){if(open)foldedMatches.add(key);else foldedMatches.delete(key);}
        else if(open)expandedPaths.delete('scope:'+key);
        else expandedPaths.add('scope:'+key);
        scopeTree();
        tree.querySelector('[data-route="'+CSS.escape(key)+'"] .scope-fold')?.focus({preventScroll:true});
      },'scope-fold');
      toggle.setAttribute('aria-expanded',String(open));
      toggle.setAttribute('aria-label',(open?'Свернуть ':'Раскрыть ')+entity.name);row.append(toggle);
    }else row.append(el('span',{class:'scope-space'}));
    const select=btn(tab==='states' && id==='root'?'Весь проект':entity.name,()=>{
      go(id,route,tab,null,true);
      if(scopeOpen)tree.querySelector('[aria-current="true"]')?.focus({preventScroll:true});
      else $('#scopeToggle').focus();
    },'scope-name');
    if(key===active)select.setAttribute('aria-current','true');
    select.title=pathLabel(p,route);row.append(select);
    if(open && children.length)item.append(el('ul',{},children.map(child=>branch([...route,child]))));
    return item;
  }
  const roots=['root'];
  const results=roots.filter(id=>!query || visible.has(id));
  tree.replaceChildren(results.length?el('ul',{},results.map(id=>branch([id]))):el('p',{class:'state-empty'},'Ничего не найдено'));
}
function renderScope(){
  $('#scopeToggle').setAttribute('aria-expanded',String(scopeOpen));
  $('#scopePanel').hidden=!scopeOpen;
  $('#studio').classList.toggle('with-scope',scopeOpen);
  if(scopeOpen)scopeTree();
}
function render() {
  renderScope();
  $('#board').onclick=null;
  $('#board').classList.toggle('entity-map',tab==='entities');
  $('#board').classList.toggle('states-overview',tab==='states' && !stateCanvas);
  $('#content').setAttribute('aria-label',tab==='entities'?'Состав сущности':tab==='states'?'Состояния':'Свободный холст');
  wires?.dispose();wires=null;
  const id=here(),entity=p.entities[id];
  const current=stateCanvas?p.states[stateCanvas]:entity;
  const header=$('.context>div');
  header.querySelector('.inline-fields')?.remove();
  const type=stateCanvas?'states':'entities', key=stateCanvas || id;
  const projectStates=tab==='states' && id==='root' && !stateCanvas;
  $('#title').replaceChildren(projectStates?'Состояния':fieldButton(current.name,header,type,key,'name','header-field'));
  if(current.instanceOf || current.instanceId)$('#title').textContent=current.name;
  $('#description').replaceChildren(current.instanceOf || current.instanceId?current.desc:fieldButton(current.desc || 'Добавить описание',header,type,key,'desc','header-field'));
  $('#edit').hidden=Boolean(current.instanceOf || current.instanceId);
  $('#createPool').hidden=tab!=='entities' && basis(id)!==id;

  $('#topproject').textContent=tab==='states'?'':p.entities.root.name;
  $('#crumbs').replaceChildren(...path.flatMap((key,i)=>[...(i?[' / ']:[]),btn(tab==='states' && key==='root'?'Проект':p.entities[key].name,()=>go(key,path.slice(0,i+1)),'crumb')]));
  if(stateCanvas)$('#crumbs').append(' / ',current.name);
  while(backStack.length && !validView(backStack.at(-1)))backStack.pop();
  $('#up').disabled=!backStack.length;
  $('#up').onclick=goBack;
  $('#tabs').replaceChildren(...entries(tabs).map(([key,name])=>{
    const b=btn(name,()=>go(here(),path,key),key===tab?'selected':'');
    b.setAttribute('aria-pressed',String(key===tab));return b;
  }));
  if(stateCanvas){
    const stateId=stateCanvas;
    let source=stateId;
    while(p.states[source].instanceId)source=p.states[source].sourceId;
    $('#actions').replaceChildren(source===stateId?btn('Удалить состояние',()=>deleteObj('states',stateId),'danger'):
      btn('Состояние основы ↗',()=>openStateCanvas(source)));
    const detail=el('section',{class:'state-workspace'});
    detail.append(stateRules(linksForState(stateReferences(),stateId,[path])));
    const board=$('#board');board.replaceChildren(detail);board.style.width='100%';board.style.height='100%';
  }else{
    drawActions();
    const board=$('#board');
    if(tab==='states')stateOverview(board);
    else if(tab==='entities')entityMap(board);
    else renderEventBoard(board);
  }
  $('#actions').append(el('button',{type:'button',id:'exportText',onclick:showBranchText,title:'Показать текст выбранной ветки'},'В текст'));
  if(basis(id)!==id && !stateCanvas)$('#actions').append(btn('Создать отдельную основу',()=>forkForm(id)));
  if(entity.instanceOf && path.length>1 && tab==='entities')$('#actions').append(btn('Убрать экземпляр',()=>removePlacement(path),'danger'));
  if(basis(id)!==id)$('#actions').prepend(btn('Открыть основу · '+p.entities[basis(id)].name,()=>openBasis(id)));
  renderPool();
}
function showBranchText(){
  const text=branchText(p,path,eventInBranch);
  const preview=el('textarea',{class:'branch-text',readOnly:true,value:text,ariaLabel:'Текст выбранной ветки'});
  const copy=btn('Скопировать',async()=>{
    try{
      await navigator.clipboard.writeText(text);
    }catch{
      preview.focus();preview.select();
      try{if(document.execCommand('copy'))return notice('Текст скопирован.');}catch{}
      return notice('Текст выделен. Скопируйте его сочетанием Ctrl+C или ⌘C.');
    }
    notice('Текст скопирован.');
  },'primary');
  modal('Текст ветки «'+p.entities[here()].name+'»',preview,footer(copy));
}
async function request(url,options) {
  const response=await fetch(url,options), result=await response.json();
  if(!response.ok)throw new Error(result.error || 'Ошибка загрузки');
  return result;
}
function home(){if(location.hash)location.hash='';else route();}
function openProject(id){location.hash='project/'+id;}
function confirmProjectDeletion(item){
  const submit=el('button',{type:'submit',class:'delete-confirm',disabled:true},'Удалить проект');
  const input=el('input',{type:'text',autocomplete:'off',required:true,
    oninput:()=>{submit.disabled=input.value!==item.name;}});
  const form=el('form',{onsubmit:async e=>{
    e.preventDefault();
    if(submit.disabled || input.value!==item.name)return;
    submit.disabled=true;input.disabled=true;
    try{
      await request('/api/projects/'+item.id,{method:'DELETE',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:input.value})});
      if(!location.hash){
        if(form.isConnected && $('dialog').open)await route();
        else document.getElementById('project-'+item.id)?.remove();
      }
    }catch(err){
      notice(err.message);input.disabled=false;submit.disabled=false;
    }
  }},el('p',{},'Все сущности, состояния и события проекта будут удалены.'),
    label('Введите точное название «'+item.name+'»',input),
    footer(btn('Отмена',()=>$('dialog').close()),submit));
  modal('Удалить проект?',form);input.focus();
}
function projectCard(item){
  const open=el('button',{type:'button',class:'projectcard',onclick:()=>openProject(item.id)},
    el('span',{class:'symbol'},'▦'),el('strong',{},item.name),el('p',{},item.desc));
  const remove=btn('Удалить',()=>confirmProjectDeletion(item),'project-delete');
  remove.ariaLabel='Удалить проект «'+item.name+'»';
  return el('article',{class:'project-entry',id:'project-'+item.id},open,remove);
}
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
  wires?.dispose();wires=null;
  const ticket=++loadSequence, id=location.hash.match(/^#project\/([1-9]\d*)$/)?.[1];
  expandedPaths.clear();expandedPaths.add('scope:root');foldedMatches.clear();$('#scopeSearch').value='';
  backStack.length=0;undoStack.length=0;entityDraft=null;
  if($('dialog').open)$('dialog').close();
  document.body.classList.remove('openpool');
  stateCanvas=null;$('#home').hidden=!id;$('#studio').hidden=true;$('#poolToggle').hidden=true;$('#library').hidden=Boolean(id);
  $('#topproject').textContent='';$('#status').textContent='Загрузка…';
  try {
    if(id){
      let data=await request('/api/projects/'+id);if(ticket!==loadSequence)return;
      if(data.project.placementVersion!==2){
        const updated=migratePlacements(data.project,uid);
        const r=await fetch('/api/projects/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({version:data.version,project:updated})});
        if(!r.ok && r.status!==409)throw Error((await r.json()).error);
        data=await request('/api/projects/'+id);
        if(ticket!==loadSequence)return;
        if(data.project.placementVersion!==2)throw Error('Проект изменился во время обновления. Откройте его ещё раз.');
      }
      selectedNode=null;projectId=data.id;p=data.project;version=data.version;path=['root'];tab='entities';picked=null;clipboardDrag=null;
      $('#search').value='';$('#studio').hidden=false;$('#poolToggle').hidden=false;$('#content').scrollTo(0,0);
      render();$('#status').textContent='Сохранено';
    }else{
      const {projects}=await request('/api/projects');if(ticket!==loadSequence)return;
      projectId=null;p=null;lastBranch=null;$('#status').textContent='';
      $('#projects').replaceChildren(...(projects.length?projects.map(projectCard):[el('p',{class:'shelfempty'},'Здесь появятся ваши проекты.')]));
    }
  }catch(err){if(ticket!==loadSequence)return;$('#status').textContent='Ошибка загрузки';notice(err.message);$('#library').hidden=false;$('#projects').replaceChildren(btn('Вернуться к проектам',home));}
}
const importInput=$('#importFile');
$('#importProject').onclick=()=>importInput.click();
importInput.onchange=async()=>{
  const file=importInput.files[0];importInput.value='';
  if(!file)return;
  const button=$('#importProject');button.disabled=true;
  try{
    const data=JSON.parse(await file.text());
    const result=await request('/api/projects/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    openProject(result.id);
  }catch(err){notice('Импорт не выполнен. '+err.message);}
  finally{button.disabled=false;}
};
$('#home').onclick=home;$('#newProject').onclick=newProject;
$('#scopeToggle').onclick=()=>{
  scopeOpen=!scopeOpen;document.body.classList.remove('openpool');renderScope();
  if(scopeOpen)$('#scopeSearch').focus();
};
$('#scopeClose').onclick=()=>{scopeOpen=false;renderScope();$('#scopeToggle').focus();};
$('#scopeSearch').oninput=()=>{foldedMatches.clear();scopeTree();};
narrowScope.addEventListener('change',()=>{scopeOpen=!narrowScope.matches;if(p)renderScope();});
$('#poolToggle').onclick=()=>{
  if(narrowScope.matches && scopeOpen){scopeOpen=false;renderScope();}
  document.body.classList.toggle('openpool');
};
$('#createPool').onclick=()=>addObject();
$('#search').oninput=renderPool;$('#edit').onclick=()=>stateCanvas?editCardFields($('.context>div'),'states',stateCanvas):editEntity(here());

const board=$('#board');
board.ondragover=e=>{
  if(!clipboardDrag || tab!=='entities')return;
  e.preventDefault();e.dataTransfer.dropEffect='link';
  const target=e.target.closest('.entity-row') || board;
  if(!target.classList.contains('drop-target')){
    board.querySelector('.drop-target')?.classList.remove('drop-target');
    board.classList.remove('drop-target');target.classList.add('drop-target');
  }
};
board.ondragleave=e=>{
  if(!board.contains(e.relatedTarget)){
    board.querySelector('.drop-target')?.classList.remove('drop-target');board.classList.remove('drop-target');
  }
};
board.ondrop=e=>{
  e.preventDefault();
  const drag=clipboardDrag,route=e.target.closest('.entity-row')?.dataset.route.split('/') || path;
  clearPoolDrag();
  if(drag && drag.owner===here() && drag.project===projectId)attachEntity(drag.id,route);
};
board.ondblclick=e=>{if(e.target===board && tab==='events' && basis(here())===here())addObject();};
document.addEventListener('keydown',e=>{if(e.key==='Escape' && picked && !$('dialog').open){picked=null;render();}});
document.addEventListener('keydown',e=>{
  if(e.defaultPrevented || e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey ||
     (e.code!=='KeyZ' && e.key.toLowerCase()!=='z') || !projectId || $('#studio').hidden)return;
  if(e.target.isContentEditable || e.target.closest?.('input,textarea'))return;
  e.preventDefault();
  if(!e.repeat)undoChange();
});
window.addEventListener('hashchange',route);
route();
