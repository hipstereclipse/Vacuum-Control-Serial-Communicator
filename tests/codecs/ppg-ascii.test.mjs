// PPG ASCII codec: ported from CSC tests/test_ppg_ascii.py, plus framer fragmentation,
// scanner helpers and a round trip against the PPG550/PPG570 emulator.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { test, assert } from "../harness.mjs";
import { createPpgCodec, isPpgAck, ppgData, ppgRequest, PPG_PRESSURE_STATUS } from "../../public/core/codecs/ppg-ascii.js";
import { createPpgEmulator } from "../../public/core/sim/emulators/ppg.js";
import { ascii, text, concat } from "../../public/core/bytes.js";

const spec = (name) => YAML.parse(readFileSync(new URL(`../../specs-src/gauges/${name}.yaml`, import.meta.url), "utf8"), { uniqueKeys: false });
const s = (bytes) => text(bytes);

const ppg570Table = {
  model: "PPG570",
  commands: {
    pressure: { mnemonic: "P", read: true, write: false, unit: "mbar" },
    pressure_combined: { mnemonic: "P", query_param: "CMB", read: true, write: false, unit: "mbar" },
    setpoint_1: { mnemonic: "SPV", query_param: "1", write_prefix: "1,", read: true, write: true, unit: "mbar" }
  }
};

// ── build_request ─────────────────────────────────────────────────────────

test("fallback table builds the CSC frames (address 254)", () => {
  const c = createPpgCodec(null, { address: 254 });
  assert.equal(s(c.buildRequest("pressure")), "@254PR3?\\");
  assert.equal(s(c.buildRequest("temperature")), "@254T?\\");
  assert.equal(s(c.buildRequest("software_version")), "@254FV?\\");
  assert.equal(s(c.buildRequest("zero_adjust", "")), "@254VAC!\\");
  assert.equal(s(c.buildRequest("unit", "Torr")), "@254U!Torr\\");
});

test("default address is 254; RS485 address is zero-padded", () => {
  assert.equal(createPpgCodec(null).address, 254);
  assert.equal(createPpgCodec(spec("ppg550")).address, 254);
  assert.equal(s(createPpgCodec(null, { address: 12 }).buildRequest("pressure")), "@012PR3?\\");
});

test("unknown command and write to read-only raise", () => {
  const c = createPpgCodec(null);
  assert.throws(() => c.buildRequest("nonexistent"), /unknown command/);
  assert.throws(() => c.buildRequest("pressure", "1E-3"), /read-only/);
});

test("query_param and write_prefix are encoded (PPG570)", () => {
  const c = createPpgCodec(ppg570Table);
  assert.equal(s(c.buildRequest("pressure_combined")), "@254P?CMB\\");
  assert.equal(s(c.buildRequest("setpoint_1", "2.00E-2")), "@254SPV!1,2.00E-2\\");
});

test("YAML spec: numeric query_param becomes text; scanner probes match ppgRequest", () => {
  const c = createPpgCodec(spec("ppg570"));
  assert.equal(s(c.buildRequest("setpoint_2")), "@254SPV?2\\");
  assert.equal(s(c.buildRequest("setpoint_2", "5.0E-1")), "@254SPV!2,5.0E-1\\");
  assert.equal(s(c.buildRequest("pressure")), "@254P?\\");
  for (const m of ["FV", "SN", "PR3", "PR1"]) assert.equal(s(ppgRequest(m)), `@254${m}?\\`);
});

// ── parse_response: success ──────────────────────────────────────────────

test("pressure, temperature, firmware and serial replies decode", () => {
  const c = createPpgCodec(null);
  let r = c.parseResponse(ascii("@ACK1.23E-3\\"), "pressure");
  assert.ok(r.success);
  assert.ok(Math.abs(r.value - 1.23e-3) < 1e-10);
  assert.equal(r.unit, "mbar");
  assert.equal(r.formatted, "1.230E-03 mbar");
  r = c.parseResponse(ascii("@ACK9.99E+2\\"), "pressure");
  assert.ok(Math.abs(r.value - 999) < 0.5);
  r = c.parseResponse(ascii("@ACK25.3\\"), "temperature");
  assert.ok(r.success && Math.abs(r.value - 25.3) < 1e-6 && r.unit === "°C" && r.formatted === "25.3 °C");
  r = c.parseResponse(ascii("@ACK1.07\\"), "software_version");
  assert.equal(r.extra.text, "1.07");
  r = c.parseResponse(ascii("@ACK12345678\\"), "serial_number");
  assert.ok(r.extra.text.includes("12345678"));
});

test("address-prefixed ACK is normalised", () => {
  const r = createPpgCodec(null).parseResponse(ascii("@253ACK1.00E-3\\"), "pressure");
  assert.ok(r.success);
  assert.ok(Math.abs(r.value - 1e-3) < 1e-12);
  assert.equal(r.extra.responseAddress, 253);
});

test("trailing CR/LF after the terminator is tolerated", () => {
  assert.ok(createPpgCodec(null).parseResponse(ascii("@ACK1.0E-2\\\r\n"), "pressure").success);
});

// ── parse_response: errors ───────────────────────────────────────────────

