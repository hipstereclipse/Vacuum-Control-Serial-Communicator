// Pfeiffer ASCII codec: ported from CSC tests/test_pfeiffer_ascii.py, plus the plan's golden
// vectors (Appendix A), the scanner's response validation, framing and an emulator round trip.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { test, assert } from "../harness.mjs";
import {
  createPfeifferAsciiCodec,
  pfeifferReadFrame,
  isValidPfeifferResponse,
  pfeifferData,
  pfeifferFrame,
  encodePfeifferValue
} from "../../public/core/codecs/pfeiffer-ascii.js";
import { asciiSum } from "../../public/core/checks/sum8.js";
import { createPfeifferAsciiEmulator, expoNew } from "../../public/core/sim/emulators/pfeiffer-ascii.js";
import { ascii, text, concat } from "../../public/core/bytes.js";

const loadSpec = (name) => YAML.parse(readFileSync(new URL(`../../specs-src/gauges/${name}.yaml`, import.meta.url), "utf8"), { uniqueKeys: false });

const PARAMS = {
  pressure: { pid: 340, data_type: "u_expo_new", read: true, write: false, unit: "mbar" },
  standby: { pid: 2, data_type: "boolean_old", read: true, write: true, unit: "" },
  actual_speed_hz: { pid: 309, data_type: "u_integer", read: true, write: false, unit: "Hz" },
  motor_current_A: { pid: 310, data_type: "u_real", read: true, write: false, unit: "A" },
  firmware: { pid: 312, data_type: "string", read: true, write: false, unit: "" },
  motor_on: { pid: 23, data_type: "boolean_old", read: true, write: true, unit: "" }
};
const proto = () => createPfeifferAsciiCodec({ commands: PARAMS }, { address: 1 });

/** CSC test helper `make_response`. */
function makeResponse(addr, pid, data) {
  return pfeifferFrame(addr, "10", pid, data);
}

// ── golden vectors and checksum ──────────────────────────────────────────

test("golden vectors: parameter 309 and 310 reads at address 001 (plan Appendix A)", () => {
  assert.equal(text(pfeifferReadFrame(309)), "0010030902=?107\r");
  assert.equal(text(pfeifferReadFrame(310)), "0010031002=?099\r");
  assert.equal(text(pfeifferReadFrame(309, 1)), text(proto().buildRequest("actual_speed_hz")));
});

test("checksum: empty string is 0, known value is the ASCII sum mod 256", () => {
  assert.equal(asciiSum(""), 0);
  const frame = "00100030002=?";
  assert.equal(asciiSum(frame), [...frame].reduce((s, c) => s + c.charCodeAt(0), 0) % 256);
});

// ── build_request ─────────────────────────────────────────────────────────

test("read request fields: addr 001, action 00, pid 340, len 02, =?, valid checksum, CR", () => {
  const t = text(proto().buildRequest("pressure"));
  assert.ok(t.startsWith("0010034002=?"));
  assert.equal(t.slice(0, 3), "001");
  assert.equal(t.slice(3, 5), "00");
  assert.equal(t.slice(5, 8), "340");
  assert.equal(t.slice(8, 10), "02");
  assert.equal(t.slice(10, 12), "=?");
  assert.ok(t.endsWith("\r"));
  const body = t.slice(0, -1);
  assert.equal(Number(body.slice(-3)), asciiSum(body.slice(0, -3)));
});

test("boolean_old writes 111111 / 000000", () => {
  const data = (bytes) => {
    const t = text(bytes).replace(/\r$/, "");
    return t.slice(10, 10 + Number(t.slice(8, 10)));
  };
  assert.equal(data(proto().buildRequest("standby", true)), "111111");
  assert.equal(data(proto().buildRequest("standby", false)), "000000");
  // Web: numeric text is converted first, as CSC's turbo terminal does, so "0" is OFF.
  assert.equal(data(proto().buildRequest("standby", "0")), "000000");
  assert.equal(data(proto().buildRequest("standby", "1")), "111111");
});

test("unknown command and write to read-only raise", () => {
  assert.throws(() => proto().buildRequest("nonexistent"), /unknown command/);
  assert.throws(() => proto().buildRequest("pressure", 1e-6), /read-only/);
});

