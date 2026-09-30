// TC600: the parameter table (CSC tc600_protocol.py against device_specs tc600.yaml), the
// danger flags, and the protocol parts of CSC tests/test_turbo_worker.py (status snapshot,
// recoverable and fatal transport errors), run against the Pfeiffer ASCII emulator.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { test, assert } from "../harness.mjs";
import {
  TC600_COMMANDS,
  TC600_DANGER_COMMANDS,
  TC600_DEFAULT_POLL_COMMANDS,
  TURBO_MAX_CONSECUTIVE_ERRORS,
  Tc600Poller,
  assertTc600WriteAllowed,
  createTc600Codec,
  describeTc600Error,
  summarizeTc600Status
} from "../../public/core/turbo/tc600.js";
import { pfeifferFrame } from "../../public/core/codecs/pfeiffer-ascii.js";
import { createPfeifferAsciiEmulator } from "../../public/core/sim/emulators/pfeiffer-ascii.js";
import { concat, text } from "../../public/core/bytes.js";

const yamlSpec = YAML.parse(readFileSync(new URL("../../specs-src/turbos/tc600.yaml", import.meta.url), "utf8"), { uniqueKeys: false });

test("every YAML command is in the table with the same pid, type, read, write and unit", () => {
  for (const [name, y] of Object.entries(yamlSpec.commands)) {
    const t = TC600_COMMANDS[name];
    assert.ok(t, `${name} missing from TC600_COMMANDS`);
    assert.equal(t.pid, y.pid, name);
    assert.equal(t.data_type, y.data_type, name);
    assert.equal(t.read, y.read, name);
    assert.equal(t.write, y.write, name);
    assert.equal(t.unit, y.unit ?? "", name);
  }
});

test("actuating commands are flagged danger; reads are safe", () => {
  for (const name of ["pump_on", "motor_on", "vent_enable", "standby", "error_ack", "op_mode", "vent_mode", "speed_setpoint_pct", "rs485_address"]) {
    assert.ok(TC600_COMMANDS[name].danger, name);
    assert.ok(TC600_DANGER_COMMANDS.includes(name), name);
  }
  for (const [name, c] of Object.entries(TC600_COMMANDS)) if (!c.write) assert.ok(!c.danger && c.risk === "safe", name);
  assert.throws(() => assertTc600WriteAllowed("motor_on", {}), /confirmation/);
  assert.doesNotThrow(() => assertTc600WriteAllowed("motor_on", { confirmed: true }));
  assert.doesNotThrow(() => assertTc600WriteAllowed("vent_time_s"));
  assert.throws(() => assertTc600WriteAllowed("actual_speed_hz", { confirmed: true }), /read-only/);
  const rows = Object.fromEntries(createTc600Codec().commands().map((r) => [r.name, r]));
  assert.equal(rows.pump_on.risk, "danger");
  assert.equal(rows.actual_speed_hz.risk, "safe");
});

test("codec: TC600 frames, command lists and error descriptions", () => {
  const codec = createTc600Codec({ address: 1 });
  assert.equal(text(codec.buildRequest("actual_speed_hz")), "0010030902=?107\r");
  assert.equal(text(codec.buildRequest("pump_on", true)).slice(0, 16), "0011001006111111");
  assert.throws(() => codec.buildWrite("pump_on", true), /confirmation/);
  assert.equal(text(codec.buildWrite("pump_on", true, { confirmed: true })), text(codec.buildRequest("pump_on", true)));
  assert.ok(codec.readableCommands.includes("actual_speed_hz") && !codec.readableCommands.includes("error_ack"));
  assert.ok(codec.writableCommands.includes("error_ack") && !codec.writableCommands.includes("firmware"));
  assert.equal(codec.allCommands.length, Object.keys(TC600_COMMANDS).length);
  assert.equal(describeTc600Error(" Err001 "), "TMP excess rotation speed");
  assert.equal(describeTc600Error("Err999"), "Unknown code: Err999");
});

test("CSC turbo worker vectors: speed 027000 = 27000 Hz, pump_on 000000 = off", () => {
  const codec = createTc600Codec();
  const speed = codec.parseResponse(pfeifferFrame(1, "10", 309, "027000"), "actual_speed_hz");
  assert.ok(speed.success && Math.abs(speed.value - 27000) < 1);
  const pump = codec.parseResponse(pfeifferFrame(1, "10", 23, "000000"), "pump_on");
  assert.ok(pump.success && pump.value === 0);
});

