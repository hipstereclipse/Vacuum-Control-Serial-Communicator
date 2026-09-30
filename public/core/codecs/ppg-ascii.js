// @ts-check
/**
 * PPG ASCII protocol codec — INFICON PPG550 / PPG570.
 * One-to-one port of CSC src/serial_comm/protocols/ppg_ascii.py, plus the ACK helpers
 * from GUI/gauge_workspace/port_scanner.py (`_ppg_is_ack`, `_ppg_data`).
 *
 *   Request:  @{addr:03d}{mnemonic}{? | !}{query_param | write_prefix + value}\
 *   Response: @ACK{data}\  or  @NAK{reason}\   (some firmware: @253ACK...\)
 *
 *   addr 254 is the broadcast / RS232 default. Backslash (0x5C) terminates; no checksum.
 */
import { terminatorFramer } from "../framers/terminator.js";
import { ascii, printable } from "../bytes.js";
import { err, info, ok } from "../models.js";
import { commandsFromSpec, formatPressure } from "./common.js";

export const TERMINATOR = 0x5c;
export const BROADCAST_ADDRESS = 254;

/** Status words a gauge returns instead of a number (CSC `_PRESSURE_STATUS`). */
export const PPG_PRESSURE_STATUS = Object.freeze([
  "UR", "UNDERRANGE",
  "OR", "OVERRANGE",
  "NO SENSOR", "NS",
  "WAIT",
  "HV OFF",
  "LO SN",
  "ATM",
  "ERR",
  "PROG"
]);

/** Fallback table when no spec is supplied: command -> [mnemonic, writable, unit] (CSC `_MNEMONIC_DEFAULTS`). */
export const PPG_MNEMONIC_DEFAULTS = Object.freeze({
  pressure: ["PR3", false, "mbar"],
  temperature: ["T", false, "°C"],
  software_version: ["FV", false, ""],
  serial_number: ["SN", false, ""],
  unit: ["U", true, ""],
  zero_adjust: ["VAC", true, ""],
  piezo_adjust: ["FS", true, ""],
  atm_pressure: ["PR4", false, "mbar"],
  combined_pressure: ["PR1", false, "mbar"],
  atm_zero: ["ATZ", true, ""],
  atm_full_scale: ["ATD", true, ""]
});

/**
 * Risk classes for specs without a `risk` field (plan 5.4 and 11): U caution; adjustments,
 * factory default, address, baud and setpoint writes danger.
 */
const DANGER_MNEMONICS = new Set(["VAC", "FS", "ATZ", "ATD", "FD", "ADR", "BR", "BAUD"]);
const SETPOINT_MNEMONIC = /^(SP\d?|SPV|SPH|SPD|SPE|SPS|SD\d|EN\d|SH\d)$/;

const PRESSURE_UNITS = new Set(["mbar", "Torr", "Pa", "hPa", "psi"]);

/**
 * A request frame, as the scanner's probes are written (`@254FV?\`).
 * @param {string} mnemonic @param {number} [address] @param {"?" | "!"} [action] @param {string} [suffix]
 */
export function ppgRequest(mnemonic, address = BROADCAST_ADDRESS, action = "?", suffix = "") {
  return ascii(`@${pad3(address)}${mnemonic}${action}${suffix}\\`);
}

/** True for `@ACK...\` and address-prefixed `@253ACK...\` (CSC `_ppg_is_ack`). @param {Uint8Array} raw */
export function isPpgAck(raw) {
  const t = latin(raw);
  if (t.startsWith("@ACK")) return true;
  return t.length >= 8 && t[0] === "@" && /^\d{3}$/.test(t.slice(1, 4)) && t.slice(4, 7) === "ACK";
}

/** Data from `@ACK...\` or `@dddACK...\` (CSC `_ppg_data`); "" for anything else. @param {Uint8Array} raw */
export function ppgData(raw) {
  const t = latin(raw);
  let payload = "";
  if (t.startsWith("@ACK")) payload = t.slice(4, -1);
  else if (isPpgAck(raw)) payload = t.slice(7, -1);
  return replaceNonAscii(payload).trim();
}

/** Backslash-terminated frames. */
export function ppgFramer() {
  return terminatorFramer({ terminator: TERMINATOR, maxLength: 256 });
}

/**
 * @param {any} spec   device spec (CSC YAML keys), or null for the built-in fallback table
 * @param {{ address?: number }} [options]
 * @returns {import("../models.js").Codec & {
 *   gaugeType: string,
 *   mnemonicFor: (command: string) => { mnemonic: string, queryParam: string },
 *   runtimeOverrides: () => { mnemonic: Record<string, string>, queryParam: Record<string, string> },
 * }}
 */
