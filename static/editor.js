import {p,el,btn,option,label,entries,uid,modal,fields,footer,save,deleteObj,outbound,eventDetail,stateDetail,notice,setLayerPoint,currentOwnerPath} from './app.js';

import {entityRoutes,pathLabel} from './routes.js';

export const newGroup = ()=>({op:'and',neg:false,items:[]});
export const leaves = n => n.items ? n.items.flatMap(leaves) : [n];

export function triggers(node, negative=false) {
  const negated = negative !== node.neg;
  if(node.items)return node.items.flatMap(child=>triggers(child,negated));
  return negated ? [] : [node.ref];
}
export function removeCause(node,id,positiveOnly=false,negative=false) {
  const negated=negative !== node.neg;
  for(const child of node.items) if(child.items) removeCause(child,id,positiveOnly,negated);
  node.items=node.items.filter(child=>child.items?child.items.length:
    child.ref!==id || (positiveOnly && (negated !== child.neg)));
}
function addCause(target,id) {
  const group=target.causes, leaf={op:'event',neg:false,ref:id};
  if(!group.items.length) target.causes={...newGroup(),items:[leaf]};
  else if(group.op==='or' && !group.neg)group.items.push(leaf);
  else target.causes={op:'or',neg:false,items:[group,leaf]};
}
const words={and:'И',or:'ИЛИ',all:'Все из',any:'Любой из'};
const ownerLabel=(owner,route)=>route?pathLabel(p,route):p.entities[owner].name+' (общая сущность)';
export const fullState=(id,route)=>ownerLabel(p.states[id].owner,route)+' → '+p.states[id].name;
export const fullEvent=id=>ownerLabel(p.events[id].owner,p.events[id].ownerPath)+' / '+p.events[id].name;

