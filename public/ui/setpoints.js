// @ts-check
/**
 * Setpoint editor: an interactive window for a gauge's setpoint relays, after the setpoint
 * configuration panel in CSC (gauge_tab.py GaugeSettingsPanel), extended.
 *
 *  - Every switch-on and switch-off level can be changed four ways that stay in sync: drag its
 *    line on the plot (or drag the shaded band to move both), the slider, the ± nudge buttons
 *    or arrow keys and mouse wheel on the line, or by typing a pressure (or, on a CDG, the raw
 *    byte). The hysteresis can be typed as a percentage or picked from presets.
 *  - The plot draws an illustrative vacuum cycle: vented, pump-down into a valley, a gas burst
 *    that climbs back into the focused setpoint's hysteresis band, base pressure, then a vent.
 *    Markers show where each relay switches, and the lanes underneath show each relay's state
 *    over the cycle, so it is visible that a relay holds its state inside the band.
 *  - Nothing is written while editing. Apply sends only what changed, after one danger
 *    confirmation that lists every frame, then reads the values back to verify them.
 *
 * The model (raw/pressure law, relay state machine, PPG hysteresis readings) lives in
 * public/core/setpoints.js.
 */
import { h, replace, openDialog, toast } from "./dom.js";
import { convertPressure, isPressureUnit, PRESSURE_UNITS } from "../core/units.js";
import { formatPressure } from "../core/codecs/common.js";
import {
  cdgRawToMbar, cdgMbarToRaw, ppgToBand, bandToPpg, relayTrace, relayStep, zoneOf, illustrativeCycle,
  cycleLevels, formatSetpointValue, gaugeRangeMbar, CYCLE_PHASES, CDG_RAW_MAX
} from "../core/setpoints.js";

const MODE_KEY = "gauge-communicator-ppg-hysteresis";
const PAD = { left: 76, right: 128, top: 26, bottom: 26 };
const PLOT_H = 330;
const LANE_H = 24;

/** @returns {"absolute" | "offset"} */
export function hysteresisMode() {
  try {
    return localStorage.getItem(MODE_KEY) === "offset" ? "offset" : "absolute";
  } catch {
    return "absolute";
  }
}

/** @param {number} index */
export const setpointColor = (index) => `var(--sp-${index <= 3 ? index : 1})`;

/** The unit a PPG answers in: its last `unit` reply, else mbar. @param {any} d */
function gaugeUnit(d) {
  const u = String(d.secondary.get("unit")?.formatted ?? "").trim().toUpperCase();
  if (u.startsWith("TORR")) return "Torr";
  if (u.startsWith("PASCAL") || u === "PA") return "Pa";
  if (u.startsWith("MICRON")) return "micron";
  return "mbar";
}

/**
 * Setpoint bands known from earlier replies (the device's `secondary` map), for the summary
 * card on the device tab. Null for a channel that has not been read yet.
 * @param {any} d @param {import("../core/setpoints.js").SetpointLayout} layout
 * @returns {({ index: number, on: number, off: number, direction: "below" | "above", enabled: boolean, raw?: { on: number, off: number } } | null)[]}
 */
export function knownBands(d, layout) {
  const fs = d.codec.fullScaleMbar ?? d.fullScale?.mbar ?? 1;
  return layout.channels.map((ch) => {
    if (layout.kind === "cdg") {
      const r = d.secondary.get(ch.commands.read)?.extra;
      if (!r || r.low == null) return null;
      return { index: ch.index, on: cdgRawToMbar(r.low, fs), off: cdgRawToMbar(r.high, fs), direction: "below", enabled: true, raw: { on: r.low, off: r.high } };
    }
    const value = d.secondary.get(ch.commands.value);
    if (!value || !Number.isFinite(value.value)) return null;
    const unit = gaugeUnit(d);
    const toMbar = (/** @type {number} */ v) => convertPressure(v, unit, "mbar");
    const hyst = d.secondary.get(ch.commands.hysteresis ?? "");
    const direction = /ABOVE/i.test(d.secondary.get(ch.commands.direction ?? "")?.formatted ?? "") ? "above" : "below";
    const enabledText = d.secondary.get(ch.commands.enable ?? "")?.formatted;
    const enabled = enabledText == null ? true : !/^OFF/i.test(enabledText.trim());
    const band = ppgToBand({ value: toMbar(value.value), hysteresis: Number.isFinite(hyst?.value) ? toMbar(hyst.value) : toMbar(value.value), direction }, hysteresisMode());
    return { index: ch.index, ...band, direction, enabled };
  });
}

/**
 * Read every setpoint register from the gauge (safe reads only).
 * @param {any} app @param {any} d @param {import("../core/setpoints.js").SetpointLayout} layout
 */
export async function readSetpoints(app, d, layout) {
  const commands = new Set((d.codec.commands?.() ?? []).filter((/** @type {any} */ c) => c.read).map((/** @type {any} */ c) => c.name));
  const errors = [];
  const reads = layout.kind === "ppg" && commands.has("unit") ? ["unit"] : [];
  for (const ch of layout.channels) {
    for (const [role, name] of Object.entries(ch.commands)) {
      if (layout.kind === "cdg" && role !== "read") continue;
      if (commands.has(name)) reads.push(name);
    }
  }
  for (const name of reads) {
    const entry = await app.query(d, name);
    if (entry.error) errors.push(`${name}: ${entry.error}`);
  }
  return { errors, count: reads.length };
}

/**
 * @param {any} app
 * @param {any} d
 */
