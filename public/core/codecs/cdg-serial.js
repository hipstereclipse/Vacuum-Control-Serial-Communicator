// @ts-check
/**
 * CDG serial protocol codec — INFICON SKY CDG025D / CDG045D / CDG100D / CDG160D / CDG200D.
 * One-to-one port of CSC src/serial_comm/protocols/cdg_serial.py (which cites TIRA49E1),
 * plus the identification helpers from GUI/gauge_workspace/port_scanner.py.
 *
 *   Command (5 bytes, host -> gauge): 03 | service | register | data | sum(bytes 1..3) mod 256
 *   Response (9 bytes, gauge -> host): 07 | page | status | error | meas hi | meas lo |
 *                                       read echo | sensor type | sum(bytes 1..7) mod 256
 *
 *   ratio    = signed_int16(meas) / 16384, clamped to [-0.024, +1.024]
 *   pressure = ratio * full scale
 */
import { sum8 } from "../checks/sum8.js";
import { syncFixedFramer } from "../framers/sync-fixed.js";
import {
  CDG_FATAL_MASK,
  CDG_FS_TOLERANCE,
  CDG_FULL_SCALE_OPTIONS_MBAR,
  CDG_RATIO_MAX,
  CDG_RATIO_MIN,
  CDG_SENSOR_MODELS,
  CDG_TORR_NATIVE_TYPE_WORDS
} from "../constants.js";
import { err, info, ok } from "../models.js";
import { commandsFromSpec, formatPressure } from "./common.js";

export const RESPONSE_LENGTH = 9;
export const RESPONSE_SYNC = 0x07;
export const COMMAND_START = 0x03;

/** Service, register and write flag per command (CSC `_COMMANDS`). */
export const CDG_COMMANDS = Object.freeze({
  pressure: { service: 0x00, register: 0x00, write: false },
  data_tx_mode: { service: 0x10, register: 0x01, write: true },
  cdg_type: { service: 0x00, register: 0x3b, write: false },
  firmware: { service: 0x00, register: 0x10, write: false },
  serial_number: { service: 0x00, register: 0x11, write: false },
  unit: { service: 0x10, register: 0x04, write: true },
  setpoint_1_low: { service: 0x10, register: 0x20, write: true },
  setpoint_1_high: { service: 0x10, register: 0x21, write: true },
  setpoint_2_low: { service: 0x10, register: 0x22, write: true },
  setpoint_2_high: { service: 0x10, register: 0x23, write: true },
  setpoint_1_read: { service: 0x00, register: 0x20, write: false },
  setpoint_2_read: { service: 0x00, register: 0x22, write: false },
  reset: { service: 0x40, register: 0x00, write: true },
  factory_reset: { service: 0x40, register: 0x01, write: true },
  zero_adjust: { service: 0x40, register: 0x02, write: true },
  fs_adjust: { service: 0x40, register: 0x03, write: true },
  clear_zero: { service: 0x40, register: 0x04, write: true }
});

/** @param {Uint8Array} frame */
export function isCdgFrame(frame) {
  return frame.length === RESPONSE_LENGTH && frame[0] === RESPONSE_SYNC && sum8(frame, 1, 8) === frame[8];
}

/**
 * @param {number} service
 * @param {number} register
 * @param {number} [data]
 */
export function cdgRequest(service, register, data = 0) {
  const out = Uint8Array.of(COMMAND_START, service & 0xff, register & 0xff, data & 0xff, 0);
  out[4] = sum8(out, 1, 4);
  return out;
}

/**
 * @param {any} [spec]
 * @param {{ fullScaleMbar?: number, address?: number }} [options]
 * @returns {import("../models.js").Codec & { fullScaleMbar: number, setFullScale: (mbar: number) => void }}
 */
