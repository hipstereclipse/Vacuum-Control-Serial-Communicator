// @ts-check
/**
 * Data model for the gauge-simulation subsystem. Port of CSC
 * src/serial_comm/simulation_models.py, plus the seedable random source the engine and
 * simulated gauges share (CSC uses Python's `random.Random`, seeded per gauge).
 *
 * One engine owns one "real" chamber pressure (mbar) that follows the selected pattern;
 * each simulated gauge reads it and applies its own response (Pirani gas correction,
 * CDG direct read, cold-cathode underrange/saturation, ...). Nothing here has side effects.
 */
import { formatG } from "../units.js";

// ── Patterns & gas types ─────────────────────────────────────────────────────

/** The shape of pressure-vs-time the engine produces. */
export const SimulationPattern = Object.freeze({
  PUMPDOWN: "PUMPDOWN",
  LEAK: "LEAK",
  ARGON_ENVIRONMENT: "ARGON_ENVIRONMENT",
  CUSTOM: "CUSTOM"
});

/** Ambient gas species used by the thermal (Pirani) correction. */
export const GasType = Object.freeze({
  N2: "N2", // baseline (1.0)
  AR: "AR", // argon (~1.6)
  HE: "HE", // helium (~0.8)
  CO2: "CO2" // carbon dioxide (~0.89)
});

/** Ambient humidity level; more adsorbed water slows pumpdowns. */
export const HumidityLevel = Object.freeze({
  LOW: "LOW", // dry/controlled environment, minimal outgassing
  MEDIUM: "MEDIUM", // typical lab
  HIGH: "HIGH" // humid / exposed chamber, heavy water-vapour load
});

/** Pumpdown time multiplier per humidity level. */
export const HUMIDITY_TIME_FACTOR = Object.freeze({ LOW: 1.0, MEDIUM: 1.15, HIGH: 1.35 });

/**
 * Pirani correction factor relative to the N2 baseline. CSC's response model reads
 * `true_pressure * factor` when the gas is not N2.
 *
 * 🟠 These are CSC's "approximate values widely cited for hot-wire Pirani gauges"; the
 * correction data should be taken from the PSG55x / PCG55x manuals, which are not among
 * the port's sources. 🟠 In the usual convention these numbers are C in
 * p_true = C * p_indicated, which would make the indicated value true / C; CSC multiplies
 * instead (argon reads high). Kept for parity with simulated_worker.py `_model_pirani`.
 */
export const PIRANI_GAS_FACTOR = Object.freeze({ N2: 1.0, AR: 1.6, HE: 0.8, CO2: 0.89 });

const GAS_ALIASES = /** @type {Record<string, string>} */ ({
  n2: "N2", nitrogen: "N2", air: "N2",
  ar: "AR", argon: "AR",
  he: "HE", helium: "HE",
  co2: "CO2", "carbon dioxide": "CO2"
});

/**
 * Canonical GasType for user input ("Ar", "argon", "AR" -> "AR"); throws on unknown gas.
 * 🟠 "air" maps to N2 (Pirani factor 1.0), which is the usual approximation; CSC has no air entry.
 * @param {unknown} gas
 */
export function normalizeGas(gas) {
  const key = String(gas ?? "").trim().toLowerCase();
  const out = GAS_ALIASES[key];
  if (!out) throw new Error(`Unknown gas type '${gas}'. Supported: ${Object.values(GasType).join(", ")}`);
  return out;
}

/** @param {unknown} level */
export function normalizeHumidity(level) {
  const key = String(level ?? "").trim().toUpperCase();
  if (!(key in HumidityLevel)) {
    throw new Error(`Unknown humidity level '${level}'. Supported: ${Object.values(HumidityLevel).join(", ")}`);
  }
  return key;
}

/** @param {unknown} pattern */
export function normalizePattern(pattern) {
  const key = String(pattern ?? "").trim().toUpperCase();
  if (!(key in SimulationPattern)) {
    throw new Error(`Unknown simulation pattern '${pattern}'. Supported: ${Object.values(SimulationPattern).join(", ")}`);
  }
  return key;
}

// ── Gauge-family classification ──────────────────────────────────────────────

/** How a simulated gauge turns real pressure into an emitted reading. */
export const GaugeFamily = Object.freeze({
  PIRANI: "PIRANI",
  CDG: "CDG",
  COLD_CATHODE: "COLD_CATHODE",
  COMBINATION: "COMBINATION", // Pirani + cold cathode (BCG, PCG)
  VGC: "VGC" // controller, passes through the attached sensor
});

