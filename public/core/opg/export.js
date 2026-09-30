// @ts-check
/**
 * Spectrum Studio exports, ported from CSC gauge_tab.py (`_write_opg_csv` and the per-chart
 * `_export_*_csv` helpers).
 *
 * The OPG CSV (RGD or RoR) keeps CSC's layout byte for byte: a short key/value preamble, a
 * header row, a unit row, then one row per captured sample, with the fields of each block
 * joined by ", " and the blocks joined by ",". Numbers are printed the way Python's str()
 * prints them, so a file from the browser and one from CSC diff cleanly.
 *
 * Deliberate differences from CSC:
 *  - CSC writes made-up bootloader and application versions ("03.01.00.0063",
 *    "01.00.28.0184") when the gauge has not been read; here those fields stay empty.
 *  - CSC always writes AnalogOut 0 and IntegrationTime 0.0; here they carry the last analog
 *    output reading (mV) and the record's integration time (ms) when known.
 *  - The single-spectrum CSV calls its second column relative_intensity (CSC: intensity_counts),
 *    because the values are normalised to a peak of 1.
 */
import { convertPressure, isPressureUnit } from "../units.js";
import {
  ROR_WAVELENGTH_MAX_NM,
  ROR_WAVELENGTH_MIN_NM,
  SPECTRUM_SAMPLES,
  STUDIO_GASES,
  WAVELENGTH_MAX_NM,
  WAVELENGTH_MIN_NM,
  interp,
  linspace
} from "./spectrum-studio.js";

const RGD_SPECIES = ["Hydrogen", "Helium", "Nitrogen", "Oxygen", "Argon", "NH", "OH", "CH", "CO", "Fluor"];
const RGD_RATIOS = [
  "391nm N2+ vs  311nm OH", "336nm N2 vs 311nm OH", "391nm N2+ vs 656nm H", "336nm N2 vs 656nm H",
  "391nm N2+ vs 810nm Ar", "777nm O vs 810nm Ar", "502nm He vs 336nm N2", "777nm O vs 336nm N2"
];
const ROR_LINES_NM = [777.0, 812.0, 822.0, 870.0, 337.0, 656.0];
const ROR_LINE_LABELS = ["O2 777nm", "Ar 812nm", "N2 822nm", "N2 870nm", "N2 337nm", "H 656nm", "pressure Rise"];
const COMMON_HEADERS = ["Timestamp", "Time", "TotalPressure", "AnalogOut", "IntegrationTime"];
const COMMON_UNITS = ["[timestamp]", "[sec]", "[mbar]", "[mV]", "[ms]"];
const MBAR_TO_MTORR = 750.062;

/**
 * Python's str() of a float: shortest round-trip digits, ".0" on whole numbers, scientific
 * notation below 1e-4 and from 1e16 ("1e-05", "1.5e+16").
 * @param {number} x
 */
