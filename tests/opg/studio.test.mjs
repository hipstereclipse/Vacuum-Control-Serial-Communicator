// Spectrum Studio model: ports of CSC tests/test_opg_spectrum_studio.py, plus the spike
// filter, gas history, RGD mapping, the plasma threshold advisory and chart visibility.
import { test, assert } from "../harness.mjs";
import {
  OpgStudioState,
  PLASMA_DEFAULTS,
  STUDIO_GASES,
  chartVisibility,
  createSpikeFilter,
  deltaSummary,
  evaluateAutoPlasma,
  formatSci,
  gasPercentFromRgd,
  lastValid,
  pressureDeltaPercent,
  seriesValueAt,
  vacuumQuality,
  vacuumScore
} from "../../public/core/opg/spectrum-studio.js";
import { SpectrumMode } from "../../public/core/sim/opg-spectrum.js";
import { SAMPLE_STATUS, Series } from "../../public/core/store/buffers.js";

const approx = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b)), `${a} ≈ ${b}`);

/** A studio on a fake clock. */
function studio(options = {}) {
  let now = 1_000_000;
  const s = new OpgStudioState({ now: () => now, ...options });
  return { s, advance: (ms) => (now += ms), now: () => now };
}

test("delta percent uses compare B as the reference (CSC)", () => {
  approx(pressureDeltaPercent(5.0e-6, 4.0e-6), 25.0);
  approx(pressureDeltaPercent(3.0e-6, 4.0e-6), -25.0);
});

test("delta percent is null for an invalid reference (CSC)", () => {
  assert.equal(pressureDeltaPercent(5.0e-6, 0.0), null);
  assert.equal(pressureDeltaPercent(NaN, 4.0e-6), null);
  assert.equal(pressureDeltaPercent(5.0e-6, Infinity), null);
});

test("delta line includes the pressure and percent delta (CSC)", () => {
  const d = deltaSummary(5.0e-6, 4.0e-6, "mbar");
  assert.ok(d);
  assert.ok(d.text.includes("Δ = +1.0000E-06 mbar"), d.text);
  assert.ok(d.text.includes("Δ% = +25.00%"), d.text);
  assert.ok(d.text.includes("ratio = 1.25"), d.text);
  assert.equal(deltaSummary(NaN, 1, "mbar"), null);
  const zero = deltaSummary(1e-6, 0, "Torr");
  assert.ok(zero.text.includes("Δ% = n/a") && zero.text.includes("ratio = n/a"), zero.text);
});

test("formatSci matches Python's {:.3E}", () => {
  assert.equal(formatSci(1.2344e-5), "1.234E-05");
  assert.equal(formatSci(-2e-7, 4, true), "-2.0000E-07");
  assert.equal(formatSci(3, 2, true), "+3.00E+00");
});

test("ignition thresholds follow the display unit but are stored in mbar (CSC)", () => {
  const { s } = studio({ plasma: { minIgnitionMbar: 1.33322387415, maxSafeMbar: 13.3322387415 } });
  approx(s.thresholdIn("minMbar", "Torr"), 1.0);
  approx(s.thresholdIn("maxMbar", "Torr"), 10.0);
  s.setThresholdFrom("minMbar", 2.0, "Torr");
  approx(s.plasma.minMbar, 2.6664477483);
  // "As reported" (auto) shows mbar.
  approx(s.thresholdIn("minMbar", "auto"), 2.6664477483);
  // Nonsense input leaves the stored threshold alone.
  s.setThresholdFrom("minMbar", -1, "Torr");
  approx(s.plasma.minMbar, 2.6664477483);
});

test("defaults match CSC's settings dialog", () => {
  assert.deepEqual({ ...PLASMA_DEFAULTS }, { mode: "off", minIgnitionMbar: 1e-6, maxSafeMbar: 1e-2, autoStartAlgorithm: true });
});

test("pressure and peer histories are not sample-capped (CSC)", () => {
  const { s, advance } = studio();
  for (let i = 0; i < 5000; i += 1) {
    s.ingestPressure(1e-5 * (1 + (i % 3) * 0.01), "mbar");
    advance(100);
  }
  assert.equal(s.pressure.length, 5000);
  assert.equal(s.ror.length, 5000);
});

