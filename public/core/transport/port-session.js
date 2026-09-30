// @ts-check
/**
 * PortSession — wraps one granted Web Serial port.
 *
 * Emits: "data" (Uint8Array chunk), "traffic" ({ dir: "tx" | "rx", bytes, t }), "open",
 * "close", "error" (Error), "disconnect". The reader loop never awaits UI work; framing is
 * done by the scheduler that owns this session, so the session is protocol-agnostic.
 *
 * Web Serial facts relied on (WEB_PORT_PLAN.md section 3; 🟠 V15 where marked):
 * - line settings are fixed at open; changing baud means close and reopen (`reopen`);
 * - a read loop must always be running or bytes are lost once the buffer fills;
 * - the default 255-byte buffer is too small for a CDG stream 🟠, so 4096 is requested;
 * - on Windows a port is opened exclusively 🟠, so "busy" failures get a plain message.
 */
import { Emitter } from "../models.js";
import { SERIAL_BUFFER_SIZE } from "../constants.js";

let nextId = 1;

export class PortSession extends Emitter {
  /**
   * @param {any} port  a SerialPort from navigator.serial
   * @param {{ label?: string }} [options]
   */
  constructor(port, options = {}) {
    super();
    this.port = port;
    this.id = `port-${nextId++}`;
    this.kind = "serial";
    this.label = options.label ?? describePort(port);
    /** @type {import("./emulated-port.js").LineSettings | null} */
    this.settings = null;
    this.isOpen = false;
    /** @type {any} */
    this._reader = null;
    /** @type {Promise<void> | null} */
    this._readLoop = null;
    this._closing = false;
    const info = typeof port?.getInfo === "function" ? port.getInfo() : {};
    this.info = { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId };
  }

  /** @param {import("./emulated-port.js").LineSettings} settings */
  async open(settings) {
    if (this.isOpen) throw new Error("Port is already open.");
    const full = { dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: SERIAL_BUFFER_SIZE, ...settings };
    try {
      await this.port.open(full);
    } catch (error) {
      throw new Error(explainOpenError(error, full.baudRate));
    }
    this.settings = full;
    this.isOpen = true;
    this._closing = false;
    this._readLoop = this._runReader();
    this.emit("open", full);
  }

  async _runReader() {
    while (this.isOpen && this.port.readable && !this._closing) {
      const reader = this.port.readable.getReader();
      this._reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) {
            this.emit("traffic", { dir: "rx", bytes: value, t: Date.now() });
            this.emit("data", value);
          }
        }
      } catch (error) {
        // A framing, parity or buffer-overrun error ends this reader; the stream is usable again.
        if (!this._closing) this.emit("error", /** @type {Error} */ (error));
      } finally {
        try {
          reader.releaseLock();
        } catch {}
        this._reader = null;
      }
    }
  }

  /** @param {Uint8Array} bytes */
  async write(bytes) {
    if (!this.isOpen || !this.port.writable) throw new Error("Port is not open.");
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
    this.emit("traffic", { dir: "tx", bytes: Uint8Array.from(bytes), t: Date.now() });
  }

  async close() {
    if (!this.isOpen) return;
    this._closing = true;
    try {
      await this._reader?.cancel();
    } catch {}
    try {
      await this._readLoop;
    } catch {}
    try {
      await this.port.close();
    } catch {}
    this.isOpen = false;
    this.emit("close", null);
  }

  /** Drain, close and reopen the same granted port with new settings. @param {import("./emulated-port.js").LineSettings} settings */
  async reopen(settings) {
    await this.close();
    await this.open(settings);
  }

  /** @param {{ dataTerminalReady?: boolean, requestToSend?: boolean, break?: boolean }} signals */
  async setSignals(signals) {
    if (this.isOpen && typeof this.port.setSignals === "function") await this.port.setSignals(signals);
  }
}

/** @param {any} port */
export function describePort(port) {
  const info = typeof port?.getInfo === "function" ? port.getInfo() : {};
  if (info.usbVendorId != null) {
    const vid = info.usbVendorId.toString(16).padStart(4, "0").toUpperCase();
    const pid = (info.usbProductId ?? 0).toString(16).padStart(4, "0").toUpperCase();
    const vendor = KNOWN_VENDORS[/** @type {keyof typeof KNOWN_VENDORS} */ (info.usbVendorId)];
    return `${vendor ? `${vendor} ` : ""}USB ${vid}:${pid}`;
  }
  return "Serial port";
}

const KNOWN_VENDORS = { 0x0403: "FTDI", 0x067b: "Prolific", 0x10c4: "Silicon Labs", 0x1a86: "WCH", 0x2341: "Arduino", 0x0557: "ATEN", 0x110a: "Moxa" };

/** @param {any} error @param {number} baud */
function explainOpenError(error, baud) {
  const message = String(error?.message ?? error);
  if (/already open|in use|access denied|failed to open/i.test(message)) {
    return "Port busy: another program (the desktop CSC, a terminal, or another browser tab) has this port open. Close it and try again.";
  }
  if (/baud/i.test(message)) return `The adapter rejected ${baud} baud.`;
  return `Could not open the port: ${message}`;
}
