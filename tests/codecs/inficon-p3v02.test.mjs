// INFICON P3 V02 codec: ported from CSC tests/test_inficon_p3_v02.py (CRC vector from
// TIRB59E1), plus framing, the echo rule and a round trip against the OPG550 emulator.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { test, assert, hex } from "../harness.mjs";
import {
  CMD_READ_REQ,
  CMD_READ_RESP,
  CMD_WRITE_REQ,
  CMD_WRITE_RESP,
  ERROR_PID,
  createP3V02Codec,
  p3BuildFrame,
  p3ParseFrame,
  crc16Mcrf4xx
} from "../../public/core/codecs/inficon-p3v02.js";
import { createP3V02Emulator } from "../../public/core/sim/emulators/p3v02.js";
import { concat, toHex, float32BE, ascii } from "../../public/core/bytes.js";

const opgSpec = () => YAML.parse(readFileSync(new URL("../../specs-src/gauges/opg550.yaml", import.meta.url), "utf8"), { uniqueKeys: false });

const READ_MFG_BODY = hex("00 00 20 00 05 01 27 10 00 00");
const READ_MFG_CRC = 0x6853;

/** struct.pack helpers */
const be = {
  u32: (...vs) => concat(...vs.map((v) => Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff))),
  u16: (...vs) => concat(...vs.map((v) => Uint8Array.of((v >> 8) & 0xff, v & 0xff))),
  i16: (...vs) => be.u16(...vs.map((v) => v & 0xffff)),
  f32: (...vs) => concat(...vs.map((v) => float32BE(v)))
};

// ── CRC and frames ───────────────────────────────────────────────────────

test("CRC-16/MCRF4XX: TIRB59E1 read-manufacturer vector and empty input", () => {
  assert.equal(crc16Mcrf4xx(READ_MFG_BODY), READ_MFG_CRC);
  assert.equal(crc16Mcrf4xx([]), 0xffff);
});

test("build_frame matches the manual's canonical read of PID 10000", () => {
  const frame = p3BuildFrame(CMD_READ_REQ, 10000);
  assert.equal(toHex(frame.subarray(0, 10)), toHex(READ_MFG_BODY));
  assert.equal(frame[10], READ_MFG_CRC & 0xff);
  assert.equal(frame[11], READ_MFG_CRC >> 8);
  assert.equal(toHex(frame), "00 00 20 00 05 01 27 10 00 00 53 68");
});

test("parse_frame round trip, bad CRC, truncation and trailing bytes", () => {
  const p = p3ParseFrame(p3BuildFrame(CMD_READ_REQ, 14000, [1]));
  assert.ok(p.crcOk);
  assert.equal(p.ver, 2);
  assert.equal(p.ack, 0);
  assert.equal(p.cmd, CMD_READ_REQ);
  assert.equal(p.pid, 14000);
  assert.equal(p.idx, 0);
  assert.equal(toHex(p.data), "01");
  assert.equal(p.trailing.length, 0);
  const bad = p3BuildFrame(CMD_READ_REQ, 10000);
  bad[bad.length - 1] ^= 0xff;
  assert.equal(p3ParseFrame(bad).crcOk, false);
  assert.throws(() => p3ParseFrame(p3BuildFrame(CMD_READ_REQ, 10000).subarray(0, 8)));
  const withTrail = p3ParseFrame(concat(p3BuildFrame(CMD_READ_REQ, 10000), hex("AA BB")));
  assert.ok(withTrail.crcOk);
  assert.equal(toHex(withTrail.trailing), "AA BB");
});

// ── build_request ─────────────────────────────────────────────────────────