test("spike filter drops a reading 100x above the median of the last five (CSC)", () => {
  const f = createSpikeFilter();
  assert.ok(f.accept(1e-4));
  assert.ok(f.accept(1e-2)); // fewer than three in the window: always kept
  assert.ok(f.accept(1e-4));
  assert.ok(!f.accept(2e-2)); // median 1e-4 -> 1e-2 limit
  assert.ok(f.accept(9e-3));
  const { s } = studio();
  for (const p of [1e-6, 1e-6, 1e-6, 1.5e-4, 1.1e-6]) s.ingestPressure(p, "mbar");
  assert.equal(s.pressure.length, 4);
  assert.equal(s.rejectedSpikes, 1);
});

test("pressure in Torr is stored in mbar and dP/dt comes from consecutive samples", () => {
  const { s, advance } = studio();
  s.ingestPressure(1e-3, "Torr");
  advance(2000);
  s.ingestPressure(2e-3, "Torr");
  approx(s.pressure.v[0], 1.33322387415e-3, 1e-6);
  approx(s.ror.v[1], (1.33322387415e-3) / 2, 1e-6);
  assert.equal(s.ror.v[0], 0);
});

test("Live Data waits for a spectrum; a simulated mode identifies species and grows the gas history", () => {
  const { s, advance } = studio();
  s.ingestPressure(1e-4, "mbar");
  assert.equal(s.spectrum, null);
  assert.match(s.moleculeText, /waiting for live spectrum data/);
  assert.equal(s.gasPct.N2.length, 0);
  // Switching the plot option redraws at once from the last pressure, without an export sample.
  s.setSpectrumMode(SpectrumMode.HELIUM_LEAK);
  assert.equal(s.gasPct.He.length, 1);
  assert.equal(s.exportSamples.length, 0);
  advance(500);
  s.ingestPressure(1.1e-4, "mbar");
  assert.equal(s.spectrum.source, "simulated");
  assert.equal(s.spectrum.x.length, 288);
  assert.ok(s.latestGasPct.He > 0, JSON.stringify(s.latestGasPct));
  assert.equal(s.gasPct.He.length, 2);
  approx(s.gasPartial.He.last().v, (1.1e-4 * s.latestGasPct.He) / 100, 1e-5);
  assert.equal(s.exportSamples.length, 1);
  assert.equal(typeof s.exportSamples[0].spectrum, "object"); // recomputed on export, not stored
});

test("no species identification above 1E-2 mbar, and all-zero shares do not add gas samples", () => {
  const { s, advance } = studio();
  s.setSpectrumMode(SpectrumMode.AIR_LEAK);
  s.ingestPressure(5e-2, "mbar");
  assert.match(s.moleculeText, /unavailable above 1\.0E-02 mbar/);
  assert.ok(STUDIO_GASES.every((g) => s.latestGasPct[g] === 0));
  assert.equal(s.gasPct.N2.length, 0);
  advance(500);
  s.ingestPressure(4e-3, "mbar");
  assert.equal(s.gasPct.N2.length, 1);
});

test("a live record's pixels are normalised and replace the waiting message", () => {
  const { s, advance } = studio();
  s.ingestPressure(2e-5, "mbar");
  const pixels = Array.from({ length: 288 }, (_, i) => (i === 100 ? 5000 : 50));
  s.ingestReply("spec_record", { success: true, value: 288, extra: { pixel_data: pixels, record_id: 7, integration_us: 1000 } });
  assert.equal(s.spectrum.source, "live");
  assert.equal(s.spectrum.recordId, 7);
  assert.equal(Math.max(...s.spectrum.y), 1);
  approx(s.spectrum.x[0], 303.05);
  approx(s.spectrum.x[287], 876.07);
  assert.equal(s.spectra.length, 1);
  // All-zero payloads leave the plot alone.
  s.ingestReply("spec_record", { success: true, value: 288, extra: { pixel_data: new Array(288).fill(0) } });
  assert.equal(s.spectra.length, 1);
  advance(1000);
  s.ingestPressure(2.1e-5, "mbar");
  assert.equal(s.exportSamples.at(-1).spectrum, 0);
  assert.equal(s.exportSamples.at(-1).integrationMs, 1);
});

