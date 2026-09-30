// @ts-check
/**
 * Pfeiffer ASCII parameter protocol codec — INFICON BCG450, BCG552 (gauge side), OPG550
 * gauge side, and the Pfeiffer TC600 drive unit. One-to-one port of CSC
 * src/serial_comm/protocols/pfeiffer_ascii.py (PM 800 488 BN / TIRA89E1), plus the
 * response validation and helpers from GUI/gauge_workspace/port_scanner.py.
 *
 *   [Addr:3][Action:2][Param:3][DataLen:2][Data:n][Checksum:3] CR
 *
 *   Action    "00" read request, "10" write request or response ("11" also accepted as a response)
 *   Data      "=?" (length 02) for reads
 *   Checksum  sum of every preceding character mod 256, three decimal digits
 *   Errors    "NO_DEF", "_RANGE", "_LOGIC" in the data field
 */
import { asciiSum } from "../checks/sum8.js";
import { terminatorFramer } from "../framers/terminator.js";
import { ascii } from "../bytes.js";
import { err, info, ok } from "../models.js";
import { commandsFromSpec, formatPressure } from "./common.js";

export const TERMINATOR = 0x0d;
export const READ_ACTION = "00";
export const WRITE_ACTION = "10";
export const READ_PAYLOAD = "=?";
/** Actions a device sends back; anything else (our own "00" request echoed) is not a response. */
export const RESPONSE_ACTIONS = Object.freeze(["10", "11"]);
export const ERROR_SUBSTRINGS = Object.freeze(["NO_DEF", "_RANGE", "_LOGIC"]);

/**
 * Build a frame from its fields (CSC `build_request`).
 * @param {number} address @param {string} action @param {number} param @param {string} data
 */
export function pfeifferFrame(address, action, param, data) {
  const body = `${pad(address, 3)}${action}${pad(param, 3)}${pad(data.length, 2)}${data}`;
  return ascii(`${body}${pad(asciiSum(body), 3)}\r`);
}

/**
 * Read request for a parameter, as the scanner's `_pfa_read_frame` builds it.
 * `pfeifferReadFrame(309)` is `0010030902=?107` + CR.
 * @param {number} param @param {number} [address]
 */
export function pfeifferReadFrame(param, address = 1) {
  return pfeifferFrame(address, READ_ACTION, param, READ_PAYLOAD);
}

/**
 * True only for a well-formed *response* frame (CSC port_scanner.py `_valid_pfeiffer_frame`):
 * numeric address, action "10" or "11", numeric length, exact total length, valid checksum,
 * CR-terminated. An echoed request (action "00") never validates.
 * @param {Uint8Array} frame
 */
export function isValidPfeifferResponse(frame) {
  if (!frame || frame.length < 14) return false;
  if (frame.some((b) => b > 0x7f)) return false;
  const t = latin(frame);
  if (!/^\d{3}$/.test(t.slice(0, 3))) return false;
  if (!RESPONSE_ACTIONS.includes(t.slice(3, 5))) return false;
  if (!/^\d{2}$/.test(t.slice(8, 10))) return false;
  if (t.length !== 14 + Number(t.slice(8, 10))) return false;
  // The Python slices the checksum as text[-4:-1] and never checks the final byte is CR;
  // the terminator framer guarantees it here.
  const cs = pyInt(t.slice(-4, -1));
  return cs !== null && cs === asciiSum(t.slice(0, -4));
}

/** Data field of a validated response (CSC `_pfeiffer_data`). @param {Uint8Array} frame */
export function pfeifferData(frame) {
  const t = latin(frame);
  const n = Number(t.slice(8, 10));
  return t.slice(10, 10 + n);
}

/**
 * Fields of any frame, request or response, without validation.
 * @param {Uint8Array} frame
 */
export function pfeifferFields(frame) {
  const t = latin(frame).replace(/\r+$/, "");
  return {
    address: Number(t.slice(0, 3)),
    action: t.slice(3, 5),
    param: Number(t.slice(5, 8)),
    length: Number(t.slice(8, 10)),
    data: t.slice(10, 10 + Number(t.slice(8, 10))),
    checksum: t.slice(-3)
  };
}

/** CR-terminated frames. */
export function pfeifferFramer() {
  return terminatorFramer({ terminator: TERMINATOR, maxLength: 128, skipLeading: [0x0a] });
}

/**
 * Encode a write value for the data field (CSC `_encode_value`).
 * @param {any} value
 * @param {string} dataType
 */
