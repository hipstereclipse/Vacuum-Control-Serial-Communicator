// @ts-check
/**
 * Synthetic OPG550 optical spectrum and species identification. Port of CSC
 * src/serial_comm/opg_spectrum.py.
 *
 * The OPG550 reports optical telemetry, so the spectrum is intensity over wavelength (nm),
 * not over mass/charge. Each species contributes Gaussian lines at its signature
 * wavelengths, weighted by its fraction in a composition model; the sum is normalised to
 * a peak of 1. In CSC the synthetic spectrum drives the fixed scenario modes; AUTO ("Live
 * Data") shows the gauge's own spectrum, but the AUTO composition model exists here too.
 */

/** Spectrum modes; values are CSC's display strings. */
export const SpectrumMode = Object.freeze({
  AUTO: "Auto",
  AIR_LEAK: "Air Leak",
  WATER_LEAK: "Water Leak",
  HELIUM_LEAK: "Helium Leak",
  HYDROCARBON_BACKSTREAM: "Hydrocarbon Backstream"
});

/**
 * Accepts a key ("AIR_LEAK", "air_leak") or a display value ("Air Leak"); throws otherwise.
 * @param {unknown} mode
 * @returns {string}
 */
export function normalizeSpectrumMode(mode) {
  const s = String(mode ?? "").trim();
  const key = s.toUpperCase().replace(/[\s-]+/g, "_");
  if (key in SpectrumMode) return SpectrumMode[/** @type {keyof typeof SpectrumMode} */ (key)];
  const byValue = Object.values(SpectrumMode).find((v) => v.toLowerCase() === s.toLowerCase());
  if (byValue) return byValue;
  throw new Error(`Unknown spectrum mode '${mode}'. Supported: ${Object.keys(SpectrumMode).join(", ")}`);
}

/**
 * Above this pressure the broad background dominates and species-level interpretation
 * is not realistic; CSC only runs identification at or below it.
 */
export const OPG_ANALYSIS_MAX_PRESSURE_MBAR = 1e-2;

/**
 * Simplified optical signatures: [wavelength nm, relative weight]. Arrays rather than
 * objects so line order matches Python's dict order (JS sorts integer-like keys).
 * 🟠 The OH lines at 309/312 nm lie outside the default 380–780 nm window, so they clamp
 * to the first sample during identification. Kept for parity.
 * @type {Readonly<Record<string, readonly (readonly [number, number])[]>>}
 */
const OPTICAL_SIGNATURES = Object.freeze({
  N2: [[391.0, 0.65], [428.0, 1.0], [662.0, 0.35]],
  O2: [[577.0, 0.7], [630.0, 1.0], [762.0, 0.55]],
  Ar: [[696.0, 0.7], [706.0, 1.0], [738.0, 0.8]],
  He: [[447.0, 0.6], [588.0, 1.0], [668.0, 0.6]],
  H2O: [[720.0, 0.8], [742.0, 1.0], [760.0, 0.9]],
  OH: [[309.0, 1.0], [312.0, 0.8], [431.0, 0.45]],
  CO2: [[690.0, 0.45], [720.0, 0.9], [760.0, 1.0]],
  CH4: [[430.0, 0.7], [620.0, 0.55], [730.0, 1.0]],
  H2: [[486.0, 0.65], [656.0, 1.0]],
  CO: [[520.0, 0.5], [607.0, 1.0], [646.0, 0.45]]
});

/** Species the model knows, in CSC order. */
export const OPTICAL_SPECIES = Object.freeze(Object.keys(OPTICAL_SIGNATURES));

/**
 * Known signature wavelengths (nm) for `gas`, sorted; empty for unknown gases.
 * @param {string} gas
 * @returns {number[]}
 */
export function opticalSignatureWavelengths(gas) {
  return (OPTICAL_SIGNATURES[gas] ?? []).map(([nm]) => nm).sort((a, b) => a - b);
}

/** Baseline fractions per fixed scenario mode. @type {Record<string, Record<string, number>>} */
const SCENARIO_COMPOSITION = {
  [SpectrumMode.AIR_LEAK]: { N2: 0.72, O2: 0.2, Ar: 0.03, H2O: 0.04, OH: 0.01, CO2: 0.01 },
  [SpectrumMode.WATER_LEAK]: { H2O: 0.62, OH: 0.08, N2: 0.18, O2: 0.06, CO2: 0.06, H2: 0.08 },
  [SpectrumMode.HELIUM_LEAK]: { He: 0.78, N2: 0.14, O2: 0.04, Ar: 0.02, H2O: 0.02, OH: 0.005 },
  [SpectrumMode.HYDROCARBON_BACKSTREAM]: { CH4: 0.44, H2O: 0.26, OH: 0.04, CO: 0.14, CO2: 0.08, H2: 0.08 }
};

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** @param {number} x @param {number} mu @param {number} sigma */
function gaussian(x, mu, sigma) {
  const z = (x - mu) / Math.max(sigma, 1e-6);
  return Math.exp(-0.5 * z * z);
}

