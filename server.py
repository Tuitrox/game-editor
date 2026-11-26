"""Local game design editor. Run with Python 3.10+ or Docker Compose."""
import json
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", BASE / "data"))
DB = DATA / "editor.sqlite3"
ASSETS = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
          "/wires.js": ("wires.js", "text/javascript"), "/routes.js": ("routes.js", "text/javascript"), "/canvas.css": ("canvas.css", "text/css"), "/editor.js": ("editor.js", "text/javascript"), "/style.css": ("style.css", "text/css")}


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
        children = entities[key]["children"]
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
        elif kind == "conditions" and op == "self":
            refs = node["refs"]
            require(event.get("scope") == "local" and isinstance(refs, list) and len(refs) <= 1
                    and all(key in states and states[key]["owner"] == event["owner"] for key in refs),
                    "Выберите состояние источника события")
            require(paths_for(node, "paths", refs) == [event.get("ownerPath")] * len(refs),
                    "Неверное размещение источника")
        elif kind == "conditions" and op in ("all", "any"):
            require(event.get("scope") != "local", "Группы сущностей доступны в глобальных событиях")
            refs = node["refs"]
            require(isinstance(refs, list) and refs and all(i in states for i in refs),
                    "Выберите сущности и состояние")
            paths = paths_for(node, "paths", refs)
            targets = {(states[key]["owner"], tuple(path or [])) for key, path in zip(refs, paths)}
            require(len(targets) == len(refs), "Повтор размещения в группе")
        else:
            raise ValueError("Неверный блок правила")

    for event in events.values():
        require(event.get("scope") in (None, "local", "global"), "Неизвестный тип события")
        require(event.get("scope") != "global" or event["owner"] == "root", "Глобальное событие принадлежит проекту")
        check_path(event.get("ownerPath"), event["owner"])
        for kind in ("conditions", "causes"):
            require(event[kind]["op"] in ("and", "or"), "Нужна группа правил")
            rule(event[kind], kind, event, True)
        require(isinstance(event["effects"], list) and all(i in states for i in event["effects"]),
                "Выберите состояние последствия")
        paths_for(event, "effectPaths", event["effects"])


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
        if self.path != "/api/projects":
            return self.reply(404, {})
        try:
            data = self.packet()
            root = {"name": data["name"], "desc": data["desc"], "children": [], "positions": {}}
            project = {"entities": {"root": root}, "states": {}, "events": {}}
            validate(project)
            with sqlite3.connect(DB) as db:
                key = db.execute("INSERT INTO project(version,body) VALUES(1,?)",
                                 (json.dumps(project, ensure_ascii=False),)).lastrowid
            self.reply(201, {"id": key, "version": 1, "project": project})
        except (ValueError, TypeError, KeyError) as exc:
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
                previous = json.loads(row[0])["events"]
                for event_id, event in packet["project"]["events"].items():
                    old = previous.get(event_id)
                    if old and old.get("scope") != "global":
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
        conn.execute("CREATE TABLE IF NOT EXISTS project(id INTEGER PRIMARY KEY, version INTEGER, body TEXT)")
    ThreadingHTTPServer((os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", 8787))), Handler).serve_forever()