export function encodePfeifferValue(value, dataType) {
  if (dataType === "boolean_old") return truthy(value) ? "111111" : "000000";
  if (dataType === "boolean_new") return truthy(value) ? "1" : "0";
  if (dataType === "u_integer") return pad(toInt(value), 6);
  if (dataType === "u_short_int") return pad(toInt(value), 3);
  // Fixed point 4.2: 1234.56 -> "123456". Python round() is round-half-even.
  if (dataType === "u_real") return pad(roundHalfEven(toFloat(value) * 100), 6);
  if (dataType === "u_expo" || dataType === "u_expo_new") {
    // 🟠 CSC writes Python "{:.2E}" (e.g. "1.20E-06", 8 characters) for both exponential
    // types, although u_expo_new is decoded from the 6-digit "mmmmee" form. Kept for parity;
    // check a u_expo_new write against PM 800 488 BN before relying on it.
    const v = toFloat(value);
    return Number.isFinite(v) ? formatPressure(v, "", 3) : v !== v ? "NAN" : v > 0 ? "INF" : "-INF";
  }
  // String: padded or truncated to 6 characters.
  return String(value).slice(0, 6).padEnd(6);
}

/**
 * Decode the data field (CSC `_decode_value`).
 * @param {string} data
 * @param {string} dataType
 * @param {string} unit
 * @param {Uint8Array} raw
 * @param {Record<string, any>} [extra]
 * @returns {import("../models.js").Reading}
 */
export function decodePfeifferValue(data, dataType, unit, raw, extra = {}) {
  try {
    if (dataType === "boolean_old") {
      const v = data.replace(/^0+|0+$/g, "") ? 1 : 0;
      return { success: true, value: v, formatted: v ? "True" : "False", raw, extra };
    }
    if (dataType === "boolean_new") {
      const v = mustFloat(data.trim());
      return { success: true, value: v, formatted: v ? "True" : "False", raw, extra };
    }
    if (dataType === "u_integer" || dataType === "u_short_int") {
      const v = mustInt(data);
      return ok(v, unit, `${v} ${unit}`.trim(), raw, extra);
    }
    if (dataType === "u_real") {
      const v = mustInt(data) / 100;
      return ok(v, unit, `${v.toFixed(2)} ${unit}`.trim(), raw, extra);
    }
    if (dataType === "u_expo") {
      const v = mustFloat(data);
      return ok(v, unit, formatPressure(v, unit), raw, extra);
    }
    if (dataType === "u_expo_new") {
      // "456711" -> 4.567 x 10^(11 - 20) = 4.567e-9
      let v;
      if (data.length === 6 && /^\d{6}$/.test(data)) v = (Number(data.slice(0, 4)) / 1000) * 10 ** (Number(data.slice(4)) - 20);
      else v = mustFloat(data);
      return ok(v, unit, formatPressure(v, unit), raw, extra);
    }
    return info(data.trim(), raw, { ...extra, text: data.trim() });
  } catch (e) {
    return err(`Decode error (${dataType}): ${/** @type {Error} */ (e).message}`, raw, extra);
  }
}

/**
 * @param {any} spec   device spec (CSC YAML keys), or null
 * @param {{ address?: number }} [options]
 * @returns {import("../models.js").Codec & { params: Record<string, any> }}
 */
