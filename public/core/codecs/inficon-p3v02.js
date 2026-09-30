// @ts-check
/**
 * INFICON P3 V02 binary protocol codec — OPG550 (TIRB59E1).
 * One-to-one port of CSC src/serial_comm/protocols/inficon_p3_v02.py, including the OPG
 * SPEC / RoR / RGD record decoders.
 *
 *   Byte 0      ADDR   0x00 on RS232, receiver address on RS485
 *   Byte 1      ID     sender ID (master 0x00, OPG550 0x0B)
 *   Byte 2      HDR    VER (bits 7..4, = 2) | RES | ACK (bit 0: 0 from master, 1 from slave)
 *   Bytes 3..4  LEN    APDU length, big endian = 1 (CMD) + 2 (PID) + 2 (IDX) + data
 *   Byte 5      CMD    1 read req, 2 read resp, 3 write req, 4 write resp
 *   Bytes 6..7  PID    big endian
 *   Bytes 8..9  IDX    always 0
 *   Bytes 10..  DATA
 *   Last 2      CRC-16/MCRF4XX (reflected 0x8408, init 0xFFFF, no final XOR), low byte first
 *
 *   Total length = LEN + 7. Errors come back as PID 0xFFFF plus one error byte.
 *
 * The CRC is the same algorithm as the PxG55x CRC (checks/crc16-x8408.js); CSC's test vector
 * (read PID 10000 -> CRC 0x6853, from TIRB59E1) is a permanent unit test.
 */
import { crc16x8408 } from "../checks/crc16-x8408.js";
import { lengthPrefixedFramer } from "../framers/length-prefixed.js";
import { ascii, float32BE, int32BE, readFloat32BE, readInt32BE, readUint32BE, toHex } from "../bytes.js";
import { err, info, ok } from "../models.js";
import { commandsFromSpec, formatPressure } from "./common.js";

export const PROTOCOL_VERSION = 2;
export const MASTER_ID = 0x00;
/** Slave device IDs by product; the OPG550 answers with 0x0B. */
export const KNOWN_SLAVE_IDS = Object.freeze([0x0b]);
export const CMD_READ_REQ = 0x01;
export const CMD_READ_RESP = 0x02;
export const CMD_WRITE_REQ = 0x03;
export const CMD_WRITE_RESP = 0x04;
export const ERROR_PID = 0xffff;
/** Largest frame the 16-bit LEN field allows. */
export const MAX_FRAME = 5 + 0xffff + 2;

export const P3_ERRORS = Object.freeze({
  0: "Application error (see error history)",
  1: "Access violation",
  2: "Parameter out of limits",
  3: "Parameter not found",
  4: "Data length error",
  5: "Wrong password",
  6: "Fatal EEPROM error",
  7: "Timeout",
  9: "Not in setup mode",
  100: "CRC mismatch",
  101: "Wrong command",
  102: "Acknowledge bit set but should not be",
  103: "Acknowledge bit not set but should be",
  104: "Wrong protocol version"
});

/** CRC-16/MCRF4XX (CSC `crc16_mcrf4xx`). @param {ArrayLike<number>} data */
export function crc16Mcrf4xx(data) {
  return crc16x8408(data);
}

/**
 * Build a complete, CRC-checked frame (CSC `build_frame`).
 * @param {number} cmd
 * @param {number} pid
 * @param {ArrayLike<number>} [data]
 * @param {{ addr?: number, senderId?: number, ack?: number }} [opts]
 */
export function p3BuildFrame(cmd, pid, data = [], { addr = 0x00, senderId = MASTER_ID, ack = 0 } = {}) {
  const apduLen = 5 + data.length;
  const out = new Uint8Array(10 + data.length + 2);
  out[0] = addr & 0xff;
  out[1] = senderId & 0xff;
  out[2] = ((PROTOCOL_VERSION & 0x0f) << 4) | (ack & 0x01);
  out[3] = (apduLen >> 8) & 0xff;
  out[4] = apduLen & 0xff;
  out[5] = cmd & 0xff;
  out[6] = (pid >> 8) & 0xff;
  out[7] = pid & 0xff;
  out.set(data, 10);
  const crc = crc16x8408(out, 0, 10 + data.length);
  out[10 + data.length] = crc & 0xff;
  out[11 + data.length] = crc >>> 8;
  return out;
}

