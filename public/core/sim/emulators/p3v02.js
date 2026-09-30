// @ts-check
/**
 * OPG550 emulator for the INFICON P3 V02 protocol (CSC inficon_p3_v02.py, the scanner's
 * `_probe_p3v02`, specs-src/gauges/opg550.yaml). Answers the identification PIDs 10000 to
 * 10004, pressure PID 14000 (float32, request data = unit code 1 mbar, 2 Torr, 3 Pa,
 * 4 micron) and a few status PIDs. Unknown PIDs return the error frame (PID 0xFFFF,
 * code 3 "Parameter not found"); writes to read-only PIDs return code 1.
 */
import { ascii, float32BE, int32BE } from "../../bytes.js";
import { CMD_READ_REQ, CMD_READ_RESP, CMD_WRITE_REQ, CMD_WRITE_RESP, ERROR_PID, p3BuildFrame, p3Framer, p3ParseFrame } from "../../codecs/inficon-p3v02.js";
import { timedFramer } from "./line.js";

const UNIT_FACTORS = { 1: 1, 2: 1 / 1.33322387415, 3: 100, 4: 1000 / 1.33322387415 };

/**
 * @param {{
 *   product?: string,
 *   manufacturer?: string,
 *   serial?: string,
 *   firmware?: string,
 *   bootloader?: string,
 *   baudRate?: number,
 *   address?: number,          RS485 address; on RS232 the gauge answers address 0
 *   rs485?: boolean,
 *   deviceId?: number,
 *   pressure?: () => number,   mbar
 *   responseDelayMs?: number,
 * }} [options]
 * @returns {import("../../transport/emulated-port.js").Emulator}
 */
export function createP3V02Emulator(options = {}) {
  const product = options.product ?? "OPG550";
  const deviceId = options.deviceId ?? 0x0b;
  const framer = p3Framer();
  const feed = timedFramer(framer);
  const state = {
    address: options.address ?? 0,
    pressure: options.pressure ?? (() => 2.5e-3),
    masterUnit: 1,
    plasmaInterlock: 0,
    plasmaEnabled: 0,
    operatingMode: 0,
    errorStatus: 0
  };
  const cstr = (/** @type {string} */ s) => Uint8Array.from([...ascii(s), 0]);

  /** @type {Record<number, { read?: (req: Uint8Array) => Uint8Array, write?: (data: Uint8Array) => number | void }>} */
  const params = {
    10000: { read: () => cstr(options.manufacturer ?? "INFICON") },
    10001: { read: () => cstr(product) },
    10002: { read: () => cstr(options.serial ?? "55001234") },
    10003: { read: () => cstr(options.bootloader ?? "1.00") },
    10004: { read: () => cstr(options.firmware ?? "1.12") },
    11000: { read: () => Uint8Array.of(state.errorStatus) },
    11001: { read: () => int32BE(32) },
    11002: { read: () => int32BE(0) },
    12000: { write: (d) => (d.length === 1 ? void (state.plasmaInterlock = d[0] ? 1 : 0) : 4) },
    12001: { read: () => Uint8Array.of(state.plasmaInterlock) },
    12002: { write: (d) => (d.length === 1 ? void (state.plasmaEnabled = d[0] ? 1 : 0) : 4) },
    12003: { read: () => Uint8Array.of(state.plasmaEnabled ? 2 : 0) },
    13000: { read: () => Uint8Array.of(0x01, 0x20) },
    14000: {
      read: (req) => {
        const unit = req.length ? req[0] : state.masterUnit;
        const factor = UNIT_FACTORS[/** @type {keyof typeof UNIT_FACTORS} */ (unit)] ?? 1;
        return float32BE(state.pressure() * factor);
      }
    },
    14001: { read: () => Uint8Array.of(state.masterUnit) },
    19000: { read: () => Uint8Array.of(state.operatingMode) },
    19100: { write: () => void (state.operatingMode = 0) }
  };

  return {
    family: "inficon_p3_v02",
    model: product,
    baudRate: options.baudRate ?? 115200,
    address: state.address,
    state,
    open() {
      framer.reset();
    },
    classify(f) {
      try {
        const p = p3ParseFrame(f);
        if (!p.crcOk) return "unknown";
        return p.cmd === CMD_READ_REQ ? "read" : p.cmd === CMD_WRITE_REQ ? "write" : "unknown";
      } catch {
        return "unknown";
      }
    },
    receive(bytes, ctx) {
      for (const frame of feed(bytes, ctx.now())) {
        const f = p3ParseFrame(frame);
        if (f.ack !== 0 || (f.cmd !== CMD_READ_REQ && f.cmd !== CMD_WRITE_REQ)) continue;
        if (f.addr !== (options.rs485 ? state.address : 0)) continue;
        const replyAddr = 0x00;
        const respCmd = f.cmd === CMD_READ_REQ ? CMD_READ_RESP : CMD_WRITE_RESP;
        const delay = options.responseDelayMs ?? 3;
        /** @param {number} pid @param {ArrayLike<number>} data @param {number} [cmd] */
        const send = (pid, data, cmd = respCmd) => ctx.send(p3BuildFrame(cmd, pid, data, { addr: replyAddr, senderId: deviceId, ack: 1 }), delay);
        const param = params[f.pid];
        if (!param) {
          send(ERROR_PID, [3]);
          continue;
        }
        if (f.cmd === CMD_READ_REQ) {
          if (!param.read) send(ERROR_PID, [1]);
          else send(f.pid, param.read(f.data));
        } else {
          if (!param.write) {
            send(ERROR_PID, [1]);
            continue;
          }
          const code = param.write(f.data);
          if (code) send(ERROR_PID, [code]);
          else send(f.pid, []);
        }
      }
    }
  };
}