test("same-timestamp gas samples overwrite instead of duplicating (CSC)", () => {
  const { s } = studio();
  s.setSpectrumMode(SpectrumMode.WATER_LEAK);
  s.ingestPressure(1e-4, "mbar");
  const before = s.gasPct.H2O.length;
  s.appendGasHistory(s.pressure.last().t);
  assert.equal(s.gasPct.H2O.length, before);
});

test("RGD partial pressures map CH to CH4 and skip NH and Fluor (CSC)", () => {
  const partials = [1e-6, 2e-6, 3e-6, 0, 0, 5e-6, 4e-7, 6e-7, 1e-7, 9e-6];
  const { pct, partialMap } = gasPercentFromRgd(partials, 1e-5);
  approx(pct.H2, 10);
  approx(pct.He, 20);
  approx(pct.N2, 30);
  approx(pct.CH4, 6);
  approx(pct.OH, 4);
  assert.equal(pct.H2O, 0);
  assert.ok(!("NH" in pct) && !("Fluor" in pct));
  assert.equal(partialMap.NH, 5e-6);
  const { s } = studio();
  s.ingestPressure(1e-5, "mbar");
  s.ingestReply("rgd_record", { success: true, value: 288, extra: { partial_pressures: partials, total_pressure_mbar: 1e-5 } });
  assert.match(s.moleculeText, /^RGD partial pressures: H2 1\.00E-06 mbar/);
  approx(s.gasPartial.N2.last().v, 3e-6, 1e-6);
});

test("RGD shares hold across pressure readings until the next spectrum; a record's ignition flag updates the plasma state", () => {
  const { s, advance } = studio();
  s.ingestPressure(1e-5, "mbar");
  const pixels = Array.from({ length: 288 }, (_, i) => 10 + (i % 7));
  const partials = [1e-6, 0, 6e-6, 1e-6, 0, 0, 0, 0, 0, 0];
  s.ingestReply("rgd_record", { success: true, value: 288, extra: { pixel_data: pixels, partial_pressures: partials, total_pressure_mbar: 1e-5, ignition_status: 1 } });
  assert.equal(s.plasma.state, 2);
  approx(s.latestGasPct.N2, 60);
  advance(500);
  s.ingestPressure(1.01e-5, "mbar");
  approx(s.latestGasPct.N2, 60);
  assert.match(s.moleculeText, /^RGD partial pressures/);
  s.ingestReply("spec_record", { success: true, value: 288, extra: { pixel_data: pixels.map((v) => v * 2), ignition_status: 0 } });
  assert.match(s.moleculeText, /^Likely optical gas signatures/);
  assert.equal(s.plasma.state, 1);
});

test("record counts, algorithm states, telemetry, identity and plasma state from replies", () => {
  const { s } = studio();
  s.ingestReply("spec_record_count", { success: true, value: 4, unit: "" });
  s.ingestReply("spec_state", { success: true, value: 4, formatted: "Active (CAPTURE SPECTRUM)" });
  s.ingestReply("software_version", { success: true, value: "1.12", formatted: "1.12" });
  s.ingestReply("plasma_state", { success: true, value: 2, formatted: "Plasma ON and ignited" });
  s.ingestReply("analog_output_voltage", { success: true, value: 4321, unit: "mV", formatted: "4321 mV" });
  s.ingestReply("error_status", { success: false, error: "Device error 3" });
  assert.equal(s.recordCounts.spec_record, 4);
  assert.equal(s.algorithmStates.spec_record.label, "Active (CAPTURE SPECTRUM)");
  assert.equal(s.telemetry.get("spec_record_count"), "4");
  assert.equal(s.telemetry.get("analog_output_voltage"), "4321 mV");
  assert.equal(s.identity.firmware, "1.12");
  assert.equal(s.plasma.state, 2);
  assert.equal(s.analogMv, 4321);
  assert.equal(s.errorText, "Device error 3");
  s.ingestReply("ror_record", { success: true, value: 0.5, extra: { pressure_rise_mtorr_per_min: 0.5 } });
  assert.match(s.modeStatus, /pressure rise 0\.5 mTorr\/min/);
  assert.equal(s.gaugeRor.length, 1);
});

