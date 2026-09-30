import { test, assert } from "../harness.mjs";
import { Series, SAMPLE_STATUS, decimate, statusFromWarnings } from "../../public/core/store/buffers.js";
import { makeSession, parseSession } from "../../public/core/store/session.js";
import { measurementCsv, trafficCsv, transcript, csvHeader } from "../../public/core/store/export.js";

test("Series grows past its capacity and keeps order", () => {
  const s = new Series("a", { capacity: 2 });
  for (let i = 0; i < 100; i += 1) s.push(i * 10, i);
  assert.equal(s.length, 100);
  assert.equal(s.lowerBound(505), 51);
  assert.deepEqual(s.last(), { t: 990, v: 99, s: 0 });
});

test("stats leave out over- and underrange samples and give the rate in decades per minute", () => {
  const s = new Series("a");
  // One decade drop per minute: 1e-2 → 1e-3 over 60 s.
  for (let i = 0; i <= 60; i += 1) s.push(i * 1000, 10 ** (-2 - i / 60));
  s.push(61000, 5, SAMPLE_STATUS.OVERRANGE);
  const st = s.stats(0, 61000);
  assert.equal(st.count, 61);
  assert.ok(st.max < 0.011);
  assert.ok(Math.abs(st.decadesPerMinute - -1) < 1e-6);
});

test("decimation keeps spikes and bounds the point count", () => {
  const s = new Series("a");
  for (let i = 0; i < 100000; i += 1) s.push(i, i === 55555 ? 1000 : 1);
  const points = decimate(s, 0, 100000, 200);
  assert.ok(points.length <= 200 * 4 + 2);
  assert.ok(points.some((p) => p.v === 1000));
});

test("decimate keeps the samples just before the window without throwing", () => {
  const s = new Series("b");
  // Two samples before `from` fall in column -1, the decimator's initial column.
  for (const t of [990, 995, 1000, 1500, 2000]) s.push(t, t / 1000);
  const points = decimate(s, 999, 2000, 10);
  assert.ok(points.some((p) => p.t === 995));
  assert.ok(points.some((p) => p.t === 2000));
});

test("statusFromWarnings maps codec warnings to sample status", () => {
  assert.equal(statusFromWarnings(["overrange"]), SAMPLE_STATUS.OVERRANGE);
  assert.equal(statusFromWarnings(["sensor not ready"]), SAMPLE_STATUS.WARNING);
  assert.equal(statusFromWarnings([]), SAMPLE_STATUS.OK);
});

test("session round trip keeps real and simulated devices and the full-scale origin", () => {
  const devices = [
    { id: "d1", model: "CDG045D", family: "cdg_serial", simulated: false, fullScale: { value: 10, unit: "Torr", origin: "user" }, poll: { commands: ["pressure"], intervalMs: 100 } },
    { id: "d2", model: "PCG550", family: "inficon_binary", simulated: true, poll: { commands: ["pressure"], intervalMs: 500 } }
  ];
  const json = JSON.stringify(makeSession({ name: "Chamber 3", devices, app: { version: "0.1.0", build: "abc" } }));
  const parsed = parseSession(json);
  assert.equal(parsed.devices.length, 2);
  assert.equal(parsed.devices.find((d) => d.id === "d2").simulated, true);
  assert.deepEqual(parsed.devices[0].fullScale, { value: 10, unit: "Torr", origin: "user" });
  assert.throws(() => parseSession('{"format":"something-else"}'), /Unknown session format/);
});

test("merged CSV: union of timestamps, empty cells where a device had no sample, displayed column", () => {
  const a = new Series("a", { unit: "mbar" });
  const b = new Series("b", { unit: "mbar" });
  a.push(1000, 1.33322387415);
  a.push(2000, 2);
  b.push(2000, 3, SAMPLE_STATUS.OVERRANGE);
  const header = csvHeader({ app: { version: "0.1.0", build: "abc" }, session: "S", devices: [{ label: "A", model: "CDG045D", address: 0, fullScale: { value: 10, unit: "Torr", origin: "user" }, line: { baudRate: 9600 } }], displayUnit: "Torr" });
  const out = measurementCsv({ series: [{ label: "A", series: a }, { label: "B", series: b }], displayUnit: "Torr", header });
  const lines = out.trim().split("\n");
  assert.match(lines[0], /build abc/);
  assert.ok(lines.some((l) => /full scale 10 Torr \(confirmed by user\)/.test(l)));
  const table = lines.filter((l) => !l.startsWith("#"));
  assert.equal(table[0], "timestamp_iso,epoch_ms,A value,A unit,A status,A displayed (Torr),B value,B unit,B status,B displayed (Torr)");
  assert.match(table[1], /^.*,1000,1\.33322\d*,mbar,ok,1(\.0+\d*)?,,,,$/);
  assert.match(table[2], /,2000,2,mbar,ok,.*,3,mbar,overrange,/);
});

test("traffic CSV and transcript carry exact bytes", () => {
  const entries = [{ t: 0, dir: "tx", device: "CDG", bytes: Uint8Array.of(3, 0, 0x3b, 0, 0x3b) }];
  assert.match(trafficCsv({ entries, header: "# h" }), /03 00 3B 00 3B/);
  assert.match(transcript({ entries, header: "# h" }), /→ <0x03><NUL>;<NUL>;/);
});
