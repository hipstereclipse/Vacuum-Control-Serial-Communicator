// @ts-check
/**
 * Simulation facade used by the UI and the protocol emulators.
 *
 *   const sim = createSimulation({ scenario: "pumpdown", gas: "N2", seed: 1 });
 *   const cdg = sim.gauge({ type: "CDG045D", fullScaleMbar: 13.332 });
 *   createCdgEmulator({ pressure: cdg.pressure, errorByte: () => (cdg.status() === "OR" ? 0x02 : 0) });
 *   sim.start();                           // or sim.step(dt) in tests
 *
 * One simulation owns one engine (CSC's process-wide singleton, simulation_engine.py
 * `get_engine`) and any number of gauges reading it (CSC SimulatedGaugeWorker, one per
 * gauge). Time only moves in step() / start(); gauge.pressure() never advances it.
 *
 * Reading cache: a gauge computes one sample per (simulation time, input revision) and
 * returns it for every call until time moves or an input changes, so any number of
 * emulator requests between two steps get the same value and draw no extra random
 * numbers. 🟠 CSC instead draws a fresh noisy sample on every poll and, when polled twice
 * in the same instant, snaps its lag filter to that sample.
 */
import { createSimulationEngine } from "./engine.js";
import { createRng, normalizeGas, normalizeHumidity, normalizePattern, simulatedGaugeConfig } from "./models.js";
import { listScenarios, scenarioByKey } from "./scenarios.js";
import { OPG_ANALYSIS_MAX_PRESSURE_MBAR, identifyOpticalSpecies, normalizeSpectrumMode, simulateOpticalSpectrum } from "./opg-spectrum.js";
import { createSimulatedGauge } from "./simulated-gauge.js";

export { listScenarios } from "./scenarios.js";
export { SimulationPattern, GasType, HumidityLevel, GaugeFamily } from "./models.js";
export { SpectrumMode } from "./opg-spectrum.js";
export { OVERRANGE_SENTINEL, UNDERRANGE_SENTINEL } from "./simulated-gauge.js";

/**
 * @typedef {Object} SimulationInputs
 * @property {string=} scenario        CSC scenario key or alias (see scenarios.js); applied first
 * @property {string=} pattern         PUMPDOWN | LEAK | ARGON_ENVIRONMENT | CUSTOM (overrides the scenario's)
 * @property {number=} baseMbar        base pressure, mbar
 * @property {number=} leakRate        mbar·L/s (LEAK pattern)
 * @property {string=} gas             N2 | AR | HE | CO2 (case-insensitive, "argon" etc. accepted)
 * @property {string=} humidity        LOW | MEDIUM | HIGH
 * @property {number=} volumeL         chamber volume for the leak model, litres
 * @property {import("./models.js").RecipeStep[]=} recipeSteps   CUSTOM recipe
 * @property {boolean=} resetClock     scenario/pattern changes restart at t = 0 unless false
 *
 * @typedef {Object} SimulationState
 * @property {string | null} scenario
 * @property {string} pattern
 * @property {string} gas
 * @property {string} humidity
 * @property {number} pressureMbar     true chamber pressure
 * @property {number} elapsedS         simulation time
 * @property {number} trendMbarPerS    change over the last step
 * @property {boolean} paused
 * @property {boolean} running         start() timer active
 * @property {number} basePressureMbar
 * @property {number} leakRateMbarLS
 * @property {number} volumeL
 * @property {import("./models.js").RecipeStep[]} recipeSteps
 * @property {number} currentStepIndex
 * @property {number} currentStepFraction
 * @property {number} registeredCount
 *
 * @typedef {Object} SimGauge
 * @property {string} id
 * @property {string} model
 * @property {string} family
 * @property {number} fullScaleMbar                 CDG full scale; spec maximum for other families
 * @property {() => number} pressure                mbar as the gauge would report (lagged primary reading)
 * @property {() => ("OR" | "UR" | null)} status     range status of the same sample
 * @property {(command: string) => { value: number, status: ("OR" | "UR" | null) }} read   un-lagged sub-sensor read, e.g. "pirani_pressure", "cc_pressure"
 * @property {() => void} remove
 */

