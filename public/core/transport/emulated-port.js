// @ts-check
/**
 * EmulatedPort — the same interface as PortSession, backed by protocol emulators instead
 * of a Web Serial port. Framers, codecs, the scheduler, the scan engine and the UI all run
 * unmodified against it (WEB_PORT_PLAN.md section 10).
 *
 * An emulator answers real frames. It only "hears" the host when the port's line settings
 * match its own, exactly like a real gauge at a different baud rate stays silent.
 *
 * @typedef {Object} LineSettings
 * @property {number} baudRate
 * @property {number=} dataBits
 * @property {number=} stopBits
 * @property {"none" | "even" | "odd"=} parity
 * @property {number=} bufferSize
 *
 * @typedef {Object} EmulatorContext
 * @property {LineSettings} settings
 * @property {(bytes: Uint8Array, delayMs?: number) => void} send   queue bytes to the host
 * @property {() => number} now                                     ms, monotonic
 * @property {(fn: () => void, ms: number) => any} setTimer
 * @property {(handle: any) => void} clearTimer
 *
 * @typedef {Object} Emulator
 * @property {string} family                       e.g. "cdg_serial"
 * @property {string} model
 * @property {number} baudRate                     the rate the emulated gauge is set to
 * @property {number=} address
 * @property {(bytes: Uint8Array, ctx: EmulatorContext) => void} receive   raw host bytes (any chunking)
 * @property {((ctx: EmulatorContext) => void)=} open    port opened at matching settings (start streaming here)
 * @property {(() => void)=} close
 * @property {((frame: Uint8Array) => "read" | "write" | "unknown")=} classify   used by tests: no writes during a scan
 * @property {Record<string, any>=} state          live, inspectable state (pressure source, unit, setpoints...)
 *
 * @typedef {Object} FaultOptions
 * @property {boolean=} echo            reflect every host write back first (RS485 adapter echo)
 * @property {boolean=} loopback        reflect host writes and never let the emulator answer
 * @property {boolean=} silent          nothing answers
 * @property {number=} splitEvery       deliver responses in chunks of at most N bytes
 * @property {number=} corruptEvery     flip one bit in every Nth response chunk
 * @property {number=} latencyMs        added to every response
 */
import { Emitter } from "../models.js";

let nextId = 1;

export class EmulatedPort extends Emitter {
  /**
   * @param {{ emulators?: Emulator[], label?: string, faults?: FaultOptions, clock?: { now: () => number, setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} [options]
   */
  constructor(options = {}) {
    super();
    this.id = `emu-${nextId++}`;
    this.kind = "emulated";
    this.label = options.label ?? "Simulated port";
    /** @type {Emulator[]} */
    this.emulators = options.emulators ?? [];
    /** @type {FaultOptions} */
    this.faults = { ...(options.faults ?? {}) };
    this.clock = options.clock ?? {
      now: () => (globalThis.performance ? performance.now() : Date.now()),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    };
    /** @type {LineSettings | null} */
    this.settings = null;
    this.isOpen = false;
    /** Every host write, for tests and the "no write during scan" assertion. @type {Uint8Array[]} */
    this.hostWrites = [];
    /** @type {Set<any>} */
    this._timers = new Set();
    this._chunkCount = 0;
    this.info = { usbVendorId: undefined, usbProductId: undefined };
  }

  /** @param {Emulator} emulator */
  attach(emulator) {
    this.emulators.push(emulator);
    if (this.isOpen && this.settings && this._hears(emulator)) emulator.open?.(this._context(emulator));
  }

  /** @param {Emulator} emulator */
  detach(emulator) {
    this.emulators = this.emulators.filter((e) => e !== emulator);
    emulator.close?.();
  }

  /** @param {LineSettings} settings */
  async open(settings) {
    if (this.isOpen) throw new Error("Port is already open.");
    this.settings = { dataBits: 8, stopBits: 1, parity: "none", ...settings };
    this.isOpen = true;
    this.emit("open", this.settings);
    for (const emulator of this.emulators) if (this._hears(emulator)) emulator.open?.(this._context(emulator));
  }

  async close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const t of this._timers) this.clock.clearTimeout(t);
    this._timers.clear();
    for (const emulator of this.emulators) emulator.close?.();
    this.emit("close", null);
  }

  /** @param {LineSettings} settings */
  async reopen(settings) {
    await this.close();
    await this.open(settings);
  }

  /** @param {Uint8Array} bytes */
  async write(bytes) {
    if (!this.isOpen) throw new Error("Port is not open.");
    const copy = Uint8Array.from(bytes);
    this.hostWrites.push(copy);
    this.emit("traffic", { dir: "tx", bytes: copy, t: Date.now() });
    if (this.faults.silent) return;
    if (this.faults.echo || this.faults.loopback) this._deliver(copy, 0);
    if (this.faults.loopback) return;
    for (const emulator of this.emulators) {
      if (this._hears(emulator)) emulator.receive(copy, this._context(emulator));
    }
  }

  /** @param {Emulator} emulator */
  _hears(emulator) {
    return Boolean(this.settings) && this.settings?.baudRate === emulator.baudRate;
  }

  /** @param {Emulator} emulator @returns {EmulatorContext} */
  _context(emulator) {
    return {
      settings: /** @type {LineSettings} */ (this.settings),
      send: (bytes, delayMs = 2) => {
        if (!this.isOpen || !this._hears(emulator)) return;
        this._deliver(bytes, delayMs + (this.faults.latencyMs ?? 0));
      },
      now: () => this.clock.now(),
      setTimer: (fn, ms) => {
        const handle = this.clock.setTimeout(() => {
          this._timers.delete(handle);
          if (this.isOpen) fn();
        }, ms);
        this._timers.add(handle);
        return handle;
      },
      clearTimer: (handle) => {
        this.clock.clearTimeout(handle);
        this._timers.delete(handle);
      }
    };
  }

  /** @param {Uint8Array} bytes @param {number} delayMs */
  _deliver(bytes, delayMs) {
    const size = this.faults.splitEvery && this.faults.splitEvery > 0 ? this.faults.splitEvery : bytes.length || 1;
    for (let offset = 0, i = 0; offset < bytes.length; offset += size, i += 1) {
      let chunk = Uint8Array.from(bytes.subarray(offset, offset + size));
      this._chunkCount += 1;
      if (this.faults.corruptEvery && this._chunkCount % this.faults.corruptEvery === 0 && chunk.length) {
        chunk[chunk.length - 1] ^= 0x01;
      }
      const handle = this.clock.setTimeout(() => {
        this._timers.delete(handle);
        if (!this.isOpen) return;
        this.emit("traffic", { dir: "rx", bytes: chunk, t: Date.now() });
        this.emit("data", chunk);
      }, Math.max(0, delayMs) + i);
      this._timers.add(handle);
    }
  }
}
