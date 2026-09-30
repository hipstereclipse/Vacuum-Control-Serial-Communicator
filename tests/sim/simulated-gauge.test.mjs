// Port of the non-Qt cases of CSC tests/test_simulated_worker.py: the response model is
// driven directly with a no-noise random source, as the Python tests replace `_rng`.
import { test, assert } from "../harness.mjs";
import { GasType, GaugeFamily, classifyFamily, cdgFullScaleOptions } from "../../public/core/sim/models.js";
import { OVERRANGE_SENTINEL, createSimulatedGauge } from "../../public/core/sim/simulated-gauge.js";

const isClose = (a, b, rel = 1e-12) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

/** CSC `_NoNoise`: gauss always 0. */
const noNoise = { random: () => 0.5, uniform: (/** @type {number} */ lo) => lo, gauss: () => 0 };

/** @param {string} model @param {object} [extra] */
const quiet = (model, extra = {}) => createSimulatedGauge({ model, rng: noNoise, calBiasRel: 0, ...extra });

// ── Pirani gas correction ───────────────────────────────────────────────────

for (const [gas, factor] of [[GasType.N2, 1.0], [GasType.AR, 1.6], [GasType.HE, 0.8], [GasType.CO2, 0.89]]) {
  test(`Pirani applies the ${gas} correction factor ${factor}`, () => {
    const real = 1e-3;
    const { value } = quiet("PPG550").respond(real, gas, "pressure");
    assert.ok(isClose(value, real * factor), `${value}`);
  });
}

test("PSG550 reading moves with the gas type", () => {
  const g = quiet("PSG550");
  assert.notEqual(g.respond(1.0, "N2").value, g.respond(1.0, "AR").value);
});

// ── CDG is gas independent ──────────────────────────────────────────────────

for (const gas of Object.values(GasType)) {
  test(`CDG reading does not change with gas ${gas}`, () => {
    const real = 0.5;
    const { value } = quiet("CDG025D").respond(real, gas, "pressure");
    assert.ok(isClose(value, real), `got ${value} for ${gas}`);
  });
}

test("CDG with noise gives identical readings for every gas (same random stream)", () => {
  const readings = Object.values(GasType).map((gas) => {
    const g = createSimulatedGauge({ model: "CDG045D", fullScaleMbar: 13.332, seed: 7 });
    return [0.1, 1, 5, 12].map((p) => g.respond(p, gas).value);
  });
  for (const r of readings) assert.deepEqual(r, readings[0]);
});

test("CDG clamps to full scale", () => {
  const g = quiet("CDG025D", { fullScaleMbar: 10.0 });
  const r = g.respond(100.0, GasType.N2, "pressure");
  assert.ok(r.value <= 10.0, `${r.value}`);
  assert.equal(r.status, "OR");
});

test("CDG floors at 0.05 % of full scale and flags underrange", () => {
  const g = quiet("CDG045D", { fullScaleMbar: 10.0 });
  const r = g.respond(1e-6, GasType.N2);
  assert.ok(isClose(r.value, 10.0 * 0.5e-3));
  assert.equal(r.status, "UR");
  assert.equal(g.respond(5.0, "N2").status, null);
});

test("CDG default full scale follows CSC's option table index 2", () => {
  assert.equal(quiet("CDG025D").fullScaleMbar, 1);
  assert.equal(quiet("CDG045D").fullScaleMbar, 0.25);
});

test("CDG models outside CSC's table are still CDGs (gas independent)", () => {
  assert.equal(classifyFamily("CDG100D"), GaugeFamily.CDG);
  const g = quiet("CDG100D", { fullScaleMbar: 1.3332 });
  assert.ok(isClose(g.respond(0.5, "AR").value, 0.5));
});

test("CDG full-scale labels match CSC", () => {
  const labels = cdgFullScaleOptions("CDG025D").map((o) => o.label);
  assert.equal(labels[0], "0.1 mbar");
  assert.equal(labels[1], "0.1 Torr (0.1333 mbar)");
  assert.equal(labels[5], "10 Torr (13.3 mbar)");
  assert.equal(labels[3], "1 Torr (1.33 mbar)");
  assert.equal(cdgFullScaleOptions("CDG045D").length, 23);
});

