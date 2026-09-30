// @ts-check
/**
 * Simulated gauge response: what a given gauge would report for the engine's true
 * pressure. Port of the non-Qt logic of CSC src/serial_comm/simulated_worker.py
 * (`_apply_response_model`, `_model_*`, `_apply_sensor_dynamics`,
 * `_resolve_cdg_full_scale_mbar`); the QThread loop, fake terminal frames and signals are
 * replaced by the protocol emulators in ./emulators.
 *
 *   PIRANI        true * gas factor, clamped to the spec range; over max -> 9.9e9 sentinel
 *   CDG           gas independent; floored at 0.05 % FS, clamped at FS
 *   COLD_CATHODE  log-normal noise inside 1e-10..1e-2 mbar; 9.9e9 above, 0 below
 *   COMBINATION   per command ("pirani…", "cc…") or blended across the crossover band
 *   OPG550        combination plus a banded relative-accuracy envelope
 *   VGC           pass-through, clamped to the spec range, no noise
 *
 * Every response also carries a status word: "OR" (over range), "UR" (under range) or
 * null. CSC only has the sentinel values; the status word is added here so emulators can
 * set their error bits without testing sentinels.
 */
import {
  GaugeFamily,
  PIRANI_GAS_FACTOR,
  cdgFullScaleOptions,
  classifyFamily,
  createRng,
  getSimulationSpec,
  resolveModelAlias
} from "./models.js";

/** Cold-cathode valid range, mbar; outside it the gauge clamps and flags (CSC `_CC_*`). */
export const CC_LOWER_MBAR = 1e-10;
export const CC_UPPER_MBAR = 1e-2;
/** Value reported when a gauge is driven over range. */
export const OVERRANGE_SENTINEL = 9.9e9;
/** Value a cold cathode reports under range. */
export const UNDERRANGE_SENTINEL = 0.0;
/** Log10-space noise sigma for cold cathodes. 🟠 CSC's comment says "±5 % log-space"; 0.05 decades is about ±12 % at 1 sigma. */
export const CC_LOG_NOISE_SIGMA = 0.05;

/** @typedef {"OR" | "UR" | null} RangeStatus */
/** @typedef {{ value: number, status: RangeStatus }} GaugeResponse */

/** @param {number} value @param {RangeStatus} [status] @returns {GaugeResponse} */
const resp = (value, status = null) => ({ value, status });

/**
 * Sub-sensor selected by a command name, as CSC matches substrings.
 * 🟠 CSC's substring test also matches unrelated names: "ion" is in "combination" and
 * "calibration", "cc" is in "accuracy". Kept for parity.
 * @param {string} command
 * @param {readonly string[]} ionTokens
 * @returns {"pirani" | "cc" | null}
 */
function subSensor(command, ionTokens) {
  const lc = command.toLowerCase();
  if (lc.includes("pirani") || lc.includes("thermal")) return "pirani";
  if (ionTokens.some((k) => lc.includes(k))) return "cc";
  return null;
}

/**
 * @param {{
 *   model?: string,              CSC model name ("CDG045D", "PSG550", "BCG450", ...); `type` is an alias
 *   type?: string,
 *   fullScaleMbar?: number,      CDG only; default: CSC's per-model option table, index 2
 *   rng?: import("./models.js").Rng,
 *   seed?: number | string,      used when no rng is given
 *   calBiasRel?: number,         fixed per-sensor calibration bias; default drawn from the rng
 * }} options
 */