/**
 * Parse a complete frame buffer (CSC `parse_frame`). Throws when the buffer is too short or
 * truncated; a CRC failure is reported in `crcOk`, not thrown.
 * @param {Uint8Array} buf
 */
export function p3ParseFrame(buf) {
  if (buf.length < 12) throw new Error(`frame too short (${buf.length} bytes)`);
  const apduLen = (buf[3] << 8) | buf[4];
  const total = 5 + apduLen + 2;
  if (buf.length < total) throw new Error(`frame truncated (need ${total}, have ${buf.length})`);
  // 🟠 V13: like CSC, an APDU length below 5 is not rejected here; PID and IDX are then read
  // from bytes beyond the APDU. The framer below never produces such a frame.
  const crcRx = (buf[5 + apduLen + 1] << 8) | buf[5 + apduLen];
  const crcCalc = crc16x8408(buf, 0, 5 + apduLen);
  return {
    addr: buf[0],
    senderId: buf[1],
    ack: buf[2] & 0x01,
    ver: (buf[2] >> 4) & 0x0f,
    cmd: buf[5],
    pid: (buf[6] << 8) | buf[7],
    idx: (buf[8] << 8) | buf[9],
    data: buf.slice(10, Math.max(10, 5 + apduLen)),
    crcOk: crcRx === crcCalc,
    crcRx,
    crcCalc,
    totalLen: total,
    trailing: buf.slice(total)
  };
}

/**
 * Length-prefixed framer: 5-byte header, total = LEN + 7, CRC-validated. A header whose
 * version nibble is not 2 or whose LEN is below 5 cannot start a frame, which keeps a
 * garbage byte from stalling the framer on an absurd length.
 * @param {{ maxLength?: number }} [opts]
 */
export function p3Framer({ maxLength = MAX_FRAME } = {}) {
  return lengthPrefixedFramer({
    headerLength: 5,
    totalLength: (h) => {
      const apdu = (h[3] << 8) | h[4];
      if (h[2] >> 4 !== PROTOCOL_VERSION || apdu < 5) return null;
      return apdu + 7;
    },
    maxLength,
    validate: checkP3Crc
  });
}

/** @param {Uint8Array} frame */
function checkP3Crc(frame) {
  if (frame.length < 12) return false;
  const crc = crc16x8408(frame, 0, frame.length - 2);
  return frame[frame.length - 2] === (crc & 0xff) && frame[frame.length - 1] === crc >>> 8;
}

// ── Data-type coders (CSC `_encode_value` / `_decode_value`) ─────────────────

/**
 * @param {any} value
 * @param {string} dataType
 * @returns {Uint8Array}
 */
export function encodeP3Value(value, dataType) {
  if (dataType === "opg_all_algorithms_off") return Uint8Array.of(0);
  if (dataType === "opg_spec_enable" || dataType === "opg_ror_enable" || dataType === "opg_rgd_enable") {
    if (value instanceof Uint8Array) return Uint8Array.from(value);
    const isSpec = dataType === "opg_spec_enable";
    let mode;
    let count;
    let third;
    if (Array.isArray(value)) {
      mode = value.length > 0 ? int(value[0]) : 1;
      count = value.length > 1 ? int(value[1]) : 0;
      third = value.length > 2 ? int(value[2]) : isSpec ? 1000 : 0;
    } else if (value && typeof value === "object") {
      mode = int(value.mode ?? 1);
      count = int(value.count ?? value.number_of_spectra ?? 0);
      third = isSpec ? int(value.integration_us ?? 1000) : int(value.gas ?? value.gas_number ?? 0);
    } else {
      mode = int(value);
      count = 0;
      third = isSpec ? 1000 : 0;
    }
    // SPEC: >BII (mode, count, integration µs); RoR / RGD: >BIB (mode, count, gas).
    const out = new Uint8Array(isSpec ? 9 : 6);
    const view = new DataView(out.buffer);
    view.setUint8(0, mode & 0xff);
    view.setUint32(1, count >>> 0, false);
    if (isSpec) view.setUint32(5, third >>> 0, false);
    else view.setUint8(5, third & 0xff);
    return out;
  }
  if (dataType === "uint8" || dataType === "enum_uint8" || dataType === "bool_uint8") return Uint8Array.of(int(value) & 0xff);
  if (dataType === "uint16_be") {
    const v = int(value) & 0xffff;
    return Uint8Array.of(v >> 8, v & 0xff);
  }
  if (dataType === "uint32_be") return int32BE(int(value) >>> 0);
  if (dataType === "int32_be") {
    const v = int(value);
    // Python struct.pack(">i") raises out of range rather than wrapping.
    if (v < -0x80000000 || v > 0x7fffffff) throw new Error(`int32 value out of range: ${v}`);
    return int32BE(v);
  }
  if (dataType === "float32_be") return float32BE(Number(value));
  if (dataType === "string") {
    if (value instanceof Uint8Array) return value;
    return Uint8Array.from(String(value), (c) => (c.charCodeAt(0) < 0x80 ? c.charCodeAt(0) : 0x3f));
  }
  throw new Error(`Unknown data_type for encode: '${dataType}'`);
}

