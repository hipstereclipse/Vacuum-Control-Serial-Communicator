// @ts-check
/**
 * INFICON binary protocol codec for the PSG55x and PCG55x (and, experimentally, the
 * other families CSC routes through `pfeiffer_binary`).
 *
 * Implemented from the PxG55x frame description (S16, the OEM document TQRA78E1, used as
 * a proxy until the INFICON "PxG55x Communication Protocol RS232C/RS485C" is checked, V1),
 * NOT from CSC's pfeiffer_binary.py, which differs in CRC, pressure decode, addressing and
 * response validation (WEB_PORT_PLAN.md 5.3, findings 1 to 5).
 *
 *   Address | Device ID | Ack | MsgLength | Cmd | PID hi | PID lo | Res | Res | Data... | CRC lo | CRC hi
 *
 *   MsgLength counts Cmd, PID, Reserved and Data (5 + n).
 *   Cmd: 1 read request, 2 read response, 3 write request, 4 write response.
 *   Requests carry device ID 0x00 (master); responses carry the gauge's ID (PCG: 0x02).
 *   Errors: PID 0xFFFF plus an error byte.
 *   CRC-16, reflected polynomial 0x8408, init 0xFFFF, low byte first.
 *   Maximum 64 bytes per frame.
 */
import { checkCrc16x8408, withCrc16x8408 } from "../checks/crc16-x8408.js";
import { lengthPrefixedFramer } from "../framers/length-prefixed.js";
import { float32BE, int32BE, readFloat32BE, readInt32BE, readUint32BE, text } from "../bytes.js";
import { err, info, ok } from "../models.js";
import { commandsFromSpec, formatPressure } from "./common.js";

export const CMD_READ = 1;
export const CMD_READ_RESPONSE = 2;
export const CMD_WRITE = 3;
export const CMD_WRITE_RESPONSE = 4;
export const MASTER_DEVICE_ID = 0x00;
export const ERROR_PID = 0xffff;
export const MAX_FRAME = 64;
const HEADER = 9;

/** Error byte after PID 0xFFFF (S16 🟠 V1). */
export const PXG_ERRORS = Object.freeze({
  1: "access error (parameter is read-only or write-only)",
  2: "value above maximum or below minimum",
  3: "parameter not found",
  4: "length error",
  6: "memory access error",
  7: "memory access timeout"
});

/** Pressure units for PID 224 (S16 🟠). */
export const PXG_UNITS = Object.freeze({ 0: "mbar", 1: "Torr", 2: "Pa", 3: "micron", 4: "counts" });

/**
 * Build a request frame.
 * @param {{ address?: number, cmd: number, pid: number, data?: ArrayLike<number>, deviceId?: number, ack?: number }} f
 */
export function pxgFrame({ address = 0, cmd, pid, data = [], deviceId = MASTER_DEVICE_ID, ack = 0 }) {
  const body = new Uint8Array(HEADER + data.length);
  body[0] = address & 0xff;
  body[1] = deviceId & 0xff;
  body[2] = ack & 0xff;
  body[3] = 5 + data.length;
  body[4] = cmd;
  body[5] = (pid >> 8) & 0xff;
  body[6] = pid & 0xff;
  body[7] = 0;
  body[8] = 0;
  body.set(data, HEADER);
  return withCrc16x8408(body);
}

/**
 * Decode a parsed frame into its fields; no validation beyond structure.
 * @param {Uint8Array} frame
 */
export function pxgFields(frame) {
  return {
    address: frame[0],
    deviceId: frame[1],
    ack: frame[2],
    msgLength: frame[3],
    cmd: frame[4],
    pid: (frame[5] << 8) | frame[6],
    data: frame.slice(HEADER, frame.length - 2)
  };
}

/** Length-prefixed framer: total = byte 3 + 6, CRC-validated. */
export function pxgFramer() {
  return lengthPrefixedFramer({
    headerLength: 4,
    totalLength: (h) => (h[3] >= 5 ? h[3] + 6 : null),
    maxLength: MAX_FRAME,
    validate: checkCrc16x8408
  });
}

/**
 * Decode a data field.
 * @param {Uint8Array} data
 * @param {string} type
 * @returns {{ value?: number, text?: string }}
 */
