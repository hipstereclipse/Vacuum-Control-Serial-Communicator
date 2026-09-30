// @ts-check
import { ByteQueue } from "./buffer.js";

/**
 * Length-prefixed frames. `totalLength(header)` returns the whole frame length from the
 * first `headerLength` bytes, or null when the header cannot start a frame.
 *
 * - PxG55x binary: total = header byte 3 + 6 (S9, S16).
 * - INFICON P3 V02: total = 16-bit big-endian value in header bytes 3 and 4 + 7 (S9).
 *
 * A header that yields an impossible length, or a frame that fails `validate` (the CRC),
 * drops one byte and resynchronises, so garbage before a frame and a corrupted byte both
 * recover on the next good frame.
 *
 * @param {{
 *   headerLength: number,
 *   totalLength: (header: Uint8Array) => number | null,
 *   maxLength: number,
 *   validate?: (frame: Uint8Array) => boolean,
 *   accept?: (firstByte: number) => boolean,
 * }} options
 * @returns {import("../models.js").Framer}
 */
export function lengthPrefixedFramer({ headerLength, totalLength, maxLength, validate, accept = () => true }) {
  const queue = new ByteQueue();
  const hasValidator = typeof validate === "function";
  const check = validate ?? (() => true);

  /** Offset of the first complete, validated frame after offset 0, or -1. */
  function findAhead() {
    for (let offset = 1; offset + headerLength <= queue.length; offset += 1) {
      if (!accept(queue.at(offset))) continue;
      const header = new Uint8Array(headerLength);
      for (let i = 0; i < headerLength; i += 1) header[i] = queue.at(offset + i);
      const total = totalLength(header);
      if (total == null || total < headerLength || total > maxLength || offset + total > queue.length) continue;
      const candidate = new Uint8Array(total);
      for (let i = 0; i < total; i += 1) candidate[i] = queue.at(offset + i);
      if (check(candidate)) return offset;
    }
    return -1;
  }

  return {
    push(chunk) {
      queue.append(chunk);
      /** @type {Uint8Array[]} */
      const frames = [];
      while (queue.length >= headerLength) {
        if (!accept(queue.at(0))) {
          queue.drop(1);
          continue;
        }
        const total = totalLength(queue.peek(headerLength));
        if (total == null || total < headerLength || total > maxLength) {
          queue.drop(1);
          continue;
        }
        if (queue.length < total) {
          // A false header (garbage, or a corrupted frame's payload) can claim a plausible
          // length and stall the stream until that many bytes arrive. If a complete,
          // validated frame already sits further on, skip to it instead of waiting.
          const ahead = hasValidator ? findAhead() : -1;
          if (ahead > 0) {
            queue.drop(ahead);
            continue;
          }
          break;
        }
        const candidate = queue.peek(total);
        if (check(candidate)) {
          frames.push(candidate);
          queue.drop(total);
        } else {
          queue.drop(1);
        }
      }
      return frames;
    },
    reset() {
      queue.clear();
    },
    pending() {
      return queue.length;
    }
  };
}