/**
 * @param {Uint8Array} data
 * @param {string} dataType
 * @param {string} unit
 * @param {Uint8Array} raw
 * @param {Record<number, string> | null} [options]
 * @returns {import("../models.js").Reading}
 */
export function decodeP3Value(data, dataType, unit, raw, options = null) {
  try {
    if (dataType === "uint8" || dataType === "bool_uint8") {
      if (data.length < 1) return err("empty uint8 payload", raw);
      return ok(data[0], unit, `${data[0]} ${unit}`.trim(), raw);
    }
    if (dataType === "enum_uint8") {
      if (data.length < 1) return err("empty enum payload", raw);
      const code = data[0];
      const label = options?.[code] ?? `code ${code}`;
      return { success: true, value: code, unit, formatted: label, raw, extra: { code, label } };
    }
    if (dataType === "uint16_be") {
      if (data.length < 2) return err("short uint16", raw);
      const v = (data[0] << 8) | data[1];
      return ok(v, unit, `${v} ${unit}`.trim(), raw);
    }
    if (dataType === "uint32_be") {
      if (data.length < 4) return err("short uint32", raw);
      const v = readUint32BE(data, 0);
      return ok(v, unit, `${v} ${unit}`.trim(), raw);
    }
    if (dataType === "int32_be") {
      if (data.length < 4) return err("short int32", raw);
      const v = readInt32BE(data, 0);
      return ok(v, unit, `${v} ${unit}`.trim(), raw);
    }
    if (dataType === "float32_be") {
      if (data.length < 4) return err("short float32", raw);
      const v = readFloat32BE(data, 0);
      return ok(v, unit, formatPressure(v, unit), raw);
    }
    if (dataType === "string") {
      const text = cString(data);
      return info(text, raw, { text });
    }
    if (dataType === "uint16_be_array") {
      if (data.length < 2) return err("empty uint16 array", raw);
      const n = data.length >> 1;
      const values = u16Array(data, 0, n);
      const peak = values.reduce((m, v) => Math.max(m, v), 0);
      let pixelData = values;
      // CSC keeps the last 288 pixels when a longer array carries data there.
      if (n > 288 && peak > 0) {
        const tail = values.slice(-288);
        if (tail.reduce((m, v) => Math.max(m, v), 0) > 0) pixelData = tail;
      }
      return {
        success: true,
        value: n,
        formatted: `${n} pixels`,
        raw,
        extra: { pixel_count: pixelData.length, pixel_data: pixelData, raw_array: values }
      };
    }
    if (dataType === "opg_spec_record") return decodeSpecRecord(data, unit || "mbar", raw);
    if (dataType === "opg_ror_record") return decodeRorRecord(data, unit || "mbar", raw);
    if (dataType === "opg_rgd_record") return decodeRgdRecord(data, unit || "mbar", raw);
    if (dataType === "error_record") {
      // 4-byte error number + NUL-terminated description + NUL-terminated solution.
      if (data.length < 4) return err("short error record", raw);
      const code = readUint32BE(data, 0);
      const parts = asciiReplace(data.subarray(4)).split("\0");
      const description = parts[0] ?? "";
      const solution = parts[1] ?? "";
      return { success: true, value: code, formatted: `[${code}] ${description}`, raw, extra: { code, description, solution } };
    }
    const hexText = toHex(data, "").toLowerCase();
    return info(hexText, raw, { hex: hexText });
  } catch (e) {
    return err(`Decode error (${dataType}): ${/** @type {Error} */ (e).message}`, raw);
  }
}

