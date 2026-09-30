// @ts-check
/**
 * Canvas trend engine, generalised from the VGC tool's trend from channels of one controller
 * to series from many devices: log decade gridlines or linear ticks, 1 min to whole-session
 * windows, freeze, hover crosshair, per-series last/min/max/mean and a least-squares rate in
 * decades per minute, per-pixel-column decimation that keeps extremes, and broken lines on
 * non-OK status and on silences far longer than the series' cadence.
 *
 * Several Trend instances can share one TrendView, which synchronises window, freeze, pan and
 * the hover time (the combined tab). The hover readout sits fixed at the far left, the
 * convention CSC uses in Spectrum Studio.
 */
import { h, formatClock } from "./dom.js";
import { decimate, SAMPLE_STATUS } from "../core/store/buffers.js";
import { convertPressure, isPressureUnit } from "../core/units.js";
import { formatPressure } from "../core/codecs/common.js";

export const WINDOWS = [
  ["1 min", 60e3],
  ["5 min", 5 * 60e3],
  ["15 min", 15 * 60e3],
  ["1 h", 3600e3],
  ["6 h", 6 * 3600e3],
  ["Session", Infinity]
];
const PAD = { top: 12, right: 14, bottom: 24, left: 62 };
const GAP_FACTOR = 3;
const MIN_GAP_MS = 4000;

export class TrendView {
  constructor() {
    this.windowMs = 5 * 60e3;
    /** @type {number | null} */
    this.frozenEnd = null;
    /** @type {number | null} */
    this.hoverT = null;
    /** @type {"log" | "linear"} */
    this.scale = "log";
    this.revision = 0;
    /** @type {Set<() => void>} */
    this.listeners = new Set();
  }

  /** @param {Partial<{ windowMs: number, frozenEnd: number | null, hoverT: number | null, scale: "log" | "linear" }>} patch */
  set(patch) {
    Object.assign(this, patch);
    this.revision += 1;
    for (const fn of this.listeners) fn();
  }
}

/** @type {Set<Trend>} */
const live = new Set();
let rafPending = false;
function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    for (const trend of live) trend.drawIfNeeded();
    if (live.size) setTimeout(schedule, 250);
  });
}

/**
 * @typedef {{ series: import("../core/store/buffers.js").Series, color: string, label: string, visible?: boolean }} TrendSeries
 */

export class Trend {
  /**
   * @param {{
   *   view?: TrendView,
   *   height?: number,
   *   getSeries: () => TrendSeries[],
   *   displayUnit: () => string,
   *   toolbar?: boolean,
   *   stats?: boolean,
   *   title?: string,
   * }} options
   */
  constructor(options) {
    /** @type {(() => void)[]} */
    this.cleanup = [];
    this.view = options.view ?? new TrendView();
    this.height = options.height ?? 230;
    this.getSeries = options.getSeries;
    this.displayUnit = options.displayUnit;
    this.canvas = /** @type {HTMLCanvasElement} */ (h("canvas.trend-canvas", { height: this.height, "aria-label": "Pressure trend", role: "img" }));
    this.hover = h("div.trend-hover", { hidden: true });
    this.statsEl = h("div.trend-stats");
    this.lastKey = "";
    this.dragFrom = null;
    const toolbar = options.toolbar === false ? null : this.buildToolbar(options.title);
    this.el = h("div.trend", null, toolbar, h("div.trend-wrap", null, this.canvas, this.hover), options.stats === false ? null : this.statsEl);
    this.listen(() => this.markDirty());
    this.bindPointer();
    live.add(this);
    schedule();
  }