test("NAK, empty, missing terminator, garbage and non-numeric replies fail", () => {
  const c = createPpgCodec(null);
  let r = c.parseResponse(ascii("@NAK\\"), "pressure");
  assert.ok(!r.success && r.error.includes("NAK"));
  assert.ok(!c.parseResponse(new Uint8Array(0), "pressure").success);
  r = c.parseResponse(ascii("@ACK1.23E-3"), "pressure");
  assert.ok(!r.success && /terminator/i.test(r.error));
  assert.ok(!c.parseResponse(ascii("GARBAGE1.23E-3\\"), "pressure").success);
  r = c.parseResponse(ascii("@ACKnotanumber\\"), "pressure");
  assert.ok(!r.success && r.extra.status === undefined);
});

test("every pressure status word becomes an error with extra.status for the chip", () => {
  const c = createPpgCodec(null);
  for (const word of PPG_PRESSURE_STATUS) {
    const r = c.parseResponse(ascii(`@ACK${word}\\`), "pressure");
    assert.ok(!r.success, word);
    assert.equal(r.extra.status, word);
    assert.ok(r.error.includes(word));
  }
  assert.equal(c.parseResponse(ascii("@ACK hv off \\"), "pressure").extra.status, "HV OFF");
});

test("UNKNOWN COMMAND swaps PR3 -> P, then back once; other NAKs do not", () => {
  const c = createPpgCodec(null);
  assert.equal(s(c.buildRequest("pressure")), "@254PR3?\\");
  c.parseResponse(ascii("@NAKWAIT\\"), "pressure");
  assert.equal(s(c.buildRequest("pressure")), "@254PR3?\\");
  assert.ok(!c.parseResponse(ascii("@NAKUNKNOWNCOMMAND\\"), "pressure").success);
  assert.equal(s(c.buildRequest("pressure")), "@254P?\\");
  c.parseResponse(ascii("@NAKUNKNOWN COMMAND\\"), "pressure");
  assert.equal(s(c.buildRequest("pressure")), "@254PR3?\\");
  // Both directions tried: no further flapping.
  c.parseResponse(ascii("@NAKUNKNOWN COMMAND\\"), "pressure");
  assert.equal(s(c.buildRequest("pressure")), "@254PR3?\\");
});

test("pressure_combined downgrades P?CMB to P? on UNKNOWN COMMAND", () => {
  const c = createPpgCodec(ppg570Table);
  assert.equal(s(c.buildRequest("pressure_combined")), "@254P?CMB\\");
  assert.ok(!c.parseResponse(ascii("@NAKUNKNOWNCOMMAND\\"), "pressure_combined").success);
  assert.equal(s(c.buildRequest("pressure_combined")), "@254P?\\");
});

// ── scanner helpers, validation, framing ─────────────────────────────────

test("isPpgAck / ppgData match port_scanner.py", () => {
  assert.ok(isPpgAck(ascii("@ACK1.07\\")));
  assert.ok(isPpgAck(ascii("@253ACK1.07\\")));
  assert.ok(!isPpgAck(ascii("@NAKUNKNOWN COMMAND\\")));
  assert.ok(!isPpgAck(ascii("@254FV?\\")));
  assert.equal(ppgData(ascii("@ACK 1.07 \\")), "1.07");
  assert.equal(ppgData(ascii("@253ACK12345\\")), "12345");
  assert.equal(ppgData(ascii("@NAKX\\")), "");
});

test("an echoed request never parses or matches as a response", () => {
  const c = createPpgCodec(null);
  const req = c.buildRequest("pressure");
  assert.ok(!c.parseResponse(req, "pressure").success);
  assert.ok(!c.matchesResponse(req, "pressure"));
  assert.ok(c.matchesResponse(ascii("@ACK1E-3\\"), "pressure"));
  assert.ok(c.validateFrame(req).ok);
  assert.ok(!c.validateFrame(ascii("254PR3?")).ok);
});

test("RS485: an address-prefixed reply from another gauge does not match", () => {
  const c = createPpgCodec(null, { address: 12 });
  assert.ok(c.matchesResponse(ascii("@012ACK1E-3\\"), "pressure"));
  assert.ok(!c.matchesResponse(ascii("@013ACK1E-3\\"), "pressure"));
});

test("framer: every split point of a response yields exactly one frame", () => {
  for (const reply of ["@ACK1.23E-03\\", "@253ACK1.00E-3\\", "@NAKUNKNOWN COMMAND\\", "@ACKNO SENSOR\\"]) {
    const bytes = ascii(reply);
    for (let i = 0; i <= bytes.length; i += 1) {
      const framer = createPpgCodec(null).framer();
      const frames = [...framer.push(bytes.subarray(0, i)), ...framer.push(bytes.subarray(i))];
      assert.equal(frames.length, 1, `${reply} split at ${i}`);
      assert.equal(s(frames[0]), reply);
    }
    const framer = createPpgCodec(null).framer();
    const frames = [];
    for (const b of bytes) frames.push(...framer.push(Uint8Array.of(b)));
    assert.equal(frames.length, 1);
  }
});

