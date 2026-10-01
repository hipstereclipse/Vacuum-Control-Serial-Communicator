// @ts-check
/**
 * OPG550 Spectrum Studio: the data model behind the studio view (WEB_PORT_PLAN.md section 5.6
 * and parity row 17). Port of the state and analysis in CSC GUI/gauge_workspace/gauge_tab.py
 * `OPG550SpectrumStudio`; the drawing lives in public/ui/spectrum-studio.js.
 *
 * What it keeps, as CSC does:
 *  - the OPG550's own pressure after spike rejection (a reading more than 100x the median of
 *    the last five is a plasma-transition artefact and is dropped), and dP/dt from it;
 *  - the latest spectrum, live from SPEC / RoR / RGD records or synthesised from the pressure
 *    for the scenario plot options, with optical species identification below 1E-2 mbar;
 *  - a gas history: per tracked gas the share (%), partial pressure and its rate of change;
 *  - every sample the OPG CSV export needs;
 *  - plasma state and the ignition thresholds, which are shown in the active unit but stored
 *    and evaluated in mbar.
 *
 * Every history is kept for the whole session (CSC keeps unbounded deques on purpose).
 * Peer pressures are not copied here: in the browser every device's Series already holds its
 * full history on a shared wall-clock axis, so the studio reads them directly.
 *
 * Auto plasma has three modes (plasma.mode). All use CSC's thresholds and 5 s cooldown:
 *  - "off": no evaluation.
 *  - "prompt" (the default when enabled): a threshold crossing raises a prompt; the write needs
 *    the user's click and the usual confirmation (WEB_PORT_PLAN.md section 11).
 *  - "auto": CSC's behaviour. A crossing queues an action (takeAutoAction) that the app sends
 *    without asking: plasma off above the max safe pressure, on below the min ignition
 *    pressure, and after an automatic ignition optionally the main plot's algorithm, as CSC's
 *    plasma_enable handler does. The mode has to be armed through a danger confirmation and is
 *    never restored as "auto" after a reload.
 *
 * CSC also enables the SPEC / RoR / RGD algorithm whenever the main plot changes and re-sends
 * the enable every 30 s. Here starting an algorithm is an explicit, confirmed action (or part
 * of armed auto plasma); the background acquisition only reads (state, record count, record).
 *
 * Other differences: the gas shares from an RGD record's own partial pressures hold until the
 * next spectrum (CSC lets the next pressure reading replace them with the optical fit), and a
 * record's ignition flag updates the plasma state shown.
 */
import { SAMPLE_STATUS, Series } from "../store/buffers.js";
import { convertPressure, isPressureUnit } from "../units.js";
import {
  OPG_ANALYSIS_MAX_PRESSURE_MBAR,
  SpectrumMode,
  identifyOpticalSpecies,
  simulateOpticalSpectrum
} from "../sim/opg-spectrum.js";

/** Gases the studio tracks, in CSC order. */
export const STUDIO_GASES = Object.freeze(["OH", "H2O", "H2", "N2", "O2", "Ar", "He", "CO", "CO2", "CH4"]);

export const ANALYSIS_MODES = Object.freeze(["Raw Spectrum", "Rate of Rise", "Residual Gas Detection", "Advanced Analysis"]);

/** @type {Readonly<Record<string, string>>} */
export const MODE_DETAIL = Object.freeze({
  "Raw Spectrum": "Reading SPEC state and counts and rendering the visible and near-UV spectrum.",
  "Rate of Rise": "Reading RoR state and counts while plotting dP/dt from the live pressure.",
  "Residual Gas Detection": "Reading RGD state and counts and tracking the selected gas signatures.",
  "Advanced Analysis": "Compare two pressure sources and correlate their difference with a selected OPG gas signal."
});

/** One-shot reads per main plot ("Poll Mode" in CSC). Reads only. */
export const POLL_GROUPS = Object.freeze({
  "Raw Spectrum": ["pressure", "operating_mode", "spectrometer_pixel_count", "spec_state", "spec_record_count", "spec_buffer_size", "spec_record"],
  "Rate of Rise": ["pressure", "operating_mode", "ror_state", "ror_record_count", "ror_buffer_size", "ror_record"],
  "Residual Gas Detection": ["pressure", "operating_mode", "rgd_state", "rgd_record_count", "rgd_buffer_size", "rgd_record", "analog_output_mode", "analog_output_voltage"],
  "Advanced Analysis": ["pressure", "operating_mode", "spec_state", "ror_state", "rgd_state", "spec_record", "analog_output_mode", "analog_output_voltage", "error_status"]
});

/** "Snapshot All": every safe read CSC lists, in its order. */
export const SNAPSHOT_COMMANDS = Object.freeze([
  "pressure", "product_name", "software_version", "bootloader_version", "serial_number", "manufacturer_name",
  "error_status", "error_count", "plasma_state", "spectrometer_pixel_count", "spec_record", "operating_mode",
  "spec_state", "spec_record_count", "ror_state", "ror_record_count", "ror_record", "rgd_state", "rgd_record_count",
  "rgd_record", "analog_output_mode", "analog_output_voltage"
]);

/** Commands shown in the telemetry table, in CSC order. */
export const TELEMETRY_COMMANDS = Object.freeze([
  "operating_mode", "bootloader_version", "spec_state", "spec_record_count", "ror_state", "ror_record_count",
  "rgd_state", "rgd_record_count", "analog_output_mode", "analog_output_voltage", "error_count"
]);

export const RECORD_COMMANDS = Object.freeze(["spec_record", "ror_record", "rgd_record"]);

