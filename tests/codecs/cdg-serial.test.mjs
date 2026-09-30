// CDG codec: ported from CSC tests/test_cdg_serial.py and port_scanner.py behavior.
import { test, assert, hex } from "../harness.mjs";
import {
  createCdgCodec,
  identifyCdg,
  inferCdgFullScaleMbar,
  cdgModelFromFrames,
  isCdgFrame
} from "../../public/core/codecs/cdg-serial.js";
import { sum8 } from "../../public/core/checks/sum8.js";
import { toHex, concat } from "../../public/core/bytes.js";

/** Build a CDG response frame with a correct checksum. */
function frame({ page = 0, status = 0, error = 0, meas = 0, echo = 0, code = 1 } = {}) {
  const w = meas & 0xffff;
  const f = Uint8Array.of(0x07, page, status, error, w >> 8, w & 0xff, echo, code, 0);
  f[8] = sum8(f, 1, 8);
  return f;
}

test("request frames match the TIRA49E1 layout and the scanner's probes", () => {
  const codec = createCdgCodec();
  assert.equal(toHex(codec.buildRequest("pressure")), "03 00 00 00 00");
  assert.equal(toHex(codec.buildRequest("cdg_type")), "03 00 3B 00 3B");
  assert.equal(toHex(codec.buildRequest("unit", 1)), "03 10 04 01 15");
  assert.equal(toHex(codec.buildRequest("zero_adjust")), "03 40 02 00 42");
  assert.throws(() => codec.buildRequest("nope"));
});

test("read commands ignore a value; only write commands carry the data byte", () => {
  const codec = createCdgCodec();
  assert.equal(toHex(codec.buildRequest("firmware", 9)), "03 00 10 00 10");
});

test("pressure: ratio × full scale, half scale on a 10 Torr head", () => {
  const codec = createCdgCodec(null, { fullScaleMbar: 13.332 });
  const r = codec.parseResponse(frame({ meas: 8192 }), "pressure");
  assert.ok(r.success);
  assert.ok(Math.abs(r.value - 6.666) < 1e-9);
  assert.equal(r.unit, "mbar");
  assert.deepEqual(r.extra.warnings, []);
  assert.equal(r.extra.gaugeType, "CDG045D");
});

test("negative measurement words are signed", () => {
  const codec = createCdgCodec(null, { fullScaleMbar: 1 });
  const r = codec.parseContinuous(frame({ meas: -164 }));
  assert.ok(Math.abs(r.value - -164 / 16384) < 1e-12);
});

test("ratio clamps to [-0.024, 1.024] and saturation is promoted to a warning", () => {
  const codec = createCdgCodec(null, { fullScaleMbar: 10 });
  const over = codec.parseContinuous(frame({ meas: 0x7fff }));
  assert.equal(over.value, 10.24);
  assert.ok(over.extra.warnings.includes("overrange"));
  const under = codec.parseContinuous(frame({ meas: -2000 }));
  assert.ok(Math.abs(under.value - -0.24) < 1e-12);
  assert.ok(under.extra.warnings.includes("underrange"));
});

test("fatal error bits 0x20 and 0x40 discard the reading; soft bits are warnings", () => {
  const codec = createCdgCodec();
  assert.equal(codec.parseContinuous(frame({ error: 0x20 })).success, false);
  assert.equal(codec.parseContinuous(frame({ error: 0x40 })).success, false);
  const soft = codec.parseContinuous(frame({ error: 0x01 | 0x04 | 0x08 | 0x10 | 0x80, meas: 100 }));
  assert.ok(soft.success);
  assert.deepEqual(soft.extra.warnings, ["underrange", "zero adjust running", "fs adjust running", "extended status", "sensor not ready"]);
});

test("bad checksum, wrong sync, and wrong length are errors, never exceptions", () => {
  const codec = createCdgCodec();
  const bad = frame();
  bad[8] ^= 1;
  assert.match(codec.parseContinuous(bad).error, /Checksum/);
  const sync = frame();
  sync[0] = 0x06;
  assert.match(codec.parseContinuous(sync).error, /sync/);
  assert.match(codec.parseContinuous(hex("07 00")).error, /Expected 9/);
  assert.match(codec.parseContinuous(new Uint8Array(0)).error, /No response/);
});

