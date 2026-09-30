// Scheduler against EmulatedPort (WEB_PORT_PLAN.md section 13): one outstanding transaction
// per port, terminal interleaving, streaming echo matching, and the error-policy constants.
import { test, assert, sleep } from "../harness.mjs";
import { EmulatedPort } from "../../public/core/transport/emulated-port.js";
import { PortScheduler } from "../../public/core/scheduler/port-scheduler.js";
import { createCdgCodec } from "../../public/core/codecs/cdg-serial.js";
import { createInficonBinaryCodec } from "../../public/core/codecs/inficon-binary.js";
import { createCdgEmulator } from "../../public/core/sim/emulators/cdg.js";
import { createPxgEmulator } from "../../public/core/sim/emulators/pxg.js";
import { Registry } from "../../public/core/registry/registry.js";
import { readFileSync } from "node:fs";

const registry = new Registry(JSON.parse(readFileSync("public/specs/all.json", "utf8")));
const pcgSpec = registry.get("PCG550");

const openPorts = [];
export async function closeAll() {
  for (const p of openPorts.splice(0)) await p.close();
}

async function setup({ emulators, faults, baudRate }) {
  await closeAll();
  const port = new EmulatedPort({ emulators, faults });
  openPorts.push(port);
  await port.open({ baudRate });
  const scheduler = new PortScheduler(port, { responseTimeoutMs: 120, errorRetryDelayMs: 20 });
  const events = { reading: [], error: [], status: [], terminal: [], info: [] };
  for (const type of Object.keys(events)) scheduler.on(type, (e) => events[type].push(e));
  return { port, scheduler, events };
}

test("CDG: one read request starts streaming; frames become readings at the recorded spacing", async () => {
  const emulator = createCdgEmulator({ fullScaleMbar: 13.332, pressure: () => 6.666, streamIntervalMs: 10 });
  const { port, scheduler, events } = await setup({ emulators: [emulator], baudRate: 9600 });
  scheduler.addDevice({ id: "cdg", label: "CDG", codec: createCdgCodec(null, { fullScaleMbar: 13.332 }), intervalMs: 50 });
  scheduler.start();
  await sleep(400);
  await scheduler.stop();
  assert.equal(port.hostWrites.length, 1, "only the start request was written");
  assert.ok(events.reading.length >= 4 && events.reading.length <= 10, `readings: ${events.reading.length}`);
  assert.ok(Math.abs(events.reading[0].value - 6.666) < 0.001);
  assert.ok(events.status.some((s) => s.state === "streaming"));
});

test("CDG streaming line: a type query takes the frame with read echo 0x3B, not a pressure frame", async () => {
  const emulator = createCdgEmulator({ fullScaleMbar: 13.332, streamIntervalMs: 5 });
  const { scheduler } = await setup({ emulators: [emulator], baudRate: 9600 });
  const codec = createCdgCodec(null, { fullScaleMbar: 13.332 });
  scheduler.addDevice({ id: "cdg", label: "CDG", codec });
  scheduler.start();
  await sleep(60);
  const entry = await scheduler.terminal("cdg", codec.buildRequest("cdg_type"), { command: "cdg_type" });
  await scheduler.stop();
  assert.equal(entry.response[6], 0x3b);
  assert.match(entry.formatted, /FS≈13.332/);
});

test("CDG silence: 5 empty reads give 'No data from CDG' and stop the device", async () => {
  const emulator = createCdgEmulator({ streamIntervalMs: 10 });
  const { port, scheduler, events } = await setup({ emulators: [emulator], baudRate: 9600, faults: { silent: true } });
  scheduler.addDevice({ id: "cdg", label: "CDG", codec: createCdgCodec() });
  scheduler.start();
  await sleep(900);
  await scheduler.stop();
  const fatal = events.error.find((e) => !e.recoverable);
  assert.ok(fatal, "a non-recoverable error was emitted");
  assert.match(fatal.message, /No data from CDG/);
  assert.equal(port.hostWrites.length, 2, "start request plus one restart attempt");
});

