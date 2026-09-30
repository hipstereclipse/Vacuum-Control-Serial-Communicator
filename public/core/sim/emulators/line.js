// @ts-check
// Real gauges discard a partial frame after an inter-character timeout, so bytes left over
// from another protocol's probe cannot glue onto the next request.
export const INTER_CHAR_TIMEOUT_MS = 100;

/**
 * @param {import("../../models.js").Framer} framer
 * @returns {(bytes: Uint8Array, now: number) => Uint8Array[]}
 */
export function timedFramer(framer) {
  let last = -Infinity;
  return (bytes, now) => {
    if (now - last > INTER_CHAR_TIMEOUT_MS) framer.reset();
    last = now;
    return framer.push(bytes);
  };
}