test("auto plasma: CSC's decision table and 5 s cooldown", () => {
  const base = { enabled: true, minMbar: 1e-6, maxMbar: 1e-2, lastActionMs: -Infinity, nowMs: 0 };
  assert.deepEqual(evaluateAutoPlasma({ ...base, pressureMbar: 5e-2, plasmaState: 2 }), { action: "off", reason: "above max safe" });
  assert.deepEqual(evaluateAutoPlasma({ ...base, pressureMbar: 5e-2, plasmaState: 1 })?.action, "off");
  assert.equal(evaluateAutoPlasma({ ...base, pressureMbar: 5e-2, plasmaState: 0 }), null);
  assert.deepEqual(evaluateAutoPlasma({ ...base, pressureMbar: 5e-7, plasmaState: 0 })?.action, "on");
  assert.equal(evaluateAutoPlasma({ ...base, pressureMbar: 5e-7, plasmaState: 2 }), null);
  assert.equal(evaluateAutoPlasma({ ...base, pressureMbar: 1e-4, plasmaState: 0 }), null);
  assert.equal(evaluateAutoPlasma({ ...base, pressureMbar: 5e-2, plasmaState: null }), null);
  assert.equal(evaluateAutoPlasma({ ...base, enabled: false, pressureMbar: 5e-2, plasmaState: 2 }), null);
  assert.equal(evaluateAutoPlasma({ ...base, pressureMbar: 5e-2, plasmaState: 2, lastActionMs: -4000 }), null);
  assert.ok(evaluateAutoPlasma({ ...base, pressureMbar: 5e-2, plasmaState: 2, lastActionMs: -5000 }));
});

test("the studio raises a plasma prompt instead of writing, and clears it when the condition ends", () => {
  const { s, advance } = studio();
  s.ingestReply("plasma_state", { success: true, value: 2 });
  s.ingestPressure(1e-4, "mbar");
  assert.equal(s.plasma.prompt, null); // auto plasma off
  s.setPlasmaSettings({ mode: "prompt" });
  advance(100);
  for (const p of [3e-2, 3.1e-2, 3.2e-2]) s.ingestPressure(p, "mbar");
  assert.equal(s.plasma.prompt?.action, "off");
  approx(s.plasma.prompt.pressureMbar, 3e-2, 1e-6); // raised by the first reading above max safe
  s.notePlasmaAction();
  assert.equal(s.plasma.prompt, null);
  s.ingestPressure(3.3e-2, "mbar");
  assert.equal(s.plasma.prompt, null); // cooldown
  advance(5000);
  s.ingestPressure(3.3e-2, "mbar");
  assert.equal(s.plasma.prompt?.action, "off");
  for (const p of [1e-3, 1e-3, 1e-3, 1e-3]) s.ingestPressure(p, "mbar");
  assert.equal(s.plasma.prompt, null);
});

test("auto mode queues CSC's actions once per cooldown and never shows a prompt", () => {
  const { s, advance } = studio();
  s.ingestReply("plasma_state", { success: true, value: 2 });
  s.setPlasmaSettings({ mode: "auto" });
  for (const p of [3e-2, 3.1e-2, 3.2e-2]) s.ingestPressure(p, "mbar");
  assert.equal(s.plasma.prompt, null);
  const a = s.takeAutoAction();
  assert.equal(a?.action, "off");
  assert.equal(s.takeAutoAction(), null); // taken once
  s.ingestReply("plasma_state", { success: true, value: 0 });
  s.ingestPressure(3.3e-2, "mbar");
  assert.equal(s.takeAutoAction(), null); // off and above min ignite: nothing to do
  s.noteAutoAction(a, "sent", "Torr");
  assert.match(s.modeStatus, /^Auto-plasma: pressure 2\.25E-02 Torr > max safe 7\.50E-03 Torr: switching plasma OFF \(sent\)\.$/);
  advance(1000);
  for (const p of [5e-7, 5e-7, 5e-7]) s.ingestPressure(p, "mbar");
  assert.equal(s.takeAutoAction(), null); // still inside the 5 s cooldown
  advance(5000);
  s.ingestPressure(5e-7, "mbar");
  assert.equal(s.takeAutoAction()?.action, "on");
  // Leaving auto mode drops anything queued.
  advance(6000);
  s.ingestPressure(5e-7, "mbar");
  assert.equal(s.plasma.pending?.action, "on");
  s.setPlasmaSettings({ mode: "prompt" });
  assert.equal(s.takeAutoAction(), null);
});

