"use strict";
/* =====================================================================
 * 窑烧程序校对工具 —— 前端（原生 HTML/CSS/JS/SVG，无外部依赖，可离线）
 * =================================================================== */

/* ----------------------------- 常量与默认值 ----------------------------- */
const RATE_TOL = 0.01;          // 速率取整相对偏差超过 1% 即标注
const ZERO_JUMP_MIN = 1;        // 升温耗时不足 1 分钟视为零时长跳温
const HISTORY_LIMIT = 100;
const LS = {
  kilns: "kp:local:kilns",
  plans: "kp:local:plans",
  versions: "kp:local:versions",
  firings: "kp:local:firings",
  seq: "kp:local:seq",
  draft: "kp:draft",
};

const DEFAULT_KILN = {
  maxTemp: 1280,
  heatRateMax: 150,
  coolRateMax: 100,
  maxSegments: 16,
  rateStep: 1,
  tempStep: 1,
  holdStep: 1,
};

const KILN_FIELDS = [
  ["maxTemp", "温度上限", "°C", 1],
  ["heatRateMax", "最大升温速率", "°C/h", 1],
  ["coolRateMax", "最大降温速率", "°C/h", 1],
  ["maxSegments", "控制器段数", "段", 1],
  ["rateStep", "速率步进", "°C/h", 0.1],
  ["tempStep", "温度步进", "°C", 1],
  ["holdStep", "时长步进", "min", 1],
];

/* ----------------------------- 小工具 ----------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function qRound(v, step) {
  if (!step || step <= 0) return v;
  return Math.round(v / step) * step;
}
// 消除浮点尾差（保留 3 位小数）
function tidy(v) { return Math.round(v * 1000) / 1000; }
function fmtMin(m) {
  if (!Number.isFinite(m)) return "—";
  const neg = m < 0;
  m = Math.round(Math.abs(m));
  const h = Math.floor(m / 60), mm = m % 60;
  return (neg ? "-" : "") + h + ":" + String(mm).padStart(2, "0");
}
function fmtDelta(m) {
  const r = Math.round(m);
  return (r >= 0 ? "+" : "−") + Math.abs(r) + " 分钟";
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function nowLabel() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* =====================================================================
 * 内置示例（可编辑：载入后与普通方案完全一致）
 * =================================================================== */
function examples() {
  // 示例 1：典型电窑釉烧（含一处降温超能力 + 若干取整偏移）
  const glaze = {
    kilnName: "示例电窑（16 段）",
    kilnConfig: { maxTemp: 1280, heatRateMax: 150, coolRateMax: 100,
                  maxSegments: 16, rateStep: 5, tempStep: 5, holdStep: 5 },
    planName: "示例 · 高温釉烧 1240℃",
    plan: {
      startTemp: 25,
      segments: [
        { rate: 100, target: 600, hold: 0 },
        { rate: 80,  target: 1050, hold: 10 },
        { rate: 33,  target: 1240, hold: 20 },
        { rate: 130, target: 900, hold: 0 },   // 全窑降温，130 > 100 → 能力不足
        { rate: 80,  target: 80,  hold: 0 },
      ],
    },
  };
  // 示例 2：素烧（干净、全部合法）
  const bisque = {
    kilnName: "示例电窑（16 段）",
    kilnConfig: glaze.kilnConfig,
    planName: "示例 · 素烧 1000℃",
    plan: {
      startTemp: 20,
      segments: [
        { rate: 80,  target: 200, hold: 10 },
        { rate: 120, target: 600, hold: 0 },
        { rate: 70,  target: 1000, hold: 15 },
        { rate: 60,  target: 200, hold: 0 },
      ],
    },
  };
  // 示例 3：故意制造各类问题（超温 / 超能力 / 零跳温 / 段数溢出 / 取整）
  const bad = {
    kilnName: "小控制器窑（8 段）",
    kilnConfig: { maxTemp: 1230, heatRateMax: 120, coolRateMax: 80,
                  maxSegments: 8, rateStep: 10, tempStep: 10, holdStep: 10 },
    planName: "示例 · 问题演示曲线",
    plan: { startTemp: 20, segments: [] },
  };
  {
    const s = bad.plan.segments;
    let t = 20;
    // 8 个正常阶梯升温段
    for (let i = 0; i < 8; i++) {
      const target = t + 130;
      s.push({ rate: 100, target, hold: i === 3 ? 12 : 0 });
      t = target;
  }
    // 继续追加 → 段数溢出
    s.push({ rate: 150, target: 1260, hold: 8 });        // 超温 1260>1230
    s.push({ rate: 2000, target: 1265, hold: 0 });       // 能力不足 + 零跳温
    s.push({ rate: 63, target: 500, hold: 33 });         // 取整偏移 63→60、33→30
    s.push({ rate: 3000, target: 1100, hold: 7 });       // 零时长跳温
  }
  return [
    { name: "高温釉烧（1 处能力不足 + 取整偏移）", ...glaze },
    { name: "素烧曲线（全部合法）", ...bisque },
    { name: "问题演示（超温/超能力/零跳温/溢出/取整）", ...bad },
  ];
}

/* =====================================================================
 * 核心：把计划编译成控制器步骤并生成校验问题
 * 纯函数，便于测试。
 * =================================================================== */
function buildModel(plan, kiln) {
  const cfg = Object.assign({}, DEFAULT_KILN, kiln || {});
  const segs = [];
  const issues = [];
  const startTemp = num(plan.startTemp, NaN);
  const startValid = Number.isFinite(startTemp);
  const startT = startValid ? startTemp : 20;

  const addIssue = (sev, code, title, desc, nodeId, segIndex) =>
    issues.push({ sev, code, title, desc, nodeId, segIndex });

  if (!startValid) addIssue("error", "invalid", "起始温度无效",
                            "请填写数值。", "start", -1);
  if (startT > cfg.maxTemp)
    addIssue("error", "overTemp", "起始温度超温",
      `${startT}°C 已高于窑炉温度上限 ${cfg.maxTemp}°C。`, "start", -1);

  let tRun = 0, tcRun = 0, peak = startT;
  const rawSegs = Array.isArray(plan.segments) ? plan.segments : [];

  rawSegs.forEach((raw, i) => {
    const from = i === 0 ? startT : num(rawSegs[i - 1].target, NaN);
    const target = num(raw.target, NaN);
    const hold = Math.max(0, num(raw.hold, 0));
    const rate = num(raw.rate, NaN);
    const tValid = Number.isFinite(target);
    const tv = tValid ? target : from;
    const dT = tv - from;
    const up = dT > 0, down = dT < 0, flat = dT === 0;
    const cap = up ? cfg.heatRateMax : down ? cfg.coolRateMax : Infinity;

    const s = {
      i, from, target: tv, targetValid: tValid, dT, hold,
      up, down, flat,
      rate: Number.isFinite(rate) ? rate : null,
      startMin: tRun,
      qTarget: tidy(qRound(tv, cfg.tempStep)),
      qHold: tidy(Math.max(0, qRound(hold, cfg.holdStep))),
      qRate: null,
      compFrom: i === 0 ? startT : segs[i - 1].qTarget,
      compStartMin: tcRun,
      flags: new Set(),
      sev: null,
    };

    // ---- 计划侧时间轴 ----
    let usedRate = 0, invalid = false;
    if (flat) {
      s.rampMin = 0;
    } else if (!Number.isFinite(rate) || rate <= 0) {
      invalid = true;
      usedRate = Math.max(1, cap === Infinity ? 60 : cap);
      s.rampMin = Math.abs(dT) / usedRate * 60;
    } else {
      usedRate = rate;
      s.rampMin = Math.abs(dT) / rate * 60;
    }
    s.rampEndMin = tRun + s.rampMin;
    s.endMin = s.rampEndMin + hold;
    tRun = s.endMin;

    // ---- 编译（取整）侧 ----
    if (flat) {
      s.qRate = 0;
      s.compRampMin = 0;
    } else {
      s.qRate = tidy(Math.max(0, qRound(usedRate, cfg.rateStep)));
      s.compRampMin = s.qRate > 0
        ? Math.abs(s.qTarget - s.compFrom) / s.qRate * 60 : 0;
    }
    s.compRampEndMin = tcRun + s.compRampMin;
    s.compEndMin = s.compRampEndMin + s.qHold;
    tcRun = s.compEndMin;

    peak = Math.max(peak, tv);
    const node = `ramp-${i}`, holdNode = `hold-${i}`;
    const where = `第 ${i + 1} 段（${fmtMin(s.startMin)}–${fmtMin(s.endMin)}）`;
    const mark = (sev) => { if (sev === "error" || s.sev !== "error") s.sev = sev; };

    // ---- 问题判定 ----
    if (!tValid) {
      s.flags.add("invalid"); mark("error");
      addIssue("error", "invalid", `第 ${i + 1} 段目标温度无效`, "请填写数值。", node, i);
    }
    if (invalid) {
      s.flags.add("invalid"); mark("error");
      addIssue("error", "invalid", `第 ${i + 1} 段速率无效`,
        "升降温段需要大于 0 的速率（°C/h）。", node, i);
    }
    if (tv > cfg.maxTemp) {
      s.flags.add("overTemp"); mark("error");
      addIssue("error", "overTemp", `第 ${i + 1} 段超温`,
        `${tv}°C 超过窑炉温度上限 ${cfg.maxTemp}°C ${tv - cfg.maxTemp}°C。`, node, i);
    } else if (s.qTarget > cfg.maxTemp) {
      // 原温度不超，但按步进就近取整后的执行温度越过上限
      s.flags.add("overTemp"); mark("error");
      addIssue("error", "overTemp", `第 ${i + 1} 段取整后超温`,
        `目标 ${tv}°C 未超上限，但按 ${cfg.tempStep}°C 步进取整为 ${s.qTarget}°C 后`
        + `超过上限 ${cfg.maxTemp}°C ${s.qTarget - cfg.maxTemp}°C，`
        + `请降低目标温度或核对温度步进/上限配置。`, node, i);
    }
    if (!flat && Number.isFinite(rate) && rate > 0 && rate > cap) {
      s.flags.add("rateOver"); mark("error");
      addIssue("error", "rateOver", `第 ${i + 1} 段能力不足`,
        `${up ? "升温" : "降温"}速率 ${rate}°C/h 超过窑炉${up ? "升温" : "降温"}能力 ${cap}°C/h。`,
        node, i);
    } else if (!flat && s.qRate > cap) {
      s.flags.add("rateOver"); mark("error");
      addIssue("error", "rateOver", `第 ${i + 1} 段取整后超能力`,
        `速率取整为 ${s.qRate}°C/h 后超过 ${cap}°C/h，请把步进步进值调小或降低速率。`,
        node, i);
    }
    if (!flat && s.rampMin < ZERO_JUMP_MIN) {
      s.flags.add("zeroJump"); mark("error");
      addIssue("error", "zeroJump", `第 ${i + 1} 段零时长跳温`,
        `${from}→${tv}°C（Δ${Math.abs(dT)}°C）仅需约 ${Math.round(s.rampMin * 60)} 秒，`
        + `控制器会按 0 分钟处理，跳变不可控。`, node, i);
    } else if (!flat && s.compRampMin < ZERO_JUMP_MIN) {
      s.flags.add("zeroJump"); mark("error");
      addIssue("error", "zeroJump", `第 ${i + 1} 段取整后零时长跳温`,
        `取整为 ${s.qRate}°C/h 后升降耗时不足 1 分钟。`, node, i);
    }

    // 取整偏移
    const offs = [];
    if (!flat && s.rate !== null && s.rate > 0 && s.qRate > 0 &&
        Math.abs(s.qRate - s.rate) > RATE_TOL * Math.abs(s.rate))
      offs.push(`速率 ${s.rate}→${s.qRate}°C/h`);
    if (s.qTarget !== tv)
      offs.push(`目标 ${tv}→${s.qTarget}°C`);
    if (s.qHold !== hold)
      offs.push(`保温 ${hold}→${s.qHold}min`);
    if (offs.length) {
      s.flags.add("round"); mark("warn");
      addIssue("warn", "round", `第 ${i + 1} 段取整偏移`,
        offs.join("；") + "。实际执行以取整值为准。", node, i);
    }
    if (i >= cfg.maxSegments) s.flags.add("overflow");

    s.where = where;
    segs.push(s);
  });

  // 段数溢出（全局）
  if (rawSegs.length > cfg.maxSegments) {
    const first = cfg.maxSegments;
    addIssue("error", "overflow", "段数溢出",
      `共需 ${rawSegs.length} 段，控制器仅支持 ${cfg.maxSegments} 段；`
      + `第 ${first + 1} 段起无法录入，请合并相邻段或换用更多段数的控制器。`,
      `ramp-${first}`, first);
  }

  // 总时长取整偏移（全局）
  const totalDelta = tcRun - tRun;
  if (Math.abs(totalDelta) >= 1)
    addIssue("warn", "timeShift", "总时长取整偏移",
      `按步进取整后总时长偏移 ${fmtDelta(totalDelta)}（原 ${fmtMin(tRun)}，执行 ${fmtMin(tcRun)}）。`,
      null, -1);

  const errors = issues.filter((x) => x.sev === "error").length;
  const warns = issues.filter((x) => x.sev === "warn").length;

  return {
    cfg, startT, startValid,
    segs, issues,
    totalMin: tRun,
    compiledTotalMin: tcRun,
    totalDelta,
    peakTemp: peak,
    segCount: rawSegs.length,
    errors, warns,
    valid: errors === 0,
  };
}