function searchPicker(caption,choices,onPick,browse=null){
  const wrap=el('div',{class:'search-picker'});
  const trigger=btn(caption,()=>{
    if(wrap.children.length>1){wrap.lastElementChild.remove();return;}
    const input=el('input',{type:'search',placeholder:'Введите название или часть пути',ariaLabel:caption});
    const list=el('div',{class:'picker-results'});
    let folder=[];
    function showFolder(){
      if(folder.length){
        list.append(btn('← '+pathLabel(p,folder),()=>{folder=folder.slice(0,-1);filter();},'choice folder-up'));
        for(const item of browse(folder))list.append(btn(item.label,()=>onPick(item),'choice'));
      }
      const nested=new Set(Object.values(p.entities).flatMap(e=>e.children));
      const children=folder.length?p.entities[folder.at(-1)].children:Object.keys(p.entities).filter(key=>!nested.has(key));
      for(const child of children){
        const route=[...folder,child], items=browse(route);
        if(!items.length && !p.entities[child].children.length)continue;
        list.append(btn(p.entities[child].name+' ›',()=>{folder=route;filter();},'choice folder'));
      }
      if(!list.childElementCount)list.append(el('small',{},'Нет доступных элементов'));
    }
    function filter(){
      list.replaceChildren();
      const terms=input.value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      if(!terms.length && browse){showFolder();return;}
      for(const item of choices()){
        if(!terms.every(term=>item.label.toLocaleLowerCase().includes(term)))continue;
        list.append(btn(item.label,()=>onPick(item),'choice'));
        if(list.childElementCount===75){list.append(el('small',{},'Уточните поиск для остальных результатов'));break;}
      }
      if(!list.childElementCount)list.append(el('small',{},'Совпадений нет'));
    }
    input.oninput=filter;
    input.onkeydown=e=>{
      if(e.key==='Enter'){e.preventDefault();list.querySelector('button')?.click();}
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();wrap.lastElementChild.remove();trigger.focus();}
    };
    wrap.append(el('div',{class:'picker-panel'},input,list));filter();input.focus();
  },'pick-trigger');
  wrap.append(trigger);return wrap;
}
function* eventChoices(){
  for(const [key] of entries(p.events))yield {key,label:fullEvent(key)};
}
function statesOf(owner){return entries(p.states).filter(([,s])=>s.owner===owner);}
function stateItems(route){return statesOf(route.at(-1)).map(([key])=>({key,route,label:fullState(key,route)}));}
function* stateChoices(){for(const route of entityRoutes(p))yield* stateItems(route);}
function conditionFields(node,draw){
  const refs=node.refs, paths=node.paths??=refs.map(()=>null);
  const ownerAt=i=>paths[i]?.at(-1) ?? p.states[refs[i]].owner;
  const group=el('div',{class:'condition-members'});
  refs.forEach((key,i)=>{
    group.append(el('div',{class:'effectline'},el('span',{},ownerLabel(ownerAt(i),paths[i])+' → '+(p.states[key]?.name || 'Выберите состояние')),
      btn('Убрать',()=>{refs.splice(i,1);paths.splice(i,1);draw();},'unlink')));
  });
  function members(route){
    if(!statesOf(route.at(-1)).length || paths.some(r=>r?.join('/')===route.join('/')))return [];
    return [{route,label:'Выбрать · '+pathLabel(p,route)}];
  }
  function* available(){for(const route of entityRoutes(p))yield* members(route);}
  group.append(searchPicker('＋ Сущность в группу',available,({route})=>{
    const shared=refs.length && refs.every(key=>p.states[key]?.name===p.states[refs[0]]?.name)?p.states[refs[0]]?.name:null;
    paths.push(route);refs.push(statesOf(route.at(-1)).find(([,s])=>s.name===shared)?.[0] || '');draw();
  },members));
  if(refs.length){
    const options=refs.map((_,i)=>statesOf(ownerAt(i)));
    const names=[...new Set(options[0].map(([,s])=>s.name))].filter(name=>options.every(row=>row.some(([,s])=>s.name===name)));
    const name=p.states[refs[0]]?.name;
    const selected=name && refs.every(key=>p.states[key]?.name===name)?name:'';
    group.append(label('Состояние для всей группы',selector([['','Выберите состояние'],...names.map(v=>[v,v])],selected,v=>{
      if(v){node.refs=options.map(row=>row.find(([,s])=>s.name===v)[0]);draw();}
    })));
    if(!names.length)group.append(el('small',{},'У выбранных сущностей нет общего названия состояния. Используйте отдельную проверку для другой группы.'));
  }
  return group;
}
export function describeRule(n) {
  if(n.items && !n.items.length)return el('p',{class:'empty'},'Не заданы');
  const clause=el('div',{class:'clause'});
  if(n.neg)clause.append(el('b',{class:'not'},'НЕ '));
  if(n.items) {
    if(n.items.length>1)clause.append(el('strong',{},words[n.op]));
    clause.append(...n.items.map(describeRule));
  } else if(n.op==='event')clause.append(btn(fullEvent(n.ref),()=>eventDetail(n.ref),'link'));
  else clause.append(el('strong',{},words[n.op]),...n.refs.map((id,i)=>btn(fullState(id,n.paths?.[i]),()=>stateDetail(id,n.paths?.[i]),'link')));
  return clause;
}
function selector(items,value,change) {
  const control=el('select',{onchange:e=>change(e.target.value)},...items.map(([v,text])=>option(v,text)));
  control.value=value;return control;
}
function tick(text,checked,change) {
  return el('label',{class:'tick'},el('input',{type:'checkbox',checked,onchange:e=>change(e.target.checked)}),text);
}
function editRule(n,kind,draw,drop) {
  const shell=el('div',{class:'rulebox'});
  const head=el('div',{class:'rulehead'});
  if(n.items)head.append(selector([['and','И · все блоки'],['or','ИЛИ · любой блок']],n.op,v=>n.op=v));
  else if(kind==='conditions')head.append(selector([['any','Любой из'],['all','Все из']],n.op,v=>n.op=v));
  else head.append(el('strong',{},'Событие'));
  head.append(tick('НЕ',n.neg,v=>n.neg=v));
  if(drop)head.append(btn('Убрать',drop,'unlink'));
  shell.append(head);
  if(n.items) {
    n.items.forEach((child,i)=>shell.append(editRule(child,kind,draw,()=>{n.items.splice(i,1);draw();})));
    const add=kind==='conditions'?btn('+ Проверка',()=>{
      n.items.push({op:'any',neg:false,refs:[],paths:[]});draw();
    }):searchPicker('＋ Причина',eventChoices,({key})=>{n.items.push({op:'event',neg:false,ref:key});draw();});
    shell.append(el('div',{class:'addrow'},add,btn('+ Группа',()=>{n.items.push(newGroup());draw();})));
  }else if(kind==='causes'){
    shell.append(el('p',{},fullEvent(n.ref)),searchPicker('Сменить событие',eventChoices,({key})=>{n.ref=key;draw();}));
  }else shell.append(conditionFields(n,draw));
  return shell;
}
export function editEvent(owner,id,point=null) {
  const key=id || uid();
  const event=id?structuredClone(p.events[id]):{name:'',desc:'',owner,ownerPath:currentOwnerPath(owner),conditions:newGroup(),causes:newGroup(),effects:[]};
  event.effectPaths??=event.effects.map(()=>null);
  const original=id?outbound(id):[];
  const outgoing=new Set(original);
  // A self-reference is edited in the causes tree, just like any other inbound rule.
  const nextTargets=entries(p.events).filter(([k])=>k!==key);
  function commit() {
    if(leaves(event.conditions).some(n=>!n.refs.length || n.refs.some(key=>!key)))
      return notice('Заполните группу и выберите состояние.');
    const next=structuredClone(p);
    const draft=structuredClone(event);
    for(const n of leaves(draft.conditions))delete n.pick;
    next.events[key]=draft;
    if(!id && point)setLayerPoint(next,owner,'events',key,point);
    for(const [target] of nextTargets) {
      if(original.includes(target) && !outgoing.has(target))removeCause(next.events[target].causes,key,true);
      if(!original.includes(target) && outgoing.has(target))addCause(next.events[target],key);
    }
    save(next);
  }
  function draw() {
    const scroll=document.querySelector('dialog').scrollTop;
    const effects=el('div',{class:'effects'});
    for(const [index,state] of event.effects.entries())effects.append(el('div',{class:'effectline'},
      el('span',{},fullState(state,event.effectPaths[index])),
      btn('Убрать',()=>{event.effects.splice(index,1);event.effectPaths.splice(index,1);draw();},'unlink')));
    for(const id of outgoing) {
      if(id===key)continue;
      effects.append(el('div',{class:'effectline'},el('span',{},'Вызвать → '+fullEvent(id)),btn('Убрать',()=>{outgoing.delete(id);draw();},'unlink')));
    }
    function* availableEvents(){for(const item of eventChoices())if(item.key!==key && !outgoing.has(item.key))yield item;}
    function* ownerChoices(){yield {route:null,label:'Все размещения · '+p.entities[owner].name};for(const route of entityRoutes(p))if(route.at(-1)===owner)yield {route,label:pathLabel(p,route)};}
    const emitter=el('div',{class:'emitter'},el('small',{},'Источник события'),
      el('p',{},ownerLabel(owner,event.ownerPath)),searchPicker('Выбрать размещение',ownerChoices,({route})=>{event.ownerPath=route;draw();}));
    const form=el('form',{onsubmit:e=>{e.preventDefault();commit();}},...fields(event),emitter,
      el('h3',{},'Условия'),editRule(event.conditions,'conditions',draw),
      el('h3',{},'Причины'),editRule(event.causes,'causes',draw),
      el('h3',{},'Последствия'),effects,
      searchPicker('＋ Смена состояния',stateChoices,({key,route})=>{event.effects.push(key);event.effectPaths.push(route);draw();},stateItems),
      searchPicker('＋ Вызвать событие',availableEvents,({key})=>{outgoing.add(key);draw();}),
      footer(id?btn('Удалить событие',()=>deleteObj('events',id),'danger'):null,el('button',{class:'primary',type:'submit'},'Сохранить правило')));
    modal(id?'Редактировать событие':'Новое событие',form);
    document.querySelector('dialog').scrollTop=scroll;
  }
  draw();
}