test("auto mode is never restored from saved settings, and plasma reads follow the mode", () => {
  const { s, advance } = studio({ plasma: { mode: "auto" } });
  assert.equal(s.plasma.mode, "prompt");
  assert.ok(s.plasmaReadDue());
  assert.ok(!s.plasmaReadDue());
  advance(2000);
  assert.ok(s.plasmaReadDue());
  s.setPlasmaSettings({ mode: "off" });
  advance(5000);
  assert.ok(!s.plasmaReadDue());
  assert.equal(new OpgStudioState({ plasma: { mode: "nonsense" } }).plasma.mode, "off");
});

test("acquisition runs for Live Data only, at most every 2 s", () => {
  const { s, advance } = studio();
  assert.ok(s.acquisitionDue());
  assert.ok(!s.acquisitionDue());
  advance(1999);
  assert.ok(!s.acquisitionDue());
  advance(1);
  assert.ok(s.acquisitionDue());
  s.setSpectrumMode(SpectrumMode.AIR_LEAK);
  advance(5000);
  assert.ok(!s.acquisitionDue());
  s.setSpectrumMode(SpectrumMode.AUTO);
  assert.ok(s.acquisitionDue());
  assert.equal(s.activeRecordCommand(), "spec_record");
  s.setAnalysisMode("Rate of Rise");
  assert.equal(s.activeRecordCommand(), "ror_record");
});

test("chart visibility per main plot (CSC _sync_chart_visibility)", () => {
  assert.deepEqual(chartVisibility("Raw Spectrum", true), { advanced: false, trend: false, spectrum: true, gas: false });
  assert.deepEqual(chartVisibility("Rate of Rise", false), { advanced: false, trend: true, spectrum: false, gas: false });
  assert.deepEqual(chartVisibility("Residual Gas Detection", false), { advanced: false, trend: false, spectrum: true, gas: false });
  assert.deepEqual(chartVisibility("Residual Gas Detection", true), { advanced: false, trend: false, spectrum: false, gas: true });
  assert.deepEqual(chartVisibility("Advanced Analysis", true), { advanced: true, trend: false, spectrum: false, gas: true });
});

test("hover lookup is numpy searchsorted, clamped", () => {
  const series = new Series("x", { unit: "mbar" });
  for (const [t, v] of [[0, 1], [10, 2], [20, 3]]) series.push(t, v);
  assert.equal(seriesValueAt(series, -5).v, 1);
  assert.equal(seriesValueAt(series, 10).v, 2);
  assert.equal(seriesValueAt(series, 11).v, 3);
  assert.equal(seriesValueAt(series, 99).v, 3);
  assert.equal(seriesValueAt(new Series("y"), 0), null);
});

test("the Δ line's latest value skips over- and underrange samples", () => {
  const series = new Series("cdg", { unit: "Torr" });
  series.push(0, 5e-3, SAMPLE_STATUS.OK);
  series.push(1, -0.24, SAMPLE_STATUS.UNDERRANGE);
  assert.deepEqual(lastValid(series), { t: 0, v: Float32Array.of(5e-3)[0] });
  assert.equal(lastValid(new Series("empty")), null);
});

test("vacuum regime and score (CSC)", () => {
  assert.equal(vacuumQuality(5), "Rough");
  assert.equal(vacuumQuality(1e-2), "Medium");
  assert.equal(vacuumQuality(5e-4), "Fine");
  assert.equal(vacuumQuality(1e-6), "High");
  assert.equal(vacuumQuality(1e-8), "Ultra-high");
  assert.equal(vacuumScore(1e3), 0);
  assert.equal(vacuumScore(1e-9), 1000);
  assert.equal(vacuumScore(1e-3), 500);
});
