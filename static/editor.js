import {p,el,btn,option,label,entries,uid,modal,fields,footer,save,deleteObj,outbound,eventDetail,stateDetail,notice,currentOwnerPath} from './app.js';

import {pathLabel} from './routes.js';
import {parameterTypes, parameterTest, comparisons, changeDirections, changeText} from './parameters.js';

export const newGroup = ()=>({op:'and',neg:false,items:[]});
export const leaves = n => n.items ? n.items.flatMap(leaves) : [n];
export const parameterRefs = e => [...leaves(e.conditions).filter(n=>n.op==='parameter'),
  ...leaves(e.causes).filter(n=>n.op==='change'),...(e.parameterEffects || [])];

export function triggers(node, negative=false) {
  const negated = (negative !== node.neg) !== (node.op==='not');
  if(node.items)return node.items.flatMap(child=>triggers(child,negated));
  return !negated && node.op==='event' ? [node.ref] : [];
}
export function removeCause(node,id,positiveOnly=false,negative=false) {
  const negated=(negative !== node.neg) !== (node.op==='not');
  for(const child of node.items) if(child.items) removeCause(child,id,positiveOnly,negated);
  node.items=node.items.filter(child=>child.items?child.items.length:
    child.op!=='event' || child.ref!==id || (positiveOnly && (negated !== child.neg)));
}
function addCause(target,id) {
  const group=target.causes, leaf={op:'event',neg:false,ref:id};
  if(!group.items.length) target.causes={...newGroup(),items:[leaf]};
  else if(group.op==='or' && !group.neg)group.items.push(leaf);
  else target.causes={op:'or',neg:false,items:[group,leaf]};
}
const words={and:'И',or:'ИЛИ',not:'НЕ',all:'Все из',any:'Любой из'};
const ownerLabel=(owner,route)=>route?pathLabel(p,route):p.entities[owner].name;
const stateOwnerLabel=(owner,route)=>route?.length?pathLabel(p,route.filter(id=>id!=='root')) || 'Проект':owner==='root'?'Проект':p.entities[owner].name;
export const fullState=(id,route)=>stateOwnerLabel(p.states[id].owner,route)+' → '+p.states[id].name;
export const fullEvent=id=>{
  const event=p.events[id];
  return (event.scope==='global'?'Глобальное событие':ownerLabel(event.owner,event.ownerPath))+' / '+event.name;
};