/**
 * @typedef {Object} GaugeSimulationSpec   CSC GaugeSimulationSpec
 * @property {number} minMbar
 * @property {number} maxMbar
 * @property {number} repeatabilityRel
 * @property {number} accuracyRel
 * @property {number} responseTauS
 * @property {number} warmupS              carried over from CSC; the CSC worker never uses it
 * @property {number | null} blendLowMbar  combination gauges: ion below this
 * @property {number | null} blendHighMbar combination gauges: Pirani above this
 */

/**
 * @param {number} minMbar @param {number} maxMbar @param {number} repeatabilityRel
 * @param {number} accuracyRel @param {number} responseTauS
 * @param {{ warmupS?: number, blendLowMbar?: number, blendHighMbar?: number }} [extra]
 * @returns {GaugeSimulationSpec}
 */
function simSpec(minMbar, maxMbar, repeatabilityRel, accuracyRel, responseTauS, extra = {}) {
  return Object.freeze({
    minMbar, maxMbar, repeatabilityRel, accuracyRel, responseTauS,
    warmupS: extra.warmupS ?? 0,
    blendLowMbar: extra.blendLowMbar ?? null,
    blendHighMbar: extra.blendHighMbar ?? null
  });
}

/** Single source of truth for "what kind of sensor is this" (CSC `_FAMILY_BY_MODEL`). */
export const FAMILY_BY_MODEL = Object.freeze({
  // Pirani / thermal
  PPG550: GaugeFamily.PIRANI,
  PPG570: GaugeFamily.PIRANI,
  PSG500: GaugeFamily.PIRANI,
  PSG550: GaugeFamily.PIRANI,
  MPG400: GaugeFamily.PIRANI,
  MPG500: GaugeFamily.PIRANI,
  PEG100: GaugeFamily.PIRANI,
  // Capacitance diaphragm
  CDG025D: GaugeFamily.CDG,
  CDG045D: GaugeFamily.CDG,
  // Cold cathode / ionisation only
  MAG500: GaugeFamily.COLD_CATHODE,
  BPG402: GaugeFamily.COLD_CATHODE,
  BPG552: GaugeFamily.COLD_CATHODE,
  // Combination (Pirani + CC)
  // 🟠 PCG550 is Pirani + capacitance diaphragm, not Pirani + cold cathode; CSC models it
  // with the cold-cathode branch below 6e-4 mbar (and its spec floor makes it underrange
  // below 1e-4 mbar). Kept for parity.
  OPG550: GaugeFamily.COMBINATION,
  BCG450: GaugeFamily.COMBINATION,
  BCG552: GaugeFamily.COMBINATION,
  PCG550: GaugeFamily.COMBINATION,
  // Controllers, pass-through
  VGC083: GaugeFamily.VGC,
  VGC094: GaugeFamily.VGC,
  VGC40X: GaugeFamily.VGC,
  VGC50X: GaugeFamily.VGC
});

/**
 * Model names outside CSC's table that resolve to a table entry. Not in CSC: added so
 * every CDG model is modelled as a CDG (CSC falls back to Pirani for, e.g., CDG100D,
 * which would make it gas dependent) and the PxG55x variants get their family's spec.
 * @param {string} model
 */
export function resolveModelAlias(model) {
  const m = String(model ?? "").trim().toUpperCase();
  if (m in FAMILY_BY_MODEL) return m;
  if (/^CD[GS]/.test(m) || m === "CAPACITANCE") return m.startsWith("CDG025") ? "CDG025D" : "CDG045D";
  if (/^PSG5/.test(m) || m === "PSG") return "PSG550";
  if (/^PCG5/.test(m) || m === "PCG") return "PCG550";
  if (/^PPG5/.test(m) || m === "PPG") return "PPG550";
  if (/^BCG/.test(m) || m === "BCG") return m.startsWith("BCG45") ? "BCG450" : "BCG552";
  if (/^BPG/.test(m)) return m.startsWith("BPG40") ? "BPG402" : "BPG552";
  if (/^OPG/.test(m)) return "OPG550";
  if (/^MAG/.test(m) || m === "COLD_CATHODE") return "MAG500";
  if (m === "PIRANI") return "PSG550";
  return m;
}

/**
 * CSC `classify_family`: unknown models fall back to PIRANI (direct read with gas
 * correction). Model aliases (see resolveModelAlias) are applied first.
 * @param {string} model
 */
