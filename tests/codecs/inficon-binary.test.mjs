// PxG55x binary codec against the S16 vectors (Appendix A) and the corrections in plan 5.3.
import { test, assert, hex } from "../harness.mjs";
import { createInficonBinaryCodec, decodeValue, encodeValue, pxgFrame, CMD_READ_RESPONSE, ERROR_PID } from "../../public/core/codecs/inficon-binary.js";
import { createPxgEmulator } from "../../public/core/sim/emulators/pxg.js";
import { toHex } from "../../public/core/bytes.js";

const spec = {
  model: "PCG550",
  device_id: 2,
  transport: { default_address: 0 },
  commands: {
    pressure: { pid: 221, read: true, data_type: "fixs32en20", unit: "mbar", measurement: "pressure" },
    pressure_real32: { pid: 222, read: true, data_type: "real32", unit: "mbar" },
    data_unit: { pid: 224, read: true, write: true, data_type: "u8", options: [{ value: 0, label: "mbar" }, { value: 1, label: "Torr" }] },
    product_name: { pid: 208, read: true, data_type: "string" },
    run_hours: { pid: 104, read: true, data_type: "fixs32en2", unit: "h" },
    zero_adjust: { pid: 417, read: false, write: true, data_type: "u8", write_value: 1 }
  }
};

test("read PID 221 request matches the S16 example byte for byte", () => {
  const codec = createInficonBinaryCodec(spec);
  assert.equal(toHex(codec.buildRequest("pressure")), "00 00 00 05 01 00 DD 00 00 AB 21");
});

test("write PID 224 = 1 matches the S16 example", () => {
  const codec = createInficonBinaryCodec(spec);
  assert.equal(toHex(codec.buildRequest("data_unit", 1)), "00 00 00 06 03 00 E0 00 00 01 34 6D");
});

test("S16 read response decodes linearly to 885.63 mbar (plan 5.3 finding 2)", () => {
  const codec = createInficonBinaryCodec(spec);
  const r = codec.parseResponse(hex("00 02 01 09 02 00 DD 00 00 37 5A 05 BF D9 BB"), "pressure");
  assert.ok(r.success, r.error);
  assert.ok(Math.abs(r.value - 885.63) < 0.005, String(r.value));
  assert.equal(r.unit, "mbar");
});

test("S16 write response is acknowledged", () => {
  const codec = createInficonBinaryCodec(spec);
  const r = codec.parseResponse(hex("00 02 01 05 04 00 E0 00 00 94 EA"), "data_unit");
  assert.ok(r.success);
  assert.equal(r.formatted, "Write acknowledged");
});

test("Fixs32en20 documented example: 10 mbar is sent as 10485760", () => {
  assert.equal(decodeValue(Uint8Array.of(0x00, 0xa0, 0x00, 0x00), "Fixs32en20").value, 10);
  assert.equal(toHex(encodeValue(10, "fixs32en20")), "00 A0 00 00");
});

test("RS485 mode puts the device address in byte 0; RS232 always sends 0 (finding 3)", () => {
  assert.equal(createInficonBinaryCodec(spec, { address: 5, rsMode: "RS485" }).buildRequest("pressure")[0], 5);
  assert.equal(createInficonBinaryCodec(spec, { address: 5, rsMode: "RS232" }).buildRequest("pressure")[0], 0);
});

test("requests carry master device ID 0x00 (finding 4)", () => {
  assert.equal(createInficonBinaryCodec(spec).buildRequest("pressure")[1], 0x00);
});

test("an echoed request is rejected, and error frames decode to readable errors (finding 5)", () => {
  const codec = createInficonBinaryCodec(spec);
  assert.match(codec.parseResponse(codec.buildRequest("pressure"), "pressure").error, /echo/);
  const errFrame = pxgFrame({ deviceId: 2, ack: 1, cmd: CMD_READ_RESPONSE, pid: ERROR_PID, data: [3] });
  const r = codec.parseResponse(errFrame, "pressure");
  assert.equal(r.success, false);
  assert.match(r.error, /parameter not found/);
  assert.equal(r.extra.errorCode, 3);
});