export function createPfeifferAsciiCodec(spec = null, options = {}) {
  const address = Number(options.address ?? spec?.transport?.default_address ?? 1);
  /** @type {Record<string, any>} */
  const params = spec?.commands ?? {};

  /** @param {string} name */
  function command(name) {
    const cmd = params[name];
    if (!cmd) throw new Error(`PfeifferAsciiProtocol: unknown command '${name}'`);
    if (cmd.pid == null) throw new Error(`PfeifferAsciiProtocol: command '${name}' has no pid`);
    return cmd;
  }

  return {
    protocol: "pfeiffer_ascii",
    address,
    params,
    framer: pfeifferFramer,
    supportsContinuousOutput: () => false,
    buildRequest(name, value) {
      const cmd = command(name);
      const pid = Number(cmd.pid);
      // CSC: None means read; any other value (even "") is a write.
      if (value === undefined || value === null) return pfeifferFrame(address, READ_ACTION, pid, READ_PAYLOAD);
      if (!cmd.write) throw new Error(`Command '${name}' (PID ${pid}) is read-only`);
      return pfeifferFrame(address, WRITE_ACTION, pid, encodePfeifferValue(value, cmd.data_type ?? "string"));
    },
    parseResponse(raw, name) {
      if (!raw || raw.length === 0) return err("No response received");
      if (raw.some((b) => b > 0x7f)) return err(`Non-ASCII response: ${latin(raw)}`, raw);
      const t = latin(raw).replace(/\r+$/, "");
      // Minimum: 3+2+3+2+0+3 = 13 characters (empty data).
      if (t.length < 13) return err(`Response too short: '${t}'`, raw);
      const csField = t.slice(-3);
      const received = pyInt(csField);
      if (received === null) return err(`Malformed checksum field: '${csField}'`, raw);
      const expected = asciiSum(t.slice(0, -3));
      if (expected !== received) return err(`Checksum mismatch: expected ${pad(expected, 3)}, got ${pad(received, 3)}`, raw);

      const action = t.slice(3, 5);
      const extra = { address: Number(t.slice(0, 3)), action, param: Number(t.slice(5, 8)) };
      // Web addition (port_scanner.py `_valid_pfeiffer_frame`): our own request echoed back is not a reply.
      if (!RESPONSE_ACTIONS.includes(action)) return err(`Received a request frame (action ${action}), not a response`, raw, extra);

      const lenField = t.slice(8, 10);
      const dataLen = pyInt(lenField);
      if (dataLen === null) return err(`Bad data length field: '${lenField}'`, raw, extra);
      const data = t.slice(10, 10 + dataLen);
      for (const e of ERROR_SUBSTRINGS) if (data.includes(e)) return err(`Device error: ${data}`, raw, { ...extra, deviceError: e });

      const cmd = params[name] ?? {};
      const decoded = decodePfeifferValue(data, cmd.data_type ?? "string", cmd.unit ?? "", raw, { ...extra, data });
      if (decoded.success && cmd.options?.length && decoded.value !== undefined) {
        const option = cmd.options.find((/** @type {any} */ o) => Number(o.value) === decoded.value);
        if (option) decoded.formatted = `${option.label} (${decoded.value})`;
      }
      return decoded;
    },
    matchesResponse(frame, name) {
      if (!isValidPfeifferResponse(frame)) return false;
      const cmd = params[name];
      if (!cmd || cmd.pid == null) return true;
      return Number(latin(frame).slice(5, 8)) === Number(cmd.pid);
    },
    validateFrame(frame) {
      const t = latin(frame);
      if (!t.endsWith("\r")) return { ok: false, detail: "A Pfeiffer ASCII frame ends with CR" };
      const body = t.slice(0, -1);
      if (!/^\d{3}\d{2}\d{3}\d{2}/.test(body)) return { ok: false, detail: "Expected addr(3) action(2) param(3) length(2) as digits" };
      const n = Number(body.slice(8, 10));
      if (body.length !== 13 + n) return { ok: false, detail: `Length field ${pad(n, 2)} implies ${14 + n} bytes, frame has ${t.length}` };
      const calc = asciiSum(body.slice(0, -3));
      const good = pyInt(body.slice(-3)) === calc;
      return { ok: good, detail: good ? "Checksum OK" : `Checksum should be ${pad(calc, 3)}` };
    },
    commands: () => commandsFromSpec(spec)
  };
}

// ── Python-compatible helpers ─────────────────────────────────────────────

/** Zero-padded decimal, Python "{:0Nd}" (the sign counts towards the width). @param {number} n @param {number} width */
export function pad(n, width) {
  const v = Math.trunc(n);
  return v < 0 ? `-${String(-v).padStart(width - 1, "0")}` : String(v).padStart(width, "0");
}

/** Python int() of a string: optional whitespace and sign, decimal digits. Null when invalid. @param {string} s */
export function pyInt(s) {
  const m = /^\s*([+-]?\d+)\s*$/.exec(s);
  return m ? Number(m[1]) : null;
}

/** Python float() of a string. Null when invalid. @param {string} s */
export function pyFloat(s) {
  const t = String(s).trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (special) return special[2].toLowerCase() === "nan" ? NaN : special[1] === "-" ? -Infinity : Infinity;
  return null;
}

/** @param {string} s */
function mustInt(s) {
  const v = pyInt(s);
  if (v === null) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  return v;
}

/** @param {string} s */
function mustFloat(s) {
  const v = pyFloat(s);
  if (v === null) throw new Error(`could not convert string to float: '${s}'`);
  return v;
}

/** Python int(value): numbers truncate, strings must be integer literals. @param {any} value */
function toInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot convert ${value} to integer`);
    return Math.trunc(value);
  }
  return mustInt(String(value));
}

/** @param {any} value */
function toFloat(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  return mustFloat(String(value));
}

/**
 * Truthiness for boolean writes.
 * 🟠 CSC uses Python truthiness, so the *string* "0" would switch a boolean parameter ON.
 * Its own turbo terminal converts numeric text to int first (turbo_window.py `_on_term_send`),
 * so numeric strings are converted here the same way, and "false"/"off" read as false.
 * @param {any} value
 */
function truthy(value) {
  if (typeof value === "string") {
    const t = value.trim();
    if (/^(false|off|no)$/i.test(t)) return false;
    const n = pyFloat(t);
    if (n !== null) return n !== 0;
    return t.length > 0 || value.length > 0;
  }
  return Boolean(value);
}

/** @param {number} x */
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** @param {Uint8Array} bytes */
function latin(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