/* ----------------------------- 曲线几何点列 ----------------------------- */
function curvePoints(plan, model, compiled = false) {
  // 返回 {x:min, y:temp} 点列（升温点+保温点）
  const pts = [{ x: 0, y: model.startT, kind: "start" }];
  model.segs.forEach((s) => {
    if (compiled) {
      pts.push({ x: s.compRampEndMin, y: s.qTarget, kind: "ramp", i: s.i });
      if (s.qHold > 0)
        pts.push({ x: s.compEndMin, y: s.qTarget, kind: "hold", i: s.i });
    } else {
      pts.push({ x: s.rampEndMin, y: s.target, kind: "ramp", i: s.i });
      if (s.hold > 0) pts.push({ x: s.endMin, y: s.target, kind: "hold", i: s.i });
    }
  });
  return pts;
}

/* =====================================================================
 * 存储层：优先服务端 SQLite，失败自动回退 localStorage（双击 html 也能用）
 * =================================================================== */
const Store = {
  mode: "server",

  async api(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    } finally {
      clearTimeout(timer);
    }
  },

  async detect() {
    try {
      await this.api("GET", "/api/kilns");
      this.mode = "server";
    } catch (e) {
      this.mode = "local";
    }
  },

  // ---- server 实现 ----
  async listKilns() {
    if (this.mode === "local") return Local.listKilns();
    const rows = await this.api("GET", "/api/kilns");
    return rows.map((r) => ({ id: r.id, name: r.name,
                              config: JSON.parse(r.config || "{}") }));
  },
  async createKiln(name, config) {
    if (this.mode === "local") return Local.createKiln(name, config);
    return (await this.api("POST", "/api/kilns", { name, config })).id;
  },
  async updateKiln(id, name, config) {
    if (this.mode === "local") return Local.updateKiln(id, name, config);
    await this.api("PUT", "/api/kilns/" + id, { name, config });
  },
  async deleteKiln(id) {
    if (this.mode === "local") return Local.deleteKiln(id);
    await this.api("DELETE", "/api/kilns/" + id);
  },
  async listPlans(kilnId) {
    if (this.mode === "local") return Local.listPlans(kilnId);
    const rows = await this.api("GET", "/api/plans?kiln_id=" + kilnId);
    return rows.map((r) => ({ id: r.id, kilnId: r.kiln_id, name: r.name }));
  },
  async createPlan(kilnId, name, data) {
    if (this.mode === "local") return Local.createPlan(kilnId, name, data);
    return (await this.api("POST", "/api/plans", { kiln_id: kilnId, name, data })).id;
  },
  async updatePlan(id, name, data) {
    if (this.mode === "local") return Local.updatePlan(id, name, data);
    await this.api("PUT", "/api/plans/" + id, { name, data });
  },
  async deletePlan(id) {
    if (this.mode === "local") return Local.deletePlan(id);
    await this.api("DELETE", "/api/plans/" + id);
  },
  async getPlan(id) {
    if (this.mode === "local") return Local.getPlan(id);
    const r = await this.api("GET", "/api/plans/" + id);
    return {
      id: r.id, kilnId: r.kiln_id, name: r.name,
      data: JSON.parse(r.data),
      versions: (r.versions || []).map((v) =>
        ({ id: v.id, label: v.label, createdAt: v.created_at })),
    };
  },
  async getVersion(id) {
    if (this.mode === "local") return Local.getVersion(id);
    const r = await this.api("GET", "/api/versions/" + id);
    return { id: r.id, planId: r.plan_id, label: r.label,
             data: JSON.parse(r.data), createdAt: r.created_at };
  },
  async createVersion(planId, label, data) {
    if (this.mode === "local") return Local.createVersion(planId, label, data);
    return (await this.api("POST", `/api/plans/${planId}/versions`,
                           { label, data })).id;
  },
  async deleteVersion(id) {
    if (this.mode === "local") return Local.deleteVersion(id);
    await this.api("DELETE", "/api/versions/" + id);
  },
  // ---- 烧成记录（复盘）：只新增/读取/删除记录，绝不动方案数据 ----
  async listFirings(planId) {
    if (this.mode === "local") return Local.listFirings(planId);
    const rows = await this.api("GET", `/api/plans/${planId}/firings`);
    return rows.map((r) => ({ id: r.id, planId: r.plan_id, name: r.name,
                              createdAt: r.created_at,
                              sampleCount: r.sample_count }));
  },
  async createFiring(planId, name, meta, samples) {
    if (this.mode === "local")
      return Local.createFiring(planId, name, meta, samples);
    return (await this.api("POST", `/api/plans/${planId}/firings`,
                           { name, meta, samples })).id;
  },
  async getFiring(id) {
    if (this.mode === "local") return Local.getFiring(id);
    const r = await this.api("GET", "/api/firings/" + id);
    return { id: r.id, planId: r.plan_id, name: r.name,
             createdAt: r.created_at,
             meta: JSON.parse(r.meta || "{}"),
             samples: JSON.parse(r.samples || "[]") };
  },
  async updateFiring(id, name, meta) {
    if (this.mode === "local") return Local.updateFiring(id, name, meta);
    await this.api("PUT", "/api/firings/" + id, { name, meta });
  },
  async deleteFiring(id) {
    if (this.mode === "local") return Local.deleteFiring(id);
    await this.api("DELETE", "/api/firings/" + id);
  },
};

