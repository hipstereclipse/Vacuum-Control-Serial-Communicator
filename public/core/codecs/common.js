// @ts-check
/**
 * Helpers shared by codecs: turning a spec's command table into CommandInfo rows for
 * the command dictionary and the frame builder.
 */

/**
 * @param {any} spec  generated JSON spec (public/specs/*.json)
 * @returns {import("../models.js").CommandInfo[]}
 */
export function commandsFromSpec(spec) {
  return Object.entries(spec?.commands ?? {}).map(([name, cmd]) => ({
    name,
    read: Boolean(cmd.read),
    write: Boolean(cmd.write),
    unit: cmd.unit ?? "",
    description: cmd.description ?? "",
    risk: cmd.risk ?? (cmd.write ? "caution" : "safe"),
    source: cmd.source ?? spec?.source ?? "",
    valueHint: cmd.value_hint ?? (cmd.options?.length ? cmd.options.map((/** @type {any} */ o) => `${o.value}=${o.label}`).join(", ") : ""),
    experimental: Boolean(cmd.experimental)
  }));
}

/**
 * Format a pressure in the scientific style every INFICON display uses.
 * @param {number} value
 * @param {string} unit
 * @param {number} [digits]
 */
export function formatPressure(value, unit, digits = 4) {
  if (!Number.isFinite(value)) return `— ${unit}`.trim();
  return `${value.toExponential(digits - 1).toUpperCase().replace(/E([+-])(\d)$/, "E$10$2")} ${unit}`.trim();
}
