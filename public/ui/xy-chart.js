// @ts-check
/**
 * A small canvas XY chart for Spectrum Studio: a numeric x axis (seconds since the studio
 * started, or wavelength in nm), a left axis and an optional right axis, each log or linear,
 * dashed lines, fill to the baseline, a shaded band between two lines, and vertical markers.
 *
 * Time charts share an XView, so zooming (wheel), panning (drag) and resetting (double-click)
 * one of them moves them all. Only the chart under the pointer draws a crosshair; it reports
 * the pointer's x value through `onHover`, and the studio writes the values into one hover bar
 * whose x reading stays at the far left (CSC's Spectrum Studio convention).
 *
 * Series lines are decimated per pixel column with extremes kept (store/buffers.js), so a
 * whole session of a fast peer gauge still draws quickly.
 */
import { h } from "./dom.js";
import { decimate } from "../core/store/buffers.js";

/**
 * @typedef {{ scale: "log" | "linear", label?: string, color?: string, fixed?: [number, number], includeZero?: boolean }} Axis
 * @typedef {{ series: import("../core/store/buffers.js").Series, t0: number, map?: (v: number) => number }} SeriesData
 * @typedef {{ x: ArrayLike<number>, y: ArrayLike<number> }} ArrayData
 * @typedef {{ axis?: "left" | "right", color: string, width?: number, dash?: number[], fill?: boolean, fillAlpha?: number, data: SeriesData | ArrayData }} Line
 * @typedef {{
 *   xDomain?: [number, number] | null,
 *   xLabel?: (x: number) => string,
 *   left: Axis,
 *   right?: Axis | null,
 *   lines: Line[],
 *   band?: { a: number, b: number, color: string } | null,
 *   markers?: { x: number, color: string, label?: string }[],
 *   empty?: string,
 * }} ChartModel
 */

const PAD = { top: 20, bottom: 26, left: 66, right: 16, rightAxis: 66 };

export class XView {
  constructor() {
    /** @type {[number, number] | null} */
    this.range = null;
    this.revision = 0;
    /** @type {Set<() => void>} */
    this.listeners = new Set();
  }

  /** @param {[number, number] | null} range */
  set(range) {
    this.range = range;
    this.revision += 1;
    for (const fn of this.listeners) fn();
  }
}

