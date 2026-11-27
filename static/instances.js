// Placed objects keep their IDs across renames and edits to the source.
// Generated records use the same reference format as ordinary project records.
export function refreshInstances(project, uid) {
  const {entities, states, events}=project;
  if(!Object.values(entities).some(e=>e.instanceOf || e.instanceId) &&
     !Object.values(states).some(s=>s.instanceId) && !Object.values(events).some(e=>e.instanceId))return;
  const previous=new Map(), live=new Set();
  const collections={entities,states,events};
  const owners={states:new Map(),events:new Map()};
  function indexOwner(kind,id,owner){
    if(!owners[kind].has(owner))owners[kind].set(owner,new Set());
    owners[kind].get(owner).add(id);
  }
  for(const [kind,collection] of Object.entries(collections)){
    for(const [id,obj] of Object.entries(collection)){
      if(obj.instanceId)previous.set([kind,obj.instanceId,obj.sourceId].join('/'),id);
      if(owners[kind])indexOwner(kind,id,obj.owner);
    }
  }
  const done=new Set(), active=new Set();
  function prepare(id){
    if(done.has(id))return;
    if(active.has(id))throw Error('Такое размещение создаёт цикл через основу.');
    active.add(id);
    const entity=entities[id];
    if(entity.instanceOf){
      prepare(entity.instanceOf);
      projectBranch(id,entity.instanceOf);
    }else for(const child of entity.children)prepare(child);
    active.delete(id);done.add(id);
  }
  function projectBranch(instance,source){
    const ids={entities:new Map([[source,instance]]),states:new Map(),events:new Map()};
    function allocate(kind,id){
      const key=[kind,instance,id].join('/');
      const target=previous.get(key) || uid();
      live.add(key);ids[kind].set(id,target);
      return target;
    }
    for(const id of ids.entities.keys()){
      for(const child of entities[id].children)if(!ids.entities.has(child))allocate('entities',child);
    }
    for(const kind of ['states','events']){
      for(const owner of ids.entities.keys())for(const id of owners[kind].get(owner) || []){
        const obj=collections[kind][id];
        if((kind!=='events' || local(owner,obj.ownerPath)) && (!obj.instanceId ||
          live.has([kind,obj.instanceId,obj.sourceId].join('/')))){
          const target=allocate(kind,id);
          indexOwner(kind,target,ids.entities.get(owner));
        }
      }
    }
    for(const [id,target] of ids.entities){
      const base=entities[id];
      const ent=id===source?entities[target]:{name:base.name,instanceId:instance,sourceId:id};
      ent.desc=base.desc;
      ent.children=base.children.map(k=>ids.entities.get(k));
      if(base.parameters)ent.parameters=structuredClone(base.parameters);
      else delete ent.parameters;
      entities[target]=ent;
    }
    for(const [id,target] of ids.states){
      states[target]={...states[id],owner:ids.entities.get(states[id].owner),instanceId:instance,sourceId:id};
    }
    function local(owner,path,anchor){
      if(!ids.entities.has(owner))return false;
      if(anchor?.includes(source) && path?.includes(source) && path[0]===anchor[0]){
        const prefix=r=>r.slice(0,r.indexOf(source)+1).join('/');
        if(prefix(path)!==prefix(anchor))return false;
      }
      // A route through another placement of a shared child remains external.
      return !path || path.length===1 || path.includes(source) || ids.entities.has(path[0]) || owner===source;
    }
    function route(path,owner){
      if(!local(owner,path))return path;
      if(!path)return path;
      const inside=path.includes(source)?path.indexOf(source):path.findIndex(k=>ids.entities.has(k));
      return path.slice(inside).map(k=>ids.entities.get(k));
    }
    function parameter(n,anchor){
      if(!local(n.owner,n.path,anchor))return;
      if(n.path)n.path=route(n.path,n.owner);
      n.owner=ids.entities.get(n.owner);
    }
    function stateList(refs,paths,anchor){
      refs.forEach((ref,i)=>{
        const owner=states[ref]?.owner;
        if(!local(owner,paths?.[i],anchor))return;
        refs[i]=ids.states.get(ref);
        if(paths?.[i])paths[i]=route(paths[i],owner);
      });
    }
    function rule(n,anchor){
      if(n.items)n.items.forEach(child=>rule(child,anchor));
      else if(n.op==='event')n.ref=ids.events.get(n.ref) || n.ref;
      else if(n.refs)stateList(n.refs,n.paths,anchor);
      else parameter(n,anchor);
    }
    for(const [id,target] of ids.events){
      const e=structuredClone(events[id]);
      const anchor=e.ownerPath;
      if(e.ownerPath)e.ownerPath=route(e.ownerPath,e.owner);
      e.owner=ids.entities.get(e.owner);
      rule(e.conditions,anchor);rule(e.causes,anchor);
      stateList(e.effects,e.effectPaths,anchor);
      (e.parameterEffects || []).forEach(n=>parameter(n,anchor));
      delete e.additionalCauses;
      const extra=(events[target]?.additionalCauses || []).filter(k=>events[k]);
      if(extra.length){
        e.additionalCauses=extra;
        const leaves=extra.map(ref=>({op:'event',neg:false,ref}));
        e.causes={op:'or',neg:false,items:[...(e.causes.items.length?[e.causes]:[]),...leaves]};
      }
      events[target]={...e,instanceId:instance,sourceId:id};
    }
  }
  for(const [id,e] of Object.entries(entities))if(!e.instanceId)prepare(id);
  for(const [key,id] of previous)if(!live.has(key))delete collections[key.split('/')[0]][id];
}
