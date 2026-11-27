import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {refreshInstances} from '../static/instances.js';
import {forkPlacement,migratePlacements,syncPlacements,movePlacement} from '../static/placements.js';
import {projectGraph} from '../static/graph.js';

let serial=0;
const uid=()=>'new-'+ ++serial;
const ent=(name,children=[])=>({name,children,desc:''});
const group=(...items)=>({op:'and',neg:false,items});
const event=(owner,name)=>({owner,name,desc:'',scope:'local',causes:group(),conditions:group(),effects:[]});
const validate=(p,expected=0)=>{
  const r=spawnSync(process.platform==='win32'?'python':'python3',['-c','import json,sys;from server import validate;validate(json.load(sys.stdin))'],
    {input:JSON.stringify(p),encoding:'utf8'});
  assert.equal(r.status,expected,r.stderr);
};
for(const path of ['seed.json','examples/night-voyage.json']){
  const migrated=migratePlacements(JSON.parse(readFileSync(new URL('../'+path,import.meta.url))),uid);
  validate(migrated);
  assert.equal(migratePlacements(migrated,uid),migrated);
  const before=structuredClone(migrated);
  syncPlacements(migrated,uid);
  assert.deepEqual(migrated,before);
}
const old={entities:{root:ent('Проект',['room']),room:ent('Машинное отделение',['engine','right']),
  engine:{...ent('Левый',['pump']),parameters:{oil:{name:'Масло',type:'number'}}},
  right:{...ent('Правый'),instanceOf:'engine'},pump:ent('Насос')},
  states:{hot:{owner:'engine',name:'Перегрет',desc:''},dry:{owner:'pump',name:'Сухой',desc:''}},
  events:{heat:{...event('engine','Нагрев'),effects:['hot']},alarm:event('root','Сигнал')}};
refreshInstances(old,uid);
const rhs=Object.keys(old.states).find(k=>old.states[k].owner==='right');
const rhsEvent=Object.keys(old.events).find(k=>old.events[k].owner==='right');
Object.assign(old.events.alarm,{scope:'global',conditions:group({op:'all',neg:false,refs:['hot',rhs],
  paths:[['root','room','engine'],['root','room','right']]}),causes:group({op:'event',ref:rhsEvent,neg:false})});
const p=migratePlacements(old,uid);
validate(p);
const base=p.entities.engine.instanceOf;
assert.equal(base,p.entities.right.instanceOf);
assert.equal(p.events.alarm.causes.items[0].ref,rhsEvent);
assert.deepEqual(p.events.alarm.conditions,old.events.alarm.conditions);
const roomBase=p.entities.room.instanceOf;
const [leftSlot,rightSlot]=p.entities[roomBase].children;
const member=(owner,key)=>Object.keys(p.states).find(k=>p.states[k].owner===owner && p.states[k].member===key);
const pumpSlot=p.entities[rightSlot].children[0];
p.events.check={...event(roomBase,'Оба перегреты'),ownerPath:[roomBase],conditions:group(
  {op:'all',neg:false,refs:[member(leftSlot,'hot'),member(rightSlot,'hot')],paths:[[roomBase,leftSlot],[roomBase,rightSlot]]},
  {op:'any',neg:true,refs:[member(pumpSlot,'dry')],paths:[[roomBase,rightSlot,pumpSlot]]})};
syncPlacements(p,uid);validate(p);
const physical=Object.keys(p.events).find(k=>p.events[k].owner==='room' && p.events[k].sourceId==='check');
assert.deepEqual(p.events[physical].conditions.items[0].refs,['hot',rhs]);
const rightPump=p.entities.right.children[0],sensor=member(rightPump,'dry');
assert.deepEqual(p.events[physical].conditions.items[1].refs,[sensor]);
const independent=forkPlacement(p,'right','Форсированный двигатель',uid);
syncPlacements(p,uid);validate(p);
assert.equal(p.entities.right.name,'Правый');
assert.equal(p.entities.right.instanceOf,independent);
assert.equal(p.entities.engine.instanceOf,base);
assert.equal(p.entities.right.children[0],rightPump);
assert.deepEqual(p.events[physical].conditions.items[0].refs,['hot',rhs]);
assert.deepEqual(p.events[physical].conditions.items[1].refs,[sensor]);
p.states.extra={owner:independent,name:'Форсаж',desc:''};
p.entities[base].parameters.oil.name='Масло основы';
p.states[member(p.entities.pump.instanceOf,'dry')].name='Изменённое состояние насоса';
syncPlacements(p,uid);validate(p);
assert.equal(p.entities.engine.parameters.oil.name,'Масло основы');
assert.equal(p.entities.right.parameters.oil.name,'Масло');
assert.equal(p.states[sensor].name,'Сухой');
assert(member('right','extra'));assert(!member('engine','extra'));
assert.equal(p.events.alarm.causes.items[0].ref,rhsEvent);
// A second room uses the original placement, including the original right motor.
p.entities.second={...ent('Вторая машинная'),instanceOf:roomBase};
p.entities.root.children.push('second');
syncPlacements(p,uid);validate(p);
assert.equal(p.entities[p.entities.second.children[1]].instanceOf,base);
const linked=structuredClone(p);
linked.events.check.conditions.items[0].refs=['hot'];
linked.events.check.conditions.items[0].paths=[['root','room','engine']];
syncPlacements(linked,uid);validate(linked);
assert(movePlacement(linked,['root','room','right'],['root','second'],uid));
syncPlacements(linked,uid);validate(linked);
assert(!linked.entities.room.children.includes('right'));
assert(linked.entities.second.children.includes('right'));
assert.equal(linked.states[rhs].owner,'right');
assert.equal(linked.events.alarm.causes.items[0].ref,rhsEvent);
assert.deepEqual(linked.events.alarm.conditions.items[0].paths[1],['root','second','right']);
assert.throws(()=>movePlacement(linked,['root','second'],['root','second','right'],uid),/самой себя/);
const persisted=structuredClone(linked);
syncPlacements(persisted,uid);assert.deepEqual(persisted,linked);
linked.events.check.conditions.items[0].paths=[['root','second','engine']];
validate(linked,1);
const reload=JSON.parse(JSON.stringify(p));syncPlacements(reload,uid);assert.deepEqual(reload,p);
const onShip=(obj,branch)=>{
  const scan=id=>id===obj.owner || p.entities[id].children.some(scan);
  return scan(branch.at(-1));
};
const graph=projectGraph(p,['root'],onShip);
assert(graph.nodes.some(n=>n.id===physical));assert(!graph.nodes.some(n=>n.id==='check'));
console.log('PASS migration, two engines, descendant conditions, independent nested fork, external IDs, reload');
