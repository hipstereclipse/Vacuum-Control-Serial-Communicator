// @ts-check
import { ByteQueue } from "./buffer.js";

/**
 * Terminator-delimited frames (PPG: backslash, S6; Pfeiffer ASCII: CR, S5).
 * The terminator stays on the frame, as CSC's `read_until` returns it.
 * Leading CR/LF noise is dropped; a frame longer than `maxLength` without a terminator is
 * discarded so a line of garbage cannot grow the buffer without bound.
 *
 * @param {{ terminator: number, maxLength?: number, skipLeading?: number[] }} options
 * @returns {import("../models.js").Framer}
 */
export function terminatorFramer({ terminator, maxLength = 512, skipLeading = [0x0a, 0x0d] }) {
  const queue = new ByteQueue();
  const skip = new Set(skipLeading.filter((b) => b !== terminator));
  return {
    push(chunk) {
      queue.append(chunk);
      /** @type {Uint8Array[]} */
      const frames = [];
      for (;;) {
        while (queue.length && skip.has(queue.at(0))) queue.drop(1);
        const at = queue.indexOf(terminator);
        if (at < 0) {
          if (queue.length > maxLength) queue.clear();
          break;
        }
        if (at === 0) {
          queue.drop(1);
          continue;
        }
        frames.push(queue.take(at + 1));
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
