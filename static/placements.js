// A slot identifies a child within a definition. A member identifies a state or
// event within an owner. Both survive renaming and switching to a forked basis.
const kinds=['states','events'];
const pairs=Object.entries;
const copy=structuredClone;
function owned(project){
  const index={states:new Map(),events:new Map()};
  for(const kind of kinds)for(const [id,obj] of pairs(project[kind])){
    if(!index[kind].has(obj.owner))index[kind].set(obj.owner,[]);
    index[kind].get(obj.owner).push([id,obj]);
  }
  return index;
}
function common(a,b){
  let i=0;
  while(i<a.length && i<b.length && a[i]===b[i])i++;
  return i;
}
function rewrite(event,old,at,resolve){
  const e=copy(event);
  function target(owner,path){
    const dest=resolve(owner,path);
    if(!dest)return {owner,path};
    return {owner:dest.id,path:path?dest.route:null};
  }
  function stateRefs(refs,paths){
    return refs.map((ref,i)=>{
      const dest=resolve(old.states[ref].owner,paths?.[i]);
      if(paths?.[i] && dest)paths[i]=dest.route;
      return dest?.states.get(ref) || ref;
    });
  }
  function parameter(n){
    const dest=target(n.owner,n.path);n.owner=dest.owner;
    if(n.path)n.path=dest.path;
  }
  function walk(n){
    if(n.items)n.items.forEach(walk);
    else if(n.op==='event')n.ref=resolve(old.events[n.ref].owner)?.events.get(n.ref) || n.ref;
    else if(n.refs)n.refs=stateRefs(n.refs,n.paths);
    else if(n.op==='parameter' || n.op==='change')parameter(n);
  }
  e.owner=at.id;
  if(e.ownerPath)e.ownerPath=at.route;
  walk(e.causes);walk(e.conditions);
  e.effects=stateRefs(e.effects,e.effectPaths);
  (e.parameterEffects || []).forEach(parameter);
  delete e.additionalCauses;
  return e;
}
function clean(obj){
  const result=copy(obj);
  for(const k of ['instanceOf','instanceId','sourceId','additionalCauses','forked','slot','member'])delete result[k];
  return result;
}
function node(id,route,oldId,oldRoute){
  return {id,route,oldId,oldRoute,states:new Map(),events:new Map()};
}
function indexNode(index,n){
  if(!index.has(n.oldId))index.set(n.oldId,[]);
  index.get(n.oldId).push(n);
}
function nearest(nodes,path,anchor){
  let best,score=-1;
  for(const n of nodes || []){
    const match=path && path.length<=n.oldRoute.length && path.every((v,i)=>n.oldRoute[n.oldRoute.length-path.length+i]===v);
    const rank=(match?anchor.length+1:0)+common(n.oldRoute,anchor);
    if(rank>score){score=rank;best=n;}
  }
  return best;
}

