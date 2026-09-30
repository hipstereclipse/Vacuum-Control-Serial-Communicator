// Golden vectors from WEB_PORT_PLAN.md Appendix A. The four PxG55x frames come from S16
// (🟠 OEM document, V1) and become permanent unit tests.
import { test, assert, hex } from "../harness.mjs";
import { crc16x8408, checkCrc16x8408, withCrc16x8408 } from "../../public/core/checks/crc16-x8408.js";
import { sum8, asciiSum } from "../../public/core/checks/sum8.js";
import { toHex } from "../../public/core/bytes.js";

export const PXG_VECTORS = [
  ["read PID 221 request", "00 00 00 05 01 00 DD 00 00", "AB 21"],
  ["read PID 221 response", "00 02 01 09 02 00 DD 00 00 37 5A 05 BF", "D9 BB"],
  ["write PID 224 = 1 request", "00 00 00 06 03 00 E0 00 00 01", "34 6D"],
  ["write PID 224 response", "00 02 01 05 04 00 E0 00 00", "94 EA"]
];

for (const [name, body, crc] of PXG_VECTORS) {
  test(`CRC-16/0x8408 validates S16 vector: ${name}`, () => {
    const frame = withCrc16x8408(hex(body));
    assert.equal(toHex(frame.subarray(-2)), crc);
    assert.ok(checkCrc16x8408(hex(`${body} ${crc}`)));
  });
}

test("CSC's MSB-first 0x1021 CRC does not validate the S16 vectors (plan 5.3 finding 1)", () => {
  const cscCrc = (bytes) => {
    let crc = 0xffff;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i += 1) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
    }
    return crc;
  };
  for (const [, body, crc] of PXG_VECTORS) {
    const c = cscCrc(hex(body));
    assert.notEqual(toHex([c & 0xff, c >> 8]), crc);
  }
});

test("crc16x8408 over a sub-range equals the CRC of the slice", () => {
  const bytes = hex("FF 00 00 00 05 01 00 DD 00 00 FF");
  assert.equal(crc16x8408(bytes, 1, 10), crc16x8408(bytes.subarray(1, 10)));
});

test("CDG probe frames satisfy the checksum rule (sum of bytes 1..3)", () => {
  for (const frame of [hex("03 00 00 00 00"), hex("03 00 3B 00 3B")]) assert.equal(sum8(frame, 1, 4), frame[4]);
});

test("Pfeiffer ASCII checksums for parameters 309 and 310 at address 001", () => {
  assert.equal(asciiSum("0010030902=?"), 107);
  assert.equal(asciiSum("0010031002=?"), 99);
});
