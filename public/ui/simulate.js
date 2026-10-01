// @ts-check
/**
 * Simulation UI (WEB_PORT_PLAN.md section 10): add simulated gauges that answer real frames
 * through an EmulatedPort, and a Simulation tab with the chamber inputs CSC exposes (scenario,
 * gas type, humidity, leak rate, base pressure) plus pause, restart and speed.
 */
import { h, replace, openDialog, closeDialog, toast } from "./dom.js";
import { FS_TORR, FS_MBAR } from "./add-gauge.js";
import { bindRowSelection } from "./multi-select.js";
import { FAMILY_LABELS } from "../core/registry/registry.js";
import { formatPressure } from "../core/codecs/common.js";

/** Models the protocol emulators can answer for. */
export const SIMULATABLE = ["CDG025D", "CDG045D", "CDG100D", "CDG160D", "CDG200D", "PCG550", "PSG550", "PPG550", "PPG570", "BCG450", "OPG550", "TC600"];
const GASES = ["N2", "AR", "HE", "CO2"];
const HUMIDITY = ["LOW", "MEDIUM", "HIGH"];

/**
 * Add one or more simulated gauges. Models are picked from a list with the same multi-select
 * as the Add Gauge results (click, Ctrl-click, Shift-click, drag, or the checkboxes); every
 * selected CDG gets the chosen full scale.
 * @param {any} app
 */