const PARAMS = {
  manufacturer_name: { pid: 10000, read: true, data_type: "string" },
  pressure: { pid: 14000, read: true, data_type: "float32_be", unit: "mbar", request_data: [1] },
  self_diagnostic: { pid: 11000, read: true, data_type: "enum_uint8", options: { 0: "OK", 1: "Service", 2: "Failure" } },
  plasma_enable: { pid: 12002, read: false, write: true, data_type: "bool_uint8" },
  serial_number: { pid: 10002, read: true, data_type: "string" },
  spec_record: { pid: 20004, read: true, data_type: "opg_spec_record", request_data: [0, 0, 0, 0, 0, 1, 1, 32, 0], unit: "mbar" },
  legacy_array: { pid: 20005, read: true, data_type: "uint16_be_array" },
  spec_enable: { pid: 20000, read: false, write: true, data_type: "opg_spec_enable" },
  ror_enable: { pid: 21000, read: false, write: true, data_type: "opg_ror_enable" },
  ror_record: { pid: 21004, read: true, data_type: "opg_ror_record", request_data: [0, 0, 0, 0, 0, 1, 1, 32, 0, 1, 0, 6, 0], unit: "mbar" },
  rgd_record: { pid: 22004, read: true, data_type: "opg_rgd_record", request_data: [0, 0, 0, 0, 0, 1, 1, 32, 0, 1, 0, 10, 0, 1, 0, 8, 0], unit: "mbar" }
};
const protocol = () => createP3V02Codec({ commands: PARAMS }, { address: 0 });

test("read requests: no data, fixed request_data, runtime request data", () => {
  let p = p3ParseFrame(protocol().buildRequest("manufacturer_name"));
  assert.ok(p.cmd === CMD_READ_REQ && p.pid === 10000 && p.data.length === 0);
  p = p3ParseFrame(protocol().buildRequest("pressure"));
  assert.ok(p.pid === 14000 && toHex(p.data) === "01");
  p = p3ParseFrame(protocol().buildReadRequest("spec_record", [0xff, 0xff, 0xff, 0xff]));
  assert.ok(p.pid === 20004 && toHex(p.data) === "FF FF FF FF");
  p = p3ParseFrame(protocol().buildRequest("spec_record"));
  assert.equal(toHex(p.data), "00 00 00 00 00 01 01 20 00");
});

test("writes: spec_enable >BII default 1000 µs, ror_enable >BIB, bool_uint8", () => {
  let p = p3ParseFrame(protocol().buildRequest("spec_enable", 1));
  assert.ok(p.cmd === CMD_WRITE_REQ && p.pid === 20000);
  assert.equal(toHex(p.data), toHex(concat([1], be.u32(0, 1000))));
  p = p3ParseFrame(protocol().buildRequest("ror_enable", 1));
  assert.equal(toHex(p.data), "01 00 00 00 00 00");
  p = p3ParseFrame(protocol().buildRequest("spec_enable", { mode: 1, count: 5, integration_us: 2000 }));
  assert.equal(toHex(p.data), toHex(concat([1], be.u32(5, 2000))));
  p = p3ParseFrame(protocol().buildRequest("plasma_enable", 1));
  assert.ok(p.cmd === CMD_WRITE_REQ && p.pid === 12002 && toHex(p.data) === "01");
});

test("unknown, write to read-only and read of write-only raise", () => {
  assert.throws(() => protocol().buildRequest("not_a_command"));
  assert.throws(() => protocol().buildRequest("manufacturer_name", "foo"));
  assert.throws(() => protocol().buildRequest("plasma_enable"), /write-only/);
});

// ── parse_response ───────────────────────────────────────────────────────

const resp = (pid, data, cmd = CMD_READ_RESP) => p3BuildFrame(cmd, pid, data, { addr: 0, senderId: 0x0b, ack: 1 });

test("string, float pressure, enum label and write ack", () => {
  let r = protocol().parseResponse(resp(10000, ascii("INFICON AG\0")), "manufacturer_name");
  assert.ok(r.success && r.formatted === "INFICON AG");
  r = protocol().parseResponse(resp(14000, float32BE(1.234e-3)), "pressure");
  assert.ok(r.success && r.unit === "mbar" && Math.abs(r.value - 1.234e-3) < 1e-9);
  r = protocol().parseResponse(resp(11000, [1]), "self_diagnostic");
  assert.ok(r.success && r.formatted === "Service" && r.extra.code === 1);
  r = protocol().parseResponse(resp(12002, [], CMD_WRITE_RESP), "plasma_enable");
  assert.ok(r.success && r.formatted === "OK");
});

