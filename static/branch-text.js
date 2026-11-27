import {projectGraph} from './graph.js';
import {parameterTypes, parameterTest, changeDirections} from './parameters.js';

// Names are editable and need not be unique. Add the stored ID only for ambiguous names.
function namesFor(collection,byOwner=false){
  const key=obj=>byOwner?obj.owner+'/'+obj.name:obj.name;
  const counts=new Map();
  for(const obj of Object.values(collection))counts.set(key(obj),(counts.get(key(obj)) || 0)+1);
  return Object.fromEntries(Object.entries(collection).map(([id,obj])=>[id,
    counts.get(key(obj))>1?obj.name+' ['+id+']':obj.name]));
}

export function branchText(project,branch,inBranch){
  const {entities,states,events}=project, whole=branch.length===1 && branch[0]==='root';
  const entityNames=namesFor(entities),stateNames=namesFor(states,true),eventNames=namesFor(events,true);
  const parameterNames=new Map();
  const routeName=route=>route.map(id=>entityNames[id]).join(' › ');
  const local=(owner,route)=>whole || inBranch({owner,ownerPath:route},branch);
  const parents=new Map();
  const places=new Map();
  for(const [id,entity] of Object.entries(entities))for(const child of entity.children){
    if(!parents.has(child))parents.set(child,[]);
    parents.get(child).push(id);
  }
  function place(owner,route){
    const base=[...(route || [owner])];
    // Complete a relative path when its prefix is unambiguous.
    while(parents.get(base[0])?.length===1)base.unshift(parents.get(base[0])[0]);
    const shared=parents.has(base[0]);
    const external=!local(owner,route);
    const key=(external?'out:':'in:')+base.join('/');
    if(!places.has(key)){
      const label=(external?'вне ветки · ':'')+routeName(base)+(shared?' (во всех размещениях этого пути)':'');
      places.set(key,{ref:'@'+(places.size+1),label});
    }
    return places.get(key).ref;
  }
  function eventName(id){
    const e=events[id];
    const owner=e.scope==='global'?'глобальное событие':place(e.owner,e.ownerPath);
    return '«'+eventNames[id]+'» '+owner;
  }
  function stateName(id,route){
    return '«'+stateNames[id]+'» '+place(states[id].owner,route);
  }
  function paramName(n){
    if(!parameterNames.has(n.owner))parameterNames.set(n.owner,namesFor(entities[n.owner].parameters));
    return parameterNames.get(n.owner)[n.ref];
  }
  function change(n){return paramName(n)+' '+place(n.owner,n.path)+' — '+changeDirections[n.direction];}
  const nodes=projectGraph(project,branch,inBranch).nodes.filter(n=>n.kind==='events');
  const describedEvents=new Set(nodes.map(n=>n.id));
  const unique=new Set(),ambiguous=new Set();
  for(const name of Object.values(eventNames)){
    if(unique.has(name))ambiguous.add(name);
    unique.add(name);
  }
  function expression(n,event){
    let value;
    if(n.items){
      const children=n.items.map(item=>expression(item,event));
      if(!children.length)value='не заданы';
      else if(n.op==='not')value='НЕ ('+children[0]+')';
      else value=children.length===1?children[0]:'('+children.join(n.op==='and'?' И ':' ИЛИ ')+')';
    }else if(n.op==='event')value='событие '+(describedEvents.has(n.ref) && !ambiguous.has(eventNames[n.ref])?'«'+eventNames[n.ref]+'»':eventName(n.ref));
    else if(n.op==='player')value='действие игрока «'+n.name+'»';
    else if(n.op==='change')value=change(n);
    else if(n.op==='parameter'){
      value=parameterTest(project,n,paramName(n))+' '+place(n.owner,n.path);
    }else if(n.op==='self')value=n.refs.length?'состояние '+stateName(n.refs[0],event.ownerPath):'любое состояние ('+place(event.owner,event.ownerPath)+')';
    else{
      const list=n.refs.map((s,i)=>stateName(s,n.paths?.[i]));
      value=(n.op==='all'?'все из':'любой из')+' ['+list.join('; ')+']';
    }
    return n.neg?'НЕ ('+value+')':value;
  }

  const lines=['Ветка: '+routeName(branch),'','Иерархия сущностей'];
  const seen=new Set();
  function tree(id,depth){
    const ent=entities[id],repeat=seen.has(id);
    const source=ent.instanceOf || ent.sourceId;
    lines.push('  '.repeat(depth)+'- '+entityNames[id]+(source?' (основа: '+entityNames[source]+')':'')+(repeat?' (та же сущность, см. выше)':ent.desc?' — '+ent.desc:''));
    if(repeat)return;
    seen.add(id);
    for(const child of ent.children)tree(child,depth+1);
  }
  tree(branch.at(-1),0);
  if(whole && project.placementVersion!==2){
    const detached=Object.keys(entities).filter(id=>id!=='root' && !parents.has(id));
    if(detached.length)lines.push('','Сущности пула вне дерева проекта');
    for(const id of detached)tree(id,0);
  }
  function section(title,rows){
    lines.push('',title);
    if(!rows.length)lines.push('Нет');
    for(const row of rows)lines.push(row);
  }
  const stateRows=Object.entries(states).filter(([,s])=>seen.has(s.owner)).map(([id,s])=>
    '- '+stateName(id,null)+(s.desc?' — '+s.desc:''));
  const params=[];
  for(const owner of seen)for(const [ref,p] of Object.entries(entities[owner].parameters || {})){
    params.push('- '+paramName({owner,ref})+' '+place(owner,null)+' — '+parameterTypes[p.type || 'number']);
  }
  function rules(external){
    const rows=[];
    for(const {id,obj:e} of nodes.filter(n=>n.external===external)){
      rows.push('- '+eventName(id)+(e.desc?' — '+e.desc:''));
      if(e.causes.items.length || e.causes.neg)rows.push('  Причины: '+expression(e.causes,e));
      if(e.conditions.items.length || e.conditions.neg)rows.push('  Условия: '+expression(e.conditions,e));
      const effects=[...e.effects.map((s,i)=>'установить состояние '+stateName(s,e.effectPaths?.[i])),
        ...(e.parameterEffects || []).map(change)];
      if(effects.length)rows.push('  Последствия: '+effects.join('; '));
    }
    return rows;
  }
  const internal=rules(false);
  const external=rules(true);
  if(places.size)section('Размещения',Array.from(places.values(),p=>p.ref+' '+p.label));
  section('Состояния',stateRows);
  section('Параметры',params);
  if(nodes.length)lines.push('','Пустые поля правил пропущены. Связь событий указана в причинах принимающего события.');
  section('События ветки',internal);
  if(external.length)section('Связанные внешние события',external);
  return lines.join('\n');
}
