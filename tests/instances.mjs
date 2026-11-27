import assert from 'node:assert/strict';
import {refreshInstances} from '../static/instances.js';
import {projectGraph} from '../static/graph.js';
import {branchText} from '../static/branch-text.js';

const entity=(name,children=[])=>({name,children,desc:''});
const instance=(name,instanceOf)=>({...entity(name),instanceOf});
const group=(...items)=>({op:'and',neg:false,items});
const change=(owner,ref,direction)=>({owner,ref,direction,path:[owner]});
const project={
  entities:{root:entity('Корабль',['room']),room:entity('Машинное отделение',['left','right']),
    left:instance('Левый','engine'),right:instance('Правый','engine'),
    engine:{...entity('Двигатель',['sensor']),parameters:{oil:{name:'Масло',type:'number'},t:{name:'Температура',type:'number'}}},
    sensor:entity('Датчик')},
  states:{hot:{owner:'engine',name:'Перегрет',desc:''},alert:{owner:'sensor',name:'Тревога',desc:''}},
  events:{heat:{owner:'engine',ownerPath:['engine'],scope:'local',name:'Нагрев',desc:'',
    conditions:group({op:'self',neg:true,refs:['hot'],paths:[['engine']]}),
    causes:group({op:'change',neg:false,...change('engine','oil','down')}),
    effects:['hot','alert'],effectPaths:[['engine'],['engine','sensor']],parameterEffects:[change('engine','t','up')]},
    alarm:{owner:'sensor',ownerPath:['engine','sensor'],scope:'local',name:'Сигнал',desc:'',
      causes:group({op:'event',ref:'heat',neg:false}),conditions:group(),effects:[]}}
};
let serial=0;
const refresh=()=>refreshInstances(project,()=> 'generated-'+ ++serial);
const record=(kind,instance,source)=>Object.entries(project[kind]).find(([,o])=>o.instanceId===instance && o.sourceId===source);
refresh();
for(const side of ['left','right']){
  const [id,e]=record('events',side,'heat');
  const sensor=project.entities[side].children[0];
  assert.deepEqual(e.ownerPath,[side]);
  assert.equal(e.parameterEffects[0].owner,side);
  assert.equal(e.causes.items[0].owner,side);
  assert.deepEqual(e.conditions.items[0].refs,[record('states',side,'hot')[0]]);
  assert.deepEqual(e.effects,[record('states',side,'hot')[0],record('states',side,'alert')[0]]);
  assert.deepEqual(e.effectPaths,[[side],[side,sensor]]);
  assert.equal(record('events',side,'alarm')[1].causes.items[0].ref,id);
}
const [rightHeat]=record('events','right','heat');
project.events.external={owner:'room',scope:'local',name:'Ремонт',desc:'',conditions:group(),
  causes:group({op:'event',ref:rightHeat,neg:false}),effects:[],parameterEffects:[change('right','oil','up')]};
project.entities.engine.parameters.t.name='Температура масла';
project.events.heat.name='Нагрев двигателя';
project.entities.right.name='Правый двигатель';
refresh();
assert.equal(record('events','right','heat')[0],rightHeat);
assert.equal(record('events','left','heat')[1].name,'Нагрев двигателя');
assert.equal(project.entities.left.parameters.t.name,'Температура масла');
const inBranch=(obj,route)=>route.includes(obj.owner) || project.entities[route.at(-1)].children.includes(obj.owner);
const graph=projectGraph(project,['right'],inBranch);
assert(graph.nodes.some(n=>n.key==='parameters:right:t'));
assert(!graph.nodes.some(n=>n.key==='parameters:left:t'));
assert(graph.edges.some(e=>e.from==='events:'+rightHeat && e.to==='events:external'));
assert.match(branchText(project,['room'],inBranch),/Правый двигатель \(основа: Двигатель\)/);
const saved=JSON.stringify(project);
refresh();
assert.equal(JSON.stringify(project),saved);
// A room can itself be used as a source, including its named engines.
project.entities.secondRoom=instance('Вторая машинная','room');
project.entities.root.children.push('secondRoom');
refresh();
const secondRight=record('entities','secondRoom','right')[0];
const secondHeat=record('events','secondRoom',rightHeat)[0];
const secondRepair=record('events','secondRoom','external')[1];
assert.equal(secondRepair.parameterEffects[0].owner,secondRight);
assert.equal(secondRepair.causes.items[0].ref,secondHeat);
delete project.entities.secondRoom;
project.entities.root.children.pop();
refresh();
assert.equal(JSON.stringify(project),saved);
project.entities.engine.children.push('right');
assert.throws(refresh,/цикл/);
console.log('PASS independent engine rules, nested states, external links, stable IDs and shared updates');