test("firmware, setpoints, type query and ACK parse", () => {
  const codec = createCdgCodec();
  assert.equal(codec.parseResponse(frame({ meas: 0x0114, echo: 0x10 }), "firmware").formatted, "v1.20");
  const sp = codec.parseResponse(frame({ meas: 0x0a14, echo: 0x20 }), "setpoint_1_read");
  assert.deepEqual([sp.extra.low, sp.extra.high], [10, 20]);
  const type = codec.parseResponse(frame({ meas: 10, echo: 0x3b }), "cdg_type");
  assert.equal(type.extra.fullScaleHintMbar, 13.332);
  assert.equal(codec.parseResponse(frame(), "zero_adjust").formatted, "ACK");
});

test("matchesResponse uses the read-command echo in byte 6 on a streaming line", () => {
  const codec = createCdgCodec();
  assert.equal(codec.matchesResponse(frame({ echo: 0x00 }), "cdg_type"), false);
  assert.equal(codec.matchesResponse(frame({ echo: 0x3b }), "cdg_type"), true);
  assert.equal(codec.matchesResponse(frame({ echo: 0x00 }), "pressure"), true);
});

test("full-scale inference: Torr-native words, scaled candidates within 5 %, else none", () => {
  assert.equal(inferCdgFullScaleMbar(2), 2.6664);
  assert.equal(inferCdgFullScaleMbar(1000), 1333.22);
  assert.equal(inferCdgFullScaleMbar(1100), 1100);
  assert.equal(inferCdgFullScaleMbar(25), 0.25);
  assert.equal(inferCdgFullScaleMbar(7), null);
  assert.equal(inferCdgFullScaleMbar(null), null);
});

test("model inference guards against reading a full-scale integer as a model code", () => {
  const stream = frame({ code: 0x01 });
  // Type reply 0x0002 (2 Torr): high byte 0, low byte 2 → must NOT become CDG100D (0x02).
  assert.equal(cdgModelFromFrames(stream, frame({ meas: 0x0002, echo: 0x3b, code: 0x01 })), "CDG045D");
  // A type reply whose high byte is a model code wins.
  assert.equal(cdgModelFromFrames(stream, frame({ meas: 0x0400, echo: 0x3b, code: 0x01 })), "CDG200D");
  assert.equal(cdgModelFromFrames(frame({ code: 0x0b })), "HPG400");
});

test("Torr-native 1000 and 500 Torr type words are not read as CDG160D / CDG045D (CSC bug, back-port)", () => {
  assert.equal(cdgModelFromFrames(frame({ code: 0x04 }), frame({ meas: 1000, echo: 0x3b, code: 0x04 })), "CDG200D");
  assert.equal(cdgModelFromFrames(frame({ code: 0x03 }), frame({ meas: 500, echo: 0x3b, code: 0x03 })), "CDG160D");
});

test("identifyCdg finds frames inside noisy streams", () => {
  const stream = concat(hex("00 FF 07 01"), frame({ meas: 4096, code: 0x02 }));
  const typeStream = concat(frame({ meas: 8192 }), frame({ meas: 100, echo: 0x3b, code: 0x02 }));
  const id = identifyCdg(stream, typeStream);
  assert.equal(id.model, "CDG100D");
  assert.equal(id.typeWord, 100);
  assert.equal(id.fullScaleMbar, 133.32);
  assert.equal(id.rawRatio, 0.25);
  assert.ok(isCdgFrame(frame()));
});

test("setFullScale changes subsequent readings and rejects nonsense", () => {
  const codec = createCdgCodec(null, { fullScaleMbar: 1 });
  codec.setFullScale(1333.22);
  assert.ok(Math.abs(codec.parseContinuous(frame({ meas: 16384 })).value - 1333.22) < 1e-9);
  assert.throws(() => codec.setFullScale(0));
});