export function classifyFamily(model) {
  const m = resolveModelAlias(model);
  return FAMILY_BY_MODEL[/** @type {keyof typeof FAMILY_BY_MODEL} */ (m)] ?? GaugeFamily.PIRANI;
}

/** Per-model simulation metadata (CSC `_MODEL_SIM_SPECS`). */
export const MODEL_SIM_SPECS = Object.freeze({
  // Pirani / thermal
  PPG550: simSpec(5e-4, 1.2e3, 0.003, 0.03, 0.8),
  PPG570: simSpec(5e-4, 1.2e3, 0.0025, 0.025, 0.7),
  PSG500: simSpec(5e-4, 1.1e3, 0.0035, 0.035, 0.9),
  PSG550: simSpec(5e-4, 1.2e3, 0.003, 0.03, 0.85),
  PEG100: simSpec(8e-4, 1.1e3, 0.006, 0.05, 1.2),
  // Combination sensors modelled as a Pirani + ion/cold-cathode blend
  BCG450: simSpec(5e-10, 1.1e3, 0.008, 0.12, 0.9, { warmupS: 2.0, blendLowMbar: 6e-4, blendHighMbar: 2e-3 }),
  BCG552: simSpec(5e-10, 1.1e3, 0.008, 0.1, 0.85, { warmupS: 2.0, blendLowMbar: 5e-4, blendHighMbar: 1.5e-3 }),
  BPG402: simSpec(1e-10, 1e-2, 0.01, 0.2, 1.6, { warmupS: 2.5 }),
  BPG552: simSpec(1e-10, 1e-2, 0.01, 0.2, 1.6, { warmupS: 2.5 }),
  MAG500: simSpec(1e-9, 1e-2, 0.012, 0.2, 1.6, { warmupS: 2.0 }),
  // OPG550 simulated as Pirani + cold cathode with pressure-dependent blending
  OPG550: simSpec(1e-9, 1.3e3, 0.003, 0.03, 0.8, { warmupS: 1.5, blendLowMbar: 7e-4, blendHighMbar: 2e-3 }),
  // Capacitance / piezo combinations
  MPG400: simSpec(5e-4, 1.3e3, 0.003, 0.03, 0.75),
  MPG500: simSpec(5e-4, 1.3e3, 0.003, 0.03, 0.75),
  PCG550: simSpec(1e-4, 1.3e3, 0.002, 0.02, 0.6),
  // CDG family uses dynamic full-scale logic and its own accuracy model
  CDG025D: simSpec(1e-5, 1.333e3, 0.0004, 0.0025, 0.4),
  CDG045D: simSpec(1e-5, 1.333e3, 0.0004, 0.0025, 0.4),
  // Controllers (pass-through of the attached transducer)
  VGC083: simSpec(1e-10, 1.3e3, 0.01, 0.15, 0.8),
  VGC094: simSpec(1e-10, 1.3e3, 0.01, 0.15, 0.8),
  VGC40X: simSpec(1e-10, 1.3e3, 0.01, 0.15, 0.8),
  VGC50X: simSpec(1e-10, 1.3e3, 0.01, 0.15, 0.8)
});

export const DEFAULT_SIM_SPEC = simSpec(5e-4, 1e3, 0.005, 0.05, 0.9);

/**
 * CSC `get_simulation_spec`, with model aliases applied first.
 * @param {string} model
 * @returns {GaugeSimulationSpec}
 */
export function getSimulationSpec(model) {
  const m = resolveModelAlias(model);
  return MODEL_SIM_SPECS[/** @type {keyof typeof MODEL_SIM_SPECS} */ (m)] ?? DEFAULT_SIM_SPEC;
}

// ── CDG full-scale option tables ─────────────────────────────────────────────
// INFICON sells Torr-native and mbar-native heads as distinct SKUs (a "10 mbar" and a
// "10 Torr (≈13.33 mbar)" head are different products). CSC: "Sources: INFICON ordering
// documentation, confirmed 2026-04."

/** @typedef {{ label: string, mbar: number }} CDGFullScaleOption */

/**
 * Torr-native head; the label shows both units.
 * 🟠 CSC converts with 1.33322 rather than 1.33322387415 (units.py), so a "10 Torr" head
 * is 13.3322 mbar here. Kept for parity.
 * @param {number} torr
 * @returns {CDGFullScaleOption}
 */
