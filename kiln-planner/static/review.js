"use strict";
/* =====================================================================
 * 烧成复盘 —— CSV 导入 / 实测曲线叠加 / 分段偏差分析 / 两次对照
 * 依赖 app.js 提供的全局：state, Store, buildModel, curvePoints, CH,
 * fmtMin, niceStep, esc, $, toast, renderAll, renderChart, nowLabel
 * 纯函数（CSV 解析、采样提取、分段分析）不依赖 DOM，可在 Node 下测试。
 * =================================================================== */

const REVIEW_DEFAULTS = { tolTemp: 10, minDurMin: 10, maxGapMin: 5 };
const QUALITY_CAP = 100;     // 每类质量问题最多记录的条数
const LOCATE_CAP = 300;      // 定位面板最多显示的原始行数

/* ----------------------------- 小工具（纯） ----------------------------- */
function fmtM(m) {
  if (!Number.isFinite(m)) return "—";
  const neg = m < 0;
  m = Math.round(Math.abs(m));
  return (neg ? "-" : "") + Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0");
}
function r1(v) { return Math.round(v * 10) / 10; }
function toPt(s) { return { t: s[0], temp: s[1], row: s[2], rawT: s[3] }; }

/* =====================================================================
 * CSV 解析（纯函数）
 * =================================================================== */
function decodeCSVBuffer(buf) {
  if (!buf || buf.byteLength === 0)
    return { error: "文件为空。请确认控制器已完成导出、文件大小不为 0。" };
  const b = new Uint8Array(buf);
  if (b[0] === 0x50 && b[1] === 0x4b)
    return { error: "该文件是 Excel 工作簿（.xlsx），不是 CSV。请用 Excel/WPS 打开后「另存为 → CSV UTF-8」再导入。" };
  if (b[0] === 0xd0 && b[1] === 0xcf)
    return { error: "该文件是老式 Excel 工作簿（.xls），不是 CSV。请另存为 CSV 文本后再导入。" };
  let text = null, encoding = "UTF-8";
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(b); }
  catch (e) {
    try { text = new TextDecoder("gbk").decode(b); encoding = "GBK"; }
    catch (e2) { text = new TextDecoder("utf-8").decode(b); }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim())
    return { error: "文件只有空白字符，没有可解析的数据。请确认导出的是温度记录而非空模板。" };
  return { text, encoding };
}

function detectDelimiter(lines) {
  const cands = [",", ";", "\t", "|"];
  let best = null, bestScore = 0;
  for (const c of cands) {
    const counts = lines.slice(0, 8)
      .map((l) => l.split(c).length - 1)
      .filter((n) => n > 0);
    if (counts.length >= 2 && counts.every((n) => n === counts[0])) {
      const score = counts[0] * counts.length;
      if (score > bestScore) { bestScore = score; best = c; }
    }
  }
  return best;
}

function parseCSVText(text, forcedDelim) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { error: "文件为空。" };
  const delim = forcedDelim || detectDelimiter(lines);
  if (!delim)
    return { error: "未检测到逗号、分号或制表符分隔，无法识别为 CSV。\n"
      + "请确认控制器导出的是 CSV 文本；若是 .xlsx 文件，请先另存为 CSV。" };
  const rows = lines.map((line) => {
    const cells = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { cells.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  });
  if (rows[0].length < 2)
    return { error: "每行只有 1 列，至少需要「时间」和「炉温」两列。请检查分隔符是否选对。" };
  return { delimiter: delim, rows };
}

function parseTempValue(raw) {
  const m = String(raw).match(/[-+]?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const TIME_FMT_LABELS = {
  auto: "日期时间（自动识别）",
  clock: "时钟 HH:MM[:SS]（跨零点自动 +24h）",
  elapsed_s: "相对秒",
  elapsed_min: "相对分钟",
  elapsed_h: "相对小时",
};

/* 解析时间单元格为“分钟”。ctx 携带跨零点/首行基准状态，逐行推进。 */
function parseTimeValue(raw, fmt, ctx) {
  const s = String(raw).trim();
  if (!s) return null;
  if (fmt === "elapsed_s" || fmt === "elapsed_min" || fmt === "elapsed_h") {
    if (!/^[-+]?\d+(?:\.\d+)?$/.test(s)) return null;   // 相对时间必须是纯数字
    const v = parseFloat(s);
    return fmt === "elapsed_s" ? v / 60 : fmt === "elapsed_h" ? v * 60 : v;
  }
  // 时钟（auto 与 clock 都尝试）
  const mc = s.match(/^(\d{1,3}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (mc) {
    let v = (+mc[1]) * 60 + (+mc[2]) + (mc[3] ? +mc[3] / 60 : 0);
    if (ctx.prevClock !== undefined && v < ctx.prevClock - 720)
      ctx.dayOffset = (ctx.dayOffset || 0) + 1440;      // 跨零点：+24h
    ctx.prevClock = v;
    return v + (ctx.dayOffset || 0);
  }
  if (fmt === "clock") return null;
  // YYYY-MM-DD / YYYY/M/D / YYYY.M.D + 时间
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const v = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 60000;
    if (ctx.firstAbs === undefined) ctx.firstAbs = v;
    return v - ctx.firstAbs;
  }
  // M/D/YYYY HH:MM（部分美系控制器）
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const v = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0)) / 60000;
    if (ctx.firstAbs === undefined) ctx.firstAbs = v;
    return v - ctx.firstAbs;
  }
  return null;
}

function guessHasHeader(rows) {
  if (rows.length < 2) return false;
  const r0 = rows[0], r1 = rows[1];
  let score = 0;
  for (let c = 0; c < r0.length; c++) {
    const a = r0[c] || "", b = r1[c] || "";
    const aAlpha = /[A-Za-z一-鿿°]/.test(a);
    const bData = parseTempValue(b) !== null || parseTimeValue(b, "auto", {}) !== null;
    if (aAlpha && bData) score++;
  }
  return score >= Math.max(1, Math.floor(r0.length / 2));
}

function guessMapping(rows, hasHeader) {
  const start = hasHeader ? 1 : 0;
  const dataRows = rows.slice(start, start + 30);
  const nCols = Math.max(...rows.map((r) => r.length));
  const timeScore = [], tempScore = [];
  for (let c = 0; c < nCols; c++) {
    let ts = 0, vs = 0;
    dataRows.forEach((r) => {
      const cell = (r[c] || "").trim();
      if (!cell) return;
      if (parseTimeValue(cell, "auto", {}) !== null) ts++;
      if (parseTempValue(cell) !== null) vs++;
    });
    const head = hasHeader ? (rows[0][c] || "") : "";
    if (/时间|时刻|日期|time|date/i.test(head)) ts += 5;
    if (/温度|炉温|temp|pv|实测/i.test(head)) vs += 5;
    timeScore[c] = ts; tempScore[c] = vs;
  }
  let timeCol = 0, best = -1;
  timeScore.forEach((s, c) => { if (s > best) { best = s; timeCol = c; } });
  let tempCol = -1; best = -1;
  tempScore.forEach((s, c) => { if (c !== timeCol && s > best) { best = s; tempCol = c; } });
  if (tempCol < 0) tempCol = timeCol === 0 ? 1 : 0;
  let timeFormat = "elapsed_min";
  const cell = ((dataRows[0] || [])[timeCol] || "").trim();
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(cell) || /^\d{1,2}\/\d{1,2}\/\d{4}/.test(cell))
    timeFormat = "auto";
  else if (/^\d{1,3}:\d{2}/.test(cell)) timeFormat = "clock";
  return { timeCol, tempCol, timeFormat };
}

/* 逐行提取样本。空值/无法解析/乱序/重复分别记录，剔除行全部可查，绝不插值。 */
function extractSamples(rows, opt) {
  const issues = { empty: [], format: [], outOfOrder: [], duplicate: [] };
  const counts = { empty: 0, format: 0, outOfOrder: 0, duplicate: 0 };
  const push = (kind, row, text) => {
    counts[kind]++;
    if (issues[kind].length < QUALITY_CAP) issues[kind].push({ row, text });
  };
  const samples = [];
  const ctx = {};
  let prevT = -Infinity, rowsTotal = 0;
  const start = opt.hasHeader ? 1 : 0;
  for (let r = start; r < rows.length; r++) {
    const cells = rows[r];
    const rowNo = r + 1;                       // CSV 行号（含表头）
    const rawT = (cells[opt.timeCol] ?? "").trim();
    const rawV = (cells[opt.tempCol] ?? "").trim();
    if (!rawT && !rawV) continue;              // 整行空白：跳过不计
    rowsTotal++;
    if (!rawT) { push("empty", rowNo, `时间列为空（温度=${rawV || "空"}）`); continue; }
    if (!rawV) { push("empty", rowNo, `温度列为空（时间=${rawT}）`); continue; }
    const temp0 = parseTempValue(rawV);
    if (temp0 === null) { push("format", rowNo, `温度无法解析：“${rawV}”`); continue; }
    const t = parseTimeValue(rawT, opt.timeFormat, ctx);
    if (t === null) {
      push("format", rowNo,
        `时间无法解析：“${rawT}”（当前格式：${TIME_FMT_LABELS[opt.timeFormat]}）`);
      continue;
    }
    if (t < prevT - 1e-9) { push("outOfOrder", rowNo, `时间早于上一有效行：“${rawT}”`); continue; }
    if (t - prevT < 1e-9) { push("duplicate", rowNo, `时间与上一有效行重复：“${rawT}”`); continue; }
    prevT = t;
    samples.push({
      t,
      temp: opt.unit === "F" ? (temp0 - 32) * 5 / 9 : temp0,
      row: rowNo, rawT,
    });
  }
  return { samples, issues, counts, rowsTotal };
}

