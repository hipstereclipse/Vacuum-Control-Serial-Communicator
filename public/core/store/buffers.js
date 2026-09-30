// @ts-check
/**
 * In-memory sample buffers: typed arrays per series, 13 bytes per sample (8-byte time,
 * 4-byte value, 1-byte status). Four gauges at 10 Hz for 24 h is about 3.46 million
 * samples, roughly 45 MB — it fits in memory, but the chunks are also flushed to IndexedDB
 * so a long log does not live only here (WEB_PORT_PLAN.md section 9).
 */

/** Status codes stored per sample. Over- and underrange are drawn but left out of statistics (VGC trend rule). */
export const SAMPLE_STATUS = Object.freeze({ OK: 0, UNDERRANGE: 1, OVERRANGE: 2, WARNING: 3, GAP: 9 });

/** @param {string[]} warnings */
export function statusFromWarnings(warnings = []) {
  if (warnings.includes("overrange")) return SAMPLE_STATUS.OVERRANGE;
  if (warnings.includes("underrange")) return SAMPLE_STATUS.UNDERRANGE;
  return warnings.length ? SAMPLE_STATUS.WARNING : SAMPLE_STATUS.OK;
}

export class Series {
  /**
   * @param {string} id       deviceId:command
   * @param {{ unit?: string, capacity?: number }} [options]
   */
  constructor(id, options = {}) {
    this.id = id;
    this.unit = options.unit ?? "";
    const capacity = options.capacity ?? 1024;
    this.t = new Float64Array(capacity);
    this.v = new Float32Array(capacity);
    this.s = new Uint8Array(capacity);
    this.length = 0;
    /** Index of the first sample not yet flushed to IndexedDB. */
    this.flushed = 0;
    this.version = 0;
  }

  /** @param {number} t epoch ms @param {number} value @param {number} [status] */
  push(t, value, status = SAMPLE_STATUS.OK) {
    if (this.length === this.t.length) this._grow();
    this.t[this.length] = t;
    this.v[this.length] = value;
    this.s[this.length] = status;
    this.length += 1;
    this.version += 1;
  }

  _grow() {
    const size = this.t.length * 2;
    const t = new Float64Array(size);
    const v = new Float32Array(size);
    const s = new Uint8Array(size);
    t.set(this.t);
    v.set(this.v);
    s.set(this.s);
    this.t = t;
    this.v = v;
    this.s = s;
  }

  last() {
    if (!this.length) return null;
    const i = this.length - 1;
    return { t: this.t[i], v: this.v[i], s: this.s[i] };
  }

  /** First index with t >= time (binary search). @param {number} time */
  lowerBound(time) {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.t[mid] < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Last, min, max, mean and a least-squares rate in decades per minute over [from, to],
   * leaving out non-OK samples (the VGC trend statistics).
   * @param {number} from @param {number} to
   */
  stats(from, to) {
    let n = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let logN = 0;
    const t0 = from;
    for (let i = this.lowerBound(from); i < this.length && this.t[i] <= to; i += 1) {
      if (this.s[i] === SAMPLE_STATUS.OVERRANGE || this.s[i] === SAMPLE_STATUS.UNDERRANGE || this.s[i] === SAMPLE_STATUS.GAP) continue;
      const v = this.v[i];
      n += 1;
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
      if (v > 0) {
        const x = (this.t[i] - t0) / 60000;
        const y = Math.log10(v);
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
        logN += 1;
      }
    }
    const denom = logN * sxx - sx * sx;
    return {
      count: n,
      last: this.last()?.v ?? NaN,
      min: n ? min : NaN,
      max: n ? max : NaN,
      mean: n ? sum / n : NaN,
      decadesPerMinute: logN > 2 && denom !== 0 ? (logN * sxy - sx * sy) / denom : NaN
    };
  }

  /** Samples in a range as plain arrays (for exports). @param {number} [from] @param {number} [to] */
  slice(from = -Infinity, to = Infinity) {
    const start = this.lowerBound(from);
    let end = start;
    while (end < this.length && this.t[end] <= to) end += 1;
    return { t: this.t.slice(start, end), v: this.v.slice(start, end), s: this.s.slice(start, end) };
  }

  /** Samples not yet flushed, and mark them flushed. */
  takeUnflushed() {
    const chunk = { from: this.flushed, t: this.t.slice(this.flushed, this.length), v: this.v.slice(this.flushed, this.length), s: this.s.slice(this.flushed, this.length) };
    this.flushed = this.length;
    return chunk;
  }

  /** @param {{ t: ArrayLike<number>, v: ArrayLike<number>, s: ArrayLike<number> }} chunk */
  load(chunk) {
    for (let i = 0; i < chunk.t.length; i += 1) this.push(chunk.t[i], chunk.v[i], chunk.s[i]);
    this.flushed = this.length;
  }
}

/**
 * Per-pixel-column decimation that keeps extremes: for each column, the first, min, max and
 * last sample, so spikes survive any zoom level (VGC trend engine).
 * @param {Series} series
 * @param {number} from @param {number} to @param {number} columns
 * @returns {{ t: number, v: number, s: number }[]}
 */
export function decimate(series, from, to, columns) {
  const out = [];
  const start = Math.max(0, series.lowerBound(from) - 1);
  const span = Math.max(1, to - from);
  let col = -1;
  /** @type {any} */
  let bucket = null;
  const flush = () => {
    if (!bucket) return;
    const points = [bucket.first, bucket.min, bucket.max, bucket.last].filter((p, i, arr) => arr.indexOf(p) === i);
    points.sort((a, b) => a - b);
    for (const i of points) out.push({ t: series.t[i], v: series.v[i], s: series.s[i] });
  };
  for (let i = start; i < series.length; i += 1) {
    const t = series.t[i];
    if (t > to) {
      flush();
      bucket = null;
      out.push({ t, v: series.v[i], s: series.s[i] });
      return out;
    }
    const c = Math.floor(((t - from) / span) * columns);
    // A sample just before the window lands in column -1, the initial `col`: open a bucket anyway.
    if (c !== col || !bucket) {
      flush();
      col = c;
      bucket = { first: i, min: i, max: i, last: i };
    } else {
      if (series.v[i] < series.v[bucket.min]) bucket.min = i;
      if (series.v[i] > series.v[bucket.max]) bucket.max = i;
      bucket.last = i;
    }
  }
  flush();
  return out;
}
