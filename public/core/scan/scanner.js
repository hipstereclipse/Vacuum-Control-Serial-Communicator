// @ts-check
/**
 * Scan and identification engine (WEB_PORT_PLAN.md section 6). Keeps CSC's rule that probes
 * are active and structured, and the VGC tool's rule that automatic probing sends read-only
 * commands and an identity needs the active probe plus a model-specific signature.
 *
 * Works on any port with the PortSession interface (open, close, reopen, write, on("data")),
 * so the same code scans granted Web Serial ports and emulated ports.
 */
import { equalBytes, text } from "../bytes.js";
import { PASSIVE_LISTEN_MS, PPG_BROADCAST_ADDRESS, PROBE_TIMEOUT_MS } from "../constants.js";
import { identifyCdg, isCdgFrame, RESPONSE_LENGTH, RESPONSE_SYNC } from "../codecs/cdg-serial.js";
import { pxgFields, pxgFramer, CMD_READ_RESPONSE, ERROR_PID, decodeValue } from "../codecs/inficon-binary.js";
import { syncFixedFramer } from "../framers/sync-fixed.js";
import { terminatorFramer } from "../framers/terminator.js";
import {
  CDG_PRESSURE_READ,
  CDG_TYPE_READ,
  PFA_FW,
  PFA_HW,
  PPG_FV,
  PPG_PR1,
  PPG_PR3,
  PPG_SN,
  PXG_PID_FIRMWARE,
  PXG_PID_PRESSURE,
  PXG_PID_PRODUCT,
  PXG_PID_SERIAL,
  pfaData,
  pfaModelHint,
  pfaRead,
  pfaValidResponse,
  ppgData,
  ppgIsAck,
  ppgRead,
  probePlan,
  pxgRead
} from "./probe-plans.js";

/**
 * @typedef {Object} ScanResult
 * @property {string} family
 * @property {string} model          best model match in the registry ("" when unclassified)
 * @property {string} modelHint      what the scan saw, e.g. "INFICON CDG045D"
 * @property {number} baudRate
 * @property {"RS232" | "RS485"} rsMode
 * @property {number} address
 * @property {string=} firmware
 * @property {string=} serial
 * @property {string=} pressure       snapshot, as text
 * @property {number | null=} fullScaleMbar
 * @property {boolean=} fullScaleConfident
 * @property {boolean=} streaming
 * @property {string} description
 * @property {Record<string, any>} meta
 */

const cdgFramer = () => syncFixedFramer({ sync: RESPONSE_SYNC, length: RESPONSE_LENGTH, validate: isCdgFrame });
const ppgFramer = () => terminatorFramer({ terminator: 0x5c, maxLength: 128 });
const pfaFramer = () => terminatorFramer({ terminator: 0x0d, maxLength: 128 });

class EchoOnly extends Error {}

/** Collects frames from a port through a probe-specific framer. */
class Line {
  /** @param {any} port */
  constructor(port) {
    this.port = port;
    /** @type {((chunk: Uint8Array) => void) | null} */
    this.sink = null;
    this.unsub = port.on("data", (/** @type {Uint8Array} */ chunk) => this.sink?.(chunk));
    /** Every write the scan made, for the read-only assertion in tests. @type {Uint8Array[]} */
    this.writes = [];
  }

  dispose() {
    this.unsub();
  }

  /** Listen without sending. @param {() => any} makeFramer @param {number} ms */
  listen(makeFramer, ms) {
    const framer = makeFramer();
    /** @type {Uint8Array[]} */
    const frames = [];
    this.sink = (chunk) => frames.push(...framer.push(chunk));
    return new Promise((resolve) => setTimeout(() => {
      this.sink = null;
      resolve(frames);
    }, ms));
  }