/* 异常采样间隔：超过中位数 3 倍（且至少多 2 分钟） */
function detectAbnormalGaps(samples) {
  if (samples.length < 4) return [];
  const gaps = [];
  for (let k = 1; k < samples.length; k++)
    gaps.push({ k, gap: samples[k].t - samples[k - 1].t });
  const sorted = gaps.map((g) => g.gap).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const limit = Math.max(med * 3, med + 2);
  return gaps.filter((g) => g.gap > limit)
    .map((g) => ({ row: samples[g.k].row,
                   t0: samples[g.k - 1].t, t1: samples[g.k].t, gapMin: g.gap }));
}

/* 裁剪 + 零时刻平移，输出存储格式 [t, temp, row, rawT] */
function applyTrimZero(samples, trimStart, trimEnd, zero) {
  return samples
    .filter((p) => p.t >= trimStart - 1e-9 && p.t <= trimEnd + 1e-9)
    .map((p) => [Math.round((p.t - zero) * 1000) / 1000,
                 Math.round(p.temp * 100) / 100, p.row, p.rawT]);
}

/* =====================================================================
 * 分段复盘分析（纯函数）：按取整执行曲线的段窗口计算
 * =================================================================== */
function analyzeFiring(model, samples, params) {
  const tol = params.tolTemp, minDur = params.minDurMin, maxGap = params.maxGapMin;
  const segs = [], findings = [];
  const S = samples;
  const inWin = (a, b) => S.filter((p) => p.t >= a - 1e-9 && p.t <= b + 1e-9);

  model.segs.forEach((s, i) => {
    const win = { start: s.compStartMin, rampEnd: s.compRampEndMin, end: s.compEndMin };
    const dir = s.flat ? "flat" : s.up ? "up" : "down";
    const planned = s.flat ? 0 : (s.up ? s.qRate : -s.qRate);
    const seg = {
      i, dir, win, plannedRate: planned, qTarget: s.qTarget, qHold: s.qHold,
      actualRate: null, rateDevPct: null,
      reachTime: null, reachDelay: null, reached: null,
      hold: null, overshoot: null, gaps: [], sampleCount: 0,
    };
    const winLen = win.end - win.start;
    if (winLen < 0.5) { segs.push(seg); return; }   // 退化窗口（零跳温段）无法评估

    const all = inWin(win.start, win.end);
    seg.sampleCount = all.length;

    // ---- 采样缺口（含窗口边缘）----
    const gaps = [];
    if (!all.length) {
      if (winLen > maxGap) gaps.push({ t0: win.start, t1: win.end, gap: winLen });
    } else {
      if (all[0].t - win.start > maxGap)
        gaps.push({ t0: win.start, t1: all[0].t, gap: all[0].t - win.start });
      for (let k = 1; k < all.length; k++) {
        const g = all[k].t - all[k - 1].t;
        if (g > maxGap) gaps.push({ t0: all[k - 1].t, t1: all[k].t, gap: g });
      }
      const lastT = all[all.length - 1].t;
      if (win.end - lastT > maxGap)
        gaps.push({ t0: lastT, t1: win.end, gap: win.end - lastT });
    }
    seg.gaps = gaps;

    // ---- 实测升降温速率（升降段窗口内最小二乘）----
    if (!s.flat && win.rampEnd > win.start) {
      const rp = inWin(win.start, win.rampEnd);
      if (rp.length >= 2 && rp[rp.length - 1].t - rp[0].t > 0.5) {
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        rp.forEach((p) => { sx += p.t; sy += p.temp; sxx += p.t * p.t; sxy += p.t * p.temp; });
        const n = rp.length, den = n * sxx - sx * sx;
        if (den > 1e-9) {
          seg.actualRate = (n * sxy - sx * sy) / den * 60;   // ℃/h
          if (planned) seg.rateDevPct = (seg.actualRate - planned) / Math.abs(planned) * 100;
        }
      }
    }

    // ---- 到温时刻（窗口后给宽限：ramp 的 10%，5–30 分钟）----
    if (!s.flat) {
      const rampMin = Math.max(0, win.rampEnd - win.start);
      const grace = Math.min(30, Math.max(5, rampMin * 0.1));
      const cand = inWin(win.start, win.end + grace);
      const hit = cand.find((p) =>
        s.up ? p.temp >= s.qTarget - tol : p.temp <= s.qTarget + tol);
      if (hit) {
        seg.reached = true;
        seg.reachTime = hit.t;
        seg.reachDelay = hit.t - win.rampEnd;
      } else {
        seg.reached = false;
        if (cand.length) {
          let extreme = cand[0].temp;
          cand.forEach((p) => {
            extreme = s.up ? Math.max(extreme, p.temp) : Math.min(extreme, p.temp);
          });
          findings.push({ sev: "error", code: "unreached", segIndex: i,
            t0: win.start, t1: win.end,
            data: { target: s.qTarget, dir, extreme: r1(extreme) } });
        }
      }
    }

    // ---- 保温区间偏差 + 持续偏离 ----
    if (s.qHold > 0 && win.end > win.rampEnd) {
      const hp = inWin(win.rampEnd, win.end);
      if (hp.length) {
        let sum = 0, maxAbs = 0, outN = 0, best = null, cur = null;
        hp.forEach((p) => {
          const dev = p.temp - s.qTarget;
          sum += dev;
          const a = Math.abs(dev);
          if (a > maxAbs) maxAbs = a;
          if (a > tol) {
            outN++;
            if (cur) { cur.t1 = p.t; cur.n++; } else cur = { t0: p.t, t1: p.t, n: 1 };
          } else {
            if (cur && (!best || cur.t1 - cur.t0 > best.t1 - best.t0)) best = cur;
            cur = null;
          }
        });
        if (cur && (!best || cur.t1 - cur.t0 > best.t1 - best.t0)) best = cur;
        const longest = best ? best.t1 - best.t0 : 0;
        seg.hold = { meanDev: sum / hp.length, maxAbsDev: maxAbs,
                     outPct: outN / hp.length * 100, longestOut: longest, n: hp.length };
        if (best && best.n >= 2 && longest >= minDur)
          findings.push({ sev: "error", code: "sustainedDev", segIndex: i,
            t0: best.t0, t1: best.t1, data: { dur: r1(longest), target: s.qTarget } });
      }
    }

    // ---- 峰值超调（整个段窗口）----
    if (all.length) {
      let os;
      if (s.down) {
        let mn = all[0].temp;
        all.forEach((p) => { mn = Math.min(mn, p.temp); });
        os = s.qTarget - mn;
      } else {
        let mx = all[0].temp;
        all.forEach((p) => { mx = Math.max(mx, p.temp); });
        os = mx - s.qTarget;
      }
      seg.overshoot = r1(os);
      if (os > tol)
        findings.push({ sev: "warn", code: "overshoot", segIndex: i,
          t0: win.start, t1: win.end,
          data: { os: r1(os), target: s.qTarget, dir } });
    }

    // ---- 采样缺口 / 无数据 ----
    if (gaps.length) {
      let mx = 0;
      gaps.forEach((g) => { mx = Math.max(mx, g.gap); });
      findings.push({ sev: "warn", code: "gap", segIndex: i,
        t0: gaps[0].t0, t1: gaps[0].t1, data: { count: gaps.length, max: r1(mx) } });
    }
    if (!all.length)
      findings.push({ sev: "warn", code: "noData", segIndex: i,
        t0: win.start, t1: win.end, data: {} });

    // ---- 速率偏差（提示级）----
    if (seg.rateDevPct !== null && Math.abs(seg.rateDevPct) > 30 &&
        Math.abs(seg.actualRate - planned) > 10)
      findings.push({ sev: "info", code: "rateDev", segIndex: i,
        t0: win.start, t1: win.rampEnd,
        data: { planned, actual: r1(seg.actualRate), pct: Math.round(seg.rateDevPct) } });

    segs.push(seg);
  });

  const sevRank = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => sevRank[a.sev] - sevRank[b.sev] || a.segIndex - b.segIndex);

  let peak = null;
  if (S.length) {
    let mx = S[0];
    S.forEach((p) => { if (p.temp > mx.temp) mx = p; });
    peak = { temp: mx.temp, t: mx.t, row: mx.row };
  }
  return { segs, findings, peak };
}