const Local = {
  read(k, d) {
    try { return JSON.parse(localStorage.getItem(k)) ?? d; }
    catch (e) { return d; }
  },
  write(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  nextId() {
    const n = (parseInt(localStorage.getItem(LS.seq), 10) || 100) + 1;
    localStorage.setItem(LS.seq, String(n));
    return n;
  },
  async listKilns() { return this.read(LS.kilns, []); },
  async createKiln(name, config) {
    const rows = this.read(LS.kilns, []);
    const id = this.nextId();
    rows.push({ id, name, config });
    this.write(LS.kilns, rows);
    return id;
  },
  async updateKiln(id, name, config) {
    const rows = this.read(LS.kilns, []);
    const k = rows.find((r) => r.id === id);
    if (k) { k.name = name; k.config = config; this.write(LS.kilns, rows); }
  },
  async deleteKiln(id) {
    this.write(LS.kilns, this.read(LS.kilns, []).filter((r) => r.id !== id));
    const deadPlans = this.read(LS.plans, [])
      .filter((r) => r.kilnId === id).map((r) => r.id);
    this.write(LS.plans, this.read(LS.plans, []).filter((r) => r.kilnId !== id));
    this.write(LS.firings,
      this.read(LS.firings, []).filter((r) => !deadPlans.includes(r.planId)));
  },
  async listPlans(kilnId) {
    return this.read(LS.plans, []).filter((r) => r.kilnId === kilnId)
      .map((r) => ({ id: r.id, kilnId: r.kilnId, name: r.name }));
  },
  async createPlan(kilnId, name, data) {
    const rows = this.read(LS.plans, []);
    const id = this.nextId();
    rows.push({ id, kilnId, name, data });
    this.write(LS.plans, rows);
    return id;
  },
  async updatePlan(id, name, data) {
    const rows = this.read(LS.plans, []);
    const p = rows.find((r) => r.id === id);
    if (p) { p.name = name; p.data = data; this.write(LS.plans, rows); }
  },
  async deletePlan(id) {
    this.write(LS.plans, this.read(LS.plans, []).filter((r) => r.id !== id));
    this.write(LS.versions, this.read(LS.versions, []).filter((r) => r.planId !== id));
    this.write(LS.firings, this.read(LS.firings, []).filter((r) => r.planId !== id));
  },
  async getPlan(id) {
    const p = this.read(LS.plans, []).find((r) => r.id === id);
    if (!p) return null;
    return {
      ...p,
      versions: this.read(LS.versions, []).filter((v) => v.planId === id)
        .map((v) => ({ id: v.id, label: v.label, createdAt: v.createdAt })),
    };
  },
  async getVersion(id) {
    return this.read(LS.versions, []).find((v) => v.id === id) || null;
  },
  async createVersion(planId, label, data) {
    const rows = this.read(LS.versions, []);
    const id = this.nextId();
    rows.push({ id, planId, label, data, createdAt: nowLabel() });
    this.write(LS.versions, rows);
    return id;
  },
  async deleteVersion(id) {
    this.write(LS.versions, this.read(LS.versions, []).filter((v) => v.id !== id));
  },
  // ---- 烧成记录（本地回退存储） ----
  async listFirings(planId) {
    return this.read(LS.firings, [])
      .filter((r) => r.planId === planId)
      .sort((a, b) => b.id - a.id)
      .map((r) => ({ id: r.id, planId: r.planId, name: r.name,
                     createdAt: r.createdAt, sampleCount: r.samples.length }));
  },
  async createFiring(planId, name, meta, samples) {
    const rows = this.read(LS.firings, []);
    const id = this.nextId();
    rows.push({ id, planId, name, meta, samples, createdAt: nowLabel() });
    this.write(LS.firings, rows);
    return id;
  },
  async getFiring(id) {
    return this.read(LS.firings, []).find((r) => r.id === id) || null;
  },
  async updateFiring(id, name, meta) {
    const rows = this.read(LS.firings, []);
    const f = rows.find((r) => r.id === id);
    if (f) { f.name = name; f.meta = meta; this.write(LS.firings, rows); }
  },
  async deleteFiring(id) {
    this.write(LS.firings, this.read(LS.firings, []).filter((r) => r.id !== id));
  },
};

/* =====================================================================
 * 全局状态
 * =================================================================== */
const state = {
  kilns: [],
  plans: [],
  kiln: null,                 // {id,name,config}
  plan: null,                 // {id,name,data}
  versions: [],
  past: [],                   // 撤销栈：旧快照
  future: [],                 // 重做栈
  selNode: null,
  selSeg: null,
  drag: null,
  saveTimer: null,
};

function snapshot() {
  return {
    data: deepClone(state.plan.data),
    kilnConfig: deepClone(state.kiln.config),
    kilnName: state.kiln.name,
    planName: state.plan.name,
  };
}
function applySnapshot(snap) {
  state.plan.data = deepClone(snap.data);
  state.kiln.config = deepClone(snap.kilnConfig);
  state.kiln.name = snap.kilnName;
  state.plan.name = snap.planName;
}
function undo() {
  if (!state.past.length) return;
  state.future.push(snapshot());
  applySnapshot(state.past.pop());
  Store.updateKiln(state.kiln.id, state.kiln.name, state.kiln.config);
  scheduleSave(); saveDraft();
  renderAll();
  toast("已撤销");
}
function redo() {
  if (!state.future.length) return;
  state.past.push(snapshot());
  applySnapshot(state.future.pop());
  Store.updateKiln(state.kiln.id, state.kiln.name, state.kiln.config);
  scheduleSave(); saveDraft();
  renderAll();
  toast("已重做");
}

/* 统一变更入口：把变更前快照压入撤销栈，执行修改，再联动刷新 */
function commit(mutator, msg) {
  state.past.push(snapshot());
  state.future = [];
  if (state.past.length > HISTORY_LIMIT) state.past.shift();
  mutator();
  afterEdit(msg);
}
/* 来自表单输入框的变更：change 可能在焦点尚未离开输入框时触发（合成事件/
   辅助技术），同步移除该输入框会让 Chromium 焦点清理抛 NotFoundError，
   因此把重渲染延迟到当前事件结束之后；状态与历史仍立即更新。 */
function commitInput(mutator, msg) {
  state.past.push(snapshot());
  state.future = [];
  if (state.past.length > HISTORY_LIMIT) state.past.shift();
  mutator();
  scheduleSave();
  saveDraft();
  setTimeout(() => {
    renderAll();
    if (msg) toast(msg);
  }, 0);
}
function afterEdit(msg) {
  scheduleSave();
  saveDraft();
  renderAll();
  if (msg) toast(msg);
}
function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (state.plan && state.plan.id != null)
      Store.updatePlan(state.plan.id, state.plan.name, state.plan.data);
  }, 700);
}
function saveDraft() {
  try {
    localStorage.setItem(LS.draft, JSON.stringify({
      kilnId: state.kiln.id, planId: state.plan.id,
      snap: snapshot(), at: Date.now(),
    }));
  } catch (e) { /* 忽略配额错误 */ }
}
function clearDraft() { localStorage.removeItem(LS.draft); }

/* =====================================================================
 * SVG 曲线图（交互版）
 * =================================================================== */
const CH = { W: 0, H: 360, ml: 58, mr: 18, mt: 18, mb: 38,
            Tmax: 1, ymin: 0, ymax: 1, model: null };

function niceStep(span, targetLines, candidates) {
  for (const c of candidates) if (span / c <= targetLines) return c;
  return candidates[candidates.length - 1];
}

function chartDomains(model) {
  const pts = curvePoints(null, model, false)
    .concat(curvePoints(null, model, true));
  const temps = [model.startT].concat(model.segs.map((s) => s.target),
                                      model.segs.map((s) => s.qTarget));
  const xmax = Math.max(1, model.totalMin, model.compiledTotalMin);
  let ymin = Math.min(...temps, 0) ;
  let ymax = Math.max(...temps, model.cfg.maxTemp);
  const pad = Math.max(20, (ymax - ymin) * 0.08);
  ymin = Math.max(0, Math.floor((ymin - pad) / 10) * 10);
  ymax = Math.ceil((ymax + pad) / 10) * 10;
  return { xmax, ymin, ymax };
}