/** @param {Uint8Array} data @param {Uint8Array} raw */
function decodeRecordHeader(data, raw) {
  if (data.length < 17) return err("short OPG record header", raw);
  const ignition = data[16];
  return {
    record_id: readUint32BE(data, 0),
    time_ms: readUint32BE(data, 4),
    integration_us: readUint32BE(data, 8),
    total_pressure_mbar: readFloat32BE(data, 12),
    ignition_status: ignition,
    ignition_active: Boolean(ignition)
  };
}

/** @param {number[]} values @param {string} unit */
function scaleToUnit(values, unit) {
  if (unit === "Torr") return values.map((v) => v / 750.062);
  // 🟠 V13: CSC divides by 100 for Pascal and by 750062 for micron. mbar -> Pa is x100 and
  // mbar -> micron is x750.062, so these look inverted or wrong; kept for parity.
  if (unit === "Pascal") return values.map((v) => v / 100);
  if (unit === "micron") return values.map((v) => v / 750062);
  return values;
}

/** @param {Uint8Array} data @param {string} unit @param {Uint8Array} raw @returns {import("../models.js").Reading} */
function decodeSpecRecord(data, unit, raw) {
  const header = decodeRecordHeader(data, raw);
  if ("success" in header) return header;
  const count = (data.length - 17) >> 2;
  const powers = u32Array(data, 17, count);
  const pixelData = powers.map((v) => v / 10);
  const extra = { ...header, pixel_count: pixelData.length, pixel_data: pixelData, raw_array: powers, spectrum_power: pixelData };
  return { success: true, value: pixelData.length, unit, formatted: `SPEC record ${header.record_id} (${pixelData.length} pixels)`, raw, extra };
}

/** @param {Uint8Array} data @param {string} _unit @param {Uint8Array} raw @returns {import("../models.js").Reading} */
function decodeRorRecord(data, _unit, raw) {
  const header = decodeRecordHeader(data, raw);
  if ("success" in header) return header;
  let offset = 17;
  if (data.length < offset + 4) return err("short OPG RoR pressure-rise payload", raw);
  const pressureRise = readFloat32BE(data, offset);
  offset += 4;
  const remaining = data.length - offset;
  // 🟠 V13: CSC assumes six leak-rate numbers whenever at least 12 bytes remain.
  const gasCount = remaining >= 12 ? 6 : 0;
  const pixelCount = Math.max(0, remaining - gasCount * 2) >> 1;
  const intensities = u16Array(data, offset, pixelCount);
  offset += pixelCount * 2;
  const leakRates = [];
  for (let i = 0; i < gasCount; i += 1) leakRates.push((((data[offset + i * 2] << 24) >> 16) | data[offset + i * 2 + 1]) / 100);
  const extra = {
    ...header,
    pressure_rise_mtorr_per_min: pressureRise,
    pixel_count: intensities.length,
    pixel_data: intensities,
    raw_array: intensities,
    spectrum_intensity: intensities,
    leak_rate_numbers: leakRates
  };
  return {
    success: true,
    value: pressureRise,
    unit: "mTorr/min",
    formatted: `RoR record ${header.record_id} (${pyG3(pressureRise)} mTorr/min)`,
    raw,
    extra
  };
}

/** @param {Uint8Array} data @param {string} unit @param {Uint8Array} raw @returns {import("../models.js").Reading} */
function decodeRgdRecord(data, unit, raw) {
  const header = decodeRecordHeader(data, raw);
  if ("success" in header) return header;
  let offset = 17;
  const gasCount = 10;
  const ratioCount = 8;
  const tailBytes = gasCount * 4 * 2 + ratioCount * 4;
  const pixelCount = Math.max(0, data.length - offset - tailBytes) >> 2;
  const powers = u32Array(data, offset, pixelCount);
  offset += pixelCount * 4;
  const gasIntensities = data.length >= offset + gasCount * 4 ? f32Array(data, offset, gasCount) : [];
  offset += gasIntensities.length * 4;
  const partials = data.length >= offset + gasCount * 4 ? f32Array(data, offset, gasCount) : [];
  offset += partials.length * 4;
  const ratios = data.length >= offset + ratioCount * 4 ? f32Array(data, offset, ratioCount) : [];
  const pixelData = powers.map((v) => v / 10);
  const extra = {
    ...header,
    pixel_count: pixelData.length,
    pixel_data: pixelData,
    raw_array: powers,
    spectrum_power: pixelData,
    gas_intensities: gasIntensities,
    partial_pressures: scaleToUnit(partials, unit),
    ratio_numbers: ratios
  };
  return { success: true, value: pixelData.length, unit, formatted: `RGD record ${header.record_id} (${pixelData.length} pixels)`, raw, extra };
}

