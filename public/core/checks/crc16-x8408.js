// @ts-check
/**
 * CRC-16, reflected polynomial 0x8408, initial 0xFFFF, no final XOR, transmitted low byte first.
 *
 * This is the PxG55x binary protocol CRC as described in the OEM document TQRA78E1 (S16),
 * and it validates all four example frames in that document (WEB_PORT_PLAN.md Appendix A).
 * CSC's `_crc16` (MSB-first, polynomial 0x1021) validates none of them — see plan 5.3 finding 1.
 * 🟠 V1: confirm against the INFICON "PxG55x Communication Protocol RS232C/RS485C" document.
 *
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]  exclusive
 */
export function crc16x8408(bytes, start = 0, end = bytes.length) {
  let crc = 0xffff;
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc;
}

/** Append the CRC, low byte first. @param {ArrayLike<number>} body */
export function withCrc16x8408(body) {
  const crc = crc16x8408(body);
  const out = new Uint8Array(body.length + 2);
  out.set(body);
  out[body.length] = crc & 0xff;
  out[body.length + 1] = crc >>> 8;
  return out;
}

/** True when the last two bytes are the CRC of the rest. @param {Uint8Array} frame */
export function checkCrc16x8408(frame) {
  if (frame.length < 3) return false;
  const crc = crc16x8408(frame, 0, frame.length - 2);
  return frame[frame.length - 2] === (crc & 0xff) && frame[frame.length - 1] === crc >>> 8;
}