  /** @param {string} [title] */
  buildToolbar(title) {
    const windows = h("div.segmented", { role: "group", "aria-label": "Time window" });
    const scale = h("div.segmented", { role: "group", "aria-label": "Scale" });
    const freeze = /** @type {HTMLButtonElement} */ (h("button.button.small", { type: "button", "aria-pressed": "false" }, "Freeze"));
    const sync = () => {
      for (const b of windows.querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.ms) === this.view.windowMs));
      for (const b of scale.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.scale === this.view.scale));
      freeze.textContent = this.view.frozenEnd == null ? "Freeze" : "Follow live";
      freeze.setAttribute("aria-pressed", String(this.view.frozenEnd != null));
    };
    for (const [label, ms] of WINDOWS) {
      windows.append(h("button", { type: "button", dataset: { ms: String(ms) }, onclick: () => this.view.set({ windowMs: Number(ms) }) }, label));
    }
    for (const s of ["log", "linear"]) {
      scale.append(h("button", { type: "button", dataset: { scale: s }, onclick: () => this.view.set({ scale: /** @type {any} */ (s) }) }, s === "log" ? "Log" : "Linear"));
    }
    freeze.onclick = () => this.view.set({ frozenEnd: this.view.frozenEnd == null ? Date.now() : null });
    this.listen(sync);
    sync();
    return h("div.trend-toolbar", null, title ? h("strong", null, title) : null, windows, scale, freeze,
      h("span.hint", null, "Wheel to zoom, drag to pan"));
  }

  bindPointer() {
    const c = this.canvas;
    c.addEventListener("mousemove", (e) => {
      const r = this.range();
      const x = e.offsetX;
      const w = c.clientWidth - PAD.left - PAD.right;
      if (this.dragFrom != null) {
        const dx = x - this.dragFrom.x;
        const span = r.end - r.start;
        this.view.set({ frozenEnd: Math.min(Date.now(), this.dragFrom.end - (dx / w) * span) });
        return;
      }
      if (x < PAD.left || x > c.clientWidth - PAD.right) return this.view.set({ hoverT: null });
      this.view.set({ hoverT: r.start + ((x - PAD.left) / w) * (r.end - r.start) });
    });
    c.addEventListener("mouseleave", () => {
      this.dragFrom = null;
      this.view.set({ hoverT: null });
    });
    c.addEventListener("mousedown", (e) => {
      const r = this.range();
      this.dragFrom = { x: e.offsetX, end: r.end };
    });
    window.addEventListener("mouseup", () => (this.dragFrom = null));
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = this.range();
      const current = Number.isFinite(this.view.windowMs) ? this.view.windowMs : r.end - r.start;
      const next = Math.min(30 * 86400e3, Math.max(5e3, current * (e.deltaY > 0 ? 1.25 : 0.8)));
      this.view.set({ windowMs: next });
    }, { passive: false });
  }

  /** Subscribe to the shared view and remember to unsubscribe on destroy. @param {() => void} fn */
  listen(fn) {
    if (!this.cleanup) this.cleanup = [];
    this.view.listeners.add(fn);
    this.cleanup.push(() => this.view.listeners.delete(fn));
  }

  markDirty() {
    this.lastKey = "";
  }

  destroy() {
    live.delete(this);
    for (const fn of this.cleanup) fn();
    this.el.remove();
  }

  range() {
    const all = this.getSeries().filter((s) => s.visible !== false && s.series.length);
    const end = this.view.frozenEnd ?? Date.now();
    let start;
    if (Number.isFinite(this.view.windowMs)) start = end - this.view.windowMs;
    else start = all.length ? Math.min(...all.map((s) => s.series.t[0])) : end - 60e3;
    if (end - start < 1000) start = end - 1000;
    return { start, end };
  }

  drawIfNeeded() {
    if (!this.canvas.isConnected) return;
    const series = this.getSeries();
    const key = [
      this.view.revision,
      this.displayUnit(),
      this.canvas.clientWidth,
      document.documentElement.dataset.theme,
      this.view.frozenEnd == null ? Math.floor(Date.now() / 500) : "f",
      ...series.map((s) => `${s.series.version}:${s.visible !== false}:${s.color}`)
    ].join("|");
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.draw(series);
  }

  /** @param {TrendSeries[]} seriesList */
  draw(seriesList) {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    const height = this.height;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.height = `${height}px`;
    }
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const css = getComputedStyle(document.documentElement);
    const gridColor = css.getPropertyValue("--chart-grid").trim();
    const minorColor = css.getPropertyValue("--chart-grid-minor").trim();
    const muted = css.getPropertyValue("--muted").trim();
    const { start, end } = this.range();
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const display = this.displayUnit();
    const visible = seriesList.filter((s) => s.visible !== false && s.series.length);

    // Decimate and convert each series into display units.
    const prepared = visible.map((s) => {
      const unit = s.series.unit;
      const convert = display !== "auto" && isPressureUnit(unit) && isPressureUnit(display) ? (/** @type {number} */ v) => convertPressure(v, unit, display) : (/** @type {number} */ v) => v;
      const points = decimate(s.series, start, end, Math.max(50, Math.floor(plotW))).map((p) => ({ ...p, v: convert(p.v) }));
      return { ...s, points, unit: display !== "auto" && isPressureUnit(unit) ? display : unit, cadence: cadence(s.series) };
    });

    const logScale = this.view.scale === "log";
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of prepared) {
      for (const p of s.points) {
        if (p.t < start || p.t > end || !Number.isFinite(p.v)) continue;
        if (logScale && p.v <= 0) continue;
        lo = Math.min(lo, p.v);
        hi = Math.max(hi, p.v);
      }
    }
    if (!Number.isFinite(lo)) {
      lo = logScale ? 1e-3 : 0;
      hi = logScale ? 1e3 : 1;
    }
    let yMin;
    let yMax;
    if (logScale) {
      yMin = Math.floor(Math.log10(lo));
      yMax = Math.ceil(Math.log10(hi));
      if (yMax - yMin < 1) yMax = yMin + 1;
    } else {
      const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
      yMin = lo - pad;
      yMax = hi + pad;
    }
    const yOf = (/** @type {number} */ v) => {
      const f = logScale ? (Math.log10(v) - yMin) / (yMax - yMin) : (v - yMin) / (yMax - yMin);
      return PAD.top + plotH - f * plotH;
    };
    const xOf = (/** @type {number} */ t) => PAD.left + ((t - start) / (end - start)) * plotW;

    // Grid and labels.
    ctx.font = "11px Cascadia Code, Consolas, monospace";
    ctx.fillStyle = muted;
    ctx.lineWidth = 1;
    if (logScale) {
      for (let d = yMin; d <= yMax; d += 1) {
        if (d < yMax) {
          ctx.strokeStyle = minorColor;
          for (let m = 2; m < 10; m += 1) line(ctx, PAD.left, yOf(m * 10 ** d), width - PAD.right, yOf(m * 10 ** d));
        }
        ctx.strokeStyle = gridColor;
        const y = yOf(10 ** d);
        line(ctx, PAD.left, y, width - PAD.right, y);
        ctx.textAlign = "right";
        ctx.fillText(`1E${d >= 0 ? "+" : ""}${d}`, PAD.left - 6, y + 4);
      }
    } else {
      ctx.strokeStyle = gridColor;
      for (const v of niceTicks(yMin, yMax, 6)) {
        const y = yOf(v);
        line(ctx, PAD.left, y, width - PAD.right, y);
        ctx.textAlign = "right";
        ctx.fillText(Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0) ? v.toExponential(1) : String(Number(v.toPrecision(4))), PAD.left - 6, y + 4);
      }
    }
    ctx.textAlign = "center";
    ctx.strokeStyle = gridColor;
    for (const t of timeTicks(start, end, Math.max(2, Math.floor(plotW / 110)))) {
      const x = xOf(t);
      line(ctx, x, PAD.top, x, PAD.top + plotH);
      ctx.fillText(formatClock(t).slice(0, end - start > 600e3 ? 5 : 8), x, height - 7);
    }
    const unitLabel = [...new Set(prepared.map((s) => s.unit))].join(" / ");
    if (unitLabel) {
      ctx.save();
      ctx.textAlign = "left";
      ctx.fillText(unitLabel, PAD.left + 4, PAD.top + 11);
      ctx.restore();
    }

    // Traces.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, plotW, plotH);
    ctx.clip();
    for (const s of prepared) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let pen = false;
      let prevT = -Infinity;
      const gap = Math.max(MIN_GAP_MS, GAP_FACTOR * s.cadence);
      for (const p of s.points) {
        const bad = p.s === SAMPLE_STATUS.OVERRANGE || p.s === SAMPLE_STATUS.UNDERRANGE || p.s === SAMPLE_STATUS.GAP;
        if (bad || !Number.isFinite(p.v) || (logScale && p.v <= 0)) {
          if (p.s === SAMPLE_STATUS.OVERRANGE || p.s === SAMPLE_STATUS.UNDERRANGE) {
            marker(ctx, xOf(p.t), p.s === SAMPLE_STATUS.OVERRANGE ? PAD.top + 5 : PAD.top + plotH - 5, p.s === SAMPLE_STATUS.OVERRANGE);
          }
          pen = false;
          continue;
        }
        const x = xOf(p.t);
        const y = yOf(p.v);
        if (!pen || p.t - prevT > gap) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        pen = true;
        prevT = p.t;
      }
      ctx.stroke();
    }
    ctx.restore();

    // Hover crosshair and readout.
    const hoverT = this.view.hoverT;
    if (hoverT != null && hoverT >= start && hoverT <= end) {
      ctx.strokeStyle = muted;
      ctx.setLineDash([4, 4]);
      line(ctx, xOf(hoverT), PAD.top, xOf(hoverT), PAD.top + plotH);
      ctx.setLineDash([]);
      const rows = prepared.map((s) => {
        const p = nearest(s.points, hoverT);
        return p ? `<span style="color:${s.color}">■</span> ${escapeHtml(s.label)}: ${isPressureUnit(s.unit) ? formatPressure(p.v, s.unit) : `${Number(p.v.toPrecision(5))} ${s.unit}`}` : "";
      }).filter(Boolean);
      this.hover.innerHTML = `<b>${formatClock(hoverT)}</b><br>${rows.join("<br>")}`;
      this.hover.hidden = false;
    } else {
      this.hover.hidden = true;
    }

    // Statistics over the visible window.
    this.statsEl.replaceChildren(...prepared.map((s) => {
      const st = s.series.stats(start, end);
      const conv = (/** @type {number} */ v) => (display !== "auto" && isPressureUnit(s.series.unit) && isPressureUnit(display) ? convertPressure(v, s.series.unit, display) : v);
      const fmt = (/** @type {number} */ v) => (Number.isFinite(v) ? (isPressureUnit(s.unit) ? formatPressure(conv(v), s.unit, 3) : `${Number(conv(v).toPrecision(4))} ${s.unit}`) : "—");
      return h("div", null, h("span", { style: { color: s.color } }, "■ "), `${s.label} — last `, h("b", null, fmt(st.last)), " · min ", h("b", null, fmt(st.min)),
        " · max ", h("b", null, fmt(st.max)), " · mean ", h("b", null, fmt(st.mean)),
        " · rate ", h("b", null, Number.isFinite(st.decadesPerMinute) ? `${st.decadesPerMinute >= 0 ? "+" : ""}${st.decadesPerMinute.toFixed(3)} dec/min` : "—"));
    }));
  }
}

