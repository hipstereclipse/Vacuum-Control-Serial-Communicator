// Facade (public/core/sim/index.js): scenarios, gauges, determinism, and the CDG
// gas-independence rule of WEB_PORT_PLAN.md section 10.
import { test, assert, sleep } from "../harness.mjs";
import { createSimulation, listScenarios } from "../../public/core/sim/index.js";
import { SCENARIOS, scenarioByKey } from "../../public/core/sim/scenarios.js";
import { configFromDict, configToDict, simulatedGaugeConfig } from "../../public/core/sim/models.js";

/** @param {ReturnType<typeof createSimulation>} sim @param {() => number} read @param {number} n @param {number} dt */
function run(sim, read, n, dt = 0.5) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    sim.step(dt);
    out.push(read());
  }
  return out;
}

test("listScenarios returns CSC's five scenarios", () => {
  const rows = createSimulation().listScenarios();
  assert.deepEqual(rows.map((r) => r.id), ["pumpdown_realistic", "semi_cleaning", "pvd_process", "rac_leak_test", "slow_leak_watch"]);
  assert.ok(rows.every((r) => r.label && r.description));
  assert.deepEqual(listScenarios(), rows);
});

test("scenario aliases resolve", () => {
  assert.equal(scenarioByKey("pumpdown")?.key, "pumpdown_realistic");
  assert.equal(scenarioByKey("leak")?.key, "slow_leak_watch");
  assert.equal(scenarioByKey("PVD-process")?.key, "pvd_process");
  assert.equal(scenarioByKey("nope"), null);
  assert.throws(() => createSimulation({ scenario: "nope" }), /Unknown scenario/);
});

test("scenario sets pattern, base, gas and humidity", () => {
  const sim = createSimulation({ scenario: "pvd_process" });
  const s = sim.state();
  assert.equal(s.scenario, "pvd_process");
  assert.equal(s.pattern, "CUSTOM");
  assert.equal(s.gas, "AR");
  assert.equal(s.humidity, "MEDIUM");
  assert.equal(s.recipeSteps.length, 5);
  assert.equal(s.pressureMbar, 1013.0);
});

test("explicit inputs override the scenario", () => {
  const sim = createSimulation({ scenario: "pumpdown", baseMbar: 1e-3, gas: "helium", humidity: "low" });
  const s = sim.state();
  assert.equal(s.basePressureMbar, 1e-3);
  assert.equal(s.gas, "HE");
  assert.equal(s.humidity, "LOW");
});

test("pumpdown decreases monotonically toward base pressure", () => {
  const sim = createSimulation({ scenario: "pumpdown", seed: 11 });
  const truth = run(sim, () => sim.state().pressureMbar, 600, 0.5);
  for (let i = 1; i < truth.length; i += 1) assert.ok(truth[i] <= truth[i - 1], `true pressure rose at step ${i}`);
  assert.ok(Math.abs(truth.at(-1) - 8e-6) / 8e-6 < 1e-3, `ends at base: ${truth.at(-1)}`);

  // A simulated Pirani follows within its noise (repeatability 0.3 %).
  const sim2 = createSimulation({ scenario: "pumpdown", seed: 11 });
  const psg = sim2.gauge({ type: "PSG550" });
  const readings = run(sim2, psg.pressure, 600, 0.5);
  for (let i = 1; i < readings.length; i += 1) assert.ok(readings[i] <= readings[i - 1] * 1.01, `PSG rose at step ${i}: ${readings[i - 1]} -> ${readings[i]}`);
  assert.ok(Math.abs(readings.at(-1) - 5e-4) < 1e-12, "Pirani bottoms out at its range minimum");
  assert.equal(psg.status(), "UR");
});

test("same seed gives identical readings; different seed does not", () => {
  const make = (/** @type {number} */ seed) => {
    const sim = createSimulation({ scenario: "semi_cleaning", seed });
    const cdg = sim.gauge({ type: "CDG045D", fullScaleMbar: 13.332 });
    const pcg = sim.gauge({ type: "PCG550" });
    return run(sim, () => [cdg.pressure(), pcg.pressure()], 200, 1.0);
  };
  assert.deepEqual(make(42), make(42));
  assert.notDeepEqual(make(42), make(43));
});

test("pressure() does not advance time and is stable between steps", () => {
  const sim = createSimulation({ scenario: "pumpdown", seed: 5 });
  const psg = sim.gauge({ type: "PSG550" });
  sim.step(10);
  const t = sim.state().elapsedS;
  const a = psg.pressure();
  for (let i = 0; i < 50; i += 1) assert.equal(psg.pressure(), a);
  assert.equal(sim.state().elapsedS, t);
});

test("adding a gauge does not change another gauge's readings", () => {
  const simA = createSimulation({ seed: 9 });
  const a = simA.gauge({ type: "PSG550" });
  const simB = createSimulation({ seed: 9 });
  const b = simB.gauge({ type: "PSG550" });
  const extra = simB.gauge({ type: "BCG450" });
  const ra = run(simA, a.pressure, 50);
  const rb = run(simB, () => (extra.pressure(), b.pressure()), 50);
  assert.deepEqual(ra, rb);
});

