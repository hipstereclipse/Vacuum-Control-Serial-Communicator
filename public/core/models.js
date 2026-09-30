// @ts-check
/**
 * Event model and codec contract, a direct translation of CSC's models.py and
 * protocols/base.py. Nothing in the acquisition path throws past these types:
 * a failure is a Reading with success=false or a DeviceError.
 */

/**
 * @typedef {Object} Reading            mirrors CSC GaugeReading
 * @property {boolean} success
 * @property {number=} value
 * @property {string=} unit
 * @property {string=} formatted
 * @property {Uint8Array} raw
 * @property {Record<string, any>=} extra  warnings, status bytes, sensor code, etc.
 * @property {string=} error
 *
 * @typedef {Object} Framer
 * @property {(chunk: Uint8Array) => Uint8Array[]} push   returns complete frames
 * @property {() => void} reset
 * @property {() => number} pending                        bytes held waiting for more
 *
 * @typedef {Object} CommandInfo
 * @property {string} name
 * @property {boolean} read
 * @property {boolean} write
 * @property {string=} unit
 * @property {string=} description
 * @property {"safe" | "caution" | "danger"} risk
 * @property {string=} source
 * @property {string=} valueHint
 *
 * @typedef {Object} Codec
 * @property {string} protocol
 * @property {number} address
 * @property {() => Framer} framer
 * @property {(command: string, value?: any) => Uint8Array} buildRequest
 * @property {(frame: Uint8Array, command: string) => Reading} parseResponse
 * @property {() => boolean} supportsContinuousOutput
 * @property {((frame: Uint8Array) => Reading)=} parseContinuous
 * @property {((frame: Uint8Array, command: string) => boolean)=} matchesResponse  needed on streaming lines
 * @property {(() => CommandInfo[])=} commands
 * @property {((frame: Uint8Array) => { ok: boolean, detail: string })=} validateFrame  used by the terminal to flag bad frames before sending
 */

/**
 * @param {number} value
 * @param {string} unit
 * @param {string} formatted
 * @param {Uint8Array} [raw]
 * @param {Record<string, any>} [extra]
 * @returns {Reading}
 */
export function ok(value, unit, formatted, raw = new Uint8Array(0), extra = {}) {
  return { success: true, value, unit, formatted, raw, extra };
}

/**
 * A successful reading that carries text rather than a number (firmware, serial number, ACK).
 * @param {string} formatted
 * @param {Uint8Array} [raw]
 * @param {Record<string, any>} [extra]
 * @returns {Reading}
 */
export function info(formatted, raw = new Uint8Array(0), extra = {}) {
  return { success: true, formatted, raw, extra };
}

/**
 * @param {string} message
 * @param {Uint8Array} [raw]
 * @param {Record<string, any>} [extra]
 * @returns {Reading}
 */
export function err(message, raw = new Uint8Array(0), extra = {}) {
  return { success: false, error: message, raw, extra };
}

/** Monotonic and wall-clock timestamps, CSC `timestamp_mono` / `timestamp_wall`. */
export function stamp() {
  const perf = globalThis.performance;
  const mono = perf ? perf.timeOrigin + perf.now() : Date.now();
  return { mono, wall: new Date().toISOString() };
}

/**
 * @typedef {Object} DeviceReading
 * @property {string} deviceId
 * @property {number} mono
 * @property {string} wall
 * @property {number} value
 * @property {string} unit
 * @property {string} command
 * @property {string[]} warnings
 * @property {Uint8Array} raw
 *
 * @typedef {Object} DeviceError
 * @property {string} deviceId
 * @property {number} mono
 * @property {string} wall
 * @property {string} message
 * @property {boolean} recoverable   false → the link is dead; true → log and retry
 *
 * @typedef {Object} TerminalEntry
 * @property {Uint8Array} request
 * @property {Uint8Array} response
 * @property {string} wall
 * @property {string} command         empty for raw custom frames
 * @property {string=} formatted
 * @property {string=} error
 * @property {boolean=} autoPoll
 */

/**
 * @param {string} deviceId
 * @param {string} message
 * @param {boolean} recoverable
 * @returns {DeviceError}
 */
export function deviceError(deviceId, message, recoverable = true) {
  const { mono, wall } = stamp();
  return { deviceId, mono, wall, message, recoverable };
}

/**
 * A tiny event emitter; EventTarget would do, but this also works in older Node test runs
 * and keeps listeners' exceptions from breaking the reader loop.
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /** @param {string} type @param {Function} listener @returns {() => void} */
  on(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)?.add(listener);
    return () => this._listeners.get(type)?.delete(listener);
  }

  /** @param {string} type @param {any} payload */
  emit(type, payload) {
    for (const listener of this._listeners.get(type) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`Listener for "${type}" failed`, error);
      }
    }
  }
}