  /**
   * Write a read request and return the first frame that is not an echo of it and that
   * `accept` approves. Throws EchoOnly when the only thing that came back was our own bytes.
   * @param {Uint8Array} request
   * @param {() => any} makeFramer
   * @param {{ accept?: (frame: Uint8Array) => boolean, timeoutMs?: number }} [options]
   * @returns {Promise<Uint8Array | null>}
   */
  async ask(request, makeFramer, options = {}) {
    const framer = makeFramer();
    const accept = options.accept ?? (() => true);
    let echoed = false;
    let otherBytes = 0;
    const result = new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), options.timeoutMs ?? PROBE_TIMEOUT_MS);
      /** @param {Uint8Array | null} frame */
      const finish = (frame) => {
        clearTimeout(timer);
        this.sink = null;
        resolve(frame);
      };
      this.sink = (chunk) => {
        for (const frame of framer.push(chunk)) {
          if (equalBytes(frame, request)) {
            echoed = true;
            continue;
          }
          otherBytes += frame.length;
          if (accept(frame)) return finish(frame);
        }
        if (!equalBytes(chunk, request)) otherBytes += chunk.length;
      };
    });
    this.writes.push(Uint8Array.from(request));
    await this.port.write(request);
    const frame = /** @type {Uint8Array | null} */ (await result);
    // CSC: echo but no response on the first probe → likely loopback or no gauge; stop probing.
    if (!frame && echoed && otherBytes === 0) throw new EchoOnly("echo but no response — likely loopback or no gauge");
    return frame;
  }
}

/**
 * Probe one port. Stops at the first verified identity.
 * @param {any} port
 * @param {{
 *   mode?: "quick" | "thorough",
 *   rsMode?: "RS232" | "RS485",
 *   onStatus?: (message: string) => void,
 *   signal?: AbortSignal,
 *   registry?: import("../registry/registry.js").Registry,
 * }} [options]
 * @returns {Promise<{ results: ScanResult[], writes: Uint8Array[], verdict: string }>}
 */
export async function scanPort(port, options = {}) {
  const mode = options.mode ?? "quick";
  const rsMode = options.rsMode ?? "RS232";
  const status = options.onStatus ?? (() => {});
  const line = new Line(port);
  /** @type {ScanResult[]} */
  const results = [];
  let verdict = "no gauge answered";
  let currentBaud = 0;

  /** @param {number} baudRate */
  async function atBaud(baudRate) {
    if (currentBaud === baudRate && port.isOpen) return;
    if (port.isOpen) await port.reopen({ baudRate });
    else await port.open({ baudRate });
    currentBaud = baudRate;
  }

  try {
    for (const step of probePlan(mode)) {
      if (options.signal?.aborted) {
        verdict = "scan cancelled";
        break;
      }
      status(step.label);
      await atBaud(step.baudRate);
      const found = await runStep(step.step, line, { baudRate: step.baudRate, rsMode, registry: options.registry });
      if (found) {
        results.push(found);
        verdict = `found ${found.modelHint}`;
        break;
      }
    }
  } catch (error) {
    if (error instanceof EchoOnly) {
      verdict = error.message;
      status(verdict);
    } else {
      verdict = `port error: ${/** @type {Error} */ (error).message}`;
      status(verdict);
    }
  } finally {
    line.dispose();
    try {
      await port.close();
    } catch {}
  }
  return { results, writes: line.writes, verdict };
}

/**
 * @param {string} step
 * @param {Line} line
 * @param {{ baudRate: number, rsMode: "RS232" | "RS485", registry?: import("../registry/registry.js").Registry }} ctx
 * @returns {Promise<ScanResult | null>}
 */
