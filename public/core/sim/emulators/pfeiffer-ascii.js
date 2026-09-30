// @ts-check
/**
 * Pfeiffer ASCII emulator: INFICON BCG450 / BCG552 gauge side and the Pfeiffer TC600 drive.
 * Answers `addr 00 param 02 =?` reads and `addr 10 param len data` writes with action "10"
 * frames (PM 800 488 BN / TIRA89E1, CSC pfeiffer_ascii.py). Unknown parameters answer
 * NO_DEF, writes to read-only parameters _LOGIC, invalid data _RANGE. Frames with a bad
 * checksum or another address are ignored, as a real unit does.
 *
 * Parameter 309 carries a firmware string with the model name for gauges, so the scanner's
 * model-hint rule (port_scanner.py `_identify_pfeiffer`) maps it. On a TC600, 309 is the
 * actual rotation speed (PM 800 547 BE, tc600.js); pass `param309: "firmware"` to get the
 * scanner-friendly string instead.
 */
import { asciiSum } from "../../checks/sum8.js";
import { pad, pfeifferFrame, pfeifferFramer } from "../../codecs/pfeiffer-ascii.js";
import { timedFramer } from "./line.js";

/**
 * @typedef {string | (() => string) | { get?: () => string, set?: (data: string) => string | void }} ParamSource
 *   A value source. `set` returns an error word ("_RANGE") to refuse the write.
 */

/**
 * @param {{
 *   model?: "BCG450" | "BCG552" | "TC600" | string,
 *   address?: number,
 *   baudRate?: number,
 *   pressure?: () => number,         mbar
 *   firmware?: string,               parameter 309 text (gauges); default: the model name
 *   hardware?: string,               parameter 310 text (gauges)
 *   serial?: string,
 *   param309?: "firmware" | "speed",
 *   params?: Record<number, ParamSource>,   extra or overriding parameters
 *   finalSpeedHz?: number,           TC600 nominal final speed
 *   accelHzPerS?: number,            TC600 spin-up rate
 *   decelHzPerS?: number,            TC600 run-down rate
 *   responseDelayMs?: number,
 * }} [options]
 * @returns {import("../../transport/emulated-port.js").Emulator}
 */