/**
 * Enum options as {code: label} (CSC `_normalize_options`). A list may use `code` (CSC) or
 * `value` (the web spec convention used by commandsFromSpec).
 * @param {any} options
 * @returns {Record<number, string> | null}
 */
export function normalizeP3Options(options) {
  if (options == null) return null;
  if (Array.isArray(options)) {
    /** @type {Record<number, string>} */
    const out = {};
    for (const item of options) {
      if (item && typeof item === "object" && ("code" in item || "value" in item)) {
        const code = item.code ?? item.value;
        out[Number(code)] = String(item.label ?? code);
      }
    }
    return Object.keys(out).length ? out : null;
  }
  if (typeof options === "object") {
    /** @type {Record<number, string>} */
    const out = {};
    for (const [k, v] of Object.entries(options)) out[Number(k)] = String(v);
    return out;
  }
  return null;
}

/**
 * Fixed request data (CSC `_coerce_request_data`).
 * @param {any} req
 * @returns {Uint8Array}
 */
export function coerceRequestData(req) {
  if (req == null) return new Uint8Array(0);
  if (req instanceof Uint8Array) return Uint8Array.from(req);
  if (typeof req === "string") return ascii(req);
  if (Array.isArray(req)) return Uint8Array.from(req, (b) => int(b) & 0xff);
  if (typeof req === "number" && Number.isInteger(req)) return Uint8Array.of(req & 0xff);
  throw new Error(`Unsupported request_data: ${JSON.stringify(req)}`);
}

/**
 * @param {any} spec   device spec (CSC YAML keys), or null
 * @param {{ address?: number }} [options]
 * @returns {import("../models.js").Codec & { buildReadRequest: (command: string, requestData?: any) => Uint8Array }}
 */