function torrHead(torr) {
  const mbar = torr * 1.33322;
  const mbarStr = mbar >= 10 ? mbar.toFixed(1) : mbar >= 1 ? mbar.toFixed(2) : formatG(mbar, 4);
  return Object.freeze({ label: `${formatG(torr)} Torr (${mbarStr} mbar)`, mbar });
}

/** @param {number} mbar @returns {CDGFullScaleOption} */
function mbarHead(mbar) {
  return Object.freeze({ label: `${formatG(mbar)} mbar`, mbar });
}

/** CDG025D: 0.1 / 1 / 10 / 100 / 1100 mbar and 0.1 / 1 / 10 / 100 / 1000 Torr heads. */
export const CDG025D_FULL_SCALE_OPTIONS = Object.freeze([
  mbarHead(0.1), torrHead(0.1), mbarHead(1), torrHead(1), mbarHead(10),
  torrHead(10), mbarHead(100), torrHead(100), mbarHead(1100), torrHead(1000)
]);

/** CDG045D: wider range of heads. */
export const CDG045D_FULL_SCALE_OPTIONS = Object.freeze([
  mbarHead(0.1), torrHead(0.1), mbarHead(0.25), torrHead(0.25), mbarHead(1), torrHead(1),
  mbarHead(2), torrHead(2), mbarHead(5), torrHead(5), mbarHead(10), torrHead(10),
  mbarHead(20), torrHead(20), mbarHead(50), torrHead(50), mbarHead(100), torrHead(100),
  mbarHead(200), torrHead(200), mbarHead(1100), torrHead(500), torrHead(1000)
]);

/** Fallback for unknown CDG models. */
export const CDG_FULL_SCALE_OPTIONS = Object.freeze([
  mbarHead(0.1), torrHead(0.1), mbarHead(1), torrHead(1), mbarHead(10),
  torrHead(10), mbarHead(100), torrHead(100), torrHead(1000)
]);

/** @param {string} model */
export function cdgFullScaleOptions(model) {
  const m = String(model ?? "").toUpperCase();
  if (m === "CDG025D") return CDG025D_FULL_SCALE_OPTIONS;
  if (m === "CDG045D") return CDG045D_FULL_SCALE_OPTIONS;
  return CDG_FULL_SCALE_OPTIONS;
}

// ── Recipe steps & gauge config ──────────────────────────────────────────────

/** @typedef {"linear" | "exponential" | "flat"} Interpolation */

/**
 * @typedef {Object} RecipeStep   one segment of a CUSTOM pattern's pressure-vs-time recipe
 * @property {string} name
 * @property {number} durationS
 * @property {number} startPressureMbar
 * @property {number} endPressureMbar
 * @property {Interpolation} interpolation
 */

/**
 * @param {string} name @param {number} durationS @param {number} startPressureMbar
 * @param {number} endPressureMbar @param {Interpolation} [interpolation]
 * @returns {RecipeStep}
 */
export function recipeStep(name, durationS, startPressureMbar, endPressureMbar, interpolation = "linear") {
  return Object.freeze({ name, durationS, startPressureMbar, endPressureMbar, interpolation });
}

/** CSC `_default_recipe`. @returns {RecipeStep[]} */
export function defaultRecipe() {
  return [
    recipeStep("Roughing Pumpdown", 90.0, 1013.0, 2e-1, "exponential"),
    recipeStep("High-Vac Pumpdown", 180.0, 2e-1, 8e-6, "exponential"),
    recipeStep("Process Hold", 120.0, 8e-6, 1.2e-5, "linear"),
    recipeStep("Gas Burst / Load", 12.0, 1.2e-5, 6e-4, "linear"),
    recipeStep("Recovery", 90.0, 6e-4, 1e-5, "exponential"),
    recipeStep("Slow Leak Drift", 300.0, 1e-5, 2.5e-5, "linear")
  ];
}

