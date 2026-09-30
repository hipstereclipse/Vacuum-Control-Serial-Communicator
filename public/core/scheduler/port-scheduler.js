// @ts-check
/**
 * PortScheduler — one per physical port. The web edition of CSC's GaugeWorker
 * (acquisition.py), restated for a port shared by several devices (RS485 multi-drop):
 *
 * - one transaction outstanding on the port at any time (half-duplex bus);
 * - a poll cycle walks the devices in order, honours each device's own interval, and never
 *   starts a new cycle before the previous one finished;
 * - terminal jobs are drained between poll transactions (CSC drains at the top of a cycle);
 * - a frame equal to the request byte for byte is an RS485 echo: wait for the next one;
 * - CSC's error policy constants, unchanged (Appendix C);
 * - streaming devices (CDG) decode every frame; ad-hoc commands on a streaming line take the
 *   first valid frame the codec says matches (CDG: read-command echo in byte 6).
 *
 * Emits: "reading", "info", "error", "terminal", "status", "gap", "stats".
 */
import { Emitter, deviceError, stamp } from "../models.js";
import { equalBytes } from "../bytes.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  ERROR_RETRY_DELAY_MS,
  LOOPBACK_CYCLES,
  MAX_CONSECUTIVE_ERRORS,
  MIN_POLL_INTERVAL_MS,
  RESPONSE_TIMEOUT_MS
} from "../constants.js";

/**
 * @typedef {Object} DeviceConfig
 * @property {string} id
 * @property {string} label
 * @property {import("../models.js").Codec & Record<string, any>} codec
 * @property {string[]=} commands       polled each cycle (polled devices) — reads only
 * @property {number=} intervalMs       poll interval; for streaming devices, the minimum spacing of recorded samples
 * @property {boolean=} polling
 *
 * @typedef {DeviceConfig & {
 *   commands: string[], intervalMs: number, polling: boolean, streaming: boolean,
 *   nextDue: number, consecutiveErrors: number, silentCycles: number, emptyReads: number,
 *   lastFrameAt: number, lastRecordedAt: number, state: string, started: boolean
 * }} DeviceSession
 */

export class PortScheduler extends Emitter {
  /**
   * @param {import("../transport/emulated-port.js").EmulatedPort | import("../transport/port-session.js").PortSession} port
   * @param {{ responseTimeoutMs?: number, errorRetryDelayMs?: number }} [options]
   */
  constructor(port, options = {}) {
    super();
    this.port = port;
    this.responseTimeoutMs = options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
    this.errorRetryDelayMs = options.errorRetryDelayMs ?? ERROR_RETRY_DELAY_MS;
    /** @type {Map<string, DeviceSession>} */
    this.devices = new Map();
    /** @type {import("../models.js").Framer | null} */
    this.framer = null;
    this.protocol = null;
    /** @type {any} */
    this.pending = null;
    /** @type {Array<any>} */
    this.jobs = [];
    this.running = false;
    /** @type {(() => void) | null} */
    this._wakeFn = null;
    /** @type {any} */
    this._watchdog = null;
    this._unsub = [
      port.on("data", (/** @type {Uint8Array} */ chunk) => this._onData(chunk)),
      port.on("close", () => this._onPortClosed("Port closed")),
      port.on("disconnect", () => this._onPortClosed("Adapter unplugged"))
    ];
    this.cycleMs = 0;
  }

  /** @param {DeviceConfig} config */
  addDevice(config) {
    if (this.protocol && config.codec.protocol !== this.protocol) {
      throw new Error(`This port already runs ${this.protocol}; devices on one port must share a protocol.`);
    }
    if (!this.protocol) {
      this.protocol = config.codec.protocol;
      this.framer = config.codec.framer();
    }
    const streaming = config.codec.supportsContinuousOutput();
    /** @type {DeviceSession} */
    const device = {
      ...config,
      commands: (config.commands ?? ["pressure"]).slice(),
      intervalMs: Math.max(MIN_POLL_INTERVAL_MS, config.intervalMs ?? DEFAULT_POLL_INTERVAL_MS),
      polling: config.polling ?? true,
      streaming,
      nextDue: 0,
      consecutiveErrors: 0,
      silentCycles: 0,
      emptyReads: 0,
      lastFrameAt: 0,
      lastRecordedAt: 0,
      state: "idle",
      started: false
    };
    this.devices.set(device.id, device);
    this._setState(device, device.polling ? "starting" : "paused");
    this._wake();
    return device;
  }