export function createP3V02Codec(spec = null, options = {}) {
  const address = Number(options.address ?? spec?.transport?.default_address ?? 0);
  /** @type {Record<string, any>} */
  const params = spec?.commands ?? {};

  /** @param {string} name */
  function command(name) {
    const cmd = params[name];
    if (!cmd) throw new Error(`InficonP3V02Protocol: unknown command '${name}'`);
    return cmd;
  }

  /** @param {string} name @param {any} [requestData] */
  function buildReadRequest(name, requestData) {
    const cmd = command(name);
    const pid = Number(cmd.pid);
    if (!cmd.read) throw new Error(`Command '${name}' (PID ${pid}) is write-only`);
    const data = requestData != null ? coerceRequestData(requestData) : coerceRequestData(cmd.request_data);
    return p3BuildFrame(CMD_READ_REQ, pid, data, { addr: address });
  }

  return {
    protocol: "inficon_p3_v02",
    address,
    framer: () => p3Framer(),
    supportsContinuousOutput: () => false,
    buildReadRequest,
    buildRequest(name, value) {
      const cmd = command(name);
      const pid = Number(cmd.pid);
      // CSC: None means read. 🟠 A write-only action (e.g. all_algorithms_off) therefore needs a
      // dummy value, because a read of it raises "write-only".
      if (value === undefined || value === null) return buildReadRequest(name);
      if (!cmd.write) throw new Error(`Command '${name}' (PID ${pid}) is read-only`);
      return p3BuildFrame(CMD_WRITE_REQ, pid, encodeP3Value(value, cmd.data_type ?? "uint8"), { addr: address });
    },
    parseResponse(raw, name) {
      if (!raw || raw.length === 0) return err("No response received");
      let parsed;
      try {
        parsed = p3ParseFrame(raw);
      } catch (e) {
        return err(`Malformed frame: ${/** @type {Error} */ (e).message}`, raw);
      }
      if (!parsed.crcOk) return err(`CRC mismatch (rx=0x${hex4(parsed.crcRx)} calc=0x${hex4(parsed.crcCalc)})`, raw);
      // An echoed request has ACK = 0 and is rejected here.
      if (parsed.ack !== 1) return err("Slave response missing ACK bit", raw, { pid: parsed.pid, cmd: parsed.cmd });
      if (parsed.pid === ERROR_PID) {
        const code = parsed.data.length ? parsed.data[0] : -1;
        const desc = P3_ERRORS[/** @type {keyof typeof P3_ERRORS} */ (code)] ?? `error code ${code}`;
        return err(`Device error ${code}: ${desc}`, raw, { errorCode: code });
      }
      const cmd = params[name] ?? {};
      if (cmd.pid != null && parsed.pid !== Number(cmd.pid)) return err(`PID mismatch: expected ${cmd.pid}, got ${parsed.pid}`, raw);
      if (parsed.cmd === CMD_WRITE_RESP) return info("OK", raw);
      if (parsed.cmd !== CMD_READ_RESP) return err(`Unexpected response CMD 0x${parsed.cmd.toString(16).toUpperCase().padStart(2, "0")}`, raw);
      return decodeP3Value(parsed.data, cmd.data_type ?? "string", cmd.unit ?? "", raw, normalizeP3Options(cmd.options || null));
    },
    matchesResponse(frame, name) {
      let parsed;
      try {
        parsed = p3ParseFrame(frame);
      } catch {
        return false;
      }
      if (!parsed.crcOk || parsed.ack !== 1) return false;
      if (parsed.cmd !== CMD_READ_RESP && parsed.cmd !== CMD_WRITE_RESP) return false;
      const cmd = params[name];
      return parsed.pid === ERROR_PID || !cmd || cmd.pid == null || Number(cmd.pid) === parsed.pid;
    },
    validateFrame(frame) {
      if (frame.length < 12) return { ok: false, detail: "A P3 V02 frame is at least 12 bytes" };
      const total = ((frame[3] << 8) | frame[4]) + 7;
      if (frame.length !== total) return { ok: false, detail: `LEN ${total - 7} implies ${total} bytes, frame has ${frame.length}` };
      if (frame[2] >> 4 !== PROTOCOL_VERSION) return { ok: false, detail: `Header version ${frame[2] >> 4}, expected ${PROTOCOL_VERSION}` };
      return checkP3Crc(frame)
        ? { ok: true, detail: "CRC OK" }
        : { ok: false, detail: "CRC does not validate (CRC-16/MCRF4XX, low byte first)" };
    },
    commands: () => commandsFromSpec(spec)
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Python int(): numbers truncate, strings must be integer literals. @param {any} v */
function int(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`cannot convert ${v} to integer`);
    return Math.trunc(v);
  }
  const m = /^\s*([+-]?\d+)\s*$/.exec(String(v));
  if (!m) throw new Error(`invalid literal for int() with base 10: '${v}'`);
  return Number(m[1]);
}

/** @param {Uint8Array} d @param {number} offset @param {number} n */
function u16Array(d, offset, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (d[offset + i * 2] << 8) | d[offset + i * 2 + 1];
  return out;
}

/** @param {Uint8Array} d @param {number} offset @param {number} n */
function u32Array(d, offset, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = readUint32BE(d, offset + i * 4);
  return out;
}

/** @param {Uint8Array} d @param {number} offset @param {number} n */
function f32Array(d, offset, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = readFloat32BE(d, offset + i * 4);
  return out;
}

/** Text up to the first NUL, Python `.decode("ascii", errors="replace")`. @param {Uint8Array} data */
function cString(data) {
  const end = data.indexOf(0);
  return asciiReplace(end < 0 ? data : data.subarray(0, end));
}

/** @param {Uint8Array} bytes */
function asciiReplace(bytes) {
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : "�";
  return s;
}

/** Python "{:.3g}". @param {number} v */
function pyG3(v) {
  if (!Number.isFinite(v)) return v !== v ? "nan" : v > 0 ? "inf" : "-inf";
  if (v === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(Number(v.toPrecision(3)))));
  if (exp < -4 || exp >= 3) {
    const [m, e] = v.toExponential(2).split("e");
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const n = Number(e);
    return `${mant}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const fixed = v.toFixed(Math.max(0, 2 - exp));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** @param {number} n */
function hex4(n) {
  return n.toString(16).toUpperCase().padStart(4, "0");
}
