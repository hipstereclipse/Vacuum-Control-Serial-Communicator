// Setpoint model (public/core/setpoints.js) and command value shapes (public/core/command-values.js).
import { readFileSync } from "node:fs";
import { test, assert } from "../harness.mjs";
import {
  detectSetpoints, cdgRawToMbar, cdgMbarToRaw, ppgToBand, bandToPpg, relayStep, relayTrace, zoneOf,
  illustrativeCycle, cycleLevels, formatSetpointValue
} from "../../public/core/setpoints.js";
import { valueShape, choicesFrom, commandGroup } from "../../public/core/command-values.js";
import { commandsFromSpec } from "../../public/core/codecs/common.js";

const specs = JSON.parse(readFileSync(new URL("../../public/specs/all.json", import.meta.url), "utf8"));
const all = specs.specs ?? specs;
const spec = (model) => Object.values(all).find((s) => s.model === model);

test("detects CDG low/high pairs and PPG indexed setpoints from the generated specs", () => {
  const cdg = detectSetpoints(commandsFromSpec(spec("CDG045D")));
  assert.equal(cdg.kind, "cdg");
  assert.deepEqual(cdg.channels.map((c) => c.index), [1, 2]);
  assert.deepEqual(cdg.channels[0].commands, { low: "setpoint_1_low", high: "setpoint_1_high", read: "setpoint_1_read" });
  for (const model of ["PPG550", "PPG570"]) {
    const ppg = detectSetpoints(commandsFromSpec(spec(model)));
    assert.equal(ppg.kind, "ppg", model);
    assert.deepEqual(ppg.channels.map((c) => c.index), [1, 2, 3], model);
    assert.deepEqual(Object.keys(ppg.channels[1].commands).sort(), ["direction", "enable", "hysteresis", "value"], model);
  }
  assert.equal(detectSetpoints(commandsFromSpec(spec("PCG550"))), null);
});

test("CDG cube law round-trips every raw byte", () => {
  const fs = 13.332;
  assert.equal(cdgRawToMbar(0, fs), 0);
  assert.equal(cdgRawToMbar(255, fs), fs);
  assert.ok(Math.abs(cdgRawToMbar(60, fs) - fs * (60 / 255) ** 3) < 1e-12);
  for (let raw = 0; raw <= 255; raw += 1) assert.equal(cdgMbarToRaw(cdgRawToMbar(raw, fs), fs), raw);
  assert.equal(cdgMbarToRaw(1e9, fs), 255);
  assert.equal(cdgMbarToRaw(-1, fs), 0);
});

test("PPG hysteresis: absolute release pressure or offset from the setpoint", () => {
  assert.deepEqual(ppgToBand({ value: 0.1, hysteresis: 0.11, direction: "below" }, "absolute"), { on: 0.1, off: 0.11 });
  const below = ppgToBand({ value: 0.1, hysteresis: 0.02, direction: "below" }, "offset");
  assert.ok(Math.abs(below.off - 0.12) < 1e-12);
  const above = ppgToBand({ value: 0.1, hysteresis: 0.02, direction: "above" }, "offset");
  assert.ok(Math.abs(above.off - 0.08) < 1e-12);
  assert.deepEqual(bandToPpg({ on: 0.1, off: 0.11 }, "absolute"), { value: 0.1, hysteresis: 0.11 });
  assert.ok(Math.abs(bandToPpg({ on: 0.1, off: 0.12 }, "offset").hysteresis - 0.02) < 1e-12);
});

test("relay holds its state inside the hysteresis band", () => {
  const sp = { on: 1, off: 2, direction: "below" };
  assert.equal(relayStep(false, 1.5, sp), false);
  assert.equal(relayStep(true, 1.5, sp), true);
  assert.equal(relayStep(false, 0.9, sp), true);
  assert.equal(relayStep(true, 2.1, sp), false);
  assert.equal(relayStep(true, 0.5, { ...sp, enabled: false }), false);
  const up = { on: 10, off: 5, direction: "above" };
  assert.equal(relayStep(false, 11, up), true);
  assert.equal(relayStep(true, 7, up), true);
  assert.equal(relayStep(true, 4, up), false);
  // Falling from 3 to 0.5, bursting to 1.5 (inside the band), then venting to 3.
  const { states, switches } = relayTrace([3, 1.5, 0.5, 1.5, 0.8, 3], sp);
  assert.deepEqual(states, [false, false, true, true, true, false]);
  assert.deepEqual(switches, [{ i: 2, on: true }, { i: 5, on: false }]);
  assert.equal(zoneOf(1.5, sp), "band");
  assert.equal(zoneOf(0.5, sp), "on");
  assert.equal(zoneOf(5, sp), "off");
  assert.equal(zoneOf(5, { ...sp, enabled: false }), "disabled");
});