export class XYChart {
  /**
   * @param {{
   *   height?: number,
   *   view?: XView,
   *   getModel: () => ChartModel,
   *   getKey: () => string,
   *   onHover?: (x: number | null) => void,
   *   label?: string,
   * }} options
   */
  constructor(options) {
    this.height = options.height ?? 220;
    this.view = options.view ?? new XView();
    this.getModel = options.getModel;
    this.getKey = options.getKey;
    this.onHover = options.onHover ?? (() => {});
    /** @type {number | null} */
    this.hoverX = null;
    this.lastKey = "";
    /** @type {{ start: number, end: number, plotLeft: number, plotW: number } | null} */
    this.frame = null;
    /** @type {{ px: number, range: [number, number] } | null} */
    this.drag = null;
    this.canvas = /** @type {HTMLCanvasElement} */ (h("canvas.xy-canvas", { height: this.height, role: "img", "aria-label": options.label ?? "Chart" }));
    this.el = h("div.xy-chart", null, this.canvas);
    this.onView = () => this.draw(true);
    this.view.listeners.add(this.onView);
    this.resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.draw(true)) : null;
    this.resize?.observe(this.canvas);
    this.bind();
  }

  destroy() {
    this.view.listeners.delete(this.onView);
    this.resize?.disconnect();
    this.el.remove();
  }

  get zoomed() {
    return this.view.range != null;
  }

  resetZoom() {
    this.view.set(null);
  }

  bind() {
    const c = this.canvas;
    const px = (/** @type {MouseEvent} */ e) => e.clientX - c.getBoundingClientRect().left;
    c.addEventListener("mousemove", (e) => {
      const f = this.frame;
      if (!f) return;
      if (this.drag) {
        const span = this.drag.range[1] - this.drag.range[0];
        const dx = ((px(e) - this.drag.px) / f.plotW) * span;
        this.view.set([this.drag.range[0] - dx, this.drag.range[1] - dx]);
        return;
      }
      const x = px(e);
      const inside = x >= f.plotLeft && x <= f.plotLeft + f.plotW;
      this.hoverX = inside ? f.start + ((x - f.plotLeft) / f.plotW) * (f.end - f.start) : null;
      this.draw(true);
      this.onHover(this.hoverX);
    });
    c.addEventListener("mouseleave", () => {
      this.drag = null;
      this.hoverX = null;
      this.draw(true);
      this.onHover(null);
    });
    c.addEventListener("mousedown", (e) => {
      if (!this.frame) return;
      this.drag = { px: px(e), range: [this.frame.start, this.frame.end] };
    });
    window.addEventListener("mouseup", () => (this.drag = null));
    c.addEventListener("dblclick", () => this.resetZoom());
    c.addEventListener("wheel", (e) => {
      const f = this.frame;
      if (!f) return;
      e.preventDefault();
      const at = f.start + ((px(e) - f.plotLeft) / f.plotW) * (f.end - f.start);
      const k = e.deltaY > 0 ? 1.25 : 0.8;
      this.view.set([at - (at - f.start) * k, at + (f.end - at) * k]);
    }, { passive: false });
  }

  /** Redraw when the data key, size, theme, view or hover changed. @param {boolean} [force] */
  draw(force = false) {
    if (!this.canvas.isConnected) return;
    const key = [this.getKey(), this.canvas.clientWidth, document.documentElement.dataset.theme, this.view.revision, this.hoverX].join("|");
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.render(this.getModel());
  }

  /** @param {ChartModel} model */
  render(model) {
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
    const color = (/** @type {string} */ c) => (c.startsWith("--") ? css.getPropertyValue(c).trim() || "#888" : c);
    const grid = color("--chart-grid");
    const minor = color("--chart-grid-minor");
    const muted = color("--muted");

    const hasRight = Boolean(model.right);
    const plotLeft = PAD.left;
    const plotW = Math.max(40, width - PAD.left - (hasRight ? PAD.rightAxis : PAD.right));
    const plotH = height - PAD.top - PAD.bottom;

    // X range: the shared zoom, else the model's domain, else the data's extent.
    let [start, end] = this.view.range ?? model.xDomain ?? extent(model.lines);
    if (!Number.isFinite(start) || !Number.isFinite(end)) [start, end] = [0, 60];
    if (end - start < 1e-9) [start, end] = [start - 1, end + 1];
    this.frame = { start, end, plotLeft, plotW };
    const cols = Math.max(50, Math.floor(plotW));
    const prepared = model.lines.map((line) => ({ ...line, points: pointsOf(line.data, start, end, cols) }));

    const axisRange = (/** @type {Axis} */ axis, /** @type {"left" | "right"} */ side) => {
      if (axis.fixed) return axis.scale === "log" ? [Math.log10(axis.fixed[0]), Math.log10(axis.fixed[1])] : [...axis.fixed];
      let lo = Infinity;
      let hi = -Infinity;
      for (const l of prepared) {
        if ((l.axis ?? "left") !== side) continue;
        for (const p of l.points) {
          if (p.x < start || p.x > end || !Number.isFinite(p.y) || (axis.scale === "log" && p.y <= 0)) continue;
          lo = Math.min(lo, p.y);
          hi = Math.max(hi, p.y);
        }
      }
      if (axis.includeZero && axis.scale === "linear") {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      if (!Number.isFinite(lo)) return axis.scale === "log" ? [-6, 0] : [0, 1];
      if (axis.scale === "log") {
        const a = Math.floor(Math.log10(lo));
        const b = Math.ceil(Math.log10(hi));
        return [a, b > a ? b : a + 1];
      }
      const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1e-12;
      return [axis.includeZero && lo === 0 ? 0 : lo - pad, hi + pad];
    };
    const leftRange = axisRange(model.left, "left");
    const rightRange = model.right ? axisRange(model.right, "right") : leftRange;
    const yOf = (/** @type {Axis} */ axis, /** @type {number[]} */ r, /** @type {number} */ v) => {
      const f = axis.scale === "log" ? (Math.log10(v) - r[0]) / (r[1] - r[0]) : (v - r[0]) / (r[1] - r[0]);
      return PAD.top + plotH - f * plotH;
    };
    const xOf = (/** @type {number} */ x) => plotLeft + ((x - start) / (end - start)) * plotW;

    // Grid and axis labels.
    ctx.font = "11px Cascadia Code, Consolas, monospace";
    ctx.lineWidth = 1;
    ctx.fillStyle = muted;
    drawAxis(ctx, model.left, leftRange, (v) => yOf(model.left, leftRange, v), { x: plotLeft - 6, align: "right", grid: [plotLeft, plotLeft + plotW], gridColor: grid, minorColor: minor, color: muted });
    if (model.right) {
      const rc = color(model.right.color ?? "--muted");
      drawAxis(ctx, model.right, rightRange, (v) => yOf(/** @type {Axis} */ (model.right), rightRange, v), { x: plotLeft + plotW + 6, align: "left", grid: null, gridColor: grid, minorColor: minor, color: rc });
    }
    ctx.textAlign = "center";
    ctx.fillStyle = muted;
    ctx.strokeStyle = grid;
    for (const t of niceTicks(start, end, Math.max(2, Math.floor(plotW / 90)))) {
      const x = xOf(t);
      segment(ctx, x, PAD.top, x, PAD.top + plotH);
      ctx.fillText(model.xLabel ? model.xLabel(t) : shortNumber(t), x, height - 8);
    }
    ctx.save();
    ctx.textAlign = "left";
    if (model.left.label) ctx.fillText(model.left.label, plotLeft + 4, 13);
    if (model.right?.label) {
      ctx.textAlign = "right";
      ctx.fillStyle = color(model.right.color ?? "--muted");
      ctx.fillText(model.right.label, plotLeft + plotW - 4, 13);
    }
    ctx.restore();
    ctx.strokeStyle = color("--line-strong");
    ctx.strokeRect(plotLeft + 0.5, PAD.top + 0.5, plotW, plotH);

    // Plot area.
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, PAD.top, plotW, plotH);
    ctx.clip();

    const toXY = (/** @type {typeof prepared[number]} */ l) => {
      const axis = (l.axis ?? "left") === "right" && model.right ? model.right : model.left;
      const r = (l.axis ?? "left") === "right" && model.right ? rightRange : leftRange;
      return l.points.filter((p) => Number.isFinite(p.y) && !(axis.scale === "log" && p.y <= 0)).map((p) => [xOf(p.x), yOf(axis, r, p.y)]);
    };

    if (model.band && prepared[model.band.a] && prepared[model.band.b]) {
      const a = toXY(prepared[model.band.a]);
      const b = toXY(prepared[model.band.b]);
      if (a.length > 1 && b.length > 1) {
        ctx.fillStyle = color(model.band.color);
        ctx.beginPath();
        a.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        for (let i = b.length - 1; i >= 0; i -= 1) ctx.lineTo(b[i][0], b[i][1]);
        ctx.closePath();
        ctx.fill();
      }
    }

    for (const l of prepared) {
      const pts = toXY(l);
      if (!pts.length) continue;
      const c = color(l.color);
      if (l.fill && pts.length > 1) {
        const axis = (l.axis ?? "left") === "right" && model.right ? model.right : model.left;
        const r = (l.axis ?? "left") === "right" && model.right ? rightRange : leftRange;
        const base = axis.scale === "log" ? PAD.top + plotH : Math.min(PAD.top + plotH, Math.max(PAD.top, yOf(axis, r, 0)));
        ctx.save();
        ctx.globalAlpha = l.fillAlpha ?? 0.22;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], base);
        for (const [x, y] of pts) ctx.lineTo(x, y);
        ctx.lineTo(pts[pts.length - 1][0], base);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.strokeStyle = c;
      ctx.lineWidth = l.width ?? 1.8;
      ctx.setLineDash(l.dash ?? []);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (pts.length === 1) ctx.arc(pts[0][0], pts[0][1], 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const m of model.markers ?? []) {
      if (m.x < start || m.x > end) continue;
      const x = xOf(m.x);
      ctx.strokeStyle = color(m.color);
      ctx.setLineDash([2, 3]);
      segment(ctx, x, PAD.top, x, PAD.top + plotH);
      ctx.setLineDash([]);
      if (m.label) {
        ctx.fillStyle = color(m.color);
        ctx.textAlign = "center";
        ctx.fillText(m.label, x, PAD.top + 11);
      }
    }

    if (this.hoverX != null && this.hoverX >= start && this.hoverX <= end) {
      ctx.strokeStyle = muted;
      ctx.setLineDash([4, 4]);
      segment(ctx, xOf(this.hoverX), PAD.top, xOf(this.hoverX), PAD.top + plotH);
      ctx.setLineDash([]);
    }
    ctx.restore();

    if (!prepared.some((l) => l.points.length) && model.empty) {
      ctx.fillStyle = muted;
      ctx.textAlign = "center";
      ctx.font = "14px Calibri, Carlito, system-ui, sans-serif";
      ctx.fillText(model.empty, plotLeft + plotW / 2, PAD.top + plotH / 2);
    }
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx @param {Axis} axis @param {number[]} r @param {(v: number) => number} yOf
 * @param {{ x: number, align: CanvasTextAlign, grid: [number, number] | null, gridColor: string, minorColor: string, color: string }} o
 */
function drawAxis(ctx, axis, r, yOf, o) {
  ctx.textAlign = o.align;
  if (axis.scale === "log") {
    const step = Math.max(1, Math.ceil((r[1] - r[0]) / 8));
    for (let d = Math.ceil(r[0]); d <= r[1]; d += 1) {
      const y = yOf(10 ** d);
      if (o.grid) {
        if (d < r[1] && step === 1) {
          ctx.strokeStyle = o.minorColor;
          for (let m = 2; m < 10; m += 1) segment(ctx, o.grid[0], yOf(m * 10 ** d), o.grid[1], yOf(m * 10 ** d));
        }
        ctx.strokeStyle = o.gridColor;
        segment(ctx, o.grid[0], y, o.grid[1], y);
      }
      if ((d - Math.ceil(r[0])) % step === 0) {
        ctx.fillStyle = o.color;
        ctx.fillText(`1E${d >= 0 ? "+" : ""}${d}`, o.x, y + 4);
      }
    }
    return;
  }
  for (const v of niceTicks(r[0], r[1], 6)) {
    const y = yOf(v);
    if (o.grid) {
      ctx.strokeStyle = o.gridColor;
      segment(ctx, o.grid[0], y, o.grid[1], y);
    }
    ctx.fillStyle = o.color;
    ctx.fillText(shortNumber(v), o.x, y + 4);
  }
}

/** @param {Line[]} lines @returns {[number, number]} */
function extent(lines) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of lines) {
    const d = l.data;
    if ("series" in d) {
      if (!d.series.length) continue;
      lo = Math.min(lo, (d.series.t[0] - d.t0) / 1000);
      hi = Math.max(hi, (d.series.t[d.series.length - 1] - d.t0) / 1000);
    } else if (d.x.length) {
      lo = Math.min(lo, d.x[0]);
      hi = Math.max(hi, d.x[d.x.length - 1]);
    }
  }
  return [lo, hi];
}