  /** @param {string} id */
  removeDevice(id) {
    this.devices.delete(id);
    if (this.devices.size === 0) {
      this.protocol = null;
      this.framer = null;
    }
  }

  /** @param {string} id @param {boolean} enabled */
  setPolling(id, enabled) {
    const device = this._device(id);
    device.polling = enabled;
    if (enabled) {
      device.consecutiveErrors = 0;
      device.silentCycles = 0;
      device.emptyReads = 0;
      device.nextDue = 0;
      if (device.state === "dead" || device.state === "offline") device.started = false;
    } else if (device.streaming) {
      // CSC flushes input while paused so stale streamed frames cannot collide with ad-hoc commands.
      this.framer?.reset();
    }
    this._setState(device, enabled ? "starting" : "paused");
    this._wake();
  }

  /** @param {string} id @param {string[]} commands */
  setCommands(id, commands) {
    const device = this._device(id);
    const known = new Map((device.codec.commands?.() ?? []).map((c) => [c.name, c]));
    // Only read commands are polled automatically (CSC `set_commands`); never a write.
    device.commands = commands.filter((c) => !known.size || known.get(c)?.read);
  }

  /** @param {string} id @param {number} ms */
  setInterval(id, ms) {
    this._device(id).intervalMs = Math.max(MIN_POLL_INTERVAL_MS, Number(ms) || DEFAULT_POLL_INTERVAL_MS);
    this._wake();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop = this._run();
    this._watchdog = setInterval(() => this._checkStreams(), this.responseTimeoutMs);
  }

  async stop() {
    this.running = false;
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = null;
    this._wake();
    this.pending?.finish(null);
    for (const job of this.jobs.splice(0)) job.reject(new Error("Scheduler stopped"));
    try {
      await this._loop;
    } catch {}
  }

  dispose() {
    for (const unsub of this._unsub) unsub();
  }

  /**
   * Queue a terminal frame (raw bytes or a built command). Resolves with the TerminalEntry.
   * @param {string} deviceId
   * @param {Uint8Array} request
   * @param {{ command?: string, isWrite?: boolean }} [options]
   * @returns {Promise<import("../models.js").TerminalEntry>}
   */
  terminal(deviceId, request, options = {}) {
    return new Promise((resolve, reject) => {
      this.jobs.push({ kind: "terminal", deviceId, request, command: options.command ?? "", isWrite: Boolean(options.isWrite), resolve, reject });
      this._wake();
    });
  }

  // ---------------------------------------------------------------------------------------

