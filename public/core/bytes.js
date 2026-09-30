// @ts-check
/**
 * Byte helpers shared by codecs, framers, the terminal and the tests.
 * No DOM, no Node APIs: these run unchanged in the browser and in Node.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");

/** @param {string} text */
export function ascii(text) {
  return encoder.encode(text);
}

/** Decode bytes one-to-one as Latin-1, so no byte is ever lost or merged. @param {Uint8Array} bytes */
export function text(bytes) {
  return decoder.decode(bytes);
}

/** @param {ArrayLike<number>} bytes @param {string} [sep] */
export function toHex(bytes, sep = " ") {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(sep);
}

/**
 * Parse "03 00 3B", "03003B", "0x03,0x00" and similar into bytes.
 * @param {string} input
 * @returns {Uint8Array}
 */
export function fromHex(input) {
  const cleaned = input.replace(/0x/gi, "").replace(/[\s,;:-]+/g, "");
  if (cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) {
    throw new Error("Hex input must be pairs of hex digits, e.g. 03 00 3B 00 3B");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** @param {Uint8Array | null | undefined} a @param {Uint8Array | null | undefined} b */
export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** @param {...ArrayLike<number>} parts */
export function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Printable view of bytes, control characters shown as <CR>, <0x07> and so on. @param {Uint8Array} bytes */
export function printable(bytes) {
  const names = { 0: "NUL", 5: "ENQ", 6: "ACK", 9: "TAB", 10: "LF", 13: "CR", 21: "NAK" };
  let out = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `<${names[/** @type {keyof typeof names} */ (b)] ?? `0x${b.toString(16).toUpperCase().padStart(2, "0")}`}>`;
  }
  return out;
}

/**
 * Parse terminal input in one of the VGC tool's formats.
 * @param {string} input
 * @param {"ascii" | "escaped" | "hex" | "decimal" | "base64"} format
 * @returns {Uint8Array}
 */
export function parseInput(input, format) {
  switch (format) {
    case "hex":
      return fromHex(input);
    case "decimal": {
      const values = input.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
        throw new Error("Decimal input must be whole numbers from 0 to 255.");
      }
      return Uint8Array.from(values);
    }
    case "base64": {
      const binary = atob(input.trim());
      return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    }
    case "escaped": {
      const unescaped = input.replace(/\\(x[0-9a-fA-F]{2}|r|n|t|0|\\)/g, (_, code) => {
        if (code === "r") return "\r";
        if (code === "n") return "\n";
        if (code === "t") return "\t";
        if (code === "0") return "\0";
        if (code === "\\") return "\\";
        return String.fromCharCode(parseInt(code.slice(1), 16));
      });
      return Uint8Array.from(unescaped, (c) => c.charCodeAt(0) & 0xff);
    }
    default:
      return Uint8Array.from(input, (c) => c.charCodeAt(0) & 0xff);
  }
}

/** @param {Uint8Array} bytes @param {number} offset */
export function readInt32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) | 0;
}

/** @param {Uint8Array} bytes @param {number} offset */
export function readUint32BE(bytes, offset) {
  return readInt32BE(bytes, offset) >>> 0;
}

/** @param {Uint8Array} bytes @param {number} offset */
export function readFloat32BE(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, false);
}

/** @param {number} value */
export function int32BE(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

/** @param {number} value */
export function float32BE(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, false);
  return out;
}
