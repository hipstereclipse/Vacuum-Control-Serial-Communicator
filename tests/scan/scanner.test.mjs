// Scan against emulators (WEB_PORT_PLAN.md section 13): every probe plan, silent ports,
// loopback, wrong-protocol cross-talk, and the assertion that no write request is ever
// emitted during a scan.
import { test, assert } from "../harness.mjs";
import { readFileSync } from "node:fs";
import { EmulatedPort } from "../../public/core/transport/emulated-port.js";
import { scanPort, sweepAddresses } from "../../public/core/scan/scanner.js";
import { probePlan } from "../../public/core/scan/probe-plans.js";
import { Registry } from "../../public/core/registry/registry.js";
import { createCdgEmulator } from "../../public/core/sim/emulators/cdg.js";
import { createPxgEmulator } from "../../public/core/sim/emulators/pxg.js";
import { createPpgEmulator } from "../../public/core/sim/emulators/ppg.js";
import { createPfeifferAsciiEmulator } from "../../public/core/sim/emulators/pfeiffer-ascii.js";
import { createP3V02Emulator } from "../../public/core/sim/emulators/p3v02.js";

const registry = new Registry(JSON.parse(readFileSync("public/specs/all.json", "utf8")));

/** Scan and assert that every byte the scan wrote was a read request. */
async function scan(emulators, options = {}) {
  const port = new EmulatedPort({ emulators, faults: options.faults });
  const outcome = await scanPort(port, { registry, mode: options.mode ?? "quick", rsMode: options.rsMode });
  for (const write of port.hostWrites) {
    for (const emulator of emulators) {
      const kind = emulator.classify?.(write);
      assert.notEqual(kind, "write", `${emulator.model} saw a write during the scan: ${Array.from(write)}`);
    }
  }
  assert.equal(port.isOpen, false, "the scan closes the port");
  return { ...outcome, port };
}

test("probe plans: quick uses factory rates only, thorough adds every PxG rate", () => {
  const quick = probePlan("quick").map((p) => `${p.step}@${p.baudRate}`);
  assert.deepEqual(quick, ["listen@9600", "ppg@9600", "pfeiffer@9600", "cdg@9600", "pxg@57600", "p3v02@115200"]);
  const thorough = probePlan("thorough").map((p) => `${p.step}@${p.baudRate}`);
  assert.deepEqual(thorough.filter((s) => s.startsWith("pxg")), ["pxg@9600", "pxg@57600", "pxg@38400", "pxg@19200"]);
});

test("CDG045D with a 10 Torr head: model and full-scale hint from the type query", async () => {
  const { results } = await scan([createCdgEmulator({ model: "CDG045D", fullScaleMbar: 13.332, pressure: () => 3 })]);
  assert.equal(results.length, 1);
  const [r] = results;
  assert.equal(r.family, "cdg_serial");
  assert.equal(r.model, "CDG045D");
  assert.equal(r.fullScaleMbar, 13.332);
  assert.equal(r.fullScaleConfident, true);
  assert.equal(r.streaming, false);
});

test("a CDG left streaming is found by listening, before anything is sent", async () => {
  const { results, writes } = await scan([createCdgEmulator({ model: "CDG100D", fullScaleMbar: 133.32, streaming: true, streamIntervalMs: 20 })]);
  assert.equal(results[0].model, "CDG100D");
  assert.equal(results[0].streaming, true);
  assert.equal(writes.length, 1, "only the type query was sent");
});

test("a CDG whose type word gives no confident full scale still identifies, without a hint", async () => {
  const { results } = await scan([createCdgEmulator({ model: "CDG025D", fullScaleMbar: 1, typeWord: 7 })]);
  assert.equal(results[0].model, "CDG025D");
  assert.equal(results[0].fullScaleMbar, null);
  assert.equal(results[0].fullScaleConfident, false);
});

test("PCG550 at its factory 57600 baud: identified by product name and a PID 221 read", async () => {
  const { results } = await scan([createPxgEmulator({ model: "PCG550", pressure: () => 4.2e-2, serial: "44009876" })]);
  assert.equal(results[0].family, "inficon_binary");
  assert.equal(results[0].model, "PCG550");
  assert.equal(results[0].baudRate, 57600);
  assert.equal(results[0].serial, "44009876");
  assert.match(results[0].pressure, /4\.20.e-2 mbar/);
});

