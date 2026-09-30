// @ts-check
/**
 * Setpoint model shared by the setpoint editor: which setpoint commands a device has, how the
 * values it stores map to pressures, and how a relay with hysteresis behaves along a pressure
 * trace. Framework free, tested in Node (tests/setpoints).
 *
 * Every setpoint is normalised to the same shape, in mbar:
 *   on         the pressure at which the relay energises
 *   off        the pressure at which it releases again
 *   direction  "below": energise when the pressure falls to `on`, release when it rises to `off` (off >= on)
 *              "above": energise when the pressure rises to `on`, release when it falls to `off` (off <= on)
 * Between `on` and `off` (the hysteresis band) the relay keeps whatever state it had.
 *
 * SKY CDG (CSC gauge_tab.py): setpoint N low/high are raw bytes 0..255 and the pressure is
 *   p = FS * (raw / 255)^3
 * the relay energises below `low` and releases above `high` (🟠 V7: encoding still to be
 * checked in TIRA49E1).
 *
 * PPG550/570: a setpoint value, a hysteresis value, a direction and an enable. Whether the
 * hysteresis value is the absolute release pressure or an offset from the setpoint is not yet
 * confirmed against the operating manual (🟠 V14), so both readings are offered.
 */

import { getSimulationSpec } from "./sim/models.js";

export const CDG_RAW_MAX = 255;

/** @typedef {"below" | "above"} Direction */
/** @typedef {"absolute" | "offset"} HysteresisMode */

/**
 * @typedef {Object} SetpointChannel
 * @property {number} index
 * @property {Record<string, string>} commands   role -> command name (low, high, read | value, hysteresis, direction, enable)
 */

/**
 * @typedef {{ kind: "cdg" | "ppg", channels: SetpointChannel[] }} SetpointLayout
 */

/**
 * Detect the setpoint commands a device offers.
 * @param {{ name: string, read: boolean, write: boolean }[]} commands
 * @returns {SetpointLayout | null}
 */