// Build complete address maps before copying rules: a rule can point forward,
// across sibling branches, or to a different occurrence of a shared legacy ID.
function buildWorld(old,out,start,rootId,definition,sourceFor,index,uid,used,keepIds){
  const byId=new Map(),nodes=[];
  function allocate(kind,id){
    if(keepIds && !used[kind].has(id)){used[kind].add(id);return id;}
    return uid();
  }
  function visit(oldId,id,route,oldRoute,slot){
    const src=old.entities[oldId],n=node(id,route,oldId,oldRoute);
    nodes.push(n);indexNode(byId,n);
    const ent={name:src.name,desc:src.desc,children:[]};
    if(src.parameters)ent.parameters=copy(src.parameters);
    if(slot)ent.slot=slot;
    if(id!=='root' && !(definition && route.length===1))ent.instanceOf=sourceFor(oldId);
    out.entities[id]=ent;
    for(const kind of kinds)for(const [key,obj] of index[kind].get(oldId) || []){
      if(kind==='events' && !definition && obj.ownerPath?.length>1 &&
          !obj.ownerPath.every((v,i)=>oldRoute[oldRoute.length-obj.ownerPath.length+i]===v)){
        (ent.omittedEvents??=[]).push(key);
        continue;
      }
      n[kind].set(key,allocate(kind,key));
    }
    for(const child of src.children){
      const next=allocate('entities',child);
      ent.children.push(next);
      visit(child,next,[...route,next],[...oldRoute,child],old.entities[child].slot || child);
    }
  }
  visit(start,rootId,[rootId],[start],null);
  return {byId,nodes,definition};
}
function writeWorld(old,out,world,fallback,memberFor){
  for(const n of world.nodes){
    function resolve(id,path){
      if(id===n.oldId && (!path || path.at(-1)===id && path.length<=1))return n;
      const local=nearest(world.byId.get(id),path,n.oldRoute);
      // Explicit cross-placement links stay in their original branch.
      if(local && (!path || path.length===1 || path.includes(world.nodes[0].oldId) || !fallback(id,path)))return local;
      return fallback(id,path) || local;
    }
    const ent=out.entities[n.id],src=old.entities[n.oldId];
    const remap=(layout,keyFor)=>Object.fromEntries(pairs(layout).map(([k,v])=>[keyFor(k),copy(v)]));
    const childKey=k=>resolve(k)?.id || k;
    const memberKey=(kind,k)=>resolve(old[kind][k].owner)?.[kind].get(k) || k;
    for(const f of ['positions','sizes'])if(src[f])ent[f]=remap(src[f],childKey);
    if(src.views){
      ent.views=copy(src.views);
      for(const view of Object.values(ent.views))for(const f of ['positions','sizes']){
        if(view[f])view[f]=remap(view[f],childKey);
      }
    }
    for(const f of ['layers','layerSizes'])if(src[f]){
      ent[f]=Object.fromEntries(pairs(src[f]).map(([k,layout])=>[k,remap(layout,key=>memberKey(k,key))]));
    }
    if(src.eventLinks)ent.eventLinks=remap(src.eventLinks,key=>memberKey('events',key));
    for(const kind of kinds)for(const [oldId,id] of n[kind]){
      const src=old[kind][oldId];
      const obj=kind==='events'?rewrite(src,old,n,resolve):{...src,owner:n.id};
      out[kind][id]={...clean(obj),member:memberFor(kind,oldId)};
    }
  }
}