test("PxG: polled reads decode, and only read requests are ever written by polling", async () => {
  const emulator = createPxgEmulator({ model: "PCG550", pressure: () => 2.5e-3 });
  const { port, scheduler, events } = await setup({ emulators: [emulator], baudRate: 57600 });
  const codec = await registry.makeCodec(pcgSpec);
  scheduler.addDevice({ id: "pcg", label: "PCG", codec, commands: ["pressure", "atm_pressure"], intervalMs: 30 });
  scheduler.start();
  await sleep(250);
  await scheduler.stop();
  const pressures = events.reading.filter((r) => r.command === "pressure");
  assert.ok(pressures.length >= 3, `pressure readings: ${pressures.length}`);
  // Fixs32en20 resolves 2^-20 ≈ 9.5e-7 mbar, so compare to half a count.
  assert.ok(Math.abs(pressures[0].value - 2.5e-3) <= 2 ** -21);
  assert.ok(events.reading.some((r) => r.command === "atm_pressure" && Math.abs(r.value - 1013.25) < 1e-3));
  assert.ok(port.hostWrites.every((w) => emulator.classify(w) === "read"));
});

test("setCommands never lets a write command into the poll list", async () => {
  const { scheduler } = await setup({ emulators: [], baudRate: 57600 });
  const codec = await registry.makeCodec(pcgSpec);
  scheduler.addDevice({ id: "pcg", label: "PCG", codec, polling: false });
  scheduler.setCommands("pcg", ["pressure", "cdg_zero_adjust", "reset", "data_unit"]);
  assert.deepEqual(scheduler.devices.get("pcg").commands, ["pressure", "data_unit"]);
});

test("RS485: two gauges on one bus share the port with one transaction at a time", async () => {
  const a = createPxgEmulator({ model: "PCG550", address: 1, rs485: true, pressure: () => 1e-2 });
  const b = createPxgEmulator({ model: "PSG550", address: 2, rs485: true, pressure: () => 5e-1 });
  const { port, scheduler, events } = await setup({ emulators: [a, b], baudRate: 57600, faults: { echo: true } });
  let outstanding = 0;
  let maxOutstanding = 0;
  const write = port.write.bind(port);
  port.write = async (bytes) => {
    outstanding += 1;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    await write(bytes);
  };
  scheduler.on("reading", () => (outstanding = Math.max(0, outstanding - 1)));
  scheduler.on("error", () => (outstanding = Math.max(0, outstanding - 1)));
  scheduler.addDevice({ id: "a", label: "A", codec: await registry.makeCodec(pcgSpec, { address: 1, rsMode: "RS485" }), intervalMs: 20 });
  scheduler.addDevice({ id: "b", label: "B", codec: await registry.makeCodec(registry.get("PSG550"), { address: 2, rsMode: "RS485" }), intervalMs: 20 });
  scheduler.start();
  await sleep(300);
  await scheduler.stop();
  const fromA = events.reading.filter((r) => r.deviceId === "a");
  const fromB = events.reading.filter((r) => r.deviceId === "b");
  assert.ok(fromA.length >= 3 && fromB.length >= 3, `A ${fromA.length}, B ${fromB.length}`);
  assert.ok(fromA.every((r) => Math.abs(r.value - 1e-2) <= 2 ** -21));
  assert.ok(fromB.every((r) => Math.abs(r.value - 5e-1) < 1e-6));
  assert.equal(maxOutstanding, 1, "never more than one transaction outstanding");
  assert.equal(events.error.length, 0, events.error.map((e) => e.message).join("; "));
});

test("loopback plug: 5 silent cycles give the CSC loopback message and stop polling", async () => {
  const emulator = createPxgEmulator({ model: "PCG550" });
  const { scheduler, events } = await setup({ emulators: [emulator], baudRate: 57600, faults: { loopback: true } });
  scheduler.addDevice({ id: "pcg", label: "PCG", codec: await registry.makeCodec(pcgSpec), intervalMs: 10 });
  scheduler.start();
  await sleep(1200);
  await scheduler.stop();
  const fatal = events.error.find((e) => !e.recoverable);
  assert.ok(fatal);
  assert.match(fatal.message, /TX is echoing without response/);
  assert.equal(events.status.at(-1).state, "dead");
});