function findingText(f, params) {
  const seg = `第 ${f.segIndex + 1} 段`;
  const d = f.data || {};
  switch (f.code) {
    case "unreached":
      return { title: `${seg}未到温`,
        desc: `窗口 ${fmtM(f.t0)}–${fmtM(f.t1)} 内实测${d.dir === "down" ? "最低" : "最高"}`
          + `仅 ${d.extreme}℃，未进入目标 ${d.target}℃ ±${params.tolTemp}℃ 区间。` };
    case "sustainedDev":
      return { title: `${seg}保温持续偏离`,
        desc: `${fmtM(f.t0)}–${fmtM(f.t1)} 连续约 ${Math.round(d.dur)} 分钟偏离目标 `
          + `${d.target}℃ 超过 ±${params.tolTemp}℃。` };
    case "overshoot":
      return { title: `${seg}${d.dir === "down" ? "下冲" : "超调"} ${d.os.toFixed(1)}℃`,
        desc: `窗口内实测${d.dir === "down" ? "低于" : "高于"}目标 ${d.target}℃ 达 `
          + `${d.os.toFixed(1)}℃（容差 ±${params.tolTemp}℃）。` };
    case "gap":
      return { title: `${seg}采样缺口 ×${d.count}`,
        desc: `最长缺口 ${d.max.toFixed(1)} 分钟（${fmtM(f.t0)} 起），超过最大采样间隔 `
          + `${params.maxGapMin} 分钟；缺失区间未做插值。` };
    case "noData":
      return { title: `${seg}窗口内无实测样本`,
        desc: `${fmtM(f.t0)}–${fmtM(f.t1)} 没有任何采样点。请检查裁剪区间、零时刻或 CSV 是否完整。` };
    case "rateDev":
      return { title: `${seg}实测速率偏差 ${d.pct > 0 ? "+" : ""}${d.pct}%`,
        desc: `计划（取整）${d.planned}℃/h，实测约 ${d.actual}℃/h。` };
    default: return { title: seg, desc: "" };
  }
}

/* =====================================================================
 * 示例 CSV（与内置示例「高温釉烧」方案相匹配，含若干典型数据缺陷）
 * =================================================================== */
function demoCSV() {
  const prog = [[100, 600, 0], [80, 1050, 10], [33, 1240, 20], [130, 900, 0], [80, 80, 0]];
  const segs = [];
  let t = 0, temp = 25;
  prog.forEach(([rate, target, hold]) => {
    const ramp = Math.abs(target - temp) / rate * 60;
    segs.push({ t0: t, t1: t + ramp, from: temp, to: target });
    t += ramp;
    if (hold > 0) { segs.push({ t0: t, t1: t + hold, from: target, to: target }); t += hold; }
    temp = target;
  });
  const total = t;
  const sp = (tt) => {
    for (const s of segs)
      if (tt <= s.t1)
        return s.from + (s.to - s.from) * (tt - s.t0) / Math.max(1e-9, s.t1 - s.t0);
    return temp;
  };
  const holdStart = segs[4].t0;                    // 1240℃ 保温起点
  const fmtDT = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
         + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  const start = Date.UTC(2026, 8, 10, 8, 0, 0);
  const lines = ["No.,Time,PV(°C)"];
  let act = 25, prevTs = "", seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let tt = 0; tt <= Math.round(total); tt++) {
    const no = tt + 1;
    act += (sp(tt) - act) * 0.18;                              // 跟踪滞后
    let v = act + (rand() - 0.5) * 3;                          // 噪声
    if (tt > holdStart && tt < holdStart + 25)
      v += 14 * Math.exp(-(tt - holdStart) / 9);               // 到温超调
    const ts = fmtDT(start + tt * 60000);
    if (no === 300) { lines.push(`${no},${ts},`); prevTs = ts; continue; }        // 空温度
    if (no === 700) { lines.push(`${no},${prevTs},${v.toFixed(1)}`); prevTs = ts; continue; } // 重复时间
    if (no === 1000) {                                                  // 乱序时间
      lines.push(`${no},${fmtDT(start + (tt - 30) * 60000)},${v.toFixed(1)}`);
      prevTs = ts; continue;
    }
    if (no >= 1200 && no < 1209) { prevTs = ts; continue; }             // 9 分钟采样缺口
    lines.push(`${no},${ts},${v.toFixed(1)}`);
    prevTs = ts;
  }
  return lines.join("\r\n");
}

/* =====================================================================
 * 复盘 UI 状态
 * =================================================================== */
const rv = {
  records: [],          // 当前方案的记录摘要
  active: null,         // 完整记录 {id, planId, name, createdAt, meta, samples}
  pts: null,            // [{t, temp, row, rawT}]
  analysis: null,
  params: { ...REVIEW_DEFAULTS },
  highlight: null,      // {t0, t1}
  persistTimer: null,
};

const csvW = {
  fileName: "", encoding: "", text: "",
  delimiter: ",", delimChoice: "auto",
  rows: [], hasHeader: true,
  map: { timeCol: 0, tempCol: 1, timeFormat: "auto", unit: "C" },
  parsed: null, gaps: [],
  trim: { start: 0, end: 0, zero: 0 },
  name: "",
};

/* ----------------------------- app.js 钩子 ----------------------------- */
function extendDomain(dom) {
  if (!rv.pts || !rv.pts.length) return;
  let mn = Infinity, mx = -Infinity, tmax = 0;
  rv.pts.forEach((p) => {
    if (p.temp < mn) mn = p.temp;
    if (p.temp > mx) mx = p.temp;
    if (p.t > tmax) tmax = p.t;
  });
  dom.xmax = Math.max(dom.xmax, tmax);
  if (mn < dom.ymin) dom.ymin = Math.max(0, Math.floor((mn - 10) / 10) * 10);
  if (mx > dom.ymax) dom.ymax = Math.ceil((mx + 10) / 10) * 10;
}

function chartOverlay(X, Y, model) {
  if (!rv.active || !rv.pts || !rv.pts.length) return "";
  let g = "";
  if (rv.highlight) {
    const x0 = X(rv.highlight.t0), x1 = X(rv.highlight.t1);
    g += `<rect class="review-band" x="${Math.min(x0, x1).toFixed(1)}" y="${CH.mt}" `
       + `width="${Math.max(2, Math.abs(x1 - x0)).toFixed(1)}" height="${CH.H - CH.mt - CH.mb}"/>`;
  }
  model.segs.forEach((s) => {
    if (s.compStartMin > 0.5)
      g += `<line class="review-segline" x1="${X(s.compStartMin)}" x2="${X(s.compStartMin)}"
             y1="${CH.mt}" y2="${CH.H - CH.mb}"/>`;
  });
  const d = rv.pts.map((p, k) =>
    `${k ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.temp).toFixed(1)}`).join("");
  g += `<path class="curve-actual" d="${d}"/>`;
  return g;
}

function onRenderAll(model) {
  updateActiveBar();
  const has = !!(rv.active && rv.pts);
  const card = $("#reviewSegCard");
  if (card) card.hidden = !has;
  if (!has) return;
  rv.analysis = analyzeFiring(model, rv.pts, rv.params);
  renderFindings();
  renderSegTable(model);
}

function onPlanChanged() {
  rv.active = null; rv.pts = null; rv.analysis = null; rv.highlight = null;
  rv.records = [];
  updateActiveBar();
  ["#reviewParamSection", "#reviewFindingsSection", "#reviewQualitySection",
   "#reviewCompareSection"].forEach((sel) => { const el = $(sel); if (el) el.hidden = true; });
  const seg = $("#reviewSegCard"); if (seg) seg.hidden = true;
  const loc = $("#reviewLocateCard"); if (loc) loc.hidden = true;
  refreshRecordList();
}