export function createPpgCodec(spec = null, options = {}) {
  const address = Number(options.address ?? spec?.transport?.default_address ?? BROADCAST_ADDRESS);
  const gaugeType = spec?.model ?? "PPG550";

  /** @type {Map<string, { mnemonic: string, writable: boolean, unit: string, queryParam: string, writePrefix: string }>} */
  const table = new Map();
  if (spec?.commands && Object.keys(spec.commands).length) {
    for (const [name, c] of Object.entries(spec.commands)) {
      if (!c?.mnemonic) continue;
      table.set(name, {
        mnemonic: String(c.mnemonic),
        writable: Boolean(c.write),
        unit: c.unit ?? "",
        // Python `str(x or "")`: a falsy query_param (0, "") becomes "".
        queryParam: c.query_param ? String(c.query_param) : "",
        writePrefix: c.write_prefix ? String(c.write_prefix) : ""
      });
    }
  } else {
    for (const [name, [mnemonic, writable, unit]] of Object.entries(PPG_MNEMONIC_DEFAULTS)) {
      table.set(name, { mnemonic, writable, unit, queryParam: "", writePrefix: "" });
    }
  }

  /** Runtime fallbacks learned from UNKNOWN COMMAND replies (CSC `_runtime_*_override`). */
  /** @type {Record<string, string>} */
  const mnemonicOverride = {};
  /** @type {Record<string, string>} */
  const queryParamOverride = {};
  /** @type {Set<string>} */
  const pressureFallbackTried = new Set();

  /** @param {string} name */
  function mnemonicFor(name) {
    const entry = table.get(name);
    if (!entry) throw new Error(`PPGProtocol: unknown command '${name}'`);
    return {
      mnemonic: mnemonicOverride[name] ?? entry.mnemonic,
      queryParam: name in queryParamOverride ? queryParamOverride[name] : entry.queryParam
    };
  }

  /**
   * Auto-recover from pressure mnemonic mismatches (CSC `_maybe_adapt_on_unknown_command`):
   * pressure swaps PR3 <-> P once each way; pressure_combined downgrades P?CMB to P?.
   * @param {string} name @param {string} reason
   */
  function maybeAdaptOnUnknownCommand(name, reason) {
    if (name !== "pressure" && name !== "pressure_combined") return;
    if (!reason.replace(/ /g, "").toUpperCase().includes("UNKNOWNCOMMAND")) return;
    if (name === "pressure_combined") {
      if (queryParamOverride.pressure_combined !== "") {
        queryParamOverride.pressure_combined = "";
        mnemonicOverride.pressure_combined = "P";
      }
      return;
    }
    const base = table.get("pressure");
    if (!base) return;
    const current = (mnemonicOverride.pressure ?? base.mnemonic).toUpperCase();
    if (current === "PR3" && !pressureFallbackTried.has("P")) {
      mnemonicOverride.pressure = "P";
      pressureFallbackTried.add("P");
      return;
    }
    if (current === "P" && !pressureFallbackTried.has("PR3")) {
      mnemonicOverride.pressure = "PR3";
      pressureFallbackTried.add("PR3");
    }
  }

  /** @param {string} data @param {Uint8Array} raw @param {string} unit */
  function decodePressure(data, raw, unit) {
    const upper = data.trim().toUpperCase();
    if (PPG_PRESSURE_STATUS.includes(upper)) return err(`Gauge status: ${data}`, raw, { status: upper });
    const v = pyFloat(data);
    // Unknown non-numeric string: report it without crashing.
    if (v === null) return err(`Unexpected response: '${data}'`, raw);
    return ok(v, unit, formatPressure(v, unit), raw);
  }

  /** @param {string} name @param {string} data @param {Uint8Array} raw */
  function decode(name, data, raw) {
    const unit = table.get(name)?.unit ?? "";
    // Route by unit, as CSC does. 🟠 This also applies to write replies, so a bare "@ACK\"
    // after a setpoint write (unit mbar) reports "Unexpected response: ''" as a failure.
    if (PRESSURE_UNITS.has(unit)) return decodePressure(data, raw, unit);
    if (unit === "°C" || unit === "degC") {
      const v = pyFloat(data);
      if (v === null) return err(`Parse error for '${name}': could not convert string to float: '${data}'`, raw);
      return ok(v, unit, `${v.toFixed(1)} ${unit}`, raw);
    }
    return info(data || "OK", raw, { text: data });
  }

  return {
    protocol: "ppg_ascii",
    address,
    gaugeType,
    framer: ppgFramer,
    supportsContinuousOutput: () => false,
    mnemonicFor,
    runtimeOverrides: () => ({ mnemonic: { ...mnemonicOverride }, queryParam: { ...queryParamOverride } }),
    buildRequest(name, value) {
      const entry = table.get(name);
      if (!entry) throw new Error(`PPGProtocol: unknown command '${name}'`);
      const { mnemonic, queryParam } = mnemonicFor(name);
      // CSC: None means read; any other value (even "", as for VAC!) is a write.
      const isWrite = value !== undefined && value !== null;
      if (isWrite && !entry.writable) throw new Error(`PPGProtocol: command '${name}' is read-only`);
      const action = isWrite ? "!" : "?";
      const suffix = isWrite ? `${entry.writePrefix}${value}` : queryParam;
      return ascii(`@${pad3(address)}${mnemonic}${action}${suffix}\\`);
    },
    parseResponse(raw, name) {
      if (!raw || raw.length === 0) return err("No response received", raw ?? new Uint8Array(0));
      const t = latin(raw).replace(/[\r\n]+$/, "");
      if (!t.endsWith("\\")) return err(`Missing terminator; got ${printable(raw)}`, raw);
      let body = t.slice(0, -1);
      /** @type {Record<string, any>} */
      const extra = {};
      // Some firmware includes the address: "@253ACK...\" -> "@ACK...\".
      if (body.length >= 7 && body[0] === "@" && /^\d{3}$/.test(body.slice(1, 4)) && (body.slice(4, 7) === "ACK" || body.slice(4, 7) === "NAK")) {
        extra.responseAddress = Number(body.slice(1, 4));
        body = `@${body.slice(4)}`;
      }
      if (body.startsWith("@NAK")) {
        const reason = replaceNonAscii(body.slice(4)).trim();
        maybeAdaptOnUnknownCommand(name, reason);
        return err(`NAK: ${reason || "(no reason)"}`, raw, { ...extra, nak: reason });
      }
      if (!body.startsWith("@ACK")) return err(`Unexpected prefix: ${printable(raw)}`, raw);
      const reading = decode(name, replaceNonAscii(body.slice(4)).trim(), raw);
      reading.extra = { ...extra, ...reading.extra };
      return reading;
    },
    matchesResponse(frame, _name) {
      const t = latin(frame);
      if (!t.endsWith("\\")) return false;
      if (t.startsWith("@ACK") || t.startsWith("@NAK")) return true;
      const m = /^@(\d{3})(ACK|NAK)/.exec(t);
      if (!m) return false;
      // On an RS485 bus an address-prefixed reply must come from our gauge.
      return address === BROADCAST_ADDRESS || Number(m[1]) === address;
    },
    validateFrame(frame) {
      const t = latin(frame);
      const m = /^@(\d{3})([A-Z0-9]+)([?!])(.*)\\$/s.exec(t);
      if (!m) return { ok: false, detail: "A PPG request is @<3-digit address><mnemonic><? or !><param>\\" };
      if (m[4].includes("\\")) return { ok: false, detail: "Backslash is the terminator and cannot appear in the parameter" };
      return { ok: true, detail: `${m[3] === "?" ? "Read" : "Write"} ${m[2]} at address ${m[1]}` };
    },
    commands() {
      const fromSpec = commandsFromSpec(spec);
      if (fromSpec.length) {
        return fromSpec.map((c) => (spec.commands[c.name]?.risk ? c : { ...c, risk: riskFor(spec.commands[c.name]?.mnemonic, c.write) }));
      }
      return Object.entries(PPG_MNEMONIC_DEFAULTS).map(([name, [mnemonic, writable, unit]]) => ({
        name,
        read: true, // CSC lets any fallback command be read with "?"
        write: writable,
        unit,
        risk: riskFor(mnemonic, writable),
        description: `${mnemonic}${writable ? "!" : "?"}`
      }));
    }
  };
}

/** @param {string | undefined} mnemonic @param {boolean} writable @returns {"safe" | "caution" | "danger"} */
function riskFor(mnemonic, writable) {
  if (!writable) return "safe";
  const m = String(mnemonic ?? "").toUpperCase();
  if (DANGER_MNEMONICS.has(m) || SETPOINT_MNEMONIC.test(m)) return "danger";
  return "caution";
}

/** Python float() of a string; null when invalid. @param {string} s */
function pyFloat(s) {
  const t = String(s).trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (special) return special[2].toLowerCase() === "nan" ? NaN : special[1] === "-" ? -Infinity : Infinity;
  return null;
}

/** @param {number} n */
function pad3(n) {
  const v = Math.trunc(n);
  return v < 0 ? `-${String(-v).padStart(2, "0")}` : String(v).padStart(3, "0");
}

/** Python `.decode("ascii", errors="replace")`. @param {string} s */
function replaceNonAscii(s) {
  return s.replace(/[\x80-\xff]/g, "�");
}

/** @param {Uint8Array} bytes */
function latin(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