export function detectSetpoints(commands) {
  const byName = new Map(commands.map((c) => [c.name, c]));
  /** @type {SetpointChannel[]} */
  const cdg = [];
  for (let i = 1; i <= 4; i += 1) {
    const low = byName.get(`setpoint_${i}_low`);
    const high = byName.get(`setpoint_${i}_high`);
    if (low?.write && high?.write) {
      /** @type {Record<string, string>} */
      const roles = { low: low.name, high: high.name };
      if (byName.get(`setpoint_${i}_read`)?.read) roles.read = `setpoint_${i}_read`;
      cdg.push({ index: i, commands: roles });
    }
  }
  if (cdg.length) return { kind: "cdg", channels: cdg };

  /** @type {SetpointChannel[]} */
  const ppg = [];
  for (let i = 1; i <= 9; i += 1) {
    const value = byName.get(`setpoint_${i}`);
    if (!value?.write) continue;
    /** @type {Record<string, string>} */
    const roles = { value: value.name };
    for (const role of ["hysteresis", "direction", "enable"]) {
      if (byName.has(`setpoint_${i}_${role}`)) roles[role] = `setpoint_${i}_${role}`;
    }
    ppg.push({ index: i, commands: roles });
  }
  return ppg.length ? { kind: "ppg", channels: ppg } : null;
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** CDG raw setpoint byte to mbar (cube law). @param {number} raw @param {number} fullScaleMbar */
export function cdgRawToMbar(raw, fullScaleMbar) {
  const ratio = clamp(Number(raw) / CDG_RAW_MAX, 0, 1);
  return fullScaleMbar * ratio ** 3;
}

/** mbar to the nearest CDG raw setpoint byte. @param {number} mbar @param {number} fullScaleMbar */
export function cdgMbarToRaw(mbar, fullScaleMbar) {
  const ratio = clamp(Number(mbar) / fullScaleMbar, 0, 1);
  return Math.round(CDG_RAW_MAX * Math.cbrt(ratio));
}

/**
 * PPG setpoint registers to the normalised band.
 * @param {{ value: number, hysteresis: number, direction: Direction }} sp  mbar
 * @param {HysteresisMode} mode
 */
export function ppgToBand(sp, mode) {
  const on = sp.value;
  if (mode === "absolute") return { on, off: sp.hysteresis };
  const h = Math.abs(sp.hysteresis);
  return { on, off: sp.direction === "above" ? Math.max(0, on - h) : on + h };
}

/**
 * The normalised band back to PPG registers.
 * @param {{ on: number, off: number }} band  mbar
 * @param {HysteresisMode} mode
 */
export function bandToPpg(band, mode) {
  return { value: band.on, hysteresis: mode === "absolute" ? band.off : Math.abs(band.off - band.on) };
}

/**
 * One step of a relay with hysteresis.
 * @param {boolean} state  current relay state
 * @param {number} p       pressure, mbar
 * @param {{ on: number, off: number, direction: Direction, enabled?: boolean }} sp
 */
export function relayStep(state, p, sp) {
  if (sp.enabled === false) return false;
  if (sp.direction === "above") {
    if (p >= sp.on) return true;
    if (p <= sp.off) return false;
    return state;
  }
  if (p <= sp.on) return true;
  if (p >= sp.off) return false;
  return state;
}

/**
 * Relay state along a pressure trace, plus the indices where it switches.
 * @param {number[]} pressures
 * @param {{ on: number, off: number, direction: Direction, enabled?: boolean }} sp
 * @param {boolean} [initial]
 */
export function relayTrace(pressures, sp, initial = false) {
  /** @type {boolean[]} */
  const states = [];
  /** @type {{ i: number, on: boolean }[]} */
  const switches = [];
  let state = initial;
  pressures.forEach((p, i) => {
    const next = relayStep(state, p, sp);
    if (i > 0 && next !== state) switches.push({ i, on: next });
    states.push(next);
    state = next;
  });
  return { states, switches };
}

/**
 * Where a pressure sits relative to a setpoint, independent of history.
 * @param {number} p
 * @param {{ on: number, off: number, direction: Direction, enabled?: boolean }} sp
 * @returns {"disabled" | "on" | "off" | "band"}
 */
export function zoneOf(p, sp) {
  if (sp.enabled === false) return "disabled";
  const lo = Math.min(sp.on, sp.off);
  const hi = Math.max(sp.on, sp.off);
  if (p > lo && p < hi) return "band";
  if (sp.direction === "above") return p >= sp.on ? "on" : "off";
  return p <= sp.on ? "on" : "off";
}

/** Phases of the illustrative cycle, as fractions of its length. */
export const CYCLE_PHASES = Object.freeze([
  { from: 0, to: 0.05, label: "Vented" },
  { from: 0.05, to: 0.4, label: "Pump-down" },
  { from: 0.4, to: 0.58, label: "Gas burst" },
  { from: 0.58, to: 0.72, label: "Base pressure" },
  { from: 0.72, to: 0.93, label: "Vent" },
  { from: 0.93, to: 1, label: "" }
]);

/**
 * An illustrative vacuum cycle in log pressure: vented, pump-down into a valley below every
 * switch-on point, a gas burst that climbs back up to `burst` (placed inside the focused
 * setpoint's hysteresis band, so the relay visibly holds), recovery to base pressure, then a
 * vent back up. Returns n points with x in 0..1.
 * @param {{ top: number, bottom: number, burst: number, n?: number }} levels  mbar
 */
export function illustrativeCycle({ top, bottom, burst, n = 480 }) {
  const lt = Math.log10(top);
  const lb = Math.log10(bottom);
  const lp = Math.log10(clamp(burst, bottom, top));
  const lr = lb + (lp - lb) * 0.12;
  const easeOut = (/** @type {number} */ t, /** @type {number} */ k) => 1 - (1 - t) ** k;
  const smooth = (/** @type {number} */ t) => t * t * (3 - 2 * t);
  const seg = (/** @type {number} */ x, /** @type {number} */ a, /** @type {number} */ b) => clamp((x - a) / (b - a), 0, 1);
  /** @type {{ x: number, p: number }[]} */
  const points = [];
  for (let i = 0; i < n; i += 1) {
    const x = i / (n - 1);
    let l;
    if (x < 0.05) l = lt;
    else if (x < 0.4) l = lt + (lb - lt) * easeOut(seg(x, 0.05, 0.4), 2.6);
    else if (x < 0.47) l = lb + (lp - lb) * smooth(seg(x, 0.4, 0.47));
    else if (x < 0.58) l = lp + (lr - lp) * easeOut(seg(x, 0.47, 0.58), 2.2);
    else if (x < 0.72) l = lr + (lb - lr) * smooth(seg(x, 0.58, 0.72));
    else if (x < 0.93) l = lb + (lt - lb) * smooth(seg(x, 0.72, 0.93));
    else l = lt;
    points.push({ x, p: 10 ** l });
  }
  return points;
}

/**
 * Levels for the illustrative cycle and a view range that keeps every setpoint inside it.
 * @param {{ on: number, off: number, enabled?: boolean }[]} setpoints  mbar
 * @param {{ on: number, off: number } | null} focus
 * @param {{ min: number, max: number }} range  what the gauge can measure, mbar
 */
export function cycleLevels(setpoints, focus, range) {
  const values = setpoints.flatMap((s) => [s.on, s.off]).filter((v) => v > 0 && Number.isFinite(v));
  const lo = values.length ? Math.min(...values) : Math.sqrt(range.min * range.max);
  const hi = values.length ? Math.max(...values) : lo;
  // Stay inside what the gauge can measure, but never crop a setpoint out of view.
  let yMin = Math.max(range.min, lo / 40);
  if (yMin > lo / 2) yMin = lo / 10;
  let yMax = Math.min(range.max, hi * 40);
  if (yMax < hi * 2) yMax = hi * 3;
  const span = Math.log10(yMax) - Math.log10(yMin);
  const top = 10 ** (Math.log10(yMax) - span * 0.06);
  const bottom = Math.max(yMin * 1.3, lo / 6);
  const burst = focus ? Math.sqrt(Math.max(focus.on, 1e-30) * Math.max(focus.off, 1e-30)) : Math.sqrt(lo * hi);
  return { yMin, yMax, top, bottom: Math.min(bottom, lo * 0.9), burst };
}

/**
 * What a gauge can measure, in mbar: a CDG from its full scale (four decades below it), every
 * other model from the simulation's model table.
 * @param {string} model @param {number | null | undefined} fullScaleMbar
 */
export function gaugeRangeMbar(model, fullScaleMbar) {
  if (fullScaleMbar && /^CDG/i.test(model)) return { min: fullScaleMbar * 1e-4, max: fullScaleMbar };
  const spec = getSimulationSpec(model);
  return { min: spec.minMbar, max: spec.maxMbar };
}

/** Pressure written the way PPG gauges print it: 1.00E-02. @param {number} mbar */
export function formatSetpointValue(mbar) {
  return mbar.toExponential(2).toUpperCase().replace(/E([+-])(\d)$/, "E$10$2");
}
