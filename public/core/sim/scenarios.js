// @ts-check
/**
 * Ready-made simulation scenarios. Port of CSC src/serial_comm/simulation_scenarios.py,
 * plus the recipe presets and operation snippets of CSC's recipe editor
 * (GUI/gauge_workspace/recipe_editor.py `_RECIPE_PRESETS`, `_OPERATION_SNIPPETS`), which
 * are plain data a web recipe editor needs as well.
 *
 * Applying a scenario sets pattern, base pressure, leak rate, humidity, gas and (for
 * CUSTOM) the recipe, as CSC's add-simulated-gauge dialog does (`_on_scenario_changed`).
 * 🟠 CUSTOM recipes ignore the leak rate (rac_leak_test's 0.0015 mbar·L/s has no effect),
 * and LEAK ignores humidity; both as in CSC's engine.
 */
import { GasType, HumidityLevel, SimulationPattern, recipeStep } from "./models.js";

/**
 * @typedef {Object} SimulationScenario
 * @property {string} key
 * @property {string} title
 * @property {string} description
 * @property {string} pattern
 * @property {number} basePressureMbar
 * @property {number} leakRateMbarLS
 * @property {string} humidity
 * @property {string} gas
 * @property {readonly import("./models.js").RecipeStep[]} recipeSteps
 */

/** @param {SimulationScenario} s */
const scenario = (s) => Object.freeze({ ...s, recipeSteps: Object.freeze([...s.recipeSteps]) });

/** @type {readonly SimulationScenario[]} */
export const SCENARIOS = Object.freeze([
  scenario({
    key: "pumpdown_realistic",
    title: "General Pumpdown (Humidity Aware)",
    description: "Atmosphere to high-vac with humidity-dependent outgassing and realistic timing.",
    pattern: SimulationPattern.PUMPDOWN,
    basePressureMbar: 8e-6,
    leakRateMbarLS: 0.0,
    humidity: HumidityLevel.MEDIUM,
    gas: GasType.N2,
    recipeSteps: []
  }),
  scenario({
    key: "semi_cleaning",
    title: "Semiconductor Cleaning Cycle",
    description: "Pump, O2/N2 clean pulse, hold, and post-clean recovery envelope.",
    pattern: SimulationPattern.CUSTOM,
    basePressureMbar: 2e-5,
    leakRateMbarLS: 0.0,
    humidity: HumidityLevel.MEDIUM,
    gas: GasType.N2,
    recipeSteps: [
      recipeStep("Initial Pumpdown", 180.0, 1013.0, 2e-4, "exponential"),
      recipeStep("Plasma Clean Backfill", 35.0, 2e-4, 2.5e-2, "linear"),
      recipeStep("Clean Hold", 180.0, 2.5e-2, 2.2e-2, "linear"),
      recipeStep("Gas Shutoff", 20.0, 2.2e-2, 4e-4, "linear"),
      recipeStep("Recovery", 140.0, 4e-4, 1.5e-5, "exponential")
    ]
  }),
  scenario({
    key: "pvd_process",
    title: "PVD / Sputter Process",
    description: "Pumpdown, argon process pressure control, and recovery to base.",
    pattern: SimulationPattern.CUSTOM,
    basePressureMbar: 1.2e-5,
    leakRateMbarLS: 0.0,
    humidity: HumidityLevel.MEDIUM,
    gas: GasType.AR,
    recipeSteps: [
      recipeStep("Chamber Pumpdown", 210.0, 1013.0, 8e-6, "exponential"),
      recipeStep("Argon Backfill", 18.0, 8e-6, 4.8e-3, "linear"),
      recipeStep("Process Stabilize", 120.0, 4.8e-3, 3.5e-3, "linear"),
      recipeStep("Deposition Drift", 300.0, 3.5e-3, 4.1e-3, "linear"),
      recipeStep("Purge + Pump", 120.0, 4.1e-3, 1.2e-5, "exponential")
    ]
  }),
  scenario({
    key: "rac_leak_test",
    title: "RAC Leak Test",
    description: "Automotive HVAC evacuation, isolation hold, and leak event response.",
    pattern: SimulationPattern.CUSTOM,
    basePressureMbar: 2e-2,
    leakRateMbarLS: 0.0015,
    humidity: HumidityLevel.HIGH,
    gas: GasType.N2,
    recipeSteps: [
      recipeStep("Rough Evacuation", 140.0, 1013.0, 1.8, "exponential"),
      recipeStep("Deep Pull", 160.0, 1.8, 2.2e-2, "exponential"),
      recipeStep("Isolation Hold", 240.0, 2.2e-2, 2.8e-2, "linear"),
      recipeStep("Leak Spike", 20.0, 2.8e-2, 8.5e-2, "linear"),
      recipeStep("Post-test Decay", 90.0, 8.5e-2, 2.5e-2, "exponential")
    ]
  }),
  scenario({
    key: "slow_leak_watch",
    title: "Long Hold with Slow Leak",
    description: "Commissioning hold where small leaks and moisture drive pressure creep.",
    pattern: SimulationPattern.LEAK,
    basePressureMbar: 8e-6,
    leakRateMbarLS: 5e-4,
    humidity: HumidityLevel.HIGH,
    gas: GasType.N2,
    recipeSteps: []
  })
]);