test("the illustrative cycle dips below every switch-on point and bursts into the focused band", () => {
  const sps = [{ on: 0.17, off: 0.34 }, { on: 1.4, off: 2.2 }];
  const levels = cycleLevels(sps, sps[0], { min: 1e-4, max: 13.332 });
  assert.ok(levels.yMin <= 0.17 / 10 && levels.yMax <= 13.332);
  assert.ok(levels.bottom < 0.17 && levels.top > 2.2);
  const curve = illustrativeCycle(levels);
  const ps = curve.map((c) => c.p);
  assert.ok(Math.min(...ps) < 0.17);
  assert.ok(Math.abs(ps[0] - levels.top) / levels.top < 1e-9 && Math.abs(ps.at(-1) - levels.top) / levels.top < 1e-9);
  // SP1 switches on in the pump-down, holds through the burst, and releases only in the vent.
  const { switches } = relayTrace(ps, { ...sps[0], direction: "below" });
  assert.equal(switches.length, 2);
  assert.ok(curve[switches[0].i].x < 0.4 && switches[0].on);
  assert.ok(curve[switches[1].i].x > 0.72 && !switches[1].on);
  const burstPeak = Math.max(...curve.filter((c) => c.x > 0.42 && c.x < 0.55).map((c) => c.p));
  assert.ok(burstPeak > 0.17 && burstPeak < 0.34, `burst ${burstPeak}`);
});

test("formatSetpointValue prints the gauge style", () => {
  assert.equal(formatSetpointValue(0.02), "2.00E-02");
  assert.equal(formatSetpointValue(1100), "1.10E+03");
});

test("value shapes come from options, ranges, units and descriptions", () => {
  const ppg550 = spec("PPG550");
  const ppg570 = spec("PPG570");
  const values = (shape) => shape.choices.map((c) => c.value);
  assert.deepEqual(values(valueShape("setpoint_1_direction", ppg550.commands.setpoint_1_direction, ppg550)), ["ABOVE", "BELOW"]);
  assert.deepEqual(values(valueShape("setpoint_1_enable", ppg550.commands.setpoint_1_enable, ppg550)), ["OFF", "ON"]);
  assert.deepEqual(values(valueShape("unit", ppg550.commands.unit, ppg550)), ["MBAR", "PASCAL", "TORR"]);
  assert.deepEqual(values(valueShape("baud_rate", ppg550.commands.baud_rate, ppg550)), ["4800", "9600", "19200", "38400", "57600", "115200"]);
  assert.deepEqual(values(valueShape("unit", ppg570.commands.unit, ppg570)), ["MBAR", "PASCAL", "TORR"]);
  assert.deepEqual(values(valueShape("setpoint_1_enable", ppg570.commands.setpoint_1_enable, ppg570)), ["ON", "OFF"]);
  assert.ok(values(valueShape("factory_default", ppg550.commands.factory_default, ppg550)).includes("NONE"));
  assert.deepEqual(values(valueShape("piezo_adjust", ppg550.commands.piezo_adjust, ppg550)), ["CLEAR"]);
  assert.equal(valueShape("setpoint_1", ppg550.commands.setpoint_1, ppg550).kind, "pressure");
  const cdg = spec("CDG045D");
  assert.deepEqual(values(valueShape("unit", cdg.commands.unit, cdg)), ["0", "1", "2"]);
  const raw = valueShape("setpoint_1_low", cdg.commands.setpoint_1_low, cdg);
  assert.equal(raw.kind, "range");
  assert.equal(raw.max, 255);
  assert.equal(valueShape("zero_adjust", cdg.commands.zero_adjust, cdg).kind, "none");
  const pcg = spec("PCG550");
  assert.deepEqual(values(valueShape("data_unit", pcg.commands.data_unit, pcg)), ["0", "1", "2", "3", "4"]);
  assert.deepEqual(values(valueShape("baud_rate", pcg.commands.baud_rate, pcg)), ["9600", "19200", "38400", "57600"]);
  assert.equal(valueShape("reset", pcg.commands.reset, pcg).kind, "text");
  const tc = spec("TC600");
  const speed = valueShape("speed_setpoint_pct", tc.commands.speed_setpoint_pct, tc);
  assert.equal(speed.kind, "range");
  assert.equal(speed.min, 20);
  assert.deepEqual(values(valueShape("pump_on", tc.commands.pump_on, tc)), ["1", "0"]);
  assert.deepEqual(choicesFrom({ options: { 0: "OFF", 1: "ON" } }, "").map((c) => c.value), ["0", "1"]);
});

test("command groups for the quick-command bar", () => {
  assert.equal(commandGroup("serial_number"), "identity");
  assert.equal(commandGroup("software_version"), "identity");
  assert.equal(commandGroup("pirani_pressure"), "readings");
  assert.equal(commandGroup("setpoint_2_hysteresis"), "setpoints");
  assert.equal(commandGroup("zero_adjust"), "service");
  assert.equal(commandGroup("gas_type"), "configuration");
});