export function createCdgCodec(spec = null, options = {}) {
  let fullScaleMbar = Number(options.fullScaleMbar ?? spec?.full_scale_mbar ?? 1) || 1;

  /** @param {Uint8Array} raw */
  function validate(raw) {
    if (!raw || raw.length === 0) return err("No response received");
    if (raw.length !== RESPONSE_LENGTH) return err(`Expected ${RESPONSE_LENGTH} bytes, got ${raw.length}`, raw);
    if (raw[0] !== RESPONSE_SYNC) return err(`Invalid sync byte: 0x${hex2(raw[0])}`, raw);
    const calc = sum8(raw, 1, 8);
    if (calc !== raw[8]) return err(`Checksum error: expected ${hex2(calc)}, got ${hex2(raw[8])}`, raw);
    return null;
  }

  /** @param {Uint8Array} raw */
  function parseContinuous(raw) {
    const invalid = validate(raw);
    if (invalid) return invalid;
    const page = raw[1];
    const status = raw[2];
    const errorByte = raw[3];
    if (errorByte & CDG_FATAL_MASK) return err(`Gauge fault (error byte 0x${hex2(errorByte)})`, raw, { errorByte, fatal: true });

    const meas = (raw[4] << 24) >> 16 | raw[5];
    const rawRatio = meas / 16384;
    const ratio = Math.max(CDG_RATIO_MIN, Math.min(CDG_RATIO_MAX, rawRatio));
    const pressure = ratio * fullScaleMbar;
    const sensorCode = raw[7];
    const gaugeType = CDG_SENSOR_MODELS[/** @type {keyof typeof CDG_SENSOR_MODELS} */ (sensorCode)] ?? `code_0x${hex2(sensorCode)}`;

    /** @type {string[]} */
    const warnings = [];
    if (errorByte & 0x01) warnings.push("underrange");
    if (errorByte & 0x02) warnings.push("overrange");
    // CSC promotes a saturated ratio to a warning when the error byte does not flag it.
    if (rawRatio >= CDG_RATIO_MAX && !warnings.includes("overrange")) warnings.push("overrange");
    if (rawRatio <= CDG_RATIO_MIN && !warnings.includes("underrange")) warnings.push("underrange");
    if (errorByte & 0x04) warnings.push("zero adjust running");
    if (errorByte & 0x08) warnings.push("fs adjust running");
    if (errorByte & 0x10) warnings.push("extended status");
    if (errorByte & 0x80) warnings.push("sensor not ready");

    return ok(pressure, "mbar", formatPressure(pressure, "mbar"), raw, {
      gaugeType,
      sensorCode,
      page,
      status,
      errorByte,
      ratio,
      rawRatio,
      fullScaleMbar,
      readEcho: raw[6],
      warnings
    });
  }

  return {
    protocol: "cdg_serial",
    address: options.address ?? 0,
    get fullScaleMbar() {
      return fullScaleMbar;
    },
    setFullScale(mbar) {
      if (!(Number(mbar) > 0)) throw new Error("Full scale must be a positive number of mbar.");
      fullScaleMbar = Number(mbar);
    },
    framer() {
      return syncFixedFramer({ sync: RESPONSE_SYNC, length: RESPONSE_LENGTH, validate: isCdgFrame });
    },
    supportsContinuousOutput() {
      return true;
    },
    buildRequest(command, value) {
      const cmd = CDG_COMMANDS[/** @type {keyof typeof CDG_COMMANDS} */ (command)];
      if (!cmd) throw new Error(`CDG: unknown command '${command}'`);
      const data = value != null && value !== "" && cmd.write ? Number(value) & 0xff : 0;
      return cdgRequest(cmd.service, cmd.register, data);
    },
    parseContinuous,
    parseResponse(raw, command) {
      if (command === "pressure") return parseContinuous(raw);
      const invalid = validate(raw);
      if (invalid) return invalid;
      const word = (raw[4] << 8) | raw[5];
      if (command === "setpoint_1_read" || command === "setpoint_2_read") {
        return ok(word, "raw", `low=${raw[4]}, high=${raw[5]}`, raw, { low: raw[4], high: raw[5] });
      }
      if (command === "firmware") return info(`v${raw[4]}.${String(raw[5]).padStart(2, "0")}`, raw);
      if (command === "serial_number") {
        // 🟠 CSC reads bytes 4..7, which includes the sensor-type byte; confirm in TIRA49E1.
        const serial = ((raw[4] << 24) >>> 0) + (raw[5] << 16) + (raw[6] << 8) + raw[7];
        return info(String(serial), raw);
      }
      if (command === "cdg_type") {
        const fs = inferCdgFullScaleMbar(word);
        return info(`type word 0x${word.toString(16).toUpperCase().padStart(4, "0")}${fs ? ` · FS≈${fs} mbar` : ""}`, raw, {
          typeWord: word,
          fullScaleHintMbar: fs
        });
      }
      // Write and service commands: a valid frame is taken as the acknowledgement, as in CSC.
      return info("ACK", raw, { status: raw[2], errorByte: raw[3] });
    },
    matchesResponse(frame, command) {
      if (!isCdgFrame(frame)) return false;
      const cmd = CDG_COMMANDS[/** @type {keyof typeof CDG_COMMANDS} */ (command)];
      if (!cmd || cmd.service !== 0x00) return true;
      // Read commands are matched on the read-command echo in byte 6 (scanner: read_echo=0x3B).
      return frame[6] === cmd.register;
    },
    validateFrame(frame) {
      if (frame.length === 5 && frame[0] === COMMAND_START) {
        const good = sum8(frame, 1, 4) === frame[4];
        return { ok: good, detail: good ? "CDG command checksum OK" : `CDG checksum should be ${hex2(sum8(frame, 1, 4))}` };
      }
      return { ok: false, detail: "A CDG command is 5 bytes starting with 03" };
    },
    commands() {
      const fromSpec = commandsFromSpec(spec);
      if (fromSpec.length) return fromSpec;
      return Object.entries(CDG_COMMANDS).map(([name, c]) => ({
        name,
        read: !c.write,
        write: c.write,
        risk: c.write ? "caution" : "safe",
        description: ""
      }));
    }
  };
}

