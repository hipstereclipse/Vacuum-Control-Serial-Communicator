// @ts-check
/**
 * Simulation engine: the shared "real pressure" clock for all simulated gauges.
 * Port of CSC src/serial_comm/simulation_engine.py.
 *
 * Each simulated gauge reads `currentRealPressure()` and applies its own response model
 * (simulated-gauge.js). All pressures are mbar.
 *
 * Time model: CSC measures elapsed time from `time.monotonic()` minus paused time. Here
 * the clock is virtual and only moves when `advance(dt)` is called (the facade calls it
 * from `step()` or its own interval), which makes the engine deterministic in tests and
 * lets readers sample it any number of times without moving time. Pause/resume/restart
 * keep CSC's semantics: advance() is ignored while paused, restart() returns to t = 0.
 * There is no lock: JS is single-threaded, so CSC's threading.Lock has no counterpart.
 */
import { HUMIDITY_TIME_FACTOR, HumidityLevel, GasType, SimulationPattern, normalizeGas, normalizeHumidity, normalizePattern } from "./models.js";

/** Atmospheric start pressure for PUMPDOWN, mbar. */
export const P_ATM_MBAR = 1013.0;

/** Default chamber volume (litres) used by the leak-rate model. */
export const DEFAULT_VOLUME_L = 10.0;

// Staged pumpdown time constants at LOW humidity for a typical 10 L chamber.
// Stage 1: roughing pump, atm -> 1..10 Torr (turbo spin-up threshold)
// Stage 2: turbo, crossover -> deep vacuum
// Stage 3: molecular flow, where conductance limits effective speed
const ROUGHING_TAU_S = 9.0;
const TURBO_TAU_S = 3.8;
const MOLECULAR_TAU_S = 18.0;
const CROSSOVER_MBAR = 13.0; // 10 Torr (turbo enable threshold)
const MOLECULAR_TRANSITION_MBAR = 3e-6;

// Moisture-loaded surfaces outgas after pump start: a long tail most visible at
// medium/high humidity.
const OUTGASSING_TAU_S = /** @type {Record<string, number>} */ ({ LOW: 180.0, MEDIUM: 240.0, HIGH: 320.0 });
const OUTGASSING_START_FRACTION = /** @type {Record<string, number>} */ ({ LOW: 2e-9, MEDIUM: 8e-9, HIGH: 3e-8 });

/**
 * Interpolate between two pressures (CSC `_interpolate`). "exponential" interpolates in
 * log space and needs both endpoints > 0; otherwise it falls back to linear.
 * @param {number} a
 * @param {number} b
 * @param {number} frac  0..1
 * @param {string} mode  "linear" | "exponential" | "flat"
 */
export function interpolate(a, b, frac, mode) {
  if (mode === "flat") return a;
  if (mode === "exponential" && a > 0 && b > 0) return a * (b / a) ** frac;
  return a + (b - a) * frac;
}

/**
 * Staged pumpdown: roughing, turbo, then a molecular-flow tail, floored by humidity-driven
 * outgassing and the base pressure (CSC `_pumpdown_locked`).
 * @param {number} t  seconds since pump start
 * @param {{ basePressureMbar: number, humidity?: string }} p
 */
export function pumpdownPressure(t, { basePressureMbar: base, humidity = HumidityLevel.MEDIUM }) {
  if (base >= P_ATM_MBAR) return base;

  const h = HUMIDITY_TIME_FACTOR[/** @type {keyof typeof HUMIDITY_TIME_FACTOR} */ (humidity)] ?? 1.0;
  const tau1 = ROUGHING_TAU_S * h;
  const tauTurbo = TURBO_TAU_S * h;
  const tauMol = MOLECULAR_TAU_S * h;

  // Stage 1: roughing decay
  const pRough = P_ATM_MBAR * Math.exp(-t / tau1);
  // When roughing reaches the crossover, stage 2 begins.
  const tCross = P_ATM_MBAR > CROSSOVER_MBAR ? tau1 * Math.log(P_ATM_MBAR / CROSSOVER_MBAR) : 0.0;
  if (t <= tCross) return Math.max(pRough, base); // high-vac pump not yet effective

  // Stage 2: turbo dominates down to the molecular-flow threshold.
  const t2 = t - tCross;
  const pTurbo = CROSSOVER_MBAR * Math.exp(-t2 / tauTurbo);
  const tMol = CROSSOVER_MBAR > MOLECULAR_TRANSITION_MBAR ? tauTurbo * Math.log(CROSSOVER_MBAR / MOLECULAR_TRANSITION_MBAR) : 0.0;

  // Stage 3: deep-vacuum molecular regime slows further decay.
  const pFlowLimited = t2 <= tMol ? pTurbo : MOLECULAR_TRANSITION_MBAR * Math.exp(-(t2 - tMol) / tauMol);

  // 🟠 CSC's fallbacks for an unknown humidity (780 s, 0.03) are far from the table values;
  // unreachable once humidity is normalised, kept for parity.
  const outTau = OUTGASSING_TAU_S[humidity] ?? 780.0;
  const outFrac = OUTGASSING_START_FRACTION[humidity] ?? 0.03;
  const pOut = P_ATM_MBAR * outFrac * Math.exp(-t / outTau);

  // After crossover, roughing no longer governs chamber pressure.
  const pressure = Math.max(pFlowLimited, pOut, base);
  // Clamp to base once close enough.
  return pressure <= base * 1.0001 ? base : pressure;
}