function renderChart() {
  const wrap = $("#chartWrap");
  if (!state.plan) return;
  const model = buildModel(state.plan.data, state.kiln.config);
  CH.model = model;
  const dom = chartDomains(model);
  if (window.Review) Review.extendDomain(dom);  // 复盘实测曲线可能超出方案域
  const { xmax, ymin, ymax } = dom;
  Object.assign(CH, {
    W: Math.max(560, wrap.clientWidth - 4),
    Tmax: xmax, ymin, ymax,
  });

  const xStep = niceStep(xmax, 9, [15, 30, 60, 120, 180, 240, 360, 480, 720, 1080, 1440, 2880]);
  const yStep = niceStep(ymax - ymin, 7, [20, 25, 50, 100, 200, 250, 500]);
  const X = (t) => CH.ml + clamp(t, 0, CH.Tmax) / CH.Tmax * (CH.W - CH.ml - CH.mr);
  const Y = (tp) => CH.H - CH.mb - (clamp(tp, CH.ymin, CH.ymax) - CH.ymin)
                   / (CH.ymax - CH.ymin) * (CH.H - CH.mt - CH.mb);

  let g = "";
  // 横向网格 + Y 刻度
  for (let v = Math.ceil(ymin / yStep) * yStep; v <= ymax; v += yStep) {
    g += `<line class="grid-line" x1="${CH.ml}" x2="${CH.W - CH.mr}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text class="axis-tick" x="${CH.ml - 7}" y="${Y(v) + 3.5}" text-anchor="end">${v}</text>`;
  }
  // 纵向网格 + X 刻度
  for (let t = 0; t <= xmax + 1e-6; t += xStep) {
    g += `<line class="grid-line" x1="${X(t)}" x2="${X(t)}" y1="${CH.mt}" y2="${CH.H - CH.mb}"/>`;
    g += `<text class="axis-tick" x="${X(t)}" y="${CH.H - CH.mb + 15}" text-anchor="middle">${fmtMin(t)}</text>`;
  }
  // 温度上限
  if (model.cfg.maxTemp <= ymax) {
    g += `<line x1="${CH.ml}" x2="${CH.W - CH.mr}" y1="${Y(model.cfg.maxTemp)}" y2="${Y(model.cfg.maxTemp)}"
           stroke="#c0392b" stroke-width="1.2" stroke-dasharray="6 4" opacity=".75"/>`;
    g += `<text class="axis-tick" x="${CH.W - CH.mr - 4}" y="${Y(model.cfg.maxTemp) - 4}" text-anchor="end" fill="#c0392b">上限 ${model.cfg.maxTemp}℃</text>`;
  }
  // 轴
  g += `<line class="axis-line" x1="${CH.ml}" x2="${CH.ml}" y1="${CH.mt}" y2="${CH.H - CH.mb}"/>`;
  g += `<line class="axis-line" x1="${CH.ml}" x2="${CH.W - CH.mr}" y1="${CH.H - CH.mb}" y2="${CH.H - CH.mb}"/>`;
  g += `<text class="axis-title" x="14" y="${CH.mt + 8}">℃</text>`;
  g += `<text class="axis-title" x="${CH.W - CH.mr}" y="${CH.H - 6}" text-anchor="end">小时:分钟</text>`;

  // 零跳温标记（原曲线竖虚线）
  model.segs.forEach((s) => {
    if (s.flags.has("zeroJump") && s.rampMin < ZERO_JUMP_MIN) {
      g += `<line class="zero-jump-marker" x1="${X(s.startMin)}" x2="${X(s.rampEndMin)}"
             y1="${Y(s.from)}" y2="${Y(s.target)}"/>`;
    }
  });

  // 曲线（保温段水平段叠加同色线）
  const pathFrom = (pts) => pts.map((p, k) => `${k ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  const planPts = curvePoints(state.plan.data, model, false);
  const compPts = curvePoints(state.plan.data, model, true);
  g += `<path class="curve-comp" d="${pathFrom(compPts)}"/>`;
  g += `<path class="curve-plan" d="${pathFrom(planPts)}"/>`;
  if (window.Review) g += Review.chartOverlay(X, Y, model);  // 复盘叠加层

  // 节点
  const nodeSVG = (id, cx, cy, kind, title, badge) => {
    const cls = ["node", kind === "hold" ? "hold" : "ramp"];
    if (state.selNode === id) cls.push("selected");
    const segI = kind === "start" ? -1 : parseInt(id.split("-")[1], 10);
    const seg = Number.isInteger(segI) && segI >= 0 ? model.segs[segI] : null;
    if (seg?.sev === "error") cls.push("flag-error");
    if (seg?.sev === "warn") cls.push("flag-warn");
    if (state.drag?.id === id) cls.push("dragging");
    const r = kind === "start" ? 5 : 5.5;
    let badgeSvg = "";
    if (badge === "error")
      badgeSvg = `<circle cx="${cx + 7}" cy="${cy - 7}" r="5.5" fill="#c0392b" stroke="#fff" stroke-width="1"/>
                  <text x="${cx + 7}" y="${cy - 3.6}" text-anchor="middle" class="node-badge" fill="#fff">!</text>`;
    else if (badge === "warn")
      badgeSvg = `<circle cx="${cx + 7}" cy="${cy - 7}" r="5" fill="#c08a1e" stroke="#fff" stroke-width="1"/>
                  <text x="${cx + 7}" y="${cy - 3.8}" text-anchor="middle" class="node-badge" fill="#fff">…</text>`;
    const shape = kind === "start"
      ? `<rect class="node-body" x="${cx - 4.5}" y="${cy - 4.5}" width="9" height="9" transform="rotate(45 ${cx} ${cy})" fill="#2f6690"/>`
      : `<circle class="node-body" cx="${cx}" cy="${cy}" r="${r}"/>`;
    return `<g class="${cls.join(" ")}" data-node="${id}" data-kind="${kind}">
              <title>${esc(title)}</title>
              <circle class="node-hit" cx="${cx}" cy="${cy}" r="13"/>
              ${shape}${badgeSvg}
            </g>`;
  };

  // start 节点
  g += nodeSVG("start", X(0), Y(model.startT), "start",
               `起始温度 ${model.startT}℃（上下拖动修改）`, null);
  model.segs.forEach((s) => {
    const badge = s.flags.has("overTemp") || s.flags.has("rateOver") ||
                  s.flags.has("zeroJump") || s.flags.has("invalid")
      ? "error" : s.sev === "warn" ? "warn" : null;
    g += nodeSVG(`ramp-${s.i}`, X(s.rampEndMin), Y(s.target), "ramp",
      `第${s.i + 1}段 升温/降温点\n${s.from}→${s.target}℃  速率 ${s.rate ?? "—"}℃/h\n`
      + `时刻 ${fmtMin(s.rampEndMin)}（拖动改温度/速率）`, badge);
    if (s.hold > 0)
      g += nodeSVG(`hold-${s.i}`, X(s.endMin), Y(s.target), "hold",
        `第${s.i + 1}段 保温结束  ${s.hold}min\n结束时刻 ${fmtMin(s.endMin)}（左右拖动改保温）`,
        s.flags.has("round") ? "warn" : null);
  });

  // 空曲线提示
  if (model.segCount === 0)
    g += `<text class="axis-title" x="${(CH.ml + CH.W - CH.mr) / 2}" y="${CH.H / 2}" text-anchor="middle" style="font-size:13px">
            还没有分段，点击下方“＋ 追加段”开始编排</text>`;

  let svg = wrap.querySelector("svg");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("id", "mainChart");
    wrap.appendChild(svg);
    bindChartDrag(svg);
  }
  svg.setAttribute("viewBox", `0 0 ${CH.W} ${CH.H}`);
  svg.setAttribute("width", CH.W);
  svg.innerHTML = g;
}

/* ---------- 拖拽 ---------- */
function svgPoint(svg, evt) {
  const ctm = svg.getScreenCTM();
  return new DOMPoint(evt.clientX, evt.clientY).matrixTransform(ctm.inverse());
}

function bindChartDrag(svg) {
  svg.addEventListener("pointerdown", (evt) => {
    const g = evt.target.closest(".node");
    if (!g) return;
    const id = g.dataset.node;
    const kind = g.dataset.kind;
    if (kind === "hold") {
      const i = parseInt(id.split("-")[1], 10);
      state.selNode = id; state.selSeg = i;
    } else if (id === "start") {
      state.selNode = "start"; state.selSeg = null;
    } else {
      const i = parseInt(id.split("-")[1], 10);
      state.selNode = id; state.selSeg = i;
    }
    state.drag = { id, kind, startSnap: snapshot(), moved: false, shift: evt.shiftKey };
    svg.setPointerCapture(evt.pointerId);
    renderChart();
  });

  svg.addEventListener("pointermove", (evt) => {
    const d = state.drag;
    if (!d) return;
    const model = CH.model;
    const p = svgPoint(svg, evt);
    const plotW = CH.W - CH.ml - CH.mr, plotH = CH.H - CH.mt - CH.mb;
    const temp = CH.ymax - (p.y - CH.mt) / plotH * (CH.ymax - CH.ymin);
    const atMin = (p.x - CH.ml) / plotW * CH.Tmax;
    const seg = state.plan.data.segments;
    const cfg = state.kiln.config;

    if (d.kind === "start") {
      let v = clamp(temp, 0, cfg.maxTemp * 1.3);
      if (evt.shiftKey) v = tidy(qRound(v, cfg.tempStep));
      state.plan.data.startTemp = tidy(v);
    } else {
      const i = parseInt(d.id.split("-")[1], 10);
      const m = model.segs[i];
      if (d.kind === "ramp") {
        let v = clamp(temp, 0, cfg.maxTemp * 1.3);
        if (evt.shiftKey) v = tidy(qRound(v, cfg.tempStep));
        const fromT = i === 0 ? model.startT : num(seg[i - 1].target, model.startT);
        const newDT = v - fromT;
        const segStart = m.startMin;
        let newRampMin = clamp(atMin - segStart, 0, CH.Tmax - segStart + 1);
        let rate;
        if (Math.abs(newDT) < 1e-9) {
          rate = seg[i].rate; // 同温：纯保温，x 不起作用
        } else if (newRampMin <= 0) {
          rate = 9999;        // 故意零跳温
        } else {
          rate = tidy(Math.abs(newDT) * 60 / newRampMin);
          if (evt.shiftKey) {
            const qr = Math.max(cfg.rateStep, tidy(qRound(rate, cfg.rateStep)));
            rate = qr;
          }
        }
        seg[i].target = tidy(v);
        if (rate !== undefined && rate !== null) seg[i].rate = rate;
      } else {
        // hold：只能左右
        const newEnd = clamp(atMin, m.rampEndMin, CH.Tmax + 1440);
        let h = Math.max(0, newEnd - m.startMin - m.rampMin);
        if (evt.shiftKey) h = tidy(qRound(h, cfg.holdStep));
        seg[i].hold = tidy(h);
      }
    }
    d.moved = true;
    scheduleSave(); saveDraft();
    // 拖拽时只刷图表、摘要与右侧（避免表格频繁重建也无妨，这里全刷）
    renderAll();
  });

  const finish = (evt) => {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    if (d.moved) {
      // 拖拽前快照（down 时捕获）压入撤销栈，撤销可回到拖前
      state.past.push(d.startSnap);
      state.future = [];
      if (state.past.length > HISTORY_LIMIT) state.past.shift();
      scheduleSave(); saveDraft();
      renderAll();
    } else {
      renderAll();
    }
  };
  svg.addEventListener("pointerup", finish);
  svg.addEventListener("pointercancel", finish);
}

/* =====================================================================
 * 表格 / 摘要 / 侧栏渲染
 * =================================================================== */
function renderSummary(model) {
  const counts = {};
  model.issues.forEach((x) => { counts[x.code] = (counts[x.code] || 0) + 1; });
  const verdict = model.errors
    ? `<span class="verdict has-error">✗ ${model.errors} 个错误${model.warns ? ` · ${model.warns} 个提醒` : ""}</span>`
    : model.warns
      ? `<span class="verdict has-warn">△ ${model.warns} 个取整提醒</span>`
      : `<span class="verdict ok">✓ 校验通过，可录入控制器</span>`;

  $("#summaryBar").innerHTML = `
    <div class="metric"><span class="k">方案</span>
      <span class="v" style="display:flex;align-items:center;gap:6px">
        <input type="text" id="planNameInput" value="${esc(state.plan.name)}" style="width:200px;font-weight:600">
        <button id="btnNewPlan" title="另建空白方案">＋新方案</button>
        <button id="btnDeletePlan" class="danger" title="删除当前方案">删除</button>
      </span></div>
    <div class="metric"><span class="k">计划总时长</span><span class="v">${fmtMin(model.totalMin)}</span></div>
    <div class="metric"><span class="k">执行总时长（取整后）</span>
      <span class="v">${fmtMin(model.compiledTotalMin)}</span></div>
    <div class="metric"><span class="k">峰值温度</span><span class="v">${model.peakTemp}℃</span></div>
    <div class="metric"><span class="k">段数</span>
      <span class="v">${model.segCount}/${model.cfg.maxSegments}</span></div>
    ${verdict}`;
}

function renderTable(model) {
  const cfg = model.cfg;
  const tb = $("#segTbody");
  const rows = model.segs.map((s) => {
    const dir = s.flat
      ? `<span class="dir-pill dir-flat">保温</span>`
      : s.up ? `<span class="dir-pill dir-up">↑ 升温</span>`
             : `<span class="dir-pill dir-down">↓ 降温</span>`;
    const flagIcon = s.sev === "error"
      ? `<span class="row-flag tag error" title="本段存在错误">!</span>`
      : s.sev === "warn"
        ? `<span class="row-flag tag warn" title="本段有取整偏移">偏移</span>` : "";
    return `<tr data-seg="${s.i}" class="${state.selSeg === s.i ? "sel" : ""}">
      <td class="c-idx">${s.i + 1}</td>
      <td>${dir}</td>
      <td><input type="number" class="num" data-seg="${s.i}" data-field="rate"
            value="${s.rate ?? ""}" step="${cfg.rateStep}" min="0"
            ${s.flat ? "disabled" : ""}>
        ${s.flags.has("rateOver") ? '<span class="tag error row-flag">超</span>' : ""}</td>
      <td><input type="number" class="num" data-seg="${s.i}" data-field="target"
            value="${s.targetValid ? s.target : ""}" step="${cfg.tempStep}">
        ${s.flags.has("overTemp") ? '<span class="tag error row-flag">温</span>' : ""}</td>
      <td><input type="number" class="num" data-seg="${s.i}" data-field="hold"
            value="${s.hold}" step="${cfg.holdStep}" min="0">
        ${s.flags.has("round") && s.qHold !== s.hold ? '<span class="tag warn row-flag">圆</span>' : ""}</td>
      <td class="cell-time">${fmtMin(s.startMin)}</td>
      <td class="cell-time">${fmtMin(s.endMin)}${flagIcon}</td>
      <td class="c-op">
        <button data-act="split" data-seg="${s.i}" title="在本段中间拆成两段">拆段</button>
        <button data-act="merge" data-seg="${s.i}"
          ${s.i === model.segs.length - 1 ? "disabled" : ""}
          title="与下一段合并">合并</button>
        <button data-act="del" data-seg="${s.i}" class="danger" title="删除本段">删</button>
      </td>
    </tr>`;
  }).join("");
  tb.innerHTML = rows || `<tr><td colspan="8" style="text-align:center;color:#9a9188;padding:18px">
      暂无分段。点击右上“＋ 追加段”，或从顶栏“载入示例”开始。</td></tr>`;

  const st = $("#startTempInput");
  st.value = model.startValid ? state.plan.data.startTemp : "";
  st.step = cfg.tempStep;
  st.classList.toggle("invalid", !model.startValid);
}

function renderIssues(model) {
  const el = $("#issueList");
  if (!model.issues.length) {
    el.innerHTML = `<div class="empty">✓ 未发现问题：没有超温、超能力、零跳温或溢出，取整也没有偏移。</div>`;
    return;
  }
  el.innerHTML = model.issues.map((x, k) => `
    <div class="issue ${x.sev}" data-issue="${k}">
      <span class="dot"></span>
      <span class="itext">
        <div class="ititle">${esc(x.title)}</div>
        <div class="idesc">${esc(x.desc)}</div>
        <div class="iloc">${x.nodeId ? "点击定位节点" : "全局"}</div>
      </span>
    </div>`).join("");
}

function renderSteps(model) {
  const el = $("#stepsList");
  if (!model.segCount) {
    el.innerHTML = `<div class="empty">没有可编译的分段。</div>`;
    $("#compileNote").textContent = "";
    return;
  }
  el.innerHTML = model.segs.map((s) => {
    const tags = [];
    if (s.flags.has("overflow")) tags.push(`<span class="tag error">溢出·无法录入</span>`);
    if (s.flags.has("overTemp")) tags.push(`<span class="tag error">超温</span>`);
    if (s.flags.has("rateOver")) tags.push(`<span class="tag error">超能力</span>`);
    if (s.flags.has("zeroJump")) tags.push(`<span class="tag error">零跳温</span>`);
    if (s.flags.has("round")) tags.push(`<span class="tag warn">取整偏移</span>`);
    const rateTxt = s.flat ? "0" : s.qRate;
    return `<div class="step-row ${s.flags.has("overflow") ? "over" : ""}">
      <span class="sidx">${s.i + 1}</span>
      <span class="sparam">${rateTxt}℃/h → <b>${s.qTarget}℃</b>
        <small>保温 ${s.qHold}min</small><br>
        <small>${fmtMin(s.compStartMin)}–${fmtMin(s.compEndMin)}</small></span>
      <span class="sflags">${tags.join("")}</span>
    </div>`;
  }).join("");

  const notes = [
    `共 ${model.segCount} 段 / 控制器 ${model.cfg.maxSegments} 段。`,
    `速率按 ${model.cfg.rateStep}℃/h、温度按 ${model.cfg.tempStep}℃、时长按 ${model.cfg.holdStep}min 就近取整。`,
  ];
  if (model.errors) notes.push(`存在 ${model.errors} 个错误，修正前请勿录入。`);
  $("#compileNote").textContent = notes.join(" ");
}

function renderKilnForm() {
  const k = state.kiln;
  const rows = KILN_FIELDS.map(([key, label, unit, step]) => `
    <label>${label}（${unit}）</label>
    <input type="number" id="kf-${key}" data-kfield="${key}"
           value="${k.config[key]}" step="${step}" min="0">
  `).join("");
  $("#kilnForm").innerHTML = `
    <label>窑炉名称</label>
    <input type="text" id="kf-name" data-kfield="name" value="${esc(k.name)}">
    <hr>
    <div class="group-title">能力</div>
    ${rows}
  `;
  $("#storeStatus").textContent =
    Store.mode === "server"
      ? "数据已保存到本机 SQLite（kiln.db），全程不联网。"
      : "未连接本地服务，数据仅保存在此浏览器（localStorage）。用 server.py 启动可使用数据库。";
}

/* =====================================================================
 * 迷你静态曲线图（差异对照 & 打印卡共用）
 * items: [{plan, name, color, dash}]
 * =================================================================== */
function miniChartSVG(items, kiln, W = 760, H = 220) {
  const models = items.map((it) => buildModel(it.plan, kiln));
  let xmax = 1, ymin = Infinity, ymax = -Infinity;
  models.forEach((m) => {
    xmax = Math.max(xmax, m.totalMin, m.compiledTotalMin);
    m.segs.forEach((s) => {
      ymin = Math.min(ymin, s.from, s.target, s.qTarget);
      ymax = Math.max(ymax, s.target, s.qTarget, m.cfg.maxTemp);
    });
  });
  const ml = 52, mr = 14, mt = 14, mb = 30;
  ymin = Math.max(0, Math.floor((ymin - 20) / 10) * 10);
  ymax = Math.ceil((ymax + 25) / 10) * 10;
  const X = (t) => ml + t / xmax * (W - ml - mr);
  const Y = (v) => H - mb - (v - ymin) / (ymax - ymin) * (H - mt - mb);
  let g = "";
  const yStep = niceStep(ymax - ymin, 6, [20, 25, 50, 100, 200, 250, 500]);
  for (let v = Math.ceil(ymin / yStep) * yStep; v <= ymax; v += yStep)
    g += `<line x1="${ml}" x2="${W - mr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eee"/>
          <text x="${ml - 5}" y="${Y(v) + 3}" text-anchor="end" font-size="9" fill="#777">${v}</text>`;
  const xStep = niceStep(xmax, 9, [15, 30, 60, 120, 180, 240, 360, 480, 720, 1080, 1440, 2880]);
  for (let t = 0; t <= xmax; t += xStep)
    g += `<line x1="${X(t)}" x2="${X(t)}" y1="${mt}" y2="${H - mb}" stroke="#f3f3f3"/>
          <text x="${X(t)}" y="${H - mb + 13}" text-anchor="middle" font-size="9" fill="#777">${fmtMin(t)}</text>`;
  if (kiln.maxTemp <= ymax)
    g += `<line x1="${ml}" x2="${W - mr}" y1="${Y(kiln.maxTemp)}" y2="${Y(kiln.maxTemp)}"
         stroke="#c0392b" stroke-dasharray="4 3" opacity=".7"/>`;
  items.forEach((it, idx) => {
    const m = models[idx];
    const pts = curvePoints(it.plan, m, !!it.compiled);
    const d = pts.map((p, k) => `${k ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    g += `<path d="${d}" fill="none" stroke="${it.color}" stroke-width="2"
           ${it.dash ? 'stroke-dasharray="7 4"' : ""}/>`;
    g += `<rect x="${W - mr - 150}" y="${mt + 2 + idx * 15}" width="22" height="3" fill="${it.color}"/>
          <text x="${W - mr - 124}" y="${mt + 7 + idx * 15}" font-size="10" fill="#444">${esc(it.name)}</text>`;
  });
  g += `<line x1="${ml}" x2="${ml}" y1="${mt}" y2="${H - mb}" stroke="#999"/>
        <line x1="${ml}" x2="${W - mr}" y1="${H - mb}" y2="${H - mb}" stroke="#999"/>`;
  return `<svg class="pc-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

/* =====================================================================
 * 版本 & 差异
 * =================================================================== */
async function refreshVersions() {
  if (!state.plan || state.plan.id == null) {
    state.versions = [];
    $("#versionList").innerHTML =
      `<div class="empty">新方案保存后才可以存版本。</div>`;
    const opts = `<option value="current">当前编辑稿</option>`;
    $("#diffA").innerHTML = opts;
    $("#diffB").innerHTML = opts;
    return;
  }
  const full = await Store.getPlan(state.plan.id);
  state.versions = full ? full.versions : [];
  const el = $("#versionList");
  if (!state.versions.length) {
    el.innerHTML = `<div class="empty">尚未保存版本。调整满意后点击顶栏“存为版本”。</div>`;
  } else {
    el.innerHTML = state.versions.map((v) => `
      <div class="version-row">
        <div class="vmeta">
          <div class="vlabel">${esc(v.label)}</div>
          <div class="vtime">${esc(v.createdAt || "")}</div>
        </div>
        <button data-ver="load" data-id="${v.id}">载入</button>
        <button class="danger" data-ver="del" data-id="${v.id}">删</button>
      </div>`).join("");
  }
  // 差异下拉
  const opts = [`<option value="current">当前编辑稿</option>`]
    .concat(state.versions.map((v) =>
      `<option value="v${v.id}">${esc(v.label)}</option>`));
  $("#diffA").innerHTML = opts;
  $("#diffB").innerHTML = opts;
  $("#diffB").selectedIndex = Math.min(1, state.versions.length);
}

async function saveVersion() {
  const n = state.versions.length + 1;
  const label = prompt("版本名称：", `v${n} · ${nowLabel()}`);
  if (label === null) return;
  const id = await Store.createVersion(state.plan.id,
    label.trim() || `版本 ${n}`, deepClone(state.plan.data));
  await Store.updatePlan(state.plan.id, state.plan.name, state.plan.data);
  await refreshVersions();
  toast("已保存版本");
}

async function resolveDiffOpt(value) {
  if (value === "current")
    return { name: "当前编辑稿", data: deepClone(state.plan.data) };
  const v = await Store.getVersion(parseInt(value.slice(1), 10));
  return { name: v.label, data: v.data };
}

function diffRows(a, b) {
  // 生成 [{label, av, bv, changed}] 平铺参数行
  const rows = [];
  const push = (label, av, bv, numish = true) => {
    const changed = JSON.stringify(av) !== JSON.stringify(bv);
    rows.push({ label, av: av ?? "—", bv: bv ?? "—", changed, numish });
  };
  push("起始温度 ℃", a.startTemp, b.startTemp);
  push("段数", a.segments.length, b.segments.length, true);
  const n = Math.max(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const sa = a.segments[i], sb = b.segments[i];
    if (sa && sb) {
      push(`第${i + 1}段 速率 ℃/h`, sa.rate, sb.rate);
      push(`第${i + 1}段 目标 ℃`, sa.target, sb.target);
      push(`第${i + 1}段 保温 min`, sa.hold, sb.hold);
    } else if (sa) {
      push(`第${i + 1}段`, `${sa.rate}℃/h→${sa.target}℃ 保${sa.hold}min`, "（B 中已删除）", false);
    } else {
      push(`第${i + 1}段`, "（A 中不存在）", `${sb.rate}℃/h→${sb.target}℃ 保${sb.hold}min`, false);
    }
  }
  const ma = buildModel(a, state.kiln.config);
  const mb = buildModel(b, state.kiln.config);
  push("计划总时长", fmtMin(ma.totalMin), fmtMin(mb.totalMin), false);
  push("峰值温度 ℃", ma.peakTemp, mb.peakTemp);
  return rows;
}

async function openDiff() {
  const A = await resolveDiffOpt($("#diffA").value);
  const B = await resolveDiffOpt($("#diffB").value);
  const rows = diffRows(A.data, B.data);
  const trs = rows.map((r) => `
    <tr class="${r.changed ? "changed" : ""}">
      <td>${esc(r.label)}</td>
      <td class="${r.numish ? "num" : ""}">${esc(r.av)}</td>
      <td class="${r.numish ? "num" : ""}">${esc(r.bv)}</td>
    </tr>`).join("");
  const changed = rows.filter((r) => r.changed).length;
  $("#diffContent").innerHTML = `
    <table class="diff-table">
      <thead><tr><th>项目</th><th>A：${esc(A.name)}</th><th>B：${esc(B.name)}</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
    <p class="note">共 ${changed} 处不同${changed ? "（黄色底纹标注）。" : "，两版完全一致。"}</p>
    <div class="diff-chart-wrap">
      ${miniChartSVG(
        [{ plan: A.data, name: "A：" + A.name, color: "#b4512e", dash: false },
         { plan: B.data, name: "B：" + B.name, color: "#2f6690", dash: true }],
        state.kiln.config)}
    </div>`;
  $("#diffModal").hidden = false;
}

/* =====================================================================
 * 打印卡
 * =================================================================== */
function buildPrintCard(model) {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // 问题按类型汇总（具体位置在步骤表“标记”列逐段标出，保证单页排得下）
  const codeNames = {
    overTemp: ["超温", "✗"], rateOver: ["能力不足", "✗"],
    zeroJump: ["零跳温", "✗"], invalid: ["参数无效", "✗"],
    overflow: ["段数溢出", "✗"], round: ["取整偏移", "△"],
    timeShift: ["总时长偏移", "△"],
  };
  const order = ["overTemp", "rateOver", "zeroJump", "invalid",
                 "overflow", "round", "timeShift"];
  const agg = {};
  model.issues.forEach((x) => {
    (agg[x.code] ||= { segs: new Set(), global: false });
    if (x.segIndex >= 0) agg[x.code].segs.add(x.segIndex + 1);
    else agg[x.code].global = true;
  });
  let warnBlock;
  if (model.issues.length) {
    const tags = order.filter((c) => agg[c]).map((c) => {
      const [name, mark] = codeNames[c];
      const a = agg[c];
      const loc = a.segs.size
        ? "段" + Array.from(a.segs).sort((x, y) => x - y).join(",")
        : (a.global ? "全局" : "");
      return `<span class="wt">${mark} ${name}${loc ? "：" + loc : ""}</span>`;
    }).join("");
    warnBlock = `<div class="pc-warn">
      <div class="pc-warn-title">校验问题共 ${model.issues.length} 项（错误 ${model.errors} / 提醒 ${model.warns}），修正前请勿录入：</div>
      <div class="pc-warn-tags">${tags}</div></div>`;
  } else {
    warnBlock = `<div class="pc-warn"><b>校验通过</b>：无超温 / 超能力 / 零跳温 / 段数溢出，取整无显著偏移。</div>`;
  }

  const rows = model.segs.map((s) => {
    const star = s.flags.has("round") ? "*" : "";
    const over = s.i >= model.cfg.maxSegments ? "⚠溢出" :
      (s.flags.has("overTemp") ? "⚠超温" : s.flags.has("rateOver") ? "⚠超能力" :
       s.flags.has("zeroJump") ? "⚠零跳" : "");
    return `<tr>
      <td>${s.i + 1}</td>
      <td>${s.flat ? "—" : s.qRate}${star}</td>
      <td>${s.qTarget}${star}</td>
      <td>${s.qHold}${star}</td>
      <td>${fmtMin(s.compStartMin)}</td>
      <td>${fmtMin(s.compEndMin)}</td>
      <td>${over}</td>
    </tr>`;
  }).join("");
  $("#printCard").innerHTML = `
    <h1>窑烧程序卡 — ${esc(state.plan.name)}</h1>
    <div class="pc-meta">
      <span>窑炉：${esc(state.kiln.name)}</span>
      <span>温度上限：${model.cfg.maxTemp}℃</span>
      <span>控制器：${model.cfg.maxSegments} 段</span>
      <span>起始炉温：${model.startT}℃</span>
      <span>计划总时长：${fmtMin(model.totalMin)}</span>
      <span>执行总时长：${fmtMin(model.compiledTotalMin)}</span>
      <span>日期：${date}</span>
    </div>
    ${warnBlock}
    ${miniChartSVG(
        [{ plan: state.plan.data, name: "原曲线", color: "#000", dash: false },
         { plan: state.plan.data, name: "执行曲线（取整）", color: "#666", dash: true, compiled: true }],
        state.kiln.config, 760, 200)}
    <table class="pc-table">
      <thead><tr><th>#</th><th>速率 ℃/h</th><th>目标 ℃</th><th>保温 min</th>
        <th>起</th><th>止</th><th>标记</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="pc-foot">
      <span>带 * 号的数值由原参数按步进就近取整；录入前请与工艺单再次核对。</span>
    </div>
    <div class="pc-sign"><span>编制</span><span>复核</span><span>录入控制器</span></div>`;
}

/* =====================================================================
 * 导入 / 导出
 * =================================================================== */
function exportJSON() {
  const payload = {
    app: "kiln-planner",
    format: 1,
    exportedAt: new Date().toISOString(),
    kiln: { name: state.kiln.name, config: state.kiln.config },
    plan: { name: state.plan.name, data: state.plan.data },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)],
                       { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = state.plan.name.replace(/[\\/:*?"<>|]/g, "_") + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已导出 JSON");
}

async function importJSON(file) {
  let obj;
  try {
    obj = JSON.parse(await file.text());
  } catch (e) {
    toast("导入失败：不是合法 JSON");
    return;
  }
  // 兼容：裸 plan / 包裹格式
  let kilnName, kilnConfig, planName, planData;
  if (obj && obj.plan && obj.kiln) {
    kilnName = obj.kiln.name || "导入的窑炉";
    kilnConfig = Object.assign({}, DEFAULT_KILN, obj.kiln.config || {});
    planName = obj.plan.name || file.name.replace(/\.json$/i, "");
    planData = normalizePlan(obj.plan.data || obj.plan);
  } else if (obj && Array.isArray(obj.segments)) {
    kilnName = "导入的窑炉";
    kilnConfig = { ...DEFAULT_KILN };
    planName = file.name.replace(/\.json$/i, "");
    planData = normalizePlan(obj);
  } else {
    toast("导入失败：文件格式无法识别");
    return;
  }
  const kid = await Store.createKiln(kilnName, kilnConfig);
  const pid = await Store.createPlan(kid, planName, planData);
  state.kilns = await Store.listKilns();
  await loadKiln(kid, pid);
  await renderSelectors();
  clearDraft();
  toast("已导入为新窑炉与新方案");
}

function normalizePlan(p) {
  return {
    startTemp: num(p.startTemp, 20),
    segments: (Array.isArray(p.segments) ? p.segments : []).map((s) => ({
      rate: num(s.rate, 0),
      target: num(s.target, 0),
      hold: Math.max(0, num(s.hold, 0)),
    })),
  };
}

/* =====================================================================
 * 示例菜单
 * =================================================================== */
function toggleExamples(btn) {
  const existing = $("#exampleMenu");
  if (existing) { existing.remove(); return; }
  const menu = document.createElement("div");
  menu.id = "exampleMenu";
  menu.style.cssText =
    "position:fixed;z-index:60;background:#fff;border:1px solid #c9c2b8;"
    + "border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);min-width:320px";
  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 6 + "px";
  menu.style.left = r.left + "px";
  menu.innerHTML = `<div style="padding:8px 14px;font-size:12px;color:#6b6259;border-bottom:1px solid #eee">
      载入示例会创建为新的窑炉与方案，不影响当前数据</div>`;
  examples().forEach((ex, i) => {
    const d = document.createElement("div");
    d.textContent = ex.name;
    d.style.cssText = "padding:9px 14px;cursor:pointer;font-size:13px";
    d.onmouseenter = () => (d.style.background = "#f7f4f0");
    d.onmouseleave = () => (d.style.background = "");
    d.onclick = async () => {
      menu.remove();
      const kid = await Store.createKiln(ex.kilnName, deepClone(ex.kilnConfig));
      const pid = await Store.createPlan(kid, ex.planName, deepClone(ex.plan));
      state.kilns = await Store.listKilns();
      await loadKiln(kid, pid);
      await renderSelectors();
      clearDraft();
      toast("已载入示例（可自由编辑）");
    };
    menu.appendChild(d);
  });
  document.body.appendChild(menu);
  setTimeout(() => {
    const closer = (e) => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("pointerdown", closer); }
    };
    document.addEventListener("pointerdown", closer);
  }, 0);
}

/* =====================================================================
 * 分段编辑操作
 * =================================================================== */
function appendSegment() {
  const segs = state.plan.data.segments;
  const last = segs.length ? segs[segs.length - 1].target : state.plan.data.startTemp;
  commit(() => segs.push({ rate: 100, target: last + 100, hold: 0 }), "已追加一段");
}
function splitSegment(i) {
  const segs = state.plan.data.segments;
  const s = segs[i];
  commit(() => {
    const from = i === 0 ? state.plan.data.startTemp : segs[i - 1].target;
    const mid = tidy(qRound((from + s.target) / 2, state.kiln.config.tempStep));
    const h1 = tidy(qRound(s.hold / 2, state.kiln.config.holdStep));
    const h2 = tidy(s.hold - h1);
    const a = { rate: s.rate, target: mid, hold: h1 };
    const b = { rate: s.rate, target: s.target, hold: h2 };
    segs.splice(i, 1, a, b);
    state.selSeg = i;
  }, "已拆段");
}
function mergeSegment(i) {
  const segs = state.plan.data.segments;
  if (i >= segs.length - 1) return;
  const a = segs[i], b = segs[i + 1];
  const from = i === 0 ? state.plan.data.startTemp : segs[i - 1].target;
  const end = b.target;

  // 合并只能把“同向路径上的转角”拉直；下列情形会删除或改变烧成过程，必须拒绝
  const reason =
    end === from
      ? `第 ${i + 1}、${i + 2} 段是往返段（${from}→${a.target}→${end}℃），`
        + "合并后净温差为 0，烧成过程会被静默删除，已保留原段。"
    : (a.target > Math.max(from, end) || a.target < Math.min(from, end))
      ? `第 ${i + 1}、${i + 2} 段的中间温度 ${a.target}℃ 超出合并路径 `
        + `${from}→${end}℃，合并会丢掉这段温度行程，已保留原段。`
      : (a.hold > 0 && a.target !== end)
        ? `第 ${i + 1} 段在 ${a.target}℃ 有 ${a.hold}min 保温，合并后保温会被移到终点 `
          + `${end}℃（工艺被改变），已保留原段。如确需合并，请先手动清零该段保温。`
        : null;
  if (reason) {
    state.selSeg = i;
    renderAll();
    toast(reason);
    return;
  }

  commit(() => {
    const dT1 = Math.abs(a.target - from), dT2 = Math.abs(b.target - a.target);
    const t1 = a.rate > 0 ? dT1 / a.rate * 60 : 0;
    const t2 = b.rate > 0 ? dT2 / b.rate * 60 : 0;
    const totalT = t1 + t2;
    const rate = totalT > 0 ? tidy(Math.abs(end - from) * 60 / totalT) : 0;
    segs.splice(i, 2, { rate, target: end, hold: tidy(a.hold + b.hold) });
    state.selSeg = i;
  }, "已合并相邻段");
}
function deleteSegment(i) {
  commit(() => {
    state.plan.data.segments.splice(i, 1);
    state.selSeg = null; state.selNode = null;
  }, "已删除分段");
}

/* =====================================================================
 * 选择器 / 装载
 * =================================================================== */
async function renderSelectors() {
  const ks = $("#kilnSelect");
  ks.innerHTML = state.kilns.map((k) =>
    `<option value="${k.id}" ${k.id === state.kiln.id ? "selected" : ""}>${esc(k.name)}</option>`).join("");
  const ps = $("#planSelect");
  if (state.plans.length) {
    ps.innerHTML = state.plans.map((p) =>
      `<option value="${p.id}" ${p.id === state.plan.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  } else {
    ps.innerHTML = `<option value="">（无方案）</option>`;
  }
}

