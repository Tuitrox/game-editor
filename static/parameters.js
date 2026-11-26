export const parameterTypes = {number:'Число', string:'Строка', boolean:'Да / нет'};
export const comparisons = {lt:'<', le:'≤', eq:'=', ge:'≥', gt:'>'};
export const changeDirections = {up:'Увеличилось', down:'Уменьшилось'};

export function changeText(project,change){
  return project.entities[change.owner].parameters[change.ref].name+' · '+changeDirections[change.direction];
}

export function parameterTest(project, rule) {
  const param = project.entities[rule.owner].parameters[rule.ref];
  let value = rule.value === 'constant' ? 'Константа' : rule.value + '%';
  if (param.type === 'string') value = '«' + rule.value + '»';
  if (param.type === 'boolean') value = rule.value ? 'Да' : 'Нет';
  return param.name + ' ' + comparisons[rule.compare] + ' ' + value;
}
