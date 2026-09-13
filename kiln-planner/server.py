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
from datetime import datetime
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
CREATE TABLE IF NOT EXISTS firings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    meta        TEXT NOT NULL,
    samples     TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS cone_sheets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    kiln_id     INTEGER NOT NULL REFERENCES kilns(id) ON DELETE CASCADE,
    firing_id   INTEGER REFERENCES firings(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft',
    data        TEXT NOT NULL,
    snapshot    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
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


# ---- 烧成记录（实际烧成复盘）：只读引用方案，绝不改写方案数据 ----

def api_list_firings(conn, plan_id):
    rows = conn.execute(
        "SELECT id, plan_id, name, sample_count, created_at FROM firings "
        "WHERE plan_id=? ORDER BY id DESC", (plan_id,)).fetchall()
    return [dict(r) for r in rows]


def api_create_firing(conn, plan_id, body):
    name = str(body.get("name", "")).strip() or "未命名烧成记录"
    meta = body.get("meta", {})
    samples = body.get("samples", [])
    if not isinstance(samples, list) or len(samples) < 2:
        raise ValueError("烧成记录至少需要 2 个采样点")
    if len(samples) > 200000:
        raise ValueError("采样点超过 200000，请先在控制器侧降采样后再导入")
    clean = []
    for s in samples:
        if not isinstance(s, (list, tuple)) or len(s) < 3:
            raise ValueError("采样点格式无效（应为 [分钟, 温度, CSV行号, 原始时间]）")
        t, temp = s[0], s[1]
        if (not isinstance(t, (int, float))
                or not isinstance(temp, (int, float))):
            raise ValueError("采样点包含非数值")
        clean.append([t, temp, int(s[2]),
                      str(s[3])[:64] if len(s) > 3 else ""])
    cur = conn.execute(
        "INSERT INTO firings(plan_id, name, meta, samples, sample_count) "
        "VALUES(?,?,?,?,?)",
        (plan_id, name, json.dumps(meta, ensure_ascii=False),
         json.dumps(clean, ensure_ascii=False), len(clean)))
    conn.commit()
    return {"id": cur.lastrowid}


def api_get_firing(conn, firing_id):
    row = conn.execute(
        "SELECT id, plan_id, name, meta, samples, created_at FROM firings "
        "WHERE id=?", (firing_id,)).fetchone()
    return dict(row) if row else None


def api_update_firing(conn, firing_id, body):
    # 仅允许改名与更新元信息（如分析参数），实测样本保存后不可改写
    name = str(body.get("name", "")).strip() or "未命名烧成记录"
    meta = json.dumps(body.get("meta", {}), ensure_ascii=False)
    conn.execute("UPDATE firings SET name=?, meta=? WHERE id=?",
                 (name, meta, firing_id))
    conn.commit()
    return {"ok": True}


def api_delete_firing(conn, firing_id):
    conn.execute("DELETE FROM firings WHERE id=?", (firing_id,))
    conn.commit()
    return {"ok": True}


# ---- 见证锥复核观测单：草稿 → 已锁定 → 待判读 → 已封存（单向流转） ----
CONE_FLOW = {"draft": ["locked"], "locked": ["reading"],
             "reading": [], "sealed": []}
CONE_ROLE_NAMES = {"guide": "引导锥", "target": "目标锥", "guard": "保护锥"}
CONE_POS_EPS = 0.05          # 重位判定阈值（归一化坐标）


def _cone_placement(data):
    """提取布点（不含判读结果）；锁定后这部分必须保持不变。"""
    layers = []
    for ly in data.get("layers", []):
        packs = []
        for p in ly.get("packs", []):
            cones = [{"role": c.get("role"), "coneNo": c.get("coneNo"),
                      "expected": c.get("expected")}
                     for c in p.get("cones", [])]
            packs.append({"id": p.get("id"), "x": p.get("x"), "y": p.get("y"),
                          "note": p.get("note", ""), "cones": cones})
        layers.append({"id": ly.get("id"), "name": ly.get("name"),
                       "orient": ly.get("orient", 0), "packs": packs})
    return {"layers": layers, "grades": data.get("grades", [])}


def _cone_unread(data):
    n = 0
    for ly in data.get("layers", []):
        for p in ly.get("packs", []):
            for c in p.get("cones", []):
                if not c.get("result"):
                    n += 1
    return n


def _cone_validate(data):
    """锁定前检查：重位 / 缺号 / 层板越界 / 等级排序。返回错误文本列表。"""
    errs = []
    layers = data.get("layers") or []
    if not layers:
        errs.append("至少需要一个层板")
    npacks = 0
    for li, ly in enumerate(layers):
        lname = ly.get("name") or ("第 %d 层" % (li + 1))
        packs = ly.get("packs") or []
        npacks += len(packs)
        for pi, p in enumerate(packs):
            where = "%s 布点#%d" % (lname, pi + 1)
            x, y = p.get("x"), p.get("y")
            if (not isinstance(x, (int, float))
                    or not isinstance(y, (int, float))
                    or isinstance(x, bool) or isinstance(y, bool)
                    or not (0 <= x <= 1) or not (0 <= y <= 1)):
                errs.append(where + " 超出层板范围")
            roles = [c.get("role") for c in p.get("cones", [])]
            for need, label in CONE_ROLE_NAMES.items():
                if need not in roles:
                    errs.append("%s 缺少%s" % (where, label))
            if any(not str(c.get("coneNo") or "").strip()
                   for c in p.get("cones", [])):
                errs.append(where + " 有锥未填锥号")
        for i in range(len(packs)):
            for j in range(i + 1, len(packs)):
                xi, yi = packs[i].get("x"), packs[i].get("y")
                xj, yj = packs[j].get("x"), packs[j].get("y")
                if all(isinstance(v, (int, float)) and not isinstance(v, bool)
                       for v in (xi, yi, xj, yj)):
                    if (xi - xj) ** 2 + (yi - yj) ** 2 < CONE_POS_EPS ** 2:
                        errs.append("%s 布点#%d 与 #%d 重位"
                                    % (lname, i + 1, j + 1))
    if layers and not npacks:
        errs.append("至少放置一个锥组")
    ranks = [g.get("rank") for g in data.get("grades", [])
             if isinstance(g, dict) and g.get("rank") is not None]
    if len(ranks) != len(set(ranks)):
        errs.append("判读等级的排序值必须唯一（自定义等级须明确排序）")
    return errs


def api_list_conesheets(conn, plan_id):
    rows = conn.execute(
        "SELECT c.id, c.plan_id, c.kiln_id, c.firing_id, c.name, c.status, "
        "c.created_at, c.updated_at, "
        "(SELECT name FROM firings f WHERE f.id = c.firing_id) AS firing_name "
        "FROM cone_sheets c WHERE c.plan_id=? ORDER BY c.id DESC",
        (plan_id,)).fetchall()
    return [dict(r) for r in rows]


def api_create_conesheet(conn, plan_id, body):
    plan = conn.execute("SELECT id, kiln_id FROM plans WHERE id=?",
                        (plan_id,)).fetchone()
    if not plan:
        raise ValueError("方案不存在")
    name = str(body.get("name", "")).strip() or "未命名观测单"
    data = body.get("data") or {}
    status = str(body.get("status") or "draft")
    if status not in ("draft", "locked", "reading", "sealed"):
        raise ValueError("观测单状态无效")
    if status != "draft":
        errs = _cone_validate(data)
        if errs:
            raise ValueError("数据未通过检查：" + "；".join(errs[:6]))
    snapshot = body.get("snapshot")
    if status == "sealed":
        missing = _cone_unread(data)
        if missing:
            raise ValueError("还有 %d 个点位未判读，不能封存" % missing)
        if not snapshot:
            snapshot = {"sealedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "data": data, "analysis": body.get("analysis")}
    cur = conn.execute(
        "INSERT INTO cone_sheets(plan_id, kiln_id, firing_id, name, status, "
        "data, snapshot) VALUES(?,?,?,?,?,?,?)",
        (plan_id, plan["kiln_id"], body.get("firing_id"), name, status,
         json.dumps(data, ensure_ascii=False),
         json.dumps(snapshot, ensure_ascii=False) if snapshot else None))
    conn.commit()
    return {"id": cur.lastrowid}


def api_get_conesheet(conn, sheet_id):
    row = conn.execute(
        "SELECT c.id, c.plan_id, c.kiln_id, c.firing_id, c.name, c.status, "
        "c.data, c.snapshot, c.created_at, c.updated_at, "
        "(SELECT name FROM firings f WHERE f.id = c.firing_id) AS firing_name "
        "FROM cone_sheets c WHERE c.id=?", (sheet_id,)).fetchone()
    return dict(row) if row else None


def api_update_conesheet(conn, sheet_id, body):
    row = conn.execute("SELECT * FROM cone_sheets WHERE id=?",
                       (sheet_id,)).fetchone()
    if not row:
        return None
    status = row["status"]
    if status == "sealed":
        raise ValueError("观测单已封存，快照不可变，不能再修改")
    data = json.loads(row["data"])
    new_data = body.get("data", data)
    new_status = str(body.get("status") or status)
    if new_status != status and new_status not in CONE_FLOW[status]:
        raise ValueError("观测单状态只能按 草稿→已锁定→待判读→已封存 流转")
    if status != "draft":
        if _cone_placement(new_data) != _cone_placement(data):
            raise ValueError("锁定后布点与判读等级不可再改动")
        if status == "locked" and _cone_unread(new_data) > 0:
            raise ValueError("请先「出窑判读」再登记判读结果")
    if new_status == "locked":
        errs = _cone_validate(new_data)
        if errs:
            raise ValueError("锁定前请先修正：" + "；".join(errs[:6]))
    name = str(body.get("name", row["name"])).strip() or row["name"]
    firing_id = body.get("firing_id", row["firing_id"])
    conn.execute(
        "UPDATE cone_sheets SET name=?, firing_id=?, status=?, data=?, "
        "updated_at=datetime('now','localtime') WHERE id=?",
        (name, firing_id, new_status,
         json.dumps(new_data, ensure_ascii=False), sheet_id))
    conn.commit()
    return {"ok": True}


def api_seal_conesheet(conn, sheet_id, body):
    row = conn.execute("SELECT * FROM cone_sheets WHERE id=?",
                       (sheet_id,)).fetchone()
    if not row:
        return None
    if row["status"] == "sealed":
        raise ValueError("观测单已封存")
    if row["status"] != "reading":
        raise ValueError("只有「待判读」状态才能封存")
    data = json.loads(row["data"])
    missing = _cone_unread(data)
    if missing:
        raise ValueError("还有 %d 个点位未判读，全部处理后才能封存" % missing)
    snapshot = {
        "sealedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "data": data,                      # 以库内数据为准，保证快照与观测单一致
        "analysis": body.get("analysis"),  # 前端算好的冷热差/待复核结果
    }
    conn.execute(
        "UPDATE cone_sheets SET status='sealed', snapshot=?, "
        "updated_at=datetime('now','localtime') WHERE id=?",
        (json.dumps(snapshot, ensure_ascii=False), sheet_id))
    conn.commit()
    return {"ok": True}


def api_delete_conesheet(conn, sheet_id):
    row = conn.execute("SELECT status FROM cone_sheets WHERE id=?",
                       (sheet_id,)).fetchone()
    if not row:
        return None
    if row["status"] == "sealed":
        raise ValueError("观测单已封存，快照不可删除")
    conn.execute("DELETE FROM cone_sheets WHERE id=?", (sheet_id,))
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
                if (len(parts) == 4 and parts[1] == "plans"
                        and parts[3] == "firings"):
                    return self.send_json(
                        api_list_firings(conn, int(parts[2])))
                if (len(parts) == 4 and parts[1] == "plans"
                        and parts[3] == "conesheets"):
                    return self.send_json(
                        api_list_conesheets(conn, int(parts[2])))
                if len(parts) == 3 and parts[1] == "conesheets":
                    result = api_get_conesheet(conn, int(parts[2]))
                    return (self.send_json(result) if result
                            else self.send_error_json(404, "观测单不存在"))
                if len(parts) == 3 and parts[1] == "firings":
                    result = api_get_firing(conn, int(parts[2]))
                    return (self.send_json(result) if result
                            else self.send_error_json(404, "烧成记录不存在"))
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
                if (len(parts) == 4 and parts[1] == "plans"
                        and parts[3] == "firings"):
                    result = api_create_firing(conn, int(parts[2]), body)
                    return self.send_json(result)
                if (len(parts) == 4 and parts[1] == "plans"
                        and parts[3] == "conesheets"):
                    result = api_create_conesheet(conn, int(parts[2]), body)
                    return self.send_json(result)
                if (len(parts) == 4 and parts[1] == "conesheets"
                        and parts[3] == "seal"):
                    result = api_seal_conesheet(conn, int(parts[2]), body)
                    return (self.send_json(result) if result
                            else self.send_error_json(404, "观测单不存在"))
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
                if len(parts) == 3 and parts[1] == "firings":
                    api_update_firing(conn, int(parts[2]), body)
                    return self.send_json({"ok": True})
                if len(parts) == 3 and parts[1] == "conesheets":
                    result = api_update_conesheet(conn, int(parts[2]), body)
                    return (self.send_json(result) if result
                            else self.send_error_json(404, "观测单不存在"))
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
                if len(parts) == 3 and parts[1] == "firings":
                    api_delete_firing(conn, int(parts[2]))
                    return self.send_json({"ok": True})
                if len(parts) == 3 and parts[1] == "conesheets":
                    result = api_delete_conesheet(conn, int(parts[2]))
                    return (self.send_json(result) if result
                            else self.send_error_json(404, "观测单不存在"))
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
