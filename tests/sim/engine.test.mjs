// Port of CSC tests/test_simulation_engine.py (PUMPDOWN, LEAK, ARGON_ENVIRONMENT, CUSTOM,
// clock, registration). CSC reads a wall clock; here time moves with engine.advance().
import { test, assert } from "../harness.mjs";
import { P_ATM_MBAR, createSimulationEngine, interpolate } from "../../public/core/sim/engine.js";
import { SimulationPattern, recipeStep, simulatedGaugeConfig } from "../../public/core/sim/models.js";

const isClose = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

// ── PUMPDOWN ────────────────────────────────────────────────────────────────

test("pumpdown starts at atmosphere", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.PUMPDOWN, { basePressureMbar: 1e-6 });
  assert.ok(isClose(eng.currentRealPressure(), P_ATM_MBAR, 1e-3));
});

test("pumpdown decreases monotonically through key times", () => {
  const eng = createSimulationEngine();
  const base = 1e-6;
  eng.setPattern(SimulationPattern.PUMPDOWN, { basePressureMbar: base });
  const p0 = eng.pressureAt(0.0);
  const p1m = eng.pressureAt(60.0);
  const p10m = eng.pressureAt(600.0);
  assert.ok(isClose(p0, P_ATM_MBAR, 1e-12));
  assert.ok(base <= p10m && p10m < p1m && p1m < P_ATM_MBAR);
});

test("pumpdown stays at base after completion", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.PUMPDOWN, { basePressureMbar: 1e-3 });
  assert.ok(isClose(eng.pressureAt(24 * 3600.0), 1e-3, 1e-12));
});

test("pumpdown reaches the 1e-6..1e-5 range within two minutes", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.PUMPDOWN, { basePressureMbar: 8e-6 });
  assert.ok(eng.pressureAt(120.0) <= 1e-5);
});

test("pumpdown shows roughing then turbo handoff", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.PUMPDOWN, { basePressureMbar: 1e-6 });
  assert.ok(eng.pressureAt(30.0) > 1.333, "still rough vacuum at 30 s");
  assert.ok(eng.pressureAt(50.0) < 13.333, "through the crossover band at 50 s");
  assert.ok(eng.pressureAt(90.0) < 1e-3, "high vacuum by 90 s");
});

test("higher humidity slows the pumpdown", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.PUMPDOWN, { basePressureMbar: 1e-7 });
  eng.setHumidity("LOW");
  const low = eng.pressureAt(80);
  eng.setHumidity("HIGH");
  const high = eng.pressureAt(80);
  assert.ok(high > low, `${high} > ${low}`);
});

// ── LEAK ────────────────────────────────────────────────────────────────────

test("leak accumulates linearly", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.LEAK, { basePressureMbar: 1e-6, leakRateMbarLS: 0.1 });
  eng.setVolume(10.0);
  assert.ok(isClose(eng.pressureAt(0.0), 1e-6, 1e-12));
  // 0.1 mbar·L/s / 10 L * 10 s = 0.1 mbar on top of base.
  assert.ok(isClose(eng.pressureAt(10.0), 1e-6 + 0.1));
  assert.ok(isClose(eng.pressureAt(100.0), 1e-6 + 1.0));
});

test("leak with zero rate holds base", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.LEAK, { basePressureMbar: 5e-4, leakRateMbarLS: 0.0 });
  eng.advance(100);
  assert.ok(isClose(eng.currentRealPressure(), 5e-4, 1e-12));
});

// ── ARGON_ENVIRONMENT ───────────────────────────────────────────────────────

test("argon environment is flat", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.ARGON_ENVIRONMENT, { basePressureMbar: 3e-4 });
  const p1 = eng.currentRealPressure();
  eng.advance(50);
  const p2 = eng.currentRealPressure();
  assert.equal(p1, p2);
  assert.ok(isClose(p1, 3e-4, 1e-12));
});

// ── CUSTOM ──────────────────────────────────────────────────────────────────

test("custom linear interpolation", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.CUSTOM, { recipeSteps: [recipeStep("Ramp", 10.0, 1.0, 11.0, "linear")] });
  assert.ok(isClose(eng.pressureAt(5.0), 6.0));
});