// ── poller against the emulator ──────────────────────────────────────────

function emulatorLink(emu) {
  let t = 0;
  const ctx = { sent: [], settings: { baudRate: 9600 }, send: (b) => ctx.sent.push(Uint8Array.from(b)), now: () => t, setTimer: () => 0, clearTimer: () => {} };
  emu.open(ctx);
  const framer = createTc600Codec().framer();
  const transact = async (req) => {
    ctx.sent.length = 0;
    emu.receive(req, ctx);
    const frames = framer.push(concat(...ctx.sent));
    if (!frames.length) throw new Error("timeout");
    return frames[0];
  };
  return { transact, advance: (ms) => (t += ms) };
}

test("poller: default poll list yields a status snapshot", async () => {
  const emu = createPfeifferAsciiEmulator({ model: "TC600" });
  const link = emulatorLink(emu);
  const poller = new Tc600Poller();
  assert.deepEqual(poller.pollCommands, [...TC600_DEFAULT_POLL_COMMANDS]);
  const cycle = await poller.runCycle(link.transact);
  assert.ok(cycle.hasStatus && !cycle.fatal && cycle.errors.length === 0);
  for (const cmd of TC600_DEFAULT_POLL_COMMANDS) assert.ok(cycle.readings[cmd].success, cmd);
  const s = summarizeTc600Status(cycle.readings);
  assert.equal(s.pumpOn, false);
  assert.equal(s.speedHz, 0);
  assert.equal(s.errorCode, "no Err");
  assert.equal(s.errorActive, false);
});

test("poller: confirmed start spins the emulated rotor up; latest write wins", async () => {
  const emu = createPfeifferAsciiEmulator({ model: "TC600", accelHzPerS: 50 });
  const link = emulatorLink(emu);
  const poller = new Tc600Poller({ pollCommands: ["actual_speed_hz", "pump_on"] });
  assert.throws(() => poller.sendCommand("motor_on", true), /confirmation/);
  poller.sendCommand("motor_on", true, { confirmed: true });
  await poller.runCycle(link.transact);
  poller.sendCommand("pump_on", false, { confirmed: true });
  poller.sendCommand("pump_on", true, { confirmed: true }); // rapid Stop -> Start: only Start is sent
  const started = await poller.runCycle(link.transact);
  assert.deepEqual(started.terminal, ["SET pump_on = true"]);
  assert.equal(started.readings.pump_on.value, 1);
  link.advance(10_000);
  let r = await poller.runCycle(link.transact);
  assert.ok(Math.abs(r.readings.actual_speed_hz.value - 500) <= 1, String(r.readings.actual_speed_hz.value));
  link.advance(60_000);
  r = await poller.runCycle(link.transact);
  assert.equal(r.readings.actual_speed_hz.value, 1500);
  poller.requestRead("firmware");
  r = await poller.runCycle(link.transact);
  assert.ok(r.readings.firmware.success && r.terminal.includes("READ firmware"));
});

test("poller: a transport error is recoverable, five in a row are fatal", async () => {
  const poller = new Tc600Poller({ pollCommands: ["pump_on"] });
  const failing = async () => {
    throw new Error("write fail");
  };
  const first = await poller.runCycle(failing);
  assert.ok(first.errors[0].recoverable && !first.fatal && first.retryDelayMs === 3000);
  let last = first;
  for (let i = 1; i < TURBO_MAX_CONSECUTIVE_ERRORS; i += 1) last = await poller.runCycle(failing);
  assert.ok(last.fatal && !last.errors[0].recoverable);
});

test("emulator: TC600 unknown parameter NO_DEF; read-only write _LOGIC; 309 is speed unless asked", async () => {
  const codec = createTc600Codec();
  const link = emulatorLink(createPfeifferAsciiEmulator({ model: "TC600" }));
  const r = codec.parseResponse(await link.transact(pfeifferFrame(1, "00", 999, "=?")), "firmware");
  assert.ok(!r.success && r.error.includes("NO_DEF"));
  const w = codec.parseResponse(await link.transact(pfeifferFrame(1, "10", 309, "001000")), "actual_speed_hz");
  assert.ok(!w.success && w.error.includes("_LOGIC"));
  const id = emulatorLink(createPfeifferAsciiEmulator({ model: "TC600", param309: "firmware" }));
  assert.ok(text(await id.transact(pfeifferFrame(1, "00", 309, "=?"))).includes("TC600"));
});
