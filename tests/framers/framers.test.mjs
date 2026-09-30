// Framer robustness (WEB_PORT_PLAN.md section 13): every valid frame split at every byte
// boundary, frames concatenated in one chunk, garbage before a frame, single-byte
// corruption and resync, echoed requests.
import { test, assert, hex } from "../harness.mjs";
import { syncFixedFramer } from "../../public/core/framers/sync-fixed.js";
import { lengthPrefixedFramer } from "../../public/core/framers/length-prefixed.js";
import { terminatorFramer } from "../../public/core/framers/terminator.js";
import { ByteQueue } from "../../public/core/framers/buffer.js";
import { isCdgFrame } from "../../public/core/codecs/cdg-serial.js";
import { pxgFramer } from "../../public/core/codecs/inficon-binary.js";
import { ascii, concat, toHex } from "../../public/core/bytes.js";

const cdgFramer = () => syncFixedFramer({ sync: 0x07, length: 9, validate: isCdgFrame });
// A valid CDG frame: sum of bytes 1..7 = 0x00+0x00+0x00+0x20+0x00+0x00+0x01 = 0x21.
const CDG = hex("07 00 00 00 20 00 00 01 21");
const CDG2 = hex("07 00 00 02 40 00 00 01 43");
const PXG_RESPONSE = hex("00 02 01 09 02 00 DD 00 00 37 5A 05 BF D9 BB");
const PXG_REQUEST = hex("00 00 00 05 01 00 DD 00 00 AB 21");

function feedAll(framer, chunks) {
  return chunks.flatMap((c) => framer.push(c));
}

function everySplit(frame, makeFramer) {
  for (let cut = 1; cut < frame.length; cut += 1) {
    const framer = makeFramer();
    const frames = feedAll(framer, [frame.subarray(0, cut), frame.subarray(cut)]);
    assert.equal(frames.length, 1, `split at ${cut}`);
    assert.equal(toHex(frames[0]), toHex(frame));
  }
  // One byte at a time.
  const framer = makeFramer();
  const frames = feedAll(framer, Array.from(frame, (b) => Uint8Array.of(b)));
  assert.equal(frames.length, 1, "byte-by-byte");
}

test("ByteQueue grows, compacts and finds bytes", () => {
  const q = new ByteQueue(4);
  q.append(hex("01 02 03"));
  q.drop(2);
  q.append(hex("04 05 06 07 08"));
  assert.equal(q.length, 6);
  assert.equal(q.indexOf(0x06), 3);
  assert.equal(toHex(q.take(2)), "03 04");
});

test("sync-fixed: CDG frame split at every byte boundary", () => everySplit(CDG, cdgFramer));

test("sync-fixed: two frames in one chunk, garbage before, and resync after corruption", () => {
  const corrupted = CDG.slice();
  corrupted[5] ^= 0x10;
  const framer = cdgFramer();
  const frames = framer.push(concat(hex("FF 07 13 00"), corrupted, CDG, CDG2));
  assert.deepEqual(frames.map((f) => toHex(f)), [toHex(CDG), toHex(CDG2)]);
});

test("sync-fixed: an echoed 5-byte CDG command never becomes a frame", () => {
  const framer = cdgFramer();
  assert.equal(framer.push(hex("03 00 00 00 00")).length, 0);
  assert.equal(framer.push(CDG).length, 1);
});

test("sync-fixed: a 0x07 inside a request does not swallow the following frame", () => {
  const framer = cdgFramer();
  const frames = framer.push(concat(hex("03 10 07 00 17"), CDG));
  assert.equal(frames.length, 1);
  assert.equal(toHex(frames[0]), toHex(CDG));
});

test("length-prefixed: PxG frame split at every byte boundary", () => everySplit(PXG_RESPONSE, pxgFramer));

test("length-prefixed: request echo then response are both framed, in order", () => {
  const frames = pxgFramer().push(concat(PXG_REQUEST, PXG_RESPONSE));
  assert.deepEqual(frames.map((f) => toHex(f)), [toHex(PXG_REQUEST), toHex(PXG_RESPONSE)]);
});

test("length-prefixed: garbage and a corrupted frame resynchronise on the next good frame", () => {
  const bad = PXG_RESPONSE.slice();
  bad[10] ^= 0x01;
  const frames = pxgFramer().push(concat(hex("55 AA FF"), bad, PXG_RESPONSE));
  assert.equal(frames.length, 1);
  assert.equal(toHex(frames[0]), toHex(PXG_RESPONSE));
});

test("length-prefixed: impossible lengths are skipped", () => {
  const framer = lengthPrefixedFramer({ headerLength: 4, totalLength: (h) => h[3] + 6, maxLength: 64, validate: (f) => f[4] === 0x11 });
  const frames = framer.push(concat(hex("00 00 00 FF"), hex("00 00 00 00 11 22")));
  assert.equal(frames.length, 1);
  assert.equal(toHex(frames[0]), "00 00 00 00 11 22");
});

test("terminator: PPG backslash frames split everywhere and concatenated", () => {
  const frame = ascii("@ACK1.23E-03\\");
  everySplit(frame, () => terminatorFramer({ terminator: 0x5c }));
  const frames = terminatorFramer({ terminator: 0x5c }).push(ascii("@ACK1\\@253ACK2\\@NAK160\\"));
  assert.deepEqual(frames.map((f) => new TextDecoder().decode(f)), ["@ACK1\\", "@253ACK2\\", "@NAK160\\"]);
});

test("terminator: Pfeiffer CR frames ignore leading LF noise and cap runaway lines", () => {
  const framer = terminatorFramer({ terminator: 0x0d, maxLength: 16 });
  assert.equal(framer.push(ascii("\n\n0011030906BCG450099\r")).length, 1);
  assert.equal(framer.push(ascii("x".repeat(40))).length, 0);
  assert.equal(framer.pending(), 0, "runaway line discarded");
  assert.equal(framer.push(ascii("abc\r")).length, 1);
});