async function runStep(step, line, ctx) {
  switch (step) {
    case "listen": {
      const frames = await line.listen(cdgFramer, PASSIVE_LISTEN_MS);
      if (!frames.length) return null;
      const typeFrame = await line.ask(CDG_TYPE_READ, cdgFramer, { accept: (f) => f[6] === 0x3b });
      return cdgResult(frames[0], typeFrame, ctx, true);
    }
    case "ppg": {
      const fv = await line.ask(PPG_FV, ppgFramer);
      if (!fv || !ppgIsAck(fv)) return null;
      return identifyPpg(line, fv, ctx);
    }
    case "pfeiffer": {
      const fw = await line.ask(PFA_FW, pfaFramer);
      if (!fw || !pfaValidResponse(fw)) return null;
      const firmware = pfaData(fw).trim();
      const hwFrame = await line.ask(PFA_HW, pfaFramer);
      const hardware = hwFrame && pfaValidResponse(hwFrame) ? pfaData(hwFrame).trim() : "";
      let hint = pfaModelHint(firmware);
      if (!hint && /^\d{6}$/.test(firmware)) {
        // On a TC600, parameter 309 is the rotor speed, not a name, so CSC can never hint a
        // turbo from it. Parameter 349 is the drive's electronics name (🟠 check PM 800 547 BE).
        const nameFrame = await line.ask(pfaRead(349), pfaFramer);
        const name = nameFrame && pfaValidResponse(nameFrame) ? pfaData(nameFrame).trim() : "";
        if (/TC\s?600/i.test(name)) hint = "TC600";
      }
      return {
        family: "pfeiffer_ascii",
        model: registryModel(ctx.registry, hint),
        modelHint: hint ? (hint === "TC600" ? "TC600 (Turbo)" : `INFICON ${hint}`) : firmware ? `INFICON gauge (${firmware.slice(0, 6).trim()})` : "Unknown Pfeiffer ASCII",
        baudRate: ctx.baudRate,
        rsMode: ctx.rsMode,
        address: 1,
        firmware,
        description: [firmware && `FW: ${firmware}`, hardware && `HW: ${hardware}`].filter(Boolean).join("  |  ") || "Pfeiffer device",
        meta: { hardware, turbo: hint === "TC600" }
      };
    }
    case "cdg": {
      const frame = await line.ask(CDG_PRESSURE_READ, cdgFramer);
      if (!frame) return null;
      const typeFrame = await line.ask(CDG_TYPE_READ, cdgFramer, { accept: (f) => f[6] === 0x3b });
      return cdgResult(frame, typeFrame, ctx, false);
    }
    case "pxg":
      return probePxg(line, 0, ctx);
    case "p3v02":
      return probeP3(line, ctx);
    default:
      return null;
  }
}

/**
 * @param {Uint8Array} frame @param {Uint8Array | null} typeFrame
 * @param {{ baudRate: number, rsMode: "RS232" | "RS485", registry?: any }} ctx @param {boolean} streaming
 * @returns {ScanResult}
 */
function cdgResult(frame, typeFrame, ctx, streaming) {
  const id = identifyCdg(frame, typeFrame);
  const parts = [`ratio ${id.rawRatio >= 0 ? "+" : ""}${id.rawRatio.toFixed(3)}`, `code 0x${id.sensorCode.toString(16).toUpperCase().padStart(2, "0")}`];
  if (id.fullScaleMbar != null) parts.push(`FS≈${id.fullScaleMbar} mbar`);
  if (id.typeWord != null) parts.push(`type=0x${id.typeWord.toString(16).toUpperCase().padStart(4, "0")}`);
  if (streaming) parts.push("was already streaming");
  return {
    family: "cdg_serial",
    model: id.model && registryModel(ctx.registry, id.model) ? id.model : "",
    modelHint: id.model ? `INFICON ${id.model}` : "INFICON CDG (unclassified)",
    baudRate: ctx.baudRate,
    rsMode: "RS232",
    address: 0,
    fullScaleMbar: id.fullScaleMbar,
    fullScaleConfident: id.fullScaleMbar != null,
    streaming,
    description: parts.join("  |  "),
    meta: { sensorCode: id.sensorCode, typeWord: id.typeWord, rawRatio: id.rawRatio }
  };
}

