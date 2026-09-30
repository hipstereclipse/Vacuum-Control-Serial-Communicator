// @ts-check
/**
 * Pfeiffer TC600 electronic drive unit: parameter table, error texts and the protocol side
 * of the turbo poll loop. Port of CSC src/serial_comm/turbos/tc600_protocol.py and the
 * non-Qt logic of turbos/turbo_worker.py (cycle order, latest-write-wins, error counting),
 * plus the status interpretation in GUI/turbo_workspace/turbo_window.py.
 *
 * The wire format is Pfeiffer ASCII (codecs/pfeiffer-ascii.js, PM 800 547 BE for the
 * parameter numbers). Every command that moves the rotor, vents or changes the link is
 * flagged `danger: true`; the UI must get an explicit confirmation before sending it
 * (plan section 11, CSC guide section 5).
 */
import { createPfeifferAsciiCodec } from "../codecs/pfeiffer-ascii.js";

/** Pause after a recoverable transport error, CSC turbo_worker.py `_ERROR_RETRY_DELAY` (3 s, not the gauge 2 s). */
export const TURBO_ERROR_RETRY_DELAY_MS = 3000;
/** Consecutive transport errors before the link is dead, turbo_worker.py `_MAX_CONSECUTIVE_ERRORS`. */
export const TURBO_MAX_CONSECUTIVE_ERRORS = 5;
/** Default cycle, turbo_worker.py `poll_interval`. */
export const TURBO_DEFAULT_POLL_INTERVAL_MS = 1000;
/** Speed bar full scale, turbo_window.py `_MAX_SPEED_HZ`. */
export const TC600_MAX_SPEED_HZ = 1500;
/** Commands read every cycle, turbo_worker.py `_DEFAULT_POLL_COMMANDS`. */
export const TC600_DEFAULT_POLL_COMMANDS = Object.freeze(["pump_on", "actual_speed_hz", "motor_current_A", "motor_power_W", "error_code"]);

/**
 * @typedef {Object} Tc600Command
 * @property {number} pid
 * @property {string} data_type
 * @property {boolean} read
 * @property {boolean} write
 * @property {string} unit
 * @property {boolean} danger       actuating: needs an explicit confirmation before a write
 * @property {"safe" | "caution" | "danger"} risk
 * @property {string} description
 * @property {{ value: number, label: string }[]=} options
 */

/** @param {number} pid @param {string} type @param {boolean} read @param {boolean} write @param {string} unit @param {"safe" | "caution" | "danger"} risk @param {string} description @param {any} [options] */
const p = (pid, type, read, write, unit, risk, description, options) =>
  Object.freeze({ pid, data_type: type, read, write, unit, danger: risk === "danger", risk: write ? risk : "safe", description, ...(options ? { options } : {}) });

/**
 * CSC `_TC600_PARAMS` (PM 800 547 BE). Risk classes are this port's proposal.
 * @type {Readonly<Record<string, Tc600Command>>}
 */