export function openSimulate(app) {
  const items = SIMULATABLE.filter((m) => app.registry.has(m)).map((model) => ({ model, selected: model === "CDG045D" }));
  const fsOptions = [...FS_TORR, ...FS_MBAR];
  let fs = FS_TORR.find((o) => o.value === 10) ?? fsOptions[0];
  const fsSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "CDG full scale" },
    fsOptions.map((o, i) => h("option", { value: String(i) }, `${o.value} ${o.unit} (${o.mbar} mbar)`))));
  fsSelect.value = String(fsOptions.indexOf(fs));
  fsSelect.onchange = () => (fs = fsOptions[Number(fsSelect.value)]);
  const fsField = h("label.field", null, h("span.field-label", null, "Full scale for the simulated CDGs"), fsSelect);
  const add = /** @type {HTMLButtonElement} */ (h("button.button.primary", { type: "button" }));

  const rows = items.map((it) => {
    const spec = app.registry.get(it.model);
    const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: it.selected, "aria-label": `Select ${it.model}` }));
    const row = h("tr", null, h("td", null, box), h("td", null, h("strong", null, it.model)), h("td.hint", null, FAMILY_LABELS[/** @type {keyof typeof FAMILY_LABELS} */ (spec.protocol)] ?? spec.protocol), h("td", null, spec.experimental ? h("span.chip.warn", null, "experimental") : null));
    return { row, box };
  });
  const refresh = () => {
    const chosen = items.filter((x) => x.selected);
    fsField.hidden = !chosen.some((x) => x.model.startsWith("CDG"));
    add.disabled = !chosen.length;
    add.textContent = chosen.length > 1 ? `Add ${chosen.length} simulated gauges` : "Add simulated gauge";
  };
  bindRowSelection(rows, items, refresh);
  refresh();

  add.onclick = async () => {
    const chosen = items.filter((x) => x.selected);
    add.disabled = true;
    let failed = 0;
    for (const it of chosen) {
      try {
        await app.addSimulatedDevice({ model: it.model, fullScale: it.model.startsWith("CDG") ? { ...fs, origin: "user" } : null });
      } catch (error) {
        failed += 1;
        toast(`${it.model}: ${/** @type {Error} */ (error).message}`, "bad");
      }
    }
    if (chosen.length > 1 && !failed) toast(`${chosen.length} simulated gauges added.`);
    if (!failed) closeDialog("simulateDialog");
    else refresh();
  };
  openDialog("simulateDialog", {
    body: [
      h("div.scroll.sim-models", null, h("table.data", null, h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Model"), h("th", null, "Protocol"), h("th", null, ""))), h("tbody", null, rows.map((r) => r.row)))),
      h("p.hint", null, "Click a model to select it, Ctrl-click to add or remove one, Shift-click or drag to select a range."),
      fsField,
      h("p.hint", null, "Each simulated gauge runs the real codec, framer and scheduler against a protocol emulator, so everything you see, terminal bytes included, is what the real gauge would exchange. A CDG reading is gas-type independent; Pirani readings are not.")
    ],
    actions: [h("button.button", { type: "button", onclick: () => closeDialog("simulateDialog") }, "Cancel"), add]
  });
}

/**
 * The Simulation tab.
 * @param {any} app
 */
export class SimulationTab {
  /** @param {any} app */
  constructor(app) {
    this.app = app;
    this.el = h("div.panel", { role: "tabpanel" });
    this.stateEl = h("div.value-card");
    this.build();
  }

  build() {
    const sim = this.app.simulation();
    const s = sim.state();
    const select = (/** @type {string} */ label, /** @type {string[] | [string, string][]} */ options, /** @type {string} */ value, /** @type {(v: string) => void} */ onChange) => {
      const el = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": label }, options.map((o) => (Array.isArray(o) ? h("option", { value: o[0] }, o[1]) : h("option", { value: o }, o)))));
      el.value = value;
      el.onchange = () => onChange(el.value);
      return h("label.field", null, h("span.field-label", null, label), el);
    };
    const number = (/** @type {string} */ label, /** @type {number} */ value, /** @type {(v: number) => void} */ onChange) => {
      const el = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: String(value), style: { width: "120px" } }));
      el.onchange = () => {
        const v = Number(el.value);
        if (Number.isFinite(v) && v > 0) onChange(v);
        else toast(`${label} must be a positive number`, "warn");
      };
      return h("label.field", null, h("span.field-label", null, label), el);
    };
    const set = (/** @type {any} */ patch) => {
      try {
        sim.setInputs(patch);
        this.app.markDirty();
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "bad");
      }
    };
    replace(this.el,
      h("div.card", null, h("h3.card-title", null, "Chamber"), this.stateEl),
      h("div.card", null,
        h("h3.card-title", null, "Inputs"),
        h("div.grid-2", null,
          select("Scenario", sim.listScenarios().map((/** @type {any} */ x) => [x.id, x.label]), s.scenario ?? "", (v) => set({ scenario: v })),
          select("Gas type", GASES, s.gas, (v) => set({ gas: v })),
          select("Humidity", HUMIDITY, s.humidity, (v) => set({ humidity: v })),
          number("Base pressure (mbar)", s.basePressureMbar, (v) => set({ baseMbar: v, resetClock: false })),
          number("Leak rate (mbar·L/s)", s.leakRateMbarLS, (v) => set({ leakRate: v, resetClock: false })),
          select("Speed", [["1", "1× real time"], ["10", "10×"], ["60", "60×"]], "1", (v) => sim.setSpeed(Number(v)))),
        h("div.row", { style: { marginTop: "10px" } },
          h("button.button", { type: "button", onclick: () => (sim.state().paused ? sim.resume() : sim.pause()) }, "Pause / resume"),
          h("button.button", { type: "button", onclick: () => sim.restart() }, "Restart scenario"),
          h("button.button", { type: "button", onclick: () => openSimulate(this.app) }, "Add simulated gauge")),
        h("p.hint", null, "Scenario descriptions: ", ...sim.listScenarios().map((/** @type {any} */ x) => h("span", null, h("b", null, `${x.label}: `), `${x.description} `)))));
    this.update();
  }

  update() {
    const s = this.app.simulation().state();
    replace(this.stateEl,
      h("div", null,
        h("div.value-main", null, formatPressure(s.pressureMbar, "mbar").split(" ")[0], h("span.unit", null, "mbar")),
        h("div.value-sub", null, `true chamber pressure · t = ${s.elapsedS.toFixed(1)} s · ${s.pattern} · ${s.gas} · humidity ${s.humidity}${s.paused ? " · paused" : ""}`)),
      h("div.value-meta", null, h("div", null, `trend ${s.trendMbarPerS.toExponential(2)} mbar/s`), h("div", null, `${s.registeredCount} simulated gauge(s)`)));
  }

  destroy() {}
}