test("value encoders match CSC _encode_value", () => {
  assert.equal(encodePfeifferValue(1, "boolean_new"), "1");
  assert.equal(encodePfeifferValue(27000, "u_integer"), "027000");
  assert.equal(encodePfeifferValue(-12, "u_integer"), "-00012");
  assert.equal(encodePfeifferValue(7, "u_short_int"), "007");
  assert.equal(encodePfeifferValue(1234.56, "u_real"), "123456");
  assert.equal(encodePfeifferValue(0.125, "u_real"), "000012"); // Python round() is half-even
  assert.equal(encodePfeifferValue(1.2e-6, "u_expo"), "1.20E-06");
  assert.equal(encodePfeifferValue(1.2e-6, "u_expo_new"), "1.20E-06");
  assert.equal(encodePfeifferValue("ab", "string"), "ab    ");
  assert.equal(encodePfeifferValue("abcdefgh", "string"), "abcdef");
  assert.throws(() => encodePfeifferValue("12.5", "u_integer"));
});

// ── parse_response: success ──────────────────────────────────────────────

test("u_integer speed, u_real current, boolean_old and string decode", () => {
  let r = proto().parseResponse(makeResponse(1, 309, "027000"), "actual_speed_hz");
  assert.ok(r.success && r.value === 27000 && r.unit === "Hz" && r.formatted === "27000 Hz");
  r = proto().parseResponse(makeResponse(1, 310, "000123"), "motor_current_A");
  assert.ok(r.success && Math.abs(r.value - 1.23) < 1e-12 && r.unit === "A" && r.formatted === "1.23 A");
  assert.equal(proto().parseResponse(makeResponse(1, 23, "111111"), "motor_on").value, 1);
  r = proto().parseResponse(makeResponse(1, 23, "000000"), "motor_on");
  assert.ok(r.success && r.value === 0 && r.formatted === "False");
  r = proto().parseResponse(makeResponse(1, 312, "  1.07"), "firmware");
  assert.ok(r.success && r.formatted.includes("1.07"));
});

test("u_expo_new: 6-digit form and a float fallback", () => {
  let r = proto().parseResponse(makeResponse(1, 340, "456711"), "pressure");
  assert.ok(Math.abs(r.value - 4.567e-9) < 1e-20);
  assert.equal(r.formatted, "4.567E-09 mbar");
  r = proto().parseResponse(makeResponse(1, 340, "1.0E-3"), "pressure");
  assert.ok(Math.abs(r.value - 1e-3) < 1e-15);
  assert.equal(expoNew(4.567e-9), "456711");
  assert.equal(expoNew(1000), "100023");
});

// ── parse_response: errors ───────────────────────────────────────────────

test("empty, too short, bad checksum, device errors, non-ASCII all fail", () => {
  assert.ok(!proto().parseResponse(new Uint8Array(0), "pressure").success);
  assert.ok(!proto().parseResponse(ascii("001003400"), "pressure").success);
  const good = makeResponse(1, 309, "027000");
  const corrupted = concat(good.subarray(0, good.length - 4), ascii("999\r"));
  const r = proto().parseResponse(corrupted, "actual_speed_hz");
  assert.ok(!r.success && /checksum/i.test(r.error));
  const noDef = proto().parseResponse(makeResponse(1, 309, "NO_DEF"), "actual_speed_hz");
  assert.ok(!noDef.success && noDef.error.includes("NO_DEF"));
  assert.ok(!proto().parseResponse(makeResponse(1, 309, "_RANGE"), "actual_speed_hz").success);
  assert.ok(!proto().parseResponse(makeResponse(1, 309, "_LOGIC"), "actual_speed_hz").success);
  assert.ok(!proto().parseResponse(Uint8Array.of(0xff, 0xfe, 0x00), "pressure").success);
});

test("an echoed request (action 00) never validates, parses or matches", () => {
  const req = proto().buildRequest("actual_speed_hz");
  assert.ok(!isValidPfeifferResponse(req));
  const r = proto().parseResponse(req, "actual_speed_hz");
  assert.ok(!r.success && /request/.test(r.error));
  assert.ok(!proto().matchesResponse(req, "actual_speed_hz"));
  assert.ok(proto().validateFrame(req).ok, "the terminal still accepts it as a request to send");
});