/** @param {Line} line @param {Uint8Array} fvFrame @param {{ baudRate: number, rsMode: "RS232" | "RS485", registry?: any }} ctx @param {number} [address] */
async function identifyPpg(line, fvFrame, ctx, address = PPG_BROADCAST_ADDRESS) {
  const firmware = ppgData(fvFrame);
  const ask = (/** @type {string} */ mnemonic, /** @type {Uint8Array} */ broadcast) =>
    line.ask(address === PPG_BROADCAST_ADDRESS ? broadcast : ppgRead(address, mnemonic), ppgFramer);
  const snFrame = await ask("SN", PPG_SN);
  const serial = snFrame && ppgIsAck(snFrame) ? ppgData(snFrame) : "";
  // PR1 (combined) is PPG570-only; the tool still offers one combined selection (S1, S7).
  let pressure = "";
  let pr1Acked = false;
  for (const [mnemonic, broadcast] of /** @type {[string, Uint8Array][]} */ ([["PR1", PPG_PR1], ["PR3", PPG_PR3]])) {
    const frame = await ask(mnemonic, broadcast);
    if (frame && ppgIsAck(frame)) {
      pr1Acked = mnemonic === "PR1";
      pressure = ppgData(frame);
      break;
    }
  }
  return {
    family: "ppg_ascii",
    model: registryModel(ctx.registry, "PPG570") ? "PPG570" : "",
    modelHint: "INFICON PPG550/570",
    baudRate: ctx.baudRate,
    rsMode: ctx.rsMode,
    address,
    firmware,
    serial,
    pressure: pressure ? `${pressure} mbar` : "",
    description: [firmware && `FW: ${firmware}`, serial && `SN: ${serial}`, pressure && `P: ${pressure} mbar`].filter(Boolean).join("  |  ") || "PPG gauge",
    meta: { pr1Acked, combined: true }
  };
}

/**
 * PxG55x probe: read PID 208 (product name), require PSG or PCG in it (🟠 V5), confirm with a
 * PID 221 read.
 * @param {Line} line @param {number} address @param {{ baudRate: number, rsMode: "RS232" | "RS485", registry?: any }} ctx
 * @returns {Promise<ScanResult | null>}
 */
async function probePxg(line, address, ctx) {
  const accept = (/** @type {number} */ pid) => (/** @type {Uint8Array} */ f) => {
    const fields = pxgFields(f);
    return fields.cmd === CMD_READ_RESPONSE && (fields.pid === pid || fields.pid === ERROR_PID) && (ctx.rsMode !== "RS485" || fields.address === address);
  };
  const productFrame = await line.ask(pxgRead(PXG_PID_PRODUCT, address), pxgFramer, { accept: accept(PXG_PID_PRODUCT) });
  if (!productFrame) return null;
  const fields = pxgFields(productFrame);
  if (fields.pid === ERROR_PID) return null;
  const product = decodeValue(fields.data, "string").text ?? "";
  const match = /P([SC])G\s?-?(\d{2,3})/i.exec(product);
  const pressureFrame = await line.ask(pxgRead(PXG_PID_PRESSURE, address), pxgFramer, { accept: accept(PXG_PID_PRESSURE) });
  if (!pressureFrame || pxgFields(pressureFrame).pid !== PXG_PID_PRESSURE) return null;
  const mbar = decodeValue(pxgFields(pressureFrame).data, "fixs32en20").value ?? NaN;
  const readString = async (/** @type {number} */ pid) => {
    const f = await line.ask(pxgRead(pid, address), pxgFramer, { accept: accept(pid) });
    return f && pxgFields(f).pid === pid ? decodeValue(pxgFields(f).data, "string").text ?? "" : "";
  };
  const serial = await readString(PXG_PID_SERIAL);
  const firmware = await readString(PXG_PID_FIRMWARE);
  let model = "";
  if (match) {
    const family = match[1].toUpperCase() === "S" ? "PSG" : "PCG";
    const candidate = `${family}${match[2].startsWith("55") ? "550" : match[2]}`;
    model = registryModel(ctx.registry, candidate) ? candidate : "";
  }
  return {
    family: "inficon_binary",
    model,
    modelHint: product ? `INFICON ${product}` : "INFICON binary gauge",
    baudRate: ctx.baudRate,
    rsMode: ctx.rsMode,
    address,
    firmware,
    serial,
    pressure: Number.isFinite(mbar) ? `${mbar.toExponential(3)} mbar` : "",
    description: [product && `Product: ${product}`, firmware && `FW: ${firmware}`, serial && `SN: ${serial}`, Number.isFinite(mbar) && `P: ${mbar.toExponential(3)} mbar`]
      .filter(Boolean)
      .join("  |  "),
    meta: { product, verified: Boolean(match) }
  };
}

