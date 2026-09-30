// @ts-check
/**
 * CDG emulator: answers the TIRA49E1 5-byte commands with 9-byte frames and, after a
 * pressure read, streams frames continuously like a real SKY CDG.
 *
 * Fault options produce CDG soft and fatal error bits on demand.
 */
import { sum8 } from "../../checks/sum8.js";
import { CDG_SENSOR_MODELS } from "../../constants.js";

const MODEL_CODES = Object.fromEntries(Object.entries(CDG_SENSOR_MODELS).map(([code, model]) => [model, Number(code)]));

/**
 * @param {{
 *   model?: string,
 *   fullScaleMbar?: number,
 *   typeWord?: number,            what the type query (0x3B) returns; default: Torr-native integer when the FS is Torr-native
 *   pressure?: () => number,      mbar
 *   streamIntervalMs?: number,
 *   firmware?: [number, number],
 *   serial?: number,
 *   baudRate?: number,
 *   errorByte?: () => number,     extra error bits to OR in (e.g. 0x80 sensor not ready, 0x40 fatal)
 *   streaming?: boolean,          start streaming at open, as a gauge left streaming from an earlier session
 * }} [options]
 * @returns {import("../../transport/emulated-port.js").Emulator}
 */
export function createCdgEmulator(options = {}) {
  const model = options.model ?? "CDG045D";
  const sensorCode = MODEL_CODES[model] ?? 0x01;
  const state = {
    fullScaleMbar: options.fullScaleMbar ?? 13.332,
    pressure: options.pressure ?? (() => 1.0),
    unit: 0,
    // SP1 low/high, SP2 low/high as raw bytes; on a 10 Torr head (cube law) about
    // 0.17/0.34 mbar and 1.4/2.2 mbar, so a simulated pump-down crosses both.
    setpoints: [60, 75, 120, 140],
    streaming: Boolean(options.streaming),
    errorByte: options.errorByte ?? (() => 0),
    lastRead: 0x00,
    zeroOffset: 0
  };
  const torrWords = { 1.3332: 1, 2.6664: 2, 13.332: 10, 26.664: 20, 133.32: 100, 266.64: 200, 666.6: 500, 1333.22: 1000 };
  const typeWord = options.typeWord ?? torrWords[/** @type {keyof typeof torrWords} */ (state.fullScaleMbar)] ?? 0;
  const interval = options.streamIntervalMs ?? 100;
  /** @type {any} */
  let timer = null;
  let pending = new Uint8Array(0);

  /** @param {number} echo @param {number} hi @param {number} lo @param {number} [err] */
  function frame(echo, hi, lo, err = 0) {
    const f = Uint8Array.of(0x07, 0x00, state.unit << 4, err, hi & 0xff, lo & 0xff, echo, sensorCode, 0);
    f[8] = sum8(f, 1, 8);
    return f;
  }

  function pressureFrame() {
    const p = state.pressure() - state.zeroOffset;
    let ratio = p / state.fullScaleMbar;
    let err = state.errorByte() & 0xff;
    if (ratio > 1.024) err |= 0x02;
    if (ratio < -0.024) err |= 0x01;
    ratio = Math.max(-1.99, Math.min(1.99, ratio));
    const word = Math.round(ratio * 16384) & 0xffff;
    return frame(0x00, word >> 8, word & 0xff, err);
  }

  /** @param {import("../../transport/emulated-port.js").EmulatorContext} ctx */
  function tick(ctx) {
    if (!state.streaming) return;
    ctx.send(pressureFrame(), 0);
    timer = ctx.setTimer(() => tick(ctx), interval);
  }

  /** @param {import("../../transport/emulated-port.js").EmulatorContext} ctx */
  function startStreaming(ctx) {
    if (timer) ctx.clearTimer(timer);
    state.streaming = true;
    timer = ctx.setTimer(() => tick(ctx), interval);
  }

  return {
    family: "cdg_serial",
    model,
    baudRate: options.baudRate ?? 9600,
    address: 0,
    state,
    open(ctx) {
      pending = new Uint8Array(0);
      if (state.streaming) startStreaming(ctx);
    },
    close() {
      timer = null;
    },
    classify(f) {
      if (f.length !== 5 || f[0] !== 0x03) return "unknown";
      return f[1] === 0x00 ? "read" : "write";
    },
    receive(bytes, ctx) {
      const joined = new Uint8Array(pending.length + bytes.length);
      joined.set(pending);
      joined.set(bytes, pending.length);
      let i = 0;
      while (joined.length - i >= 5) {
        if (joined[i] !== 0x03) {
          i += 1;
          continue;
        }
        const cmd = joined.subarray(i, i + 5);
        if (sum8(cmd, 1, 4) !== cmd[4]) {
          i += 1;
          continue;
        }
        i += 5;
        const [, service, register, data] = cmd;
        if (service === 0x00) {
          state.lastRead = register;
          if (register === 0x00) {
            ctx.send(pressureFrame(), 3);
            startStreaming(ctx);
          } else if (register === 0x3b) ctx.send(frame(0x3b, typeWord >> 8, typeWord & 0xff), 3);
          else if (register === 0x10) ctx.send(frame(0x10, (options.firmware ?? [1, 20])[0], (options.firmware ?? [1, 20])[1]), 3);
          else if (register === 0x11) {
            const sn = options.serial ?? 12345;
            ctx.send(frame(0x11, (sn >> 8) & 0xff, sn & 0xff), 3);
          } else if (register === 0x20 || register === 0x22) {
            const k = register === 0x20 ? 0 : 2;
            ctx.send(frame(register, state.setpoints[k], state.setpoints[k + 1]), 3);
          } else ctx.send(frame(register, 0, 0), 3);
        } else if (service === 0x10) {
          if (register === 0x04) state.unit = data & 0x03;
          if (register >= 0x20 && register <= 0x23) state.setpoints[register - 0x20] = data;
          ctx.send(frame(register, 0, data), 3);
        } else if (service === 0x40) {
          if (register === 0x02) state.zeroOffset = state.pressure();
          if (register === 0x04) state.zeroOffset = 0;
          ctx.send(frame(register, 0, 0), 3);
        }
      }
      pending = joined.slice(i);
    }
  };
}