/**
 * Linear rise: P(t) = base + leak_rate * t / volume (CSC `_leak_locked`).
 * @param {number} t
 * @param {{ basePressureMbar: number, leakRateMbarLS: number, volumeL: number }} p
 */
export function leakPressure(t, { basePressureMbar, leakRateMbarLS, volumeL }) {
  return basePressureMbar + (leakRateMbarLS * t) / volumeL;
}

/**
 * Position inside a recipe: the step that covers `t` and the fraction through it
 * (shared walk of CSC `_custom_locked` and `_current_step_locked`).
 * @param {number} t
 * @param {import("./models.js").RecipeStep[]} steps  non-empty, positive total duration
 * @param {boolean} loop
 */
function locate(t, steps, loop) {
  const total = steps.reduce((sum, s) => sum + s.durationS, 0);
  // Python's % is a floored modulo; t >= 0 so JS % matches.
  const tMod = loop ? t % total : Math.min(t, total);
  let cursor = 0.0;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (tMod <= cursor + step.durationS || i === steps.length - 1) {
      const frac = step.durationS <= 0 ? 0.0 : (tMod - cursor) / step.durationS;
      return { index: i, frac: Math.max(0.0, Math.min(1.0, frac)) };
    }
    cursor += step.durationS;
  }
  return { index: steps.length - 1, frac: 1.0 };
}

/**
 * Piecewise interpolation across recipe steps (CSC `_custom_locked`).
 * 🟠 With looping on (CSC's only mode) the pressure jumps from the last step's end back
 * to the first step's start at every cycle, e.g. from 1e-5 to 1013 mbar.
 * @param {number} t
 * @param {import("./models.js").RecipeStep[]} steps
 * @param {{ loop?: boolean, basePressureMbar?: number }} [options]
 */
export function customPressure(t, steps, { loop = true, basePressureMbar = 1e-6 } = {}) {
  if (!steps.length) return basePressureMbar;
  const total = steps.reduce((sum, s) => sum + s.durationS, 0);
  if (total <= 0) return steps[0].startPressureMbar;
  const { index, frac } = locate(t, steps, loop);
  const step = steps[index];
  return interpolate(step.startPressureMbar, step.endPressureMbar, frac, step.interpolation);
}

/**
 * @typedef {Object} EngineSnapshot   CSC `snapshot()` (camelCase)
 * @property {string} pattern
 * @property {string} gas
 * @property {string} humidity
 * @property {number} pressureMbar
 * @property {number} elapsedS
 * @property {boolean} paused
 * @property {number} basePressureMbar
 * @property {number} leakRateMbarLS
 * @property {number} volumeL
 * @property {import("./models.js").RecipeStep[]} recipeSteps
 * @property {number} currentStepIndex     -1 unless CUSTOM with steps
 * @property {number} currentStepFraction
 * @property {number} registeredCount
 */

/**
 * Create an engine (CSC `SimulationEngine`; the process-wide singleton `get_engine` is
 * replaced by the facade owning one engine per simulation).
 */
