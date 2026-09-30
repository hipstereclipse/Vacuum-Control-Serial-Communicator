// @ts-check
/**
 * PxG55x emulator (PSG55x / PCG55x) for the binary protocol as described in S16 🟠.
 * Parameters are a PID table; unknown PIDs return the documented error frame
 * (PID 0xFFFF, error 3 "parameter not found"), read-only writes return error 1.
 */
import { checkCrc16x8408 } from "../../checks/crc16-x8408.js";
import { ascii, float32BE, int32BE } from "../../bytes.js";
import { CMD_READ, CMD_READ_RESPONSE, CMD_WRITE, CMD_WRITE_RESPONSE, ERROR_PID, pxgFields, pxgFrame, pxgFramer } from "../../codecs/inficon-binary.js";
import { timedFramer } from "./line.js";

const UNIT_FACTORS = { 0: 1, 1: 1 / 1.33322387415, 2: 100, 3: 1000 / 1.33322387415, 4: 1 };

/**
 * @param {{
 *   model?: "PSG550" | "PCG550" | string,
 *   address?: number,
 *   rs485?: boolean,             answer only frames addressed to `address`
 *   baudRate?: number,
 *   deviceId?: number,
 *   pressure?: () => number,     mbar
 *   atmPressure?: () => number,  mbar (PCG)
 *   serial?: string,
 *   firmware?: string,
 *   responseDelayMs?: number,
 * }} [options]
 * @returns {import("../../transport/emulated-port.js").Emulator}
 */
export function createPxgEmulator(options = {}) {
  const model = options.model ?? "PCG550";
  const isPcg = model.toUpperCase().startsWith("PCG");
  const state = {
    unit: 0,
    baud: options.baudRate ?? 57600,
    address: options.address ?? 0,
    pressure: options.pressure ?? (() => 885.63),
    atmPressure: options.atmPressure ?? (() => 1013.25),
    activeInstance: 3,
    runHours: 1234.5,
    autoZero: 0
  };
  const deviceId = options.deviceId ?? 0x02;
  const framer = pxgFramer();
  const feed = timedFramer(framer);

  /** @type {Record<number, { read?: () => Uint8Array, write?: (data: Uint8Array) => number | void }>} */
  const params = {
    221: { read: () => int32BE(Math.round(state.pressure() * 2 ** 20)) },
    222: { read: () => float32BE(state.pressure() * UNIT_FACTORS[/** @type {keyof typeof UNIT_FACTORS} */ (state.unit)]) },
    224: { read: () => Uint8Array.of(state.unit), write: (d) => (d[0] <= 4 ? void (state.unit = d[0]) : 2) },
    207: { read: () => ascii(options.serial ?? "44001234") },
    208: { read: () => ascii(model) },
    209: { read: () => ascii("SIMULATED") },
    218: { read: () => ascii(options.firmware ?? "1.07") },
    104: { read: () => int32BE(Math.round(state.runHours * 4)) },
    227: { read: () => int32BE(state.baud), write: (d) => void (state.baud = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0) },
    228: { read: () => int32BE(0) },
    103: { write: () => undefined },
    417: { write: () => undefined }
  };
  if (isPcg) {
    Object.assign(params, {
      223: { read: () => Uint8Array.of(state.activeInstance) },
      265: { read: () => int32BE(Math.round(state.atmPressure() * 2 ** 20)) },
      414: { write: () => undefined },
      421: { read: () => Uint8Array.of(state.autoZero), write: (/** @type {Uint8Array} */ d) => void (state.autoZero = d[0] ? 1 : 0) },
      448: { write: () => undefined }
    });
  }

  /** @param {number} cmd  the request's Cmd @param {number} code */
  const errorFrame = (cmd, code) =>
    pxgFrame({ address: options.rs485 ? state.address : 0, deviceId, cmd: cmd === CMD_WRITE ? CMD_WRITE_RESPONSE : CMD_READ_RESPONSE, pid: ERROR_PID, data: [code] });

  const emulator = {
    family: "inficon_binary",
    model,
    get baudRate() {
      return state.baud;
    },
    address: state.address,
    state,
    open() {
      framer.reset();
    },
    /** @param {Uint8Array} f */
    classify(f) {
      if (!checkCrc16x8408(f)) return "unknown";
      return f[4] === CMD_READ ? "read" : f[4] === CMD_WRITE ? "write" : "unknown";
    },
    /** @param {Uint8Array} bytes @param {import("../../transport/emulated-port.js").EmulatorContext} ctx */
    receive(bytes, ctx) {
      for (const frame of feed(bytes, ctx.now())) {
        const f = pxgFields(frame);
        if (options.rs485 && f.address !== state.address) continue;
        if (f.cmd !== CMD_READ && f.cmd !== CMD_WRITE) continue;
        const param = params[f.pid];
        const delay = options.responseDelayMs ?? 4;
        const ackAddress = options.rs485 ? state.address : 0;
        if (!param) {
          ctx.send(errorFrame(f.cmd, 3), delay);
          continue;
        }
        if (f.cmd === CMD_READ) {
          if (!param.read) {
            ctx.send(errorFrame(f.cmd, 1), delay);
            continue;
          }
          ctx.send(pxgFrame({ address: ackAddress, deviceId, ack: 0x01, cmd: CMD_READ_RESPONSE, pid: f.pid, data: param.read() }), delay);
        } else {
          if (!param.write) {
            ctx.send(errorFrame(f.cmd, 1), delay);
            continue;
          }
          const code = param.write(f.data);
          if (code) {
            ctx.send(errorFrame(f.cmd, code), delay);
            continue;
          }
          ctx.send(pxgFrame({ address: ackAddress, deviceId, ack: 0x01, cmd: CMD_WRITE_RESPONSE, pid: f.pid }), delay);
        }
      }
    }
  };
  return emulator;
}