async function loadKiln(kilnId, preferredPlanId) {
  if (!state.kilns.some((k) => k.id === kilnId))
    state.kilns = await Store.listKilns();
  state.kiln = state.kilns.find((k) => k.id === kilnId) || state.kilns[0];
  state.plans = await Store.listPlans(state.kiln.id);
  let planId = preferredPlanId;
  if (!planId || !state.plans.some((p) => p.id === planId))
    planId = state.plans[0]?.id;
  await loadPlan(planId);
  await renderSelectors();
}

async function loadPlan(planId) {
  if (!planId) {
    state.plan = { id: null, name: "新方案", data: { startTemp: 20, segments: [] } };
  } else {
    const full = await Store.getPlan(planId);
    state.plan = { id: full.id, name: full.name, data: normalizePlan(full.data) };
  }
  state.past = [];
  state.future = [];
  state.selSeg = null; state.selNode = null;
  if (window.Review) Review.onPlanChanged();      // 复盘记录随方案切换
  await refreshVersions();
  renderAll();
}

async function createPlan() {
  const name = prompt("新方案名称：", "新烧窑方案 " + nowLabel());
  if (!name) return;
  const id = await Store.createPlan(state.kiln.id, name.trim(),
    { startTemp: state.kiln.config.maxTemp ? 20 : 20, segments: [] });
  state.plans = await Store.listPlans(state.kiln.id);
  await renderSelectors();
  await loadPlan(id);
  clearDraft();
}
async function deleteCurrentPlan() {
  if (!state.plan.id) return;
  if (!confirm(`确定删除方案「${state.plan.name}」及其全部版本？此操作不可撤销。`)) return;
  await Store.deletePlan(state.plan.id);
  clearDraft();
  state.plans = await Store.listPlans(state.kiln.id);
  await loadPlan(state.plans[0]?.id);
  await renderSelectors();
}
async function createKiln() {
  const name = prompt("新窑炉名称：", "新窑炉");
  if (!name) return;
  const id = await Store.createKiln(name.trim(), { ...DEFAULT_KILN });
  state.kilns = await Store.listKilns();
  const pid = await Store.createPlan(id, "新烧窑方案", { startTemp: 20, segments: [] });
  await loadKiln(id, pid);
  await renderSelectors();
  clearDraft();
}
async function deleteCurrentKiln() {
  if (state.kilns.length <= 1) { toast("至少保留一台窑炉"); return; }
  if (!confirm(`确定删除窑炉「${state.kiln.name}」及其全部方案与版本？`)) return;
  const oldId = state.kiln.id;
  await Store.deleteKiln(oldId);
  clearDraft();
  state.kilns = await Store.listKilns();
  await loadKiln(state.kilns[0].id);
  await renderSelectors();
}

