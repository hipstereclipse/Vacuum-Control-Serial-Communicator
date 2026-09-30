// @ts-check
/**
 * 8-bit sum, as used by the CDG RS232C protocol (TIRA49E1): request byte 4 is the
 * sum of bytes 1 to 3 and response byte 8 is the sum of bytes 1 to 7, both mod 256.
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]  exclusive
 */
export function sum8(bytes, start = 0, end = bytes.length) {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum = (sum + bytes[i]) & 0xff;
  return sum;
}

/**
 * Pfeiffer ASCII checksum: the sum of every character before the checksum field, mod 256,
 * written as three decimal digits (TIRA89E1 / PM 800 488 BN, CSC pfeiffer_ascii.py).
 * @param {string} body
 */
export function asciiSum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum = (sum + body.charCodeAt(i)) % 256;
  return sum;
}