function eventPicker(caption,onPick,allowed=()=>true,open=false){
  return visualTree(caption,{multiple:false,eligible:()=>false,eventFilter:allowed,open,
    apply:(_route,id)=>onPick(id)});
}
function statesOf(owner){return entries(p.states).filter(([,s])=>s.owner===owner);}
function visualTree(caption,{initial=[],eligible,apply,multiple=true,stateMode=false,parameterMode=false,eventFilter=null,open=false}){
  const wrap=el('div',{class:'visual-picker'});
  const launch=btn(caption,()=>{
    if(wrap.querySelector('.tree-panel'))return;
    const selected=new Map(initial.filter(Boolean).map(route=>[route.join('/'),route]));
    const search=el('input',{type:'search',placeholder:eventFilter?'Название события или сущности…':parameterMode?'Название сущности или параметра…':stateMode?'Название сущности или состояния…':'Найти сущность по названию…',ariaLabel:'Подсветить совпадения'});
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
      if(stateMode || parameterMode)for(const [id,s] of parameterMode?entries(entity.parameters || {}):statesOf(key)){
        if(parameterMode==='number' && (s.type || 'number')!=='number')continue;
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
    if(parameterMode==='number' && !tree.querySelector('.tree-state')){
      wrap.replaceChildren(el('p',{class:'empty'},'В проекте пока нет числовых параметров. Добавьте параметр типа «Число» на холсте сущности.'));
      return;
    }
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
function removeButton(caption,action){
  return el('button',{type:'button',class:'unlink rule-remove',title:caption,ariaLabel:caption,onclick:action},'×');
}
function conditionMembers(node){
  const members=node.refs.map((id,i)=>{
    const route=node.paths?.[i], owner=route?.at(-1) ?? p.states[id].owner;
    return {owner,name:p.entities[owner].name,route,state:p.states[id]?.name,
      parents:route?.slice(0,-1).filter(key=>key!=='root').map(key=>p.entities[key].name) ?? []};
  });
  for(const member of members){
    if(!member.route)continue;
    const peers=members.filter(other=>other!==member && other.name===member.name && other.route);
    const parents=member.parents;
    let depth=1;
    while(depth<parents.length && peers.some(other=>other.parents.slice(-depth).join(' › ')===parents.slice(-depth).join(' › ')))depth++;
    member.place=parents.slice(-depth).join(' › ');
  }
  return members;
}
function conditionFields(node,draw){
  const refs=node.refs, paths=node.paths??=refs.map(()=>null);
  const ownerAt=i=>paths[i]?.at(-1) ?? p.states[refs[i]].owner;
  const group=el('div',{class:'condition-members'});
  const members=conditionMembers(node);
  const sameOwner=members.length>0 && members.every(m=>m.owner===members[0].owner && m.place);
  const mixedStates=new Set(members.map(m=>m.state)).size>1;
  if(sameOwner)group.append(el('strong',{},members[0].name));
  const chips=el('div',{class:'member-chips'});
  members.forEach((m,i)=>{
    const place=sameOwner?m.place:[m.place,m.name].filter(Boolean).join(' › ');
    const title=ownerLabel(m.owner,m.route);
    chips.append(el('span',{class:'member-chip',title},place+(mixedStates?' → '+(m.state || 'Выберите состояние'):''),
      removeButton('Убрать '+title,()=>{refs.splice(i,1);paths.splice(i,1);draw();})));
  });
  group.append(chips,visualTree(members.length?'Изменить выбор':'Выбрать сущности',{
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
    const stateSelect=selector([['','Выберите состояние'],...names.map(v=>[v,v])],selected,v=>{
      if(v){node.refs=options.map(row=>row.find(([,s])=>s.name===v)[0]);draw();}
    });
    stateSelect.ariaLabel='Состояние для всей группы';
    group.append(el('label',{class:'member-state'},'Состояние',stateSelect));
    if(!names.length)group.append(el('small',{},'У выбранных сущностей нет общего названия состояния. Используйте отдельную проверку для другой группы.'));
  }
  return group;
}
function ruleGroup(op,children){
  if(!children.length)return el('p',{class:'empty'},'Не заданы');
  if(children.length===1 && op!=='not')return children[0];
  return el('div',{class:'read-group tone-'+op},
    el('div',{class:'operator-rail'},el('strong',{},words[op])),
    el('div',{class:'rule-children'},children));
}
export function ruleReference(kind,id,route,place){
  const isEvent=kind==='event', obj=isEvent?p.events[id]:p.states[id];
  if(isEvent)route=obj.ownerPath;
  const owner=place ?? (isEvent?ownerLabel(obj.owner,route?.slice(-2)):stateOwnerLabel(obj.owner,route?.slice(-2)));
  const caption=isEvent?(obj.scope==='global'?obj.name:owner+' / '+obj.name):owner+' → '+obj.name;
  const title=isEvent?fullEvent(id):fullState(id,route);
  return el('button',{type:'button',class:'rule-ref ref-'+kind,title,ariaLabel:title,
    onclick:()=>isEvent?eventDetail(id):stateDetail(id,route)},caption);
}
export function describeRule(n,event) {
  if(n.neg)return ruleGroup('not',[describeRule({...n,neg:false},event)]);
  if(n.items)return ruleGroup(n.op,n.items.map(child=>describeRule(child,event)));
  if(n.op==='event')return ruleReference('event',n.ref);
  if(n.op==='change')return changeReference(n);
  if(n.op==='parameter')return el('span',{class:'rule-ref ref-parameter'},ownerLabel(n.owner,n.path)+' → '+parameterTest(p,n));
  if(n.op==='self')return n.refs.length?ruleReference('state',n.refs[0],event.ownerPath):
    el('span',{class:'rule-ref ref-state'},p.entities[event.owner].name+' → Любое состояние');
  return ruleGroup(n.op,conditionMembers(n).map((m,i)=>ruleReference('state',n.refs[i],m.route,
    [m.route && m.place,m.name].filter(Boolean).join(' › '))));
}
function selector(items,value,change) {
  const control=el('select',{onchange:e=>change(e.target.value)},...items.map(([v,text])=>option(v,text)));
  control.value=value;return control;
}
function normalizeNegations(node){
  if(!node.items)return node;
  const clean={...node,neg:false};
  clean.items=node.items.map(normalizeNegations);
  if(node.op==='not' && clean.items.length===1 && !clean.items[0].items){
    const child=clean.items[0];
    return {...child,neg:node.neg?child.neg:!child.neg};
  }
  return node.neg?{op:'not',neg:false,items:[clean]}:clean;
}
export function changeReference(node){
  return el('span',{class:'rule-ref ref-parameter'},ownerLabel(node.owner,node.path)+' → '+changeText(p,node));
}
function changePicker(caption,apply,open=false){
  return visualTree(caption,{multiple:false,eligible:()=>false,parameterMode:'number',open,
    apply:(path,ref)=>apply({owner:path.at(-1),path,ref})});
}
function changeFields(change,draw){
  const direction=selector(entries(changeDirections),change.direction,v=>{change.direction=v;});
  direction.ariaLabel='Направление изменения';
  return el('div',{},el('p',{class:'rule-ref ref-parameter'},ownerLabel(change.owner,change.path)+' → '+p.entities[change.owner].parameters[change.ref].name),
    direction,changePicker('Сменить параметр',target=>{Object.assign(change,target);draw();}));
}
function parameterFields(node){
  const param=p.entities[node.owner].parameters[node.ref], type=param.type || 'number';
  const fields=el('div',{class:'parameter-check'});
  if(type==='number'){
    const compare=selector(entries(comparisons),node.compare,v=>{node.compare=v;});
    compare.ariaLabel='Сравнение';
    const percent=el('input',{type:'number',min:0,max:100,step:'any',required:true,
      value:node.value==='constant'?'':node.value,ariaLabel:'Процент от максимума',
      oninput:()=>{node.value=percent.value===''?null:percent.valueAsNumber;}});
    function setThreshold(mode){
      const constant=mode==='constant';
      percent.hidden=percent.disabled=constant;
      if(constant)node.value='constant';
      else node.value=percent.value===''?null:percent.valueAsNumber;
    }
    const mode=node.value==='constant'?'constant':'percent';
    const threshold=selector([['percent','% от максимума'],['constant','Константа']],mode,setThreshold);
    threshold.ariaLabel='Тип порога';
    setThreshold(mode);
    fields.append(compare,percent,threshold);
  }else if(type==='boolean'){
    const choice=selector([['true','Да'],['false','Нет']],String(node.value),v=>{node.value=v==='true';});
    choice.ariaLabel='Проверяемое значение';fields.append(choice);
  }else fields.append(el('span',{},'Равно'),el('input',{type:'text',value:node.value,ariaLabel:'Точный текст',
    oninput:e=>{node.value=e.target.value;}}));
  return el('div',{},el('p',{class:'rule-ref ref-parameter'},ownerLabel(node.owner,node.path)+' → '+param.name),fields);
}
function ruleBoard(root,kind,event,draw){
  let dragging=null;
  function contains(node,target){return node===target || node.items?.some(child=>contains(child,target));}
  function pickParameter(panel,apply){
    if(event.scope==='local'){
      const params=entries(p.entities[event.owner].parameters || {});
      panel.append(el('small',{},ownerLabel(event.owner,event.ownerPath)));
      if(params.length)panel.append(...params.map(([id,param])=>
        btn(param.name,()=>apply(event.owner,id,event.ownerPath),'choice')));
      else panel.append(el('p',{class:'empty'},'У этой сущности пока нет параметров. Добавьте параметр на её холсте во вкладке «Сущности».'));
    }else if(Object.values(p.entities).some(entity=>Object.keys(entity.parameters || {}).length)){
      panel.append(visualTree('Выбрать параметр',{multiple:false,parameterMode:true,eligible:()=>false,open:true,
        apply:(route,id)=>apply(route.at(-1),id,route)}));
    }else panel.append(el('p',{class:'empty'},'В проекте пока нет параметров. Добавьте параметр нужной сущности во вкладке «Сущности».'));
  }
  function setParameter(node,owner,ref,path){
    const type=p.entities[owner].parameters[ref].type || 'number';
    if(!node.ref || type!==(p.entities[node.owner].parameters[node.ref].type || 'number')){
      node.compare='eq';
      node.value=type==='number'?null:type==='boolean'?true:'';
    }
    Object.assign(node,{owner,ref,path});
  }
  function addLeaf(parent,leafType){
    const caption={event:'Выбрать событие-причину',state:'Выбрать состояние',parameter:'Выбрать параметр',change:'Выбрать изменение параметра'}[leafType];
    function insert(child){
      parent.items.push(child);draw();
    }
    return el('button',{type:'button',class:'add-leaf',title:caption,ariaLabel:caption,onclick:e=>{
      board.querySelector('.slot-chooser')?.remove();
      const panel=el('div',{class:'slot-chooser'});
      e.currentTarget.parentElement.after(panel);
      if(leafType==='event'){
        panel.append(eventPicker(caption,id=>insert({op:'event',neg:false,ref:id}),()=>true,true));
      }else if(leafType==='change'){
        panel.append(changePicker(caption,target=>insert({op:'change',neg:false,direction:'up',...target}),true));
      }else if(leafType==='parameter'){
        pickParameter(panel,(owner,ref,path)=>{
          const child={op:'parameter',neg:false};
          setParameter(child,owner,ref,path);insert(child);
        });
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
    }},{event:'+ Событие',state:'+ Состояние',parameter:'+ Параметр',change:'+ Параметр'}[leafType]);
  }
  function slot(parent,index){
    const zone=el('div',{class:'rule-slot drop-only'});
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
      shell.classList.add('movable-rule');
      shell.ondragstart=e=>{
        if(e.target!==shell)return;
        e.stopPropagation();
        dragging={node,parent};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','rule');
        e.dataTransfer.setDragImage(shell,10,10);shell.classList.add('lifted');board.classList.add('sorting');
      };
      shell.ondragend=e=>{if(e.target!==shell)return;
        dragging=null;shell.draggable=false;shell.classList.remove('lifted');board.classList.remove('sorting');
        board.querySelectorAll('.target').forEach(x=>x.classList.remove('target'));};
    }
    if(node.items){
      const operator=node.op==='not'?el('strong',{},'НЕ'):
        selector([['and','И'],['or','ИЛИ']],node.op,v=>{node.op=v;draw();});
      shell.classList.add('edit-group','tone-'+node.op);
      if(node.items.length<2 && node.op!=='not')shell.classList.add('single-rule');
      shell.prepend(el('div',{class:'operator-rail'},operator));
    }
    else if(node.op==='change')head.append(el('strong',{},'Изменение параметра'));
    else if(node.op==='parameter')head.append(el('strong',{},'Параметр · '+parameterTypes[p.entities[node.owner].parameters[node.ref].type || 'number']));
    else if(kind==='conditions' && node.op!=='self'){
      shell.classList.add('tone-'+node.op);
      head.append(selector([['all','Все из'],['any','Любой из']],node.op,v=>{node.op=v;draw();}));
    }
    else head.append(el('strong',{},kind==='causes'?'Событие':'Состояние'));
    if(!node.items){
      const toggle=btn('НЕ',()=>{node.neg=!node.neg;draw();},'toggle-negation');
      toggle.setAttribute('aria-pressed',String(node.neg));
      toggle.title=node.neg?'Снять отрицание':'Добавить отрицание';
      head.append(toggle);
    }
    if(parent)head.append(removeButton('Убрать блок',()=>{parent.items.splice(parent.items.indexOf(node),1);draw();}));
    if(node.items){
      node.items.forEach((child,i)=>shell.append(slot(node,i),block(child,node)));
      shell.append(slot(node,node.items.length));
      if(node.op==='not' && node.items.length)return shell;
      const append=child=>{node.items.push(child);draw();};
      const leafTypes=kind==='causes'?['event','change']:['state','parameter'];
      shell.append(el('div',{class:'addrow'},...leafTypes.map(type=>addLeaf(node,type)),...['and','or','not'].map(op=>btn('+ '+words[op],()=>append({op,neg:false,items:[]})))));
    }else if(node.op==='change')shell.append(changeFields(node,draw));
    else if(kind==='causes'){
      shell.append(el('p',{class:'rule-ref ref-event'},fullEvent(node.ref)),eventPicker('Сменить событие',id=>{node.ref=id;draw();}));
    }else if(node.op==='parameter'){
      shell.append(parameterFields(node),btn('Сменить параметр',()=>{
        board.querySelector('.slot-chooser')?.remove();
        const panel=el('div',{class:'slot-chooser'});shell.append(panel);
        pickParameter(panel,(owner,ref,path)=>{setParameter(node,owner,ref,path);draw();});
      }));
    }
    else if(node.op==='self'){
      const options=statesOf(event.owner).map(([id,s])=>[id,s.name]);
      shell.append(el('p',{},ownerLabel(event.owner,event.ownerPath)),selector([['','Любое состояние'],...options],node.refs[0] || '',v=>{
        node.refs=v?[v]:[];node.paths=v?[event.ownerPath]:[];
      }));
    }else shell.append(conditionFields(node,draw));
    return shell;
  }
  const board=el('div',{class:'logic-board'});
  board.onpointerdown=e=>{
    const previous=board.querySelector('[draggable="true"]');
    if(previous)previous.draggable=false;
    if(!e.isPrimary || e.button!==0 || e.target.closest('button,input,select,textarea,label,summary,.slot-chooser,.visual-picker'))return;
    const shell=e.target.closest('.logic-block');
    if(shell?.classList.contains('movable-rule'))shell.draggable=true;
  };
  board.append(block(root,null));return board;
}
export function editEvent(owner,id=null,scope='local') {
  const key=id || uid();
  const event=id?structuredClone(p.events[id]):{name:'',desc:'',owner,scope,ownerPath:scope==='local'?currentOwnerPath(owner):null,conditions:newGroup(),causes:newGroup(),effects:[]};
  event.effectPaths??=event.effects.map(()=>null);
  const original=id?outbound(id):[];
  const outgoing=new Set(original);
  // A self-reference is edited in the causes tree, just like any other inbound rule.
  const nextTargets=entries(p.events).filter(([k])=>k!==key);
  function commit() {
    if(leaves(event.conditions).some(n=>(n.op==='all' || n.op==='any') && (!n.refs.length || n.refs.some(key=>!key))))
      return notice('Заполните группу и выберите состояние.');
    const next=structuredClone(p);
    const draft=structuredClone(event);
    for(const n of leaves(draft.conditions))delete n.pick;
    next.events[key]=draft;
    for(const [target] of nextTargets) {
      if(original.includes(target) && !outgoing.has(target))removeCause(next.events[target].causes,key,true);
      if(!original.includes(target) && outgoing.has(target))addCause(next.events[target],key);
    }
    save(next);
  }
  function draw() {
    for(const field of ['conditions','causes']){
      const normalized=normalizeNegations(event[field]);
      event[field]=normalized.op==='not'?{...newGroup(),items:[normalized]}:normalized;
    }
    const scroll=document.querySelector('dialog').scrollTop;
    const effects=el('div',{class:'effects'});
    for(const [index,change] of (event.parameterEffects || []).entries())effects.append(el('div',{class:'effectline'},
      changeFields(change,draw),btn('Убрать',()=>{event.parameterEffects.splice(index,1);draw();},'unlink')));
    for(const [index,state] of event.effects.entries())effects.append(el('div',{class:'effectline'},
      el('span',{class:'rule-ref ref-state'},fullState(state,event.effectPaths[index])),
      btn('Убрать',()=>{event.effects.splice(index,1);event.effectPaths.splice(index,1);draw();},'unlink')));
    for(const id of outgoing) {
      if(id===key)continue;
      effects.append(el('div',{class:'effectline'},el('span',{class:'rule-ref ref-event'},fullEvent(id)),btn('Убрать',()=>{outgoing.delete(id);draw();},'unlink')));
    }

    const form=el('form',{onsubmit:e=>{e.preventDefault();commit();}},...fields(event),
      el('h3',{},'Условия'),ruleBoard(event.conditions,'conditions',event,draw),
      el('h3',{},'Причины'),ruleBoard(event.causes,'causes',event,draw),
      el('h3',{},'Последствия'),effects,
      changePicker('＋ Изменение параметра',target=>{(event.parameterEffects??=[]).push({...target,direction:'up'});draw();}),
      visualTree('＋ Смена состояния',{multiple:false,stateMode:true,eligible:()=>true,apply:(route,key)=>{event.effects.push(key);event.effectPaths.push(route);draw();}}),
      eventPicker('＋ Событие',id=>{outgoing.add(id);draw();},id=>id!==key && !outgoing.has(id)),
      footer(id?btn('Удалить событие',()=>deleteObj('events',id),'danger'):null,el('button',{class:'primary',type:'submit'},'Сохранить правило')));
    modal(id?'Редактировать событие':'Новое событие',form);
    document.querySelector('dialog').scrollTop=scroll;
  }
  draw();
}

