// OPG550 emulator: plasma ignition, the SPEC / RoR / RGD algorithms and their records, read
// back through the real P3 V02 codec and fed into the studio model.
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { test, assert } from "../harness.mjs";
import { createP3V02Codec } from "../../public/core/codecs/inficon-p3v02.js";
import { createP3V02Emulator } from "../../public/core/sim/emulators/p3v02.js";
import { OpgStudioState } from "../../public/core/opg/spectrum-studio.js";
import { concat } from "../../public/core/bytes.js";

const opgSpec = () => YAML.parse(readFileSync(new URL("../../specs-src/gauges/opg550.yaml", import.meta.url), "utf8"), { uniqueKeys: false });

function rig(options = {}) {
  let now = 0;
  let pressure = options.pressure ?? 1e-4;
  const emu = createP3V02Emulator({ ...options, pressure: () => pressure });
  const codec = createP3V02Codec(opgSpec());
  const run = (command, value) => {
    const sent = [];
    emu.receive(codec.buildRequest(command, value), { settings: { baudRate: 115200 }, send: (b) => sent.push(Uint8Array.from(b)), now: () => now, setTimer: () => 0, clearTimer: () => {} });
    const frames = codec.framer().push(concat(...sent));
    assert.equal(frames.length, 1, `${command}: one frame`);
    return codec.parseResponse(frames[0], command);
  };
  return { emu, codec, run, advance: (ms) => (now += ms), setPressure: (p) => (pressure = p) };
}

test("plasma ignites after the delay below the ignition limit, and goes out above it", () => {
  const r = rig();
  assert.equal(r.run("plasma_state").value, 0);
  assert.ok(r.run("plasma_enable", 1).success);
  assert.equal(r.run("plasma_state").formatted, "Plasma ON, not ignited");
  r.advance(1500);
  assert.equal(r.run("plasma_state").formatted, "Plasma ON and ignited");
  r.setPressure(5e-2);
  assert.equal(r.run("plasma_state").value, 1);
  assert.ok(r.run("plasma_enable", 0).success);
  assert.equal(r.run("plasma_state").value, 0);
});

test("SPEC: enable, states, record count up to the buffer, and a record the codec decodes", () => {
  const r = rig({ bufferSize: 3 });
  assert.equal(r.run("spec_state").value, 0);
  assert.equal(r.run("operating_mode").formatted, "Manual");
  assert.ok(r.run("spec_enable", 1).success);
  assert.equal(r.run("operating_mode").formatted, "Automatic SPEC");
  assert.equal(r.run("spec_state").formatted, "Active (SETUP)"); // plasma off
  r.run("plasma_enable", 1);
  r.advance(1500);
  assert.equal(r.run("spec_state").formatted, "Active (CAPTURE BACKGROUND)");
  assert.equal(r.run("spec_record_count").value, 0);
  r.advance(2500);
  assert.equal(r.run("spec_record_count").value, 2);
  assert.equal(r.run("spec_state").formatted, "Active (CAPTURE SPECTRUM)");
  r.advance(10_000);
  assert.equal(r.run("spec_record_count").value, 3);
  assert.equal(r.run("spec_buffer_size").value, 3);
  const rec = r.run("spec_record");
  assert.ok(rec.success, rec.error);
  assert.equal(rec.extra.pixel_count, 288);
  assert.equal(rec.extra.ignition_active, true);
  assert.ok(Math.abs(rec.extra.total_pressure_mbar - 1e-4) / 1e-4 < 1e-6);
  assert.ok(Math.max(...rec.extra.pixel_data) > 1000);
  assert.ok(r.run("all_algorithms_off", 0).success);
  assert.equal(r.run("spec_state").formatted, "Not active (IDLE)");
  assert.equal(r.run("operating_mode").value, 0);
});

test("RoR and RGD records decode with their extra fields, and only one algorithm is active", () => {
  const r = rig({ ignitionDelayMs: 0 });
  r.run("plasma_enable", 1);
  r.run("ror_enable", 1);
  r.advance(1000);
  const ror = r.run("ror_record");
  assert.ok(ror.success, ror.error);
  assert.equal(ror.extra.pixel_count, 288);
  assert.equal(ror.extra.leak_rate_numbers.length, 6);
  assert.equal(typeof ror.extra.pressure_rise_mtorr_per_min, "number");
  r.run("rgd_enable", 1);
  assert.equal(r.run("ror_state").formatted, "Not active (IDLE)");
  assert.equal(r.run("operating_mode").formatted, "Automatic RGD");
  r.advance(1000);
  const rgd = r.run("rgd_record");
  assert.ok(rgd.success, rgd.error);
  assert.equal(rgd.extra.pixel_count, 288);
  assert.equal(rgd.extra.partial_pressures.length, 10);
  assert.equal(rgd.extra.ratio_numbers.length, 8);
  const sum = rgd.extra.partial_pressures.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0.5e-4 && sum < 1.6e-4, `partials sum ${sum}`);
});

test("analog output mode and voltage", () => {
  const r = rig();
  assert.equal(r.run("analog_output_mode").formatted, "Total Pressure");
  const mv = r.run("analog_output_voltage").value;
  assert.ok(mv > 0 && mv < 10000);
});

test("records feed the studio: live spectrum, gas shares and the RGD partial pressures", () => {
  const r = rig({ ignitionDelayMs: 0 });
  let now = 5000;
  const studio = new OpgStudioState({ now: () => now });
  studio.ingestReply("pressure", r.run("pressure"));
  r.run("plasma_enable", 1);
  r.run("rgd_enable", 1);
  r.advance(1000);
  studio.ingestReply("rgd_record", r.run("rgd_record"));
  assert.equal(studio.spectrum?.source, "live");
  assert.match(studio.moleculeText, /^RGD partial pressures/);
  assert.ok(studio.latestGasPct.N2 > 0);
  now += 1000;
  studio.ingestReply("pressure", r.run("pressure"));
  assert.ok(studio.exportSamples.length >= 2);
});
