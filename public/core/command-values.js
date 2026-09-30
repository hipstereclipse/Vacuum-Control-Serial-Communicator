// @ts-check
/**
 * What a write command accepts, so the terminal can offer a drop-down, a slider or a pressure
 * field, and still let the user type any value by hand. Derived from the spec: an `options`
 * table, `min_value`/`max_value`, the command unit, and as a last resort the description,
 * where CSC's YAML lists the accepted words ("ABOVE or BELOW", "U!MBAR|PASCAL|TORR",
 * "(0=mbar, 1=Torr, 2=Pa)").
 */
import { isPressureUnit } from "./units.js";

/**
 * @typedef {{ value: string, label: string }} Choice
 * @typedef {{
 *   kind: "none" | "choice" | "range" | "pressure" | "text",
 *   choices: Choice[],
 *   min?: number,
 *   max?: number,
 *   step?: number,
 *   unit?: string,
 *   placeholder: string,
 * }} ValueShape
 */

const WORD = /^[A-Z0-9][A-Z0-9.+-]*$/;

/**
 * @param {string} name   command name
 * @param {any} cmd       spec command entry (generated JSON)
 * @param {{ protocol?: string }} [spec]
 * @returns {ValueShape}
 */
export function valueShape(name, cmd, spec = {}) {
  const description = String(cmd?.description ?? "");
  const placeholder = cmd?.value_hint ? String(cmd.value_hint) : "";
  let choices = choicesFrom(cmd, description);
  // Pfeiffer ASCII booleans ("Pumping station on/off") take 1 or 0, as the turbo buttons send.
  if (!choices.length && spec.protocol === "pfeiffer_ascii" && /\bon\/off\b/i.test(description)) {
    choices = [{ value: "1", label: "On (1)" }, { value: "0", label: "Off (0)" }];
  }
  if (spec.protocol === "cdg_serial" && /^setpoint_\d_(low|high)$/.test(name)) {
    return { kind: "range", choices: [], min: 0, max: 255, step: 1, placeholder: "raw 0–255" };
  }
  if (choices.length) return { kind: "choice", choices, placeholder };
  const min = numberOrNull(cmd?.min_value);
  const max = numberOrNull(cmd?.max_value);
  if (min != null && max != null && max > min) {
    return { kind: "range", choices: [], min, max, step: Number.isInteger(min) && Number.isInteger(max) ? 1 : (max - min) / 100, unit: cmd?.unit ?? "", placeholder: `${min}–${max}` };
  }
  if (isPressureUnit(cmd?.unit)) return { kind: "pressure", choices: [], unit: cmd.unit, placeholder: placeholder || "e.g. 1.00E-02" };
  if (cmd?.write && !cmd?.read && !placeholder && !/value|<|pressure|number|address|\d/i.test(description)) {
    return { kind: "none", choices: [], placeholder: "no value needed" };
  }
  return { kind: "text", choices: [], placeholder: placeholder || (cmd?.read ? "value to write" : "value") };
}

/** @param {any} cmd @param {string} description @returns {Choice[]} */
export function choicesFrom(cmd, description) {
  const options = cmd?.options;
  if (Array.isArray(options) && options.length) {
    return options.map((o) => ({ value: String(o.value), label: `${o.label} (${o.value})` }));
  }
  if (options && typeof options === "object" && Object.keys(options).length) {
    return Object.entries(options).map(([value, label]) => ({ value, label: `${label} (${value})` }));
  }
  // "(0=mbar, 1=Torr, 2=Pa)"
  const numbered = [...description.matchAll(/(\d+)\s*=\s*([^,;)]+)/g)];
  if (numbered.length >= 2) return numbered.map((m) => ({ value: m[1], label: `${m[2].trim()} (${m[1]})` }));
  // "U!MBAR|PASCAL|TORR", "SPD!1,ABOVE|BELOW", "BAUD!<4800|9600|...>"
  const piped = /!(?:<n>,|\d,|[A-Z]{1,3},)?<?([A-Za-z0-9.+-]+(?:\|[A-Za-z0-9.+-]+)+)>?/.exec(description);
  if (piped) return words(piped[1].split("|"));
  const hint = String(cmd?.value_hint ?? "");
  for (const text of [afterColon(description), lastParenthetical(description), hint]) {
    if (!text) continue;
    const list = words(text.replace(/\(.*?\)/g, "").split(/\s*,\s*(?:or\s+)?|\s+or\s+/i));
    // "(<pressure value> or CLEAR)": offer the keyword; any other value is typed by hand.
    if (list.length >= 2 || (list.length === 1 && /<[^>]+>/.test(text))) return list;
  }
  return [];
}

/** @param {string[]} tokens @returns {Choice[]} */
function words(tokens) {
  const out = tokens.map((t) => t.trim()).filter((t) => WORD.test(t) && !/-\d/.test(t));
  return [...new Set(out)].map((value) => ({ value, label: value }));
}

/** @param {string} s */
function afterColon(s) {
  const i = s.indexOf(":");
  return i < 0 ? "" : s.slice(i + 1).trim();
}

/** @param {string} s */
function lastParenthetical(s) {
  const all = [...s.matchAll(/\(([^()]*)\)/g)];
  return all.length ? all[all.length - 1][1] : "";
}

/** @param {unknown} v */
function numberOrNull(v) {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
}

/**
 * Group a command for the quick-command bar.
 * @param {string} name
 * @returns {"identity" | "readings" | "setpoints" | "service" | "configuration"}
 */
export function commandGroup(name) {
  if (/^setpoint/.test(name)) return "setpoints";
  if (/serial|firmware|software|version|part_number|manufacturer|model_name|product_name|cdg_type|bootloader|hours/.test(name)) return "identity";
  if (/zero|adjust|reset|factory|^fs_|full_scale|clear|degas|error_ack/.test(name)) return "service";
  if (/pressure|temperature|status|error|exception|state|speed|current|power|instance|statistics|quick|record|count|size|voltage/.test(name)) return "readings";
  return "configuration";
}

export const GROUP_LABELS = Object.freeze({
  identity: "Identity",
  readings: "Readings",
  setpoints: "Setpoints",
  configuration: "Configuration",
  service: "Adjust & service"
});
