import {parameterTest,changeDirections} from './parameters.js';

// Event and state IDs belong to separate pools. References always use the same
// typed key, even when several rules point at the same external object.
export function projectGraph(project, path, inBranch) {
  const root = path.length === 1 && path[0] === 'root';
  const nodes = new Map(), edges = new Map(), locals = new Set();
  for (const kind of ['events', 'states']) {
    for (const [id, obj] of Object.entries(project[kind])) {
      const key = kind + ':' + id;
      nodes.set(key, {key, id, kind, obj, external: true});
      if (root || (obj.scope !== 'global' && inBranch(obj, path))) {
        locals.add(key);
        nodes.get(key).external = false;
      }
    }
  }
  const visible = new Set(locals);
  function link(from, to, role, label, statePath, negated = false, caption) {
    const stateKey = role === 'effect' ? to : from;
    const local = key => locals.has(key) && (root || key !== stateKey || !statePath ||
      inBranch({owner:nodes.get(key).obj.owner, ownerPath:statePath}, path));
    if (!local(from) && !local(to)) return;
    visible.add(from); visible.add(to);
    const wireRole = negated ? 'not-' + role : role;
    const key = [from, wireRole, to].join('|');
    if (!edges.has(key)) edges.set(key, {key, from, to, role:wireRole, labels:[]});
    const edge = edges.get(key);
    if (!edge.labels.includes(label)) edge.labels.push(label);
    if(caption){
      edge.captions??=[];
      if(!edge.captions.includes(caption))edge.captions.push(caption);
    }
  }
  function parameterKey(leaf){
    const key='parameters:'+leaf.owner+':'+leaf.ref;
    if(!nodes.has(key)){
      const obj={...project.entities[leaf.owner].parameters[leaf.ref],owner:leaf.owner};
      nodes.set(key,{key,id:leaf.ref,kind:'parameters',obj,external:true});
    }
    if(root || inBranch({owner:leaf.owner,ownerPath:leaf.path},path)){
      nodes.get(key).external=false;locals.add(key);
    }
    return key;
  }
  function walk(rule, apply, trail = [], inheritedNegation = false) {
    const names = {and:'И', or:'ИЛИ', not:'НЕ', all:'Все из', any:'Любой из'};
    const labels = [...trail];
    if (rule.neg) labels.push('НЕ');
    if (names[rule.op]) labels.push(names[rule.op]);
    const negated = (inheritedNegation !== Boolean(rule.neg)) !== (rule.op === 'not');
    if (rule.items) for (const item of rule.items) walk(item, apply, labels, negated);
    else apply(rule, labels.join(' › '), negated);
  }
  for (const [id, e] of Object.entries(project.events)) {
    const event = 'events:' + id;
    walk(e.causes, (leaf, label, negated) => {
      if(leaf.op==='change'){
        const caption=changeDirections[leaf.direction];
        link(parameterKey(leaf),event,'cause',[label,caption].filter(Boolean).join(' › '),leaf.path,negated,caption);
      }else link('events:'+leaf.ref, event, 'cause', 'Причина · '+label, undefined, negated);
    });
    walk(e.conditions, (leaf, label, negated) => {
      if (leaf.op === 'parameter') {
        link(parameterKey(leaf), event, 'condition', [label,parameterTest(project,leaf)].filter(Boolean).join(' › '), leaf.path, negated);
      } else leaf.refs.forEach((ref,i) =>
        link('states:'+ref, event, 'condition', 'Условие · '+label, leaf.paths?.[i], negated));
    });
    e.effects.forEach((ref,i) => link(event, 'states:'+ref, 'effect', 'Устанавливает состояние', e.effectPaths?.[i]));
    for(const change of e.parameterEffects || []){
      const caption=changeDirections[change.direction];
      link(event,parameterKey(change),'effect',caption,change.path,false,caption);
    }
  }
  // Keep existing hand-edited bends. Only a second polarity needs a new layout key.
  for (const edge of edges.values()) {
    if (edge.role.startsWith('not-')) {
      const original = [edge.from, edge.role.slice(4), edge.to].join('|');
      if (!edges.has(original)) edge.key = original;
    }
  }
  return {nodes:[...visible].sort().map(k => nodes.get(k)), edges:[...edges.values()].sort((a,b) => a.key.localeCompare(b.key,'en'))};
}

export function upstream(graph, key) {
  const incoming = new Map(graph.nodes.map(n => [n.key, []]));
  for (const edge of graph.edges) incoming.get(edge.to).push(edge);
  const nodes = new Set([key]), edges = new Set(), pending = [key];
  for (const target of pending) for (const edge of incoming.get(target)) {
    edges.add(edge.key);
    if (!nodes.has(edge.from)) {nodes.add(edge.from); pending.push(edge.from);}
  }
  return {nodes, edges};
}