/** @type {Readonly<Record<string, SimulationScenario>>} */
export const SCENARIOS_BY_KEY = Object.freeze(Object.fromEntries(SCENARIOS.map((s) => [s.key, s])));

/** Short ids accepted in addition to CSC's keys (not in CSC). */
export const SCENARIO_ALIASES = Object.freeze({
  pumpdown: "pumpdown_realistic",
  cleaning: "semi_cleaning",
  pvd: "pvd_process",
  sputter: "pvd_process",
  rac: "rac_leak_test",
  leak_test: "rac_leak_test",
  leak: "slow_leak_watch",
  slow_leak: "slow_leak_watch"
});

/**
 * CSC `scenario_by_key`, also accepting the aliases above; null when unknown.
 * @param {string} key
 * @returns {SimulationScenario | null}
 */
export function scenarioByKey(key) {
  const k = String(key ?? "").trim().toLowerCase().replace(/-/g, "_");
  const resolved = SCENARIO_ALIASES[/** @type {keyof typeof SCENARIO_ALIASES} */ (k)] ?? k;
  return SCENARIOS_BY_KEY[resolved] ?? null;
}

/** Rows for a scenario picker. */
export function listScenarios() {
  return SCENARIOS.map((s) => ({ id: s.key, label: s.title, description: s.description, pattern: s.pattern }));
}

/** Named full recipes offered by CSC's recipe editor. */
export const RECIPE_PRESETS = Object.freeze({
  "Semiconductor Loadlock": Object.freeze([
    recipeStep("Loadlock Vent", 25.0, 8e-6, 950.0, "linear"),
    recipeStep("Rough Pump", 95.0, 950.0, 2.5e-1, "exponential"),
    recipeStep("Turbo Crossover", 140.0, 2.5e-1, 9e-6, "exponential"),
    recipeStep("Transfer Hold", 90.0, 9e-6, 1.4e-5, "linear"),
    recipeStep("Door Crack Spike", 8.0, 1.4e-5, 4e-4, "linear"),
    recipeStep("Recover", 60.0, 4e-4, 1.2e-5, "exponential")
  ]),
  "PVD / Sputter Process": Object.freeze([
    recipeStep("Chamber Pumpdown", 180.0, 1013.0, 7e-6, "exponential"),
    recipeStep("Argon Backfill", 20.0, 7e-6, 4e-3, "linear"),
    recipeStep("Throttle Stabilize", 80.0, 4e-3, 3.2e-3, "linear"),
    recipeStep("Sputter Drift", 300.0, 3.2e-3, 3.8e-3, "linear"),
    recipeStep("Gas Shutoff", 15.0, 3.8e-3, 2e-4, "linear"),
    recipeStep("Base Recovery", 140.0, 2e-4, 1.2e-5, "exponential")
  ]),
  "RAC / Leak Detection": Object.freeze([
    recipeStep("Rough Evacuation", 120.0, 1013.0, 1.5, "exponential"),
    recipeStep("Deep Pull", 140.0, 1.5, 2e-2, "exponential"),
    recipeStep("Isolation Hold", 220.0, 2e-2, 2.6e-2, "linear"),
    recipeStep("Helium Spray Event", 18.0, 2.6e-2, 7.2e-2, "linear"),
    recipeStep("Post-spray Decay", 75.0, 7.2e-2, 2.4e-2, "exponential")
  ]),
  "General Vacuum Commissioning": Object.freeze([
    recipeStep("Initial Pumpdown", 150.0, 1013.0, 8e-3, "exponential"),
    recipeStep("Overnight Hold", 420.0, 8e-3, 1.6e-2, "linear"),
    recipeStep("Leak Tightening", 180.0, 1.6e-2, 1.2e-3, "exponential"),
    recipeStep("Fine Pump", 220.0, 1.2e-3, 2e-5, "exponential"),
    recipeStep("Outgassing Bump", 90.0, 2e-5, 7e-5, "linear"),
    recipeStep("Conditioned Base", 240.0, 7e-5, 1.6e-5, "exponential")
  ])
});

/** Single steps the recipe editor can append. */
export const OPERATION_SNIPPETS = Object.freeze({
  "Roughing Pump Stage": recipeStep("Roughing Pump", 120.0, 1013.0, 4e-1, "exponential"),
  "Turbo Pump Stage": recipeStep("Turbo Pump", 180.0, 4e-1, 8e-6, "exponential"),
  "Semiconductor Cleaning Hold": recipeStep("Cleaning Hold", 180.0, 2e-2, 1.8e-2, "linear"),
  "PVD Argon Backfill": recipeStep("Argon Backfill", 18.0, 8e-6, 4.5e-3, "linear"),
  "PVD Process Hold": recipeStep("Deposition Hold", 240.0, 3.4e-3, 3.8e-3, "linear"),
  "RAC Isolation Hold": recipeStep("Isolation Hold", 180.0, 2e-2, 2.6e-2, "linear"),
  "RAC Leak Spike": recipeStep("Leak Spike", 15.0, 2.6e-2, 7.5e-2, "linear"),
  "Recovery Stage": recipeStep("Recovery", 120.0, 5e-4, 1.5e-5, "exponential")
});

/** Recipe-editor interpolation choices (CSC `_INTERP_CHOICES`). */
export const INTERPOLATION_CHOICES = Object.freeze(["linear", "exponential", "flat"]);