/**
 * Visible points of a line, decimated to about four per pixel column.
 * @param {SeriesData | ArrayData} d @param {number} start @param {number} end @param {number} cols
 * @returns {{ x: number, y: number }[]}
 */
function pointsOf(d, start, end, cols) {
  if ("series" in d) {
    const map = d.map ?? ((v) => v);
    return decimate(d.series, d.t0 + start * 1000, d.t0 + end * 1000, cols).map((p) => ({ x: (p.t - d.t0) / 1000, y: map(p.v) }));
  }
  /** @type {{ x: number, y: number }[]} */
  const out = [];
  const n = d.x.length;
  let first = 0;
  while (first < n && d.x[first] < start) first += 1;
  first = Math.max(0, first - 1);
  let last = first;
  while (last < n - 1 && d.x[last] <= end) last += 1;
  const count = last - first + 1;
  if (count <= cols * 4) {
    for (let i = first; i <= last; i += 1) out.push({ x: Number(d.x[i]), y: Number(d.y[i]) });
    return out;
  }
  const span = Math.max(1e-12, end - start);
  let col = -Infinity;
  /** @type {number[]} */
  let bucket = [];
  const flush = () => {
    if (!bucket.length) return;
    let lo = bucket[0];
    let hi = bucket[0];
    for (const i of bucket) {
      if (d.y[i] < d.y[lo]) lo = i;
      if (d.y[i] > d.y[hi]) hi = i;
    }
    for (const i of [...new Set([bucket[0], lo, hi, bucket[bucket.length - 1]])].sort((a, b) => a - b)) out.push({ x: Number(d.x[i]), y: Number(d.y[i]) });
    bucket = [];
  };
  for (let i = first; i <= last; i += 1) {
    const c = Math.floor(((d.x[i] - start) / span) * cols);
    if (c !== col) {
      flush();
      col = c;
    }
    bucket.push(i);
  }
  flush();
  return out;
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 */
function segment(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.stroke();
}

/** @param {number} lo @param {number} hi @param {number} count */
export function niceTicks(lo, hi, count) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** @param {number} v */
export function shortNumber(v) {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-2) return v.toExponential(1).replace("e", "E");
  return String(Number(v.toPrecision(4)));
}