// ── Cold cathode ────────────────────────────────────────────────────────────

test("cold cathode over range returns the saturation sentinel", () => {
  const r = quiet("MAG500").respond(1.0, GasType.N2);
  assert.ok(r.value > 1e8);
  assert.equal(r.value, OVERRANGE_SENTINEL);
  assert.equal(r.status, "OR");
});

test("cold cathode under range returns zero", () => {
  const r = quiet("MAG500").respond(1e-12, GasType.N2);
  assert.equal(r.value, 0.0);
  assert.equal(r.status, "UR");
});

// ── Combination gauges ──────────────────────────────────────────────────────

test("combination Pirani command uses gas correction", () => {
  const { value } = quiet("BCG450").respond(1e-3, GasType.AR, "pirani_pressure");
  assert.ok(isClose(value, 1e-3 * 1.6));
});

test("combination cold-cathode command is not gas corrected", () => {
  const { value } = quiet("BCG450").respond(1e-4, GasType.AR, "cc_pressure");
  assert.ok(isClose(value, 1e-4, 1e-9));
});

test("combination blends across the crossover band", () => {
  const g = quiet("BCG450");
  // Band 6e-4..2e-3: halfway, N2, no noise -> both sub-sensors read true pressure.
  assert.ok(isClose(g.respond(1.3e-3, "N2").value, 1.3e-3, 1e-9));
  // With argon the blend weight moves the reading between CC (1x) and Pirani (1.6x).
  const v = g.respond(1.3e-3, "AR").value;
  assert.ok(v > 1.3e-3 && v < 1.3e-3 * 1.6);
});

// ── OPG550 ──────────────────────────────────────────────────────────────────

test("OPG550 is a combination gauge", () => {
  assert.equal(classifyFamily("OPG550"), GaugeFamily.COMBINATION);
});

test("OPG550 tracks pressure within its accuracy bands", () => {
  /** @param {number} p */
  const bandLimit = (p) => (p >= 100.0 ? 0.005 : p >= 2.0 ? 0.01 : p >= 1e-4 ? 0.05 : 0.25);
  for (const p of [120.0, 10.0, 5e-2, 8e-4, 7e-5]) {
    const { value } = quiet("OPG550").respond(p, GasType.N2, "pressure");
    const relErr = Math.abs(value - p) / Math.max(p, 1e-12);
    assert.ok(relErr <= bandLimit(p), `p=${p} relErr=${relErr}`);
  }
});

test("OPG550 with noise stays inside a generous accuracy envelope", () => {
  const g = createSimulatedGauge({ model: "OPG550", seed: 3 });
  for (let i = 0; i < 200; i += 1) {
    const v = g.respond(10.0, "N2").value;
    assert.ok(Math.abs(v - 10) / 10 < 0.1, `${v}`);
  }
});

// ── VGC pass-through ────────────────────────────────────────────────────────

test("VGC passes the true pressure through without noise", () => {
  const g = createSimulatedGauge({ model: "VGC50X", seed: 1 });
  assert.equal(g.respond(3.3e-4, "AR").value, 3.3e-4);
  assert.equal(g.respond(5000, "N2").status, "OR");
});

// ── Sensor dynamics ─────────────────────────────────────────────────────────

test("first-order lag moves toward the target with tau", () => {
  const g = quiet("PSG550"); // tau 0.85 s
  assert.equal(g.applyDynamics(100, 0), 100);
  const v = g.applyDynamics(10, 0.85);
  assert.ok(isClose(v, 100 + (1 - Math.exp(-1)) * (10 - 100), 1e-12));
  // dt = 0 snaps to the target, as in CSC.
  assert.equal(g.applyDynamics(5, 0.85), 5);
});

test("lag is bypassed at over/underrange sentinels", () => {
  const g = quiet("MAG500");
  g.applyDynamics(OVERRANGE_SENTINEL, 0);
  assert.equal(g.applyDynamics(1e-3, 0.1), 1e-3);
  assert.equal(g.applyDynamics(0, 0.2), 0);
});