/** @param {Line} line @param {{ baudRate: number, rsMode: "RS232" | "RS485", registry?: any }} ctx @returns {Promise<ScanResult | null>} */
async function probeP3(line, ctx) {
  const p3 = await import("../codecs/inficon-p3v02.js");
  const framer = p3.p3Framer ?? (() => p3.createP3V02Codec(null, {}).framer());
  const readText = async (/** @type {number} */ pid) => {
    const frame = await line.ask(p3.p3BuildFrame(p3.CMD_READ_REQ, pid), framer);
    if (!frame) return "";
    try {
      const parsed = p3.p3ParseFrame(frame);
      if (!parsed.crcOk || parsed.ack !== 1) return "";
      return text(parsed.data).split("\0", 1)[0].trim();
    } catch {
      return "";
    }
  };
  const product = await readText(10001);
  if (!product) return null;
  const manufacturer = await readText(10000);
  const serial = await readText(10002);
  const firmware = await readText(10004);
  return {
    family: "inficon_p3_v02",
    model: registryModel(ctx.registry, product) ? product.toUpperCase() : "",
    modelHint: `INFICON ${product}`,
    baudRate: ctx.baudRate,
    rsMode: ctx.rsMode,
    address: 0,
    firmware,
    serial,
    description: [firmware && `FW: ${firmware}`, serial && `SN: ${serial}`, manufacturer].filter(Boolean).join("  |  ") || `INFICON ${product}`,
    meta: { product, manufacturer }
  };
}

/**
 * RS485 address sweep: one read per candidate address with a short timeout. Only on ports
 * marked RS485, and only when asked, because it is slow. Never uses a broadcast address.
 * @param {any} port
 * @param {{ family: "inficon_binary" | "ppg_ascii" | "pfeiffer_ascii", baudRate: number, from: number, to: number, timeoutMs?: number, onStatus?: (m: string) => void, signal?: AbortSignal, registry?: any }} options
 * @returns {Promise<{ results: ScanResult[], writes: Uint8Array[] }>}
 */
export async function sweepAddresses(port, options) {
  const line = new Line(port);
  /** @type {ScanResult[]} */
  const results = [];
  const ctx = { baudRate: options.baudRate, rsMode: /** @type {"RS485"} */ ("RS485"), registry: options.registry };
  try {
    await port.open({ baudRate: options.baudRate });
    for (let address = options.from; address <= options.to; address += 1) {
      if (options.signal?.aborted) break;
      if (options.family === "ppg_ascii" && address === PPG_BROADCAST_ADDRESS) continue;
      options.onStatus?.(`address ${address}`);
      try {
        if (options.family === "inficon_binary") {
          const found = await probePxg(line, address, ctx);
          if (found) results.push(found);
        } else if (options.family === "ppg_ascii") {
          const fv = await line.ask(ppgRead(address, "FV"), ppgFramer, { timeoutMs: options.timeoutMs ?? 150 });
          if (fv && ppgIsAck(fv)) results.push(await identifyPpg(line, fv, ctx, address));
        } else {
          const fw = await line.ask(pfaRead(309, address), pfaFramer, { timeoutMs: options.timeoutMs ?? 150 });
          if (fw && pfaValidResponse(fw)) {
            const firmware = pfaData(fw).trim();
            const hint = pfaModelHint(firmware);
            results.push({
              family: "pfeiffer_ascii", model: registryModel(ctx.registry, hint), modelHint: hint ? `INFICON ${hint}` : "Pfeiffer ASCII device",
              baudRate: ctx.baudRate, rsMode: "RS485", address, firmware, description: `FW: ${firmware}`, meta: {}
            });
          }
        }
      } catch (error) {
        if (error instanceof EchoOnly) continue;
        throw error;
      }
    }
  } finally {
    line.dispose();
    try {
      await port.close();
    } catch {}
  }
  return { results, writes: line.writes };
}

/** @param {any} registry @param {string} model */
function registryModel(registry, model) {
  if (!model) return "";
  if (!registry) return model;
  return registry.has(model) ? registry.get(model).model : "";
}