test("CDG channel is unchanged when the gas type changes (live and at start)", () => {
  const readCdg = (/** @type {string} */ gas, /** @type {string | null} */ switchTo) => {
    const sim = createSimulation({ scenario: "pvd_process", gas, seed: 21 });
    const cdg = sim.gauge({ type: "CDG045D", fullScaleMbar: 13.332 });
    const psg = sim.gauge({ type: "PSG550" });
    const out = [];
    for (let i = 0; i < 300; i += 1) {
      if (switchTo && i === 150) sim.setInputs({ gas: switchTo });
      sim.step(1.0);
      out.push({ cdg: cdg.pressure(), psg: psg.pressure() });
    }
    return out;
  };
  const n2 = readCdg("N2", null);
  for (const [gas, sw] of [["AR", null], ["HE", null], ["CO2", null], ["N2", "AR"], ["N2", "HE"]]) {
    const other = readCdg(gas, sw);
    assert.deepEqual(other.map((r) => r.cdg), n2.map((r) => r.cdg), `CDG moved with gas ${gas}${sw ? `->${sw}` : ""}`);
    assert.notDeepEqual(other.map((r) => r.psg), n2.map((r) => r.psg), `Pirani should move with gas ${gas}${sw ? `->${sw}` : ""}`);
  }
});

test("CDG reports over range above full scale", () => {
  const sim = createSimulation({ scenario: "pumpdown", seed: 2 });
  const cdg = sim.gauge({ type: "CDG045D", fullScaleMbar: 13.332 });
  assert.equal(cdg.pressure(), 13.332);
  assert.equal(cdg.status(), "OR");
  sim.step(120);
  assert.equal(cdg.status(), "UR");
});

test("setInputs changes the leak rate live without resetting the clock", () => {
  const sim = createSimulation({ scenario: "leak", seed: 1 });
  sim.step(100);
  const p1 = sim.state().pressureMbar;
  sim.setInputs({ leakRate: 5e-3 });
  assert.equal(sim.state().elapsedS, 100);
  assert.ok(Math.abs(sim.state().pressureMbar - (8e-6 + (5e-3 * 100) / 10)) < 1e-12);
  assert.ok(sim.state().pressureMbar > p1);
  sim.setInputs({ scenario: "pumpdown" });
  assert.equal(sim.state().elapsedS, 0);
});

test("trend follows the last step", () => {
  const sim = createSimulation({ scenario: "leak" });
  sim.step(2);
  assert.ok(Math.abs(sim.state().trendMbarPerS - 5e-4 / 10) < 1e-12);
});

test("pause stops step(); restart returns to t = 0", () => {
  const sim = createSimulation();
  sim.step(5);
  sim.pause();
  sim.step(5);
  assert.equal(sim.state().elapsedS, 5);
  sim.resume();
  sim.restart();
  assert.equal(sim.state().elapsedS, 0);
});

test("combination gauge sub-sensor reads", () => {
  const sim = createSimulation({ scenario: "slow_leak_watch", seed: 4 });
  const bcg = sim.gauge({ type: "BCG450" });
  sim.step(1);
  const cc = bcg.read("cc_pressure");
  assert.ok(cc.value > 0 && cc.value < 1e-4);
  // CSC gives the BCG Pirani branch the whole BCG range (5e-10 mbar floor), so it is not under range here.
  assert.ok(Math.abs(bcg.read("pirani_pressure").value / sim.state().pressureMbar - 1) < 0.2);
});

test("spectrum() returns an OPG spectrum and identifies species at low pressure", () => {
  const sim = createSimulation({ scenario: "pumpdown", seed: 1 });
  const high = sim.spectrum();
  assert.equal(high.analysable, false);
  assert.deepEqual(high.species, []);
  sim.step(200);
  const low = sim.spectrum({ mode: "HELIUM_LEAK" });
  assert.equal(low.intensities.length, 288);
  assert.equal(low.wavelengthsNm.length, 288);
  assert.ok(low.analysable);
  assert.equal(low.species[0].name, "He");
});

test("start() drives time from a timer and stop() halts it", async () => {
  const sim = createSimulation({ intervalMs: 10, speed: 10 });
  let ticks = 0;
  const off = sim.onStep(() => (ticks += 1));
  sim.start();
  assert.equal(sim.state().running, true);
  await sleep(80);
  sim.stop();
  off();
  const t = sim.state().elapsedS;
  assert.ok(ticks > 0 && t > 0.2, `ticks=${ticks} t=${t}`);
  await sleep(30);
  assert.equal(sim.state().elapsedS, t);
  assert.equal(sim.state().running, false);
});

test("gauges register with the engine and can be removed", () => {
  const sim = createSimulation();
  const g = sim.gauge({ type: "PSG550", id: "sim:abcd1234" });
  assert.equal(g.id, "sim:abcd1234");
  assert.equal(sim.state().registeredCount, 1);
  g.remove();
  assert.equal(sim.state().registeredCount, 0);
});

test("gauge config round-trips through CSC's session dict form", () => {
  const cfg = simulatedGaugeConfig({ model: "CDG045D", cdgFullScaleMbar: 13.3322, gasType: "argon", humidityLevel: "high" });
  const back = configFromDict(JSON.parse(JSON.stringify(configToDict(cfg))));
  assert.deepEqual(back, cfg);
  assert.match(cfg.simId, /^sim:[0-9a-f]{8}$/);
  assert.equal(configToDict(cfg).gas_type, "AR");
});

test("every scenario runs for an hour without non-finite pressures", () => {
  for (const s of SCENARIOS) {
    const sim = createSimulation({ scenario: s.key, seed: 1 });
    const gauges = ["CDG045D", "PSG550", "PCG550", "BCG450", "OPG550", "MAG500"].map((type) => sim.gauge({ type }));
    for (let i = 0; i < 360; i += 1) {
      sim.step(10);
      for (const g of gauges) assert.ok(Number.isFinite(g.pressure()) && g.pressure() >= 0, `${s.key} ${g.model}`);
    }
  }
});