/** @type {Readonly<Record<string, string>>} */
export const RECORD_FOR_MODE = Object.freeze({
  "Raw Spectrum": "spec_record",
  "Rate of Rise": "ror_record",
  "Residual Gas Detection": "rgd_record",
  "Advanced Analysis": "spec_record"
});
/** @type {Readonly<Record<string, string>>} */
export const ENABLE_FOR_RECORD = Object.freeze({ spec_record: "spec_enable", ror_record: "ror_enable", rgd_record: "rgd_enable" });
/** @type {Readonly<Record<string, string>>} */
export const STATE_FOR_RECORD = Object.freeze({ spec_record: "spec_state", ror_record: "ror_state", rgd_record: "rgd_state" });
/** @type {Readonly<Record<string, string>>} */
export const COUNT_FOR_RECORD = Object.freeze({ spec_record: "spec_record_count", ror_record: "ror_record_count", rgd_record: "rgd_record_count" });
/** @type {Readonly<Record<string, string>>} */
export const ALGORITHM_LABELS = Object.freeze({ spec_enable: "SPEC", ror_enable: "RoR", rgd_enable: "RGD" });

/** Wavelength span of the OPG550 view (CSC). */
export const WAVELENGTH_MIN_NM = 303.05;
export const WAVELENGTH_MAX_NM = 876.07;
/** The RoR CSV uses a slightly shifted pixel grid (CSC `_opg_ror_header`). */
export const ROR_WAVELENGTH_MIN_NM = 305.53;
export const ROR_WAVELENGTH_MAX_NM = 878.56;
export const SPECTRUM_SAMPLES = 288;

/** Species order of the RGD record's gas blocks (CSC `_apply_rgd_partial_pressures`). */
export const RGD_GAS_ORDER = Object.freeze(["H2", "He", "N2", "O2", "Ar", "NH", "OH", "CH", "CO", "Fluor"]);

/** Physical range of the gauge, used to fix the right-hand pressure axes (CSC). */
export const GAUGE_RANGE_MBAR = Object.freeze({ min: 1e-10, max: 1.1e3 });

/** Live spectrum request spacing, CSC `_live_spec_timer`. */
export const LIVE_SPEC_INTERVAL_MS = 2000;
/** Cooldown between plasma actions, CSC `_evaluate_auto_plasma`. */
export const AUTO_PLASMA_COOLDOWN_MS = 5000;
/** Spike rejection: window and factor, CSC `_update_pressure`. */
export const SPIKE_WINDOW = 5;
export const SPIKE_FACTOR = 100;
/** Plasma threshold defaults, CSC GUI/settings_dialog.py DEFAULTS ("opg/..."). */
export const PLASMA_DEFAULTS = Object.freeze({ mode: /** @type {"off" | "prompt" | "auto"} */ ("off"), minIgnitionMbar: 1.0e-6, maxSafeMbar: 1.0e-2, autoStartAlgorithm: true });
/** Auto plasma modes, in the order the studio offers them. */
export const PLASMA_MODES = Object.freeze(["off", "prompt", "auto"]);
/** Plasma state reads while auto plasma is on, so the thresholds meet a current state. */
export const PLASMA_READ_INTERVAL_MS = 2000;

/** @type {Readonly<Record<string, string>>} */
export const SPECTRUM_MODE_DESCRIPTIONS = Object.freeze({
  [SpectrumMode.AUTO]: "Live Data: shows only the spectrum data returned by the gauge.",
  [SpectrumMode.AIR_LEAK]: "Air Leak: simulated atmosphere ingress. N₂ 72 %, O₂ 20 %, Ar 3 %, H₂O 4 % baseline; peaks evolve as outgassing grows over time.",
  [SpectrumMode.WATER_LEAK]: "Water Leak: simulated humid atmosphere ingress. H₂O and OH dominate; thermal dissociation produces H₂ over time.",
  [SpectrumMode.HELIUM_LEAK]: "Helium Leak: simulated He tracer. He dominates (about 78 %); residual N₂ and O₂ diminish as He fills the chamber.",
  [SpectrumMode.HYDROCARBON_BACKSTREAM]: "Hydrocarbon Backstream: simulated pump-oil vapour. CH₄ and H₂O start high; CO grows as decomposition proceeds."
});

// ---------------------------------------------------------------------------------------------
// Pure helpers

/**
 * Signed percent difference with B as the reference (CSC `_pressure_delta_percent`); null when
 * either value is not finite or B is zero.
 * @param {number} a @param {number} b
 */