export function migratePlacements(project,uid){
  if(project.placementVersion===2)return project;
  const old=project,index=owned(old);
  const out={...old,placementVersion:2,entities:{},states:{},events:{}};
  const bases=new Map(),variants=new Set(),used={entities:new Set(['root']),states:new Set(),events:new Set()};
  function ultimate(kind,id){
    let obj=old[kind][id];
    while(obj.instanceId){id=obj.sourceId;obj=old[kind][id];}
    return id;
  }
  function source(id){
    const e=old.entities[id];
    if(variants.has(id))return id;
    return e.instanceOf?source(e.instanceOf):e.instanceId?source(e.sourceId):id;
  }
  for(const [id,e] of pairs(old.entities)){
    if((e.instanceOf || e.instanceId) && kinds.some(k=>(index[k].get(id)||[]).some(([,o])=>!o.instanceId || o.additionalCauses?.length)))variants.add(id);
  }
  for(const id of Object.keys(old.entities))if(id!=='root' && source(id)===id)bases.set(id,uid());
  const basis=id=>bases.get(source(id));
  const physical=buildWorld(old,out,'root','root',false,basis,index,uid,used,true);
  const worlds=[physical],library=new Map();
  for(const [id,base] of bases){
    const w=buildWorld(old,out,id,base,true,basis,index,uid,used,false);
    worlds.push(w);
    for(const n of w.nodes)indexNode(library,n);
  }
  const fallback=(id,path)=>nearest(physical.byId.get(id),path,path || []) || nearest(library.get(id),path,path || []);
  const member=(kind,id)=>ultimate(kind,id);
  for(const w of worlds)writeWorld(old,out,w,fallback,member);
  // Old path-specific events retain their address for existing external links.
  for(const n of physical.nodes)for(const [oldId,id] of n.events){
    const oldPath=old.events[oldId].ownerPath;
    if(oldPath)out.events[id].ownerPath=n.route.slice(-oldPath.length);
  }
  // Slot identity in a generated legacy branch comes from its source child.
  for(const w of worlds)for(const n of w.nodes)if(n.route.length>1){
    const child=old.entities[n.oldId];
    out.entities[n.id].slot=child.instanceId?ultimate('entities',n.oldId):n.oldId;
  }
  if(old.graphLayouts){
    out.graphLayouts={};
    for(const [path,layout] of pairs(old.graphLayouts)){
      const chain=path.split('/'),n=fallback(chain.at(-1),chain);
      if(!n)continue;
      const translate=key=>{
        const [kind,id,param]=key.split(':');
        if(kind==='parameters'){const owner=fallback(id,chain);return owner?'parameters:'+owner.id+':'+param:key;}
        if(kind==='actions'){
          const event=fallback(old.events[id].owner,chain)?.events.get(id) || id;
          return 'actions:'+event+':'+param;
        }
        const owner=old[kind][id]?.owner;
        return kind+':'+(fallback(owner,chain)?.[kind].get(id) || id);
      };
      const fields={};
      for(const f of ['positions','sizes','bends'])fields[f]=Object.fromEntries(pairs(layout[f]).map(([k,v])=>[
        f==='bends'?k.split('|').map((s,i)=>i===1?s:translate(s)).join('|'):translate(k),v]));
      out.graphLayouts[n.route.join('/')]=fields;
    }
  }
  syncPlacements(out,uid);
  return out;
}