export const TC600_COMMANDS = Object.freeze({
  standby: p(2, "boolean_old", true, true, "", "danger", "Standby mode on/off (changes rotor speed)"),
  error_ack: p(9, "boolean_old", false, true, "", "danger", "Acknowledge active error (the pump may restart if the pumping station is on)"),
  pump_on: p(10, "boolean_old", true, true, "", "danger", "Pumping station on/off"),
  vent_enable: p(12, "boolean_old", true, true, "", "danger", "Venting enable on/off"),
  motor_on: p(23, "boolean_old", true, true, "", "danger", "Turbopump motor on/off"),
  op_mode: p(26, "u_short_int", true, true, "", "danger", "TMP operating mode", [{ value: 0, label: "Final speed" }, { value: 1, label: "Speed setting" }]),
  vent_mode: p(30, "u_short_int", true, true, "", "danger", "Venting mode", [{ value: 0, label: "Automatic" }, { value: 1, label: "No venting" }, { value: 2, label: "Venting ON" }]),
  error_code: p(303, "string", true, false, "", "safe", "Current error/warning code"),
  set_speed_hz: p(308, "u_integer", true, false, "Hz", "safe", "Set rotation speed"),
  actual_speed_hz: p(309, "u_integer", true, false, "Hz", "safe", "Actual rotation speed"),
  motor_current_A: p(310, "u_real", true, false, "A", "safe", "Motor current"),
  op_hours_TMP: p(311, "u_integer", true, false, "h", "safe", "Turbopump operating hours"),
  firmware: p(312, "string", true, false, "", "safe", "Drive unit firmware version"),
  final_speed_hz: p(315, "u_integer", true, false, "Hz", "safe", "Nominal final rotation speed"),
  motor_power_W: p(316, "u_integer", true, false, "W", "safe", "Motor power consumption"),
  runup_time_min: p(700, "u_integer", true, true, "min", "caution", "Maximum run-up time"),
  speed_setpoint_pct: p(707, "u_real", true, true, "%", "danger", "Speed set value in speed-setting mode"),
  standby_speed_pct: p(717, "u_integer", true, true, "%", "danger", "Standby rotation speed set value"),
  vent_freq_pct: p(720, "u_integer", true, true, "%", "caution", "Venting frequency (% of final speed)"),
  vent_time_s: p(721, "u_integer", true, true, "s", "caution", "Venting duration"),
  rs485_address: p(797, "u_integer", true, true, "", "danger", "RS-485 unit address (a write drops the link)"),
  // 🟠 The four entries below are in CSC's table but missing from device_specs/turbos/tc600.yaml,
  // although tc600_protocol.py says "Keep in sync with device_specs/turbos/tc600.yaml".
  bearing_temp_C: p(342, "u_short_int", true, false, "°C", "safe", "Bearing temperature"),
  motor_temp_C: p(346, "u_short_int", true, false, "°C", "safe", "Motor temperature"),
  electronics_temp_C: p(347, "u_short_int", true, false, "°C", "safe", "Electronics temperature"),
  warning_code: p(302, "string", true, false, "", "safe", "Current warning code")
});

/** Names of the commands that need an explicit confirmation. */
export const TC600_DANGER_COMMANDS = Object.freeze(Object.keys(TC600_COMMANDS).filter((k) => TC600_COMMANDS[k].danger));

/** DCU error and warning texts (CSC `ERROR_DESCRIPTIONS`). */
export const TC600_ERROR_DESCRIPTIONS = Object.freeze({
  "no Err": "No error",
  Err001: "TMP excess rotation speed",
  Err002: "Power pack unit error",
  Err006: "Start-up time error — check run-up time, fore-vacuum pressure, leaks",
  Err007: "Operating fluid deficiency (TC600 only)",
  Err008: "Connection between TC and pump",
  Err015: "Error in TC controller — power-cycle with pump at standstill",
  Err021: "Incorrect pump identification resistance",
  Err025: "Error in temperature monitoring TC",
  Err026: "Error of temperature sensor inside TC",
  Err037: "Error in motor stages or control",
  Err040: "Hardware error: external RAM defective",
  Err042: "Hardware error: EPROM checksum",
  Err043: "Hardware error: E2PROM erratum",
  Err090: "Insufficient RAM",
  Err144: "Heating type changed",
  Err698: "TC does not respond — check DCU↔TC connection",
  Err913: "Error during self-test or start-up",
  Wrn011: "TMS heating start-up time elapsed",
  Wrn022: "TMS limit temperature (TMP > 100°C)",
  Wrn033: "TMS heating circuit temperature sensor fault",
  Wrn007: "Mains power failure",
  Wrn039: "Protective conductor warning — DANGER: disconnect immediately",
  Wrn110: "Pressure gauge defective",
  Wrn777: "Pump nominal speed not set — set P777 (PumpRotMax)"
});