export function pyFloat(x) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [m, eText] = x.toExponential().split("e");
  const e = Number(eText);
  const neg = m.startsWith("-");
  const digits = m.replace("-", "").replace(".", "");
  let s;
  if (e < -4 || e >= 16) {
    s = `${digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  } else if (e < 0) {
    s = `0.${"0".repeat(-e - 1)}${digits}`;
  } else if (digits.length <= e + 1) {
    s = `${digits}${"0".repeat(e + 1 - digits.length)}.0`;
  } else {
    s = `${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`;
  }
  return neg ? `-${s}` : s;
}

/** Local "YYYY-MM-DD HH:MM:SS.ffffff" (strftime "%Y-%m-%d %H:%M:%S.%f"). @param {number} ms */
export function pyTimestamp(ms) {
  const d = new Date(ms);
  const p = (/** @type {number} */ n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds() * 1000, 6)}`;
}

/** Local "YYYYMMDD_HHMM". @param {number} ms */
function stampShort(ms) {
  const d = new Date(ms);
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Floats print as Python floats; everything else as text. @param {any} v */
function field(v) {
  return typeof v === "number" ? pyFloat(v) : String(v);
}

/** Integer fields (Python int) print without ".0". */
class Int {
  /** @param {number} v */
  constructor(v) {
    this.v = Math.trunc(v);
  }
  toString() {
    return String(this.v);
  }
}

/** @param {any[]} values @param {number[]} blocks */
export function joinBlocks(values, blocks) {
  const fields = values.map((v) => (v instanceof Int ? v.toString() : field(v)));
  const out = [];
  let pos = 0;
  for (const size of blocks) {
    out.push(fields.slice(pos, pos + size).join(", "));
    pos += size;
  }
  return out.join(",");
}

/**
 * A spectrum resampled onto the 288-pixel export grid and scaled by 10000 (CSC
 * `_spectrum_values_288`).
 * @param {{ x: ArrayLike<number>, y: ArrayLike<number> }} s @param {number} min @param {number} max
 */
export function spectrumValues288(s, min, max) {
  const x = linspace(min, max, SPECTRUM_SAMPLES);
  const y = Array.from(x, (at) => interp(s.x, s.y, at) * 10000);
  return { x: Array.from(x), y };
}

/** @param {number} num @param {number} den */
const safeRatio = (num, den) => (den > 1e-12 ? num / den : 0);

/** CSC `_opg_ratio_values`. @param {Record<string, number>} pct */
export function ratioValues(pct) {
  const g = (/** @type {string} */ k) => Number(pct[k] ?? 0);
  return [
    safeRatio(g("N2"), g("OH")), safeRatio(g("N2"), g("OH")), safeRatio(g("N2"), g("H2")), safeRatio(g("N2"), g("H2")),
    safeRatio(g("N2"), g("Ar")), safeRatio(g("O2"), g("Ar")), safeRatio(g("He"), g("N2")), safeRatio(g("O2"), g("N2"))
  ];
}

/**
 * OPG CSV in CSC's RGD or RoR layout.
 * @param {import("./spectrum-studio.js").OpgStudioState} studio
 * @param {"rgd" | "ror"} kind
 * @returns {string | null} null when there is nothing to export
 */
export function opgCsv(studio, kind) {
  const samples = studio.exportSamples.filter((s) => studio.spectrumOf(s));
  if (!samples.length) return null;
  const serialDigits = (studio.identity.serial.match(/\d/g) ?? []).join("").slice(-9).padStart(9, "0");
  const ror = kind === "ror";
  const [min, max] = ror ? [ROR_WAVELENGTH_MIN_NM, ROR_WAVELENGTH_MAX_NM] : [WAVELENGTH_MIN_NM, WAVELENGTH_MAX_NM];
  const grid = linspace(min, max, SPECTRUM_SAMPLES);
  const headers = [...COMMON_HEADERS, ...Array.from(grid, (w) => w.toFixed(2))];
  const units = [...COMMON_UNITS, ...Array(SPECTRUM_SAMPLES).fill("[counts/sec]")];
  /** @type {number[]} */
  let blocks;
  if (ror) {
    headers.push(...ROR_LINE_LABELS);
    units.push(...Array(6).fill("-"), "[mTorr/min]");
    blocks = [5, SPECTRUM_SAMPLES, 6, 1];
  } else {
    headers.push(...RGD_SPECIES, ...RGD_SPECIES, ...RGD_RATIOS);
    units.push(...Array(10).fill("[counts/sec]"), "mbar", ...Array(9).fill(" mbar"), ...Array(8).fill("--"));
    blocks = [5, SPECTRUM_SAMPLES, 10, 10, 8];
  }
  const lines = [
    `Timestamp,${stampShort(samples[0].t)}`,
    `Measurement Type,${ror ? "RoR Leak Detection Measurement" : "RGD Measurement"}`,
    `serial number,${serialDigits}`,
    `bootloader version,${studio.identity.bootloader}`,
    `application version,${studio.identity.firmware}`,
    "",
    headers.join(","),
    units.join(",")
  ];
  /** @type {import("./spectrum-studio.js").ExportSample | null} */
  let previous = null;
  for (const sample of samples) {
    const spectrum = /** @type {any} */ (studio.spectrumOf(sample));
    const { x, y } = spectrumValues288(spectrum, min, max);
    const common = [
      pyTimestamp(sample.t),
      sample.timeS,
      sample.pressureMbar,
      new Int(sample.analogMv ?? 0),
      sample.integrationMs ?? 0
    ];
    if (ror) {
      const intensities = ROR_LINES_NM.map((nm) => interp(x, y, nm));
      let rise = 0;
      if (previous) {
        const dt = sample.timeS - previous.timeS;
        if (dt > 0) rise = ((sample.pressureMbar - previous.pressureMbar) * MBAR_TO_MTORR * 60) / dt;
      }
      lines.push(joinBlocks([...common, ...y, ...intensities, rise], blocks));
    } else {
      const g = (/** @type {string} */ k) => Number(sample.gasPct[k] ?? 0);
      const speciesPct = [g("H2"), g("He"), g("N2"), g("O2"), g("Ar"), 0, g("OH"), g("CH4"), g("CO"), 0];
      lines.push(joinBlocks([...common, ...y, ...speciesPct.map((p) => p * 100), ...speciesPct.map((p) => (sample.pressureMbar * p) / 100), ...ratioValues(sample.gasPct)], blocks));
    }
    previous = sample;
  }
  return `${lines.join("\n")}\n`;
}

/** @param {number} v @param {string} unit */
const toUnit = (v, unit) => (isPressureUnit(unit) ? convertPressure(v, "mbar", unit) : v);

/**
 * Trend chart CSV (CSC `_export_trend_csv`): time since the studio's start and the filtered
 * OPG550 pressure in the display unit.
 * @param {import("./spectrum-studio.js").OpgStudioState} studio @param {string} unit @param {string} [header]
 */
export function trendCsv(studio, unit, header = "") {
  const s = studio.pressure;
  if (!s.length) return null;
  const rows = [`time_s,pressure_${unit},ror_${unit}_per_s`];
  for (let i = 0; i < s.length; i += 1) rows.push(`${studio.elapsedS(s.t[i]).toFixed(6)},${toUnit(s.v[i], unit).toExponential(6)},${toUnit(studio.ror.v[i], unit).toExponential(6)}`);
  return withHeader(header, rows);
}

/** Latest spectrum CSV (CSC `_export_spectrum_csv`). @param {import("./spectrum-studio.js").OpgStudioState} studio @param {string} [header] */
export function spectrumCsv(studio, header = "") {
  const s = studio.spectrum;
  if (!s) return null;
  const rows = ["wavelength_nm,relative_intensity"];
  for (let i = 0; i < s.x.length; i += 1) rows.push(`${s.x[i].toFixed(4)},${s.y[i].toExponential(6)}`);
  return withHeader(header ? `${header}\n# Spectrum: ${s.source === "live" ? `live (${s.command ?? "record"}${s.recordId != null ? ` ${s.recordId}` : ""})` : `simulated (${s.mode})`}` : "", rows);
}

/** Tracked-gas history CSV (CSC `_export_gas_csv`). @param {import("./spectrum-studio.js").OpgStudioState} studio @param {string} [header] */
export function gasCsv(studio, header = "") {
  const first = studio.gasPct[STUDIO_GASES[0]];
  if (!first.length) return null;
  const rows = [["time_s", ...STUDIO_GASES.flatMap((g) => [`${g}_partial_mbar`, `${g}_pct`])].join(",")];
  for (let i = 0; i < first.length; i += 1) {
    const cells = [studio.elapsedS(first.t[i]).toFixed(6)];
    for (const g of STUDIO_GASES) cells.push((studio.gasPartial[g].v[i] ?? 0).toExponential(6), (studio.gasPct[g].v[i] ?? 0).toFixed(4));
    rows.push(cells.join(","));
  }
  return withHeader(header, rows);
}

/**
 * Correlation chart CSV (CSC `_export_advanced_csv`): one row per sample of every source, in
 * the display unit.
 * @param {import("./spectrum-studio.js").OpgStudioState} studio
 * @param {{ name: string, series: import("../store/buffers.js").Series }[]} sources
 * @param {string} unit @param {string} [header]
 */
export function advancedCsv(studio, sources, unit, header = "") {
  if (!sources.some((s) => s.series.length)) return null;
  const rows = [`series,time_s,pressure_${unit}`];
  for (const { name, series } of sources) {
    const from = isPressureUnit(series.unit) ? series.unit : "mbar";
    for (let i = 0; i < series.length; i += 1) rows.push(`${csvText(name)},${studio.elapsedS(series.t[i]).toFixed(6)},${convertPressure(series.v[i], from, unit).toExponential(6)}`);
  }
  return withHeader(header, rows);
}

/** @param {string} header @param {string[]} rows */
function withHeader(header, rows) {
  return `${header ? `${header}\n` : ""}${rows.join("\n")}\n`;
}

/** @param {string} s */
function csvText(s) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