  /** @param {string} id */
  _device(id) {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Unknown device ${id}`);
    return device;
  }

  /** @param {DeviceSession} device @param {string} state @param {string} [message] */
  _setState(device, state, message = "") {
    if (device.state === state && !message) return;
    device.state = state;
    this.emit("status", { deviceId: device.id, state, message });
  }

  _wake() {
    const fn = this._wakeFn;
    this._wakeFn = null;
    fn?.();
  }

  /** @param {number} ms */
  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._wakeFn = null;
        resolve(undefined);
      }, Math.max(0, ms));
      this._wakeFn = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
    });
  }

  /** @param {Uint8Array} chunk */
  _onData(chunk) {
    if (this.pending) this.pending.rxBytes += chunk.length;
    if (!this.framer) return;
    for (const frame of this.framer.push(chunk)) this._onFrame(frame);
  }

  /** @param {Uint8Array} frame */
  _onFrame(frame) {
    const p = this.pending;
    if (p) {
      if (equalBytes(frame, p.request)) {
        p.echoSeen = true;
        return;
      }
      const matcher = p.device.codec.matchesResponse;
      if (!matcher || matcher(frame, p.command)) {
        p.finish(frame);
        return;
      }
    }
    // Unsolicited frames: continuous output from a streaming device on this port.
    for (const device of this.devices.values()) {
      if (device.streaming && device.codec.parseContinuous) {
        this._onStreamFrame(device, frame);
        return;
      }
    }
  }

  /** @param {DeviceSession} device @param {Uint8Array} frame */
  _onStreamFrame(device, frame) {
    device.lastFrameAt = Date.now();
    device.emptyReads = 0;
    if (!device.polling) return;
    if (device.state !== "streaming") this._setState(device, "streaming");
    const result = /** @type {Function} */ (device.codec.parseContinuous)(frame);
    if (!result.success) {
      device.consecutiveErrors += 1;
      this.emit("error", deviceError(device.id, result.error ?? "CDG parse error", true));
      return;
    }
    device.consecutiveErrors = 0;
    if (result.value == null) return;
    // The poll interval is the minimum spacing of recorded samples; a CDG can stream ~100 frames/s.
    const now = Date.now();
    if (now - device.lastRecordedAt < device.intervalMs) return;
    device.lastRecordedAt = now;
    this._emitReading(device, "pressure", result);
  }

  /** @param {DeviceSession} device @param {string} command @param {import("../models.js").Reading} result */
  _emitReading(device, command, result) {
    const { mono, wall } = stamp();
    this.emit("reading", {
      deviceId: device.id,
      mono,
      wall,
      value: result.value,
      unit: result.unit ?? "",
      command,
      formatted: result.formatted,
      warnings: result.extra?.warnings ?? [],
      extra: result.extra ?? {},
      raw: result.raw
    });
  }

  /** @param {string} message */
  _onPortClosed(message) {
    for (const device of this.devices.values()) {
      device.started = false;
      if (device.state !== "paused") this._setState(device, "offline", message);
    }
    this.pending?.finish(null);
  }

  /** Streaming watchdog: CSC gives up after 5 consecutive empty reads ("No data from CDG"). */
  _checkStreams() {
    for (const device of this.devices.values()) {
      if (!device.streaming || !device.polling || !device.started || device.state === "dead") continue;
      if (Date.now() - device.lastFrameAt < this.responseTimeoutMs) continue;
      device.emptyReads += 1;
      if (device.emptyReads === 2) {
        // Re-send the read request once: harmless, and it restarts output on a gauge that was power-cycled.
        this.jobs.push({ kind: "restart", deviceId: device.id, resolve: () => {}, reject: () => {} });
        this._wake();
      }
      if (device.emptyReads >= MAX_CONSECUTIVE_ERRORS) {
        this._setState(device, "dead", "No data from CDG — giving up");
        this.emit("error", deviceError(device.id, "No data from CDG — giving up. Check power, cable and baud rate, then resume.", false));
        device.polling = false;
      }
    }
  }

  /**
   * One transaction: write, then wait for the first frame the codec accepts, skipping an echo.
   * @param {DeviceSession} device
   * @param {Uint8Array} request
   * @param {string} command
   * @returns {Promise<{ frame: Uint8Array | null, sawResponse: boolean, echoSeen: boolean }>}
   */
  async _transact(device, request, command) {
    if (!device.streaming) this.framer?.reset(); // CSC: flush_input() before every write
    /** @type {any} */
    const pending = { device, request, command, rxBytes: 0, echoSeen: false };
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => pending.finish(null), this.responseTimeoutMs);
      pending.finish = (/** @type {Uint8Array | null} */ frame) => {
        clearTimeout(timer);
        if (this.pending === pending) this.pending = null;
        resolve(frame);
      };
    });
    this.pending = pending;
    try {
      await this.port.write(request);
    } catch (error) {
      pending.finish(null);
      throw error;
    }
    const frame = /** @type {Uint8Array | null} */ (await done);
    const echoBytes = pending.echoSeen ? request.length : 0;
    return { frame, sawResponse: Boolean(frame) || pending.rxBytes > echoBytes, echoSeen: pending.echoSeen };
  }

  async _drainJobs() {
    while (this.jobs.length && this.running) {
      const job = this.jobs.shift();
      const device = this.devices.get(job.deviceId);
      if (!device) {
        job.reject(new Error("Device removed"));
        continue;
      }
      if (job.kind === "restart") {
        try {
          await this.port.write(device.codec.buildRequest("pressure"));
        } catch {}
        continue;
      }
      const { wall } = stamp();
      try {
        const { frame } = await this._transact(device, job.request, job.command);
        /** @type {import("../models.js").TerminalEntry} */
        const entry = { request: job.request, response: frame ?? new Uint8Array(0), wall, command: job.command };
        if (!frame) entry.error = "No response";
        else if (job.command) {
          const parsed = device.codec.parseResponse(frame, job.command);
          entry.formatted = parsed.success ? parsed.formatted ?? String(parsed.value) : undefined;
          entry.parsed = parsed;
          if (!parsed.success) entry.error = parsed.error;
          this._afterCommand(device, job.command, parsed);
        }
        this.emit("terminal", { deviceId: device.id, ...entry });
        job.resolve(entry);
      } catch (error) {
        const entry = { request: job.request, response: new Uint8Array(0), wall, command: job.command, error: String(/** @type {Error} */ (error).message ?? error) };
        this.emit("terminal", { deviceId: device.id, ...entry });
        job.resolve(entry);
      }
    }
  }

  /** Side effects of specific commands, e.g. a unit read labels Real32 pressures. @param {DeviceSession} device @param {string} command @param {import("../models.js").Reading} parsed */
  _afterCommand(device, command, parsed) {
    if (command === "data_unit" && parsed.success && typeof device.codec.setDataUnit === "function") {
      const label = String(parsed.formatted ?? "").split(" ")[0];
      if (label) device.codec.setDataUnit(label);
    }
  }

  async _run() {
    while (this.running) {
      await this._drainJobs();
      const now = Date.now();
      let nextWake = Infinity;
      let didWork = false;

      for (const device of [...this.devices.values()]) {
        if (!this.running) break;
        if (!device.polling || device.state === "dead" || !this.port.isOpen) continue;

        if (device.streaming) {
          if (!device.started) {
            device.started = true;
            device.lastFrameAt = Date.now();
            try {
              // CSC `_run_continuous`: one read request starts continuous output.
              await this.port.write(device.codec.buildRequest("pressure"));
              this._setState(device, "starting");
            } catch (error) {
              this._transportError(device, "pressure", error);
            }
          }
          continue;
        }

        if (device.nextDue > now) {
          nextWake = Math.min(nextWake, device.nextDue);
          continue;
        }
        didWork = true;
        const cycleStart = Date.now();
        if (device.nextDue && cycleStart - device.nextDue > Math.max(3 * device.intervalMs, 2000)) {
          // Timers in a hidden tab are throttled (🟠 V15): record the gap instead of hiding it.
          this.emit("gap", { deviceId: device.id, fromMs: device.nextDue, toMs: cycleStart });
        }
        await this._pollDevice(device);
        this.cycleMs = Date.now() - cycleStart;
        this.emit("stats", { deviceId: device.id, cycleMs: this.cycleMs });
        device.nextDue = cycleStart + device.intervalMs;
        nextWake = Math.min(nextWake, device.nextDue);
      }

      if (!this.running) break;
      if (this.jobs.length) continue;
      if (!didWork) await this._sleep(Number.isFinite(nextWake) ? nextWake - Date.now() : 1000);
    }
  }

  /** @param {DeviceSession} device */
  async _pollDevice(device) {
    let cycleSawResponse = false;
    for (const command of device.commands.slice()) {
      if (!this.running || !device.polling) return;
      await this._drainJobs();
      let request;
      try {
        request = device.codec.buildRequest(command);
      } catch (error) {
        this.emit("error", deviceError(device.id, `Protocol error (${command}): ${/** @type {Error} */ (error).message}`, true));
        continue;
      }
      try {
        const { frame, sawResponse } = await this._transact(device, request, command);
        if (sawResponse) cycleSawResponse = true;
        const result = device.codec.parseResponse(frame ?? new Uint8Array(0), command);
        this._afterCommand(device, command, result);
        if (!result.success) {
          this.emit("error", deviceError(device.id, `Parse error (${command}): ${result.error}`, true));
          if (result.extra?.status) this.emit("info", { deviceId: device.id, command, status: result.extra.status, formatted: result.error });
          continue;
        }
        device.consecutiveErrors = 0;
        if (device.state !== "polling") this._setState(device, "polling");
        if (result.value == null || result.unit === "raw") {
          this.emit("info", { deviceId: device.id, command, formatted: result.formatted, extra: result.extra });
        } else {
          this._emitReading(device, command, result);
        }
      } catch (error) {
        if (!(await this._transportError(device, command, error))) return;
      }
    }

    // Loopback / silent-gauge detection (CSC `_LOOPBACK_CYCLES`).
    if (cycleSawResponse) device.silentCycles = 0;
    else {
      device.silentCycles += 1;
      if (device.silentCycles === LOOPBACK_CYCLES) {
        const message = "No reply from gauge — TX is echoing without response. Check cable pinout, power, and that no loopback plug is installed on this port.";
        this.emit("error", deviceError(device.id, message, false));
        this._setState(device, "dead", message);
        device.polling = false;
      }
    }
  }

  /**
   * @param {DeviceSession} device @param {string} command @param {any} error
   * @returns {Promise<boolean>} false when the link is declared dead
   */
  async _transportError(device, command, error) {
    device.consecutiveErrors += 1;
    const recoverable = device.consecutiveErrors < MAX_CONSECUTIVE_ERRORS;
    this.emit("error", deviceError(device.id, `Transport error (${command}): ${error?.message ?? error}`, recoverable));
    if (!recoverable) {
      this._setState(device, "dead", "Link lost after repeated transport errors");
      device.polling = false;
      return false;
    }
    await this._sleep(this.errorRetryDelayMs);
    return true;
  }
}
