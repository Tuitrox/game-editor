// Routes are stored as entity IDs. Labels may be renamed independently.
export function pathLabel(project, route){
  return route.map(key=>project.entities[key].name).join(' › ');
}
export function* entityRoutes(project){
  const entities=project.entities, nested=new Set(Object.values(entities).flatMap(e=>e.children));
  function* walk(route){
    yield route;
    for(const child of entities[route.at(-1)].children)yield* walk([...route,child]);
  }
  for(const key of Object.keys(entities))if(!nested.has(key))yield* walk([key]);
}