// Prefer a single horizontal run across several columns. A change of height
// is allowed only on the edge's own vertical lane in a gap between cards.
function straightenRoutes(routes, runs, cards) {
  const tracks=new Map();
  const wireSpacing=9;
  function horizontals(points) {
    const spans=[];
    for(let i=1;i<points.length;i++){
      const [x,y]=points[i-1], [x2,y2]=points[i];
      if(y===y2 && x!==x2)spans.push({left:Math.min(x,x2),right:Math.max(x,x2),y,low:y-wireSpacing,high:y+wireSpacing});
    }
    return spans;
  }
  for(const [key,run] of runs)tracks.set(key,horizontals(run.points));
  const boxes=cards.map(({x,y,w,h})=>({left:x,right:x+w,low:y-12,high:y+h+12}));
  function cost(points) {
    // A pair of elbows is worth a modest detour, but not a trip around the board.
    let score=(points.length-2)*48;
    for(let i=1;i<points.length;i++)score+=Math.abs(points[i][1]-points[i-1][1]);
    return score;
  }
  for(const [key,{points,lanes}] of runs){
    if(lanes.length<2 || points.length<=2)continue;
    const first=points[0],last=points.at(-1);
    const crosses=(box,left,right)=>box.right>left && box.left<right;
    const obstacles=boxes.filter(box=>crosses(box,first[0],last[0]));
    for(const [other,spans] of tracks){
      if(other!==key)for(const span of spans)if(crosses(span,first[0],last[0]))obstacles.push(span);
    }
    const clear=(left,right,y)=>!obstacles.some(box=>crosses(box,left,right) && y>box.low && y<box.high);
    let best=points, bestCost=cost(points);
    function consider(bends){
      const candidate=[first,...bends,last], score=cost(candidate);
      if(score<bestCost && horizontals(candidate).every(s=>clear(s.left,s.right,s.y))){
        best=candidate;bestCost=score;
      }
    }
    if(first[1]===last[1])consider([]);
    else for(const x of lanes)consider([[x,first[1]],[x,last[1]]]);
    // The closest free horizontal corridor starts at a clearance boundary
    // of a card or another wire. Perpendicular wire crossings remain allowed.
    const left=lanes[0],right=lanes.at(-1), levels=new Set();
    for(const box of obstacles)if(crosses(box,left,right)){
      levels.add(box.low);levels.add(box.high);
    }
    for(const y of levels){
      if(y<12 || y===first[1] || y===last[1])continue;
      consider([[left,first[1]],[left,y],[right,y],[right,last[1]]]);
    }
    if(best!==points){
      routes.get(key).bends=best.slice(1,-1);
      tracks.set(key,horizontals(best));
    }
  }
}

