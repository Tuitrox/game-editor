// Wire vertices use board coordinates. Clip each end to its card along the adjacent segment.
const ns='http://www.w3.org/2000/svg';
function svg(tag,attrs={}){
  const node=document.createElementNS(ns,tag);
  for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
  return node;
}
function boundary(rect,toward){
  const cx=rect.x+rect.w/2,cy=rect.y+rect.h/2;
  const dx=toward[0]-cx,dy=toward[1]-cy;
  const scale=Math.max(Math.abs(dx)/(rect.w/2),Math.abs(dy)/(rect.h/2));
  return scale?[cx+dx/scale,cy+dy/scale]:[cx,cy];
}
function nearestSegment(points,[x,y]){
  let best=Infinity,index=0;
  for(let i=0;i+1<points.length;i++){
    const [a,b]=points[i],dx=points[i+1][0]-a,dy=points[i+1][1]-b;
    const t=Math.max(0,Math.min(1,((x-a)*dx+(y-b)*dy)/(dx*dx+dy*dy || 1)));
    const distance=Math.hypot(x-a-t*dx,y-b-t*dy);
    if(distance<best){best=distance;index=i;}
  }
  return index;
}
export function wireLayer(board){
  const layer=svg('svg',{class:'wire-layer','aria-label':'Связи событий'});
  board.prepend(layer);
  const defs=svg('defs');layer.append(defs);
  const updates=new Map();
  const observer=new ResizeObserver(entries=>{
    for(const update of new Set(entries.flatMap(({target})=>updates.get(target) || [])))update();
  });
  function connect(start,end,role,initial,commit,locked){
    const group=svg('g',{class:'wire '+role});
    const markerId='wire-arrow-'+role;
    if(!defs.querySelector('#'+markerId)){
      const marker=svg('marker',{id:markerId,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:9,markerHeight:9,orient:'auto',markerUnits:'userSpaceOnUse',class:'wire '+role});
      marker.append(svg('path',{d:'M0 0 L10 5 L0 10 Z',fill:'currentColor'}));defs.append(marker);
    }
    const line=svg('polyline',{class:'wire-line','marker-end':'url(#'+markerId+')'});
    const hit=svg('polyline',{class:'wire-hit'}), handles=svg('g');
    group.append(line,hit,handles);layer.append(group);
    let bends=structuredClone(initial), vertices=[],gesture=null;
    function location(event){
      const r=board.getBoundingClientRect();
      return [event.clientX-r.left,event.clientY-r.top].map(v=>Math.max(0,Math.min(2000000,Math.round(v))));
    }
    function paint(){
      const origin=board.getBoundingClientRect();
      const rect=node=>{
        const r=node.getBoundingClientRect();
        return {x:r.left-origin.left,y:r.top-origin.top,w:r.width,h:r.height};
      };
      const a=rect(start),b=rect(end);
      vertices=[boundary(a,bends[0] || [b.x+b.w/2,b.y+b.h/2]),...bends,
        boundary(b,bends.at(-1) || [a.x+a.w/2,a.y+a.h/2])];
      const coords=vertices.map(p=>p.join(',')).join(' ');
      hit.setAttribute('points',coords);line.setAttribute('points',coords);
      handles.replaceChildren(...bends.map(([x,y],i)=>svg('circle',{cx:x,cy:y,r:5,'data-index':i,class:'wire-bend'})));
    }
    function persist(before){
      Promise.resolve(commit(bends)).then(()=>{if(group.isConnected){bends=before;paint();}});
    }
    group.onpointerdown=e=>{
      if(locked() || gesture || !e.isPrimary || e.button!==0)return;
      e.stopPropagation();e.preventDefault();
      const before=structuredClone(bends),point=location(e),index=e.target.dataset.index;
      const i=index===undefined?nearestSegment(vertices,point):Number(index);
      if(index===undefined)bends.splice(i,0,point);
      const controller=new AbortController(),opts={signal:controller.signal};
      gesture=controller;group.setPointerCapture(e.pointerId);
      function finish(save){
        controller.abort();gesture=null;
        if(group.hasPointerCapture(e.pointerId))group.releasePointerCapture(e.pointerId);
        if(save)persist(before);else{bends=before;paint();}
      }
      paint();
      group.addEventListener('pointermove',ev=>{if(ev.pointerId===e.pointerId){bends[i]=location(ev);paint();}},opts);
      group.addEventListener('pointerup',ev=>{if(ev.pointerId===e.pointerId)finish(true);},opts);
      group.addEventListener('pointercancel',ev=>{if(ev.pointerId===e.pointerId)finish(false);},opts);
      group.addEventListener('lostpointercapture',()=>finish(false),opts);
      window.addEventListener('blur',()=>finish(false),opts);
      window.addEventListener('keydown',ev=>{if(ev.key==='Escape')finish(false);},opts);
    };
    group.oncontextmenu=e=>{
      e.preventDefault();
      if(locked() || gesture || e.target.dataset.index===undefined)return;
      const before=structuredClone(bends);
      bends.splice(Number(e.target.dataset.index),1);paint();persist(before);
    };
    for(const node of [start,end]){
      if(!updates.has(node)){updates.set(node,[]);observer.observe(node);}
      updates.get(node).push(paint);
    }
    paint();
  }
  return {connect,refresh(node){for(const fn of updates.get(node)||[])fn();},dispose(){observer.disconnect();}};
}