test("PSG550 reset to 19200 is only found by a thorough scan", async () => {
  const quick = await scan([createPxgEmulator({ model: "PSG550", baudRate: 19200 })], { mode: "quick" });
  assert.equal(quick.results.length, 0);
  const thorough = await scan([createPxgEmulator({ model: "PSG550", baudRate: 19200 })], { mode: "thorough" });
  assert.equal(thorough.results[0].model, "PSG550");
  assert.equal(thorough.results[0].baudRate, 19200);
});

test("PPG570 answers at the broadcast address and is offered as the combined PPG550/570", async () => {
  const { results } = await scan([createPpgEmulator({ model: "PPG570", serial: "S123", firmware: "1.2" })]);
  assert.equal(results[0].family, "ppg_ascii");
  assert.equal(results[0].modelHint, "INFICON PPG550/570");
  assert.equal(results[0].serial, "S123");
  assert.equal(results[0].meta.pr1Acked, true);
});

test("PPG with address-prefixed ACKs (@253ACK) is still identified", async () => {
  const { results } = await scan([createPpgEmulator({ model: "PPG550", addressPrefixedAck: true })]);
  assert.equal(results[0].family, "ppg_ascii");
});

test("BCG450 over Pfeiffer ASCII: model hint from the firmware string", async () => {
  const { results } = await scan([createPfeifferAsciiEmulator({ model: "BCG450" })]);
  assert.equal(results[0].family, "pfeiffer_ascii");
  assert.equal(results[0].model, "BCG450");
});

test("TC600: parameter 309 is a speed, so the scan falls back to the electronics name", async () => {
  const { results } = await scan([createPfeifferAsciiEmulator({ model: "TC600", params: { 349: "TC 600" } })]);
  assert.equal(results[0].model, "TC600");
  assert.equal(results[0].meta.turbo, true);
});

test("OPG550 over P3 V02 at 115200", async () => {
  const { results } = await scan([createP3V02Emulator({ product: "OPG550", serial: "OPG-1", firmware: "2.0" })]);
  assert.equal(results[0].family, "inficon_p3_v02");
  assert.equal(results[0].model, "OPG550");
  assert.equal(results[0].serial, "OPG-1");
});

test("a silent port: no result, every probe tried, only reads sent", async () => {
  const { results, port, verdict } = await scan([]);
  assert.equal(results.length, 0);
  assert.equal(verdict, "no gauge answered");
  assert.ok(port.hostWrites.length >= 5);
});

test("loopback plug: the echo stops the scan with CSC's message", async () => {
  const { results, verdict, port } = await scan([], { faults: { loopback: true } });
  assert.equal(results.length, 0);
  assert.match(verdict, /echo but no response/);
  assert.equal(port.hostWrites.length, 1, "no further probes after the loopback verdict");
});

test("an echoing RS485 adapter does not hide the gauge behind it", async () => {
  const { results } = await scan([createPpgEmulator({ model: "PPG550" })], { faults: { echo: true } });
  assert.equal(results[0].family, "ppg_ascii");
});

test("cross-talk: a CDG does not answer PPG or Pfeiffer probes, and is found by its own", async () => {
  const cdg = createCdgEmulator({ model: "CDG200D", fullScaleMbar: 1333.22 });
  const { results } = await scan([cdg]);
  assert.equal(results[0].model, "CDG200D");
  assert.equal(results[0].fullScaleMbar, 1333.22);
});

test("RS485 PxG address sweep finds each gauge on the bus, never the broadcast address", async () => {
  const port = new EmulatedPort({
    emulators: [
      createPxgEmulator({ model: "PCG550", address: 3, rs485: true }),
      createPxgEmulator({ model: "PSG550", address: 6, rs485: true })
    ]
  });
  const { results, writes } = await sweepAddresses(port, { family: "inficon_binary", baudRate: 57600, from: 1, to: 8, registry });
  assert.deepEqual(results.map((r) => `${r.model}@${r.address}`), ["PCG550@3", "PSG550@6"]);
  assert.ok(writes.every((w) => w[4] === 1), "only read requests");
});

test("RS485 PPG sweep skips the broadcast address", async () => {
  const port = new EmulatedPort({ emulators: [createPpgEmulator({ model: "PPG550", address: 12, rs485: true })] });
  const { results, writes } = await sweepAddresses(port, { family: "ppg_ascii", baudRate: 9600, from: 10, to: 14, registry });
  assert.deepEqual(results.map((r) => r.address), [12]);
  assert.ok(!writes.some((w) => new TextDecoder().decode(w).startsWith("@254")));
});