test("CRC and length failures are errors, never exceptions", () => {
  const codec = createInficonBinaryCodec(spec);
  const bad = hex("00 02 01 09 02 00 DD 00 00 37 5A 05 BF D9 BC");
  assert.match(codec.parseResponse(bad, "pressure").error, /CRC/);
  assert.match(codec.parseResponse(hex("00 02 01 09"), "pressure").error, /too short/);
  assert.match(codec.parseResponse(new Uint8Array(0), "pressure").error, /No response/);
});

test("a device ID other than the spec's is reported as a warning, not dropped", () => {
  const codec = createInficonBinaryCodec(spec);
  const frame = pxgFrame({ deviceId: 7, ack: 1, cmd: CMD_READ_RESPONSE, pid: 221, data: [0, 0xa0, 0, 0] });
  const r = codec.parseResponse(frame, "pressure");
  assert.ok(r.success);
  assert.match(r.extra.warnings[0], /device ID/);
});

test("matchesResponse checks Cmd, PID and (in RS485) the address", () => {
  const codec = createInficonBinaryCodec(spec, { address: 3, rsMode: "RS485" });
  const good = pxgFrame({ address: 3, deviceId: 2, ack: 1, cmd: CMD_READ_RESPONSE, pid: 221, data: [0, 0, 0, 0] });
  const otherAddr = pxgFrame({ address: 4, deviceId: 2, ack: 1, cmd: CMD_READ_RESPONSE, pid: 221, data: [0, 0, 0, 0] });
  const otherPid = pxgFrame({ address: 3, deviceId: 2, ack: 1, cmd: CMD_READ_RESPONSE, pid: 222, data: [0, 0, 0, 0] });
  assert.ok(codec.matchesResponse(good, "pressure"));
  assert.ok(!codec.matchesResponse(otherAddr, "pressure"));
  assert.ok(!codec.matchesResponse(otherPid, "pressure"));
  assert.ok(!codec.matchesResponse(codec.buildRequest("pressure"), "pressure"));
});

test("action writes without a value use the spec's write_value; read-only writes are refused", () => {
  const codec = createInficonBinaryCodec(spec);
  assert.equal(toHex(codec.buildRequest("zero_adjust").subarray(0, 10)), "00 00 00 06 03 01 A1 00 00 01");
  assert.throws(() => codec.buildRequest("pressure", 5), /read-only/);
});

test("round trip against the PxG emulator: pressure, Real32 in Torr, options, strings, run hours", () => {
  const emulator = createPxgEmulator({ model: "PCG550", pressure: () => 1.5e-2 });
  const codec = createInficonBinaryCodec(spec);
  const sent = [];
  const ctx = { settings: { baudRate: 57600 }, send: (b) => sent.push(b), now: () => 0, setTimer: () => 0, clearTimer: () => {} };
  const ask = (cmd, value) => {
    sent.length = 0;
    emulator.receive(codec.buildRequest(cmd, value), ctx);
    return codec.parseResponse(sent[0], cmd);
  };
  assert.ok(Math.abs(ask("pressure").value - 1.5e-2) < 1e-6);
  assert.ok(ask("data_unit", 1).success);
  assert.equal(ask("data_unit").formatted, "Torr (1)");
  assert.ok(Math.abs(ask("pressure_real32").value - 1.5e-2 / 1.33322387415) < 1e-6);
  assert.equal(ask("product_name").formatted, "PCG550");
  assert.equal(ask("run_hours").value, 1234.5);
  sent.length = 0;
  emulator.receive(codec.buildRequest("data_unit", 9), ctx);
  assert.match(codec.parseResponse(sent[0], "data_unit").error, /above maximum/);
});
