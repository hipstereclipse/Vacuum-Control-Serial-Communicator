// Port of CSC tests/test_opg_spectrum.py.
import { test, assert } from "../harness.mjs";
import {
  OPTICAL_SPECIES,
  SpectrumMode,
  identifyOpticalSpecies,
  opticalSignatureWavelengths,
  simulateOpticalSpectrum
} from "../../public/core/sim/opg-spectrum.js";

/** @param {number[]} spectrum @param {number} nm */
function peakAtNm(spectrum, nm) {
  const n = spectrum.length;
  const idx = Math.round(((nm - 380.0) / 400.0) * (n - 1));
  return Math.max(...spectrum.slice(Math.max(0, idx - 3), Math.min(n - 1, idx + 3) + 1));
}

test("helium mode has a strong 588 nm line", () => {
  const spec = simulateOpticalSpectrum(2.0e-4, 6.0e-7, 120.0, SpectrumMode.HELIUM_LEAK);
  assert.ok(peakAtNm(spec, 588.0) > 0.55);
});

test("air leak identifies N2 or O2", () => {
  const spec = simulateOpticalSpectrum(6.0e-2, 1.2e-4, 90.0, SpectrumMode.AIR_LEAK);
  const names = new Set(identifyOpticalSpecies(spec, { topK: 3 }).map((m) => m.name));
  assert.ok(names.has("N2") || names.has("O2"), [...names].join(","));
});

test("auto mode changes with rising pressure", () => {
  const calm = simulateOpticalSpectrum(1.0e-5, 0.0, 1200.0, SpectrumMode.AUTO);
  const leaking = simulateOpticalSpectrum(1.0e-3, 8.0e-6, 1250.0, SpectrumMode.AUTO);
  const calmRatio = peakAtNm(calm, 630.0) / Math.max(peakAtNm(calm, 742.0), 1e-9);
  const leakingRatio = peakAtNm(leaking, 630.0) / Math.max(peakAtNm(leaking, 742.0), 1e-9);
  assert.ok(leakingRatio > calmRatio);
});

test("signature wavelengths expose known lines", () => {
  assert.ok(opticalSignatureWavelengths("H2").includes(656.0));
  assert.deepEqual(opticalSignatureWavelengths("not-a-gas"), []);
});

test("spectrum is normalised to a peak of 1 with the requested sample count", () => {
  const spec = simulateOpticalSpectrum(1e-4, 0, 10, "Water Leak", { wavelengthMinNm: 303.05, wavelengthMaxNm: 876.07, samples: 288 });
  assert.equal(spec.length, 288);
  assert.ok(Math.abs(Math.max(...spec) - 1) < 1e-12);
  assert.ok(Math.min(...spec) > 0);
  assert.equal(simulateOpticalSpectrum(1e-4, 0, 10, "air_leak", { samples: 3 }).length, 16);
});

test("identification needs at least 12 samples and respects topK", () => {
  assert.deepEqual(identifyOpticalSpecies([1, 1, 1]), []);
  const spec = simulateOpticalSpectrum(1e-4, 0, 0, SpectrumMode.HYDROCARBON_BACKSTREAM);
  const matches = identifyOpticalSpecies(spec, { topK: 2 });
  assert.ok(matches.length <= 2);
  for (let i = 1; i < matches.length; i += 1) assert.ok(matches[i - 1].score >= matches[i].score);
  assert.ok(matches.every((m) => OPTICAL_SPECIES.includes(m.name)));
});

test("unknown spectrum mode throws", () => {
  assert.throws(() => simulateOpticalSpectrum(1e-4, 0, 0, "Nope"), /Unknown spectrum mode/);
});
