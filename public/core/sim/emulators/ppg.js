// @ts-check
/**
 * PPG550 / PPG570 emulator for the PPG ASCII protocol (CSC ppg_ascii.py, port_scanner.py,
 * specs-src/gauges/ppg550.yaml and ppg570.yaml).
 *
 *   @{addr}{mnemonic}?{param}\  ->  @ACK{data}\  (or @{own addr}ACK{data}\ with addressPrefixedAck)
 *   unknown mnemonic            ->  @NAKUNKNOWN COMMAND\
 *   write                       ->  @ACK{new value}\  (🟠 V14: echo assumed; confirm in TINB86E1)
 *
 * Model differences the codec and scanner rely on: the PPG550 speaks PR1..PR4 but NAKs PR1
 * (the scanner reads a PR1 ACK as the PPG570 signature, port_scanner.py `_identify_ppg`) and
 * the PPG570 `P` family; the PPG570 speaks `P`, `P?CMB`, `P?MP` ... and PR1..PR4.
 * RS232 answers the broadcast address 254 and its own address; RS485 only its own address.
 */
import { ascii } from "../../bytes.js";
import { terminatorFramer } from "../../framers/terminator.js";
import { timedFramer } from "./line.js";

const MBAR_TO = { MBAR: 1, TORR: 1 / 1.33322387415, PASCAL: 100 };

/**
 * @param {{
 *   model?: "PPG550" | "PPG570",
 *   address?: number,
 *   rs485?: boolean,
 *   pressure?: () => number,          mbar
 *   atmPressure?: () => number,       mbar, ambient piezo (PPG570 PZA)
 *   status?: () => null | string,     a status word ("UR", "OR", "WAIT"...) replaces every pressure value
 *   temperature?: () => number,       °C
 *   addressPrefixedAck?: boolean,     reply "@253ACK..." as some firmware does
 *   baudRate?: number,
 *   serial?: string,
 *   firmware?: string,
 *   manufacturer?: string,
 *   responseDelayMs?: number,
 * }} [options]
 * @returns {import("../../transport/emulated-port.js").Emulator}
 */