/** Python's round(): half to even. @param {number} x */
function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** @param {Record<string, number>} comp @param {boolean} clampNegative */
function normalise(comp, clampNegative) {
  const total = Object.values(comp).reduce((sum, v) => sum + Math.max(v, 0.0), 0);
  if (total <= 0) return { N2: 1.0 };
  return Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, (clampNegative ? Math.max(v, 0.0) : v) / total]));
}

/**
 * AUTO composition: air-dominant at high pressure, drifting to H2/H2O/CO in deep vacuum;
 * a rising trend suggests ambient ingress (CSC `_auto_composition`).
 * @param {number} pressureMbar @param {number} trendMbarPerS @param {number} elapsedS
 */
function autoComposition(pressureMbar, trendMbarPerS, elapsedS) {
  const logp = Math.log10(Math.max(pressureMbar, 1e-12));
  const up = Math.max(trendMbarPerS, 0.0);
  const rising = clamp(Math.log10(1.0 + up * 1e5), 0.0, 1.0);
  const airWeight = clamp((logp + 7.0) / 7.0, 0.0, 1.0);
  const drydown = Math.exp(-Math.max(elapsedS, 0.0) / 1400.0);
  return normalise(
    {
      N2: 0.4 * airWeight + 0.18 * rising,
      O2: 0.12 * airWeight + 0.05 * rising,
      Ar: 0.018 * airWeight,
      CO2: 0.02 + 0.028 * airWeight,
      H2O: 0.22 * drydown + 0.05 * airWeight,
      OH: 0.035 * drydown + (0.025 * up) / (up + 1e-5),
      H2: 0.06 + 0.11 * (1.0 - airWeight),
      CO: 0.05 + 0.06 * (1.0 - airWeight),
      CH4: 0.03 + 0.02 * (1.0 - airWeight)
    },
    false
  );
}

/**
 * Time-evolving composition for a fixed mode (CSC `_scenario_composition_evolved`).
 * @param {string} mode @param {number} elapsedS @param {number} _pressureMbar @param {number} trendMbarPerS
 */
function scenarioCompositionEvolved(mode, elapsedS, _pressureMbar, trendMbarPerS) {
  const base = { ...SCENARIO_COMPOSITION[mode] };
  const t = Math.max(elapsedS, 0.0);
  const rising = clamp(Math.log10(1.0 + Math.max(trendMbarPerS, 0.0) * 1e5), 0.0, 1.0);
  /** @param {string} k */
  const g = (k) => base[k] ?? 0.0;

  if (mode === SpectrumMode.AIR_LEAK) {
    // Outgassed H2O grows as the leak progresses, CO2 builds slowly, N2/O2 dip.
    const h2oGrowth = clamp(t / 120.0, 0.0, 0.22);
    const co2Growth = clamp(t / 480.0, 0.0, 0.07);
    const airDecay = h2oGrowth * 0.55 + co2Growth * 0.35;
    base.H2O = g("H2O") + h2oGrowth;
    base.OH = g("OH") + h2oGrowth * 0.25;
    base.CO2 = g("CO2") + co2Growth;
    base.N2 = Math.max(0.05, g("N2") - airDecay * 0.65);
    base.O2 = Math.max(0.01, g("O2") - airDecay * 0.35);
    // Rising pressure amplifies ingress signatures.
    base.N2 *= 1.0 + rising * 0.25;
    base.O2 *= 1.0 + rising * 0.18;
  } else if (mode === SpectrumMode.WATER_LEAK) {
    // H2O dominates early; thermal dissociation produces H2 over time.
    const h2Growth = clamp(t / 240.0, 0.0, 0.15);
    const co2Growth = clamp(t / 600.0, 0.0, 0.08);
    const h2oDecay = h2Growth * 0.6 + co2Growth * 0.3;
    base.H2 = g("H2") + h2Growth;
    base.OH = g("OH") + h2Growth * 0.35;
    base.CO2 = g("CO2") + co2Growth;
    base.H2O = Math.max(0.15, g("H2O") - h2oDecay);
  } else if (mode === SpectrumMode.HELIUM_LEAK) {
    // He dominates; residual N2/O2 from the earlier pumpdown diminish.
    const n2Decay = clamp(t / 300.0, 0.0, 0.08);
    base.He = Math.min(0.95, g("He") + n2Decay * 0.7);
    base.N2 = Math.max(0.02, g("N2") - n2Decay);
    base.O2 = Math.max(0.005, g("O2") - n2Decay * 0.4);
  } else if (mode === SpectrumMode.HYDROCARBON_BACKSTREAM) {
    // CH4 builds initially; CO grows as decomposition proceeds.
    const coGrowth = clamp(t / 360.0, 0.0, 0.12);
    const h2Growth = clamp(t / 300.0, 0.0, 0.1);
    base.CO = g("CO") + coGrowth;
    base.H2 = g("H2") + h2Growth;
    base.CH4 = Math.max(0.08, g("CH4") - (coGrowth * 0.5 + h2Growth * 0.4));
  }
  return normalise(base, true);
}