export function createPfeifferAsciiEmulator(options = {}) {
  const model = options.model ?? "BCG450";
  const isTc = /^TC\s?600/i.test(model);
  const address = options.address ?? 1;
  const framer = pfeifferFramer();
  const feed = timedFramer(framer);
  /** @type {() => number} */
  let now = () => 0;

  const state = {
    pressure: options.pressure ?? (() => 1.23e-3),
    unit: 0,
    emission: false,
    gaugeFactor: 1,
    rs485Address: address,
    // TC600 drive state
    pumpOn: false,
    motorOn: false,
    standby: false,
    vent: false,
    ventMode: 0,
    opMode: 0,
    errorCode: "no Err",
    warningCode: "no Wrn",
    runupMin: 8,
    speedSetpointPct: 75,
    standbyPct: 66,
    ventFreqPct: 50,
    ventTimeS: 3600,
    opHours: 1234,
    finalSpeedHz: options.finalSpeedHz ?? 1500,
    speedHz: 0,
    speedAt: 0
  };
  const accel = options.accelHzPerS ?? 50;
  const decel = options.decelHzPerS ?? 25;

  function targetSpeed() {
    if (!(state.pumpOn && state.motorOn)) return 0;
    if (state.standby) return (state.finalSpeedHz * state.standbyPct) / 100;
    if (state.opMode === 1) return (state.finalSpeedHz * state.speedSetpointPct) / 100;
    return state.finalSpeedHz;
  }

  /** Advance the simple spin-up model to the current time. */
  function advance() {
    const t = now();
    const dt = Math.max(0, (t - state.speedAt) / 1000);
    state.speedAt = t;
    const target = targetSpeed();
    if (state.speedHz < target) state.speedHz = Math.min(target, state.speedHz + accel * dt);
    else if (state.speedHz > target) state.speedHz = Math.max(target, state.speedHz - decel * dt);
    return state.speedHz;
  }

  function motorCurrent() {
    const speed = advance();
    const target = targetSpeed();
    if (target === 0 && speed === 0) return 0;
    return speed < target - 0.5 ? 2.5 : 0.4 + (0.3 * speed) / state.finalSpeedHz;
  }

  const bool6 = (/** @type {boolean} */ v) => (v ? "111111" : "000000");
  /** @param {string} d */
  const parseBool = (d) => (/^(0|1)+$/.test(d) && d.length === 6 ? /1/.test(d) : null);
  /** @param {string} d @param {number} min @param {number} max @param {(n: number) => void} apply */
  const intSetter = (d, min, max, apply) => {
    if (!/^\d+$/.test(d)) return "_RANGE";
    const n = Number(d);
    if (n < min || n > max) return "_RANGE";
    apply(n);
  };
  /** @param {(v: boolean) => void} apply @returns {(d: string) => string | void} */
  const boolSetter = (apply) => (d) => {
    const v = parseBool(d);
    if (v === null) return "_RANGE";
    advance();
    apply(v);
  };

  /** @type {Record<number, ParamSource>} */
  const params = {};
  if (isTc) {
    Object.assign(params, {
      2: { get: () => bool6(state.standby), set: boolSetter((v) => (state.standby = v)) },
      9: { set: boolSetter((v) => void (v && (state.errorCode = "no Err"))) },
      10: { get: () => bool6(state.pumpOn), set: boolSetter((v) => (state.pumpOn = v)) },
      12: { get: () => bool6(state.vent), set: boolSetter((v) => (state.vent = v)) },
      23: { get: () => bool6(state.motorOn), set: boolSetter((v) => (state.motorOn = v)) },
      26: { get: () => pad(state.opMode, 3), set: (d) => intSetter(d, 0, 1, (n) => (advance(), (state.opMode = n))) },
      30: { get: () => pad(state.ventMode, 3), set: (d) => intSetter(d, 0, 2, (n) => (state.ventMode = n)) },
      302: { get: () => state.warningCode.padEnd(6).slice(0, 6) },
      303: { get: () => state.errorCode.padEnd(6).slice(0, 6) },
      308: { get: () => pad(Math.round(targetSpeed()), 6) },
      309: options.param309 === "firmware" ? { get: () => (options.firmware ?? model).padEnd(6) } : { get: () => pad(Math.round(advance()), 6) },
      310: { get: () => pad(Math.round(motorCurrent() * 100), 6) },
      311: { get: () => pad(state.opHours, 6) },
      312: { get: () => (options.firmware ?? "010200").padEnd(6).slice(0, 6) },
      315: { get: () => pad(state.finalSpeedHz, 6) },
      316: { get: () => pad(Math.round(motorCurrent() * 24), 6) },
      342: { get: () => pad(28, 3) },
      346: { get: () => pad(state.motorOn && state.pumpOn ? 42 : 25, 3) },
      347: { get: () => pad(35, 3) },
      700: { get: () => pad(state.runupMin, 6), set: (d) => intSetter(d, 1, 120, (n) => (state.runupMin = n)) },
      707: { get: () => pad(state.speedSetpointPct * 100, 6), set: (d) => intSetter(d, 2000, 10000, (n) => (advance(), (state.speedSetpointPct = n / 100))) },
      717: { get: () => pad(state.standbyPct, 6), set: (d) => intSetter(d, 20, 100, (n) => (advance(), (state.standbyPct = n))) },
      720: { get: () => pad(state.ventFreqPct, 6), set: (d) => intSetter(d, 40, 98, (n) => (state.ventFreqPct = n)) },
      721: { get: () => pad(state.ventTimeS, 6), set: (d) => intSetter(d, 6, 3600, (n) => (state.ventTimeS = n)) },
      797: { get: () => pad(state.rs485Address, 6), set: (d) => intSetter(d, 1, 255, (n) => (state.rs485Address = n)) }
    });
  } else {
    Object.assign(params, {
      309: { get: () => options.firmware ?? model },
      310: { get: () => options.hardware ?? "010100" },
      340: { get: () => expoNew(state.pressure()) },
      312: { get: () => (options.firmware ?? "010700").padEnd(6).slice(0, 6) },
      349: { get: () => (options.serial ?? "123456").padEnd(6).slice(0, 6) },
      130: { get: () => pad(state.unit, 3), set: (d) => intSetter(d, 0, 2, (n) => (state.unit = n)) },
      10: { get: () => bool6(state.emission), set: boolSetter((v) => (state.emission = v)) },
      342: { get: () => pad(Math.round(state.gaugeFactor * 100), 6), set: (d) => intSetter(d, 10, 1000, (n) => (state.gaugeFactor = n / 100)) },
      303: { get: () => "000000" },
      216: { get: () => pad(2530, 6) },
      797: { get: () => pad(state.rs485Address, 6), set: (d) => intSetter(d, 1, 253, (n) => (state.rs485Address = n)) }
    });
  }
  Object.assign(params, options.params ?? {});

  /** @param {ParamSource} src */
  function read(src) {
    if (typeof src === "string") return src;
    if (typeof src === "function") return src();
    return src.get ? src.get() : null;
  }

  return {
    family: "pfeiffer_ascii",
    model,
    baudRate: options.baudRate ?? 9600,
    address,
    state,
    open(ctx) {
      framer.reset();
      now = ctx.now;
      state.speedAt = ctx.now();
    },
    classify(f) {
      const t = latin(f);
      if (!/^\d{10}/.test(t)) return "unknown";
      const action = t.slice(3, 5);
      if (action === "00" && t.slice(10, 12) === "=?") return "read";
      if (action === "10") return "write";
      return "unknown";
    },
    receive(bytes, ctx) {
      now = ctx.now;
      for (const frame of feed(bytes, ctx.now())) {
        const t = latin(frame).replace(/\r$/, "");
        if (!/^\d{10}/.test(t) || t.length < 13) continue;
        if (asciiSum(t.slice(0, -3)) !== Number(t.slice(-3))) continue;
        if (Number(t.slice(0, 3)) !== address) continue;
        const action = t.slice(3, 5);
        const param = Number(t.slice(5, 8));
        const data = t.slice(10, 10 + Number(t.slice(8, 10)));
        const src = params[param];
        const delay = options.responseDelayMs ?? 4;
        /** @param {string} d */
        const reply = (d) => ctx.send(pfeifferFrame(address, "10", param, d), delay);
        if (!src) {
          reply("NO_DEF");
          continue;
        }
        if (action === "00" && data === "=?") {
          const value = read(src);
          reply(value == null ? "_LOGIC" : value);
        } else if (action === "10") {
          const setter = typeof src === "object" ? src.set : undefined;
          if (!setter) {
            reply("_LOGIC");
            continue;
          }
          const refusal = setter(data);
          // A write is answered with the written data, which is why CSC reads and discards one frame.
          reply(refusal ? refusal : data);
        }
      }
    }
  };
}

/**
 * u_expo_new: 4 mantissa digits (value / 1000) and 2 exponent digits offset by 20,
 * so 4.567e-9 is "456711" (CSC pfeiffer_ascii.py `_decode_value`).
 * @param {number} v
 */
export function expoNew(v) {
  if (!(v > 0) || !Number.isFinite(v)) return "000000";
  let e = Math.floor(Math.log10(v));
  let m = Math.round((v / 10 ** e) * 1000);
  if (m >= 10000) {
    m = Math.round(m / 10);
    e += 1;
  }
  const code = Math.max(0, Math.min(99, e + 20));
  return `${String(m).padStart(4, "0")}${String(code).padStart(2, "0")}`;
}

/** @param {Uint8Array} bytes */
function latin(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