// ── round trip against the emulator ──────────────────────────────────────

function fakeCtx(baudRate = 9600) {
  const sent = [];
  let t = 0;
  return { sent, settings: { baudRate }, send: (b) => sent.push(Uint8Array.from(b)), now: () => t, tick: (ms) => (t += ms), setTimer: () => 0, clearTimer: () => {} };
}

function transact(emulator, codec, command, value) {
  const ctx = fakeCtx(emulator.baudRate);
  emulator.receive(codec.buildRequest(command, value), ctx);
  const frames = codec.framer().push(concat(...ctx.sent));
  return frames.length ? codec.parseResponse(frames[0], command) : null;
}

test("round trip: PPG550 emulator with the PPG550 spec", () => {
  const emu = createPpgEmulator({ model: "PPG550", pressure: () => 4.56e-2, serial: "44001122", firmware: "1.07" });
  const codec = createPpgCodec(spec("ppg550"));
  const r = transact(emu, codec, "pressure");
  assert.ok(r.success);
  assert.ok(Math.abs(r.value - 4.56e-2) < 1e-12);
  assert.equal(transact(emu, codec, "serial_number").formatted, "44001122");
  assert.equal(transact(emu, codec, "software_version").formatted, "1.07");
  assert.ok(Math.abs(transact(emu, codec, "temperature").value - 25.3) < 1e-9);
  assert.equal(emu.classify(codec.buildRequest("pressure")), "read");
  assert.equal(emu.classify(codec.buildRequest("unit", "TORR")), "write");
});

test("round trip: unit write changes the reported pressure unit", () => {
  const emu = createPpgEmulator({ pressure: () => 1.33322387415 });
  const codec = createPpgCodec(spec("ppg550"));
  assert.ok(transact(emu, codec, "unit", "TORR").success);
  assert.equal(transact(emu, codec, "unit").formatted, "TORR");
  assert.ok(Math.abs(transact(emu, codec, "pressure").value - 1.0) < 1e-9);
});

test("round trip: status words from the emulator surface as status chips", () => {
  let status = "UR";
  const emu = createPpgEmulator({ status: () => status });
  const codec = createPpgCodec(null);
  assert.equal(transact(emu, codec, "pressure").extra.status, "UR");
  status = "NO SENSOR";
  assert.equal(transact(emu, codec, "pressure").extra.status, "NO SENSOR");
});

test("PR1 is the PPG570 signature: PPG550 NAKs it, PPG570 ACKs it", () => {
  const codec = createPpgCodec(null);
  const r550 = transact(createPpgEmulator({ model: "PPG550" }), codec, "combined_pressure");
  assert.ok(!r550.success && /UNKNOWN COMMAND/.test(r550.error));
  assert.ok(transact(createPpgEmulator({ model: "PPG570" }), codec, "combined_pressure").success);
});

test("runtime fallback end to end: PPG570 spec on a PPG550 recovers to PR3", () => {
  const emu = createPpgEmulator({ model: "PPG550", pressure: () => 7e-3 });
  const codec = createPpgCodec(spec("ppg570"));
  assert.ok(!transact(emu, codec, "pressure").success);
  const r = transact(emu, codec, "pressure");
  assert.ok(r.success && Math.abs(r.value - 7e-3) < 1e-12);
});

test("PPG570 emulator answers P?CMB and indexed setpoint writes", () => {
  const emu = createPpgEmulator({ model: "PPG570", pressure: () => 3e-1 });
  const codec = createPpgCodec(spec("ppg570"));
  assert.ok(Math.abs(transact(emu, codec, "pressure_combined").value - 0.3) < 1e-12);
  assert.ok(transact(emu, codec, "setpoint_1", "2.00E-2").success);
  assert.ok(Math.abs(transact(emu, codec, "setpoint_1").value - 0.02) < 1e-12);
});

test("emulator addressing: RS232 answers 254; RS485 only its own address; prefixed ACK option", () => {
  const codec254 = createPpgCodec(null);
  assert.ok(transact(createPpgEmulator({ address: 5 }), codec254, "pressure").success);
  assert.equal(transact(createPpgEmulator({ address: 5, rs485: true }), codec254, "pressure"), null);
  const codec5 = createPpgCodec(null, { address: 5 });
  const emu = createPpgEmulator({ address: 5, rs485: true, addressPrefixedAck: true });
  const ctx = fakeCtx();
  emu.receive(codec5.buildRequest("pressure"), ctx);
  assert.ok(s(ctx.sent[0]).startsWith("@005ACK"));
  assert.ok(codec5.parseResponse(ctx.sent[0], "pressure").success);
});

test("commands(): spec rows carry risk classes (U caution, VAC danger, reads safe)", () => {
  const rows = Object.fromEntries(createPpgCodec(spec("ppg550")).commands().map((r) => [r.name, r]));
  assert.equal(rows.pressure.risk, "safe");
  assert.equal(rows.unit.risk, "caution");
  assert.equal(rows.zero_adjust.risk, "danger");
  assert.equal(rows.setpoint_1.risk, "danger");
  assert.equal(createPpgCodec(null).commands().find((r) => r.name === "atm_zero").risk, "danger");
});
