// @ts-check
/**
 * Simulation UI (WEB_PORT_PLAN.md section 10): add simulated gauges that answer real frames
 * through an EmulatedPort, and a Simulation tab with the chamber inputs CSC exposes (scenario,
 * gas type, humidity, leak rate, base pressure) plus pause, restart and speed.
 */
import { h, replace, openDialog, closeDialog, toast } from "./dom.js";
import { fullScalePicker, FS_TORR } from "./add-gauge.js";
import { formatPressure } from "../core/codecs/common.js";

/** Models the protocol emulators can answer for. */
export const SIMULATABLE = ["CDG025D", "CDG045D", "CDG100D", "CDG160D", "CDG200D", "PCG550", "PSG550", "PPG550", "PPG570", "BCG450", "OPG550", "TC600"];
const GASES = ["N2", "AR", "HE", "CO2"];
const HUMIDITY = ["LOW", "MEDIUM", "HIGH"];

/** @param {any} app */
export function openSimulate(app) {
  const c = { model: "CDG045D", fullScale: FS_TORR.find((o) => o.value === 10) ?? null, fullScaleConfirmed: true };
  const body = h("div");
  const render = () => {
    const model = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Model" }, SIMULATABLE.filter((m) => app.registry.has(m)).map((m) => h("option", { value: m }, m))));
    model.value = c.model;
    model.onchange = () => {
      c.model = model.value;
      render();
    };
    const isCdg = c.model.startsWith("CDG");
    replace(body,
      h("label.field", null, h("span.field-label", null, "Gauge model"), model),
      isCdg ? fullScalePicker(c, render) : null,
      h("p.hint", null, "The simulated gauge runs the real codec, framer and scheduler against a protocol emulator, so everything you see — terminal bytes included — is what the real gauge would exchange. A CDG reading is gas-type independent; Pirani readings are not."));
  };
  render();
  const add = h("button.button.primary", { type: "button", onclick: async () => {
    if (c.model.startsWith("CDG") && !c.fullScale) return toast("Choose a full scale.", "warn");
    try {
      await app.addSimulatedDevice({ model: c.model, fullScale: c.fullScale ? { ...c.fullScale, origin: "user" } : null });
      closeDialog("simulateDialog");
    } catch (error) {
      toast(/** @type {Error} */ (error).message, "bad");
    }
  } }, "Add simulated gauge");
  openDialog("simulateDialog", { body: [body], actions: [h("button.button", { type: "button", onclick: () => closeDialog("simulateDialog") }, "Cancel"), add] });
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