export function openSetpointEditor(app, d) {
  const layout = app.setpointLayout(d);
  const cdg = layout.kind === "cdg";
  const fs = () => d.codec.fullScaleMbar ?? d.fullScale?.mbar ?? 1;
  let mode = hysteresisMode();
  let unit = app.displayUnit() !== "auto" && isPressureUnit(app.displayUnit()) ? app.displayUnit() : "mbar";
  const range = () => {
    const r = gaugeRangeMbar(d.model, fs());
    return cdg ? { min: Math.min(r.min, cdgRawToMbar(3, fs())), max: fs() } : r;
  };

  /**
   * Editable state per channel. CDG channels keep raw bytes (what the gauge stores); PPG
   * channels keep mbar. `gauge` is the last value read back, to show what changed.
   * @type {any[]}
   */
  const channels = layout.channels.map((/** @type {any} */ ch) => ({
    index: ch.index,
    commands: ch.commands,
    color: setpointColor(ch.index),
    // Placeholders until the first read-back arrives, spread out so the channels do not overlap.
    raw: ch.index === 1 ? { on: 60, off: 75 } : { on: 120, off: 140 },
    on: 10 ** (1 - 2 * (ch.index - 1)),
    off: 1.1 * 10 ** (1 - 2 * (ch.index - 1)),
    direction: "below",
    enabled: true,
    gauge: null,
    live: false
  }));
  let focus = channels[0].index;
  /** @type {{ yMin: number, yMax: number } | null} */
  let view = null;
  /** @type {number | null} */
  let hoverP = null;
  let live = /** @type {number | null} */ (null);
  let busy = false;

  // ------------------------------------------------------------------------------------------
  // Model helpers

  /** @param {any} ch */
  const band = (ch) => cdg
    ? { on: cdgRawToMbar(ch.raw.on, fs()), off: cdgRawToMbar(ch.raw.off, fs()), direction: "below", enabled: true }
    : { on: ch.on, off: ch.off, direction: ch.direction, enabled: ch.enabled };

  /** Keep the switch-off level on the correct side of the switch-on level. @param {any} ch @param {"on" | "off"} moved */
  function order(ch, moved) {
    if (cdg) {
      if (ch.raw.off < ch.raw.on) moved === "on" ? (ch.raw.off = ch.raw.on) : (ch.raw.on = ch.raw.off);
      return;
    }
    const bad = ch.direction === "above" ? ch.off > ch.on : ch.off < ch.on;
    if (bad) moved === "on" ? (ch.off = ch.on) : (ch.on = ch.off);
  }

  /** @param {number} v */
  const sig3 = (v) => Number(v.toPrecision(3));

  /** @param {any} ch @param {"on" | "off"} edge @param {number} mbar */
  function setEdge(ch, edge, mbar) {
    if (!(mbar > 0) || !Number.isFinite(mbar)) return;
    const r = range();
    const p = Math.min(r.max * 1.5, Math.max(r.min / 10, mbar));
    if (cdg) ch.raw[edge] = cdgMbarToRaw(p, fs());
    else ch[edge] = sig3(p);
    order(ch, edge);
  }

  /** @param {any} ch @param {"on" | "off"} edge @param {number} steps */
  function nudge(ch, edge, steps) {
    if (cdg) {
      ch.raw[edge] = Math.max(0, Math.min(CDG_RAW_MAX, ch.raw[edge] + steps));
      order(ch, edge);
      return;
    }
    const before = ch[edge];
    let next = sig3(before * 10 ** (0.02 * steps));
    if (next === before) next = sig3(before + Math.sign(steps) * 10 ** (Math.floor(Math.log10(before)) - 2));
    setEdge(ch, edge, next);
  }

  /** Hysteresis as a percentage of the switch-on level. @param {any} ch */
  function hysteresisPct(ch) {
    const b = band(ch);
    if (!(b.on > 0)) return 0;
    return b.direction === "above" ? (b.on / Math.max(b.off, 1e-30) - 1) * 100 : (b.off / b.on - 1) * 100;
  }

  /** @param {any} ch @param {number} pct */
  function setHysteresisPct(ch, pct) {
    if (!(pct >= 0)) return;
    const b = band(ch);
    const off = b.direction === "above" ? b.on / (1 + pct / 100) : b.on * (1 + pct / 100);
    setEdge(ch, "off", off);
  }

  /** @param {any} ch */
  function changed(ch) {
    if (!ch.gauge) return true;
    if (cdg) return ch.raw.on !== ch.gauge.raw.on || ch.raw.off !== ch.gauge.raw.off;
    return !close(ch.on, ch.gauge.on) || !close(ch.off, ch.gauge.off) || ch.direction !== ch.gauge.direction || ch.enabled !== ch.gauge.enabled;
  }

  function loadFromDevice() {
    const known = knownBands(d, layout);
    known.forEach((k, i) => {
      if (!k) return;
      const ch = channels[i];
      if (cdg && k.raw) ch.raw = { ...k.raw };
      ch.on = k.on;
      ch.off = k.off;
      ch.direction = k.direction;
      ch.enabled = k.enabled;
      ch.gauge = { raw: k.raw ? { ...k.raw } : null, on: k.on, off: k.off, direction: k.direction, enabled: k.enabled };
    });
  }

  function fit() {
    const all = channels.map(band);
    const levels = cycleLevels(all, band(channels.find((c) => c.index === focus) ?? channels[0]), range());
    const values = all.flatMap((b) => [b.on, b.off]).concat(live && live > 0 ? [live] : []);
    let yMin = levels.yMin;
    let yMax = levels.yMax;
    if (live && live > 0) {
      yMin = Math.min(yMin, live / 3);
      yMax = Math.max(yMax, live * 3);
    }
    view = { yMin: Math.max(yMin, Math.min(...values) / 1e3), yMax };
  }

  function needsRefit() {
    const vw = view;
    if (!vw) return true;
    const values = channels.map(band).flatMap((b) => [b.on, b.off]);
    return values.some((v) => v < vw.yMin * 1.2 || v > vw.yMax / 1.2);
  }

  // ------------------------------------------------------------------------------------------
  // Formatting

  /** @param {number} mbar */
  const toUnit = (mbar) => convertPressure(mbar, "mbar", unit);
  /** @param {number} mbar */
  const fmtP = (mbar) => formatPressure(toUnit(mbar), unit, 3);
  /** @param {number} mbar */
  const fmtNum = (mbar) => formatPressure(toUnit(mbar), "", 3);

  // ------------------------------------------------------------------------------------------
  // Controls

  const controls = h("div.sp-controls");
  /** @type {Map<number, any>} */
  const cardRefs = new Map();

  function buildControls() {
    cardRefs.clear();
    const modeSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "How the hysteresis value is interpreted" },
      h("option", { value: "absolute" }, "the release pressure"),
      h("option", { value: "offset" }, "an offset from the setpoint")));
    modeSelect.value = mode;
    modeSelect.onchange = () => {
      mode = /** @type {"absolute" | "offset"} */ (modeSelect.value);
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {}
      // Show the gauge's registers under the new interpretation (this discards unsaved edits).
      loadFromDevice();
      renderAll();
    };
    const unitSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Editor unit" }, PRESSURE_UNITS.map((u) => h("option", { value: u }, u))));
    unitSelect.value = unit;
    unitSelect.onchange = () => {
      unit = unitSelect.value;
      renderAll();
    };
    replace(controls,
      h("div.row", null,
        h("label.row", null, h("span.field-label", null, "Unit"), unitSelect),
        h("span.hint", null, cdg ? `Full scale ${d.fullScale ? `${d.fullScale.value} ${d.fullScale.unit}` : `${fs()} mbar`} · raw byte 0–255, p = FS·(raw/255)³ 🟠 V7` : "")),
      cdg ? null : h("label.field", null, h("span.field-label", null, "The hysteresis value is"), modeSelect,
        h("span.hint", null, "🟠 Not yet confirmed against the PPG manual. Pick what your manual says. Switching this changes how the gauge's registers are shown, not the gauge.")),
      ...channels.map(buildCard));
  }

  /** @param {any} ch */
  function buildCard(ch) {
    const refs = /** @type {any} */ ({});
    const card = h("div.sp-card", { onpointerdown: () => {
      if (focus !== ch.index) {
        focus = ch.index;
        renderAll(false);
      }
    } });
    card.style.setProperty("--sp-color", ch.color);
    refs.card = card;
    refs.status = h("span.relay");
    refs.changed = h("span.changed");
    const head = h("div.sp-card-head", null, h("span", { style: { width: "12px", height: "12px", borderRadius: "2px", background: ch.color, display: "inline-block" } }), h("strong", null, `Setpoint ${ch.index}`), refs.status, h("div.grow"), refs.changed);
    const parts = [head];
    if (!cdg) {
      const dir = h("div.segmented", { role: "group", "aria-label": `Setpoint ${ch.index} direction` });
      for (const [value, label, title] of [["below", "Below", "Relay on when the pressure falls below the setpoint"], ["above", "Above", "Relay on when the pressure rises above the setpoint"]]) {
        dir.append(h("button", { type: "button", title, dataset: { v: value }, onclick: () => {
          if (ch.direction === value) return;
          // Mirror the release level to the other side of the setpoint (same ratio in log).
          ch.direction = value;
          const ratio = ch.off / ch.on;
          ch.off = sig3(ch.on / ratio);
          order(ch, "off");
          renderAll();
        } }, label));
      }
      refs.dir = dir;
      const enable = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: ch.enabled }));
      enable.onchange = () => {
        ch.enabled = enable.checked;
        renderAll();
      };
      refs.enable = enable;
      parts.push(h("div.row", null, h("span.field-label", null, "Switch"), dir, h("label.check", { style: { marginLeft: "auto" } }, enable, "Enabled")));
    }
    parts.push(edgeRow(ch, "on", refs), edgeRow(ch, "off", refs));
    const pct = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: "0", step: "1", "aria-label": `Setpoint ${ch.index} hysteresis percent` }));
    pct.onchange = () => {
      setHysteresisPct(ch, Number(pct.value));
      renderAll();
    };
    refs.pct = pct;
    refs.ratio = h("span.hint");
    const liveButton = h("button.preset", { type: "button", title: "Put the switch-on level at the current pressure, keeping the hysteresis", onclick: () => {
      if (!(live && live > 0)) return toast("No live pressure reading yet.", "warn");
      const p0 = hysteresisPct(ch);
      setEdge(ch, "on", live);
      setHysteresisPct(ch, p0);
      renderAll();
    } }, "On = live");
    parts.push(h("div.sp-hyst", null, h("span.field-label", null, "Hysteresis"), pct, "%",
      ...[10, 25, 50, 100].map((v) => h("button.preset", { type: "button", onclick: () => {
        setHysteresisPct(ch, v);
        renderAll();
      } }, `${v} %`)), liveButton, refs.ratio));
    replace(card, ...parts);
    cardRefs.set(ch.index, refs);
    return card;
  }

  /** @param {any} ch @param {"on" | "off"} edge @param {any} refs */
  function edgeRow(ch, edge, refs) {
    const label = edge === "on"
      ? h("span.lbl", null, "Switch on", h("small", null, cdg ? "low" : "setpoint"))
      : h("span.lbl", null, "Switch off", h("small", null, cdg ? "high" : "release"));
    const slider = /** @type {HTMLInputElement} */ (h("input", { type: "range", min: "0", max: cdg ? String(CDG_RAW_MAX) : "1000", step: "1", "aria-label": `Setpoint ${ch.index} switch ${edge}` }));
    slider.oninput = () => {
      if (cdg) {
        ch.raw[edge] = Number(slider.value);
        order(ch, edge);
      } else {
        const r = range();
        const l = Math.log10(r.min) + (Number(slider.value) / 1000) * (Math.log10(r.max) - Math.log10(r.min));
        setEdge(ch, edge, 10 ** l);
      }
      renderAll(false);
    };
    const text = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputmode: "decimal", spellcheck: "false", "aria-label": `Setpoint ${ch.index} switch ${edge} pressure` }));
    const commitText = () => {
      const v = Number(text.value.trim().replace(",", "."));
      if (!(v > 0)) {
        text.classList.add("invalid");
        return;
      }
      text.classList.remove("invalid");
      setEdge(ch, edge, convertPressure(v, unit, "mbar"));
      renderAll();
    };
    text.onchange = commitText;
    text.onkeydown = (e) => {
      if (e.key === "Enter") commitText();
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        nudge(ch, edge, e.key === "ArrowUp" ? 1 : -1);
        renderAll();
      }
    };
    const nums = h("span.nums", null, text, h("span.unit", { dataset: { role: "unit" } }, unit));
    if (cdg) {
      const raw = /** @type {HTMLInputElement} */ (h("input.raw", { type: "text", inputmode: "numeric", title: "Raw setpoint byte (0–255)", "aria-label": `Setpoint ${ch.index} switch ${edge} raw byte` }));
      raw.onchange = () => {
        const v = Number(raw.value);
        if (!Number.isInteger(v) || v < 0 || v > CDG_RAW_MAX) {
          raw.classList.add("invalid");
          return;
        }
        raw.classList.remove("invalid");
        ch.raw[edge] = v;
        order(ch, edge);
        renderAll();
      };
      nums.append(h("span.unit", null, "raw"), raw);
      refs[`${edge}Raw`] = raw;
    }
    const nudgeBox = h("span.nudge", null,
      h("button", { type: "button", title: "Step down", "aria-label": `Lower setpoint ${ch.index} switch ${edge}`, onclick: () => {
        nudge(ch, edge, -1);
        renderAll();
      } }, "−"),
      h("button", { type: "button", title: "Step up", "aria-label": `Raise setpoint ${ch.index} switch ${edge}`, onclick: () => {
        nudge(ch, edge, 1);
        renderAll();
      } }, "+"));
    refs[`${edge}Slider`] = slider;
    refs[`${edge}Text`] = text;
    return h("div.sp-edge", null, label, h("div.ctl", null, nums, nudgeBox, slider));
  }

  function syncControls() {
    const r = range();
    for (const ch of channels) {
      const refs = cardRefs.get(ch.index);
      if (!refs) continue;
      const b = band(ch);
      refs.card.dataset.focus = String(ch.index === focus);
      refs.card.dataset.enabled = String(b.enabled);
      for (const edge of /** @type {("on" | "off")[]} */ (["on", "off"])) {
        const p = b[edge];
        if (document.activeElement !== refs[`${edge}Text`]) refs[`${edge}Text`].value = fmtNum(p);
        refs[`${edge}Text`].classList.remove("invalid");
        if (cdg) {
          refs[`${edge}Slider`].value = String(ch.raw[edge]);
          if (document.activeElement !== refs[`${edge}Raw`]) refs[`${edge}Raw`].value = String(ch.raw[edge]);
        } else {
          refs[`${edge}Slider`].value = String(Math.round(((Math.log10(p) - Math.log10(r.min)) / (Math.log10(r.max) - Math.log10(r.min))) * 1000));
        }
      }
      for (const el of refs.card.querySelectorAll('[data-role="unit"]')) el.textContent = unit;
      if (refs.dir) for (const btn of refs.dir.querySelectorAll("button")) btn.setAttribute("aria-pressed", String(btn.dataset.v === ch.direction));
      if (refs.enable) refs.enable.checked = ch.enabled;
      const pct = hysteresisPct(ch);
      if (document.activeElement !== refs.pct) refs.pct.value = pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
      refs.ratio.textContent = b.on > 0 ? `off/on ×${(b.off / b.on).toPrecision(3)}` : "";
      refs.changed.textContent = ch.gauge ? (changed(ch) ? "changed" : "") : "not read";
      const state = !b.enabled ? ["Disabled", ""] : live == null ? ["No live reading", ""] : ch.live ? ["Relay on", "on"] : ["Relay off", "off"];
      const zone = live != null && b.enabled ? zoneOf(live, b) : "";
      refs.status.className = `relay ${zone === "band" ? "band" : state[1]}`;
      refs.status.textContent = zone === "band" ? `${state[0]} · holding in band` : state[0];
    }
    const pending = channels.filter(changed).length;
    footerNote.replaceChildren(pending
      ? h("span", null, h("b", null, `${pending} setpoint${pending === 1 ? "" : "s"}`), channels.some((c) => !c.gauge) ? " not read from the gauge yet; Apply writes them as shown." : " changed and not yet written.")
      : h("span", null, "Matches what the gauge reported."));
    applyButton.disabled = busy || !pending;
  }

  // ------------------------------------------------------------------------------------------
  // Plot

  const plotHost = h("div.sp-plot");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  plotHost.append(svg);
  const readout = h("div.sp-readout", { "aria-live": "polite" });
  const legend = h("div.sp-legend", null,
    h("span", null, h("i", null), "switch on"),
    h("span", null, h("i.dash", null), "switch off"),
    h("span", null, h("i.box", null), "hysteresis band: the relay keeps its state"),
    h("span", { style: { color: "var(--curve)" } }, h("i", null), h("span", { style: { color: "var(--muted)" } }, "illustrative cycle")),
    h("span", { style: { color: "var(--action)" } }, h("i.dash", null), h("span", { style: { color: "var(--muted)" } }, "live pressure")));
  /** @type {{ x: number, p: number }[]} */
  let curve = [];
  let geometry = { width: 0, plotW: 0, lMin: 0, lMax: 1 };

  /** @param {number} p */
  const yOf = (p) => PAD.top + PLOT_H - ((Math.log10(p) - geometry.lMin) / (geometry.lMax - geometry.lMin)) * PLOT_H;
  /** @param {number} y */
  const pOf = (y) => 10 ** (geometry.lMin + ((PAD.top + PLOT_H - y) / PLOT_H) * (geometry.lMax - geometry.lMin));
  /** @param {number} fr */
  const xOf = (fr) => PAD.left + fr * geometry.plotW;

  function drawPlot() {
    if (!view) fit();
    const v = /** @type {{ yMin: number, yMax: number }} */ (view);
    const width = Math.max(420, plotHost.clientWidth || 760);
    const enabled = channels.filter((c) => band(c).enabled);
    const lanesH = enabled.length ? enabled.length * LANE_H + 18 : 0;
    const height = PAD.top + PLOT_H + PAD.bottom + lanesH;
    geometry = { width, plotW: width - PAD.left - PAD.right, lMin: Math.log10(v.yMin), lMax: Math.log10(v.yMax) };
    const focusCh = channels.find((c) => c.index === focus) ?? channels[0];
    const levels = cycleLevels(channels.map(band).filter((b) => b.enabled), band(focusCh), { min: v.yMin, max: v.yMax });
    curve = illustrativeCycle({ top: Math.min(levels.top, v.yMax * 0.9), bottom: Math.max(levels.bottom, v.yMin * 1.2), burst: levels.burst });
    const pressures = curve.map((c) => c.p);
    const out = [];
    const clipBottom = PAD.top + PLOT_H;

    // Grid: decades and minor lines in the editor unit.
    const dLo = Math.floor(Math.log10(toUnit(v.yMin)));
    const dHi = Math.ceil(Math.log10(toUnit(v.yMax)));
    const toMbar = (/** @type {number} */ u) => convertPressure(u, unit, "mbar");
    for (let dec = dLo; dec <= dHi; dec += 1) {
      for (let m = 2; m < 10; m += 1) {
        const p = toMbar(m * 10 ** dec);
        if (p > v.yMin && p < v.yMax) out.push(`<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${r1(yOf(p))}" y2="${r1(yOf(p))}" style="stroke:var(--chart-grid-minor)"/>`);
      }
      const p = toMbar(10 ** dec);
      if (p >= v.yMin * 0.999 && p <= v.yMax * 1.001) {
        const y = r1(yOf(p));
        out.push(`<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${y}" y2="${y}" style="stroke:var(--chart-grid)"/>`);
        out.push(`<text x="${PAD.left - 8}" y="${y + 4}" text-anchor="end" class="mono" style="fill:var(--muted);font-size:11px">1E${dec >= 0 ? "+" : "-"}${String(Math.abs(dec)).padStart(2, "0")}</text>`);
      }
    }
    out.push(`<text x="14" y="${PAD.top + PLOT_H / 2}" transform="rotate(-90 14 ${PAD.top + PLOT_H / 2})" text-anchor="middle" style="fill:var(--muted);font-size:12px;font-weight:700">Pressure (${esc(unit)})</text>`);

    // Phases of the illustrative cycle.
    for (const ph of CYCLE_PHASES) {
      if (!ph.label) continue;
      const x0 = xOf(ph.from);
      const x1 = xOf(ph.to);
      out.push(`<line x1="${r1(x0)}" x2="${r1(x0)}" y1="${PAD.top}" y2="${clipBottom}" style="stroke:var(--chart-grid);stroke-dasharray:2 4"/>`);
      out.push(`<text x="${r1((x0 + x1) / 2)}" y="${PAD.top - 9}" text-anchor="middle" style="fill:var(--muted);font-size:11.5px;font-weight:700;letter-spacing:.04em">${esc(ph.label.toUpperCase())}</text>`);
    }
    out.push(`<text x="${PAD.left + geometry.plotW / 2}" y="${clipBottom + 18}" text-anchor="middle" style="fill:var(--muted);font-size:11.5px">Illustrative vacuum cycle (time →). The shape follows your setpoints; it is not recorded data.</text>`);

    // Hysteresis bands, focused one on top.
    const ordered = [...channels].sort((a, b) => (a.index === focus ? 1 : 0) - (b.index === focus ? 1 : 0));
    for (const ch of ordered) {
      const b = band(ch);
      if (!b.enabled) continue;
      const yTop = clampY(yOf(Math.max(b.on, b.off)));
      const yBot = clampY(yOf(Math.min(b.on, b.off)));
      const f = ch.index === focus;
      out.push(`<rect x="${PAD.left}" y="${r1(yTop)}" width="${r1(geometry.plotW)}" height="${r1(Math.max(1, yBot - yTop))}" style="fill:${ch.color};fill-opacity:${f ? 0.16 : 0.08}"/>`);
    }

    // The cycle.
    out.push(`<path d="${curve.map((c, i) => `${i ? "L" : "M"}${r1(xOf(c.x))} ${r1(clampY(yOf(c.p)))}`).join("")}" style="fill:none;stroke:var(--curve);stroke-width:2.2;stroke-linejoin:round"/>`);

    // Switch markers and relay lanes.
    const laneTop = clipBottom + PAD.bottom + 4;
    enabled.forEach((ch, lane) => {
      const b = band(ch);
      const { states, switches } = relayTrace(pressures, b, false);
      const y0 = laneTop + lane * LANE_H;
      out.push(`<text x="${PAD.left - 8}" y="${y0 + 15}" text-anchor="end" style="fill:${ch.color};font-size:12px;font-weight:700">SP${ch.index}</text>`);
      out.push(`<rect x="${PAD.left}" y="${y0 + 4}" width="${r1(geometry.plotW)}" height="${LANE_H - 8}" rx="3" style="fill:var(--surface-2);stroke:var(--line)"/>`);
      let start = -1;
      states.forEach((on, i) => {
        if (on && start < 0) start = i;
        if ((!on || i === states.length - 1) && start >= 0) {
          const xa = xOf(curve[start].x);
          const xb = xOf(curve[on ? i : i - 1].x);
          out.push(`<rect x="${r1(xa)}" y="${y0 + 4}" width="${r1(Math.max(2, xb - xa))}" height="${LANE_H - 8}" rx="3" style="fill:var(--ok);fill-opacity:.85"/>`);
          if (xb - xa > 34) out.push(`<text x="${r1((xa + xb) / 2)}" y="${y0 + 16}" text-anchor="middle" style="fill:#fff;font-size:11px;font-weight:700">ON</text>`);
          start = -1;
        }
      });
      for (const s of switches) {
        const pt = curve[s.i];
        const x = r1(xOf(pt.x));
        const y = r1(clampY(yOf(pt.p)));
        out.push(`<line x1="${x}" x2="${x}" y1="${y}" y2="${y0 + LANE_H - 4}" style="stroke:${ch.color};stroke-dasharray:2 3;stroke-opacity:.8"/>`);
        out.push(`<circle cx="${x}" cy="${y}" r="5.5" style="fill:${ch.color};stroke:var(--chart-bg);stroke-width:2"/>`);
        out.push(`<text x="${x + 8}" y="${y + (s.on ? 16 : -8)}" style="fill:${ch.color};font-size:11.5px;font-weight:700">SP${ch.index} ${s.on ? "on" : "off"}</text>`);
      }
      if (ch.index === focus) {
        const holdIdx = pressures.findIndex((p, i) => curve[i].x > 0.43 && curve[i].x < 0.55 && zoneOf(p, b) === "band");
        if (holdIdx > 0 && states[holdIdx]) {
          const x = r1(xOf(curve[holdIdx].x));
          const y = r1(clampY(yOf(Math.max(b.on, b.off))) - 6);
          out.push(`<text x="${x}" y="${y}" text-anchor="middle" style="fill:var(--text);font-size:11.5px;font-weight:700">burst stays in the band: SP${ch.index} holds</text>`);
        }
      }
    });

    // Threshold lines, with hit areas for dragging. Their value tags are stacked afterwards so
    // a narrow band never hides one tag behind the other.
    /** @type {{ y: number, ch: any, edge: string, p: number, opacity: number }[]} */
    const tags = [];
    for (const ch of ordered) {
      const b = band(ch);
      const f = ch.index === focus;
      const opacity = b.enabled ? 1 : 0.35;
      const yOn = clampY(yOf(b.on));
      const yOff = clampY(yOf(b.off));
      out.push(`<rect class="band-hit" data-ch="${ch.index}" data-edge="band" x="${PAD.left}" y="${r1(Math.min(yOn, yOff) + 6)}" width="${r1(geometry.plotW)}" height="${r1(Math.max(0, Math.abs(yOff - yOn) - 12))}" style="fill:transparent"/>`);
      for (const [edge, y] of /** @type {[string, number][]} */ ([["on", yOn], ["off", yOff]])) {
        const p = edge === "on" ? b.on : b.off;
        out.push(`<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${r1(y)}" y2="${r1(y)}" style="stroke:${ch.color};stroke-width:${f ? 2.4 : 1.6};stroke-opacity:${opacity};${edge === "off" ? "stroke-dasharray:7 5" : ""}"/>`);
        tags.push({ y, ch, edge, p, opacity });
        out.push(`<line class="hit" tabindex="0" role="slider" aria-label="Setpoint ${ch.index} switch ${edge}" aria-valuetext="${esc(fmtP(p))}" data-ch="${ch.index}" data-edge="${edge}" x1="${PAD.left}" x2="${width - 6}" y1="${r1(y)}" y2="${r1(y)}" style="stroke:transparent;stroke-width:14"/>`);
      }
    }

    tags.sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const t of tags) {
      const ty = Math.max(t.y, prev + 20);
      prev = ty;
      const x0 = width - PAD.right;
      if (Math.abs(ty - t.y) > 1) out.push(`<path d="M${x0} ${r1(t.y)}L${x0 + 6} ${r1(ty)}" style="fill:none;stroke:${t.ch.color};stroke-opacity:${t.opacity}"/>`);
      out.push(`<g transform="translate(${x0 + 6} ${r1(ty)})" style="opacity:${t.opacity}"><rect x="0" y="-9" width="${PAD.right - 10}" height="18" rx="3" style="fill:${t.ch.color}"/><text x="6" y="4" style="fill:#fff;font-size:11px;font-weight:700">SP${t.ch.index} ${t.edge} <tspan class="mono" style="font-weight:400">${esc(fmtNum(t.p))}</tspan></text></g>`);
    }

    // Live pressure and hover.
    if (live && live > 0 && live >= v.yMin && live <= v.yMax) {
      const y = r1(yOf(live));
      out.push(`<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${y}" y2="${y}" style="stroke:var(--action);stroke-width:1.8;stroke-dasharray:3 3"/>`);
      out.push(`<text x="${PAD.left + 6}" y="${y - 5}" style="fill:var(--action);font-size:11.5px;font-weight:700">Live ${esc(fmtP(live))}</text>`);
    }
    if (hoverP != null) {
      const y = r1(yOf(hoverP));
      out.push(`<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${y}" y2="${y}" style="stroke:var(--muted);stroke-dasharray:1 3;pointer-events:none"/>`);
    }
    out.push(`<rect x="${PAD.left}" y="${PAD.top}" width="${r1(geometry.plotW)}" height="${PLOT_H}" style="fill:none;stroke:var(--line-strong)"/>`);

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", String(height));
    svg.innerHTML = out.join("");
    renderReadout();
  }

  /** @param {number} y */
  const clampY = (y) => Math.min(PAD.top + PLOT_H, Math.max(PAD.top, y));

  function renderReadout() {
    const p = hoverP ?? live;
    if (p == null) {
      replace(readout, h("span.hint", null, "Hover over the plot to see which relays would be on at that pressure. Drag a line, or the shaded band between two lines."));
      return;
    }
    replace(readout,
      h("span.hint", null, hoverP != null ? "At" : "Live"),
      h("span.p", null, fmtP(p)),
      ...channels.map((ch) => {
        const b = band(ch);
        const zone = zoneOf(p, b);
        const text = zone === "disabled" ? "disabled" : zone === "on" ? "on" : zone === "off" ? "off" : "holds (in band)";
        return h("span", null, h("b", { style: { color: ch.color } }, `SP${ch.index} `), h(`span.relay.${zone === "band" ? "band" : zone === "on" ? "on" : "off"}`, null, text));
      }));
  }

  // Dragging, hovering, wheel and keys on the plot.
  /** @type {{ ch: any, edge: string, l0: number, on0: number, off0: number, raw0: any } | null} */
  let drag = null;
  /** @param {PointerEvent | WheelEvent | MouseEvent} e */
  const svgY = (e) => {
    const rect = svg.getBoundingClientRect();
    return ((e.clientY - rect.top) / rect.height) * Number(svg.viewBox.baseVal.height || rect.height);
  };
  svg.addEventListener("pointerdown", (e) => {
    const target = /** @type {Element} */ (e.target);
    const chIndex = Number(target.getAttribute("data-ch"));
    const edge = target.getAttribute("data-edge");
    if (!chIndex || !edge) return;
    const ch = channels.find((c) => c.index === chIndex);
    if (!ch) return;
    e.preventDefault();
    focus = ch.index;
    const b = band(ch);
    drag = { ch, edge, l0: Math.log10(pOf(svgY(e))), on0: b.on, off0: b.off, raw0: { ...ch.raw } };
    svg.setPointerCapture(e.pointerId);
    plotHost.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    const y = svgY(e);
    if (drag) {
      const p = pOf(Math.min(PAD.top + PLOT_H, Math.max(PAD.top, y)));
      const { ch, edge } = drag;
      if (edge === "band") {
        const shift = 10 ** (Math.log10(p) - drag.l0);
        if (cdg) {
          const dOn = cdgMbarToRaw(drag.on0 * shift, fs()) - drag.raw0.on;
          const room = [-drag.raw0.on, CDG_RAW_MAX - drag.raw0.off];
          const step = Math.max(room[0], Math.min(room[1], dOn));
          ch.raw = { on: drag.raw0.on + step, off: drag.raw0.off + step };
        } else {
          ch.on = sig3(drag.on0 * shift);
          ch.off = sig3(drag.off0 * shift);
        }
      } else {
        setEdge(ch, /** @type {"on" | "off"} */ (edge), p);
      }
      hoverP = null;
      schedule(false);
      return;
    }
    hoverP = y >= PAD.top && y <= PAD.top + PLOT_H ? pOf(y) : null;
    schedule(false, true);
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    plotHost.classList.remove("dragging");
    if (needsRefit()) fit();
    schedule(true);
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("pointerleave", () => {
    if (drag) return;
    hoverP = null;
    schedule(false, true);
  });
  svg.addEventListener("wheel", (e) => {
    const target = /** @type {Element} */ (e.target);
    const ch = channels.find((c) => c.index === Number(target.getAttribute("data-ch")));
    const edge = target.getAttribute("data-edge");
    if (!ch || (edge !== "on" && edge !== "off")) return;
    e.preventDefault();
    nudge(ch, edge, e.deltaY < 0 ? 1 : -1);
    schedule(true);
  }, { passive: false });
  svg.addEventListener("keydown", (e) => {
    const target = /** @type {Element} */ (e.target);
    const ch = channels.find((c) => c.index === Number(target.getAttribute("data-ch")));
    const edge = target.getAttribute("data-edge");
    if (!ch || (edge !== "on" && edge !== "off")) return;
    if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(e.key)) return;
    e.preventDefault();
    const steps = (e.key.startsWith("Page") ? 10 : 1) * (e.key.endsWith("Up") ? 1 : -1);
    nudge(ch, edge, steps);
    focus = ch.index;
    renderAll(false);
    requestAnimationFrame(() => /** @type {SVGElement | null} */ (svg.querySelector(`.hit[data-ch="${ch.index}"][data-edge="${edge}"]`))?.focus());
  });

  let frame = 0;
  let pendingControls = false;
  /** @param {boolean} withControls @param {boolean} [plotOnlyReadout] */
  function schedule(withControls, plotOnlyReadout = false) {
    pendingControls = pendingControls || withControls || !plotOnlyReadout;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawPlot();
      if (pendingControls) syncControls();
      pendingControls = false;
    });
  }

  /** @param {boolean} [refit] */
  function renderAll(refit = true) {
    if (refit && needsRefit()) fit();
    drawPlot();
    syncControls();
  }

  // ------------------------------------------------------------------------------------------
  // Gauge I/O

  const footerNote = h("span.sp-footer-note");
  const readButton = /** @type {HTMLButtonElement} */ (h("button.button", { type: "button" }, "Read from gauge"));
  const revertButton = /** @type {HTMLButtonElement} */ (h("button.button", { type: "button", title: "Discard edits and show what the gauge last reported" }, "Revert"));
  const fitButton = /** @type {HTMLButtonElement} */ (h("button.button", { type: "button", title: "Rescale the plot around the setpoints" }, "Fit view"));
  const applyButton = /** @type {HTMLButtonElement} */ (h("button.button.primary", { type: "button" }, "Apply to gauge…"));

  async function read(showToast = true) {
    busy = true;
    readButton.disabled = true;
    readButton.textContent = "Reading…";
    try {
      const { errors } = await readSetpoints(app, d, layout);
      loadFromDevice();
      fit();
      renderAll(false);
      if (errors.length) toast(`Some setpoint reads failed: ${errors.slice(0, 3).join("; ")}`, "warn", 8000);
      else if (showToast) toast("Setpoints read from the gauge.");
    } finally {
      busy = false;
      readButton.disabled = false;
      readButton.textContent = "Read from gauge";
      syncControls();
    }
  }

  /** Writes for one channel, ordered so the gauge never sees the release level on the wrong side of the switch-on level. @param {any} ch */
  function writesFor(ch) {
    /** @type {{ command: string, value: any, label: string, display: string }[]} */
    const items = [];
    const old = ch.gauge;
    if (cdg) {
      const on = { command: ch.commands.low, value: ch.raw.on, label: `SP${ch.index} switch on (low)`, display: `${ch.raw.on} ≈ ${fmtP(cdgRawToMbar(ch.raw.on, fs()))}` };
      const off = { command: ch.commands.high, value: ch.raw.off, label: `SP${ch.index} switch off (high)`, display: `${ch.raw.off} ≈ ${fmtP(cdgRawToMbar(ch.raw.off, fs()))}` };
      const wantOn = !old || old.raw?.on !== ch.raw.on;
      const wantOff = !old || old.raw?.off !== ch.raw.off;
      const raising = old?.raw ? ch.raw.on > old.raw.off : false;
      for (const item of raising ? [off, on] : [on, off]) if ((item === on && wantOn) || (item === off && wantOff)) items.push(item);
      return items;
    }
    const gu = gaugeUnit(d);
    const reg = bandToPpg({ on: ch.on, off: ch.off }, mode);
    const inGauge = (/** @type {number} */ mbar) => formatSetpointValue(convertPressure(mbar, "mbar", gu));
    if (ch.commands.direction && (!old || old.direction !== ch.direction)) items.push({ command: ch.commands.direction, value: ch.direction.toUpperCase(), label: `SP${ch.index} direction`, display: ch.direction.toUpperCase() });
    const value = { command: ch.commands.value, value: inGauge(reg.value), label: `SP${ch.index} setpoint`, display: `${inGauge(reg.value)} ${gu}` };
    const hyst = ch.commands.hysteresis ? { command: ch.commands.hysteresis, value: inGauge(reg.hysteresis), label: `SP${ch.index} hysteresis`, display: `${inGauge(reg.hysteresis)} ${gu}${mode === "offset" ? " (offset)" : " (release)"}` } : null;
    const oldReg = old ? bandToPpg({ on: old.on, off: old.off }, mode) : null;
    const wantValue = !oldReg || !close(oldReg.value, reg.value);
    const wantHyst = hyst && (!oldReg || !close(oldReg.hysteresis, reg.hysteresis));
    const beyondOldRelease = old && mode === "absolute" && (ch.direction === "above" ? ch.on < old.off : ch.on > old.off);
    for (const item of beyondOldRelease ? [hyst, value] : [value, hyst]) {
      if (!item) continue;
      if ((item === value && wantValue) || (item === hyst && wantHyst)) items.push(item);
    }
    if (ch.commands.enable && (!old || old.enabled !== ch.enabled)) items.push({ command: ch.commands.enable, value: ch.enabled ? "ON" : "OFF", label: `SP${ch.index} enable`, display: ch.enabled ? "ON" : "OFF" });
    return items;
  }

  async function apply() {
    const items = channels.filter(changed).flatMap(writesFor);
    if (!items.length) return toast("Nothing changed.");
    busy = true;
    applyButton.disabled = true;
    try {
      const results = await app.writeBatch(d, items, {
        title: `Write setpoints to ${d.label}`,
        description: `${items.length} write${items.length === 1 ? "" : "s"} to ${d.model}. Setpoint relays switch as soon as the new levels take effect.`,
        notes: cdg
          ? ["🟠 V7: the CDG setpoint byte encoding (cube law of the full scale, as in CSC) is still to be checked against TIRA49E1. Check the relay levels on the gauge after writing."]
          : [`Hysteresis written as ${mode === "absolute" ? "the absolute release pressure" : "an offset from the setpoint"} (🟠 V14, check the PPG manual). Values are sent in ${gaugeUnit(d)}, the gauge's last reported unit.`]
      });
      if (!results) return;
      const failed = results.filter((/** @type {any} */ r) => r.entry.error);
      await read(false);
      const mismatch = channels.filter(changed);
      if (failed.length) toast(`${failed.length} write(s) failed: ${failed.map((/** @type {any} */ f) => `${f.command}: ${f.entry.error}`).slice(0, 3).join("; ")}`, "bad", 10000);
      else if (mismatch.length) toast(`Written, but the read-back of SP${mismatch.map((m) => m.index).join(", SP")} differs from what was sent. Check the gauge.`, "warn", 10000);
      else toast("Setpoints written and verified by read-back.");
    } finally {
      busy = false;
      syncControls();
    }
  }

  readButton.onclick = () => void read();
  revertButton.onclick = () => {
    loadFromDevice();
    fit();
    renderAll(false);
  };
  fitButton.onclick = () => {
    fit();
    renderAll(false);
  };
  applyButton.onclick = () => void apply();

  // ------------------------------------------------------------------------------------------
  // Live pressure and relay state from the gauge's own readings.

  function sampleLive() {
    const last = d.last;
    const next = last && Number.isFinite(last.value) && isPressureUnit(last.unit) ? convertPressure(last.value, last.unit, "mbar") : null;
    if (next == null) return;
    for (const ch of channels) ch.live = relayStep(ch.live, next, band(ch));
    if (next !== live) {
      live = next;
      schedule(true);
    }
  }
  const liveTimer = setInterval(sampleLive, 300);

  loadFromDevice();
  buildControls();
  const resize = new ResizeObserver(() => schedule(false));
  openDialog("setpointDialog", {
    title: `Setpoints — ${d.label}`,
    body: [
      h("div.callout", null,
        h("strong", null, "How to read this. "),
        cdg
          ? "Each relay switches on when the pressure falls to its low level and off when it rises back to its high level. Between the two lines (the shaded band) it keeps whatever state it had. The curve and the lanes underneath show that on a typical cycle."
          : "Each relay switches on when the pressure crosses its setpoint in the chosen direction, and releases at the hysteresis level. Between the two lines (the shaded band) it keeps whatever state it had. The curve and the lanes underneath show that on a typical cycle."),
      h("div.sp-editor", null, controls, h("div.sp-plot-wrap", null, plotHost, readout, legend))
    ],
    actions: [footerNote, fitButton, revertButton, readButton, applyButton],
    onClose: () => {
      clearInterval(liveTimer);
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    }
  });
  sampleLive();
  fit();
  requestAnimationFrame(() => {
    renderAll(false);
    resize.observe(plotHost);
  });
  // Always start from what the gauge holds now; these are safe reads.
  void read(false);
}

/** @param {number} a @param {number} b */
function close(a, b) {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 5e-3;
}

/** @param {number} v */
function r1(v) {
  return Math.round(v * 10) / 10;
}

/** @param {string} s */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
