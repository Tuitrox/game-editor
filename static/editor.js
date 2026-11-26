import {p,el,btn,option,label,entries,uid,modal,fields,footer,save,deleteObj,outbound,eventDetail,stateDetail,notice,setLayerPoint,currentOwnerPath} from './app.js';

import {pathLabel} from './routes.js';

export const newGroup = ()=>({op:'and',neg:false,items:[]});
export const leaves = n => n.items ? n.items.flatMap(leaves) : [n];

export function triggers(node, negative=false) {
  const negated = (negative !== node.neg) !== (node.op==='not');
  if(node.items)return node.items.flatMap(child=>triggers(child,negated));
  return negated ? [] : [node.ref];
}
export function removeCause(node,id,positiveOnly=false,negative=false) {
  const negated=(negative !== node.neg) !== (node.op==='not');
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
const words={and:'И',or:'ИЛИ',not:'НЕ',all:'Все из',any:'Любой из',self:'Источник события'};
const ownerLabel=(owner,route)=>route?pathLabel(p,route):p.entities[owner].name+' (общая сущность)';
export const fullState=(id,route)=>ownerLabel(p.states[id].owner,route)+' → '+p.states[id].name;
export const fullEvent=id=>ownerLabel(p.events[id].owner,p.events[id].ownerPath)+' / '+p.events[id].name;

function eventPicker(caption,onPick,allowed=()=>true,open=false){
  return visualTree(caption,{multiple:false,eligible:()=>false,eventFilter:allowed,open,
    apply:(_route,id)=>onPick(id)});
}
function statesOf(owner){return entries(p.states).filter(([,s])=>s.owner===owner);}
function visualTree(caption,{initial=[],eligible,apply,multiple=true,stateMode=false,eventFilter=null,open=false}){
  const wrap=el('div',{class:'visual-picker'});
  const launch=btn(caption,()=>{
    if(wrap.querySelector('.tree-panel'))return;
    const selected=new Map(initial.filter(Boolean).map(route=>[route.join('/'),route]));
    const search=el('input',{type:'search',placeholder:eventFilter?'Название события или сущности…':stateMode?'Название сущности или состояния…':'Найти сущность по названию…',ariaLabel:'Подсветить совпадения'});
    const folders=new Map();
    const eventsByOwner=new Map();
    if(eventFilter)for(const [id,event] of entries(p.events)){
      if(!eventFilter(id))continue;
      if(!eventsByOwner.has(event.owner))eventsByOwner.set(event.owner,[]);
      eventsByOwner.get(event.owner).push([id,event]);
    }
    const records=[], count=el('small',{ariaLive:'polite'});
    function record(title,ancestors,addr){
      const label=el('span',{},title);
      const context=ancestors.map(key=>p.entities[key.split('/').at(-1)].name).concat(title).join(' ').toLocaleLowerCase();
      records.push({label,title,ancestors,addr,context});return label;
    }
    function branch(route,ancestors=[]){
      const key=route.at(-1),entity=p.entities[key],addr=route.join('/');
      const name=record(entity.name,ancestors,addr),allowed=eligible(route);
      let row;
      if(multiple && allowed){
        const check=el('input',{type:'checkbox',checked:selected.has(addr),
          onchange:e=>{if(e.target.checked)selected.set(addr,route);else selected.delete(addr);}});
        row=el('label',{class:'tree-node',title:pathLabel(p,route)},check,name);
      }else if(!multiple && allowed && !stateMode && !eventFilter){
        row=btn('',()=>apply(route),'tree-node');row.append(name);
      }else row=el('span',{class:'tree-node'},name);
      const contents=el('div',{class:'tree-contents'}),trail=[...ancestors,addr];
      if(stateMode)for(const [id,s] of statesOf(key)){
        const pick=btn('',()=>apply(route,id),'tree-state');pick.append('→ ',record(s.name,trail));contents.append(pick);
      }
      for(const [id,event] of eventsByOwner.get(key) || []){
        if(event.ownerPath && !addr.endsWith('/'+event.ownerPath.join('/')) && addr!==event.ownerPath.join('/'))continue;
        const pick=btn('',()=>apply(route,id),'tree-state');pick.append('↳ ',record(event.name,trail));contents.append(pick);
      }
      if(entity.children.length)contents.append(el('ul',{},entity.children.map(child=>branch([...route,child],trail))));
      const line=el('div',{class:'tree-line'});
      if(contents.childElementCount){
        const folder={manual:true,show(expanded){
          contents.hidden=!expanded;toggle.textContent=expanded?'−':'+';
          toggle.setAttribute('aria-expanded',String(expanded));
          toggle.setAttribute('aria-label',(expanded?'Свернуть ':'Развернуть ')+entity.name);
        }};
        const toggle=btn('',()=>{
          const expanded=contents.hidden;
          if(!search.value.trim())folder.manual=expanded;
          folder.show(expanded);
        },'tree-toggle');
        folders.set(addr,folder);folder.show(true);line.append(toggle);
      }else line.append(el('span',{class:'toggle-space'}));
      line.append(row);return el('li',{},line,contents);
    }
    const nested=new Set(Object.values(p.entities).flatMap(e=>e.children));
    const roots=Object.keys(p.entities).filter(id=>!nested.has(id));
    const tree=el('ul',{class:'project-tree'},roots.map(id=>branch([id])));
    function highlight(){
      const query=search.value.trim().toLocaleLowerCase();let matches=0;
      const reveal=new Set();
      const terms=query.split(/\s+/).filter(Boolean);
      for(const {label,title,ancestors,addr,context} of records){
        const name=title.toLocaleLowerCase();
        const term=terms.find(word=>name.includes(word));
        if(!term || !terms.every(word=>context.includes(word))){label.textContent=title;continue;}
        ancestors.forEach(key=>reveal.add(key));if(addr)reveal.add(addr);
        const ix=name.indexOf(term);
        matches++;label.replaceChildren(title.slice(0,ix),el('mark',{},title.slice(ix,ix+term.length)),title.slice(ix+term.length));
      }
      for(const [key,folder] of folders)folder.show(folder.manual || (Boolean(query) && reveal.has(key)));
      count.textContent=query?'Совпадений '+matches:'';
    }
    search.oninput=highlight;
    search.onkeydown=e=>{if(e.key==='Enter')e.preventDefault();};
    const panel=el('section',{class:'tree-panel'},search,count,tree,
      el('div',{class:'addrow'},multiple?btn('Применить выбор',()=>apply([...selected.values()]),'primary'):null,
        btn('Закрыть',()=>{panel.remove();launch.hidden=false;launch.focus();})));
    wrap.append(panel);launch.hidden=true;queueMicrotask(()=>{if(search.isConnected)search.focus();});
  },'pick-trigger');
  wrap.append(launch);if(open)launch.click();return wrap;
}
function conditionFields(node,draw){
  const refs=node.refs, paths=node.paths??=refs.map(()=>null);
  const ownerAt=i=>paths[i]?.at(-1) ?? p.states[refs[i]].owner;
  const group=el('div',{class:'condition-members'});
  refs.forEach((key,i)=>{
    group.append(el('div',{class:'effectline'},el('span',{},ownerLabel(ownerAt(i),paths[i])+' → '+(p.states[key]?.name || 'Выберите состояние')),
      btn('Убрать',()=>{refs.splice(i,1);paths.splice(i,1);draw();},'unlink')));
  });
  group.append(visualTree('Выбрать сущности на дереве',{
    initial:paths,eligible:route=>statesOf(route.at(-1)).length>0,
    apply:routes=>{
      const old=new Map(paths.map((route,i)=>[route?.join('/'),refs[i]]));
      const common=refs.length && refs.every(key=>p.states[key]?.name===p.states[refs[0]]?.name)?p.states[refs[0]]?.name:null;
      const legacy=refs.filter((_,i)=>!paths[i]);
      node.paths=[...legacy.map(()=>null),...routes];
      node.refs=[...legacy,...routes.map(route=>old.get(route.join('/')) ||
        statesOf(route.at(-1)).find(([,s])=>s.name===common)?.[0] || '')];
      draw();
    }
  }));
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
export function describeRule(n,event) {
  if(n.items && !n.items.length)return el('p',{class:'empty'},'Не заданы');
  const clause=el('div',{class:'clause'});
  if(n.neg)clause.append(el('b',{class:'not'},'НЕ '));
  if(n.items) {
    if(n.items.length>1 || n.op==='not')clause.append(el('strong',{},words[n.op]));
    clause.append(...n.items.map(child=>describeRule(child,event)));
  } else if(n.op==='event')clause.append(btn(fullEvent(n.ref),()=>eventDetail(n.ref),'link'));
  else if(n.op==='self')clause.append(ownerLabel(event.owner,event.ownerPath)+' → '+(p.states[n.refs[0]]?.name || 'Любое состояние'));
  else clause.append(el('strong',{},words[n.op]),...n.refs.map((id,i)=>btn(fullState(id,n.paths?.[i]),()=>stateDetail(id,n.paths?.[i]),'link')));
  return clause;
}
function selector(items,value,change) {
  const control=el('select',{onchange:e=>change(e.target.value)},...items.map(([v,text])=>option(v,text)));
  control.value=value;return control;
}
function normalizeNegations(node){
  const clean={...node,neg:false};
  if(node.items)clean.items=node.items.map(normalizeNegations);
  return node.neg?{op:'not',neg:false,items:[clean]}:clean;
}
function ruleBoard(root,kind,event,draw){
  let dragging=null;
  function contains(node,target){return node===target || node.items?.some(child=>contains(child,target));}
  function slot(parent,index){
    const locked=parent.op==='not' && parent.items.length>0;
    const caption=kind==='causes'?'Выбрать событие-причину':'Выбрать условие';
    const zone=el('div',{class:'rule-slot'+(locked?' drop-only':'')});
    function insert(child){
      parent.items.splice(index,0,child);draw();
    }
    if(!locked)zone.append(btn(caption,()=>{
      board.querySelector('.slot-chooser')?.remove();
      const panel=el('div',{class:'slot-chooser'});
      zone.after(panel);
      if(kind==='causes'){
        panel.append(eventPicker(caption,id=>insert({op:'event',neg:false,ref:id}),()=>true,true));
      }else if(event.scope==='local'){
        const pick=ref=>insert({op:'self',neg:false,refs:ref?[ref]:[],paths:ref?[event.ownerPath]:[]});
        panel.append(el('small',{},ownerLabel(event.owner,event.ownerPath)),
          btn('Любое состояние',()=>pick(null),'choice'),
          ...statesOf(event.owner).map(([id,s])=>btn(s.name,()=>pick(id),'choice')));
      }else{
        const mode=selector([['all','Все из'],['any','Любой из']],'all',()=>{});
        panel.append(mode,visualTree(caption,{open:true,eligible:r=>statesOf(r.at(-1)).length>0,
          apply:routes=>{
            if(!routes.length)return notice('Выберите сущность для проверки.');
            insert({op:mode.value,neg:false,refs:routes.map(()=>''),paths:routes});
          }}));
      }
    },'slot-label'));
    function accepts(){
      if(!dragging || contains(dragging.node,parent))return false;
      return parent.op!=='not' || !parent.items.length || dragging.parent===parent;
    }
    zone.ondragover=e=>{if(accepts()){e.preventDefault();e.dataTransfer.dropEffect='move';zone.classList.add('target');}};
    zone.ondragleave=()=>zone.classList.remove('target');
    zone.ondrop=e=>{
      if(!accepts())return;
      e.preventDefault();e.stopPropagation();
      const {node,parent:source}=dragging, from=source.items.indexOf(node);
      if(from<0)return;
      source.items.splice(from,1);
      parent.items.splice(source===parent && from<index?index-1:index,0,node);draw();
    };
    return zone;
  }
  function block(node,parent){
    const shell=el('section',{class:'logic-block '+(node.items?'logic-group logic-'+node.op:'logic-leaf')});
    const head=el('div',{class:'rulehead'});shell.append(head);
    if(parent){
      const handle=el('span',{draggable:true,class:'logic-handle',title:'Перетащить блок'},'⠿');
      handle.ondragstart=e=>{
        dragging={node,parent};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','rule');
        e.dataTransfer.setDragImage(shell,10,10);shell.classList.add('lifted');board.classList.add('sorting');
      };
      handle.ondragend=()=>{dragging=null;shell.classList.remove('lifted');board.classList.remove('sorting');
        board.querySelectorAll('.target').forEach(x=>x.classList.remove('target'));};
      head.append(handle);
    }
    if(node.items && node.op!=='not')head.append(selector([['and','И'],['or','ИЛИ']],node.op,v=>{node.op=v;draw();}));
    else if(node.items)head.append(el('strong',{},'НЕ'));
    else if(kind==='conditions' && node.op!=='self')
      head.append(selector([['all','Все из'],['any','Любой из']],node.op,v=>node.op=v));
    else head.append(el('strong',{},kind==='causes'?'Событие':'Состояние источника'));
    if(parent)head.append(btn('Убрать',()=>{parent.items.splice(parent.items.indexOf(node),1);draw();},'unlink'));
    if(node.items){
      node.items.forEach((child,i)=>shell.append(slot(node,i),block(child,node)));
      shell.append(slot(node,node.items.length));
      if(node.op==='not' && node.items.length)return shell;
      const append=child=>{node.items.push(child);draw();};
      shell.append(el('div',{class:'addrow'},...['and','or','not'].map(op=>btn('+ '+words[op],()=>append({op,neg:false,items:[]})))));
    }else if(kind==='causes'){
      shell.append(el('p',{},fullEvent(node.ref)),eventPicker('Сменить событие',id=>{node.ref=id;draw();}));
    }else if(node.op==='self'){
      const options=statesOf(event.owner).map(([id,s])=>[id,s.name]);
      shell.append(el('p',{},ownerLabel(event.owner,event.ownerPath)),selector([['','Любое состояние'],...options],node.refs[0] || '',v=>{
        node.refs=v?[v]:[];node.paths=v?[event.ownerPath]:[];
      }));
    }else shell.append(conditionFields(node,draw));
    return shell;
  }
  const board=el('div',{class:'logic-board'});
  board.append(block(root,null));return board;
}
export function editEvent(owner,id,point=null,scope='local') {
  const key=id || uid();
  const event=id?structuredClone(p.events[id]):{name:'',desc:'',owner,scope,ownerPath:scope==='local'?currentOwnerPath(owner):null,conditions:newGroup(),causes:newGroup(),effects:[]};
  if(!id && scope==='local')event.conditions.items.push({op:'self',neg:false,refs:[],paths:[]});
  for(const field of ['conditions','causes']){
    const normalized=normalizeNegations(event[field]);
    event[field]=normalized.op==='not'?{...newGroup(),items:[normalized]}:normalized;
  }
  event.effectPaths??=event.effects.map(()=>null);
  const original=id?outbound(id):[];
  const outgoing=new Set(original);
  // A self-reference is edited in the causes tree, just like any other inbound rule.
  const nextTargets=entries(p.events).filter(([k])=>k!==key);
  function commit() {
    if(leaves(event.conditions).some(n=>n.op!=='self' && (!n.refs.length || n.refs.some(key=>!key))))
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

    const emitter=event.scope==='global'?el('strong',{},'Глобальное событие'):
      el('div',{class:'emitter'},el('small',{},'Источник события'),el('p',{},ownerLabel(owner,event.ownerPath)));
    const form=el('form',{onsubmit:e=>{e.preventDefault();commit();}},...fields(event),emitter,
      el('h3',{},'Условия'),ruleBoard(event.conditions,'conditions',event,draw),
      el('h3',{},'Причины'),ruleBoard(event.causes,'causes',event,draw),
      el('h3',{},'Последствия'),effects,
      visualTree('＋ Смена состояния',{multiple:false,stateMode:true,eligible:()=>true,apply:(route,key)=>{event.effects.push(key);event.effectPaths.push(route);draw();}}),
      eventPicker('＋ Вызвать событие',id=>{outgoing.add(id);draw();},id=>id!==key && !outgoing.has(id)),
      footer(id?btn('Удалить событие',()=>deleteObj('events',id),'danger'):null,el('button',{class:'primary',type:'submit'},'Сохранить правило')));
    modal(id?'Редактировать событие':'Новое событие',form);
    document.querySelector('dialog').scrollTop=scroll;
  }
  draw();
}

