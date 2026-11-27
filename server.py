"""Local game design editor. Run with Python 3.10+ or Docker Compose."""
import json
import os
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", BASE / "data"))
DB = DATA / "editor.sqlite3"
ASSETS = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
          "/placements.js": ("placements.js", "text/javascript"),
          "/instances.js": ("instances.js", "text/javascript"),
          "/branch-text.js": ("branch-text.js", "text/javascript"),
          "/parameters.js": ("parameters.js", "text/javascript"),
          "/graph.js": ("graph.js", "text/javascript"), "/wires.js": ("wires.js", "text/javascript"), "/routes.js": ("routes.js", "text/javascript"), "/canvas.css": ("canvas.css", "text/css"), "/editor.js": ("editor.js", "text/javascript"), "/style.css": ("style.css", "text/css")}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(p):
    entities, states, events = (p[k] for k in ("entities", "states", "events"))
    for collection in (entities, states, events):
        require(isinstance(collection, dict), "Неверная коллекция")
        for key, obj in collection.items():
            require(key.isascii() and key.replace("-", "").isalnum(), "Неверный идентификатор")
            require(isinstance(obj["name"], str) and obj["name"].strip(), "Нужно название")
            require(isinstance(obj["desc"], str), "Нужно описание")
    require("root" in entities, "Нужна сущность проекта")
    for key, entity in entities.items():
        if "instanceOf" in entity:
            source = entity["instanceOf"]
            require(key != "root" and source in entities and source != "root" and
                    "instanceOf" not in entities[source] and "instanceId" not in entities[source],
                    "Неизвестная основа экземпляра")
    for collection in (entities, states, events):
        resolved = set()
        for key, obj in collection.items():
            if "instanceId" in obj:
                require(obj["instanceId"] in entities and "instanceOf" in entities[obj["instanceId"]]
                        and obj.get("sourceId") in collection and key != obj["sourceId"],
                        "Потеряна связь экземпляра с основой")
                chain = set()
                source = key
                while source not in resolved and "instanceId" in collection[source]:
                    require(source not in chain, "Цикл в основах экземпляров")
                    chain.add(source)
                    source = collection[source]["sourceId"]
                    require(source in collection, "Неизвестная основа")
                resolved.update(chain)
    if p.get("placementVersion") == 2:
        for entity in entities.values():
            require(all(k in entities and entities[k].get("instanceOf") for k in entity["children"]),
                    "В дереве можно размещать только экземпляры из пула")
        for collection in (states, events):
            for obj in collection.values():
                basis = entities.get(obj["owner"], {}).get("instanceOf")
                if basis:
                    require(obj.get("instanceId") == obj["owner"] and
                            collection.get(obj.get("sourceId"), {}).get("owner") == basis,
                            "Содержимое экземпляра должно принадлежать его основе")
    visited, active = set(), set()

    def coordinates(positions, allowed):
        require(isinstance(positions, dict) and positions.keys() <= set(allowed), "Неизвестная карточка на холсте")
        for point in positions.values():
            require(isinstance(point, list) and len(point) == 2 and
                    all(type(coord) is int and 0 <= coord <= 2000000 for coord in point),
                    "Неверные координаты")

    def visit(key):
        require(key in entities and key not in active, "Цикл или неизвестная сущность")
        if key in visited:
            return
        active.add(key)
        parameters = entities[key].get("parameters", {})
        require(isinstance(parameters, dict), "Неверный список параметров")
        for param_id, param in parameters.items():
            require(param_id.isascii() and param_id.replace("-", "").isalnum() and
                    isinstance(param, dict), "Неверный параметр")
            require(isinstance(param.get("name"), str) and param["name"].strip(), "Нужно название параметра")
            if "type" in param:
                require(param["type"] in ("number", "string", "boolean"), "Неизвестный тип параметра")
            else:  # Numeric definitions from older projects.
                value = param.get("value")
                require(type(value) in (int, float) and -sys.float_info.max <= value <= sys.float_info.max,
                        "Нужен тип параметра")
        children = entities[key]["children"]
        omitted = entities[key].get("omittedSlots", [])
        require(isinstance(omitted, list) and all(isinstance(slot, str) for slot in omitted),
                "Неверный список исключённых размещений")
        require(isinstance(children, list) and len(set(children)) == len(children)
                and "root" not in children, "Недопустимое вложение")
        positions = entities[key].get("positions", {})
        coordinates(positions, children)
        def sizes_for(layout, allowed):
            coordinates(layout, allowed)
            for width, height in layout.values():
                require(175 <= width <= 10000 and 100 <= height <= 10000
                        and width % 5 == height % 5 == 0, "Неверный размер карточки")

        for event_id, links in entities[key].get("eventLinks", {}).items():
            require(event_id in events and isinstance(links, dict), "Неизвестное событие связи")
            for role, link in links.items():
                require(role in ("incoming", "state-effects", "event-effects") and isinstance(link, dict),
                        "Неизвестный тип связи")
                if "position" in link:
                    coordinates({role: link["position"]}, [role])
                if "size" in link:
                    sizes_for({role: link["size"]}, [role])
                bends = link.get("bends", [])
                require(isinstance(bends, list), "Неверные точки стрелки")
                coordinates(dict(enumerate(bends)), range(len(bends)))

        sizes_for(entities[key].get("sizes", {}), children)
        for kind, view in entities[key].get("views", {}).items():
            require(kind in ("states", "events"), "Неизвестный холст")
            coordinates(view.get("positions", {}), children)
            sizes_for(view.get("sizes", {}), children)
        for kind, layout in entities[key].get("layerSizes", {}).items():
            require(kind in ("states", "events"), "Неизвестный холст")
            sizes_for(layout, events if kind == "events" else (k for k, obj in states.items() if obj["owner"] == key))
        layers = entities[key].get("layers", {})
        require(isinstance(layers, dict) and layers.keys() <= {"states", "events"}, "Неизвестное восприятие")
        for kind, layout in layers.items():
            coordinates(layout, events if kind == "events" else (i for i, obj in states.items() if obj["owner"] == key))
        for child in children:
            visit(child)
        if "instanceOf" in entities[key]:
            visit(entities[key]["instanceOf"])
        active.remove(key)
        visited.add(key)

    for key in entities:
        visit(key)
    for obj in [*states.values(), *events.values()]:
        require(obj["owner"] in entities, "Неизвестная сущность")

    def check_path(path, owner):
        if path is None:  # Older projects refer to the shared entity.
            return
        require(isinstance(path, list) and path and path[-1] == owner
                and all(key in entities for key in path)
                and all(b in entities[a]["children"] for a, b in zip(path, path[1:])),
                "Правило ссылается на это размещение. Измените путь в событии перед удалением связи.")

    def paths_for(obj, field, refs):
        paths = obj.get(field, [None] * len(refs))
        require(isinstance(paths, list) and len(refs) == len(paths), "Неполная группа путей")
        for key, path in zip(refs, paths):
            check_path(path, states[key]["owner"])
        return paths

    def parameter_type(node):
        owner, ref = node["owner"], node["ref"]
        require(owner in entities and ref in entities[owner].get("parameters", {}), "Неизвестный параметр")
        check_path(node.get("path"), owner)
        return entities[owner]["parameters"][ref].get("type", "number")

    def check_change(node):
        require(parameter_type(node) == "number", "Выберите числовой параметр")
        require(node["direction"] in ("up", "down"), "Выберите направление изменения")

    nodes = {"events:" + k for k in events} | {"states:" + k for k in states}
    nodes.update(f"parameters:{owner}:{k}" for owner, entity in entities.items()
                     for k in entity.get("parameters", {}))

    def rule(node, kind, event, outer=False):
        require(type(node["neg"]) is bool, "Неверное отрицание")
        op = node["op"]
        if op in ("and", "or", "not"):
            children = node["items"]
            require(isinstance(children, list) and (outer or children), "Заполните вложенную группу")
            if op == "not":
                require(len(children) == 1, "Область НЕ должна содержать один блок")
            for child in children:
                rule(child, kind, event)
        elif kind == "causes" and op == "event":
            require(node["ref"] in events, "Выберите событие")
        elif kind == "causes" and op == "player":
            action_id = node.get("id")
            require(isinstance(action_id, str) and re.fullmatch(r"[a-zA-Z0-9-]+", action_id),
                    "Неверный идентификатор действия игрока")
            require(isinstance(node.get("name"), str) and node["name"].strip(), "Опишите действие игрока")
            key = f"actions:{event_id}:{action_id}"
            require(key not in nodes, "Повтор идентификатора действия игрока")
            nodes.add(key)
        elif kind == "causes" and op == "change":
            check_change(node)
        elif kind == "conditions" and op == "parameter":
            param_type = parameter_type(node)
            if event.get("scope") == "local":
                require(node["owner"] == event["owner"] and node.get("path") == event.get("ownerPath"),
                        "Выберите параметр источника события")
            value, compare = node["value"], node["compare"]
            if param_type == "number":
                require(compare in ("lt", "le", "eq", "ge", "gt"), "Выберите знак сравнения")
                require(value == "constant" or (type(value) in (int, float) and 0 <= value <= 100),
                        "Укажите процент от 0 до 100 или выберите константу")
            elif param_type == "boolean":
                require(compare == "eq" and type(value) is bool, "Выберите Да или Нет")
            else:
                require(compare == "eq" and isinstance(value, str), "Введите строку для сравнения")
        elif kind == "conditions" and op == "self":
            refs = node["refs"]
            require(event.get("scope") == "local" and isinstance(refs, list) and len(refs) <= 1
                    and all(key in states and states[key]["owner"] == event["owner"] for key in refs),
                    "Выберите состояние источника события")
            require(paths_for(node, "paths", refs) == [event.get("ownerPath")] * len(refs),
                    "Неверное размещение источника")
        elif kind == "conditions" and op in ("all", "any"):

            refs = node["refs"]
            require(isinstance(refs, list) and refs and all(i in states for i in refs),
                    "Выберите сущности и состояние")
            paths = paths_for(node, "paths", refs)
            if event.get("scope") == "local":
                branch = event.get("ownerPath") or [event["owner"]]
                require(all(path and path[:len(branch)] == branch for path in paths),
                        "Выберите состояние источника события или его вложенной сущности")
            targets = {(states[key]["owner"], tuple(path or [])) for key, path in zip(refs, paths)}
            require(len(targets) == len(refs), "Повтор размещения в группе")
        else:
            raise ValueError("Неверный блок правила")

    for event_id, event in events.items():
        if "additionalCauses" in event:
            extra = event["additionalCauses"]
            require("instanceId" in event and isinstance(extra, list) and
                    all(k in events for k in extra), "Неизвестная причина события экземпляра")
        require(event.get("scope") in (None, "local", "global"), "Неизвестный тип события")
        require(event.get("scope") != "global" or event["owner"] == "root", "Глобальное событие принадлежит проекту")
        check_path(event.get("ownerPath"), event["owner"])
        for kind in ("conditions", "causes"):
            require(event[kind]["op"] in ("and", "or"), "Нужна группа правил")
            rule(event[kind], kind, event, True)
        require(isinstance(event["effects"], list) and all(i in states for i in event["effects"]),
                "Выберите состояние последствия")
        paths_for(event, "effectPaths", event["effects"])
        changes = event.get("parameterEffects", [])
        require(isinstance(changes, list), "Неверный список изменений параметров")
        for change in changes:
            check_change(change)

    for route, layout in p.get("graphLayouts", {}).items():
        require(isinstance(route, str) and isinstance(layout, dict), "Неверная раскладка схемы")
        chain = route.split("/")
        require(all(k in entities for k in chain) and
                all(b in entities[a]["children"] for a, b in zip(chain, chain[1:])), "Неизвестный холст")
        coordinates(layout["positions"], nodes)
        coordinates(layout["sizes"], nodes)
        for w, h in layout["sizes"].values():
            require(220 <= w <= 10000 and 100 <= h <= 10000, "Неверный размер карточки")
        for edge_key, bends in layout["bends"].items():
            parts = edge_key.split("|")
            require(len(parts) == 3 and parts[0] in nodes and parts[2] in nodes and
                    parts[1] in ("cause", "not-cause", "condition", "not-condition", "effect"), "Неизвестная связь")
            require(isinstance(bends, list), "Неверные точки поворота")
            coordinates(dict(enumerate(bends)), range(len(bends)))


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, data, mime="application/json"):
        if mime == "application/json":
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ASSETS:
            name, mime = ASSETS[path]
            return self.reply(200, (BASE / "static" / name).read_bytes(), mime)
        if path == "/api/projects":
            with sqlite3.connect(DB) as db:
                rows = db.execute("SELECT id, json_extract(body, '$.entities.root.name'), "
                                  "json_extract(body, '$.entities.root.desc') FROM project ORDER BY id DESC")
                projects = [dict(id=i, name=n, desc=d) for i, n, d in rows]
            return self.reply(200, {"projects": projects})
        key = self.project_key()
        if key:
            with sqlite3.connect(DB) as db:
                row = db.execute("SELECT version, body FROM project WHERE id=?", (key,)).fetchone()
            if row:
                return self.reply(200, {"id": key, "version": row[0], "project": json.loads(row[1])})
        self.reply(404, {"error": "Проект не найден"})

    def project_key(self):
        path = urlsplit(self.path).path
        if path == "/api/project":
            return 1
        match = re.fullmatch(r"/api/projects/([1-9][0-9]{0,17})", path)
        return int(match[1]) if match else None

    def packet(self):
        size = int(self.headers.get("Content-Length", 0))
        require(0 < size <= 16_000_000, "Размер проекта вне допустимых границ")
        origin = self.headers.get("Origin")
        require(not origin or urlsplit(origin).netloc == self.headers.get("Host"), "Неверный источник запроса")
        return json.loads(self.rfile.read(size))

    def do_POST(self):
        if self.path not in ("/api/projects", "/api/projects/import"):
            return self.reply(404, {})
        try:
            data = self.packet()
            require(isinstance(data, dict), "Ожидается объект проекта")
            if self.path == "/api/projects/import":
                project = data.get("project", data)
            else:
                root = {"name": data["name"], "desc": data["desc"], "children": [], "positions": {}}
                project = {"placementVersion": 2, "entities": {"root": root}, "states": {}, "events": {}}
            validate(project)
            with sqlite3.connect(DB) as db:
                key = db.execute("INSERT INTO project(version,body) VALUES(1,?)",
                                 (json.dumps(project, ensure_ascii=False),)).lastrowid
            self.reply(201, {"id": key, "version": 1, "project": project})
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError, IndexError) as exc:
            self.reply(400, {"error": str(exc)})

    def do_DELETE(self):
        key = self.project_key()
        if not key:
            return self.reply(404, {"error": "Проект не найден"})
        try:
            name = self.packet()["name"]
            require(isinstance(name, str) and name, "Введите название проекта")
            with sqlite3.connect(DB) as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT json_extract(body, '$.entities.root.name') FROM project WHERE id=?",
                                 (key,)).fetchone()
                if row is None:
                    return self.reply(404, {"error": "Проект уже удалён"})
                if row[0] != name:
                    return self.reply(409, {"error": "Название не совпадает с текущим названием проекта"})
                db.execute("DELETE FROM project WHERE id=?", (key,))
            self.reply(200, {"id": key})
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError, IndexError) as exc:
            self.reply(400, {"error": str(exc)})

    def do_PUT(self):
        key = self.project_key()
        if not key:
            return self.reply(404, {})
        try:
            packet = self.packet()
            require(type(packet["version"]) is int, "Неверная версия")
            validate(packet["project"])
            with sqlite3.connect(DB) as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT body FROM project WHERE id=? AND version=?", (key, packet["version"])).fetchone()
                if not row:
                    return self.reply(409, {"error": "Проект изменился в другой вкладке. Обновите страницу."})
                old_project = json.loads(row[0])
                modern = packet["project"].get("placementVersion") == 2
                require(old_project.get("placementVersion") != 2 or modern, "Обновите страницу редактора")
                migrating = modern and old_project.get("placementVersion") != 2
                previous = old_project["events"]
                for event_id, event in packet["project"]["events"].items():
                    old = previous.get(event_id)
                    if old and not migrating and old.get("scope") != "global":
                        require(all(old.get(field) == event.get(field) for field in ("owner", "ownerPath", "scope")),
                                "Источник привязанного события изменить нельзя")
                result = db.execute("UPDATE project SET body=?, version=version+1 WHERE id=? AND version=?",
                                    (json.dumps(packet["project"], ensure_ascii=False), key, packet["version"]))
                if not result.rowcount:
                    return self.reply(409, {"error": "Проект изменился в другой вкладке. Обновите страницу."})
            self.reply(200, {"version": packet["version"] + 1})
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError) as exc:
            self.reply(400, {"error": str(exc)})


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB) as conn:
        conn.execute("BEGIN IMMEDIATE")
        schema = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='project'").fetchone()
        # Keep a deleted project's URL from resolving to a newly created project.
        migrate = schema and "AUTOINCREMENT" not in schema[0].upper()
        if migrate:
            conn.execute("ALTER TABLE project RENAME TO project_old")
        conn.execute("CREATE TABLE IF NOT EXISTS project(id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, body TEXT)")
        if migrate:
            conn.execute("INSERT INTO project(id,version,body) SELECT id,version,body FROM project_old")
            conn.execute("DROP TABLE project_old")
    ThreadingHTTPServer((os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", 8787))), Handler).serve_forever()

