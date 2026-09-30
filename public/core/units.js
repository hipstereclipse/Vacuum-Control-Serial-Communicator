// @ts-check
/**
 * Pressure-unit helpers for display conversion. Port of CSC src/serial_comm/units.py.
 *
 * Everything inside the tool (simulation physics, stored readings, setpoint evaluation)
 * stays in mbar, as CSC does; these helpers only turn an mbar value into the unit the
 * user picked for display, and back.
 *
 *   value_in_mbar = value_in_unit * TO_MBAR[unit]
 *
 * Differences from units.py: "micron" (1 micron Hg = 1 mTorr = Torr / 1000) is added,
 * and unit lookup is case-insensitive ("torr", "TORR", "PA" all work), where CSC is
 * case-sensitive.
 */

/** Canonical ordering for UI selectors (CSC SUPPORTED_UNITS plus "micron"). */
export const PRESSURE_UNITS = Object.freeze(["mbar", "Torr", "Pa", "hPa", "micron", "psi"]);

/** Factor that converts a value *in that unit* to mbar (CSC `_TO_MBAR`). */
export const TO_MBAR = Object.freeze({
  mbar: 1.0,
  Torr: 1.33322387415, // 1 Torr == 1.33322387415 mbar
  Pa: 0.01, // 1 Pa == 0.01 mbar
  hPa: 1.0, // 1 hPa == 1 mbar exactly
  micron: 1.33322387415 / 1000, // 1 micron Hg == 1 mTorr
  psi: 68.9475729317831 // 1 psi == 68.9475729 mbar
});

/** Lower-case spelling -> canonical unit. The extra aliases are common spellings of the same units. */
const ALIASES = (() => {
  /** @type {Record<string, string>} */
  const map = {};
  for (const unit of PRESSURE_UNITS) map[unit.toLowerCase()] = unit;
  map.microns = "micron";
  map.mtorr = "micron";
  return map;
})();

/**
 * Canonical spelling of a pressure unit, or null when it is not one.
 * @param {unknown} unit
 * @returns {string | null}
 */
export function normalizeUnit(unit) {
  if (typeof unit !== "string") return null;
  return ALIASES[unit.trim().toLowerCase()] ?? null;
}

/** @param {unknown} unit */
export function isPressureUnit(unit) {
  return normalizeUnit(unit) !== null;
}

/** @param {string} unit */
function factor(unit) {
  const canonical = normalizeUnit(unit);
  if (canonical === null) {
    throw new Error(`Unsupported pressure unit '${unit}'. Supported: ${PRESSURE_UNITS.join(", ")}`);
  }
  return TO_MBAR[/** @type {keyof typeof TO_MBAR} */ (canonical)];
}

/**
 * @param {number} value
 * @param {string} unit
 */
export function toMbar(value, unit) {
  return value * factor(unit);
}

/**
 * @param {number} mbar
 * @param {string} unit
 */
export function fromMbar(mbar, unit) {
  return mbar / factor(unit);
}

/**
 * Convert `value` from one pressure unit to another. Returns `value` unchanged when both
 * units are the same (CSC's fast path, which keeps mbar -> mbar exact). Throws on an
 * unknown unit, as units.py raises ValueError.
 * @param {number} value
 * @param {string} from
 * @param {string} to
 */
export function convertPressure(value, from, to) {
  const a = factor(from);
  const b = factor(to);
  if (normalizeUnit(from) === normalizeUnit(to)) return value;
  return (value * a) / b;
}

/**
 * Python's `%.{p}g`: `p` significant digits, trailing zeros removed, scientific notation
 * when the exponent is < -4 or >= p, two-digit exponent ("1.5e+04").
 * @param {number} value
 * @param {number} [precision]
 */
export function formatG(value, precision = 6) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const p = Math.max(1, Math.trunc(precision));
  const exp = Math.floor(Math.log10(Math.abs(Number(value.toPrecision(p)))));
  if (exp < -4 || exp >= p) {
    const [mant, e] = value.toExponential(p - 1).split("e");
    return `${stripZeros(mant)}e${pyExponent(e)}`;
  }
  return stripZeros(value.toFixed(Math.max(0, p - 1 - exp)));
}

/** @param {string} s */
function stripZeros(s) {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** "-6" -> "-06", "+4" -> "+04" (Python always prints at least two exponent digits). @param {string} e */
function pyExponent(e) {
  const sign = e.startsWith("-") ? "-" : "+";
  const digits = e.replace(/^[+-]/, "");
  return sign + digits.padStart(2, "0");
}

/**
 * CSC `format_pressure`: scientific notation below 1e-2, compact `%g` otherwise.
 * `digits` has CSC's meaning of `sig`: digits after the point in scientific form
 * ("1.2300e-06 mbar"), significant digits in compact form ("1013 mbar").
 * @param {number} value
 * @param {string} unit
 * @param {number} [digits]
 */
export function formatPressure(value, unit, digits = 4) {
  if (!Number.isFinite(value)) return `— ${unit}`.trim();
  if (Math.abs(value) < 1e-2) {
    const [mant, e] = value.toExponential(digits).split("e");
    return `${mant}e${pyExponent(e)} ${unit}`;
  }
  return `${formatG(value, digits)} ${unit}`;
}
