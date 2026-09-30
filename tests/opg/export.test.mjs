// Spectrum Studio exports: CSC's RGD / RoR CSV layout, Python float printing, and the
// per-chart CSVs.
import { test, assert } from "../harness.mjs";
import { OpgStudioState } from "../../public/core/opg/spectrum-studio.js";
import { advancedCsv, gasCsv, joinBlocks, opgCsv, pyFloat, pyTimestamp, ratioValues, spectrumCsv, spectrumValues288, trendCsv } from "../../public/core/opg/export.js";
import { SpectrumMode } from "../../public/core/sim/opg-spectrum.js";
import { Series } from "../../public/core/store/buffers.js";

test("pyFloat prints like Python's str(float)", () => {
  const cases = [[0, "0.0"], [1, "1.0"], [123, "123.0"], [0.5, "0.5"], [1e-5, "1e-05"], [1.5e-5, "1.5e-05"], [0.0001, "0.0001"], [2.5e-3, "0.0025"],
    [1e16, "1e+16"], [1234567.0, "1234567.0"], [-0.25, "-0.25"], [0.1 + 0.2, "0.30000000000000004"], [NaN, "nan"], [-Infinity, "-inf"], [9.87654321e-7, "9.87654321e-07"]];
  for (const [v, s] of cases) assert.equal(pyFloat(v), s, `pyFloat(${v})`);
});

test("pyTimestamp is strftime %Y-%m-%d %H:%M:%S.%f in local time", () => {
  const t = new Date(2026, 8, 30, 14, 2, 11, 45).getTime();
  assert.equal(pyTimestamp(t), "2026-09-30 14:02:11.045000");
});

test("blocks join with ', ' inside and ',' between (CSC _join_opg_blocks)", () => {
  assert.equal(joinBlocks(["a", 1.5, 2, "b", 3], [2, 3]), "a, 1.5,2.0, b, 3.0");
});

test("resampling onto the 288-pixel grid scales by 10000", () => {
  const s = { x: [300, 900], y: [0, 1] };
  const { x, y } = spectrumValues288(s, 303.05, 876.07);
  assert.equal(x.length, 288);
  assert.ok(Math.abs(y[0] - ((303.05 - 300) / 600) * 10000) < 1e-6);
});

test("ratios guard against a zero denominator (CSC _safe_ratio)", () => {
  const r = ratioValues({ N2: 40, OH: 10, H2: 0, Ar: 4, O2: 8, He: 2 });
  assert.deepEqual(r, [4, 4, 0, 0, 10, 2, 0.05, 0.2]);
});

function capturedStudio() {
  let now = new Date(2026, 8, 30, 10, 0, 0, 0).getTime();
  const s = new OpgStudioState({ now: () => now });
  s.ingestReply("serial_number", { success: true, value: "OPG-55001234", formatted: "OPG-55001234" });
  s.ingestReply("software_version", { success: true, value: "1.12", formatted: "1.12" });
  s.setSpectrumMode(SpectrumMode.AIR_LEAK);
  for (const p of [1e-3, 1.2e-3, 1.5e-3]) {
    s.ingestPressure(p, "mbar");
    now += 1000;
  }
  return s;
}

test("RGD CSV: preamble, header and unit rows, and one row per sample in CSC's block layout", () => {
  const s = capturedStudio();
  const lines = opgCsv(s, "rgd").trimEnd().split("\n");
  assert.equal(lines[0], "Timestamp,20260930_1000");
  assert.equal(lines[1], "Measurement Type,RGD Measurement");
  assert.equal(lines[2], "serial number,055001234");
  assert.equal(lines[3], "bootloader version,");
  assert.equal(lines[4], "application version,1.12");
  assert.equal(lines[5], "");
  const header = lines[6].split(",");
  assert.equal(header.length, 5 + 288 + 10 + 10 + 8);
  assert.deepEqual(header.slice(0, 6), ["Timestamp", "Time", "TotalPressure", "AnalogOut", "IntegrationTime", "303.05"]);
  assert.equal(header[292], "876.07");
  assert.equal(header[293], "Hydrogen");
  assert.equal(lines[7].split(",").length, header.length);
  assert.equal(lines.length, 8 + 3);
  const row = lines[8];
  assert.ok(row.startsWith("2026-09-30 10:00:00.000000, 0.0, 0.001, 0, 0.0,"), row.slice(0, 60));
  // Five blocks: common, spectrum, raw counts, partials, ratios.
  assert.equal(row.split(",").length, header.length);
  assert.equal(row.split(", ").length - 1, 4 + 287 + 9 + 9 + 7);
});

test("RoR CSV: shifted grid, six line intensities and the pressure rise in mTorr/min", () => {
  const s = capturedStudio();
  const lines = opgCsv(s, "ror").trimEnd().split("\n");
  assert.equal(lines[1], "Measurement Type,RoR Leak Detection Measurement");
  const header = lines[6].split(",");
  assert.equal(header.length, 5 + 288 + 7);
  assert.equal(header[5], "305.53");
  assert.equal(header.at(-1), "pressure Rise");
  assert.equal(lines[7].split(",").at(-1), "[mTorr/min]");
  const rise = (row) => Number(row.split(",").at(-1));
  assert.equal(rise(lines[8]), 0);
  // 0.2e-3 mbar in 1 s -> 0.2e-3 * 750.062 * 60 mTorr/min
  assert.ok(Math.abs(rise(lines[9]) - 0.2e-3 * 750.062 * 60) < 1e-6, lines[9].split(",").at(-1));
});

test("nothing to export gives null", () => {
  const s = new OpgStudioState();
  assert.equal(opgCsv(s, "rgd"), null);
  assert.equal(trendCsv(s, "mbar"), null);
  assert.equal(spectrumCsv(s), null);
  assert.equal(gasCsv(s), null);
  assert.equal(advancedCsv(s, [], "mbar"), null);
});

test("per-chart CSVs: trend in the display unit, spectrum, gases, and every correlation source", () => {
  const s = capturedStudio();
  const trend = trendCsv(s, "Torr", "# header").split("\n");
  assert.equal(trend[0], "# header");
  assert.equal(trend[1], "time_s,pressure_Torr,ror_Torr_per_s");
  assert.ok(Math.abs(Number(trend[2].split(",")[1]) - 1e-3 / 1.33322387415) < 1e-9);
  const spectrum = spectrumCsv(s).split("\n");
  assert.equal(spectrum[0], "wavelength_nm,relative_intensity");
  assert.equal(spectrum.length, 288 + 2);
  const gas = gasCsv(s).split("\n");
  assert.equal(gas[0].split(",").length, 1 + 2 * 10);
  const peer = new Series("peer:pressure", { unit: "Torr" });
  peer.push(s.t0 + 500, 1e-3);
  const adv = advancedCsv(s, [{ name: "OPG, filtered", series: s.pressure }, { name: "CDG", series: peer }], "mbar").trimEnd().split("\n");
  assert.equal(adv[0], "series,time_s,pressure_mbar");
  assert.equal(adv.length, 1 + 3 + 1);
  assert.ok(adv[1].startsWith('"OPG, filtered",0.000000,'));
  assert.equal(adv[4], `CDG,0.500000,${(1.33322387415e-3).toExponential(6)}`);
});