export function decodeValue(data, type) {
  const t = String(type || "").toLowerCase();
  const fix = /^fixs32en(\d+)$/.exec(t);
  if (fix) {
    if (data.length < 4) throw new Error(`${type} needs 4 data bytes, got ${data.length}`);
    // Linear: integer / 2^n (S16's example: 10 mbar is sent as 10485760 = 10 * 2^20).
    return { value: readInt32BE(data, 0) / 2 ** Number(fix[1]) };
  }
  const logFix = /^logfixs32en(\d+)$/.exec(t);
  if (logFix) {
    // 🟠 V11: CSC's decode for MAG/MPG/BPG/BCG, unverified.
    if (data.length < 4) throw new Error(`${type} needs 4 data bytes, got ${data.length}`);
    return { value: 10 ** (readInt32BE(data, 0) / 2 ** Number(logFix[1])) };
  }
  switch (t) {
    case "real32":
    case "float":
      if (data.length < 4) throw new Error(`Real32 needs 4 data bytes, got ${data.length}`);
      return { value: readFloat32BE(data, 0) };
    case "u8":
    case "uint8":
      return { value: data[0] ?? 0 };
    case "u16":
    case "uint16":
      return { value: ((data[0] ?? 0) << 8) | (data[1] ?? 0) };
    case "u32":
    case "uint32":
      return { value: readUint32BE(data, 0) };
    case "s32":
    case "int32":
      return { value: readInt32BE(data, 0) };
    case "string":
      return { text: text(data).replace(/\0.*$/s, "").trim() };
    default:
      return { text: Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("") };
  }
}

/**
 * Encode a write value.
 * @param {any} value
 * @param {string} type
 * @returns {Uint8Array}
 */
export function encodeValue(value, type) {
  const t = String(type || "").toLowerCase();
  const fix = /^fixs32en(\d+)$/.exec(t);
  if (fix) return int32BE(Math.round(Number(value) * 2 ** Number(fix[1])));
  switch (t) {
    case "real32":
    case "float":
      return float32BE(Number(value));
    case "u8":
    case "uint8":
      return Uint8Array.of(Number(value) & 0xff);
    case "u16":
    case "uint16":
      return Uint8Array.of((Number(value) >> 8) & 0xff, Number(value) & 0xff);
    case "u32":
    case "uint32":
    case "s32":
    case "int32":
      return int32BE(Number(value) | 0);
    case "none":
    case "":
      return new Uint8Array(0);
    default:
      throw new Error(`Cannot encode a write of type '${type}'`);
  }
}

/**
 * @param {any} spec
 * @param {{ address?: number, rsMode?: "RS232" | "RS485", dataUnit?: string }} [options]
 * @returns {import("../models.js").Codec & { dataUnit: string, setDataUnit: (unit: string) => void }}
 */
