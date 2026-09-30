// @ts-check
/**
 * Export builders: measurement CSV (per device, or merged on the union of timestamps with
 * empty cells where a device had no sample, preserving CSC's full-history behaviour for
 * gauges polled at different rates), traffic CSV with exact bytes, and a readable
 * transcript. Every CSV starts with comment lines that trace the data to the build and to
 * each device's configuration (WEB_PORT_PLAN.md sections 9 and 14).
 */
import { toHex, printable } from "../bytes.js";
import { convertPressure, isPressureUnit } from "../units.js";

/** @param {string} value */
const csv = (value) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * @param {{ app: { version: string, build: string }, session: string, devices: any[], displayUnit?: string }} ctx
 */
export function csvHeader(ctx) {
  const lines = [
    `# Gauge Serial Communication Tool ${ctx.app.version} (build ${ctx.app.build})`,
    `# Session: ${ctx.session}`,
    `# Exported: ${new Date().toISOString()}`
  ];
  for (const d of ctx.devices) {
    const fs = d.fullScale ? `; full scale ${d.fullScale.value} ${d.fullScale.unit} (${d.fullScale.origin === "user" ? "confirmed by user" : "from scan"})` : "";
    lines.push(`# ${d.label}: ${d.model}${d.simulated ? " (simulated)" : ""}; ${d.line?.rsMode ?? "RS232"} address ${d.address}; ${d.line?.baudRate ?? ""} baud${fs}; serial ${d.identity?.serial || "unknown"}`);
  }
  if (ctx.displayUnit && ctx.displayUnit !== "auto") lines.push(`# Display unit: ${ctx.displayUnit} (recorded values are in the unit the gauge reported)`);
  return lines.join("\n");
}

/**
 * Merged measurement CSV. Columns per series: recorded value, recorded unit, status, and the
 * displayed value when the display unit differs from the recorded one.
 * @param {{ series: { label: string, series: import("./buffers.js").Series }[], displayUnit?: string, header: string, from?: number, to?: number }} input
 */
export function measurementCsv(input) {
  const from = input.from ?? -Infinity;
  const to = input.to ?? Infinity;
  const display = input.displayUnit && input.displayUnit !== "auto" ? input.displayUnit : null;
  const slices = input.series.map((s) => ({ ...s, data: s.series.slice(from, to) }));
  const times = new Set();
  for (const s of slices) for (const t of s.data.t) times.add(t);
  const sorted = [...times].sort((a, b) => a - b);
  const columns = ["timestamp_iso", "epoch_ms"];
  for (const s of slices) {
    const unit = s.series.unit;
    columns.push(`${s.label} value`, `${s.label} unit`, `${s.label} status`);
    if (display && isPressureUnit(unit) && unit.toLowerCase() !== display.toLowerCase()) columns.push(`${s.label} displayed (${display})`);
  }
  const cursors = slices.map(() => 0);
  const rows = [columns.map(csv).join(",")];
  for (const t of sorted) {
    const row = [new Date(t).toISOString(), String(t)];
    slices.forEach((s, k) => {
      const d = s.data;
      const unit = s.series.unit;
      const hasDisplay = display && isPressureUnit(unit) && unit.toLowerCase() !== display.toLowerCase();
      if (cursors[k] < d.t.length && d.t[cursors[k]] === t) {
        const v = d.v[cursors[k]];
        row.push(num(v), unit, STATUS_NAMES[d.s[cursors[k]]] ?? String(d.s[cursors[k]]));
        if (hasDisplay) row.push(num(convertPressure(v, unit, /** @type {string} */ (display))));
        cursors[k] += 1;
      } else {
        row.push("", "", "");
        if (hasDisplay) row.push("");
      }
    });
    rows.push(row.join(","));
  }
  return `${input.header}\n${rows.join("\n")}\n`;
}

/** Samples are stored as float32 (about 7 significant digits); print no more than that. @param {number} v */
const num = (v) => String(Number(v.toPrecision(7)));

const STATUS_NAMES = { 0: "ok", 1: "underrange", 2: "overrange", 3: "warning", 9: "gap" };

/**
 * @param {{ entries: { t: number, dir: string, device: string, bytes: Uint8Array, note?: string }[], header: string }} input
 */
export function trafficCsv(input) {
  const rows = ["timestamp_iso,direction,device,hex,text,note"];
  for (const e of input.entries) {
    rows.push([new Date(e.t).toISOString(), e.dir, e.device, toHex(e.bytes), printable(e.bytes), e.note ?? ""].map((v) => csv(String(v))).join(","));
  }
  return `${input.header}\n${rows.join("\n")}\n`;
}

/**
 * @param {{ entries: { t: number, dir: string, device: string, bytes: Uint8Array, note?: string }[], header: string }} input
 */
export function transcript(input) {
  const lines = input.header.split("\n").map((l) => l.replace(/^# ?/, ""));
  lines.push("");
  for (const e of input.entries) {
    const arrow = e.dir === "tx" ? "→" : e.dir === "rx" ? "←" : "•";
    lines.push(`${new Date(e.t).toISOString()}  ${e.device.padEnd(18)} ${arrow} ${printable(e.bytes)}   [${toHex(e.bytes)}]${e.note ? `   ${e.note}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}