/** Median spacing of the last samples, so gap detection follows each series' own cadence. @param {import("../core/store/buffers.js").Series} s */
function cadence(s) {
  const n = Math.min(s.length - 1, 30);
  if (n < 2) return 1000;
  const d = [];
  for (let i = s.length - n; i < s.length; i += 1) d.push(s.t[i] - s.t[i - 1]);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

/** @param {{ t: number, v: number }[]} points @param {number} t */
function nearest(points, t) {
  let best = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = Math.abs(p.t - t);
    if (d < bestD && Number.isFinite(p.v)) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 */
function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.stroke();
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {boolean} up */
function marker(ctx, x, y, up) {
  ctx.beginPath();
  ctx.moveTo(x, y + (up ? -4 : 4));
  ctx.lineTo(x - 4, y + (up ? 3 : -3));
  ctx.lineTo(x + 4, y + (up ? 3 : -3));
  ctx.closePath();
  ctx.fill();
}

/** @param {number} lo @param {number} hi @param {number} count */
function niceTicks(lo, hi, count) {
  const span = hi - lo;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** @param {number} start @param {number} end @param {number} count */
function timeTicks(start, end, count) {
  const steps = [1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3];
  const step = steps.find((s) => (end - start) / s <= count) ?? 86400e3;
  const offset = new Date().getTimezoneOffset() * 60e3;
  const out = [];
  for (let t = Math.ceil((start - offset) / step) * step + offset; t <= end; t += step) out.push(t);
  return out;
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