export function createInficonBinaryCodec(spec, options = {}) {
  const rsMode = options.rsMode ?? "RS232";
  const address = options.address ?? spec?.transport?.default_address ?? 0;
  const expectedDeviceId = spec?.device_id == null ? null : Number(spec.device_id);
  const pressureEnc = spec?.pressure_enc ?? "fixs32en20";
  const commands = spec?.commands ?? {};

  /** @param {string} name */
  function command(name) {
    const cmd = commands[name];
    if (!cmd) throw new Error(`${spec?.model ?? "Binary"}: unknown command '${name}'`);
    return cmd;
  }

  /** CSC specs describe types with `measurement`; the web specs use `data_type` directly. @param {any} cmd */
  function typeOf(cmd) {
    if (cmd.data_type) return cmd.data_type;
    if (cmd.measurement === "pressure") return pressureEnc;
    if (cmd.measurement === "temperature") return "real32";
    if (cmd.measurement === "error_flags") return "u32";
    return "hex";
  }

  const wireAddress = () => (rsMode === "RS485" ? address : 0);
  // Unit of the Real32 pressures, from a PID 224 read after identification (VGC `unitRead` pattern).
  let dataUnit = options.dataUnit ?? "mbar";

  return {
    protocol: "inficon_binary",
    address,
    get dataUnit() {
      return dataUnit;
    },
    /** @param {string} unit */
    setDataUnit(unit) {
      dataUnit = unit;
    },
    framer: pxgFramer,
    supportsContinuousOutput: () => false,
    buildRequest(name, value) {
      const cmd = command(name);
      const pid = Number(cmd.pid);
      const isWrite = value !== undefined && value !== null && value !== "";
      if (isWrite && !cmd.write) throw new Error(`Command '${name}' (PID ${pid}) is read-only`);
      if (!isWrite && !cmd.read && cmd.write) {
        // Actions such as a zero adjust are writes with a fixed value.
        if (cmd.write_value === undefined) throw new Error(`Command '${name}' (PID ${pid}) needs a value`);
        return pxgFrame({ address: wireAddress(), cmd: CMD_WRITE, pid, data: encodeValue(cmd.write_value, cmd.write_type ?? typeOf(cmd)) });
      }
      if (!isWrite) return pxgFrame({ address: wireAddress(), cmd: CMD_READ, pid });
      return pxgFrame({ address: wireAddress(), cmd: CMD_WRITE, pid, data: encodeValue(value, cmd.write_type ?? typeOf(cmd)) });
    },
    parseResponse(frame, name) {
      if (!frame || frame.length === 0) return err("No response received");
      if (frame.length < HEADER + 2) return err(`Response too short (${frame.length} bytes)`, frame);
      if (frame.length !== frame[3] + 6) return err(`Length mismatch: header says ${frame[3] + 6} bytes, got ${frame.length}`, frame);
      if (!checkCrc16x8408(frame)) return err("CRC mismatch", frame);
      const f = pxgFields(frame);
      /** @type {Record<string, any>} */
      const extra = { pid: f.pid, cmd: f.cmd, ack: f.ack, deviceId: f.deviceId, address: f.address };
      if (f.cmd === CMD_READ || f.cmd === CMD_WRITE) return err("Received a request frame (echo), not a response", frame, extra);
      if (f.cmd !== CMD_READ_RESPONSE && f.cmd !== CMD_WRITE_RESPONSE) return err(`Unexpected Cmd ${f.cmd}`, frame, extra);
      if (expectedDeviceId != null && f.deviceId !== expectedDeviceId) {
        // 🟠 V1/V4: only the PCG's device ID (2) is documented; a mismatch is reported, not fatal.
        extra.warnings = [`device ID 0x${f.deviceId.toString(16)} (spec expects 0x${expectedDeviceId.toString(16)})`];
      }
      if (f.pid === ERROR_PID) {
        const code = f.data[0];
        const why = PXG_ERRORS[/** @type {keyof typeof PXG_ERRORS} */ (code)] ?? `error code ${code}`;
        return err(`Device error: ${why}`, frame, { ...extra, errorCode: code });
      }
      if (f.ack !== 0x01) extra.warnings = [...(extra.warnings ?? []), `ack byte 0x${f.ack.toString(16)}`];

      if (f.cmd === CMD_WRITE_RESPONSE) return info("Write acknowledged", frame, extra);
      const cmd = commands[name] ?? {};
      if (cmd.pid != null && Number(cmd.pid) !== f.pid) return err(`Response is for PID ${f.pid}, expected ${cmd.pid}`, frame, extra);
      try {
        const type = typeOf(cmd);
        const decoded = decodeValue(f.data, type);
        if (decoded.text !== undefined) return info(decoded.text, frame, { ...extra, text: decoded.text });
        let value = /** @type {number} */ (decoded.value) * (cmd.scale ?? 1);
        const unit = cmd.unit === "data unit" ? dataUnit : cmd.unit ?? "";
        if (cmd.options?.length) {
          const option = cmd.options.find((/** @type {any} */ o) => Number(o.value) === value);
          return ok(value, "", option ? `${option.label} (${value})` : String(value), frame, extra);
        }
        if (cmd.measurement === "error_flags" || cmd.flag_names) {
          const names = cmd.flag_names ?? [];
          const active = names.filter((/** @type {string} */ _n, /** @type {number} */ i) => value & (1 << i));
          return ok(value, "", active.length ? active.join(", ") : "none", frame, { ...extra, flags: value, active });
        }
        const isPressure = cmd.measurement === "pressure" || /mbar|torr|pa$|micron/i.test(unit);
        const formatted = isPressure ? formatPressure(value, unit) : `${Number.isInteger(value) ? value : value.toPrecision(5)} ${unit}`.trim();
        return ok(value, unit, formatted, frame, extra);
      } catch (e) {
        return err(`Decode error: ${/** @type {Error} */ (e).message}`, frame, extra);
      }
    },
    matchesResponse(frame, name) {
      if (frame.length < HEADER + 2) return false;
      const f = pxgFields(frame);
      if (f.cmd !== CMD_READ_RESPONSE && f.cmd !== CMD_WRITE_RESPONSE) return false;
      if (rsMode === "RS485" && f.address !== address) return false;
      const cmd = commands[name];
      return f.pid === ERROR_PID || !cmd || Number(cmd.pid) === f.pid;
    },
    validateFrame(frame) {
      if (frame.length < HEADER + 2) return { ok: false, detail: `A PxG frame is at least ${HEADER + 2} bytes` };
      if (frame.length !== frame[3] + 6) return { ok: false, detail: `MsgLength ${frame[3]} implies ${frame[3] + 6} bytes, frame has ${frame.length}` };
      return checkCrc16x8408(frame) ? { ok: true, detail: "CRC OK" } : { ok: false, detail: "CRC does not validate (reflected 0x8408, init 0xFFFF, low byte first)" };
    },
    commands: () => commandsFromSpec(spec)
  };
}
