// @ts-check
/**
 * Constants carried over from CustomSerialCommunicator unchanged
 * (WEB_PORT_PLAN.md, Appendix C). Change them only together with CSC.
 */

/** Probe timeout, CSC `_PROBE_TIMEOUT` (port_scanner.py). */
export const PROBE_TIMEOUT_MS = 600;
/** Passive listen before the first probe, so a CDG left streaming is seen without sending anything. */
export const PASSIVE_LISTEN_MS = 300;
/** Pause after a recoverable transport error, CSC `_ERROR_RETRY_DELAY` (acquisition.py). */
export const ERROR_RETRY_DELAY_MS = 2000;
/** Consecutive errors before the link is declared dead, CSC `_MAX_CONSECUTIVE_ERRORS`. */
export const MAX_CONSECUTIVE_ERRORS = 5;
/** Silent cycles before the loopback verdict, CSC `_LOOPBACK_CYCLES`. */
export const LOOPBACK_CYCLES = 5;
/** Default poll interval, CSC `GaugeWorker` default. */
export const DEFAULT_POLL_INTERVAL_MS = 100;
/** Minimum poll interval, CSC `set_poll_interval`. */
export const MIN_POLL_INTERVAL_MS = 10;
/** Response timeout for a polled transaction. CSC uses the transport timeout; 600 ms matches the probe. */
export const RESPONSE_TIMEOUT_MS = 600;

export const CDG_RATIO_MIN = -0.024;
export const CDG_RATIO_MAX = 1.024;
export const CDG_FATAL_MASK = 0x60;
export const CDG_FS_TOLERANCE = 0.05;

/** CDG full-scale options in mbar, CSC port_scanner.py `_infer_cdg_full_scale_mbar`. */
export const CDG_FULL_SCALE_OPTIONS_MBAR = Object.freeze([
  0.1, 0.13332, 0.25, 0.3333, 1.0, 1.3332, 2.0, 2.6664, 10.0, 13.332, 20.0, 26.664, 100.0, 133.32,
  200.0, 266.64, 500.0, 666.6, 1000.0, 1100.0, 1333.22
]);

/** Torr-native CDG type words, mapped to full scale in mbar (S7). */
export const CDG_TORR_NATIVE_TYPE_WORDS = Object.freeze({
  1: 1.3332,
  2: 2.6664,
  10: 13.332,
  20: 26.664,
  100: 133.32,
  200: 266.64,
  500: 666.6,
  1000: 1333.22
});

/** CDG sensor-type byte to model. One copy only (CSC keeps two). */
export const CDG_SENSOR_MODELS = Object.freeze({
  0x00: "CDG025D",
  0x01: "CDG045D",
  0x02: "CDG100D",
  0x03: "CDG160D",
  0x04: "CDG200D",
  0x0b: "HPG400"
});

export const PPG_BROADCAST_ADDRESS = 254;
export const SCAN_BASE_BAUD = 9600;
export const P3V02_BAUD = 115200;
/** PxG55x baud options, PID 227 (S16 🟠 V2). Factory 57600 is tried first. */
export const PXG_BAUD_RATES = Object.freeze([57600, 38400, 19200, 9600]);

/** Read buffer for Web Serial ports; the default 255 bytes is too small for a CDG stream (V15). */
export const SERIAL_BUFFER_SIZE = 4096;