/* ----------------------------- 记录列表 ----------------------------- */
async function refreshRecordList() {
  const el = $("#firingList");
  if (!el) return;
  if (!state.plan || state.plan.id == null) {
    rv.records = [];
    el.innerHTML = `<div class="empty">当前方案尚未保存。请先保留一个方案，再导入烧成记录。</div>`;
    updateCompareUI();
    return;
  }
  try { rv.records = await Store.listFirings(state.plan.id); }
  catch (e) {
    el.innerHTML = `<div class="empty">记录加载失败：${esc(e.message)}</div>`;
    updateCompareUI();
    return;
  }
  if (!rv.records.length) {
    el.innerHTML = `<div class="empty">本方案还没有烧成记录。<br>点击上方「导入控制器 CSV」导入实测数据；没有现成文件时可先「下载示例 CSV」体验。</div>`;
  } else {
    el.innerHTML = rv.records.map((r) => {
      const isActive = rv.active && rv.active.id === r.id;
      return `<div class="version-row ${isActive ? "active-rec" : ""}">
        <div class="vmeta">
          <div class="vlabel">${esc(r.name)}</div>
          <div class="vtime">${esc(r.createdAt || "")} · ${r.sampleCount} 样本</div>
        </div>
        <div class="vact-btns">
          <button data-fact="open" data-id="${r.id}">${isActive ? "退出" : "查看"}</button>
          <button data-fact="rename" data-id="${r.id}" title="重命名记录">改名</button>
          <button data-fact="export" data-id="${r.id}" title="导出复盘 JSON">导出</button>
          <button class="danger" data-fact="del" data-id="${r.id}" title="删除记录">删</button>
        </div>
      </div>`;
    }).join("");
  }
  updateCompareUI();
}

function updateCompareUI() {
  const sec = $("#reviewCompareSection");
  if (!sec) return;
  sec.hidden = rv.records.length === 0;
  const opts = rv.records.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  const a = $("#cmpA"), b = $("#cmpB");
  if (a) a.innerHTML = opts;
  if (b) { b.innerHTML = opts; b.selectedIndex = Math.min(1, rv.records.length - 1); }
  const btn = $("#btnCompareFirings");
  if (btn) btn.disabled = rv.records.length < 2;
}

async function openFiring(id) {
  if (rv.active && rv.active.id === id) { deactivateFiring(); return; }
  let rec;
  try { rec = await Store.getFiring(id); }
  catch (e) { toast("读取记录失败：" + e.message); return; }
  if (!rec) { toast("记录不存在"); return; }
  rv.active = rec;
  rv.pts = rec.samples.map(toPt);
  rv.params = { ...REVIEW_DEFAULTS, ...(rec.meta.params || {}) };
  rv.highlight = null;
  renderParamsForm();
  renderQuality();
  ["#reviewParamSection", "#reviewFindingsSection", "#reviewQualitySection"]
    .forEach((sel) => { $(sel).hidden = false; });
  $("#reviewLocateCard").hidden = true;
  renderAll();              // 触发图表叠加 + onRenderAll 分析
  refreshRecordList();
  toast(`已载入「${rec.name}」，实测曲线已叠加到图上`);
}

function deactivateFiring() {
  rv.active = null; rv.pts = null; rv.analysis = null; rv.highlight = null;
  ["#reviewParamSection", "#reviewFindingsSection", "#reviewQualitySection"]
    .forEach((sel) => { $(sel).hidden = true; });
  $("#reviewSegCard").hidden = true;
  $("#reviewLocateCard").hidden = true;
  updateActiveBar();
  renderAll();
  refreshRecordList();
}

async function renameFiring(id) {
  const rec = rv.records.find((r) => r.id === id);
  const name = prompt("记录名称：", rec ? rec.name : "");
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    const full = await Store.getFiring(id);
    if (!full) { toast("记录不存在"); return; }
    await Store.updateFiring(id, trimmed, full.meta);   // 只改记录，不动方案
    if (rv.active && rv.active.id === id) {
      rv.active.name = trimmed;
      updateActiveBar();
    }
    await refreshRecordList();
    toast("已重命名");
  } catch (e) { toast("重命名失败：" + e.message); }
}

async function deleteFiring(id) {
  const rec = rv.records.find((r) => r.id === id);
  if (!confirm(`确定删除烧成记录「${rec ? rec.name : id}」？此操作不可撤销（方案程序不受影响）。`)) return;
  try {
    await Store.deleteFiring(id);
    if (rv.active && rv.active.id === id) deactivateFiring();
    await refreshRecordList();
    toast("已删除烧成记录");
  } catch (e) { toast("删除失败：" + e.message); }
}

