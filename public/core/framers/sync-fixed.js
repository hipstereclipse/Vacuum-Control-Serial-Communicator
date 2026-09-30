// @ts-check
import { ByteQueue } from "./buffer.js";

/**
 * Sync byte plus fixed length, with a validator. Used by the CDG protocol: sync 0x07,
 * 9 bytes, checksum-validated. On a failed candidate the framer slides one byte and
 * looks for the next sync, as CSC's `_first_cdg_frame` does (port_scanner.py).
 *
 * @param {{ sync: number, length: number, validate?: (frame: Uint8Array) => boolean }} options
 * @returns {import("../models.js").Framer}
 */
export function syncFixedFramer({ sync, length, validate = () => true }) {
  const queue = new ByteQueue();
  return {
    push(chunk) {
      queue.append(chunk);
      /** @type {Uint8Array[]} */
      const frames = [];
      for (;;) {
        const at = queue.indexOf(sync);
        if (at < 0) {
          queue.clear();
          break;
        }
        queue.drop(at);
        if (queue.length < length) break;
        const candidate = queue.peek(length);
        if (validate(candidate)) {
          frames.push(candidate);
          queue.drop(length);
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