/** CSC `describe_error`. @param {string} code */
export function describeTc600Error(code) {
  const c = String(code ?? "").trim();
  return TC600_ERROR_DESCRIPTIONS[/** @type {keyof typeof TC600_ERROR_DESCRIPTIONS} */ (c)] ?? `Unknown code: ${c}`;
}

/** @param {string} command */
export function isTc600Danger(command) {
  return Boolean(TC600_COMMANDS[command]?.danger);
}

/**
 * Throws unless a danger write carries an explicit confirmation (plan section 11).
 * @param {string} command @param {{ confirmed?: boolean }} [opts]
 */
export function assertTc600WriteAllowed(command, { confirmed = false } = {}) {
  const cmd = TC600_COMMANDS[command];
  if (!cmd) throw new Error(`TC600: unknown command '${command}'`);
  if (!cmd.write) throw new Error(`Command '${command}' (PID ${cmd.pid}) is read-only`);
  if (cmd.danger && !confirmed) throw new Error(`TC600: '${command}' actuates the pump and needs explicit confirmation`);
}

/**
 * The TC600 codec: a Pfeiffer ASCII codec with the TC600 table preloaded (CSC `TC600Protocol`).
 * Like CSC it ignores the YAML command list; the YAML is checked against the table in the tests.
 * @param {{ address?: number }} [options]
 */
export function createTc600Codec(options = {}) {
  const spec = { model: "TC600", protocol: "pfeiffer_ascii", transport: { default_address: 1 }, commands: TC600_COMMANDS };
  const codec = createPfeifferAsciiCodec(spec, { address: options.address ?? 1 });
  return Object.assign(codec, {
    describeError: describeTc600Error,
    allCommands: Object.keys(TC600_COMMANDS),
    readableCommands: Object.keys(TC600_COMMANDS).filter((k) => TC600_COMMANDS[k].read),
    writableCommands: Object.keys(TC600_COMMANDS).filter((k) => TC600_COMMANDS[k].write),
    /**
     * A write gated on confirmation for danger commands.
     * @param {string} command @param {any} value @param {{ confirmed?: boolean }} [opts]
     */
    buildWrite(command, value, opts = {}) {
      assertTc600WriteAllowed(command, opts);
      return codec.buildRequest(command, value);
    }
  });
}

/**
 * Dashboard reading of one status snapshot (turbo_window.py `_on_status`).
 * @param {Record<string, import("../models.js").Reading>} readings
 */
export function summarizeTc600Status(readings) {
  const speed = readings.actual_speed_hz;
  const pump = readings.pump_on;
  const errorReading = readings.error_code;
  const warning = readings.warning_code;
  const errorCode = errorReading?.success ? String(errorReading.formatted ?? "").trim() : null;
  const warningCode = warning?.success ? String(warning.formatted ?? "").trim() : null;
  const speedHz = speed?.success ? Math.trunc(speed.value ?? 0) : null;
  return {
    speedHz,
    speedFraction: speedHz == null ? null : Math.max(0, Math.min(1, speedHz / TC600_MAX_SPEED_HZ)),
    pumpOn: pump?.success ? pump.value === 1 : null,
    errorCode,
    // CSC shows the raw code when no text is known, and red unless it starts with "no".
    errorDescription: errorCode == null ? null : TC600_ERROR_DESCRIPTIONS[/** @type {keyof typeof TC600_ERROR_DESCRIPTIONS} */ (errorCode)] ?? errorCode,
    errorActive: errorCode != null && !errorCode.startsWith("no"),
    warningCode,
    warningActive: warningCode != null && !warningCode.startsWith("no")
  };
}

/**
 * The protocol half of CSC's TurboWorker, without threads: a queue of one pending write
 * (latest wins), one-shot reads and the cyclic poll list, and the transport-error counter.
 *
 * `runCycle(transact)` performs one CSC loop iteration. `transact(request)` writes the bytes
 * and resolves with the next response frame, or rejects on a transport error.
 */
