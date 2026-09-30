// @ts-check
/**
 * OPG550 emulator for the INFICON P3 V02 protocol (CSC inficon_p3_v02.py, the scanner's
 * `_probe_p3v02`, specs-src/gauges/opg550.yaml). Answers the identification PIDs 10000 to
 * 10004, pressure PID 14000 (float32, request data = unit code 1 mbar, 2 Torr, 3 Pa,
 * 4 micron), the status PIDs, and enough of the plasma and analysis PIDs for Spectrum Studio:
 *
 *  - plasma: writing 1 to PID 12002 switches it on; it ignites after `ignitionDelayMs` if the
 *    pressure is below `ignitionMaxMbar`, and goes out again if the pressure rises above it.
 *    PID 12003 reads 0 off, 1 on but not ignited, 2 ignited.
 *  - SPEC / RoR / RGD (PIDs 20000, 21000, 22000 and up): an enable write selects the algorithm
 *    (19000 then reads 1, 2 or 3); while the plasma is ignited a record is captured every
 *    `recordIntervalMs`, the record count rises to the buffer size, and a record read returns
 *    the latest one in the layout the codec decodes (header, then spectrum and per-algorithm
 *    fields). 19100 switches every algorithm off.
 *
 * 🟠 The ignition threshold, record cadence, integration time, analog-output scaling and the
 * RoR leak-rate numbers are illustrative, not taken from the OPG550 manual. Record request data
 * (record index and array descriptors, V13) is accepted but ignored: the latest record is
 * always returned.
 *
 * Unknown PIDs return the error frame (PID 0xFFFF, code 3 "Parameter not found"); writes to
 * read-only PIDs and reads of write-only PIDs return code 1.
 *
 * Options: `address` is the RS485 address (on RS232 the gauge answers address 0); `pressure`
 * returns mbar; `spectrum` returns a normalised spectrum over 303.05-876.07 nm and the
 * composition behind it (default: the AUTO composition model at the current pressure).
 */
import { ascii, float32BE, int32BE } from "../../bytes.js";
import { CMD_READ_REQ, CMD_READ_RESP, CMD_WRITE_REQ, CMD_WRITE_RESP, ERROR_PID, p3BuildFrame, p3Framer, p3ParseFrame } from "../../codecs/inficon-p3v02.js";
import { opticalComposition, simulateOpticalSpectrum } from "../opg-spectrum.js";
import { timedFramer } from "./line.js";

const UNIT_FACTORS = { 1: 1, 2: 1 / 1.33322387415, 3: 100, 4: 1000 / 1.33322387415 };
const PIXELS = 288;
const ALGORITHMS = /** @type {const} */ (["spec", "ror", "rgd"]);
/** RGD gas block order (codec / CSC `_apply_rgd_partial_pressures`). */
const RGD_ORDER = ["H2", "He", "N2", "O2", "Ar", "NH", "OH", "CH4", "CO", "Fluor"];

/**
 * @typedef {{ intensities: ArrayLike<number>, composition: Record<string, number>, trendMbarPerS?: number }} EmulatedSpectrum
 */

/**
 * @param {{
 *   product?: string,
 *   manufacturer?: string,
 *   serial?: string,
 *   firmware?: string,
 *   bootloader?: string,
 *   baudRate?: number,
 *   address?: number,
 *   rs485?: boolean,
 *   deviceId?: number,
 *   pressure?: () => number,
 *   spectrum?: () => EmulatedSpectrum,
 *   responseDelayMs?: number,
 *   ignitionMaxMbar?: number,
 *   ignitionDelayMs?: number,
 *   recordIntervalMs?: number,
 *   bufferSize?: number,
 *   plasmaEnabled?: boolean,
 * }} [options]
 * @returns {import("../../transport/emulated-port.js").Emulator}
 */