test("uint16 array keeps pixel data", () => {
  const r = protocol().parseResponse(resp(20005, be.u16(100, 200, 300, 400)), "legacy_array");
  assert.ok(r.success && r.value === 4);
  assert.equal(r.extra.pixel_count, 4);
  assert.deepEqual(r.extra.pixel_data, [100, 200, 300, 400]);
});

test("OPG SPEC record: metadata and pixels / 10", () => {
  const payload = concat(be.u32(7, 1234, 1000), be.f32(1.25e-3), [1], be.u32(100, 250, 400));
  const r = protocol().parseResponse(resp(20004, payload), "spec_record");
  assert.ok(r.success);
  assert.equal(r.extra.record_id, 7);
  assert.ok(Math.abs(r.extra.total_pressure_mbar - 1.25e-3) < 1e-9);
  assert.deepEqual(r.extra.pixel_data, [10, 25, 40]);
  assert.equal(r.formatted, "SPEC record 7 (3 pixels)");
});

test("OPG RoR record: pressure rise, intensities, leak-rate numbers", () => {
  const payload = concat(be.u32(11, 15000, 565227), be.f32(2.5e-3), [1], be.f32(3.75), be.u16(10, 20, 30, 40), be.i16(-130, 0, 45, 100, -344, 12));
  const r = protocol().parseResponse(resp(21004, payload), "ror_record");
  assert.ok(r.success);
  assert.equal(r.extra.pressure_rise_mtorr_per_min, 3.75);
  assert.deepEqual(r.extra.pixel_data, [10, 20, 30, 40]);
  const expected = [-1.3, 0, 0.45, 1.0, -3.44, 0.12];
  r.extra.leak_rate_numbers.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9));
  assert.equal(r.unit, "mTorr/min");
  assert.equal(r.formatted, "RoR record 11 (3.75 mTorr/min)");
});

test("OPG RGD record: pixels, partial pressures, ratios", () => {
  const payload = concat(
    be.u32(8, 66023, 481693),
    be.f32(1.5e-3),
    [1],
    be.u32(100, 200, 300),
    be.f32(...Array.from({ length: 10 }, (_, i) => i)),
    be.f32(...Array.from({ length: 10 }, (_, i) => 1e-6 * (i + 1))),
    be.f32(...Array.from({ length: 8 }, (_, i) => 0.1 * i))
  );
  const r = protocol().parseResponse(resp(22004, payload), "rgd_record");
  assert.ok(r.success);
  assert.deepEqual(r.extra.pixel_data, [10, 20, 30]);
  [1e-6, 2e-6, 3e-6].forEach((v, i) => assert.ok(Math.abs(r.extra.partial_pressures[i] - v) < 1e-12));
  assert.ok(Math.abs(r.extra.ratio_numbers[3] - 0.3) < 1e-6);
});

test("error PID, missing ACK, PID mismatch, CRC corruption, empty buffer", () => {
  let r = protocol().parseResponse(resp(ERROR_PID, [3]), "manufacturer_name");
  assert.ok(!r.success && r.error.includes("Parameter not found") && r.extra.errorCode === 3);
  r = protocol().parseResponse(p3BuildFrame(CMD_READ_RESP, 10000, ascii("X"), { senderId: 0x0b, ack: 0 }), "manufacturer_name");
  assert.ok(!r.success && r.error.includes("ACK"));
  r = protocol().parseResponse(resp(9999, ascii("X")), "manufacturer_name");
  assert.ok(!r.success && r.error.includes("PID mismatch"));
  const bad = resp(10000, ascii("AB"));
  bad[bad.length - 2] ^= 0xff;
  r = protocol().parseResponse(bad, "manufacturer_name");
  assert.ok(!r.success && r.error.includes("CRC"));
  assert.ok(!protocol().parseResponse(new Uint8Array(0), "manufacturer_name").success);
});