test("custom exponential interpolation is log-space", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.CUSTOM, { recipeSteps: [recipeStep("Decay", 4.0, 100.0, 1.0, "exponential")] });
  assert.ok(isClose(eng.pressureAt(2.0), 10.0));
});

test("custom flat segment", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.CUSTOM, { recipeSteps: [recipeStep("Hold", 5.0, 7.0, 99.0, "flat")] });
  assert.equal(eng.pressureAt(0.0), 7.0);
  assert.equal(eng.pressureAt(2.5), 7.0);
});

test("custom multi-step traversal", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.CUSTOM, {
    recipeSteps: [recipeStep("A", 10.0, 0.0, 10.0, "linear"), recipeStep("B", 10.0, 10.0, 20.0, "linear")]
  });
  assert.ok(isClose(eng.pressureAt(5.0), 5.0));
  assert.ok(isClose(eng.pressureAt(15.0), 15.0));
});

test("custom recipe loops and reports the current step", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.CUSTOM, {
    recipeSteps: [recipeStep("A", 10.0, 0.0, 10.0, "linear"), recipeStep("B", 10.0, 10.0, 20.0, "linear")]
  });
  assert.ok(isClose(eng.pressureAt(25.0), 5.0), "t=25 wraps to t=5");
  eng.advance(15);
  const snap = eng.snapshot();
  assert.equal(snap.currentStepIndex, 1);
  assert.ok(isClose(snap.currentStepFraction, 0.5));
});

test("current step is -1 outside CUSTOM", () => {
  const eng = createSimulationEngine();
  assert.equal(eng.snapshot().currentStepIndex, -1);
});

test("custom with no steps returns base pressure", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.CUSTOM, { basePressureMbar: 2e-5, recipeSteps: [] });
  assert.equal(eng.currentRealPressure(), 2e-5);
});

test("exponential interpolation falls back to linear for non-positive endpoints", () => {
  assert.ok(isClose(interpolate(0.0, 10.0, 0.5, "exponential"), 5.0));
  assert.ok(isClose(interpolate(10.0, 0.0, 0.5, "exponential"), 5.0));
});

// ── Clock / pause / resume ──────────────────────────────────────────────────

test("restart resets the virtual clock", () => {
  const eng = createSimulationEngine();
  eng.setPattern(SimulationPattern.PUMPDOWN, { basePressureMbar: 1e-6 });
  eng.advance(42);
  eng.restart();
  const snap = eng.snapshot();
  assert.ok(snap.elapsedS < 0.05);
  assert.ok(isClose(snap.pressureMbar, P_ATM_MBAR, 1e-3));
});

test("pause and resume are idempotent and pause stops the clock", () => {
  const eng = createSimulationEngine();
  assert.ok(!eng.isPaused());
  eng.pause();
  assert.ok(eng.isPaused());
  eng.pause();
  assert.ok(eng.isPaused());
  eng.advance(10);
  assert.equal(eng.elapsed(), 0);
  eng.resume();
  assert.ok(!eng.isPaused());
  eng.resume();
  assert.ok(!eng.isPaused());
  eng.advance(10);
  assert.equal(eng.elapsed(), 10);
});

test("setPattern with resetClock false continues the timeline", () => {
  const eng = createSimulationEngine();
  eng.advance(30);
  eng.setPattern(SimulationPattern.LEAK, { resetClock: false });
  assert.equal(eng.elapsed(), 30);
  eng.setPattern(SimulationPattern.PUMPDOWN);
  assert.equal(eng.elapsed(), 0);
});

test("base pressure is floored at 1e-12", () => {
  const eng = createSimulationEngine();
  eng.setBasePressure(0);
  assert.equal(eng.snapshot().basePressureMbar, 1e-12);
});

// ── Registration ────────────────────────────────────────────────────────────

test("registration round-trip", () => {
  const eng = createSimulationEngine();
  const cfg = simulatedGaugeConfig({ model: "PPG550", displayName: "SIM – PPG550" });
  eng.register(cfg);
  assert.equal(eng.count(), 1);
  assert.ok(eng.registered().includes(cfg));
  eng.unregister(cfg.simId);
  assert.equal(eng.count(), 0);
});
