// @ts-check
/**
 * Session model (WEB_PORT_PLAN.md section 9), the web edition of CSC's session.py: model,
 * port and protocol settings for every real and simulated device, restored in one operation.
 * 🟠 V17: CSC's exact field set was not compared; this is the plan's proposed shape.
 */

export const SESSION_FORMAT = "gauge-serial-session";
export const SESSION_VERSION = 1;

/**
 * @typedef {Object} DeviceRecord
 * @property {string} id
 * @property {string} model
 * @property {string} family
 * @property {boolean} experimental
 * @property {boolean} simulated
 * @property {{ label: string, usbVendorId?: number, usbProductId?: number }} port
 * @property {{ baudRate: number, dataBits: number, parity: string, stopBits: number, rsMode: "RS232" | "RS485" }} line
 * @property {number} address
 * @property {{ value: number, unit: string, origin: "user" | "scan" } | null} fullScale
 * @property {{ serial: string, firmware: string }} identity
 * @property {{ commands: string[], intervalMs: number }} poll
 * @property {string=} color
 * @property {Record<string, any>=} sim
 */

/**
 * @param {{ name: string, created?: string, devices: DeviceRecord[], layout?: any, app: { version: string, build: string }, notes?: string }} input
 */
export function makeSession(input) {
  return {
    format: SESSION_FORMAT,
    formatVersion: SESSION_VERSION,
    app: input.app,
    name: input.name,
    created: input.created ?? new Date().toISOString(),
    saved: new Date().toISOString(),
    devices: input.devices.filter((d) => !d.simulated),
    simulated: input.devices.filter((d) => d.simulated),
    layout: input.layout ?? { combined: "overlay", hidden: [], colors: {} },
    notes: input.notes ?? ""
  };
}

/**
 * Validate and normalise a session read from JSON. Throws with a readable message.
 * @param {any} json
 */
export function parseSession(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  if (!data || typeof data !== "object") throw new Error("Not a session file.");
  if (data.format && data.format !== SESSION_FORMAT) throw new Error(`Unknown session format "${data.format}".`);
  const devices = [...(data.devices ?? []), ...(data.simulated ?? [])];
  for (const d of devices) {
    if (!d.model || !d.id) throw new Error("A device in the session has no model or id.");
    d.simulated = Boolean(d.simulated) || (data.simulated ?? []).includes(d);
    d.poll = { commands: d.poll?.commands ?? ["pressure"], intervalMs: Number(d.poll?.intervalMs ?? 100) };
    d.line = { baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1, rsMode: "RS232", ...(d.line ?? {}) };
    d.address = Number(d.address ?? 0);
    d.identity = { serial: "", firmware: "", ...(d.identity ?? {}) };
    if (d.fullScale && !(Number(d.fullScale.value) > 0)) d.fullScale = null;
  }
  return {
    name: String(data.name ?? "Imported session"),
    created: data.created ?? new Date().toISOString(),
    app: data.app ?? null,
    devices,
    layout: { combined: "overlay", hidden: [], colors: {}, ...(data.layout ?? {}) },
    notes: String(data.notes ?? ""),
    samples: data.samples ?? null,
    traffic: data.traffic ?? null
  };
}