/* =====================================================================
 * 渲染总入口
 * =================================================================== */
function renderAll() {
  if (!state.plan || !state.kiln) return;
  const model = buildModel(state.plan.data, state.kiln.config);
  renderSummary(model);
  renderChart();
  renderTable(model);
  renderIssues(model);
  renderSteps(model);
  renderKilnForm();
  if (window.Review) Review.onRenderAll(model);   // 复盘面板联动
  $("#btnUndo").disabled = state.past.length === 0;
  $("#btnRedo").disabled = state.future.length === 0;
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* =====================================================================
 * 帮助
 * =================================================================== */
function showHelp() {
  $("#helpBody").innerHTML = `
  <h3>编排方法</h3>
  <ul>
    <li>每段由 <b>升降温速率（℃/h）、目标温度（℃）、保温时长（min）</b> 组成；
      目标温度高于上一段即升温、低于即降温、相同则为纯保温（速率被忽略）。</li>
    <li>在图上拖动 <b>实心圆点</b> 可同时改变目标温度与速率（上下改温度、左右改耗时），
      拖动 <b>空心圆点</b> 改变保温时长，菱形点是起始炉温；按住 <b>Shift</b> 拖动按步进吸附。</li>
    <li>改任意参数后，总时长、各段起止时刻、编译步骤与曲线立即重算。</li>
    <li><b>拆段</b> 在段中点一分为二；<b>合并</b> 把相邻两段拉直成一段（同向路径保持总时长不变）。
      若合并会删掉温度行程（如 20→100→20℃ 往返段）或移走中间保温，工具会拒绝并保留原段。</li>
  </ul>
  <h3>五类校验问题</h3>
  <ul>
    <li><b>超温</b>：目标温度高于窑炉温度上限。</li>
    <li><b>能力不足</b>：升降温速率超过窑炉能力（原参数或取整后）。</li>
    <li><b>段数溢出</b>：分段数超过控制器可录入段数。</li>
    <li><b>零时长跳温</b>：升降耗时不足 1 分钟，控制器按 0 分钟处理，等于硬跳变。</li>
    <li><b>取整偏移</b>：按速率/温度/时长步进就近取整后数值变化；曲线图中虚线为取整后的执行曲线。</li>
  </ul>
  <p>点击问题清单中的条目，图上相应节点会高亮定位。</p>
  <h3>版本 / 对照 / 导出</h3>
  <ul>
    <li>“存为版本”冻结当前计划；随时可载入旧版，或在“版本 / 对照”里 A/B 对照参数与曲线。</li>
    <li>导出/导入为 JSON 文件，便于在同事电脑间传递（导入会新建窑炉与方案，不覆盖现有数据）。</li>
    <li>“打印卡”生成 A4 单页程序卡，含步骤表、曲线、问题提示与签名栏。</li>
  </ul>
  <h3>烧成复盘</h3>
  <ul>
    <li>在「烧成复盘」页导入控制器导出的 CSV：预览后指定时间列、炉温列与单位，
      裁掉点火前后区间并选定零时刻（应对齐方案程序起点）。</li>
    <li>空值、乱序、重复时间与异常采样间隔会逐行单独列出，<b>不做任何静默插值</b>。</li>
    <li>实测曲线（绿色）与取整执行曲线叠加，按各段窗口计算实测速率、到温时刻、
      保温偏差与超调，并标出未到温 / 持续偏离 / 采样缺口；点击发现可定位图表区间与 CSV 原始行。</li>
    <li>温度容差、最小持续时长、最大采样间隔可随时调整并立即重算；
      一个方案可保存多条烧成记录，可任选两条对照每段偏差，也可导出复盘 JSON。
      导入与复盘<b>不会修改方案程序</b>。</li>
  </ul>
  <h3>快捷键与数据</h3>
  <ul>
    <li><code>Ctrl+Z</code> 撤销，<code>Ctrl+Y</code> 或 <code>Ctrl+Shift+Z</code> 重做。</li>
    <li>数据保存在本机 <code>kiln.db</code>（SQLite）；若未启动服务直接打开页面，
      则保存在浏览器本地，功能不受影响。本工具不连接窑炉或任何外部平台。</li>
  </ul>`;
  $("#helpModal").hidden = false;
}

/* =====================================================================
 * 事件绑定 & 启动
 * =================================================================== */
function bindEvents() {
  // 顶栏
  $("#btnUndo").onclick = undo;
  $("#btnRedo").onclick = redo;
  $("#btnExamples").onclick = (e) => toggleExamples(e.currentTarget);
  $("#btnExport").onclick = exportJSON;
  $("#btnImport").onclick = () => $("#fileImport").click();
  $("#fileImport").onchange = (e) => {
    const f = e.target.files[0];
    if (f) importJSON(f);
    e.target.value = "";
  };
  $("#btnSaveVersion").onclick = saveVersion;
  $("#btnPrint").onclick = () => {
    buildPrintCard(buildModel(state.plan.data, state.kiln.config));
    $("#printCard").hidden = false;
    window.print();
    setTimeout(() => $("#printCard").hidden = true, 300);
  };
  $("#btnHelp").onclick = showHelp;
  $$("[data-close]").forEach((b) =>
    (b.onclick = () => $("#" + b.dataset.close).hidden = true));
  $$(".modal-backdrop").forEach((m) => {
    m.addEventListener("pointerdown", (e) => { if (e.target === m) m.hidden = true; });
  });

  // 选择器
  $("#kilnSelect").onchange = (e) => loadKiln(parseInt(e.target.value, 10));
  $("#planSelect").onchange = (e) => loadPlan(parseInt(e.target.value, 10));

  // 摘要里方案名 / 新建 / 删除（事件委托，因为每次重渲染）
  $("#summaryBar").addEventListener("change", (e) => {
    if (e.target.id === "planNameInput") {
      const v = e.target.value.trim();
      if (v) { commitInput(() => { state.plan.name = v; }, null); }
    }
  });
  $("#summaryBar").addEventListener("click", (e) => {
    if (e.target.id === "btnNewPlan") createPlan();
    if (e.target.id === "btnDeletePlan") deleteCurrentPlan();
  });

  // 分段表：输入 / 拆合并 / 行选择
  $("#segTbody").addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-field]");
    if (!inp) return;
    const i = parseInt(inp.dataset.seg, 10);
    const field = inp.dataset.field;
    const raw = inp.value.trim();
    commitInput(() => {
      if (raw === "") { state.plan.data.segments[i][field] = ""; }
      else {
        let v = num(raw, 0);
        if (field === "hold") v = Math.max(0, v);
        state.plan.data.segments[i][field] = v;
      }
    }, null);
  });
  $("#segTbody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      const i = parseInt(btn.dataset.seg, 10);
      if (btn.dataset.act === "split") splitSegment(i);
      if (btn.dataset.act === "merge") mergeSegment(i);
      if (btn.dataset.act === "del") deleteSegment(i);
      return;
    }
    const tr = e.target.closest("tr[data-seg]");
    if (tr) {
      const i = parseInt(tr.dataset.seg, 10);
      state.selSeg = i;
      state.selNode = `ramp-${i}`;
      renderAll();
      $("#chartWrap").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
  $("#startTempInput").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    commitInput(() => {
      state.plan.data.startTemp = v === "" ? "" : num(v, 20);
    }, null);
  });
  $("#btnAddSegment").onclick = appendSegment;

  // 问题点击定位
  $("#issueList").addEventListener("click", (e) => {
    const row = e.target.closest(".issue");
    if (!row) return;
    const issue = CH.model.issues[parseInt(row.dataset.issue, 10)];
    if (issue.nodeId) {
      state.selNode = issue.nodeId;
      if (issue.segIndex >= 0) state.selSeg = issue.segIndex;
      renderAll();
    }
    $("#chartWrap").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // 窑炉表单
  $("#kilnForm").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-kfield]");
    if (!inp) return;
    const key = inp.dataset.kfield;
    const v = inp.value.trim();
    commitInput(() => {
      if (key === "name") state.kiln.name = v || "未命名窑炉";
      else state.kiln.config[key] = v === "" ? 0 : Math.max(0, num(v, 0));
    }, "窑炉参数已更新并重新校验");
  });
  $("#btnNewKiln").onclick = createKiln;
  $("#btnDeleteKiln").onclick = deleteCurrentKiln;

  // 版本
  $("#versionList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-ver]");
    if (!btn) return;
    const id = parseInt(btn.dataset.id, 10);
    if (btn.dataset.ver === "del") {
      if (!confirm("删除这个版本？")) return;
      await Store.deleteVersion(id);
      await refreshVersions();
    } else {
      const v = await Store.getVersion(id);
      commit(() => { state.plan.data = normalizePlan(v.data); },
        `已载入版本「${v.label}」（可继续编辑）`);
    }
  });
  $("#btnDiff").onclick = openDiff;

  // 标签页
  $$(".tab").forEach((t) => t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
    $$(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.dataset.panel === t.dataset.tab));
    if (t.dataset.tab === "versions") refreshVersions();
  }));

  // 快捷键（输入框内保留原生撤销）
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      const typing = tag === "input" || tag === "textarea" || tag === "select";
      if (e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault(); redo();
      }
    }
    if (e.key === "Escape") $$(".modal-backdrop").forEach((m) => (m.hidden = true));
  });

  window.addEventListener("resize", () => renderChart());
}

