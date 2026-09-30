// @ts-check
/**
 * Device registry — the web edition of CSC's device_registry.py. Specs are the JSON
 * generated from specs-src/ by scripts/specs-build.mjs; codecs are loaded on demand.
 */

/** Protocol key → codec module and factory name. */
const CODECS = {
  cdg_serial: ["../codecs/cdg-serial.js", "createCdgCodec"],
  inficon_binary: ["../codecs/inficon-binary.js", "createInficonBinaryCodec"],
  pfeiffer_binary: ["../codecs/inficon-binary.js", "createInficonBinaryCodec"],
  ppg_ascii: ["../codecs/ppg-ascii.js", "createPpgCodec"],
  pfeiffer_ascii: ["../codecs/pfeiffer-ascii.js", "createPfeifferAsciiCodec"],
  inficon_ascii: ["../codecs/pfeiffer-ascii.js", "createPfeifferAsciiCodec"],
  inficon_p3_v02: ["../codecs/inficon-p3v02.js", "createP3V02Codec"]
};

/** Human names for protocol families, used in the UI. */
export const FAMILY_LABELS = {
  cdg_serial: "SKY CDG (RS232C binary)",
  inficon_binary: "INFICON binary (PxG55x)",
  pfeiffer_binary: "INFICON binary (PxG55x)",
  ppg_ascii: "PPG ASCII",
  pfeiffer_ascii: "Pfeiffer ASCII",
  inficon_ascii: "Pfeiffer ASCII",
  inficon_p3_v02: "INFICON P3 V02"
};

export class DeviceNotFound extends Error {}

export class Registry {
  /** @param {Record<string, any>} specs  model → spec, as in public/specs/all.json */
  constructor(specs) {
    /** @type {Map<string, any>} */
    this.specs = new Map(Object.values(specs).map((s) => [String(s.model).toUpperCase(), s]));
  }

  /** Load public/specs/all.json relative to the page (browser) or an explicit URL. @param {string | URL} [url] */
  static async load(url = new URL("../../specs/all.json", import.meta.url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load device specs (${response.status}).`);
    return new Registry(await response.json());
  }

  /** @param {string} model */
  get(model) {
    const spec = this.specs.get(String(model).toUpperCase());
    if (!spec) throw new DeviceNotFound(`Unknown model '${model}'. Available: ${this.allModels().join(", ")}`);
    return spec;
  }

  /** @param {string} model */
  has(model) {
    return this.specs.has(String(model).toUpperCase());
  }

  allModels() {
    return [...this.specs.values()].map((s) => s.model).sort();
  }

  /** @param {"gauge" | "turbo"} [deviceClass] */
  list(deviceClass) {
    return [...this.specs.values()]
      .filter((s) => !deviceClass || s.device_class === deviceClass)
      .sort((a, b) => Number(a.experimental) - Number(b.experimental) || a.model.localeCompare(b.model));
  }

  /**
   * Instantiate the codec for a spec (CSC `make_protocol`).
   * @param {any} spec
   * @param {{ address?: number, rsMode?: "RS232" | "RS485", fullScaleMbar?: number }} [options]
   * @returns {Promise<import("../models.js").Codec & Record<string, any>>}
   */
  async makeCodec(spec, options = {}) {
    const entry = CODECS[/** @type {keyof typeof CODECS} */ (spec.protocol)];
    if (!entry) throw new Error(`Unknown protocol '${spec.protocol}' for model '${spec.model}'`);
    const module = await import(entry[0]);
    const factory = module[entry[1]];
    if (typeof factory !== "function") throw new Error(`${entry[0]} does not export ${entry[1]}`);
    const address = options.address ?? spec.transport?.default_address ?? 0;
    return factory(spec, { ...options, address });
  }

  /**
   * Line settings for a spec, in Web Serial terms.
   * @param {any} spec
   * @returns {{ baudRate: number, dataBits: number, stopBits: number, parity: "none" | "even" | "odd" }}
   */
  static lineSettings(spec) {
    const t = spec.transport ?? {};
    const parity = { N: "none", E: "even", O: "odd" }[/** @type {"N" | "E" | "O"} */ (String(t.parity ?? "N").toUpperCase())] ?? "none";
    return { baudRate: Number(t.default_baud ?? 9600), dataBits: Number(t.data_bits ?? 8), stopBits: Number(t.stop_bits ?? 1), parity: /** @type {any} */ (parity) };
  }
}
