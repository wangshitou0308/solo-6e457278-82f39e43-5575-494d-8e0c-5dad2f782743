#!/usr/bin/env python3
"""
窑烧程序校对工具 —— 本地 HTTP 服务（仅使用 Python 标准库）

用法:
    python3 server.py                 # 默认 http://127.0.0.1:8000
    python3 server.py --port 8080
    python3 server.py --host 0.0.0.0 # 允许局域网访问（默认仅本机）
    python3 server.py --db kiln.db

数据保存在同目录的 kiln.db (SQLite)。不连接窑炉或任何外部平台。
"""

import argparse
import json
import os
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

DB_PATH = os.path.join(BASE_DIR, "kiln.db")
DB_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS kilns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    config      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kiln_id     INTEGER NOT NULL REFERENCES kilns(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
"""


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------- API

def api_list_kilns(conn, query):
    rows = conn.execute(
        "SELECT k.id, k.name, k.config, k.updated_at, "
        "(SELECT COUNT(*) FROM plans p WHERE p.kiln_id = k.id) AS plan_count "
        "FROM kilns k ORDER BY k.id"
    ).fetchall()
    return [dict(r) for r in rows]


def api_create_kiln(conn, body):
    name = str(body.get("name", "")).strip() or "未命名窑炉"
    config = json.dumps(body.get("config", {}), ensure_ascii=False)
    cur = conn.execute(
        "INSERT INTO kilns(name, config) VALUES(?,?)", (name, config))
    conn.commit()
    return {"id": cur.lastrowid}


def api_update_kiln(conn, kiln_id, body):
    name = str(body.get("name", "")).strip() or "未命名窑炉"
    config = json.dumps(body.get("config", {}), ensure_ascii=False)
    conn.execute(
        "UPDATE kilns SET name=?, config=?, "
        "updated_at=datetime('now','localtime') WHERE id=?",
        (name, config, kiln_id))
    conn.commit()
    return {"ok": True}


def api_delete_kiln(conn, kiln_id):
    conn.execute("DELETE FROM kilns WHERE id=?", (kiln_id,))
    conn.commit()
    return {"ok": True}


def api_list_plans(conn, query):
    if "kiln_id" in query:
        rows = conn.execute(
            "SELECT id, kiln_id, name, updated_at FROM plans "
            "WHERE kiln_id=? ORDER BY id", (query["kiln_id"],)).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, kiln_id, name, updated_at FROM plans ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


def api_create_plan(conn, body):
    kiln_id = int(body["kiln_id"])
    name = str(body.get("name", "")).strip() or "未命名方案"
    data = json.dumps(body.get("data", {"startTemp": 20, "segments": []}),
                      ensure_ascii=False)
    cur = conn.execute(
        "INSERT INTO plans(kiln_id, name, data) VALUES(?,?,?)",
        (kiln_id, name, data))
    conn.commit()
    return {"id": cur.lastrowid}


def api_update_plan(conn, plan_id, body):
    name = str(body.get("name", "")).strip() or "未命名方案"
    data = json.dumps(body.get("data", {}), ensure_ascii=False)
    conn.execute(
        "UPDATE plans SET name=?, data=?, "
        "updated_at=datetime('now','localtime') WHERE id=?",
        (name, data, plan_id))
    conn.commit()
    return {"ok": True}


def api_delete_plan(conn, plan_id):
    conn.execute("DELETE FROM plans WHERE id=?", (plan_id,))
    conn.commit()
    return {"ok": True}


def api_get_plan(conn, plan_id):
    row = conn.execute(
        "SELECT id, kiln_id, name, data, updated_at FROM plans WHERE id=?",
        (plan_id,)).fetchone()
    if not row:
        return None
    result = dict(row)
    versions = conn.execute(
        "SELECT id, label, created_at FROM versions WHERE plan_id=? "
        "ORDER BY id DESC", (plan_id,)).fetchall()
    result["versions"] = [dict(v) for v in versions]
    return result


def api_list_versions(conn, plan_id):
    rows = conn.execute(
        "SELECT id, plan_id, label, data, created_at FROM versions "
        "WHERE plan_id=? ORDER BY id", (plan_id,)).fetchall()
    return [dict(r) for r in rows]


def api_create_version(conn, plan_id, body):
    label = str(body.get("label", "")).strip() or "版本"
    data = json.dumps(body.get("data", {}), ensure_ascii=False)
    cur = conn.execute(
        "INSERT INTO versions(plan_id, label, data) VALUES(?,?,?)",
        (plan_id, label, data))
    conn.commit()
    return {"id": cur.lastrowid}


def api_get_version(conn, version_id):
    row = conn.execute(
        "SELECT id, plan_id, label, data, created_at FROM versions WHERE id=?",
 (version_id,)).fetchone()
    return dict(row) if row else None


def api_delete_version(conn, version_id):
    conn.execute("DELETE FROM versions WHERE id=?", (version_id,))
    conn.commit()
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "KilnPlanner/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(),
                                        fmt % args))

    # ---------- helpers ----------
    def send_json(self, obj, status=200):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ValueError("请求体不是合法 JSON")

    def query_params(self):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        return {k: v[0] for k, v in q.items()}

    def serve_static(self, rel):
        rel = rel.lstrip("/")
        if rel in ("", "index.html"):
            rel = "index.html"
        path = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not path.startswith(STATIC_DIR) or not os.path.isfile(path):
            self.send_error(404, "Not Found")
            return
        ext = os.path.splitext(path)[1].lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
            ".json": "application/json; charset=utf-8",
        }.get(ext, "application/octet-stream")
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404, "Not Found")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # 静态资源允许离线缓存（应用壳），数据接口不缓存
        self.send_header("Cache-Control", "max-age=0")
        self.end_headers()
        self.wfile.write(data)

    # ---------- dispatch ----------
    def do_GET(self):
        from urllib.parse import urlparse
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if not parts or parts[0] == "index.html":
            self.serve_static("index.html")
            return
        if parts[0] != "api":
            self.serve_static("/".join(parts))
            return
        query = self.query_params()
        try:
            with DB_LOCK, get_db() as conn:
                if parts == ["api", "kilns"]:
                    return self.send_json(api_list_kilns(conn, query))
                if parts == ["api", "plans"]:
                    return self.send_json(api_list_plans(conn, query))
                if len(parts) == 3 and parts[1] == "plans":
                    result = api_get_plan(conn, int(parts[2]))
                    return (self.send_json(result) if result
                            else self.send_error_json(404, "方案不存在"))
                if (len(parts) == 4 and parts[1] == "plans"
                        and parts[3] == "versions"):
                    return self.send_json(
                        api_list_versions(conn, int(parts[2])))
                if len(parts) == 3 and parts[1] == "versions":
                    result = api_get_version(conn, int(parts[2]))
                    return (self.send_json(result) if result
                            else self.send_error_json(404, "版本不存在"))
            self.send_error_json(404, "未知接口")
        except (ValueError, IndexError) as exc:
            self.send_error_json(400, "请求参数无效: %s" % exc)
        except sqlite3.Error as exc:
            self.send_error_json(500, "数据库错误: %s" % exc)

    def do_POST(self):
        from urllib.parse import urlparse
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) < 2 or parts[0] != "api":
            self.send_error_json(404, "未知接口")
            return
        try:
            body = self.read_body()
            with DB_LOCK, get_db() as conn:
                if parts == ["api", "kilns"]:
                    return self.send_json(api_create_kiln(conn, body))
                if parts == ["api", "plans"]:
                    return self.send_json(api_create_plan(conn, body))
                if (len(parts) == 4 and parts[1] == "plans"
                        and parts[3] == "versions"):
                    result = api_create_version(conn, int(parts[2]), body)
                    return self.send_json(result)
            self.send_error_json(404, "未知接口")
        except ValueError as exc:
            self.send_error_json(400, str(exc))
        except (KeyError, IndexError, TypeError) as exc:
            self.send_error_json(400, "请求参数无效: %s" % exc)
        except sqlite3.Error as exc:
            self.send_error_json(500, "数据库错误: %s" % exc)

    def do_PUT(self):
        from urllib.parse import urlparse
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        try:
            body = self.read_body()
            with DB_LOCK, get_db() as conn:
                if len(parts) == 3 and parts[1] == "kilns":
                    api_update_kiln(conn, int(parts[2]), body)
                    return self.send_json({"ok": True})
                if len(parts) == 3 and parts[1] == "plans":
                    api_update_plan(conn, int(parts[2]), body)
                    return self.send_json({"ok": True})
            self.send_error_json(404, "未知接口")
        except ValueError as exc:
            self.send_error_json(400, str(exc))
        except (KeyError, IndexError, TypeError) as exc:
            self.send_error_json(400, "请求参数无效: %s" % exc)
        except sqlite3.Error as exc:
            self.send_error_json(500, "数据库错误: %s" % exc)

    def do_DELETE(self):
        from urllib.parse import urlparse
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        try:
            with DB_LOCK, get_db() as conn:
                if len(parts) == 3 and parts[1] == "kilns":
                    api_delete_kiln(conn, int(parts[2]))
                    return self.send_json({"ok": True})
                if len(parts) == 3 and parts[1] == "plans":
                    api_delete_plan(conn, int(parts[2]))
                    return self.send_json({"ok": True})
                if len(parts) == 3 and parts[1] == "versions":
                    api_delete_version(conn, int(parts[2]))
                    return self.send_json({"ok": True})
            self.send_error_json(404, "未知接口")
        except (ValueError, IndexError) as exc:
            self.send_error_json(400, "请求参数无效: %s" % exc)
        except sqlite3.Error as exc:
            self.send_error_json(500, "数据库错误: %s" % exc)


def main():
    global DB_PATH
    parser = argparse.ArgumentParser(description="窑烧程序校对本地工具")
    parser.add_argument("--host", default="127.0.0.1",
                        help="监听地址，默认 127.0.0.1（仅本机）")
    parser.add_argument("--port", type=int, default=8000, help="端口")
    parser.add_argument("--db", default=DB_PATH, help="SQLite 数据库路径")
    args = parser.parse_args()
    DB_PATH = os.path.abspath(args.db)

    init_db()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = "http://%s:%d/" % ("localhost" if args.host in
                             ("127.0.0.1", "0.0.0.0") else args.host,
                             args.port)
    print("窑烧程序校对工具已启动: %s" % url)
    print("数据文件: %s" % DB_PATH)
    print("按 Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        httpd.server_close()


if __name__ == "__main__":
    main()