/**
 * Full scale from the type word (CSC `_infer_cdg_full_scale_mbar`): first the Torr-native
 * integer map, then scaled candidates matched to the option list within 5 %.
 * @param {number | null | undefined} typeWord
 * @returns {number | null}
 */
export function inferCdgFullScaleMbar(typeWord) {
  if (typeWord == null) return null;
  const direct = CDG_TORR_NATIVE_TYPE_WORDS[/** @type {keyof typeof CDG_TORR_NATIVE_TYPE_WORDS} */ (typeWord)];
  if (direct) return direct;
  const base = Number(typeWord);
  const candidates = [1, 0.1, 0.01, 0.001, 10, 1.33322, 0.133322, 0.0133322].map((scale) => base * scale);
  let best = null;
  let bestErr = 1;
  for (const cand of candidates) {
    if (cand <= 0) continue;
    let nearest = CDG_FULL_SCALE_OPTIONS_MBAR[0];
    for (const opt of CDG_FULL_SCALE_OPTIONS_MBAR) if (Math.abs(opt - cand) < Math.abs(nearest - cand)) nearest = opt;
    const rel = Math.abs(nearest - cand) / Math.max(nearest, 1e-12);
    if (rel < bestErr) {
      bestErr = rel;
      best = nearest;
    }
  }
  return best != null && bestErr <= CDG_FS_TOLERANCE ? best : null;
}

/**
 * First valid CDG frame in a byte stream, optionally with a given read echo (CSC `_first_cdg_frame`).
 * @param {Uint8Array} stream
 * @param {number | null} [readEcho]
 */
export function firstCdgFrame(stream, readEcho = null) {
  for (let i = 0; i + RESPONSE_LENGTH <= stream.length; i += 1) {
    const candidate = stream.subarray(i, i + RESPONSE_LENGTH);
    if (!isCdgFrame(candidate)) continue;
    if (readEcho != null && candidate[6] !== readEcho) continue;
    return candidate.slice();
  }
  return null;
}

/**
 * Model from validated frames (CSC `_cdg_model_from_frame`). Prefers the type-query reply
 * when it carries a model byte, and never reads a plain integer full-scale reply such as
 * 0x0002 (2 Torr) as a model code.
 * @param {Uint8Array | null} frame
 * @param {Uint8Array | null} [typeFrame]
 * @returns {string | null}
 */
export function cdgModelFromFrames(frame, typeFrame = null) {
  if (!frame) return null;
  if (typeFrame) {
    const hi = typeFrame[4];
    const lo = typeFrame[5];
    // A Torr-native integer full scale is not a model byte either: 1000 Torr is 0x03E8 and 500
    // Torr is 0x01F4, whose high bytes CSC reads as CDG160D and CDG045D. Back-port to CSC.
    const torrNative = ((hi << 8) | lo) in CDG_TORR_NATIVE_TYPE_WORDS;
    for (const code of [hi, typeFrame[7]]) {
      if (code in CDG_SENSOR_MODELS) {
        if (code === hi && ((hi === 0 && lo !== 0) || torrNative)) continue;
        return CDG_SENSOR_MODELS[/** @type {keyof typeof CDG_SENSOR_MODELS} */ (code)];
      }
    }
  }
  return CDG_SENSOR_MODELS[/** @type {keyof typeof CDG_SENSOR_MODELS} */ (frame[7])] ?? null;
}

/**
 * @param {Uint8Array} stream   bytes seen after the pressure read (or while listening)
 * @param {Uint8Array | null} [typeStream]  bytes seen after the type query
 */
export function identifyCdg(stream, typeStream = null) {
  const frame = firstCdgFrame(stream);
  const typeFrame = typeStream ? firstCdgFrame(typeStream, 0x3b) : null;
  const sensorCode = frame ? frame[7] : 0;
  const rawRatio = frame ? (((frame[4] << 24) >> 16) | frame[5]) / 16384 : 0;
  const typeWord = typeFrame ? (typeFrame[4] << 8) | typeFrame[5] : null;
  return {
    model: cdgModelFromFrames(frame, typeFrame),
    fullScaleMbar: inferCdgFullScaleMbar(typeWord),
    sensorCode,
    typeWord,
    rawRatio
  };
}

/** @param {number} b */
function hex2(b) {
  return b.toString(16).toUpperCase().padStart(2, "0");
}