async function seedIfEmpty() {
  const ex = examples()[0];
  const kid = await Store.createKiln(ex.kilnName, deepClone(ex.kilnConfig));
  const pid = await Store.createPlan(kid, ex.planName, deepClone(ex.plan));
  return { kid, pid };
}

async function boot() {
  bindEvents();
  await Store.detect();
  state.kilns = await Store.listKilns();
  let preferred = null;
  if (!state.kilns.length) {
    preferred = await seedIfEmpty();
    state.kilns = await Store.listKilns();
  }

  // 草稿恢复
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(LS.draft)); } catch (e) {}

  if (draft && state.kilns.some((k) => k.id === draft.kilnId)) {
    await loadKiln(draft.kilnId, draft.planId);
    const draftPlanExists = state.plan && state.plan.id === draft.planId;
    if (draftPlanExists) {
      // 用草稿覆盖刚载入的数据
      applySnapshot(draft.snap);
      state.past = []; state.future = [];
      renderAll();
      toast("已恢复上次未关闭的编辑稿");
    }
  } else {
    if (preferred) await loadKiln(preferred.kid, preferred.pid);
    else await loadKiln(state.kilns[0].id);
    await renderSelectors();
  }
}

if (typeof document !== "undefined")
  document.addEventListener("DOMContentLoaded", boot);

/* 供 Node 直接测试核心函数 */
if (typeof module !== "undefined" && module.exports)
  module.exports = { buildModel, qRound, fmtMin, examples, DEFAULT_KILN, normalizePlan: normalizePlan };