test("scanner validation: action 10/11, exact length, checksum", () => {
  const r = makeResponse(1, 309, "BCG450");
  assert.ok(isValidPfeifferResponse(r));
  assert.equal(pfeifferData(r), "BCG450");
  assert.ok(isValidPfeifferResponse(pfeifferFrame(1, "11", 309, "x")));
  assert.ok(!isValidPfeifferResponse(pfeifferFrame(1, "20", 309, "x")));
  assert.ok(!isValidPfeifferResponse(concat(r.subarray(0, r.length - 1), ascii(" \r"))));
  const bad = Uint8Array.from(r);
  bad[12] ^= 1;
  assert.ok(!isValidPfeifferResponse(bad));
});

test("matchesResponse checks the parameter number", () => {
  const c = proto();
  assert.ok(c.matchesResponse(makeResponse(1, 309, "027000"), "actual_speed_hz"));
  assert.ok(!c.matchesResponse(makeResponse(1, 310, "000123"), "actual_speed_hz"));
});

test("framer: every split point of a response yields exactly one frame", () => {
  for (const reply of [makeResponse(1, 309, "027000"), makeResponse(1, 340, "456711"), makeResponse(1, 1, "NO_DEF")]) {
    for (let i = 0; i <= reply.length; i += 1) {
      const framer = proto().framer();
      const frames = [...framer.push(reply.subarray(0, i)), ...framer.push(reply.subarray(i))];
      assert.equal(frames.length, 1, `split at ${i}`);
      assert.equal(text(frames[0]), text(reply));
    }
  }
});

// ── emulator round trip ──────────────────────────────────────────────────

function fakeCtx(baudRate = 9600) {
  const sent = [];
  let t = 0;
  return { sent, settings: { baudRate }, send: (b) => sent.push(Uint8Array.from(b)), now: () => t, tick: (ms) => (t += ms), setTimer: () => 0, clearTimer: () => {} };
}

function transact(emulator, codec, command, value, ctx = fakeCtx()) {
  ctx.sent.length = 0;
  emulator.receive(codec.buildRequest(command, value), ctx);
  const frames = codec.framer().push(concat(...ctx.sent));
  return frames.length ? codec.parseResponse(frames[0], command) : null;
}

test("round trip: BCG450 spec (inficon_ascii) against the emulator", () => {
  const spec = loadSpec("bcg450");
  const codec = createPfeifferAsciiCodec(spec);
  assert.equal(codec.address, 1);
  const emu = createPfeifferAsciiEmulator({ model: "BCG450", pressure: () => 3.21e-6 });
  const r = transact(emu, codec, "pressure");
  assert.ok(r.success && Math.abs(r.value - 3.21e-6) / 3.21e-6 < 1e-9, JSON.stringify(r));
  assert.ok(transact(emu, codec, "pressure_units", 1).success);
  const unit = transact(emu, codec, "pressure_units");
  assert.equal(unit.value, 1);
  assert.equal(unit.formatted, "Torr (1)");
  assert.equal(emu.classify(codec.buildRequest("pressure")), "read");
  assert.equal(emu.classify(codec.buildRequest("pressure_units", 1)), "write");
});

test("emulator: 309 carries the model for the scanner hint; unknown parameters answer NO_DEF", () => {
  const emu = createPfeifferAsciiEmulator({ model: "BCG450" });
  const ctx = fakeCtx();
  emu.receive(pfeifferReadFrame(309), ctx);
  assert.ok(isValidPfeifferResponse(ctx.sent[0]));
  assert.equal(text(ctx.sent[0]).slice(3, 5), "10");
  assert.ok(pfeifferData(ctx.sent[0]).toUpperCase().includes("BCG450"));
  ctx.sent.length = 0;
  emu.receive(pfeifferReadFrame(999), ctx);
  assert.equal(pfeifferData(ctx.sent[0]), "NO_DEF");
  ctx.sent.length = 0;
  emu.receive(pfeifferReadFrame(309, 2), ctx);
  assert.equal(ctx.sent.length, 0, "another address is ignored");
  const bad = Uint8Array.from(pfeifferReadFrame(309));
  bad[bad.length - 2] = 0x30 + ((bad[bad.length - 2] - 0x30 + 1) % 10);
  emu.receive(bad, ctx);
  assert.equal(ctx.sent.length, 0, "a bad checksum is ignored");
});

test("emulator: write to a read-only parameter answers _LOGIC", () => {
  const emu = createPfeifferAsciiEmulator({ model: "BCG450" });
  const ctx = fakeCtx();
  emu.receive(pfeifferFrame(1, "10", 340, "100023"), ctx);
  assert.equal(pfeifferData(ctx.sent[0]), "_LOGIC");
});
