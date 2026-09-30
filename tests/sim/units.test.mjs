// Port of CSC tests/test_units.py, plus the web additions (micron, case-insensitive units).
import { test, assert } from "../harness.mjs";
import { PRESSURE_UNITS, convertPressure, formatPressure, fromMbar, isPressureUnit, toMbar } from "../../public/core/units.js";

const isClose = (a, b, rel = 1e-12) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

test("identity conversion is a no-op for every unit", () => {
  for (const unit of PRESSURE_UNITS) {
    assert.equal(convertPressure(1.234e-5, unit, unit), 1.234e-5);
    assert.equal(convertPressure(1013.0, unit, unit), 1013.0);
  }
});

test("A -> B -> A round-trips for every unit pair", () => {
  for (const a of PRESSURE_UNITS) {
    for (const b of PRESSURE_UNITS) {
      for (const value of [1e-6, 1e-3, 1.0, 1013.0]) {
        const back = convertPressure(convertPressure(value, a, b), b, a);
        assert.ok(isClose(back, value), `${a}->${b}->${a} ${value}: ${back}`);
      }
    }
  }
});

test("toMbar / fromMbar round-trip", () => {
  for (const unit of PRESSURE_UNITS) {
    for (const value of [1e-9, 2.5e-4, 0.75, 1100]) {
      assert.ok(isClose(fromMbar(toMbar(value, unit), unit), value), unit);
    }
  }
});

test("mbar and hPa are exactly equal", () => {
  assert.equal(convertPressure(17.5, "mbar", "hPa"), 17.5);
  assert.equal(convertPressure(17.5, "hPa", "mbar"), 17.5);
});

test("1 Torr == 1.33322387415 mbar", () => {
  assert.ok(isClose(convertPressure(1.0, "Torr", "mbar"), 1.33322387415));
});

test("1 mbar == 100 Pa", () => {
  assert.ok(isClose(convertPressure(1.0, "mbar", "Pa"), 100.0));
});

test("micron is a thousandth of a Torr", () => {
  assert.ok(isClose(convertPressure(1000, "micron", "Torr"), 1.0));
  assert.ok(isClose(toMbar(1, "micron"), 1.33322387415e-3));
  assert.ok(isClose(convertPressure(1, "mTorr", "micron"), 1));
});

test("psi factor matches CSC", () => {
  assert.ok(isClose(toMbar(1, "psi"), 68.9475729317831));
});

test("unit lookup is case-insensitive", () => {
  assert.ok(isClose(convertPressure(1, "torr", "MBAR"), 1.33322387415));
  assert.ok(isClose(convertPressure(1, "TORR", "pa"), 133.322387415));
  assert.equal(convertPressure(5, "HPA", "mbar"), 5);
  assert.ok(isPressureUnit("Torr") && isPressureUnit("torr") && isPressureUnit(" MICRON "));
  assert.ok(!isPressureUnit("bar") && !isPressureUnit("°C") && !isPressureUnit(undefined));
});

test("unknown unit throws 'Unsupported pressure unit'", () => {
  assert.throws(() => convertPressure(1.0, "bar", "mbar"), /Unsupported pressure unit/);
  assert.throws(() => convertPressure(1.0, "mbar", "bar"), /Unsupported pressure unit/);
  assert.throws(() => toMbar(1, "inHg"), /Unsupported pressure unit/);
});

test("formatPressure uses scientific notation for vacuum", () => {
  const s = formatPressure(1.23e-6, "mbar");
  assert.equal(s, "1.2300e-06 mbar");
});

test("formatPressure is compact near atmosphere", () => {
  const s = formatPressure(1013.0, "mbar");
  assert.equal(s, "1013 mbar");
  assert.equal(formatPressure(0.5, "Torr"), "0.5 Torr");
  assert.equal(formatPressure(12346, "Pa"), "1.235e+04 Pa");
  assert.equal(formatPressure(NaN, "mbar"), "— mbar");
});
