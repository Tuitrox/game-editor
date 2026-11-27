import {projectGraph} from './graph.js';
import {parameterTypes, parameterTest, changeDirections} from './parameters.js';

// Names are editable and need not be unique. Add the stored ID only for ambiguous names.
function namesFor(collection){
  const counts=new Map();
  for(const obj of Object.values(collection))counts.set(obj.name,(counts.get(obj.name) || 0)+1);
  return Object.fromEntries(Object.entries(collection).map(([id,obj])=>[id,
    counts.get(obj.name)>1?obj.name+' ['+id+']':obj.name]));
}

export function branchText(project,branch,inBranch){
  const {entities,states,events}=project, whole=branch.length===1 && branch[0]==='root';
  const entityNames=namesFor(entities),stateNames=namesFor(states),eventNames=namesFor(events);
  const parameterNames=new Map();
  const routeName=route=>route.map(id=>entityNames[id]).join(' › ');
  const local=(owner,route)=>whole || inBranch({owner,ownerPath:route},branch);
  const parents=new Map();
  for(const [id,entity] of Object.entries(entities))for(const child of entity.children){
    if(!parents.has(child))parents.set(child,[]);
    parents.get(child).push(id);
  }
  function place(owner,route){
    const base=[...(route || [owner])];
    // Complete a relative path when its prefix is unambiguous.
    while(parents.get(base[0])?.length===1)base.unshift(parents.get(base[0])[0]);
    const shared=parents.has(base[0]);
    return (local(owner,route)?'':'вне ветки · ')+routeName(base)+(shared?' (во всех размещениях этого пути)':'');
  }
  function eventName(id){
    const e=events[id];
    const owner=e.scope==='global'?'глобальное событие':place(e.owner,e.ownerPath);
    return '«'+eventNames[id]+'» ('+owner+')';
  }
  function stateName(id,route){
    return '«'+stateNames[id]+'» ('+place(states[id].owner,route)+')';
  }
  function paramName(n){
    if(!parameterNames.has(n.owner))parameterNames.set(n.owner,namesFor(entities[n.owner].parameters));
    return parameterNames.get(n.owner)[n.ref];
  }
  function change(n){return paramName(n)+' ('+place(n.owner,n.path)+') — '+changeDirections[n.direction];}
  function expression(n,event){
    let value;
    if(n.items){
      const children=n.items.map(item=>expression(item,event));
      if(!children.length)value='не заданы';
      else if(n.op==='not')value='НЕ ('+children[0]+')';
      else value=children.length===1?children[0]:'('+children.join(n.op==='and'?' И ':' ИЛИ ')+')';
    }else if(n.op==='event')value='событие '+eventName(n.ref);
    else if(n.op==='change')value=change(n);
    else if(n.op==='parameter'){
      value=parameterTest(project,n,paramName(n))+' ('+place(n.owner,n.path)+')';
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
    lines.push('  '.repeat(depth)+'- '+entityNames[id]+(repeat?' (та же сущность, см. выше)':ent.desc?' — '+ent.desc:''));
    if(repeat)return;
    seen.add(id);
    for(const child of ent.children)tree(child,depth+1);
  }
  tree(branch.at(-1),0);
  if(whole){
    const detached=Object.keys(entities).filter(id=>id!=='root' && !parents.has(id));
    if(detached.length)lines.push('','Сущности пула вне дерева проекта');
    for(const id of detached)tree(id,0);
  }
  function section(title,rows){
    lines.push('',title);
    if(!rows.length)lines.push('Нет');
    for(const row of rows)lines.push(row);
  }
  section('Состояния',Object.entries(states).filter(([,s])=>seen.has(s.owner)).map(([id,s])=>
    '- '+stateName(id,null)+(s.desc?' — '+s.desc:'')));
  const params=[];
  for(const owner of seen)for(const [ref,p] of Object.entries(entities[owner].parameters || {})){
    params.push('- '+paramName({owner,ref})+' ('+place(owner,null)+') — '+parameterTypes[p.type || 'number']);
  }
  section('Параметры',params);
  const graph=projectGraph(project,branch,inBranch);
  const nodes=graph.nodes.filter(n=>n.kind==='events');
  const dependents=new Map();
  for(const edge of graph.edges){
    if(!edge.from.startsWith('events:') || !edge.to.startsWith('events:'))continue;
    if(!dependents.has(edge.from))dependents.set(edge.from,new Set());
    dependents.get(edge.from).add(edge.to.slice('events:'.length));
  }
  function rules(external){
    const rows=[];
    for(const {id,obj:e} of nodes.filter(n=>n.external===external)){
      if(rows.length)rows.push('');
      rows.push('Событие '+eventName(id));
      if(e.desc)rows.push('  Описание: '+e.desc);
      rows.push('  Причины: '+expression(e.causes,e),'  Условия: '+expression(e.conditions,e));
      const effects=[...e.effects.map((s,i)=>'установить состояние '+stateName(s,e.effectPaths?.[i])),
        ...(e.parameterEffects || []).map(change)];
      rows.push('  Последствия: '+(effects.join('; ') || 'нет изменений состояний или параметров'));
      const targets=dependents.get('events:'+id);
      if(targets)rows.push('  Упоминается в причинах событий: '+[...targets].map(eventName).join('; '));
    }
    return rows;
  }
  section('События ветки и их связи',rules(false));
  const external=rules(true);
  if(external.length)section('Связанные внешние события',external);
  return lines.join('\n');
}