test("terminal jobs interleave with polling and error frames come back readable", async () => {
  const emulator = createPxgEmulator({ model: "PCG550" });
  const { scheduler, events } = await setup({ emulators: [emulator], baudRate: 57600 });
  const codec = await registry.makeCodec(pcgSpec);
  scheduler.addDevice({ id: "pcg", label: "PCG", codec, intervalMs: 15 });
  scheduler.start();
  await sleep(40);
  const name = await scheduler.terminal("pcg", codec.buildRequest("product_name"), { command: "product_name" });
  const unit = await scheduler.terminal("pcg", codec.buildRequest("data_unit", 1), { command: "data_unit", isWrite: true });
  const readBack = await scheduler.terminal("pcg", codec.buildRequest("data_unit"), { command: "data_unit" });
  const bad = await scheduler.terminal("pcg", codec.buildRequest("data_unit", 7), { command: "data_unit", isWrite: true });
  await sleep(40);
  await scheduler.stop();
  assert.equal(name.formatted, "PCG550");
  assert.equal(unit.formatted, "Write acknowledged");
  assert.equal(readBack.formatted, "Torr (1)");
  assert.equal(codec.dataUnit, "Torr", "a unit read labels Real32 pressures");
  assert.match(bad.error, /above maximum/);
  assert.ok(events.reading.length >= 2, "polling continued around the terminal jobs");
});

test("responses split into 1-byte chunks and a corrupted chunk: polling recovers", async () => {
  const emulator = createPxgEmulator({ model: "PCG550", pressure: () => 3.3 });
  const { scheduler, events } = await setup({ emulators: [emulator], baudRate: 57600, faults: { splitEvery: 1, corruptEvery: 37 } });
  scheduler.addDevice({ id: "pcg", label: "PCG", codec: await registry.makeCodec(pcgSpec), intervalMs: 10 });
  scheduler.start();
  await sleep(700);
  await scheduler.stop();
  assert.ok(events.reading.length >= 5, `readings: ${events.reading.length}`);
  assert.ok(events.reading.every((r) => Math.abs(r.value - 3.3) < 1e-6), "no corrupted value got through");
  assert.ok(events.error.every((e) => e.recoverable));
});

test("wrong baud: the gauge stays silent and errors are recoverable until the loopback verdict", async () => {
  const emulator = createPxgEmulator({ model: "PCG550", baudRate: 57600 });
  const { scheduler, events } = await setup({ emulators: [emulator], baudRate: 9600 });
  scheduler.addDevice({ id: "pcg", label: "PCG", codec: await registry.makeCodec(pcgSpec), intervalMs: 10 });
  scheduler.start();
  await sleep(1000);
  await scheduler.stop();
  assert.ok(events.error.filter((e) => e.recoverable).every((e) => /No response/.test(e.message)));
  assert.ok(events.error.some((e) => !e.recoverable));
});

test("a port that closes marks devices offline", async () => {
  const emulator = createPxgEmulator({ model: "PCG550" });
  const { port, scheduler, events } = await setup({ emulators: [emulator], baudRate: 57600 });
  scheduler.addDevice({ id: "pcg", label: "PCG", codec: await registry.makeCodec(pcgSpec), intervalMs: 10 });
  scheduler.start();
  await sleep(50);
  await port.close();
  await sleep(30);
  await scheduler.stop();
  assert.equal(events.status.at(-1).state, "offline");
});

test("mixing protocols on one port is refused", async () => {
  const { scheduler } = await setup({ emulators: [], baudRate: 9600 });
  scheduler.addDevice({ id: "cdg", label: "CDG", codec: createCdgCodec() });
  assert.throws(() => scheduler.addDevice({ id: "pcg", label: "PCG", codec: createInficonBinaryCodec(pcgSpec) }), /share a protocol/);
});

test("cleanup: close emulated ports", closeAll);
