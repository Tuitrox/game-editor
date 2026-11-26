import {p,el,btn,option,label,entries,uid,modal,fields,footer,save,deleteObj,outbound,eventDetail,stateDetail,notice,setLayerPoint} from './app.js';

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
const fullState=id=>p.entities[p.states[id].owner].name+' / '+p.states[id].name;
const fullEvent=id=>p.entities[p.events[id].owner].name+' / '+p.events[id].name;

export function describeRule(n) {
  if(n.items && !n.items.length)return el('p',{class:'empty'},'Не заданы');
  const clause=el('div',{class:'clause'});
  if(n.neg)clause.append(el('b',{class:'not'},'НЕ '));
  if(n.items) {
    if(n.items.length>1)clause.append(el('strong',{},words[n.op]));
    clause.append(...n.items.map(describeRule));
  } else if(n.op==='event')clause.append(btn(fullEvent(n.ref),()=>eventDetail(n.ref),'link'));
  else clause.append(el('strong',{},words[n.op]),...n.refs.map(id=>btn(fullState(id),()=>stateDetail(id),'link')));
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
    shell.append(el('div',{class:'addrow'},btn(kind==='conditions'?'+ Проверка':'+ Причина',()=>{
      if(kind==='conditions'&&!entries(p.states).length)return notice('Сначала добавьте состояние сущности.');
      if(kind==='causes'&&!entries(p.events).length)return notice('Сначала сохраните первое событие.');
      n.items.push(kind==='conditions'?{op:'any',neg:false,refs:[Object.keys(p.states)[0]]}:{op:'event',neg:false,ref:Object.keys(p.events)[0]});draw();
    }),btn('+ Группа',()=>{n.items.push(newGroup());draw();})));
  } else if(kind==='causes')shell.append(selector(entries(p.events).map(([id])=>[id,fullEvent(id)]),n.ref,v=>n.ref=v));
  else {
    const known=entries(p.states);
    const current=n.refs.map(i=>p.states[i].name);
    const name=n.pick ?? current[0] ?? known[0]?.[1].name;
    const names=[...new Set(known.map(([,s])=>s.name))];
    shell.append(label('Состояние',selector(names.map(v=>[v,v]),name,v=>{n.pick=v;n.refs=[];draw();})));
    const list=el('div',{class:'checks'});
    for(const [id,s] of known.filter(([id,s])=>s.name===name || n.refs.includes(id))) {
      list.append(tick(p.entities[s.owner].name+(s.name===name?'':' / '+s.name),n.refs.includes(id),checked=>{
        n.refs=n.refs.filter(ref=>ref!==id && (!checked||p.states[ref].owner!==s.owner));
        if(checked)n.refs.push(id);draw();
      }));
    }
    shell.append(label('Сущности для проверки',list));
  }
  return shell;
}
export function editEvent(owner,id,point=null) {
  const key=id || uid();
  const event=id?structuredClone(p.events[id]):{name:'',desc:'',owner,conditions:newGroup(),causes:newGroup(),effects:[]};
  const original=id?outbound(id):[];
  const outgoing=new Set(original);
  // A self-reference is edited in the causes tree, just like any other inbound rule.
  const nextTargets=entries(p.events).filter(([k])=>k!==key);
  function commit() {
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
    for(const [index,id] of event.effects.entries())effects.append(el('div',{class:'effectline'},
      selector(entries(p.states).map(([s])=>[s,fullState(s)]),id,v=>event.effects[index]=v),
      btn('Убрать',()=>{event.effects.splice(index,1);draw();},'unlink')));
    for(const id of outgoing) {
      if(id===key)continue;
      effects.append(el('div',{class:'effectline'},el('span',{},'Вызвать → '+fullEvent(id)),btn('Убрать',()=>{outgoing.delete(id);draw();},'unlink')));
    }
    const available=nextTargets.filter(([k])=>!outgoing.has(k));
    const choose=selector(available.map(([k])=>[k,fullEvent(k)]),available[0]?.[0],()=>{});
    const addState=btn('+ Смена состояния',()=>{
      const state=Object.keys(p.states)[0];if(!state)return notice('Сначала добавьте состояние сущности.');
      event.effects.push(state);draw();
    });
    const form=el('form',{onsubmit:e=>{e.preventDefault();commit();}},...fields(event),
      el('h3',{},'Условия'),editRule(event.conditions,'conditions',draw),
      el('h3',{},'Причины'),editRule(event.causes,'causes',draw),
      el('h3',{},'Последствия'),effects,el('div',{class:'addrow'},addState),
      available.length?label('Породить событие',el('div',{class:'effectline'},choose,btn('Добавить',()=>{outgoing.add(choose.value);draw();}))):null,
      footer(id?btn('Удалить событие',()=>deleteObj('events',id),'danger'):null,el('button',{class:'primary',type:'submit'},'Сохранить правило')));
    modal(id?'Редактировать событие':'Новое событие',form);
    document.querySelector('dialog').scrollTop=scroll;
  }
  draw();
}