// Move the existing branch. Copies of a definition reuse their corresponding
// placement IDs when the shared composition is edited in the pool.
export function movePlacement(p,from,to,uid){
  const entities=p.entities, id=from.at(-1);
  if(from.length<2 || !entities[id]?.instanceOf)throw Error('Выберите размещённый экземпляр.');
  if(from[0]!==to[0])throw Error('Перенос возможен внутри одного дерева. Для нового размещения используйте пул.');
  if(to.includes(id))throw Error('Нельзя перенести сущность внутрь самой себя.');
  if(from.at(-2)===to.at(-1))return false;
  const moves=[[id,from.at(-2),to.at(-1)]];
  function corresponding(start,route){
    let target=start;
    for(const source of route.slice(1)){
      const slot=entities[source].slot || source;
      target=entities[target].children.find(k=>entities[k].slot===slot);
      if(!target)return null;
    }
    return target;
  }
  if(from[0]!=='root')for(const [key,e] of pairs(entities)){
    if(e.instanceOf!==from[0])continue;
    const child=corresponding(key,from);
    if(!child)continue;
    const dest=corresponding(key,to);
    if(!dest)throw Error('В одном из экземпляров основы отсутствует выбранный родитель.');
    moves.push([child,corresponding(key,from.slice(0,-1)),dest]);
  }
  // Some inherited rules refer to a sibling through their former parent's
  // basis. Remember the concrete endpoint before leaving that context.
  const records=owned(p);
  function keepLinks(key){
    const entity=entities[key];
    function remember(source,target){
      if(source!==target && source!==entity.instanceOf)(entity.boundOwners??={})[source]=target;
    }
    function states(a,b){
      a.forEach((ref,i)=>remember(p.states[ref].owner,p.states[b[i]].owner));
    }
    function rule(a,b){
      if(a.items)a.items.forEach((n,i)=>rule(n,b.items[i]));
      else if(a.op==='event')remember(p.events[a.ref].owner,p.events[b.ref].owner);
      else if(a.refs)states(a.refs,b.refs);
      else if(a.owner)remember(a.owner,b.owner);
    }
    for(const [,event] of records.events.get(key) || []){
      const source=p.events[event.sourceId];
      if(!source)continue;
      rule(source.conditions,event.conditions);
      if(source.causes.items.length)rule(source.causes,event.additionalCauses?.length?event.causes.items[0]:event.causes);
      states(source.effects,event.effects);
      (source.parameterEffects || []).forEach((n,i)=>remember(n.owner,event.parameterEffects[i].owner));
    }
    entity.children.forEach(keepLinks);
  }
  for(const [child] of moves)keepLinks(child);
  // A detached placement starts using its own basis as prototype. Keep any
  // differences it previously inherited through its particular parent slot.
  function keepComposition(key,prototype){
    const e=entities[key],slots=new Map(entities[prototype].children.map(k=>[entities[k].slot || k,k]));
    const actual=new Set(e.children.map(k=>entities[k].slot || k));
    for(const slot of slots.keys())if(!actual.has(slot) && !e.omittedSlots?.includes(slot))(e.omittedSlots??=[]).push(slot);
    for(const k of e.children){
      const child=entities[k],model=slots.get(child.slot || k);
      if(!model && !e.localChildren?.includes(k))(e.localChildren??=[]).push(k);
      if(model && child.instanceOf!==entities[model].instanceOf)child.forked=true;
      keepComposition(k,model && !child.forked?model:child.instanceOf);
    }
  }
  keepComposition(id,entities[id].instanceOf);
  const newSlot=uid();
  for(const [child,oldParent,newParent] of moves){
    const prev=entities[oldParent],next=entities[newParent],e=entities[child],oldSlot=e.slot || child;
    const local=prev.localChildren?.includes(child);
    prev.children=prev.children.filter(k=>k!==child);
    if(local)prev.localChildren=prev.localChildren.filter(k=>k!==child);
    if(prev.instanceOf && !local){
      if(child===id)(prev.omittedSlots??=[]).push(oldSlot);
      (prev.movedSlots??={})[oldSlot]=child;
    }
    for(const layout of [prev,...Object.values(prev.views || {})]){
      delete layout.positions?.[child];delete layout.sizes?.[child];
    }
    e.slot=newSlot;
    next.children.push(child);
    if(child===id && next.instanceOf)(next.localChildren??=[]).push(child);
  }
  const parents=new Map();
  for(const [parent,e] of pairs(entities))for(const child of e.children)parents.set(child,parent);
  for(const [child] of moves){
    const seen=new Set();
    for(let k=child;k;k=parents.get(k)){
      if(seen.has(k))throw Error('Такой перенос создаёт цикл.');
      seen.add(k);
    }
  }
  function repair(route){
    if(!route || route.every((k,i)=>!i || parents.get(k)===route[i-1]))return route;
    const result=[route.at(-1)];
    while(parents.has(result[0]))result.unshift(parents.get(result[0]));
    return result;
  }
  function rule(n){
    if(n.items)n.items.forEach(rule);
    if(n.paths)n.paths=n.paths.map(repair);
    if(n.path)n.path=repair(n.path);
  }
  for(const event of Object.values(p.events)){
    if(event.ownerPath)event.ownerPath=repair(event.ownerPath);
    rule(event.conditions);rule(event.causes);
    if(event.effectPaths)event.effectPaths=event.effectPaths.map(repair);
    for(const change of event.parameterEffects || [])if(change.path)change.path=repair(change.path);
  }
  if(p.graphLayouts)p.graphLayouts=Object.fromEntries(pairs(p.graphLayouts).map(([key,value])=>[repair(key.split('/')).join('/'),value]));
  return true;
}