/**
 * Normalised optical intensities over wavelength (CSC `simulate_optical_spectrum`).
 * Returns `samples` points spanning wavelengthMinNm..wavelengthMaxNm (CSC's OPG view uses
 * 303.05–876.07 nm with 288 samples; the function defaults are 380–780 nm, 401 samples).
 * @param {number} pressureMbar
 * @param {number} trendMbarPerS
 * @param {number} elapsedS
 * @param {string} mode   a SpectrumMode key or value
 * @param {{ wavelengthMinNm?: number, wavelengthMaxNm?: number, samples?: number }} [options]
 * @returns {number[]}
 */
export function simulateOpticalSpectrum(pressureMbar, trendMbarPerS, elapsedS, mode, options = {}) {
  const { wavelengthMinNm = 380.0, wavelengthMaxNm = 780.0 } = options;
  const m = normalizeSpectrumMode(mode);
  const composition =
    m === SpectrumMode.AUTO
      ? autoComposition(pressureMbar, trendMbarPerS, elapsedS)
      : scenarioCompositionEvolved(m, elapsedS, pressureMbar, trendMbarPerS);

  // A rising pressure trend amplifies ingress signatures.
  const ingress = clamp(Math.log10(1.0 + Math.max(trendMbarPerS, 0.0) * 2e5), 0.0, 1.0);
  const samples = Math.max(Math.trunc(options.samples ?? 401), 16);
  const wavelengths = Array.from({ length: samples }, (_, i) => wavelengthMinNm + (wavelengthMaxNm - wavelengthMinNm) * (i / (samples - 1)));
  const spectrum = new Array(samples).fill(0.0);

  for (const [molecule, frac] of Object.entries(composition)) {
    const signature = OPTICAL_SIGNATURES[molecule];
    if (!signature) continue;
    const dyn = frac * (1.0 + ingress * (["N2", "O2", "Ar", "He"].includes(molecule) ? 1.2 : 0.45));
    for (const [lineNm, weight] of signature) {
      const sigmaNm = lineNm < 550 ? 4.0 : 5.5;
      for (let i = 0; i < samples; i += 1) spectrum[i] += dyn * weight * gaussian(wavelengths[i], lineNm, sigmaNm);
    }
  }

  // Small baseline for display continuity.
  for (let i = 0; i < samples; i += 1) spectrum[i] += 8e-4;

  const peak = Math.max(...spectrum);
  if (peak <= 0) return spectrum;
  return spectrum.map((v) => v / peak);
}

/** @typedef {{ name: string, score: number }} MoleculeMatch */

/**
 * Score known signatures against a normalised spectrum (CSC `identify_optical_species`).
 * Returns at most `topK` matches with score >= 0.2, best first.
 * @param {ArrayLike<number>} spectrum
 * @param {{ wavelengthMinNm?: number, wavelengthMaxNm?: number, topK?: number }} [options]
 * @returns {MoleculeMatch[]}
 */
export function identifyOpticalSpecies(spectrum, options = {}) {
  const { wavelengthMinNm = 380.0, wavelengthMaxNm = 780.0, topK = 4 } = options;
  const n = spectrum.length;
  if (n < 12) return [];

  /** @param {number} nm */
  const indexFromNm = (nm) => {
    const frac = (nm - wavelengthMinNm) / Math.max(wavelengthMaxNm - wavelengthMinNm, 1e-9);
    return pyRound(clamp(frac, 0.0, 1.0) * (n - 1));
  };

  /** @type {MoleculeMatch[]} */
  const scores = [];
  for (const [name, signature] of Object.entries(OPTICAL_SIGNATURES)) {
    const weightSum = signature.reduce((sum, [, w]) => sum + w, 0);
    if (weightSum <= 0) continue;
    let acc = 0.0;
    let missingPenalty = 0.0;
    for (const [lineNm, expected] of signature) {
      const center = indexFromNm(lineNm);
      let obs = -Infinity;
      for (let i = Math.max(0, center - 3); i <= Math.min(n - 1, center + 3); i += 1) obs = Math.max(obs, spectrum[i]);
      acc += Math.min(obs / Math.max(expected, 1e-6), 1.0) * expected;
      if (obs < 0.04 && expected >= 0.6) missingPenalty += 0.16;
    }
    const score = clamp(acc / weightSum - missingPenalty, 0.0, 1.0);
    if (score >= 0.2) scores.push({ name, score });
  }
  scores.sort((a, b) => b.score - a.score); // stable, like Python's sort
  return scores.slice(0, Math.max(1, topK));
}

/** Backward-compatible alias kept by CSC (`simulate_mass_spectrum`). */
export function simulateMassSpectrum(
  /** @type {number} */ pressureMbar,
  /** @type {number} */ trendMbarPerS,
  /** @type {number} */ elapsedS,
  /** @type {string} */ mode,
  { maxMass = 401 } = {}
) {
  return simulateOpticalSpectrum(pressureMbar, trendMbarPerS, elapsedS, mode, { samples: Math.max(maxMass, 16) });
}

/** Backward-compatible alias kept by CSC (`identify_common_molecules`). */
export function identifyCommonMolecules(/** @type {ArrayLike<number>} */ spectrum, { topK = 4 } = {}) {
  return identifyOpticalSpecies(spectrum, { topK });
}