export function createSimulationEngine() {
  let pattern = SimulationPattern.PUMPDOWN;
  let basePressureMbar = 1e-6;
  let leakRateMbarLS = 0.0;
  let volumeL = DEFAULT_VOLUME_L;
  /** @type {import("./models.js").RecipeStep[]} */
  let recipeSteps = [];
  const loopCustom = true;
  let gas = GasType.N2;
  let humidity = HumidityLevel.MEDIUM;
  let elapsed = 0.0;
  let paused = false;
  /** @type {Map<string, import("./models.js").SimulatedGaugeConfig>} */
  const registeredConfigs = new Map();

  /** Pressure at virtual time `t` under the current parameters (CSC `_compute_pressure_locked`). @param {number} t */
  function pressureAt(t) {
    switch (pattern) {
      case SimulationPattern.PUMPDOWN:
        return pumpdownPressure(t, { basePressureMbar, humidity });
      case SimulationPattern.LEAK:
        return leakPressure(t, { basePressureMbar, leakRateMbarLS, volumeL });
      case SimulationPattern.ARGON_ENVIRONMENT:
        // 🟠 CSC's ARGON_ENVIRONMENT is only a flat base pressure; it does not switch the
        // gas to argon (the gas is a separate input). Kept for parity.
        return basePressureMbar;
      case SimulationPattern.CUSTOM:
        return customPressure(t, recipeSteps, { loop: loopCustom, basePressureMbar });
      default:
        return basePressureMbar; // defensive
    }
  }

  /** CSC `_current_step_locked`. @param {number} t */
  function currentStep(t) {
    if (pattern !== SimulationPattern.CUSTOM || !recipeSteps.length) return { index: -1, frac: 0.0 };
    const total = recipeSteps.reduce((sum, s) => sum + s.durationS, 0);
    if (total <= 0) return { index: 0, frac: 0.0 };
    return locate(t, recipeSteps, loopCustom);
  }

  function restart() {
    elapsed = 0.0;
    paused = false;
  }

  return {
    /**
     * Switch the active pattern and optionally its parameters. `resetClock` (default true)
     * restarts at t = 0; false continues the virtual timeline.
     * @param {string} newPattern
     * @param {{ basePressureMbar?: number, leakRateMbarLS?: number, recipeSteps?: import("./models.js").RecipeStep[], resetClock?: boolean }} [params]
     */
    setPattern(newPattern, params = {}) {
      pattern = normalizePattern(newPattern);
      if (params.basePressureMbar != null) basePressureMbar = Math.max(Number(params.basePressureMbar), 1e-12);
      if (params.leakRateMbarLS != null) leakRateMbarLS = Number(params.leakRateMbarLS);
      if (params.recipeSteps != null) recipeSteps = [...params.recipeSteps];
      if (params.resetClock ?? true) restart();
    },
    /** Replace the CUSTOM recipe; no effect on other patterns. @param {import("./models.js").RecipeStep[]} steps */
    setRecipeSteps(steps) {
      recipeSteps = [...steps];
    },
    /** @param {number} mbar */
    setBasePressure(mbar) {
      basePressureMbar = Math.max(Number(mbar), 1e-12);
    },
    /** @param {number} mbarLS */
    setLeakRate(mbarLS) {
      leakRateMbarLS = Number(mbarLS);
    },
    /** @param {string} g */
    setGas(g) {
      gas = normalizeGas(g);
    },
    /** @param {number} litres */
    setVolume(litres) {
      volumeL = Math.max(Number(litres), 1e-6);
    },
    /** @param {string} level */
    setHumidity(level) {
      humidity = normalizeHumidity(level);
    },
    currentHumidity: () => humidity,
    currentGas: () => gas,
    currentPattern: () => pattern,

    // Clock control
    restart,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    isPaused: () => paused,
    /** Move the virtual clock forward; ignored while paused. @param {number} dtSeconds */
    advance(dtSeconds) {
      if (!paused && Number.isFinite(dtSeconds) && dtSeconds > 0) elapsed += dtSeconds;
    },
    elapsed: () => elapsed,

    // Registration (UI listing / cap enforcement)
    /** @param {import("./models.js").SimulatedGaugeConfig} config */
    register(config) {
      registeredConfigs.set(config.simId, config);
    },
    /** @param {string} simId */
    unregister(simId) {
      registeredConfigs.delete(simId);
    },
    registered: () => [...registeredConfigs.values()],
    count: () => registeredConfigs.size,

    /** Shared true pressure (mbar) at the current virtual time. */
    currentRealPressure: () => pressureAt(elapsed),
    pressureAt,

    /** @returns {EngineSnapshot} */
    snapshot() {
      const step = currentStep(elapsed);
      return {
        pattern,
        gas,
        humidity,
        pressureMbar: pressureAt(elapsed),
        elapsedS: elapsed,
        paused,
        basePressureMbar,
        leakRateMbarLS,
        volumeL,
        recipeSteps: [...recipeSteps],
        currentStepIndex: step.index,
        currentStepFraction: step.frac,
        registeredCount: registeredConfigs.size
      };
    }
  };
}

/** @typedef {ReturnType<typeof createSimulationEngine>} SimulationEngine */