const now = () => globalThis.performance?.now?.() ?? Date.now();

/**
 * @param {SimulationInputs & {
 *   seed?: number | string,     default 1; every random draw derives from it
 *   intervalMs?: number,        start() tick, default 100
 *   speed?: number,             simulated seconds per wall-clock second in start(), default 1
 * }} [options]
 */
export function createSimulation(options = {}) {
  const seed = options.seed ?? 1;
  const intervalMs = Math.max(10, Number(options.intervalMs ?? 100));
  let speed = Number(options.speed ?? 1);
  const engine = createSimulationEngine();
  /** @type {string | null} */
  let scenarioKey = null;
  let revision = 0; // bumps on every input change, invalidating gauge caches
  let trend = 0;
  let gaugeCount = 0;
  /** @type {any} */
  let timer = null;
  let lastTick = 0;
  /** @type {Set<(state: SimulationState) => void>} */
  const listeners = new Set();

  /** @param {SimulationInputs} inputs */
  function setInputs(inputs = {}) {
    const resetClock = inputs.resetClock ?? true;
    if (inputs.scenario != null) {
      const s = scenarioByKey(inputs.scenario);
      if (!s) throw new Error(`Unknown scenario '${inputs.scenario}'. Known: ${listScenarios().map((r) => r.id).join(", ")}`);
      scenarioKey = s.key;
      engine.setHumidity(s.humidity);
      engine.setGas(s.gas);
      engine.setPattern(s.pattern, {
        basePressureMbar: s.basePressureMbar,
        leakRateMbarLS: s.leakRateMbarLS,
        recipeSteps: s.recipeSteps.length ? [...s.recipeSteps] : undefined,
        resetClock
      });
    }
    if (inputs.pattern != null) {
      // With a scenario in the same call the clock was already reset by the scenario.
      engine.setPattern(normalizePattern(inputs.pattern), { resetClock: inputs.scenario == null && resetClock });
    }
    if (inputs.recipeSteps != null) engine.setRecipeSteps(inputs.recipeSteps);
    if (inputs.baseMbar != null) engine.setBasePressure(inputs.baseMbar);
    if (inputs.leakRate != null) engine.setLeakRate(inputs.leakRate);
    if (inputs.gas != null) engine.setGas(normalizeGas(inputs.gas));
    if (inputs.humidity != null) engine.setHumidity(normalizeHumidity(inputs.humidity));
    if (inputs.volumeL != null) engine.setVolume(inputs.volumeL);
    revision += 1;
  }

  /** @returns {SimulationState} */
  function state() {
    return { ...engine.snapshot(), scenario: scenarioKey, trendMbarPerS: trend, running: timer !== null };
  }

  /** Advance simulation time by `dtSeconds` (ignored while paused). @param {number} dtSeconds */
  function step(dtSeconds) {
    if (!(dtSeconds > 0) || engine.isPaused()) return;
    const p0 = engine.currentRealPressure();
    engine.advance(dtSeconds);
    trend = (engine.currentRealPressure() - p0) / dtSeconds;
    if (listeners.size) {
      const s = state();
      for (const fn of listeners) fn(s);
    }
  }

  /**
   * Attach a simulated gauge.
   * @param {{ type?: string, model?: string, fullScaleMbar?: number, lag?: boolean, id?: string }} spec
   * @returns {SimGauge}
   */
  function gauge(spec = {}) {
    const model = String(spec.type ?? spec.model ?? "PSG550");
    const ordinal = gaugeCount++;
    // Each gauge has its own stream so adding a gauge never changes another's readings.
    const g = createSimulatedGauge({ model, fullScaleMbar: spec.fullScaleMbar, rng: createRng(`${seed}|${ordinal}|${model.toUpperCase()}`) });
    const lag = spec.lag ?? true;
    const config = simulatedGaugeConfig({ model: g.model, simId: spec.id, cdgFullScaleMbar: g.family === "CDG" ? g.fullScaleMbar : null });
    engine.register(config);

    let cacheT = NaN;
    let cacheRev = -1;
    /** @type {{ value: number, status: ("OR" | "UR" | null) }} */
    let cached = { value: NaN, status: null };
    /** @type {Map<string, { t: number, rev: number, r: { value: number, status: ("OR" | "UR" | null) } }>} */
    const subCache = new Map();

    function sample() {
      const t = engine.elapsed();
      if (t === cacheT && revision === cacheRev) return cached;
      const r = g.respond(engine.currentRealPressure(), engine.currentGas(), "pressure");
      cached = { value: lag ? g.applyDynamics(r.value, t) : r.value, status: r.status };
      cacheT = t;
      cacheRev = revision;
      return cached;
    }

    return {
      id: config.simId,
      model: g.model,
      family: g.family,
      fullScaleMbar: g.fullScaleMbar,
      pressure: () => sample().value,
      status: () => sample().status,
      read(command) {
        const t = engine.elapsed();
        const hit = subCache.get(command);
        if (hit && hit.t === t && hit.rev === revision) return hit.r;
        const r = g.respond(engine.currentRealPressure(), engine.currentGas(), command);
        subCache.set(command, { t, rev: revision, r });
        return r;
      },
      remove: () => engine.unregister(config.simId)
    };
  }

  /**
   * Synthetic OPG550 spectrum for the current state (opg-spectrum.js), with species
   * identification when the pressure is low enough for it to be meaningful.
   * @param {{ mode?: string, wavelengthMinNm?: number, wavelengthMaxNm?: number, samples?: number, topK?: number }} [opts]
   */
  function spectrum(opts = {}) {
    const mode = normalizeSpectrumMode(opts.mode ?? "AUTO");
    // CSC's OPG view window and sample count (gauge_tab.py).
    const wavelengthMinNm = opts.wavelengthMinNm ?? 303.05;
    const wavelengthMaxNm = opts.wavelengthMaxNm ?? 876.07;
    const samples = opts.samples ?? 288;
    const pressureMbar = Math.max(engine.currentRealPressure(), 1e-12);
    const intensities = simulateOpticalSpectrum(pressureMbar, trend, engine.elapsed(), mode, { wavelengthMinNm, wavelengthMaxNm, samples });
    const n = intensities.length;
    const wavelengthsNm = intensities.map((_, i) => wavelengthMinNm + (wavelengthMaxNm - wavelengthMinNm) * (i / (n - 1)));
    const analysable = pressureMbar <= OPG_ANALYSIS_MAX_PRESSURE_MBAR;
    const species = analysable ? identifyOpticalSpecies(intensities, { wavelengthMinNm, wavelengthMaxNm, topK: opts.topK ?? 10 }) : [];
    return { mode, pressureMbar, wavelengthsNm, intensities, analysable, species };
  }

  setInputs({ scenario: "pumpdown_realistic", ...options });

  return {
    engine,
    /** Drive time from a wall-clock interval (measured, so throttled timers don't slow the simulation). */
    start() {
      if (timer !== null) return;
      lastTick = now();
      timer = setInterval(() => {
        const t = now();
        step(((t - lastTick) / 1000) * speed);
        lastTick = t;
      }, intervalMs);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    step,
    state,
    gauge,
    setInputs,
    listScenarios,
    spectrum,
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    restart() {
      engine.restart();
      trend = 0;
      revision += 1;
    },
    /** @param {number} s */
    setSpeed(s) {
      speed = Math.max(0, Number(s));
    },
    /** Called after every step with the new state; returns an unsubscribe function. @param {(state: SimulationState) => void} fn */
    onStep(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

/** @typedef {ReturnType<typeof createSimulation>} Simulation */