export class Tc600Poller {
  /** @param {{ codec?: ReturnType<typeof createTc600Codec>, pollCommands?: readonly string[], pollIntervalMs?: number }} [opts] */
  constructor(opts = {}) {
    this.codec = opts.codec ?? createTc600Codec();
    this.pollCommands = [...(opts.pollCommands ?? TC600_DEFAULT_POLL_COMMANDS)];
    this.pollIntervalMs = opts.pollIntervalMs ?? TURBO_DEFAULT_POLL_INTERVAL_MS;
    /** @type {{ command: string, value: any } | null} */
    this.pendingWrite = null;
    /** @type {Set<string>} */
    this.pendingReads = new Set();
    this.consecutiveErrors = 0;
  }

  /** Queue a one-shot read for the next cycle (CSC `request_read`). @param {string} command */
  requestRead(command) {
    this.pendingReads.add(command);
  }

  /** Replace the cyclic poll list; [] pauses cyclic reading (CSC `set_poll_commands`). @param {string[]} commands */
  setPollCommands(commands) {
    this.pollCommands = [...commands];
  }

  /**
   * Queue a write for the next cycle; latest wins, as in CSC `send_command` (rapid Start then Stop
   * sends only Stop). Danger commands need `confirmed: true`.
   * @param {string} command @param {any} value @param {{ confirmed?: boolean }} [opts]
   */
  sendCommand(command, value, opts = {}) {
    assertTc600WriteAllowed(command, opts);
    this.pendingWrite = { command, value };
  }

  /** Take the work for one cycle and clear the queues. */
  takeCycle() {
    const work = { write: this.pendingWrite, reads: [...this.pendingReads], polls: [...this.pollCommands] };
    this.pendingWrite = null;
    this.pendingReads.clear();
    return work;
  }

  /**
   * One loop iteration of CSC `_run_loop`: the pending write first (its reply, the TC600's echo,
   * is read and discarded), then one-shot reads, then the poll list. A transport error during
   * polling counts towards the fatal limit and ends the cycle.
   * @param {(request: Uint8Array) => Promise<Uint8Array>} transact
   */
  async runCycle(transact) {
    const work = this.takeCycle();
    /** @type {Record<string, import("../models.js").Reading>} */
    const readings = {};
    /** @type {{ message: string, recoverable: boolean }[]} */
    const errors = [];
    /** @type {string[]} */
    const terminal = [];
    let fatal = false;
    let retryDelayMs = 0;

    if (work.write) {
      const { command, value } = work.write;
      try {
        await transact(this.codec.buildRequest(command, value));
        terminal.push(`SET ${command} = ${value}`);
      } catch (e) {
        errors.push({ message: `Write failed (${command}): ${/** @type {Error} */ (e).message}`, recoverable: true });
      }
    }

    for (const command of work.reads) {
      try {
        const raw = await transact(this.codec.buildRequest(command));
        readings[command] = this.codec.parseResponse(raw, command);
        terminal.push(`READ ${command}`);
      } catch {
        // CSC logs one-shot failures at debug level only.
      }
    }

    for (const command of work.polls) {
      let request;
      try {
        request = this.codec.buildRequest(command);
      } catch (e) {
        // 🟠 CSC catches only TransportError here, so an unknown poll command raises out of
        // the worker thread; reported as a recoverable error instead.
        errors.push({ message: `Poll command '${command}': ${/** @type {Error} */ (e).message}`, recoverable: true });
        continue;
      }
      try {
        const raw = await transact(request);
        readings[command] = this.codec.parseResponse(raw, command);
        this.consecutiveErrors = 0;
      } catch (e) {
        this.consecutiveErrors += 1;
        const recoverable = this.consecutiveErrors < TURBO_MAX_CONSECUTIVE_ERRORS;
        errors.push({ message: `Transport error (${command}): ${/** @type {Error} */ (e).message}`, recoverable });
        if (!recoverable) fatal = true;
        else retryDelayMs = TURBO_ERROR_RETRY_DELAY_MS;
        break;
      }
    }

    return { readings, errors, terminal, fatal, retryDelayMs, hasStatus: Object.keys(readings).length > 0 };
  }
}