export function syncPlacements(p,uid,beforePrune){
  const index=owned(p),done=new Set(),active=new Set(),live=new Set();
  const prototypes=new Map();
  const byMember=(kind,owner)=>new Map((index[kind].get(owner)||[]).map(([id,o])=>[o.member || id,id]));
  // Materialize children and reserve every member ID before resolving rule links.
  function prepare(id){
    if(active.has(id))throw Error('Такое размещение создаёт цикл через основу.');
    if(done.has(id))return;
    active.add(id);
    const e=p.entities[id],base=p.entities[e.instanceOf];
    if(e.instanceOf && !base)throw Error('Основа размещения отсутствует.');
    if(base){
      prepare(e.instanceOf);
      e.desc=base.desc;
      if(base.parameters)e.parameters=copy(base.parameters);else delete e.parameters;
      const old=new Map(e.children.map(k=>[p.entities[k].slot,k]));
      const omitted=new Set(e.omittedSlots || []);
      const prototype=p.entities[prototypes.get(id)];
      const slots=prototype?.instanceOf===e.instanceOf?prototype.children:base.children;
      e.children=slots.filter(k=>!omitted.has(p.entities[k].slot || k)).map(k=>{
        const child=p.entities[k],slot=child.slot || k;
        const target=old.get(slot) || uid();
        const placed=p.entities[target]??={name:child.name,desc:child.desc,children:[],slot};
        if(!placed.forked)placed.instanceOf=child.instanceOf || k;
        placed.name=child.name;
        prototypes.set(target,k);
        return target;
      });
      for(const child of e.localChildren || [])if(!e.children.includes(child))e.children.push(child);
      for(const kind of kinds){
        const existing=byMember(kind,id),rows=[];
        for(const [src,obj] of index[kind].get(e.instanceOf)||[]){
          const member=obj.member || src;
          if(kind==='events' && e.omittedEvents?.includes(member))continue;
          const target=existing.get(member) || uid();
          const record=p[kind][target]??={owner:id};
          Object.assign(record,{owner:id,instanceId:id,sourceId:src,member});
          live.add(kind+'/'+target);rows.push([target,record]);
        }
        index[kind].set(id,rows);
      }
    }
    for(const child of e.children)prepare(child);
    done.add(id);active.delete(id);
  }
  for(const [id,e] of pairs(p.entities))if(!e.instanceOf)prepare(id);
  const removed=new Set(Object.keys(p.entities).filter(id=>!done.has(id)));
  if(removed.size)beforePrune?.(removed);
  for(const id of removed)delete p.entities[id];
  if(removed.size)for(const entity of Object.values(p.entities)){
    for(const [slot,target] of pairs(entity.movedSlots || {}))if(removed.has(target))delete entity.movedSlots[slot];
    for(const [source,target] of pairs(entity.boundOwners || {}))if(removed.has(source) || removed.has(target))delete entity.boundOwners[source];
  }
  for(const kind of kinds)for(const [id,o] of pairs(p[kind])){
    if(o.instanceId && !live.has(kind+'/'+id) || !p.entities[o.owner])delete p[kind][id];
  }
  function memberNode(src,id,route){
    const n=node(id,route,src,[]);
    for(const kind of kinds){
      const members=byMember(kind,id);
      for(const [key,obj] of index[kind].get(src)||[]){
        const target=members.get(obj.member || key);
        if(target)n[kind].set(key,target);
      }
    }
    return n;
  }
  const parents=new Map(),contexts=new Map();
  for(const [parent,e] of pairs(p.entities))for(const child of e.children)parents.set(child,parent);
  // A saved link on a template placement may point across rooms. For a new
  // copy, follow the same child slots from their common ancestor.
  function linkedOwner(id,field,key){
    const direct=p.entities[id][field]?.[key];
    if(direct)return direct;
    const prototype=prototypes.get(id),target=p.entities[prototype]?.[field]?.[key];
    if(!target)return;
    const ancestors=new Map();
    for(let src=prototype,placed=id;src && placed;src=parents.get(src),placed=parents.get(placed)){
      ancestors.set(src,placed);
    }
    const slots=[];
    for(let src=target;src;src=parents.get(src)){
      if(ancestors.has(src)){
        let placed=ancestors.get(src);
        for(const slot of slots.reverse()){
          placed=p.entities[placed].children.find(k=>p.entities[k].slot===slot);
          if(!placed)return;
        }
        return placed;
      }
      slots.push(p.entities[src].slot || src);
    }
    return target;
  }
  function bind(src,id,route,map){
    map.set(src,memberNode(src,id,route));
    const slots=new Map(p.entities[id].children.map(k=>[p.entities[k].slot,k]));
    for(const k of p.entities[src].children){
      const target=slots.get(p.entities[k].slot || k);
      if(target)bind(k,target,[...route,target],map);
      else {
        const moved=linkedOwner(id,'movedSlots',p.entities[k].slot || k);
        if(moved)bind(k,moved,[moved],map);
      }
    }
  }
  function context(id){
    if(!contexts.has(id)){
      const mapping=new Map();
      bind(p.entities[id].instanceOf,id,[id],mapping);
      contexts.set(id,mapping);
    }
    return contexts.get(id);
  }
  function resolve(id,owner){
    for(let k=id;k;k=parents.get(k)){
      if(!p.entities[k].instanceOf)continue;
      const mapped=context(k).get(owner);
      if(mapped)return mapped;
      const target=linkedOwner(k,'boundOwners',owner);
      if(target)return memberNode(owner,target,[target]);
    }
  }
  for(const id of done){
    const e=p.entities[id];
    if(!e.instanceOf)continue;
    const at=context(id).get(e.instanceOf);
    for(const kind of kinds)for(const [src,target] of at[kind]){
      const base=p[kind][src],prior=p[kind][target];
      let obj;
      if(kind==='states')obj={...base,owner:id};
      else{
        // Address shape is stable for events imported from older versions.
        const address=Object.hasOwn(prior,'name')?prior.ownerPath:base.ownerPath?[id]:null;
        obj=rewrite(base,p,{...at,route:address},owner=>resolve(id,owner));
        if(address)obj.ownerPath=address;else delete obj.ownerPath;
        function ownCondition(n){
          if(n.items)n.items.forEach(ownCondition);
          else if(n.op==='self')n.paths=n.refs.map(()=>address || null);
          else if(n.op==='parameter' && obj.scope==='local')n.path=address || null;
          else if(obj.scope==='local' && n.paths && address)n.paths=n.paths.map(path=>
            path?.[0]===id?[...address,...path.slice(1)]:path);
        }
        ownCondition(obj.conditions);
        if(prior.additionalCauses?.length){
          const extra=prior.additionalCauses.filter(key=>p.events[key]);
          if(extra.length){
            obj.additionalCauses=extra;
            obj.causes={op:'or',neg:false,items:[...(obj.causes.items.length?[obj.causes]:[]),
              ...extra.map(ref=>({op:'event',neg:false,ref}))]};
          }
        }
      }
      Object.assign(obj,{instanceId:id,sourceId:src,member:base.member || src});
      p[kind][target]=obj;
    }
  }
}