export function pressureDeltaPercent(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

/**
 * Python "{:.{d}E}" with an optional sign: 1e-6 -> "1.0000E-06".
 * @param {number} v @param {number} [digits] @param {boolean} [signed]
 */
export function formatSci(v, digits = 3, signed = false) {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf";
  const [m, e] = v.toExponential(digits).split("e");
  const n = Number(e);
  const text = `${m}E${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  return signed && v >= 0 ? `+${text}` : text;
}

/** Python "{:.{p}g}". @param {number} v @param {number} [p] */
export function formatG(v, p = 4) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(Number(v.toPrecision(p)))));
  if (exp < -4 || exp >= p) {
    const [m, e] = v.toExponential(p - 1).split("e");
    const n = Number(e);
    return `${m.includes(".") ? m.replace(/\.?0+$/, "") : m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const fixed = v.toFixed(Math.max(0, p - 1 - exp));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * The line under the correlation chart (CSC `_refresh_advanced_plot`), from the latest value of
 * each source in the display unit.
 * @param {number} a @param {number} b @param {string} unit
 */
export function deltaSummary(a, b, unit) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const pct = pressureDeltaPercent(a, b);
  // CSC divides by max(B, 1e-30), which prints ratios like 1e+24 when B reads zero; a
  // non-positive reference gives "n/a" here, as Δ% does.
  const ratio = b > 0 ? a / b : null;
  return {
    delta: a - b,
    percent: pct,
    ratio,
    text: `Δ = ${formatSci(a - b, 4, true)} ${unit}  |  Δ% = ${pct == null ? "n/a" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}  |  ratio = ${ratio == null ? "n/a" : formatG(ratio, 4)}`
  };
}

/** Vacuum regime label (CSC `_vacuum_quality`). @param {number} mbar */
export function vacuumQuality(mbar) {
  const p = Math.max(mbar, 0);
  if (p >= 1) return "Rough";
  if (p >= 1e-2) return "Medium";
  if (p >= 1e-4) return "Fine";
  if (p >= 1e-6) return "High";
  return "Ultra-high";
}

/** 1E+3 .. 1E-9 mbar mapped to 0 .. 1000 on a log scale (CSC `_vacuum_score`). @param {number} mbar */
export function vacuumScore(mbar) {
  const p = Math.max(mbar, 1e-12);
  const score = (3 - Math.log10(p)) / 12;
  return Math.trunc(Math.max(0, Math.min(1, score)) * 1000);
}

/**
 * Spike rejection (CSC `_update_pressure`): once three readings are in the window, a reading
 * more than 100x the window's median is a transient (the OPG550 can briefly report its raw
 * Pirani saturation value while the plasma changes state) and is rejected.
 */
export function createSpikeFilter(window = SPIKE_WINDOW, factor = SPIKE_FACTOR) {
  /** @type {number[]} */
  const recent = [];
  return {
    /** @param {number} mbar @returns {boolean} true when the reading is kept */
    accept(mbar) {
      if (recent.length >= 3) {
        const m = median(recent);
        if (m > 1e-12 && mbar > m * factor) return false;
      }
      recent.push(mbar);
      if (recent.length > window) recent.shift();
      return true;
    },
    reset() {
      recent.length = 0;
    }
  };
}

/** @param {number[]} values */
function median(values) {
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Should the plasma change state? (CSC `_evaluate_auto_plasma`.) Thresholds are in mbar.
 * Plasma state: 0 off, 1 on but not ignited, 2 on and ignited. Returns null when nothing
 * should change, when the state is unknown, or during the cooldown after the last action.
 * @param {{ enabled: boolean, pressureMbar: number | null, plasmaState: number | null, minMbar: number, maxMbar: number, lastActionMs: number, nowMs: number, cooldownMs?: number }} s
 * @returns {{ action: "on" | "off", reason: string } | null}
 */
export function evaluateAutoPlasma(s) {
  if (!s.enabled || s.pressureMbar == null || s.plasmaState == null || !Number.isFinite(s.pressureMbar)) return null;
  if (s.nowMs - s.lastActionMs < (s.cooldownMs ?? AUTO_PLASMA_COOLDOWN_MS)) return null;
  const on = s.plasmaState >= 1;
  if (s.pressureMbar > s.maxMbar && on) return { action: "off", reason: "above max safe" };
  if (s.pressureMbar < s.minMbar && !on) return { action: "on", reason: "below min ignite" };
  return null;
}

/**
 * Value of a series at time `t` the way CSC's hover bar looks it up: the first sample at or
 * after `t` (numpy searchsorted), clamped to the ends.
 * @param {Series} series @param {number} t
 */
export function seriesValueAt(series, t) {
  if (!series.length) return null;
  const i = Math.min(Math.max(series.lowerBound(t), 0), series.length - 1);
  return { t: series.t[i], v: series.v[i] };
}

/**
 * Newest sample that is a real reading: finite and not flagged over- or underrange or a gap
 * (a CDG below its range reports about -0.024 x full scale, which would make Δ% and the ratio
 * meaningless).
 * @param {Series} series
 */
export function lastValid(series) {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const st = series.s[i];
    if (Number.isFinite(series.v[i]) && st !== SAMPLE_STATUS.OVERRANGE && st !== SAMPLE_STATUS.UNDERRANGE && st !== SAMPLE_STATUS.GAP) return { t: series.t[i], v: series.v[i] };
  }
  return null;
}

/** `n` evenly spaced values from a to b inclusive (numpy linspace). @param {number} a @param {number} b @param {number} n */
export function linspace(a, b, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = n === 1 ? a : a + ((b - a) * i) / (n - 1);
  return out;
}

/** Linear interpolation of y(x) at `at` with clamped ends (numpy interp). @param {ArrayLike<number>} x @param {ArrayLike<number>} y @param {number} at */
export function interp(x, y, at) {
  const n = x.length;
  if (!n) return NaN;
  if (at <= x[0]) return y[0];
  if (at >= x[n - 1]) return y[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= at) lo = mid;
    else hi = mid;
  }
  const f = (at - x[lo]) / (x[hi] - x[lo] || 1);
  return y[lo] + f * (y[hi] - y[lo]);
}

/**
 * Identification matches as percentages of the summed scores (CSC, every call site).
 * @param {{ name: string, score: number }[]} matches
 */
export function gasPercentFromMatches(matches) {
  /** @type {Record<string, number>} */
  const pct = Object.fromEntries(STUDIO_GASES.map((g) => [g, 0]));
  const total = matches.reduce((s, m) => s + Math.max(m.score, 0), 0) || 1;
  for (const m of matches) if (m.name in pct) pct[m.name] = (Math.max(0, m.score) / total) * 100;
  return pct;
}

/**
 * Partial pressures of an RGD record mapped onto the tracked gases (CSC
 * `_apply_rgd_partial_pressures`): CH counts as CH4, NH and Fluor are not tracked.
 * @param {ArrayLike<number>} partials in mbar, RGD_GAS_ORDER
 * @param {number} pressureMbar
 */
export function gasPercentFromRgd(partials, pressureMbar) {
  /** @type {Record<string, number>} */
  const partialMap = {};
  for (let i = 0; i < RGD_GAS_ORDER.length && i < partials.length; i += 1) {
    const v = Number(partials[i]);
    if (Number.isFinite(v)) partialMap[RGD_GAS_ORDER[i]] = Math.max(v, 0);
  }
  const p = Math.max(Number.isFinite(pressureMbar) ? pressureMbar : 0, 1e-30);
  /** @type {Record<string, number>} */
  const pct = Object.fromEntries(STUDIO_GASES.map((g) => [g, 0]));
  for (const [gas, partial] of Object.entries(partialMap)) {
    const mapped = gas === "CH" ? "CH4" : gas;
    if (mapped in pct) pct[mapped] = Math.min(100, Math.max(0, (partial / p) * 100));
  }
  return { pct, partialMap };
}

/** Which charts a main plot shows (CSC `_sync_chart_visibility`). @param {string} mode @param {boolean} anyGas */
export function chartVisibility(mode, anyGas) {
  if (mode === "Residual Gas Detection") return { advanced: false, trend: false, spectrum: !anyGas, gas: anyGas };
  return {
    advanced: mode === "Advanced Analysis",
    trend: mode === "Rate of Rise",
    spectrum: mode === "Raw Spectrum",
    gas: mode === "Advanced Analysis" && anyGas
  };
}

// ---------------------------------------------------------------------------------------------
// Studio state

/**
 * @typedef {{
 *   x: Float64Array, y: Float64Array, t: number, source: "live" | "simulated", mode: string,
 *   command?: string, recordId?: number, integrationUs?: number, ignition?: number
 * }} Spectrum
 *
 * @typedef {{
 *   t: number, timeS: number, pressureMbar: number, gasPct: Record<string, number>,
 *   spectrum: number | { mode: string, pressureMbar: number, trend: number, elapsedS: number },
 *   integrationMs: number | null, analogMv: number | null
 * }} ExportSample
 */

export class OpgStudioState {
  /**
   * @param {{ id?: string, now?: () => number, t0?: number, plasma?: Partial<typeof PLASMA_DEFAULTS> }} [options]
   *   t0 fixes the x = 0 of the time charts (default: the first OPG550 pressure sample)
   */
  constructor(options = {}) {
    const id = options.id ?? "opg";
    this.now = options.now ?? Date.now;
    /** Spike-filtered OPG550 pressure, mbar. */
    this.pressure = new Series(`${id}:studio_pressure`, { unit: "mbar" });
    /** dP/dt of the filtered pressure, mbar/s. */
    this.ror = new Series(`${id}:studio_ror`, { unit: "mbar/s" });
    /** Pressure rise reported by RoR records, mTorr/min. */
    this.gaugeRor = new Series(`${id}:ror_pressure_rise`, { unit: "mTorr/min" });
    /** @type {Record<string, Series>} */
    this.gasPct = {};
    /** @type {Record<string, Series>} */
    this.gasPartial = {};
    /** @type {Record<string, Series>} */
    this.gasRate = {};
    for (const g of STUDIO_GASES) {
      this.gasPct[g] = new Series(`${id}:gas_${g}_pct`, { unit: "%" });
      this.gasPartial[g] = new Series(`${id}:gas_${g}_partial`, { unit: "mbar" });
      this.gasRate[g] = new Series(`${id}:gas_${g}_rate`, { unit: "mbar/s" });
    }
    /** @type {Record<string, number>} */
    this.latestGasPct = Object.fromEntries(STUDIO_GASES.map((g) => [g, 0]));
    this.spikes = createSpikeFilter();
    this.rejectedSpikes = 0;
    /** @type {number | null} wall-clock ms of the x = 0 of every time chart */
    this.t0 = options.t0 ?? null;
    /** @type {number | null} */
    this.lastPressureMbar = null;
    /** @type {number | null} */
    this.lastPressureT = null;

    /** @type {Spectrum | null} spectrum on screen */
    this.spectrum = null;
    /** @type {Spectrum | null} last spectrum from the gauge */
    this.liveSpectrum = null;
    this.spectrumMode = SpectrumMode.AUTO;
    this.moleculeText = "Likely optical gas signatures: —";
    /** @type {{ name: string, score: number }[]} */
    this.matches = [];
    /** @type {{ spectrum: Spectrum, pct: Record<string, number>, text: string } | null} shares from the RGD record behind the current spectrum */
    this.rgdShares = null;

    this.analysisMode = "Raw Spectrum";
    /** @type {Set<string>} */
    this.trackedGases = new Set();
    this.compareA = "";
    this.compareB = "";
    this.correlationGas = "OH";
    this.modeStatus = MODE_DETAIL["Raw Spectrum"];

    const plasma = { ...PLASMA_DEFAULTS, ...(options.plasma ?? {}) };
    this.plasma = {
      /** @type {number | null} 0 off, 1 on but not ignited, 2 ignited */
      state: /** @type {number | null} */ (null),
      text: "—",
      /** @type {"off" | "prompt" | "auto"} "auto" only after the user armed it in this page */
      mode: plasma.mode === "auto" ? "prompt" : PLASMA_MODES.includes(plasma.mode) ? plasma.mode : "off",
      minMbar: plasma.minIgnitionMbar,
      maxMbar: plasma.maxSafeMbar,
      /** after an automatic ignition, also start the main plot's algorithm (CSC) */
      autoStartAlgorithm: plasma.autoStartAlgorithm !== false,
      lastActionMs: -Infinity,
      lastReadMs: -Infinity,
      /** @type {{ action: "on" | "off", reason: string, pressureMbar: number, t: number } | null} */
      prompt: null,
      /** @type {{ action: "on" | "off", reason: string, pressureMbar: number, t: number } | null} queued for the app in "auto" mode */
      pending: null,
      /** @type {{ action: "on" | "off", reason: string, pressureMbar: number, t: number, result: string } | null} */
      lastAuto: null
    };

    /** @type {Record<string, number | null>} */
    this.recordCounts = { spec_record: null, ror_record: null, rgd_record: null };
    /** @type {Record<string, { code: number, label: string } | null>} */
    this.algorithmStates = { spec_record: null, ror_record: null, rgd_record: null };
    /** @type {string | null} the enable command the user last started (spec_enable ...) */
    this.startedAlgorithm = null;
    this.lastSpecRequestMs = -Infinity;
    /** @type {{ text: string, t: number } | null} */
    this.gaugeRorText = null;

    /** @type {Map<string, string>} */
    this.telemetry = new Map();
    this.identity = { firmware: "", serial: "", bootloader: "" };
    this.errorText = "—";
    /** @type {number | null} */
    this.analogMv = null;

    /** @type {ExportSample[]} */
    this.exportSamples = [];
    /** @type {Spectrum[]} live spectra referenced by export samples */
    this.spectra = [];
    this.revision = 0;
  }

  touch() {
    this.revision += 1;
  }

  /** Seconds since the studio's first sample, the x value CSC shows. @param {number} t */
  elapsedS(t) {
    return this.t0 == null ? 0 : (t - this.t0) / 1000;
  }

  /** @param {string} mode */
  setAnalysisMode(mode) {
    this.analysisMode = ANALYSIS_MODES.includes(mode) ? mode : "Raw Spectrum";
    this.modeStatus = MODE_DETAIL[this.analysisMode];
    this.lastSpecRequestMs = -Infinity;
    this.touch();
  }

  /** @param {string} mode a SpectrumMode value */
  setSpectrumMode(mode) {
    this.spectrumMode = mode;
    if (this.lastPressureMbar != null) this.updateSpectrum(this.lastPressureMbar, this.lastPressureT ?? this.now(), { capture: false });
    this.touch();
  }

  /** @param {string} gas @param {boolean} on */
  setTracked(gas, on) {
    if (on) this.trackedGases.add(gas);
    else this.trackedGases.delete(gas);
    this.touch();
  }

  visibility() {
    return chartVisibility(this.analysisMode, this.trackedGases.size > 0);
  }

  activeRecordCommand() {
    return RECORD_FOR_MODE[this.analysisMode] ?? "spec_record";
  }

  /**
   * Thresholds (mbar) and the auto plasma mode. Arming "auto" is the caller's job: the studio
   * asks for a danger confirmation first.
   * @param {{ minMbar?: number, maxMbar?: number, mode?: "off" | "prompt" | "auto", autoStartAlgorithm?: boolean }} patch
   */
  setPlasmaSettings(patch) {
    if (patch.minMbar != null && Number.isFinite(patch.minMbar) && patch.minMbar > 0) this.plasma.minMbar = patch.minMbar;
    if (patch.maxMbar != null && Number.isFinite(patch.maxMbar) && patch.maxMbar > 0) this.plasma.maxMbar = patch.maxMbar;
    if (patch.autoStartAlgorithm != null) this.plasma.autoStartAlgorithm = patch.autoStartAlgorithm;
    if (patch.mode != null && PLASMA_MODES.includes(patch.mode) && patch.mode !== this.plasma.mode) {
      this.plasma.mode = patch.mode;
      this.plasma.prompt = null;
      this.plasma.pending = null;
      // A freshly armed mode acts on the current pressure at once, as CSC's toggle does.
      this.plasma.lastActionMs = -Infinity;
    }
    this.evaluatePlasma();
    this.touch();
  }

  /** Whether thresholds are evaluated (prompt or auto). */
  get plasmaWatched() {
    return this.plasma.mode !== "off";
  }

  /** Should the app read the plasma state now? Marks the read when it says yes. @param {number} [nowMs] */
  plasmaReadDue(nowMs = this.now()) {
    if (!this.plasmaWatched || nowMs - this.plasma.lastReadMs < PLASMA_READ_INTERVAL_MS) return false;
    this.plasma.lastReadMs = nowMs;
    return true;
  }

  /** In "auto" mode: the queued plasma action, once. @returns {{ action: "on" | "off", reason: string, pressureMbar: number, t: number } | null} */
  takeAutoAction() {
    const a = this.plasma.pending;
    this.plasma.pending = null;
    return this.plasma.mode === "auto" ? a : null;
  }

  /**
   * Record what an automatic action did (CSC puts the same text in the mode status line).
   * @param {{ action: "on" | "off", reason: string, pressureMbar: number, t: number }} action @param {string} result @param {string} unit
   */
  noteAutoAction(action, result, unit) {
    this.plasma.lastAuto = { ...action, result };
    const limit = action.action === "off" ? this.plasma.maxMbar : this.plasma.minMbar;
    const u = isPressureUnit(unit) ? unit : "mbar";
    const fmt = (/** @type {number} */ mbar) => `${formatSci(convertPressure(mbar, "mbar", u), 2)} ${u}`;
    this.modeStatus = action.action === "off"
      ? `Auto-plasma: pressure ${fmt(action.pressureMbar)} > max safe ${fmt(limit)}: switching plasma OFF (${result}).`
      : `Auto-plasma: pressure ${fmt(action.pressureMbar)} < min ignite ${fmt(limit)}: switching plasma ON (${result}).`;
    this.touch();
  }

  /** Threshold in the display unit (thresholds are stored in mbar). @param {"minMbar" | "maxMbar"} key @param {string} unit */
  thresholdIn(key, unit) {
    const u = isPressureUnit(unit) ? unit : "mbar";
    return convertPressure(this.plasma[key], "mbar", u);
  }

  /** @param {"minMbar" | "maxMbar"} key @param {number} value @param {string} unit */
  setThresholdFrom(key, value, unit) {
    const u = isPressureUnit(unit) ? unit : "mbar";
    this.setPlasmaSettings({ [key]: convertPressure(value, u, "mbar") });
  }

  // -------------------------------------------------------------------------------------------
  // Ingest

  /**
   * A pressure reading from the OPG550 (CSC `_update_pressure` + `_update_spectrum_plot`).
   * @param {number} value @param {string} unit @param {number} [t] wall-clock ms
   * @returns {boolean} false when the reading was rejected as a spike
   */
  ingestPressure(value, unit, t = this.now()) {
    if (!Number.isFinite(value)) return false;
    const mbar = isPressureUnit(unit) ? convertPressure(value, unit, "mbar") : value;
    if (!this.spikes.accept(mbar)) {
      this.rejectedSpikes += 1;
      return false;
    }
    if (this.t0 == null) this.t0 = t;
    const kept = Math.max(mbar, 1e-12);
    const prev = this.pressure.last();
    this.pressure.push(t, kept);
    this.ror.push(t, prev ? (kept - prev.v) / Math.max((t - prev.t) / 1000, 1e-9) : 0);
    this.updateSpectrum(kept, t);
    return true;
  }

  /**
   * Refresh the spectrum on screen for a pressure sample, run identification, extend the gas
   * history and capture an export sample (CSC `_update_spectrum_plot`).
   * @param {number} pMbar @param {number} t @param {{ capture?: boolean }} [opts]
   */
  updateSpectrum(pMbar, t, opts = {}) {
    let trend = 0;
    if (this.lastPressureMbar != null && this.lastPressureT != null) trend = (pMbar - this.lastPressureMbar) / Math.max(1e-3, (t - this.lastPressureT) / 1000);
    const elapsed = Math.max(0, this.elapsedS(t));
    /** @type {ExportSample["spectrum"] | null} */
    let exportRef = null;

    if (this.spectrumMode === SpectrumMode.AUTO) {
      if (!this.liveSpectrum) {
        this.spectrum = null;
        this.moleculeText = "Likely optical gas signatures: waiting for live spectrum data";
        this.lastPressureMbar = Math.max(pMbar, 1e-12);
        this.lastPressureT = t;
        this.evaluatePlasma();
        this.touch();
        return;
      }
      this.spectrum = this.liveSpectrum;
      exportRef = this.spectra.indexOf(this.liveSpectrum);
    } else {
      const y = Float64Array.from(simulateOpticalSpectrum(Math.max(pMbar, 1e-12), trend, elapsed, this.spectrumMode, { wavelengthMinNm: WAVELENGTH_MIN_NM, wavelengthMaxNm: WAVELENGTH_MAX_NM, samples: SPECTRUM_SAMPLES }));
      this.spectrum = { x: linspace(WAVELENGTH_MIN_NM, WAVELENGTH_MAX_NM, y.length), y, t, source: "simulated", mode: this.spectrumMode };
      // A synthetic spectrum is a pure function of these inputs, so the export recomputes it
      // instead of keeping 288 values per sample.
      exportRef = { mode: this.spectrumMode, pressureMbar: Math.max(pMbar, 1e-12), trend, elapsedS: elapsed };
    }
    this.identify(pMbar);
    this.lastPressureMbar = Math.max(pMbar, 1e-12);
    this.lastPressureT = t;
    this.appendGasHistory(t);
    if (opts.capture !== false && exportRef != null) this.captureExportSample(t, exportRef);
    this.evaluatePlasma();
    this.touch();
  }

  /** @param {number} pMbar */
  identify(pMbar) {
    const s = this.spectrum;
    if (!s) return;
    if (this.rgdShares && this.rgdShares.spectrum === s) {
      // The gauge's own RGD partial pressures describe this spectrum better than the optical
      // signature fit. CSC lets the next pressure reading replace them; here they hold until
      // the next spectrum arrives.
      this.latestGasPct = { ...this.rgdShares.pct };
      this.moleculeText = this.rgdShares.text;
      return;
    }
    if (pMbar <= OPG_ANALYSIS_MAX_PRESSURE_MBAR) {
      this.matches = identifyOpticalSpecies(s.y, { wavelengthMinNm: s.x[0], wavelengthMaxNm: s.x[s.x.length - 1], topK: STUDIO_GASES.length });
      this.latestGasPct = gasPercentFromMatches(this.matches);
      this.moleculeText = this.matches.length
        ? `Likely optical gas signatures: ${this.matches.slice(0, 5).map((m) => `${m.name} (${this.latestGasPct[m.name]?.toFixed(0) ?? 0}%)`).join(", ")}`
        : "Likely optical gas signatures: no dominant optical signature";
    } else {
      this.matches = [];
      this.latestGasPct = Object.fromEntries(STUDIO_GASES.map((g) => [g, 0]));
      this.moleculeText = `Gas analysis unavailable above ${formatSci(OPG_ANALYSIS_MAX_PRESSURE_MBAR, 1)} mbar (pump down further to enable species identification)`;
    }
  }

  /**
   * One gas-history sample per pressure sample (CSC `_append_gas_history`): all-zero shares are
   * skipped, so the partial-pressure plot does not drop to zero between two spectra, and a
   * second call at the same timestamp overwrites instead of duplicating.
   * @param {number} t
   */
  appendGasHistory(t) {
    if (!this.pressure.length) return;
    if (!STUDIO_GASES.some((g) => (this.latestGasPct[g] ?? 0) > 0)) return;
    const p = Math.max(this.lastPressureMbar ?? 0, 0);
    const last = this.gasPct[STUDIO_GASES[0]].last();
    if (last && Math.abs(last.t - t) < 1e-6) {
      for (const g of STUDIO_GASES) {
        const pct = this.latestGasPct[g] ?? 0;
        replaceLast(this.gasPct[g], pct);
        replaceLast(this.gasPartial[g], (p * pct) / 100);
      }
      return;
    }
    for (const g of STUDIO_GASES) {
      const pct = this.latestGasPct[g] ?? 0;
      const partial = (p * pct) / 100;
      const prev = this.gasPartial[g].last();
      const rate = prev ? (partial - prev.v) / Math.max((t - prev.t) / 1000, 1e-9) : 0;
      this.gasPct[g].push(t, pct);
      this.gasPartial[g].push(t, partial);
      this.gasRate[g].push(t, rate);
    }
  }

  /**
   * Pixel data from a SPEC, RoR or RGD record, normalised to a peak of 1 over the OPG550's
   * wavelength span (CSC `_ingest_live_spectrum`). All-zero payloads are ignored.
   * @param {ArrayLike<number>} pixels @param {{ command?: string, recordId?: number, integrationUs?: number, ignition?: number, t?: number }} [meta]
   * @returns {boolean}
   */
  ingestLiveSpectrum(pixels, meta = {}) {
    if (!pixels || pixels.length < 2) return false;
    let peak = -Infinity;
    for (let i = 0; i < pixels.length; i += 1) peak = Math.max(peak, Number(pixels[i]));
    if (!(peak > 0)) return false;
    const y = new Float64Array(pixels.length);
    for (let i = 0; i < pixels.length; i += 1) y[i] = Number(pixels[i]) / peak;
    const t = meta.t ?? this.now();
    /** @type {Spectrum} */
    const s = { x: linspace(WAVELENGTH_MIN_NM, WAVELENGTH_MAX_NM, y.length), y, t, source: "live", mode: SpectrumMode.AUTO, command: meta.command, recordId: meta.recordId, integrationUs: meta.integrationUs, ignition: meta.ignition };
    this.liveSpectrum = s;
    this.spectra.push(s);
    if (this.spectrumMode === SpectrumMode.AUTO) {
      if (this.lastPressureMbar != null) this.updateSpectrum(this.lastPressureMbar, this.lastPressureT ?? t);
      else {
        this.spectrum = s;
        this.identify(0);
        this.touch();
      }
    }
    return true;
  }

  /**
   * Any parsed reply for this OPG550 (terminal reads, studio reads, polled info). Mirrors CSC
   * `on_terminal_response`.
   * @param {string} command
   * @param {{ success: boolean, value?: any, unit?: string, formatted?: string, extra?: any, error?: string }} parsed
   * @param {number} [t]
   */
  ingestReply(command, parsed, t = this.now()) {
    if (!parsed) return;
    if (!parsed.success) {
      if (command === "error_status") this.errorText = parsed.error ?? "Decode failure";
      if (RECORD_COMMANDS.includes(command)) this.lastSpecRequestMs = -Infinity;
      this.touch();
      return;
    }
    const extra = parsed.extra ?? {};
    const text = parsed.formatted || (parsed.value != null ? String(parsed.value) : "");
    if (command === "software_version") this.identity.firmware = text;
    else if (command === "serial_number") this.identity.serial = text;
    else if (command === "bootloader_version") this.identity.bootloader = text;
    else if (command === "error_status") this.errorText = parsed.formatted || "OK";
    else if (command === "plasma_state") {
      this.plasma.text = parsed.formatted || String(parsed.value ?? "—");
      if (Number.isFinite(Number(parsed.value))) this.plasma.state = Math.trunc(Number(parsed.value));
      this.evaluatePlasma();
    } else if (command === "pressure" && parsed.value != null) {
      this.ingestPressure(Number(parsed.value), parsed.unit || "mbar", t);
    } else if (command in COUNT_RECORD && parsed.value != null) {
      this.recordCounts[COUNT_RECORD[command]] = Math.trunc(Number(parsed.value));
    } else if (command in STATE_RECORD && parsed.value != null) {
      this.algorithmStates[STATE_RECORD[command]] = { code: Number(parsed.value), label: parsed.formatted ?? String(parsed.value) };
    } else if (command === "analog_output_voltage" && parsed.value != null) {
      this.analogMv = Number(parsed.value);
    }
    if (RECORD_COMMANDS.includes(command) && extra.ignition_status != null) {
      // A record says whether the plasma was ignited when it was captured.
      const ignited = Boolean(extra.ignition_status);
      if (ignited && this.plasma.state !== 2) {
        this.plasma.state = 2;
        this.plasma.text = "Plasma ON and ignited (from the record header)";
      } else if (!ignited && this.plasma.state === 2) {
        this.plasma.state = 1;
        this.plasma.text = "Plasma ON, not ignited (from the record header)";
      }
    }
    if (Array.isArray(extra.pixel_data) && extra.pixel_data.length) {
      this.ingestLiveSpectrum(extra.pixel_data, { command, recordId: extra.record_id, integrationUs: extra.integration_us, ignition: extra.ignition_status, t });
    }
    if (command === "rgd_record" && Array.isArray(extra.partial_pressures) && extra.partial_pressures.length) {
      this.applyRgdPartials(extra.partial_pressures, extra.total_pressure_mbar, t);
    }
    if (command === "ror_record" && Number.isFinite(extra.pressure_rise_mtorr_per_min)) {
      const rise = Number(extra.pressure_rise_mtorr_per_min);
      this.gaugeRor.push(t, rise);
      this.gaugeRorText = { text: `RoR active; pressure rise ${formatG(rise, 4)} mTorr/min.`, t };
      this.modeStatus = this.gaugeRorText.text;
    }
    if (TELEMETRY_COMMANDS.includes(command)) {
      this.telemetry.set(command, parsed.formatted || (parsed.value != null ? `${formatG(Number(parsed.value), 6)}${parsed.unit ? ` ${parsed.unit}` : ""}` : "OK"));
    }
    this.touch();
  }

  /**
   * RGD partial pressures replace the identification shares (CSC `_apply_rgd_partial_pressures`).
   * @param {ArrayLike<number>} partials @param {number | undefined} totalMbar @param {number} t
   */
  applyRgdPartials(partials, totalMbar, t) {
    const pressure = Number.isFinite(totalMbar) ? Number(totalMbar) : this.lastPressureMbar ?? 0;
    const { pct, partialMap } = gasPercentFromRgd(partials, pressure);
    this.latestGasPct = pct;
    const shown = Object.entries(partialMap).slice(0, 5).map(([g, v]) => `${g} ${formatSci(v, 2)} mbar`);
    if (shown.length) this.moleculeText = `RGD partial pressures: ${shown.join(", ")}`;
    if (this.spectrum?.command === "rgd_record") this.rgdShares = { spectrum: this.spectrum, pct: { ...pct }, text: this.moleculeText };
    if (this.lastPressureMbar == null) this.lastPressureMbar = Math.max(pressure, 1e-30);
    this.appendGasHistory(this.pressure.last()?.t ?? t);
    this.touch();
  }

  /**
   * Re-evaluate the plasma thresholds (in mbar) against the latest pressure (CSC
   * `_evaluate_auto_plasma`). In "prompt" mode this raises or clears the prompt; in "auto" mode
   * it queues the action for the app (takeAutoAction). Never writes anything itself.
   */
  evaluatePlasma() {
    const nowMs = this.now();
    const p = this.plasma;
    if (p.mode === "off") {
      p.prompt = null;
      p.pending = null;
      return null;
    }
    if (p.mode === "auto") {
      p.prompt = null;
      if (p.pending) return p.pending;
      const verdict = evaluateAutoPlasma({ enabled: true, pressureMbar: this.lastPressureMbar, plasmaState: p.state, minMbar: p.minMbar, maxMbar: p.maxMbar, lastActionMs: p.lastActionMs, nowMs });
      if (!verdict || this.lastPressureMbar == null) return null;
      p.lastActionMs = nowMs;
      p.pending = { ...verdict, pressureMbar: this.lastPressureMbar, t: nowMs };
      return p.pending;
    }
    if (p.prompt) {
      // Drop a prompt whose condition no longer holds.
      const still = evaluateAutoPlasma({ enabled: true, pressureMbar: this.lastPressureMbar, plasmaState: p.state, minMbar: p.minMbar, maxMbar: p.maxMbar, lastActionMs: -Infinity, nowMs });
      if (!still || still.action !== p.prompt.action) p.prompt = null;
      else return p.prompt;
    }
    const verdict = evaluateAutoPlasma({ enabled: true, pressureMbar: this.lastPressureMbar, plasmaState: p.state, minMbar: p.minMbar, maxMbar: p.maxMbar, lastActionMs: p.lastActionMs, nowMs });
    if (!verdict || this.lastPressureMbar == null) return null;
    p.lastActionMs = nowMs;
    p.prompt = { ...verdict, pressureMbar: this.lastPressureMbar, t: nowMs };
    return p.prompt;
  }

  /** Record that the user acted on the plasma (sets the cooldown, clears the prompt). */
  notePlasmaAction() {
    this.plasma.lastActionMs = this.now();
    this.plasma.prompt = null;
    this.touch();
  }

  /** The user started an algorithm (spec_enable, ror_enable or rgd_enable). @param {string} enable */
  noteAlgorithmStarted(enable) {
    this.startedAlgorithm = enable;
    for (const k of Object.keys(this.recordCounts)) this.recordCounts[k] = null;
    this.lastSpecRequestMs = -Infinity;
    this.touch();
  }

  noteAlgorithmsStopped() {
    this.startedAlgorithm = null;
    this.touch();
  }

  /**
   * Whether the background acquisition should run now (CSC `_request_live_spec_if_due`):
   * only for Live Data, at most every 2 s. Marks the request time when it says yes.
   * @param {number} [nowMs]
   */
  acquisitionDue(nowMs = this.now()) {
    if (this.spectrumMode !== SpectrumMode.AUTO) return false;
    if (nowMs - this.lastSpecRequestMs < LIVE_SPEC_INTERVAL_MS) return false;
    this.lastSpecRequestMs = nowMs;
    return true;
  }

  /** @param {number} t @param {ExportSample["spectrum"]} spectrum */
  captureExportSample(t, spectrum) {
    if (this.lastPressureMbar == null) return;
    const s = this.spectrum;
    this.exportSamples.push({
      t,
      timeS: this.elapsedS(t),
      pressureMbar: this.lastPressureMbar,
      gasPct: { ...this.latestGasPct },
      spectrum,
      integrationMs: s?.integrationUs != null ? s.integrationUs / 1000 : null,
      analogMv: this.analogMv
    });
  }

  /** The spectrum an export sample refers to. @param {ExportSample} sample */
  spectrumOf(sample) {
    if (typeof sample.spectrum === "number") return this.spectra[sample.spectrum] ?? null;
    const r = sample.spectrum;
    const y = Float64Array.from(simulateOpticalSpectrum(r.pressureMbar, r.trend, r.elapsedS, r.mode, { wavelengthMinNm: WAVELENGTH_MIN_NM, wavelengthMaxNm: WAVELENGTH_MAX_NM, samples: SPECTRUM_SAMPLES }));
    return { x: linspace(WAVELENGTH_MIN_NM, WAVELENGTH_MAX_NM, y.length), y };
  }
}

/** @type {Readonly<Record<string, string>>} */
const COUNT_RECORD = Object.freeze({ spec_record_count: "spec_record", ror_record_count: "ror_record", rgd_record_count: "rgd_record" });
/** @type {Readonly<Record<string, string>>} */
const STATE_RECORD = Object.freeze({ spec_state: "spec_record", ror_state: "ror_record", rgd_state: "rgd_record" });

/** Overwrite the newest value of a series in place. @param {Series} s @param {number} v */
function replaceLast(s, v) {
  if (!s.length) return;
  s.v[s.length - 1] = v;
  s.version += 1;
}