// A layered drawing with a temporary vertex in every column a long edge crosses.
// Feedback edges use lanes above the columns, including self-loops.
export function layoutGraph(graph, sizes) {
  const keys = graph.nodes.map(n => n.key);
  const next = new Map(keys.map(k => [k, []])), prev = new Map(keys.map(k => [k, []]));
  for (const edge of graph.edges) next.get(edge.from).push(edge);
  const entered = new Set(), active = new Set(), back = new Set(), order = [];
  for (const start of keys) {
    if (entered.has(start)) continue;
    const stack = [[start, 0]];
    entered.add(start); active.add(start);
    while (stack.length) {
      const frame = stack.at(-1), [key, i] = frame, edge = next.get(key)[i];
      if (!edge) {active.delete(key); order.push(key); stack.pop(); continue;}
      frame[1]++;
      if (active.has(edge.to)) back.add(edge.key);
      else if (!entered.has(edge.to)) {
        entered.add(edge.to); active.add(edge.to); stack.push([edge.to, 0]);
      }
    }
  }
  const rank = new Map(keys.map(k => [k, 0]));
  for (const key of order.reverse()) for (const edge of next.get(key)) {
    if (!back.has(edge.key)) rank.set(edge.to, Math.max(rank.get(edge.to),rank.get(key)+1));
  }
  const columns = [], paths = new Map(), neighbors = new Map();
  function insert(key, col) {
    (columns[col] ??= []).push(key);
    neighbors.set(key, {left:[], right:[]});
  }
  for (const k of keys) insert(k, rank.get(k));
  for (const e of graph.edges) {
    prev.get(e.to).push(e);
    if (back.has(e.key)) continue;
    const path = [e.from];
    for (let i=rank.get(e.from)+1; i<rank.get(e.to); i++) {
      const key = e.key+'#'+i;
      insert(key,i); path.push(key);
    }
    path.push(e.to); paths.set(e.key,path);
    for (let i=1;i<path.length;i++) {
      neighbors.get(path[i-1]).right.push(path[i]);
      neighbors.get(path[i]).left.push(path[i-1]);
    }
  }
  const indices = new Map();
  function index(col) {col.forEach((k,i) => indices.set(k,i));}
  columns.forEach(index);
  for (let pass=0;pass<4;pass++) {
    const forward = pass%2===0;
    for (const col of (forward ? columns : [...columns].reverse())) {
      const score = new Map(col.map(k => {
        const peers = neighbors.get(k)[forward?'left':'right'];
        return [k, peers.length ? peers.reduce((s,p)=>s+indices.get(p),0)/peers.length : indices.get(k)];
      }));
      col.sort((a,b)=>score.get(a)-score.get(b)); index(col);
    }
  }
  const slots = new Map(), positions = new Map(), segments = new Map(), gaps = new Map();
  const captionWidths=new Map();
  function reserve(col) {
    const lane = gaps.get(col) || 0;
    gaps.set(col,lane+1); return {col,lane};
  }
  for (const e of graph.edges) {
    const path = paths.get(e.key);
    if(e.captions){
      const col=rank.get(e.from);
      captionWidths.set(col,Math.max(captionWidths.get(col) || 0,e.captions.join(' / ').length*7));
    }
    segments.set(e.key,path ? path.slice(1).map((_,i)=>reserve(rank.get(e.from)+i)) :
      [reserve(rank.get(e.from)),reserve(rank.get(e.to)-1)]);
  }
  const gapX = new Map();
  let x = 40 + (gaps.get(-1)||0)*12;
  gapX.set(-1, 12);
  for (const [i,col] of columns.entries()) {
    let y = 40 + back.size*15, width = 0;
    for (const k of col) {
      const [w,h] = sizes.get(k) || [0,12];
      slots.set(k,{x,y,w,h});
      if (sizes.has(k)) positions.set(k,[x,y]);
      y += h + (w ? 42 : 14); width = Math.max(width,w);
    }
    const captionWidth=captionWidths.get(i) || 0;
    gapX.set(i, x+width+22+captionWidth);
    x += width+56+captionWidth+(gaps.get(i)||0)*12;
  }
  const ports = new Map();
  function distribute(key, list, side) {
    const other = side==='start' ? 'to' : 'from';
    list.sort((a,b)=>slots.get(a[other]).y-slots.get(b[other]).y || a.key.localeCompare(b.key,'en'));
    list.forEach((e,i)=>{
      if (!ports.has(e.key)) ports.set(e.key,{});
      ports.get(e.key)[side]=(i+1)/(list.length+1);
    });
  }
  for (const k of keys) {distribute(k,next.get(k),'start'); distribute(k,prev.get(k),'end');}
  const routes = new Map(), runs = new Map();
  let feedback = 0;
  for (const e of graph.edges) {
    const a=slots.get(e.from), b=slots.get(e.to), port=ports.get(e.key);
    // A lone port can follow its neighbour without colliding with a sibling.
    if(!back.has(e.key)){
      const y1=Math.round(a.y+a.h*port.start), y2=Math.round(b.y+b.h*port.end);
      if(next.get(e.from).length===1 && y2>=a.y+12 && y2<=a.y+a.h-12)port.start=(y2-a.y)/a.h;
      else if(prev.get(e.to).length===1 && y1>=b.y+12 && y1<=b.y+b.h-12)port.end=(y1-b.y)/b.h;
    }
    const origin=[a.x+a.w, Math.round(a.y+a.h*port.start)], end=[b.x,Math.round(b.y+b.h*port.end)];
    const lanes=segments.get(e.key).map(s=>gapX.get(s.col)+s.lane*12);
    const points=[origin], path=paths.get(e.key);
    if (path) {
      let y=origin[1];
      for (let i=0;i<lanes.length;i++) {
        const nextY = i===lanes.length-1 ? end[1] : slots.get(path[i+1]).y+6;
        points.push([lanes[i],y],[lanes[i],nextY]); y=nextY;
      }
    } else {
      const y=20+feedback++*15;
      points.push([lanes[0],origin[1]],[lanes[0],y],[lanes[1],y],[lanes[1],end[1]]);
    }
    points.push(end);
    const clean=[];
    for (const p of points) {
      const b=clean.at(-1),a=clean.at(-2);
      if (b && b[0]===p[0] && b[1]===p[1]) continue;
      if (a && (a[0]===b[0] && b[0]===p[0] || a[1]===b[1] && b[1]===p[1])) clean.pop();
      clean.push(p);
    }
    routes.set(e.key,{bends:clean.slice(1,-1),port});
    runs.set(e.key,{points:clean,lanes:path?lanes:[]});
  }
  straightenRoutes(routes,runs,keys.map(k=>slots.get(k)));
  return {positions,routes};
}