export function forkPlacement(p,id,name,uid){
  const placed=p.entities[id];
  if(!placed?.instanceOf || !name.trim())throw Error('Выберите экземпляр и введите название основы.');
  // Snapshot effective members recursively. Give each nested definition its own
  // source, so editing the former engine or one of its parts cannot affect it.
  const old=copy(p),index=owned(old),definitions=new Map(),worlds=[];
  function snapshot(key){
    if(definitions.has(key))return definitions.get(key);
    const base=uid();definitions.set(key,base);
    for(const child of old.entities[key].children)snapshot(child);
    const world=buildWorld(old,p,key,base,true,k=>definitions.get(k),index,uid,null,false);
    worlds.push(world);
    return base;
  }
  const base=snapshot(id);
  const top=worlds.at(-1);
  for(const w of worlds)writeWorld(old,p,w,(key,path)=>nearest(top.byId.get(key),path,[]),
    (kind,key)=>old[kind][key].member || key);
  for(const n of top.nodes)for(const [key] of n.events)delete p.events[key].additionalCauses;
  for(const [key,original] of definitions){
    p.entities[key].instanceOf=original;
    if(key!==id)p.entities[original].privateBasis=true;
  }
  placed.forked=true;
  p.entities[base].name=name.trim();
  return base;
}