async function exportFiring(id) {
  let rec;
  try { rec = await Store.getFiring(id); }
  catch (e) { toast("读取记录失败：" + e.message); return; }
  if (!rec) { toast("记录不存在"); return; }
  const model = buildModel(state.plan.data, state.kiln.config);
  const params = { ...REVIEW_DEFAULTS, ...(rec.meta.params || {}) };
  const analysis = analyzeFiring(model, rec.samples.map(toPt), params);
  const payload = {
    app: "kiln-planner",
    kind: "firing-review",
    format: 1,
    exportedAt: new Date().toISOString(),
    note: "复盘数据仅供分析存档；重新导入不会改变任何方案程序。",
    kiln: { name: state.kiln.name },
    plan: { name: state.plan.name, data: state.plan.data },
    firing: { name: rec.name, createdAt: rec.createdAt,
              meta: rec.meta, samples: rec.samples },
    params,
    analysis: {
      segments: analysis.segs,
      findings: analysis.findings.map((f) => ({ ...f, ...findingText(f, params) })),
      peak: analysis.peak,
    },
  };
  downloadJSON(payload, rec.name.replace(/[\\/:*?"<>|]/g, "_") + "-复盘.json");
  toast("已导出复盘 JSON");
}

/* ----------------------------- 激活条 / 参数 / 发现 ----------------------------- */
function updateActiveBar() {
  const bar = $("#reviewActiveBar");
  const legend = $("#legendActual");
  if (!bar) return;
  if (rv.active && rv.pts) {
    bar.hidden = false;
    if (legend) legend.hidden = false;
    bar.innerHTML = `复盘模式：正在对照记录 <b>${esc(rv.active.name)}</b>`
      + `（${rv.pts.length} 个样本，绿色为实测曲线，按当前方案取整曲线分段）`
      + `<button data-exit-review="1">退出复盘</button>`;
  } else {
    bar.hidden = true;
    if (legend) legend.hidden = true;
    bar.innerHTML = "";
  }
}

function renderParamsForm() {
  $("#reviewParamsForm").innerHTML = `
    <label>温度容差（±℃）</label>
    <input type="number" data-rparam="tolTemp" value="${rv.params.tolTemp}" min="0.5" step="0.5">
    <label>最小持续时长（min）</label>
    <input type="number" data-rparam="minDurMin" value="${rv.params.minDurMin}" min="1" step="1">
    <label>最大采样间隔（min）</label>
    <input type="number" data-rparam="maxGapMin" value="${rv.params.maxGapMin}" min="0.5" step="0.5">`;
}

function onParamInput(e) {
  const inp = e.target.closest("[data-rparam]");
  if (!inp) return;
  const v = parseFloat(inp.value);
  if (!Number.isFinite(v) || v <= 0) return;
  rv.params[inp.dataset.rparam] = v;
  reanalyze();
}

function reanalyze() {
  if (!rv.active || !rv.pts) return;
  const model = buildModel(state.plan.data, state.kiln.config);
  rv.analysis = analyzeFiring(model, rv.pts, rv.params);
  renderFindings();
  renderSegTable(model);
  renderChart();
  schedulePersistParams();
}

/* 参数改动写回记录元信息（仅记录，不涉及方案） */
function schedulePersistParams() {
  clearTimeout(rv.persistTimer);
  rv.persistTimer = setTimeout(async () => {
    if (!rv.active) return;
    rv.active.meta = { ...rv.active.meta, params: { ...rv.params } };
    try { await Store.updateFiring(rv.active.id, rv.active.name, rv.active.meta); }
    catch (e) { /* 参数持久化失败不影响使用 */ }
  }, 800);
}

function renderFindings() {
  const el = $("#reviewFindings");
  if (!el) return;
  const a = rv.analysis;
  if (!a) { el.innerHTML = ""; return; }
  if (!state.plan.data.segments.length) {
    el.innerHTML = `<div class="empty">当前方案没有分段，无法按段复盘。请先在「分段编排」中添加分段。</div>`;
    return;
  }
  if (!a.findings.length) {
    el.innerHTML = `<div class="empty">✓ 在 ±${rv.params.tolTemp}℃ 容差内跟踪良好：未发现未到温、持续偏离或采样缺口。</div>`;
    return;
  }
  el.innerHTML = a.findings.map((f, k) => {
    const t = findingText(f, rv.params);
    return `<div class="issue ${f.sev}" data-finding="${k}">
      <span class="dot"></span>
      <span class="itext">
        <div class="ititle">${esc(t.title)}</div>
        <div class="idesc">${esc(t.desc)}</div>
        <div class="iloc">点击定位图表区间与 CSV 原始行</div>
      </span>
    </div>`;
  }).join("");
}

function renderSegTable(model) {
  const tb = $("#reviewSegTbody");
  if (!tb || !rv.analysis) return;
  $("#reviewSegSub").textContent =
    `对照「${rv.active.name}」 · 容差 ±${rv.params.tolTemp}℃ · 持续 ≥${rv.params.minDurMin}min · 缺口 >${rv.params.maxGapMin}min`;
  if (!model.segs.length) {
    tb.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#9a9188;padding:16px">
      当前方案没有分段。请先在下方「分段编排」中添加分段，复盘会立即按段重算。</td></tr>`;
    return;
  }
  const flagOf = (i) => rv.analysis.findings.filter((f) => f.segIndex === i);
  const tagName = { unreached: ["未到温", "error"], sustainedDev: ["持续偏离", "error"],
                    overshoot: ["超调", "warn"], gap: ["缺口", "warn"],
                    noData: ["无数据", "warn"], rateDev: ["速率", "info"] };
  tb.innerHTML = rv.analysis.segs.map((sg) => {
    const dirPill = sg.dir === "flat"
      ? `<span class="dir-pill dir-flat">保温</span>`
      : sg.dir === "up" ? `<span class="dir-pill dir-up">↑ 升温</span>`
                        : `<span class="dir-pill dir-down">↓ 降温</span>`;
    const ratePlan = sg.dir === "flat" ? "—" : `${sg.plannedRate}℃/h`;
    const rateAct = sg.actualRate === null ? "—"
      : `${sg.actualRate.toFixed(1)}℃/h`
        + (sg.rateDevPct !== null
            ? ` <small>(${sg.rateDevPct > 0 ? "+" : ""}${Math.round(sg.rateDevPct)}%)</small>` : "");
    const reach = sg.dir === "flat" ? "—"
      : sg.reached === false ? `<span class="tag error">未到温</span>`
      : sg.reached === null ? "—"
      : `${fmtM(sg.reachTime)} <small>(${sg.reachDelay >= 0 ? "+" : ""}${Math.round(sg.reachDelay)}min)</small>`;
    const hold = sg.hold
      ? `均 ${sg.hold.meanDev >= 0 ? "+" : ""}${sg.hold.meanDev.toFixed(1)} / 峰 ${sg.hold.maxAbsDev.toFixed(1)}℃`
      : "—";
    const os = sg.overshoot !== null && sg.overshoot > 0
      ? `${sg.overshoot.toFixed(1)}℃` : "—";
    const tags = flagOf(sg.i).map((f) => {
      const [name, sev] = tagName[f.code] || [f.code, "info"];
      return `<span class="tag ${sev}">${name}</span>`;
    }).join("");
    return `<tr class="review-seg-row" data-segwin="${sg.i}">
      <td class="c-idx">${sg.i + 1} ${dirPill}</td>
      <td class="cell-time">${fmtM(sg.win.start)}–${fmtM(sg.win.end)}</td>
      <td class="cell-time">${ratePlan}</td>
      <td class="cell-time">${rateAct}</td>
      <td class="cell-time">${reach}</td>
      <td class="cell-time">${hold}</td>
      <td class="cell-time">${os}</td>
      <td class="review-seg-flags">${tags || `<span style="color:#9a9188">—</span>`}</td>
    </tr>`;
  }).join("");
}

/* ----------------------------- 发现定位 ----------------------------- */
function onFindingClick(e) {
  const row = e.target.closest("[data-finding]");
  if (!row || !rv.analysis) return;
  const f = rv.analysis.findings[parseInt(row.dataset.finding, 10)];
  if (!f) return;
  locateWindow(f.t0, f.t1, findingText(f, rv.params).title);
}

function onSegRowClick(e) {
  const tr = e.target.closest("[data-segwin]");
  if (!tr || !rv.analysis) return;
  const sg = rv.analysis.segs[parseInt(tr.dataset.segwin, 10)];
  if (!sg) return;
  locateWindow(sg.win.start, sg.win.end, `第 ${sg.i + 1} 段窗口`);
}

function locateWindow(t0, t1, label) {
  rv.highlight = { t0, t1 };
  renderChart();
  renderLocateCard(t0, t1, label);
  $("#chartWrap").scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderLocateCard(t0, t1, label) {
  const card = $("#reviewLocateCard");
  card.hidden = false;
  $("#reviewLocateTitle").textContent =
    `CSV 原始行 — ${label}（${fmtM(t0)}–${fmtM(t1)}）`;
  const rows = rv.pts.filter((p) => p.t >= t0 - 1e-9 && p.t <= t1 + 1e-9);
  const show = rows.slice(0, LOCATE_CAP);
  $("#reviewLocateTbody").innerHTML = show.map((p) => `
    <tr><td class="c-idx">${p.row}</td><td>${esc(p.rawT)}</td>
    <td class="cell-time">${p.t.toFixed(1)}</td><td class="cell-time">${p.temp.toFixed(1)}</td></tr>`)
    .join("")
    || `<tr><td colspan="4" style="text-align:center;color:#9a9188;padding:14px">
          该区间没有任何采样点——这本身就是采样缺口。</td></tr>`;
  $("#reviewLocateNote").textContent = rows.length
    ? `共 ${rows.length} 个采样点（CSV 行 ${rows[0].row}–${rows[rows.length - 1].row}）`
      + `${rows.length > LOCATE_CAP ? `，仅显示前 ${LOCATE_CAP} 行` : ""}。`
      + `行号对应原始 CSV 文件（含表头），可回源文件核对。`
    : "可检查该时段控制器是否停记、或 CSV 导出是否完整。";
}

function closeLocate() {
  rv.highlight = null;
  $("#reviewLocateCard").hidden = true;
  renderChart();
}

/* ----------------------------- 数据质量展示 ----------------------------- */
const QUALITY_NAMES = { empty: "空值行", format: "无法解析", outOfOrder: "时间乱序",
                        duplicate: "时间重复", gaps: "异常采样间隔" };

function qualityGroupsHTML(issues, counts) {
  const total = Object.keys(QUALITY_NAMES)
    .reduce((a, k) => a + (counts[k] || 0), 0);
  if (!total)
    return `<div class="empty" style="padding:10px 14px">✓ 未发现空值、乱序、重复或异常间隔。</div>`;
  let html = "";
  for (const k of Object.keys(QUALITY_NAMES)) {
    const n = counts[k] || 0;
    if (!n) continue;
    const list = (issues[k] || []).slice(0, 8)
      .map((it) => `<div class="qrow">行 ${it.row}：${esc(it.text)}</div>`).join("");
    html += `<div class="qgroup"><div class="qtitle">${QUALITY_NAMES[k]} × ${n}</div>${list}`
      + (n > 8 ? `<div class="qrow">… 其余 ${n - 8} 条已随记录保存，见导出复盘 JSON</div>` : "")
      + `</div>`;
  }
  return html;
}

function renderQuality() {
  const el = $("#reviewQuality");
  if (!el || !rv.active) return;
  const meta = rv.active.meta || {};
  const counts = meta.issueCounts || {};
  const issues = meta.issues || {};
  el.innerHTML = `<p class="note">原始数据行 ${meta.rowsTotal ?? "—"}，`
    + `采用 ${meta.usedSamples ?? (rv.pts ? rv.pts.length : "—")} 个样本`
    + `${meta.trimmedOut ? `，按裁剪区间弃用 ${meta.trimmedOut} 个` : ""}`
    + `${meta.unit === "F" ? "（温度已由 ℉ 换算为 ℃）" : ""}；`
    + `剔除行全部列在下方，未做任何插值。</p>`
    + qualityGroupsHTML(issues, counts);
}

/* ----------------------------- 两次烧成对照 ----------------------------- */
async function openFiringCompare() {
  if (rv.records.length < 2) { toast("至少需要两条烧成记录才能对照"); return; }
  const aId = parseInt($("#cmpA").value, 10);
  const bId = parseInt($("#cmpB").value, 10);
  if (!aId || !bId || aId === bId) { toast("请选择两条不同的记录"); return; }
  let A, B;
  try { [A, B] = await Promise.all([Store.getFiring(aId), Store.getFiring(bId)]); }
  catch (e) { toast("读取记录失败：" + e.message); return; }
  if (!A || !B) { toast("记录不存在"); return; }
  const model = buildModel(state.plan.data, state.kiln.config);
  const anA = analyzeFiring(model, A.samples.map(toPt), rv.params);
  const anB = analyzeFiring(model, B.samples.map(toPt), rv.params);
  $("#firingDiffContent").innerHTML = compareHTML(A, B, anA, anB, model);
  $("#firingDiffModal").hidden = false;
}

function compareHTML(A, B, anA, anB, model) {
  const rows = [];
  const push = (label, av, bv, digits, thresh) => {
    if (av == null && bv == null) return;
    const d = (av != null && bv != null) ? bv - av : null;
    rows.push({ label,
      a: av == null ? "—" : av.toFixed(digits),
      b: bv == null ? "—" : bv.toFixed(digits),
      d: d == null ? "—" : (d >= 0 ? "+" : "") + d.toFixed(digits),
      changed: d != null && Math.abs(d) > thresh });
  };
  model.segs.forEach((s, i) => {
    const a = anA.segs[i], b = anB.segs[i];
    if (!a || !b) return;
    push(`第${i + 1}段 实测速率 ℃/h`, a.actualRate, b.actualRate, 1, 5);
    push(`第${i + 1}段 到温延迟 min`, a.reachDelay, b.reachDelay, 0, 3);
    push(`第${i + 1}段 保温均差 ℃`,
      a.hold ? a.hold.meanDev : null, b.hold ? b.hold.meanDev : null, 1, 1);
    push(`第${i + 1}段 保温峰偏 ℃`,
      a.hold ? a.hold.maxAbsDev : null, b.hold ? b.hold.maxAbsDev : null, 1, 2);
    push(`第${i + 1}段 超调 ℃`, a.overshoot, b.overshoot, 1, 2);
  });
  const trs = rows.map((r) => `
    <tr class="${r.changed ? "changed" : ""}">
      <td>${esc(r.label)}</td><td class="num">${r.a}</td>
      <td class="num">${r.b}</td><td class="num">${r.d}</td>
    </tr>`).join("");
  const changed = rows.filter((r) => r.changed).length;
  return `
    <p class="note" style="padding:0 0 8px">按当前分析参数（容差 ±${rv.params.tolTemp}℃、
      持续 ≥${rv.params.minDurMin}min、缺口 >${rv.params.maxGapMin}min）对照每段偏差；Δ = B − A。</p>
    <table class="diff-table">
      <thead><tr><th>指标</th><th>A：${esc(A.name)}</th><th>B：${esc(B.name)}</th><th>Δ</th></tr></thead>
      <tbody>${trs || `<tr><td colspan="4" style="text-align:center">两次记录都没有可对照的分段数据。</td></tr>`}</tbody>
    </table>
    <p class="note">共 ${changed} 项差异超过阈值（黄色底纹）。</p>
    <div class="diff-chart-wrap">
      ${samplesCompareSVG(model, [
        { name: "A：" + A.name, pts: A.samples.map(toPt), color: "#3a7d44" },
        { name: "B：" + B.name, pts: B.samples.map(toPt), color: "#7d3c98" },
      ])}
    </div>`;
}

/* 实测曲线对照图（含取整执行曲线，蓝虚线） */
function samplesCompareSVG(model, items, W = 860, H = 250) {
  const compPts = curvePoints(null, model, true);
  let xmax = Math.max(1, model.compiledTotalMin);
  let ymin = Infinity, ymax = -Infinity;
  items.forEach((it) => it.pts.forEach((p) => {
    if (p.t > xmax) xmax = p.t;
    if (p.temp < ymin) ymin = p.temp;
    if (p.temp > ymax) ymax = p.temp;
  }));
  compPts.forEach((p) => {
    if (p.y < ymin) ymin = p.y;
    if (p.y > ymax) ymax = p.y;
  });
  if (!Number.isFinite(ymin)) { ymin = 0; ymax = 100; }
  ymin = Math.max(0, Math.floor((ymin - 15) / 10) * 10);
  ymax = Math.ceil((ymax + 15) / 10) * 10;
  const ml = 50, mr = 14, mt = 14, mb = 28;
  const X = (t) => ml + clamp01(t / xmax) * (W - ml - mr);
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
  const dComp = compPts.map((p, k) =>
    `${k ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  g += `<path d="${dComp}" fill="none" stroke="#2f6690" stroke-width="1.6" stroke-dasharray="7 4" opacity=".8"/>`;
  items.forEach((it, idx) => {
    const d = it.pts.map((p, k) =>
      `${k ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.temp).toFixed(1)}`).join("");
    g += `<path d="${d}" fill="none" stroke="${it.color}" stroke-width="1.8"/>`;
    g += `<rect x="${W - mr - 168}" y="${mt + 2 + idx * 15}" width="22" height="3" fill="${it.color}"/>
          <text x="${W - mr - 142}" y="${mt + 7 + idx * 15}" font-size="10" fill="#444">${esc(it.name)}</text>`;
  });
  g += `<rect x="${W - mr - 168}" y="${mt + 2 + items.length * 15}" width="22" height="3" fill="#2f6690"/>
        <text x="${W - mr - 142}" y="${mt + 7 + items.length * 15}" font-size="10" fill="#444">取整执行曲线</text>`;
  g += `<line x1="${ml}" x2="${ml}" y1="${mt}" y2="${H - mb}" stroke="#999"/>
        <line x1="${ml}" x2="${W - mr}" y1="${H - mb}" y2="${H - mb}" stroke="#999"/>`;
  return `<svg class="csv-spark" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/* =====================================================================
 * CSV 导入向导
 * =================================================================== */
const DELIM_NAMES = { ",": "逗号", ";": "分号", "\t": "制表符", "|": "竖线" };

function resetCsvWizard() {
  Object.assign(csvW, {
    fileName: "", encoding: "", text: "",
    delimiter: ",", delimChoice: "auto",
    rows: [], hasHeader: true,
    map: { timeCol: 0, tempCol: 1, timeFormat: "auto", unit: "C" },
    parsed: null, gaps: [],
    trim: { start: 0, end: 0, zero: 0 },
    name: "",
  });
  $("#csvStepFile").hidden = false;
  $("#csvStepMap").hidden = true;
  $("#csvStepTrim").hidden = true;
  $("#csvFileError").innerHTML = "";
  const fi = $("#fileCsv");
  if (fi) fi.value = "";
}

function openCsvModal() {
  if (!state.plan || state.plan.id == null) {
    toast("当前方案尚未保存，请先保留方案后再导入烧成记录");
    return;
  }
  resetCsvWizard();
  $("#csvModal").hidden = false;
}

async function onCsvFilePicked(e) {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const errBox = $("#csvFileError");
  errBox.innerHTML = "";
  let buf;
  try { buf = await f.arrayBuffer(); }
  catch (err) {
    errBox.innerHTML = `<div class="csv-error">无法读取文件：${esc(err.message)}</div>`;
    return;
  }
  const dec = decodeCSVBuffer(buf);
  if (dec.error) { errBox.innerHTML = `<div class="csv-error">${esc(dec.error)}</div>`; return; }
  const parsed = parseCSVText(dec.text, null);
  if (parsed.error) { errBox.innerHTML = `<div class="csv-error">${esc(parsed.error)}</div>`; return; }
  csvW.fileName = f.name;
  csvW.encoding = dec.encoding;
  csvW.text = dec.text;
  csvW.delimiter = parsed.delimiter;
  csvW.delimChoice = "auto";
  csvW.rows = parsed.rows;
  csvW.hasHeader = guessHasHeader(parsed.rows);
  const g = guessMapping(parsed.rows, csvW.hasHeader);
  csvW.map = { timeCol: g.timeCol, tempCol: g.tempCol, timeFormat: g.timeFormat, unit: "C" };
  csvW.parsed = null;
  renderCsvMapStep();
  $("#csvStepFile").hidden = true;
  $("#csvStepMap").hidden = false;
  $("#csvStepTrim").hidden = true;
}

function colOptions(selected) {
  const nCols = Math.max(...csvW.rows.map((r) => r.length));
  let out = "";
  for (let c = 0; c < nCols; c++) {
    const head = csvW.hasHeader ? (csvW.rows[0][c] || "") : "";
    const label = `第 ${c + 1} 列${head ? " · " + head : ""}`;
    out += `<option value="${c}" ${c === selected ? "selected" : ""}>${esc(label)}</option>`;
  }
  return out;
}

function renderCsvMapStep() {
  const preview = csvW.rows.slice(0, 8).map((r, ri) => `
    <tr class="${csvW.hasHeader && ri === 0 ? "head-row" : ""}">
      <td class="c-idx">${ri + 1}</td>
      ${r.map((c) => `<td>${esc(c) || "<span style='color:#b9b0a4'>（空）</span>"}</td>`).join("")}
    </tr>`).join("");
  $("#csvStepMap").innerHTML = `
    <div class="csv-fileinfo">文件 <b>${esc(csvW.fileName)}</b> · 编码 ${csvW.encoding}
      · 分隔符 ${DELIM_NAMES[csvW.delimiter] || csvW.delimiter} · 共 ${csvW.rows.length} 行
      ${csvW.rows.length > 8 ? `（预览前 8 行）` : ""}</div>
    <div class="table-wrap" style="max-height:220px;overflow:auto">
      <table class="csv-preview"><tbody>${preview}</tbody></table>
    </div>
    <div class="csv-map-grid">
      <label>分隔符
        <select data-csv="delim">
          <option value="auto" ${csvW.delimChoice === "auto" ? "selected" : ""}>自动（${DELIM_NAMES[csvW.delimiter]}）</option>
          <option value="," ${csvW.delimChoice === "," ? "selected" : ""}>逗号 ,</option>
          <option value=";" ${csvW.delimChoice === ";" ? "selected" : ""}>分号 ;</option>
          <option value="\t" ${csvW.delimChoice === "\t" ? "selected" : ""}>制表符 Tab</option>
          <option value="|" ${csvW.delimChoice === "|" ? "selected" : ""}>竖线 |</option>
        </select></label>
      <label>首行
        <select data-csv="hasHeader">
          <option value="1" ${csvW.hasHeader ? "selected" : ""}>首行是表头</option>
          <option value="0" ${!csvW.hasHeader ? "selected" : ""}>首行是数据</option>
        </select></label>
      <label>时间列
        <select data-csv="timeCol">${colOptions(csvW.map.timeCol)}</select></label>
      <label>炉温列
        <select data-csv="tempCol">${colOptions(csvW.map.tempCol)}</select></label>
      <label>时间格式
        <select data-csv="timeFormat">
          ${Object.keys(TIME_FMT_LABELS).map((k) =>
            `<option value="${k}" ${csvW.map.timeFormat === k ? "selected" : ""}>${TIME_FMT_LABELS[k]}</option>`).join("")}
        </select></label>
      <label>温度单位
        <select data-csv="unit">
          <option value="C" ${csvW.map.unit === "C" ? "selected" : ""}>摄氏度 ℃</option>
          <option value="F" ${csvW.map.unit === "F" ? "selected" : ""}>华氏度 ℉（导入时换算为 ℃）</option>
        </select></label>
    </div>
    <div id="csvMapError"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="primary" data-csvact="parse">解析并检查数据</button>
      <button data-csvact="repick">重新选择文件</button>
    </div>`;
}

function onCsvMapChange(e) {
  const sel = e.target.closest("[data-csv]");
  if (!sel) return;
  const key = sel.dataset.csv;
  if (key === "delim") {
    csvW.delimChoice = sel.value;
    const forced = sel.value === "auto" ? null : sel.value;
    const parsed = parseCSVText(csvW.text, forced);
    if (parsed.error) {
      $("#csvMapError").innerHTML = `<div class="csv-error">${esc(parsed.error)}</div>`;
      return;
    }
    csvW.delimiter = parsed.delimiter;
    csvW.rows = parsed.rows;
    csvW.hasHeader = guessHasHeader(parsed.rows);
    const g = guessMapping(parsed.rows, csvW.hasHeader);
    csvW.map = { ...csvW.map, timeCol: g.timeCol, tempCol: g.tempCol, timeFormat: g.timeFormat };
    renderCsvMapStep();
  } else if (key === "hasHeader") {
    csvW.hasHeader = sel.value === "1";
    const g = guessMapping(csvW.rows, csvW.hasHeader);
    csvW.map = { ...csvW.map, timeCol: g.timeCol, tempCol: g.tempCol, timeFormat: g.timeFormat };
    renderCsvMapStep();
  } else if (key === "timeCol" || key === "tempCol") {
    csvW.map[key] = parseInt(sel.value, 10);
  } else if (key === "timeFormat" || key === "unit") {
    csvW.map[key] = sel.value;
  }
}

function onCsvMapClick(e) {
  const btn = e.target.closest("[data-csvact]");
  if (!btn) return;
  if (btn.dataset.csvact === "parse") runCsvParse();
  if (btn.dataset.csvact === "repick") {
    resetCsvWizard();
    $("#fileCsv").click();
  }
}

function runCsvParse() {
  const errBox = $("#csvMapError");
  errBox.innerHTML = "";
  if (csvW.map.timeCol === csvW.map.tempCol) {
    errBox.innerHTML = `<div class="csv-error">时间列与炉温列不能是同一列，请重新选择。</div>`;
    return;
  }
  const res = extractSamples(csvW.rows, { hasHeader: csvW.hasHeader, ...csvW.map });
  csvW.parsed = res;
  if (res.samples.length < 2) {
    const c = res.counts;
    let hint = `只解析出 ${res.samples.length} 个有效样本（共 ${res.rowsTotal} 个数据行），无法复盘。`;
    if (c.format > 0)
      hint += `\n大量行无法解析：请检查「时间格式」选择（当前：${TIME_FMT_LABELS[csvW.map.timeFormat]}），`
        + `并确认时间列与炉温列没有选反。`;
    else if (c.empty > 0)
      hint += "\n多数行为空值：请确认时间列 / 炉温列选择正确。";
    else if (res.rowsTotal === 0)
      hint += "\n没有可用的数据行：若首行是数据而非表头，请把「首行」改为数据。";
    else if (c.outOfOrder > 0 || c.duplicate > 0)
      hint += "\n多数行因乱序或重复被剔除：请确认时间列选择正确、时间格式匹配。";
    errBox.innerHTML = `<div class="csv-error">${esc(hint)}</div>`;
    return;
  }
  csvW.gaps = detectAbnormalGaps(res.samples);
  const t0 = res.samples[0].t, t1 = res.samples[res.samples.length - 1].t;
  csvW.trim = { start: t0, end: t1, zero: t0 };
  csvW.name = csvW.fileName.replace(/\.(csv|txt)$/i, "") + " " + nowLabel();
  renderCsvTrimStep();
  $("#csvStepMap").hidden = true;
  $("#csvStepTrim").hidden = false;
}

/* 裁剪预览小图：灰底为裁掉区域，绿线为零时刻 */
function sparklineSVG(samples, trim) {
  const W = 840, H = 170, ml = 46, mr = 12, mt = 10, mb = 24;
  let t0 = Infinity, t1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  samples.forEach((p) => {
    if (p.t < t0) t0 = p.t;
    if (p.t > t1) t1 = p.t;
    if (p.temp < y0) y0 = p.temp;
    if (p.temp > y1) y1 = p.temp;
  });
  if (!(t1 > t0)) t1 = t0 + 1;
  if (!(y1 > y0)) y1 = y0 + 1;
  const pad = (y1 - y0) * 0.08;
  y0 = Math.max(0, Math.floor(y0 - pad));
  y1 = Math.ceil(y1 + pad);
  const X = (t) => ml + (t - t0) / (t1 - t0) * (W - ml - mr);
  const Y = (v) => H - mb - (v - y0) / (y1 - y0) * (H - mt - mb);
  const d = samples.map((p, k) =>
    `${k ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.temp).toFixed(1)}`).join("");
  const xs = X(trim.start), xe = X(trim.end), xz = X(trim.zero);
  return `<svg class="csv-spark" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}" fill="#faf8f5"/>
    <rect x="${ml}" y="${mt}" width="${Math.max(0, xs - ml)}" height="${H - mt - mb}" fill="rgba(44,38,32,.10)"/>
    <rect x="${xe}" y="${mt}" width="${Math.max(0, W - mr - xe)}" height="${H - mt - mb}" fill="rgba(44,38,32,.10)"/>
    <path d="${d}" fill="none" stroke="#3a7d44" stroke-width="1.5"/>
    <line x1="${xs}" x2="${xs}" y1="${mt}" y2="${H - mb}" stroke="#c0392b" stroke-dasharray="5 3"/>
    <line x1="${xe}" x2="${xe}" y1="${mt}" y2="${H - mb}" stroke="#c0392b" stroke-dasharray="5 3"/>
    <line x1="${xz}" x2="${xz}" y1="${mt}" y2="${H - mb}" stroke="#2f6690" stroke-width="1.6"/>
    <text x="${ml - 5}" y="${Y(y1) + 3}" text-anchor="end" font-size="9" fill="#777">${Math.round(y1)}</text>
    <text x="${ml - 5}" y="${Y(y0) + 3}" text-anchor="end" font-size="9" fill="#777">${Math.round(y0)}</text>
    <text x="${X(t0)}" y="${H - 8}" font-size="9" fill="#777">${fmtM(t0)}</text>
    <text x="${X(t1)}" y="${H - 8}" text-anchor="end" font-size="9" fill="#777">${fmtM(t1)}</text>
    <text x="${xz + 4}" y="${mt + 10}" font-size="9" fill="#2f6690">零时刻</text>
  </svg>`;
}

function renderCsvTrimStep() {
  const res = csvW.parsed;
  const c = res.counts;
  const gapItems = csvW.gaps.slice(0, QUALITY_CAP).map((g) => ({ row: g.row,
    text: `间隔 ${g.gapMin.toFixed(1)} min（${fmtM(g.t0)} → ${fmtM(g.t1)}）` }));
  const issues = { ...res.issues, gaps: gapItems };
  const counts = { ...c, gaps: csvW.gaps.length };
  $("#csvStepTrim").innerHTML = `
    <div class="csv-stats">
      <span>数据行 <b>${res.rowsTotal}</b></span>
      <span>有效样本 <b>${res.samples.length}</b></span>
      <span>空值 <b>${c.empty}</b></span>
      <span>无法解析 <b>${c.format}</b></span>
      <span>乱序 <b>${c.outOfOrder}</b></span>
      <span>重复 <b>${c.duplicate}</b></span>
      <span>异常间隔 <b>${csvW.gaps.length}</b></span>
    </div>
    ${qualityGroupsHTML(issues, counts)}
    <p class="note" style="padding:10px 0 4px">裁掉点火前 / 烧成后的区间，并选定零时刻
      （应对齐方案程序的起点）。灰色区域将被裁掉，蓝线为零时刻：</p>
    <div id="csvSpark">${sparklineSVG(res.samples, csvW.trim)}</div>
    <div class="csv-trim-grid">
      <label>裁去此前（分钟）<input type="number" id="ctStart" value="${r1(csvW.trim.start)}" step="1"></label>
      <label>裁去此后（分钟）<input type="number" id="ctEnd" value="${r1(csvW.trim.end)}" step="1"></label>
      <label>零时刻（分钟）<input type="number" id="ctZero" value="${r1(csvW.trim.zero)}" step="1"></label>
      <label>记录名称<input type="text" id="ctName" value="${esc(csvW.name)}"></label>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <button data-trimact="zeroEqStart">零时刻 = 裁剪起点</button>
      <button data-trimact="resetTrim">重置裁剪</button>
    </div>
    <div id="csvTrimError"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="primary" data-trimact="save">保存烧成记录</button>
      <button data-trimact="back">返回上一步</button>
    </div>`;
}

function onCsvTrimInput(e) {
  const id = e.target.id;
  if (id !== "ctStart" && id !== "ctEnd" && id !== "ctZero") return;
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) return;
  if (id === "ctStart") csvW.trim.start = v;
  if (id === "ctEnd") csvW.trim.end = v;
  if (id === "ctZero") csvW.trim.zero = v;
  const sp = $("#csvSpark");
  if (sp && csvW.parsed) sp.innerHTML = sparklineSVG(csvW.parsed.samples, csvW.trim);
}

function onCsvTrimClick(e) {
  const btn = e.target.closest("[data-trimact]");
  if (!btn) return;
  const act = btn.dataset.trimact;
  if (act === "zeroEqStart") {
    csvW.trim.zero = csvW.trim.start;
    $("#ctZero").value = r1(csvW.trim.zero);
    $("#csvSpark").innerHTML = sparklineSVG(csvW.parsed.samples, csvW.trim);
  } else if (act === "resetTrim") {
    const s = csvW.parsed.samples;
    csvW.trim = { start: s[0].t, end: s[s.length - 1].t, zero: s[0].t };
    renderCsvTrimStep();
  } else if (act === "back") {
    $("#csvStepTrim").hidden = true;
    $("#csvStepMap").hidden = false;
  } else if (act === "save") {
    saveFiring();
  }
}

async function saveFiring() {
  const errBox = $("#csvTrimError");
  const fail = (msg) => { errBox.innerHTML = `<div class="csv-error">${esc(msg)}</div>`; };
  const { start, end, zero } = csvW.trim;
  if (!(start < end)) return fail("裁剪起点必须早于裁剪终点。");
  if (zero < start || zero > end)
    return fail("零时刻需位于裁剪区间内；零时刻应对齐方案程序的起点（开始执行程序的时刻）。");
  const samples = applyTrimZero(csvW.parsed.samples, start, end, zero);
  if (samples.length < 2)
    return fail(`裁剪后只剩 ${samples.length} 个样本，无法复盘；请放宽裁剪区间。`);
  const name = ($("#ctName").value || "").trim() || csvW.name;
  const c = csvW.parsed.counts;
  const meta = {
    fileName: csvW.fileName, encoding: csvW.encoding,
    delimiter: csvW.delimiter, hasHeader: csvW.hasHeader,
    timeCol: csvW.map.timeCol, tempCol: csvW.map.tempCol,
    timeFormat: csvW.map.timeFormat, unit: csvW.map.unit,
    rowsTotal: csvW.parsed.rowsTotal,
    usedSamples: samples.length,
    trimmedOut: csvW.parsed.samples.length - samples.length,
    issues: {
      empty: csvW.parsed.issues.empty,
      format: csvW.parsed.issues.format,
      outOfOrder: csvW.parsed.issues.outOfOrder,
      duplicate: csvW.parsed.issues.duplicate,
      gaps: csvW.gaps.slice(0, QUALITY_CAP).map((g) => ({ row: g.row,
        text: `间隔 ${g.gapMin.toFixed(1)} min（${fmtM(g.t0)} → ${fmtM(g.t1)}）` })),
    },
    issueCounts: { empty: c.empty, format: c.format, outOfOrder: c.outOfOrder,
                   duplicate: c.duplicate, gaps: csvW.gaps.length },
    trim: { startMin: start, endMin: end, zeroMin: zero },
    params: { ...REVIEW_DEFAULTS },
    importedAt: new Date().toISOString(),
  };
  try {
    // 只写烧成记录，绝不回写方案数据
    const id = await Store.createFiring(state.plan.id, name, meta, samples);
    $("#csvModal").hidden = true;
    await refreshRecordList();
    await openFiring(id);
    toast("烧成记录已保存（方案程序未被改动）");
  } catch (e2) {
    fail("保存失败：" + e2.message);
  }
}

/* ----------------------------- 下载辅助 ----------------------------- */
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function downloadJSON(payload, filename) {
  downloadBlob(JSON.stringify(payload, null, 2), filename, "application/json");
}
function downloadDemoCsv() {
  downloadBlob("﻿" + demoCSV(), "示例烧成记录.csv", "text/csv;charset=utf-8");
  toast("已下载示例 CSV，可再用「导入控制器 CSV」打开体验");
}

/* ----------------------------- 事件绑定 ----------------------------- */
function onFiringListClick(e) {
  const btn = e.target.closest("button[data-fact]");
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  const act = btn.dataset.fact;
  if (act === "open") openFiring(id);
  else if (act === "rename") renameFiring(id);
  else if (act === "export") exportFiring(id);
  else if (act === "del") deleteFiring(id);
}

function initReview() {
  $("#btnImportCsv").addEventListener("click", openCsvModal);
  $("#firingList").addEventListener("click", onFiringListClick);
  $("#btnCompareFirings").addEventListener("click", openFiringCompare);
  $("#reviewParamsForm").addEventListener("input", onParamInput);
  $("#reviewFindings").addEventListener("click", onFindingClick);
  $("#reviewSegTbody").addEventListener("click", onSegRowClick);
  $("#btnLocateClose").addEventListener("click", closeLocate);
  $("#reviewActiveBar").addEventListener("click", (e) => {
    if (e.target.closest("[data-exit-review]")) deactivateFiring();
  });
  // CSV 向导
  $("#btnCsvPick").addEventListener("click", () => $("#fileCsv").click());
  $("#fileCsv").addEventListener("change", onCsvFilePicked);
  $("#btnCsvDemo").addEventListener("click", downloadDemoCsv);
  $("#csvStepMap").addEventListener("change", onCsvMapChange);
  $("#csvStepMap").addEventListener("click", onCsvMapClick);
  $("#csvStepTrim").addEventListener("input", onCsvTrimInput);
  $("#csvStepTrim").addEventListener("click", onCsvTrimClick);
  // 切到复盘标签时刷新记录列表
  const tab = document.querySelector('.tab[data-tab="review"]');
  if (tab) tab.addEventListener("click", () => refreshRecordList());
}

/* 挂点：供 app.js 的 renderChart / renderAll / loadPlan 调用 */
if (typeof window !== "undefined")
  window.Review = { extendDomain, chartOverlay, onRenderAll, onPlanChanged };

if (typeof document !== "undefined")
  document.addEventListener("DOMContentLoaded", initReview);

/* 供 Node 直接测试纯函数 */
if (typeof module !== "undefined" && module.exports)
  module.exports = {
    REVIEW_DEFAULTS, fmtM, decodeCSVBuffer, detectDelimiter, parseCSVText,
    parseTempValue, parseTimeValue, guessHasHeader, guessMapping,
    extractSamples, detectAbnormalGaps, applyTrimZero,
    analyzeFiring, findingText, demoCSV,
  };