test("an echoed request is rejected (ACK bit clear) and does not match", () => {
  const req = protocol().buildRequest("manufacturer_name");
  assert.ok(!protocol().parseResponse(req, "manufacturer_name").success);
  assert.ok(!protocol().matchesResponse(req, "manufacturer_name"));
  assert.ok(protocol().matchesResponse(resp(10000, ascii("INFICON\0")), "manufacturer_name"));
  assert.ok(!protocol().matchesResponse(resp(10001, ascii("OPG550\0")), "manufacturer_name"));
  assert.ok(protocol().validateFrame(req).ok);
});

test("framer: every split point yields exactly one frame; garbage before a frame is skipped", () => {
  const replies = [resp(10001, ascii("OPG550\0")), resp(14000, float32BE(2.5e-3)), resp(ERROR_PID, [3])];
  for (const reply of replies) {
    for (let i = 0; i <= reply.length; i += 1) {
      const framer = protocol().framer();
      const frames = [...framer.push(reply.subarray(0, i)), ...framer.push(reply.subarray(i))];
      assert.equal(frames.length, 1, `split at ${i}`);
      assert.equal(toHex(frames[0]), toHex(reply));
    }
  }
  const framer = protocol().framer();
  const frames = framer.push(concat(hex("FF 20 13 00"), replies[0], replies[1]));
  assert.equal(frames.length, 2);
});

// ── emulator round trip ──────────────────────────────────────────────────

function fakeCtx(baudRate = 115200) {
  const sent = [];
  return { sent, settings: { baudRate }, send: (b) => sent.push(Uint8Array.from(b)), now: () => 0, setTimer: () => 0, clearTimer: () => {} };
}

function transact(emulator, codec, command, value) {
  const ctx = fakeCtx(emulator.baudRate);
  emulator.receive(codec.buildRequest(command, value), ctx);
  const frames = codec.framer().push(concat(...ctx.sent));
  return frames.length ? codec.parseResponse(frames[0], command) : null;
}

test("round trip: OPG550 spec against the emulator (identification and pressure)", () => {
  const codec = createP3V02Codec(opgSpec());
  const emu = createP3V02Emulator({ product: "OPG550", manufacturer: "INFICON", serial: "55009876", firmware: "1.20", pressure: () => 4.2e-4, ignitionDelayMs: 0 });
  assert.equal(emu.baudRate, 115200);
  assert.equal(transact(emu, codec, "product_name").formatted, "OPG550");
  assert.equal(transact(emu, codec, "manufacturer_name").formatted, "INFICON");
  assert.equal(transact(emu, codec, "serial_number").formatted, "55009876");
  assert.equal(transact(emu, codec, "software_version").formatted, "1.20");
  const p = transact(emu, codec, "pressure");
  assert.ok(p.success && Math.abs(p.value - 4.2e-4) / 4.2e-4 < 1e-6, JSON.stringify(p));
  assert.equal(transact(emu, codec, "error_status").formatted, "OK");
  assert.ok(transact(emu, codec, "plasma_enable", 1).success);
  assert.equal(transact(emu, codec, "plasma_state").formatted, "Plasma ON and ignited");
  assert.equal(emu.classify(codec.buildRequest("pressure")), "read");
  assert.equal(emu.classify(codec.buildRequest("plasma_enable", 0)), "write");
});

test("emulator: scanner-style probe of PID 10001 and an unknown PID error frame", () => {
  const emu = createP3V02Emulator();
  const ctx = fakeCtx();
  emu.receive(p3BuildFrame(CMD_READ_REQ, 10001), ctx);
  const p = p3ParseFrame(ctx.sent[0]);
  assert.ok(p.crcOk && p.ack === 1 && p.senderId === 0x0b);
  assert.equal(new TextDecoder().decode(p.data).split("\0")[0], "OPG550");
  ctx.sent.length = 0;
  emu.receive(p3BuildFrame(CMD_READ_REQ, 4242), ctx);
  const e = p3ParseFrame(ctx.sent[0]);
  assert.ok(e.pid === ERROR_PID && e.data[0] === 3);
});