export function createSimulatedGauge(options) {
  const model = String(options.model ?? options.type ?? "PSG550").trim().toUpperCase();
  const family = classifyFamily(model);
  const spec = getSimulationSpec(model);
  const isOpg = resolveModelAlias(model) === "OPG550";
  const rng = options.rng ?? createRng(options.seed ?? model);
  // Fixed per-sensor calibration-like bias for realism (CSC `_cal_bias_rel`).
  let calBiasRel = options.calBiasRel ?? rng.gauss(0.0, spec.accuracyRel / 3.0);
  const fullScaleMbar = resolveCdgFullScale();

  /** @type {number | null} */
  let lastModelled = null;
  /** @type {number | null} */
  let lastEmitT = null;

  /** CSC `_resolve_cdg_full_scale_mbar` without the YAML fallbacks (no DeviceSpec here). */
  function resolveCdgFullScale() {
    if (family !== GaugeFamily.CDG) return spec.maxMbar;
    if (options.fullScaleMbar != null) return Math.max(Number(options.fullScaleMbar), 1e-9);
    // 🟠 CSC's comment says "the first 1 mbar / 1 Torr-range option (index 2)", but for
    // CDG045D index 2 is the 0.25 mbar head (it is 1 mbar for CDG025D). Kept for parity.
    const table = cdgFullScaleOptions(model);
    const opt = table[Math.min(2, table.length - 1)];
    return opt ? Math.max(opt.mbar, 1e-9) : 1.333;
  }

  /** @param {number} real @param {string} gas @returns {GaugeResponse} */
  function modelPirani(real, gas) {
    const factor = PIRANI_GAS_FACTOR[/** @type {keyof typeof PIRANI_GAS_FACTOR} */ (gas)] ?? 1.0;
    const pressure = real * factor;
    if (pressure > spec.maxMbar) return resp(OVERRANGE_SENTINEL, "OR");
    if (pressure < spec.minMbar) return resp(spec.minMbar, "UR");
    const noise = rng.gauss(0.0, spec.repeatabilityRel / 3.0);
    const val = pressure * (1.0 + calBiasRel + noise);
    return resp(Math.max(Math.min(val, spec.maxMbar), spec.minMbar));
  }

  /**
   * CDG: gas-type independent by construction (the gas never enters this function).
   * 🟠 CSC re-draws its "bias" on every call, so it is extra noise rather than a fixed
   * calibration offset, and the CDG ignores calBiasRel. Kept for parity.
   * @param {number} real
   * @returns {GaugeResponse}
   */
  function modelCdg(real) {
    const fs = Math.max(fullScaleMbar, 1e-9);
    // CDG minimum reading: 0.05 % of full scale (CSC: "per INFICON specs").
    const cdgMin = fs * 0.5e-3;
    const p = Math.max(real, cdgMin);

    // The first two decades below FS keep nominal accuracy; below that the log-linear
    // output and sensor nonlinearity degrade it.
    let accAbs = fs * spec.accuracyRel;
    const twoDecFloor = fs / 100.0;
    if (p < twoDecFloor) accAbs *= 1.0 + 1.0 * Math.log10(twoDecFloor / p);

    const repAbs = fs * spec.repeatabilityRel;
    // Bound absolute noise to ±1.5x the minimum detectable pressure so the bottom of the
    // range does not jump by decades.
    const maxNoiseAbs = cdgMin * 1.5;
    const bias = Math.max(-maxNoiseAbs, Math.min(maxNoiseAbs, rng.gauss(0.0, accAbs / 3.0)));
    const noise = Math.max(-maxNoiseAbs, Math.min(maxNoiseAbs, rng.gauss(0.0, repAbs / 3.0)));
    const value = Math.max(Math.min(p + bias + noise, fs), 0.0);
    // Status is not in CSC: over FS the reading is pinned at FS, under 0.05 % FS it is floored.
    const status = real > fs ? "OR" : real < cdgMin ? "UR" : null;
    return resp(value, status);
  }

  /** @param {number} real @returns {GaugeResponse} */
  function modelColdCathode(real) {
    const lower = Math.max(CC_LOWER_MBAR, spec.minMbar);
    const upper = Math.min(CC_UPPER_MBAR, spec.maxMbar);
    if (real > upper) return resp(OVERRANGE_SENTINEL, "OR");
    if (real < lower) return resp(UNDERRANGE_SENTINEL, "UR");
    const logP = Math.log10(Math.max(real, 1e-30));
    return resp(10 ** (logP + rng.gauss(0.0, CC_LOG_NOISE_SIGMA)));
  }

  /**
   * Weighted Pirani / cold-cathode blend across the crossover band, shared by the
   * combination and OPG550 branches of CSC.
   * @param {number} real @param {string} gas @param {number} lo @param {number} hi
   * @returns {GaugeResponse}
   */
  function blend(real, gas, lo, hi) {
    if (real >= hi) return modelPirani(real, gas);
    if (real <= lo) return modelColdCathode(real);
    const frac = (real - lo) / Math.max(hi - lo, 1e-12);
    const pirani = modelPirani(real, gas);
    const cc = modelColdCathode(real);
    if (cc.value <= 0.0 || cc.value >= OVERRANGE_SENTINEL) return pirani;
    return resp(cc.value * (1.0 - frac) + pirani.value * frac);
  }

  /** CSC `_opg550_accuracy_rel`: piecewise relative-accuracy envelope. @param {number} p */
  function opgAccuracyRel(p) {
    const x = Math.max(p, 1e-12);
    if (x >= 100.0) return 0.005;
    if (x >= 2.0) return 0.01;
    if (x >= 1e-4) return 0.05;
    if (x >= 1e-5) return 0.25;
    return 0.45;
  }

  /** CSC `_apply_relative_accuracy`: bounded bias/noise inside the accuracy band. @param {number} reading @param {number} relAccuracy */
  function applyRelativeAccuracy(reading, relAccuracy) {
    if (reading <= 0.0) return reading;
    const repeatRel = Math.min(spec.repeatabilityRel, relAccuracy * 0.5);
    const bias = rng.gauss(0.0, relAccuracy / 3.0);
    const noise = rng.gauss(0.0, repeatRel / 3.0);
    const adjusted = reading * (1.0 + 0.35 * calBiasRel + bias + noise);
    return Math.max(Math.min(adjusted, spec.maxMbar), spec.minMbar);
  }

  /** CSC `_model_opg550_combination`. @param {number} real @param {string} gas @param {string} command @returns {GaugeResponse} */
  function modelOpg(real, gas, command) {
    const sensor = subSensor(command, ["ion", "cold", "cc", "cath"]);
    const base =
      sensor === "pirani"
        ? modelPirani(real, gas)
        : sensor === "cc"
          ? modelColdCathode(real)
          : blend(real, gas, spec.blendLowMbar || 7e-4, spec.blendHighMbar || 2e-3);
    if (base.value <= 0.0 || base.value >= OVERRANGE_SENTINEL) return base;
    return resp(applyRelativeAccuracy(base.value, opgAccuracyRel(Math.max(real, 1e-12))), base.status);
  }

  /**
   * CSC `_apply_response_model`: the value this gauge reports for true pressure `real`.
   * @param {number} real      mbar
   * @param {string} gas       GasType
   * @param {string} [command] command name; selects the sub-sensor of combination gauges
   * @returns {GaugeResponse}
   */
  function respond(real, gas, command = "pressure") {
    if (isOpg) return modelOpg(real, gas, command);

    let fam = family;
    if (fam === GaugeFamily.COMBINATION) {
      const sensor = subSensor(command, ["ion", "cold", "cc", "bag", "cath"]);
      if (sensor === "pirani") fam = GaugeFamily.PIRANI;
      else if (sensor === "cc") fam = GaugeFamily.COLD_CATHODE;
      else return blend(real, gas, spec.blendLowMbar || 6e-4, spec.blendHighMbar || 2e-3);
    }
    if (fam === GaugeFamily.PIRANI) return modelPirani(real, gas);
    if (fam === GaugeFamily.CDG) return modelCdg(real);
    if (fam === GaugeFamily.COLD_CATHODE) return modelColdCathode(real);

    // VGC controllers and unknown families: pass-through, no noise.
    const value = Math.max(Math.min(real, spec.maxMbar), spec.minMbar);
    return resp(value, real > spec.maxMbar ? "OR" : real < spec.minMbar ? "UR" : null);
  }

  /**
   * First-order lag so readings move like real sensors (CSC `_apply_sensor_dynamics`).
   * `t` is simulation time in seconds. As in CSC, dt <= 0 snaps to the target.
   * 🟠 CSC also lags into and out of the 9.9e9 / 0 sentinels, which yields meaningless
   * readings such as 5e9 mbar for seconds after a cold cathode comes into range. Here the
   * lag is bypassed whenever the target or the previous value is a sentinel.
   * @param {number} target
   * @param {number} t
   */
  function applyDynamics(target, t) {
    if (lastModelled === null || isSentinel(target) || isSentinel(lastModelled)) {
      lastModelled = target;
      lastEmitT = t;
      return target;
    }
    const dt = lastEmitT === null ? 0.0 : Math.max(0.0, t - lastEmitT);
    lastEmitT = t;
    const tau = Math.max(spec.responseTauS, 0.02);
    const alpha = dt > 0.0 ? 1.0 - Math.exp(-dt / tau) : 1.0;
    lastModelled += alpha * (target - lastModelled);
    return lastModelled;
  }

  return {
    model,
    family,
    spec,
    fullScaleMbar,
    respond,
    applyDynamics,
    /** Test hook, like CSC tests overwriting `_cal_bias_rel`. @param {number} v */
    setCalBias(v) {
      calBiasRel = v;
    },
    resetDynamics() {
      lastModelled = null;
      lastEmitT = null;
    }
  };
}

/** @param {number} v */
function isSentinel(v) {
  return v <= UNDERRANGE_SENTINEL || v >= OVERRANGE_SENTINEL;
}

/** @typedef {ReturnType<typeof createSimulatedGauge>} SimulatedGauge */