export function createP3V02Emulator(options = {}) {
  const product = options.product ?? "OPG550";
  const deviceId = options.deviceId ?? 0x0b;
  const framer = p3Framer();
  const feed = timedFramer(framer);
  const ignitionMaxMbar = options.ignitionMaxMbar ?? 1e-2;
  const ignitionDelayMs = options.ignitionDelayMs ?? 1500;
  const recordIntervalMs = options.recordIntervalMs ?? 1000;
  const bufferSize = options.bufferSize ?? 100;
  let noise = 0x2545f491;
  const rand = () => {
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    return noise / 2 ** 32;
  };

  const state = {
    address: options.address ?? 0,
    pressure: options.pressure ?? (() => 2.5e-3),
    masterUnit: 1,
    plasmaInterlock: 0,
    plasmaEnabled: options.plasmaEnabled ? 1 : 0,
    /** @type {number | null} ms when the plasma was switched on */
    plasmaOnAt: options.plasmaEnabled ? -Infinity : /** @type {number | null} */ (null),
    /** @type {null | "spec" | "ror" | "rgd"} */
    algorithm: /** @type {null | "spec" | "ror" | "rgd"} */ (null),
    /** @type {Record<string, "none" | "idle" | "active">} */
    algorithmState: { spec: "none", ror: "none", rgd: "none" },
    algorithmStartAt: 0,
    /** @type {number | null} */
    captureAt: /** @type {number | null} */ (null),
    /** @type {Record<string, number>} records captured since the algorithm started (capped at the buffer) */
    counts: { spec: 0, ror: 0, rgd: 0 },
    recordId: 0,
    errorStatus: 0,
    lastPressure: NaN,
    lastPressureAt: 0
  };
  const cstr = (/** @type {string} */ s) => Uint8Array.from([...ascii(s), 0]);

  /** @param {number} now */
  function ignited(now) {
    return Boolean(state.plasmaEnabled) && state.plasmaOnAt != null && now - state.plasmaOnAt >= ignitionDelayMs && state.pressure() < ignitionMaxMbar;
  }

  /** Advance record capture to `now`. @param {number} now */
  function tick(now) {
    const algo = state.algorithm;
    if (!algo || !ignited(now)) {
      state.captureAt = null;
      return;
    }
    let next = state.captureAt ?? now + recordIntervalMs;
    while (now >= next) {
      state.counts[algo] = Math.min(bufferSize, state.counts[algo] + 1);
      state.recordId += 1;
      next += recordIntervalMs;
    }
    state.captureAt = next;
  }

  /** @param {"spec" | "ror" | "rgd"} algo @param {number} now */
  function algorithmCode(algo, now) {
    const s = state.algorithmState[algo];
    if (s === "none") return 0;
    if (s === "idle") return 1;
    if (!ignited(now)) return 2; // SETUP
    if (algo !== "ror" && state.counts[algo] === 0) return 3; // CAPTURE BACKGROUND
    return algo === "ror" ? 3 : 4; // CAPTURE SPECTRUM
  }

  /** @param {"spec" | "ror" | "rgd"} algo @param {Uint8Array} data @param {number} now */
  function enable(algo, data, now) {
    if (!data.length) return 4;
    if (data[0]) {
      for (const a of ALGORITHMS) if (a !== algo && state.algorithmState[a] === "active") state.algorithmState[a] = "idle";
      state.algorithm = algo;
      state.algorithmState[algo] = "active";
      state.algorithmStartAt = now;
      state.counts[algo] = 0;
      state.captureAt = null;
    } else {
      state.algorithmState[algo] = "idle";
      if (state.algorithm === algo) state.algorithm = null;
    }
    return undefined;
  }

  function spectrumNow() {
    if (options.spectrum) return options.spectrum();
    const p = Math.max(state.pressure(), 1e-12);
    return {
      intensities: simulateOpticalSpectrum(p, 0, 0, "Auto", { wavelengthMinNm: 303.05, wavelengthMaxNm: 876.07, samples: PIXELS }),
      composition: opticalComposition(p, 0, 0, "Auto"),
      trendMbarPerS: 0
    };
  }

  /** Record header: id, time ms, integration µs, total pressure (float32 mbar), ignition. @param {number} now */
  function header(now) {
    const out = new Uint8Array(17);
    const view = new DataView(out.buffer);
    view.setUint32(0, state.recordId >>> 0);
    view.setUint32(4, Math.max(0, Math.round(now - state.algorithmStartAt)) >>> 0);
    view.setUint32(8, 1000);
    view.setFloat32(12, state.pressure());
    out[16] = ignited(now) ? 1 : 0;
    return out;
  }

  /** @param {"spec" | "ror" | "rgd"} algo @param {number} now */
  function record(algo, now) {
    const s = spectrumNow();
    const n = Math.min(PIXELS, s.intensities.length);
    const px = Array.from({ length: n }, (_, i) => Math.max(0, Number(s.intensities[i]) * (1 + (rand() - 0.5) * 0.02)));
    const head = header(now);
    const comp = s.composition;
    const frac = (/** @type {string} */ k) => Math.max(0, Number(comp[k] ?? 0));
    if (algo === "ror") {
      const body = new Uint8Array(4 + n * 2 + 12);
      const view = new DataView(body.buffer);
      view.setFloat32(0, (s.trendMbarPerS ?? 0) * 750.062 * 60);
      px.forEach((v, i) => view.setUint16(4 + i * 2, Math.min(65535, Math.round(v * 60000))));
      // Six leak-rate numbers (x100 on the wire), illustrative: O2, Ar, N2 x3, H2 shares in %.
      ["O2", "Ar", "N2", "N2", "N2", "H2"].forEach((g, i) => view.setInt16(4 + n * 2 + i * 2, Math.round(frac(g) * 100 * 100)));
      return concat(head, body);
    }
    const powers = new Uint8Array(n * 4);
    const pv = new DataView(powers.buffer);
    px.forEach((v, i) => pv.setUint32(i * 4, Math.round(v * 400000)));
    if (algo === "spec") return concat(head, powers);
    const tail = new Uint8Array(10 * 4 * 2 + 8 * 4);
    const tv = new DataView(tail.buffer);
    const p = state.pressure();
    const share = (/** @type {string} */ g) => (g === "OH" ? frac("OH") + 0.5 * frac("H2O") : frac(g));
    RGD_ORDER.forEach((g, i) => {
      tv.setFloat32(i * 4, share(g) * 1e5);
      tv.setFloat32(40 + i * 4, share(g) * p);
    });
    const ratio = (/** @type {number} */ a, /** @type {number} */ b) => (b > 1e-12 ? a / b : 0);
    [ratio(frac("N2"), share("OH")), ratio(frac("N2"), share("OH")), ratio(frac("N2"), frac("H2")), ratio(frac("N2"), frac("H2")),
      ratio(frac("N2"), frac("Ar")), ratio(frac("O2"), frac("Ar")), ratio(frac("He"), frac("N2")), ratio(frac("O2"), frac("N2"))]
      .forEach((r, i) => tv.setFloat32(80 + i * 4, r));
    return concat(head, powers, tail);
  }

  /** @type {Record<number, { read?: (req: Uint8Array, now: number) => Uint8Array, write?: (data: Uint8Array, now: number) => number | void }>} */
  const params = {
    10000: { read: () => cstr(options.manufacturer ?? "SIMULATED") },
    10001: { read: () => cstr(product) },
    10002: { read: () => cstr(options.serial ?? "55001234") },
    10003: { read: () => cstr(options.bootloader ?? "1.00") },
    10004: { read: () => cstr(options.firmware ?? "1.12") },
    11000: { read: () => Uint8Array.of(state.errorStatus) },
    11001: { read: () => int32BE(32) },
    11002: { read: () => int32BE(0) },
    12000: { write: (d) => (d.length === 1 ? void (state.plasmaInterlock = d[0] ? 1 : 0) : 4) },
    12001: { read: () => Uint8Array.of(state.plasmaInterlock) },
    12002: {
      write: (d, now) => {
        if (d.length !== 1) return 4;
        const on = d[0] ? 1 : 0;
        if (on && !state.plasmaEnabled) state.plasmaOnAt = now;
        if (!on) state.plasmaOnAt = null;
        state.plasmaEnabled = on;
        return undefined;
      }
    },
    12003: { read: (_r, now) => Uint8Array.of(!state.plasmaEnabled ? 0 : ignited(now) ? 2 : 1) },
    13000: { read: () => Uint8Array.of(PIXELS >> 8, PIXELS & 0xff) },
    14000: {
      read: (req) => {
        const unit = req.length ? req[0] : state.masterUnit;
        const factor = UNIT_FACTORS[/** @type {keyof typeof UNIT_FACTORS} */ (unit)] ?? 1;
        return float32BE(state.pressure() * factor);
      }
    },
    14001: { read: () => Uint8Array.of(state.masterUnit) },
    19000: { read: () => Uint8Array.of(state.algorithm ? ALGORITHMS.indexOf(state.algorithm) + 1 : 0) },
    19100: {
      write: () => {
        for (const a of ALGORITHMS) if (state.algorithmState[a] !== "none") state.algorithmState[a] = "idle";
        state.algorithm = null;
        return undefined;
      }
    },
    30000: { read: () => Uint8Array.of(2) }, // Total Pressure
    30001: {
      read: () => {
        const mv = Math.round(Math.max(0, Math.min(10000, (Math.log10(Math.max(state.pressure(), 1e-12)) + 11) * 750)));
        return Uint8Array.of(mv >> 8, mv & 0xff);
      }
    }
  };
  ALGORITHMS.forEach((algo, i) => {
    const base = 20000 + i * 1000;
    params[base] = { write: (d, now) => enable(algo, d, now) };
    params[base + 1] = { read: (_r, now) => Uint8Array.of(algorithmCode(algo, now)) };
    params[base + 2] = { read: () => int32BE(bufferSize) };
    params[base + 3] = { read: () => int32BE(state.counts[algo]) };
    params[base + 4] = { read: (_r, now) => record(algo, now) };
  });

  return {
    family: "inficon_p3_v02",
    model: product,
    baudRate: options.baudRate ?? 115200,
    address: state.address,
    state,
    open() {
      framer.reset();
    },
    classify(f) {
      try {
        const p = p3ParseFrame(f);
        if (!p.crcOk) return "unknown";
        return p.cmd === CMD_READ_REQ ? "read" : p.cmd === CMD_WRITE_REQ ? "write" : "unknown";
      } catch {
        return "unknown";
      }
    },
    receive(bytes, ctx) {
      for (const frame of feed(bytes, ctx.now())) {
        const f = p3ParseFrame(frame);
        if (f.ack !== 0 || (f.cmd !== CMD_READ_REQ && f.cmd !== CMD_WRITE_REQ)) continue;
        if (f.addr !== (options.rs485 ? state.address : 0)) continue;
        const now = ctx.now();
        tick(now);
        const replyAddr = 0x00;
        const respCmd = f.cmd === CMD_READ_REQ ? CMD_READ_RESP : CMD_WRITE_RESP;
        const delay = options.responseDelayMs ?? 3;
        /** @param {number} pid @param {ArrayLike<number>} data @param {number} [cmd] */
        const send = (pid, data, cmd = respCmd) => ctx.send(p3BuildFrame(cmd, pid, data, { addr: replyAddr, senderId: deviceId, ack: 1 }), delay);
        const param = params[f.pid];
        if (!param) {
          send(ERROR_PID, [3]);
          continue;
        }
        if (f.cmd === CMD_READ_REQ) {
          if (!param.read) send(ERROR_PID, [1]);
          else send(f.pid, param.read(f.data, now));
        } else {
          if (!param.write) {
            send(ERROR_PID, [1]);
            continue;
          }
          const code = param.write(f.data, now);
          if (code) send(ERROR_PID, [code]);
          else send(f.pid, []);
        }
      }
    }
  };
}

/** @param {...Uint8Array} parts */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