/** "sim:" + 8 hex digits, as CSC `_new_sim_id`. */
export function newSimId() {
  const bytes = new Uint8Array(4);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 4; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `sim:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * @typedef {Object} SimulatedGaugeConfig   CSC SimulatedGaugeConfig (user-supplied, per gauge)
 * @property {string} simId
 * @property {string} model
 * @property {string} displayName
 * @property {string} pattern
 * @property {RecipeStep[]} recipeSteps    only consulted for the CUSTOM pattern
 * @property {number} basePressureMbar
 * @property {number} leakRateMbarLS
 * @property {number} pollIntervalS
 * @property {number | null} cdgFullScaleMbar
 * @property {string} humidityLevel
 * @property {string} gasType
 */

/**
 * Build a config with CSC's defaults.
 * @param {Partial<SimulatedGaugeConfig> & { model: string }} fields
 * @returns {SimulatedGaugeConfig}
 */
export function simulatedGaugeConfig(fields) {
  return {
    simId: fields.simId || newSimId(),
    model: String(fields.model),
    displayName: fields.displayName ?? `SIM – ${fields.model}`,
    pattern: normalizePattern(fields.pattern ?? SimulationPattern.PUMPDOWN),
    recipeSteps: fields.recipeSteps?.length ? [...fields.recipeSteps] : defaultRecipe(),
    basePressureMbar: fields.basePressureMbar ?? 1e-6,
    leakRateMbarLS: fields.leakRateMbarLS ?? 0.0,
    pollIntervalS: fields.pollIntervalS ?? 0.1,
    cdgFullScaleMbar: fields.cdgFullScaleMbar ?? null,
    humidityLevel: normalizeHumidity(fields.humidityLevel ?? HumidityLevel.MEDIUM),
    gasType: normalizeGas(fields.gasType ?? GasType.N2)
  };
}

/**
 * JSON form used by CSC's session serialiser (`to_dict`), keys kept snake_case so session
 * files stay interchangeable with CSC.
 * @param {SimulatedGaugeConfig} c
 */
export function configToDict(c) {
  return {
    sim_id: c.simId,
    model: c.model,
    display_name: c.displayName,
    pattern: c.pattern,
    recipe_steps: c.recipeSteps.map((s) => ({
      name: s.name,
      duration_s: s.durationS,
      start_pressure_mbar: s.startPressureMbar,
      end_pressure_mbar: s.endPressureMbar,
      interpolation: s.interpolation
    })),
    base_pressure_mbar: c.basePressureMbar,
    leak_rate_mbar_l_s: c.leakRateMbarLS,
    poll_interval_s: c.pollIntervalS,
    cdg_full_scale_mbar: c.cdgFullScaleMbar,
    humidity_level: c.humidityLevel,
    gas_type: c.gasType
  };
}

/**
 * Inverse of configToDict (CSC `from_dict`).
 * @param {any} d
 * @returns {SimulatedGaugeConfig}
 */
export function configFromDict(d) {
  const steps = (d.recipe_steps ?? []).map((/** @type {any} */ s) =>
    recipeStep(String(s.name), Number(s.duration_s), Number(s.start_pressure_mbar), Number(s.end_pressure_mbar), s.interpolation ?? "linear")
  );
  return simulatedGaugeConfig({
    simId: d.sim_id || undefined,
    model: String(d.model),
    displayName: String(d.display_name),
    pattern: d.pattern ?? "PUMPDOWN",
    recipeSteps: steps,
    basePressureMbar: Number(d.base_pressure_mbar ?? 1e-6),
    leakRateMbarLS: Number(d.leak_rate_mbar_l_s ?? 0.0),
    pollIntervalS: Number(d.poll_interval_s ?? 0.1),
    cdgFullScaleMbar: d.cdg_full_scale_mbar != null ? Number(d.cdg_full_scale_mbar) : null,
    humidityLevel: d.humidity_level ?? HumidityLevel.MEDIUM,
    gasType: d.gas_type ?? GasType.N2
  });
}

// ── Seedable random source ───────────────────────────────────────────────────

/**
 * @typedef {Object} Rng
 * @property {() => number} random                      uniform in [0, 1)
 * @property {(lo: number, hi: number) => number} uniform
 * @property {(mu: number, sigma: number) => number} gauss
 */

/**
 * 32-bit seed from a number or string (FNV-1a over the string form).
 * @param {number | string} seed
 */
export function hashSeed(seed) {
  if (typeof seed === "number" && Number.isInteger(seed)) return seed >>> 0;
  let h = 0x811c9dc5;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic PRNG (mulberry32) with a Box-Muller `gauss`, standing in for Python's
 * `random.Random`. The sequences differ from CPython's; only determinism is kept.
 * @param {number | string} [seed]
 * @returns {Rng}
 */
export function createRng(seed = 1) {
  let state = hashSeed(seed);
  function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    random,
    uniform: (lo, hi) => lo + (hi - lo) * random(),
    gauss(mu, sigma) {
      let u = 0;
      while (u <= 0) u = random();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
      return mu + sigma * z;
    }
  };
}