export function createPpgEmulator(options = {}) {
  const model = options.model ?? "PPG550";
  const is570 = model.toUpperCase() === "PPG570";
  const framer = terminatorFramer({ terminator: 0x5c, maxLength: 256 });
  const feed = timedFramer(framer);
  const state = {
    address: options.address ?? 254,
    pressure: options.pressure ?? (() => 1.23e-3),
    atmPressure: options.atmPressure ?? (() => 1013.25),
    status: options.status ?? (() => null),
    temperature: options.temperature ?? (() => 25.3),
    unit: "MBAR",
    temperatureUnit: "CELSIUS",
    gasType: "NITROGEN",
    zeroOffset: 0,
    /** @type {Record<string, string>} */
    settings: { AO: "STD", AOUT: "STD", BTN: "ON", LED: "SOLID", FAIL: "WORKING" },
    /** Setpoint registers, keyed by mnemonic plus index ("SPV1", "SP1"). @type {Record<string, string>} */
    setpoints: {}
  };
  // A device configured for broadcast still owns a real RS485 address; 253 is the factory default.
  const ownAddress = state.address === 254 ? 253 : state.address;

  /** @param {number} mbar */
  function fmt(mbar) {
    const status = state.status();
    if (status) return status;
    const v = mbar * MBAR_TO[/** @type {keyof typeof MBAR_TO} */ (state.unit)];
    return v.toExponential(2).toUpperCase().replace(/E([+-])(\d)$/, "E$10$2");
  }

  const vac = () => Math.max(0, state.pressure() - state.zeroOffset);

  /**
   * Factory-like setpoint registers so a fresh simulated gauge has something to show:
   * SP1 1E+1, SP2 1E-1, SP3 1E-2 mbar, switching BELOW, release 10 % above (🟠 V14).
   * @param {string} kind  SP/SPV value, SH/SPH hysteresis, SD/SPD direction, EN/SPE enable, SPS source
   * @param {number} index
   */
  function setpointDefault(kind, index) {
    const value = [1e1, 1e-1, 1e-2][index - 1] ?? 1;
    if (kind === "SP" || kind === "SPV") return fmtRaw(value);
    if (kind === "SH" || kind === "SPH") return fmtRaw(value * 1.1);
    if (kind === "SD" || kind === "SPD") return "BELOW";
    if (kind === "EN" || kind === "SPE") return index === 3 ? "OFF" : "ON";
    if (kind === "SPS") return "CMB";
    return "0.00E+00";
  }

  /** PPG570 SPR: the relay as the gauge would report it, from the live pressure. @param {number} index */
  function relayStatus(index) {
    const reg = (/** @type {string} */ m) => state.setpoints[`${m}${index}`] ?? setpointDefault(m, index);
    if (reg("SPE") === "OFF") return "OFF";
    const threshold = Number(reg("SPV"));
    const p = vac();
    return (reg("SPD") === "ABOVE" ? p > threshold : p < threshold) ? "ON" : "OFF";
  }

  /** @param {number} mbar */
  function fmtRaw(mbar) {
    return mbar.toExponential(2).toUpperCase().replace(/E([+-])(\d)$/, "E$10$2");
  }

  /**
   * @param {string} mnemonic @param {"?" | "!"} action @param {string} param
   * @returns {string | { nak: string }}
   */
  function handle(mnemonic, action, param) {
    const read = action === "?";
    const unknown = { nak: "UNKNOWN COMMAND" };
    switch (mnemonic) {
      case "FV":
        return read ? options.firmware ?? (is570 ? "2.10" : "1.07") : unknown;
      case "SN":
        return read ? options.serial ?? "12345678" : unknown;
      case "PN":
        return read ? (is570 ? "3PP1-100-1100" : "3PP1-000-1100") : unknown;
      case "MF":
        return read ? options.manufacturer ?? "SIMULATED" : unknown;
      case "MD":
        return read ? model : unknown;
      case "T":
        return read ? state.temperature().toFixed(1) : unknown;
      case "PR1":
        if (!is570) return unknown;
        return read ? fmt(vac()) : unknown;
      case "PR2":
      case "PR3":
      case "PR4":
        return read ? fmt(vac()) : unknown;
      case "P": {
        if (!is570) return unknown;
        if (!read) return unknown;
        const which = param.toUpperCase();
        if (which === "" || which === "CMB" || which === "MP" || which === "PZV") return fmt(vac());
        if (which === "PZA") return fmt(state.atmPressure());
        if (which === "DIFF") return fmt(vac() - state.atmPressure());
        return { nak: "INVALID PARAMETER" };
      }
      case "U": {
        if (read) return param.toUpperCase() === "T" ? state.temperatureUnit : state.unit;
        const [first, second] = param.toUpperCase().split(",");
        if (first === "T" && is570 && ["CELSIUS", "FAHRENHEIT", "KELVIN"].includes(second)) {
          state.temperatureUnit = second;
          return second;
        }
        if (first in MBAR_TO) {
          state.unit = first;
          return first;
        }
        return { nak: "INVALID VALUE" };
      }
      case "GT": {
        if (read) return state.gasType;
        const gas = param.toUpperCase();
        if (!["NITROGEN", "HELIUM", "ARGON", "AIR"].includes(gas)) return { nak: "INVALID VALUE" };
        state.gasType = gas;
        return gas;
      }
      case "VAC":
        if (read) return is570 ? String(state.zeroOffset) : unknown;
        state.zeroOffset = param ? Number(param) || 0 : state.pressure();
        return "";
      case "ATZ":
      case "ATD":
      case "FS":
      case "FD":
        return read ? "OK" : "";
      case "ADR":
        if (read) return String(ownAddress);
        return /^\d+$/.test(param) && Number(param) >= 1 && Number(param) <= 253 ? param : { nak: "INVALID VALUE" };
      case "BR":
      case "BAUD":
        if ((mnemonic === "BAUD") !== is570) return unknown;
        return read ? String(options.baudRate ?? 9600) : { nak: "NOT EMULATED" };
      default:
        break;
    }
    if (mnemonic in state.settings) {
      if (read) return state.settings[mnemonic];
      state.settings[mnemonic] = param;
      return param;
    }
    // Setpoints: PPG550 SP1/SD1/EN1/SH1; PPG570 SPV/SPH/SPD/SPE/SPS/SPR with an index.
    if (/^(SP|SD|EN|SH)[1-3]$/.test(mnemonic) && !is570) {
      if (read) return state.setpoints[mnemonic] ?? setpointDefault(mnemonic.slice(0, 2), Number(mnemonic[2]));
      state.setpoints[mnemonic] = param;
      return param;
    }
    if (/^SP[VHDESR]$/.test(mnemonic) && is570) {
      if (mnemonic === "SPR") return read ? relayStatus(Number(param)) : unknown;
      if (read) return state.setpoints[`${mnemonic}${param}`] ?? setpointDefault(mnemonic, Number(param));
      const [index, ...rest] = param.split(",");
      if (!/^[1-3]$/.test(index)) return { nak: "INVALID PARAMETER" };
      state.setpoints[`${mnemonic}${index}`] = rest.join(",");
      return rest.join(",");
    }
    return unknown;
  }

  return {
    family: "ppg_ascii",
    model,
    baudRate: options.baudRate ?? 9600,
    address: state.address,
    state,
    open() {
      framer.reset();
    },
    classify(f) {
      const m = /^@\d{3}[A-Z0-9]+([?!])/.exec(latin(f));
      if (!m) return "unknown";
      return m[1] === "?" ? "read" : "write";
    },
    receive(bytes, ctx) {
      for (const frame of feed(bytes, ctx.now())) {
        const m = /^@(\d{3})([A-Z0-9]+?)([?!])(.*)\\$/s.exec(latin(frame));
        if (!m) continue;
        const addr = Number(m[1]);
        const hears = addr === state.address || addr === ownAddress || (!options.rs485 && addr === 254);
        if (!hears) continue;
        const result = handle(m[2].toUpperCase(), /** @type {"?" | "!"} */ (m[3]), m[4]);
        const prefix = options.addressPrefixedAck ? `@${String(ownAddress).padStart(3, "0")}` : "@";
        const body = typeof result === "string" ? `${prefix}ACK${result}` : `${prefix}NAK${result.nak}`;
        ctx.send(ascii(`${body}\\`), options.responseDelayMs ?? 4);
      }
    }
  };
}

/** @param {Uint8Array} bytes */
function latin(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
