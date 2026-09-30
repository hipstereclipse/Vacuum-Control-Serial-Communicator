// @ts-check
/**
 * OPG550 Spectrum Studio (WEB_PORT_PLAN.md parity row 17), the browser port of CSC's
 * `OPG550SpectrumStudio` workspace. The data model is core/opg/spectrum-studio.js; this module
 * draws it and wires the controls.
 *
 *  Left:  the chart for the chosen main plot (Advanced correlation, Rate of Rise, Raw
 *         spectrum, Tracked gases), each with its own CSV export, and one shared hover bar
 *         whose x reading is always first, at the far left.
 *  Right: plasma ignition (thresholds shown in the display unit, stored and evaluated in
 *         mbar), analysis controls and acquisition, tracked gases, one-shot actions,
 *         telemetry, vacuum regime and device details.
 *
 * Nothing here writes to the gauge without a click and the usual confirmation: plasma and
 * algorithm writes go through app.sendCommand / app.writeBatch, and the pressure thresholds
 * only raise a prompt (core/opg/spectrum-studio.js explains the difference from CSC).
 */
import { h, replace, toast, download, formatClock } from "./dom.js";
import { XYChart, XView } from "./xy-chart.js";
import {
  ALGORITHM_LABELS,
  ANALYSIS_MODES,
  COUNT_FOR_RECORD,
  ENABLE_FOR_RECORD,
  GAUGE_RANGE_MBAR,
  POLL_GROUPS,
  SNAPSHOT_COMMANDS,
  SPECTRUM_MODE_DESCRIPTIONS,
  STATE_FOR_RECORD,
  STUDIO_GASES,
  TELEMETRY_COMMANDS,
  WAVELENGTH_MAX_NM,
  WAVELENGTH_MIN_NM,
  deltaSummary,
  formatSci,
  lastValid,
  pressureDeltaPercent,
  seriesValueAt,
  vacuumQuality,
  vacuumScore
} from "../core/opg/spectrum-studio.js";
import { advancedCsv, gasCsv, opgCsv, spectrumCsv, trendCsv } from "../core/opg/export.js";
import { SpectrumMode, opticalSignatureWavelengths } from "../core/sim/opg-spectrum.js";
import { convertPressure, isPressureUnit } from "../core/units.js";

/** Categorical gas colours, readable on the light and the dark chart background. */
export const GAS_COLORS = Object.freeze({
  OH: "#e15759", H2O: "#4e79a7", H2: "#b07aa1", N2: "#c9a227", O2: "#59a14f",
  Ar: "#f28e2b", He: "#3fa7a0", CO: "#9c755f", CO2: "#8c8c8c", CH4: "#e377c2"
});
const COLOR_A = "--info";
const COLOR_B = "#8e6bbf";
const COLOR_PRESSURE = "--info";
const COLOR_ROR = "--accent";
const COLOR_SIMULATED = "#f28e2b";
const BAND = "rgba(225, 87, 89, 0.16)";
const SELF = "self";

export class SpectrumStudio {
  /** @param {any} app @param {any} device */
  constructor(app, device) {
    this.app = app;
    this.d = device;
    /** @type {import("../core/opg/spectrum-studio.js").OpgStudioState} */
    this.s = device.opg;
    this.timeView = new XView();
    this.spectrumView = new XView();
    /** @type {Record<string, "log" | "linear">} */
    this.scales = { advanced: "log", gas: "linear" };
    /** @type {Record<string, string>} */
    this.keys = {};
    this.hoverBar = h("div.studio-hoverbar", { "aria-live": "off" });
    this.el = h("div.studio");
    this.build();
    this.clearHover();
  }

  destroy() {
    for (const c of Object.values(this.charts ?? {})) c.destroy();
    this.el.remove();
  }

  /** The studio became visible: CSC reads pressure and plasma state once (safe reads). */
  shown() {
    for (const c of ["pressure", "plasma_state"]) if (this.has(c)) this.app.query(this.d, c).catch(() => {});
  }

  /** @param {string} name */
  has(name) {
    return Boolean(this.d.spec.commands?.[name]);
  }

  unit() {
    const u = this.app.displayUnit();
    return isPressureUnit(u) ? u : "mbar";
  }

  /** mbar -> display unit factor (pressure conversion is multiplicative). */
  factor() {
    return convertPressure(1, "mbar", this.unit());
  }

  t0() {
    return this.s.t0 ?? this.s.pressure.t[0] ?? Date.now();
  }

  /** Pressure sources for the comparison: this OPG550 (spike-filtered) and every pressure series of every device. */
  sources() {
    const d = this.d;
    const out = [{ id: SELF, name: `${d.label} (this gauge, spike-filtered)`, series: this.s.pressure }];
    for (const other of this.app.state.devices.values()) {
      for (const [command, series] of other.series) {
        if (!isPressureUnit(series.unit) || (other === d && command === "pressure")) continue;
        out.push({ id: `${other.id}:${command}`, name: command === other.primaryCommand ? other.label : `${other.label} – ${command}`, series });
      }
    }
    return out;
  }

  /** The two compared sources; defaults are this OPG550 and the first other source with a valid reading. */
  compared() {
    const list = this.sources();
    const s = this.s;
    if (!list.some((x) => x.id === s.compareA)) s.compareA = SELF;
    if (!list.some((x) => x.id === s.compareB)) {
      const others = list.filter((x) => x.id !== s.compareA);
      s.compareB = (others.find((x) => lastValid(x.series)) ?? others[0])?.id ?? "";
    }
    return { list, a: list.find((x) => x.id === s.compareA) ?? null, b: list.find((x) => x.id === s.compareB) ?? null };
  }

  // -------------------------------------------------------------------------------------------
  // Layout

  build() {
    this.charts = {};
    const card = (/** @type {string} */ title, /** @type {any[]} */ tools, /** @type {any[]} */ body) =>
      h("section.card.studio-chart", null, h("h3.card-title", null, title, h("div.grow"), ...tools), ...body);
    const resetBtn = (/** @type {XView} */ view) => {
      const b = /** @type {HTMLButtonElement} */ (h("button.button.tiny", { type: "button", title: "Reset zoom (or double-click the chart)", onclick: () => view.set(null) }, "Reset zoom"));
      view.listeners.add(() => (b.hidden = view.range == null));
      b.hidden = true;
      return b;
    };
    const scaleToggle = (/** @type {"advanced" | "gas"} */ key) => {
      const seg = h("div.segmented", { role: "group", "aria-label": "Left axis scale" });
      const sync = () => {
        for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.scale === this.scales[key]));
      };
      for (const s of ["log", "linear"]) {
        seg.append(h("button", { type: "button", dataset: { scale: s }, onclick: () => {
          this.scales[key] = /** @type {any} */ (s);
          sync();
          this.charts[key].draw(true);
        } }, s === "log" ? "Log" : "Linear"));
      }
      sync();
      return seg;
    };
    const exportBtn = (/** @type {string} */ label, /** @type {() => void} */ fn) => h("button.button.tiny", { type: "button", onclick: fn }, label);

    // Advanced correlation.
    this.charts.advanced = new XYChart({
      view: this.timeView, height: 240, label: "Pressure correlation of two sources",
      getKey: () => this.advancedKey(), getModel: () => this.advancedModel(), onHover: (x) => this.hover("advanced", x)
    });
    this.legendAB = h("div.studio-legend");
    this.deltaLine = h("div.studio-delta");
    this.advancedCard = card("Advanced gauge correlation", [scaleToggle("advanced"), resetBtn(this.timeView), exportBtn("Export CSV", () => this.exportAdvanced())],
      [this.legendAB, this.charts.advanced.el, this.deltaLine]);

    // Rate of rise.
    this.charts.trend = new XYChart({
      view: this.timeView, height: 240, label: "Rate of rise and OPG550 pressure",
      getKey: () => this.trendKey(), getModel: () => this.trendModel(), onHover: (x) => this.hover("trend", x)
    });
    this.rorLine = h("div.hint");
    this.trendCard = card("Rate of rise / OPG550 pressure", [resetBtn(this.timeView), exportBtn("Export CSV", () => this.exportTrend())], [this.charts.trend.el, this.rorLine]);

    // Spectrum.
    this.charts.spectrum = new XYChart({
      view: this.spectrumView, height: 250, label: "Optical spectrum",
      getKey: () => this.spectrumKey(), getModel: () => this.spectrumModel(), onHover: (x) => this.hover("spectrum", x)
    });
    const modeSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Plot options" },
      Object.values(SpectrumMode).map((m) => h("option", { value: m }, m === SpectrumMode.AUTO ? "Live Data" : `${m} (simulated)`))));
    modeSelect.value = this.s.spectrumMode;
    this.spectrumDesc = h("p.hint.studio-desc");
    modeSelect.onchange = () => {
      this.s.setSpectrumMode(modeSelect.value);
      this.update();
    };
    this.spectrumChip = h("span.chip.plain");
    this.spectrumCard = card("Raw optical spectrum", [this.spectrumChip, h("label.row.hint", null, "Plot options", modeSelect), resetBtn(this.spectrumView), exportBtn("Export CSV", () => this.exportSpectrum())],
      [this.spectrumDesc, this.charts.spectrum.el]);

    // Tracked gases.
    this.charts.gas = new XYChart({
      view: this.timeView, height: 210, label: "Tracked gas partial pressures",
      getKey: () => this.gasKey(), getModel: () => this.gasModel(), onHover: (x) => this.hover("gas", x)
    });
    this.gasCard = card("Tracked gas analysis", [scaleToggle("gas"), resetBtn(this.timeView), exportBtn("Export CSV", () => this.exportGas())], [this.charts.gas.el]);

    const left = h("div.studio-charts", null, this.advancedCard, this.trendCard, this.spectrumCard, this.gasCard, this.hoverBar);
    const right = h("div.studio-side", null, this.buildPlasma(), this.buildAnalysis(), this.buildGases(), this.buildActions(), this.buildHealth(), this.buildTelemetry());
    replace(this.el,
      h("div.studio-intro", null,
        h("div", null, h("h3", null, "Spectrum Studio"), h("p.hint", null, "OPG550 SPEC, RoR and RGD records, analog output, and pressure correlation with the other gauges in this session.")),
        this.d.spec.experimental ? h("span.chip.warn", { title: "P3 V02 record layouts are ported from CSC and not yet checked against the OPG550 communication manual (V13)" }, "record layouts unverified (V13)") : null),
      h("div.studio-body", null, left, right));
  }

  buildPlasma() {
    const d = this.d;
    this.plasmaStatus = h("div.studio-plasma-status");
    this.plasmaPrompt = h("div");
    const canWrite = this.has("plasma_enable");
    const on = h("button.button.small", { type: "button", disabled: !canWrite, onclick: () => this.plasma(1) }, "On…");
    const off = h("button.button.small", { type: "button", disabled: !canWrite, onclick: () => this.plasma(0) }, "Off…");
    const read = h("button.button.small", { type: "button", disabled: !this.has("plasma_state"), onclick: () => this.app.sendCommand(d, "plasma_state", undefined) }, "Read");
    const auto = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: this.s.plasma.autoEnabled, disabled: !(canWrite && this.has("plasma_state")) }));
    auto.onchange = () => {
      this.s.setPlasmaSettings({ autoEnabled: auto.checked });
      this.app.savePlasmaSettings(this.s);
      if (auto.checked && this.has("plasma_state")) this.app.query(d, "plasma_state").catch(() => {});
      this.update();
    };
    this.minInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputmode: "decimal", "aria-label": "Minimum ignition pressure", spellcheck: false }));
    this.maxInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputmode: "decimal", "aria-label": "Maximum safe pressure", spellcheck: false }));
    this.minUnit = h("span.hint");
    this.maxUnit = h("span.hint");
    const bindThreshold = (/** @type {HTMLInputElement} */ input, /** @type {"minMbar" | "maxMbar"} */ key) => {
      input.onchange = () => {
        const v = Number(input.value.replace(",", "."));
        if (!(v > 0)) {
          toast("Enter a positive pressure, for example 1e-6.", "warn");
        } else {
          this.s.setThresholdFrom(key, v, this.unit());
          this.app.savePlasmaSettings(this.s);
        }
        this.keys.thresholds = "";
        this.update();
      };
    };
    bindThreshold(this.minInput, "minMbar");
    bindThreshold(this.maxInput, "maxMbar");
    return h("section.card.studio-side-card", null,
      h("h3.card-title", null, "Plasma ignition"),
      this.plasmaStatus,
      h("div.row", null, on, off, read),
      this.plasmaPrompt,
      h("label.row.studio-check", null, auto, "Prompt me from the pressure (auto plasma)"),
      h("div.studio-thresholds", null,
        h("span.studio-label", null, "Min ignite"), h("div.row", null, this.minInput, this.minUnit),
        h("span.studio-label", null, "Max safe"), h("div.row", null, this.maxInput, this.maxUnit)),
      h("p.hint.studio-note", null, "Thresholds are shown in the display unit and stored and evaluated in mbar. CSC switches the plasma by itself; this tool never writes on its own, so it prompts you instead."));
  }

  buildAnalysis() {
    const s = this.s;
    this.modeSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Main plot" }, ANALYSIS_MODES.map((m) => h("option", { value: m }, m))));
    this.modeSelect.value = s.analysisMode;
    this.modeSelect.onchange = () => {
      s.setAnalysisMode(this.modeSelect.value);
      this.keys = {};
      this.clearHover();
      this.update();
    };
    this.selectA = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Compare A" }));
    this.selectB = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Compare B" }));
    this.selectA.onchange = () => {
      s.compareA = this.selectA.value;
      this.update();
    };
    this.selectB.onchange = () => {
      s.compareB = this.selectB.value;
      this.update();
    };
    this.gasSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Right axis gas" }, STUDIO_GASES.map((g) => h("option", { value: g }, g))));
    this.gasSelect.value = s.correlationGas;
    this.gasSelect.onchange = () => {
      s.correlationGas = this.gasSelect.value;
      this.update();
    };
    this.compareRows = h("div.studio-form", null,
      h("label", null, "Compare A"), this.selectA,
      h("label", null, "Compare B"), this.selectB,
      h("label", null, "Right axis gas"), this.gasSelect);
    this.modeStatus = h("p.hint");
    this.acqStatus = h("div.studio-acq-status");
    this.startButton = /** @type {HTMLButtonElement} */ (h("button.button.small.primary", { type: "button", onclick: () => this.startAlgorithm() }, "Start"));
    const stop = h("button.button.small", { type: "button", disabled: !this.has("all_algorithms_off"), onclick: () => this.stopAlgorithms() }, "Stop all…");
    const acquire = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: this.d.opgAcquire !== false }));
    acquire.onchange = () => {
      this.d.opgAcquire = acquire.checked;
      this.update();
    };
    return h("section.card.studio-side-card", null,
      h("h3.card-title", null, "Analysis"),
      h("div.studio-form", null, h("label", null, "Main plot"), this.modeSelect),
      this.compareRows,
      this.modeStatus,
      h("div.studio-subtitle", null, "Acquisition"),
      this.acqStatus,
      h("div.row", null, this.startButton, stop),
      h("label.row.studio-check", null, acquire, "Read state, record count and the latest record every 2 s (reads only)"));
  }

  buildGases() {
    this.gasBoxes = {};
    const grid = h("div.studio-gases");
    for (const g of STUDIO_GASES) {
      const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: this.s.trackedGases.has(g) }));
      box.onchange = () => {
        this.s.setTracked(g, box.checked);
        this.keys = {};
        this.update();
      };
      this.gasBoxes[g] = box;
      grid.append(h("label.studio-gas", null, box, h("span.swatch", { style: { background: GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (g)] } }), g));
    }
    return h("section.card.studio-side-card", null, h("h3.card-title", null, "Track gases"), grid,
      h("p.hint.studio-note", null, "In Raw Spectrum, tracked gases mark their signature lines; in Residual Gas Detection and Advanced Analysis they add the tracked-gas chart."));
  }

  buildActions() {
    const d = this.d;
    const reads = async (/** @type {string} */ label, /** @type {readonly string[]} */ commands) => {
      const list = commands.filter((c) => this.has(c) && d.spec.commands[c].read);
      let failed = 0;
      for (const c of list) {
        try {
          const e = await this.app.query(d, c);
          if (e.error) failed += 1;
        } catch {
          failed += 1;
        }
      }
      toast(`${label}: ${list.length - failed} of ${list.length} reads answered.`, failed ? "warn" : "ok");
      this.update();
    };
    const buttons = [
      h("button.button.small", { type: "button", title: "Read the state, counts and latest record for the main plot once (reads only)", onclick: () => reads("Poll mode", POLL_GROUPS[/** @type {keyof typeof POLL_GROUPS} */ (this.s.analysisMode)] ?? ["pressure"]) }, "Poll mode"),
      h("button.button.small", { type: "button", title: "Read every identity, status and record command once (reads only)", onclick: () => reads("Snapshot", SNAPSHOT_COMMANDS) }, "Snapshot all"),
      h("button.button.small", { type: "button", title: "OPG CSV in CSC's layout: RoR for the Rate of Rise plot, RGD otherwise", onclick: () => this.exportOpg() }, "Export OPG CSV")
    ];
    for (const [label, command] of [["Read error", "error_status"], ["Read firmware", "software_version"], ["Read serial", "serial_number"], ["Analog out", "analog_output_voltage"]]) {
      if (this.has(command)) buttons.push(h("button.button.small", { type: "button", onclick: () => this.app.sendCommand(d, command, undefined) }, label));
    }
    return h("section.card.studio-side-card", null, h("h3.card-title", null, "Actions"), h("div.studio-actions", null, buttons));
  }

  buildHealth() {
    this.healthPressure = h("div.studio-metric");
    this.healthMeter = h("span");
    this.healthQuality = h("div.hint");
    this.moleculeLine = h("p.studio-molecules");
    return h("section.card.studio-side-card", null,
      h("h3.card-title", null, "Vacuum regime"),
      this.healthPressure,
      h("div.meter", { title: "1E+3 to 1E-9 mbar on a log scale" }, this.healthMeter),
      this.healthQuality,
      this.moleculeLine);
  }

  buildTelemetry() {
    this.telemetryList = h("dl.info-list");
    this.detailsList = h("dl.info-list");
    return h("section.card.studio-side-card", null,
      h("h3.card-title", null, "Telemetry"), this.telemetryList,
      h("div.studio-subtitle", null, "Device details"), this.detailsList);
  }

  // -------------------------------------------------------------------------------------------
  // Chart models

  /** @param {import("../core/store/buffers.js").Series} series */
  convertFrom(series) {
    const unit = this.unit();
    const from = isPressureUnit(series.unit) ? series.unit : "mbar";
    const k = convertPressure(1, from, unit);
    return (/** @type {number} */ v) => v * k;
  }

  pressureAxis() {
    const u = this.unit();
    return /** @type {import("./xy-chart.js").Axis} */ ({ scale: "log", label: `OPG pressure (${u})`, color: COLOR_PRESSURE, fixed: [convertPressure(GAUGE_RANGE_MBAR.min, "mbar", u), convertPressure(GAUGE_RANGE_MBAR.max, "mbar", u)] });
  }

  /** @returns {import("./xy-chart.js").Line} */
  pressureLine() {
    return { axis: "right", color: COLOR_PRESSURE, dash: [6, 4], width: 1.4, data: { series: this.s.pressure, t0: this.t0(), map: this.convertFrom(this.s.pressure) } };
  }

  xSeconds() {
    return (/** @type {number} */ x) => `${Number(x.toPrecision(6))} s`;
  }

  advancedKey() {
    const { a, b } = this.compared();
    const g = this.s.gasPartial[this.s.correlationGas];
    return [a?.id, a?.series.version, b?.id, b?.series.version, this.s.correlationGas, g?.version, this.unit(), this.scales.advanced].join(":");
  }

  advancedModel() {
    const { a, b } = this.compared();
    const t0 = this.t0();
    const gas = this.s.correlationGas;
    const u = this.unit();
    /** @type {import("./xy-chart.js").Line[]} */
    const lines = [];
    if (a) lines.push({ color: COLOR_A, data: { series: a.series, t0, map: this.convertFrom(a.series) } });
    if (b) lines.push({ color: COLOR_B, data: { series: b.series, t0, map: this.convertFrom(b.series) } });
    const f = this.factor();
    lines.push({ axis: "right", color: GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (gas)], width: 1.4, data: { series: this.s.gasPartial[gas], t0, map: (v) => v * f } });
    return {
      left: { scale: this.scales.advanced, label: `Pressure (${u})` },
      right: { scale: "linear", label: `${gas} partial pressure (${u}, linear)`, color: GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (gas)], includeZero: true },
      lines,
      band: a && b ? { a: 0, b: 1, color: BAND } : null,
      xLabel: this.xSeconds(),
      empty: "Waiting for pressure from the selected sources"
    };
  }

  trendKey() {
    const tracked = [...this.s.trackedGases].sort();
    return [this.s.pressure.version, tracked.join(","), ...tracked.map((g) => this.s.gasRate[g].version), this.unit()].join(":");
  }

  trendModel() {
    const t0 = this.t0();
    const f = this.factor();
    const u = this.unit();
    const tracked = STUDIO_GASES.filter((g) => this.s.trackedGases.has(g));
    /** @type {import("./xy-chart.js").Line[]} */
    const lines = tracked.length
      ? tracked.map((g) => ({ color: GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (g)], data: { series: this.s.gasRate[g], t0, map: (/** @type {number} */ v) => v * f } }))
      : [{ color: COLOR_ROR, data: { series: this.s.ror, t0, map: (/** @type {number} */ v) => v * f } }];
    lines.push(this.pressureLine());
    return { left: { scale: /** @type {"linear"} */ ("linear"), label: `Rate of rise (${u}/s)`, includeZero: true }, right: this.pressureAxis(), lines, xLabel: this.xSeconds(), empty: "Waiting for OPG550 pressure readings" };
  }

  spectrumKey() {
    const sp = this.s.spectrum;
    return [sp?.t, sp?.source, sp?.mode, this.s.lastPressureMbar, this.s.analysisMode, [...this.s.trackedGases].sort().join(","), this.unit()].join(":");
  }

  spectrumModel() {
    const sp = this.s.spectrum;
    /** @type {import("./xy-chart.js").Line[]} */
    const lines = [];
    if (sp) {
      lines.push({ color: sp.source === "live" ? "--info" : COLOR_SIMULATED, fill: true, data: { x: sp.x, y: sp.y } });
      if (this.s.lastPressureMbar != null) {
        const p = convertPressure(this.s.lastPressureMbar, "mbar", this.unit());
        lines.push({ axis: "right", color: COLOR_PRESSURE, dash: [6, 4], width: 1.4, data: { x: [WAVELENGTH_MIN_NM, WAVELENGTH_MAX_NM], y: [p, p] } });
      }
    }
    const markers = this.s.analysisMode === "Raw Spectrum"
      ? STUDIO_GASES.filter((g) => this.s.trackedGases.has(g)).flatMap((g) => opticalSignatureWavelengths(g).map((nm) => ({ x: nm, color: GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (g)], label: g })))
      : [];
    return {
      xDomain: /** @type {[number, number]} */ ([WAVELENGTH_MIN_NM, WAVELENGTH_MAX_NM]),
      xLabel: (/** @type {number} */ x) => `${Math.round(x)} nm`,
      left: { scale: /** @type {"linear"} */ ("linear"), label: "Relative optical intensity", includeZero: true },
      right: this.pressureAxis(),
      lines,
      markers,
      empty: this.s.spectrumMode === SpectrumMode.AUTO ? "Waiting for live spectrum data: switch the plasma on and start an algorithm" : "Waiting for an OPG550 pressure reading"
    };
  }

  gasKey() {
    const tracked = [...this.s.trackedGases].sort();
    return [this.s.pressure.version, tracked.join(","), ...tracked.map((g) => this.s.gasPartial[g].version), this.unit(), this.scales.gas].join(":");
  }

  gasModel() {
    const t0 = this.t0();
    const f = this.factor();
    const u = this.unit();
    /** @type {import("./xy-chart.js").Line[]} */
    const lines = STUDIO_GASES.filter((g) => this.s.trackedGases.has(g)).map((g) => ({ color: GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (g)], data: { series: this.s.gasPartial[g], t0, map: (/** @type {number} */ v) => v * f } }));
    lines.push(this.pressureLine());
    return { left: { scale: this.scales.gas, label: `Partial pressure (${u})`, includeZero: this.scales.gas === "linear" }, right: this.pressureAxis(), lines, xLabel: this.xSeconds(), empty: "Tracked gases appear once a spectrum is identified (below 1E-2 mbar)" };
  }

  // -------------------------------------------------------------------------------------------
  // Hover bar (CSC `_update_studio_value_bar`): x first, at the far left, always.

  clearHover() {
    replace(this.hoverBar, h("span.hb-x", null, h("b", null, "X"), ": —"), h("span.hint", null, "Hover a chart to read values at the cursor."));
  }

  /** @param {"advanced" | "trend" | "spectrum" | "gas"} chart @param {number | null} x */
  hover(chart, x) {
    for (const [name, c] of Object.entries(this.charts)) if (name !== chart && c.hoverX != null) {
      c.hoverX = null;
      c.draw(true);
    }
    if (x == null) return this.clearHover();
    const u = this.unit();
    const f = this.factor();
    /** @type {HTMLElement[]} */
    const parts = [];
    const part = (/** @type {string} */ color, /** @type {string} */ label, /** @type {string} */ value) =>
      parts.push(h("span.hb-part", null, h("b", { style: { color: color.startsWith("--") ? `var(${color})` : color } }, label), `: ${value}`));
    const t0 = this.t0();
    const t = t0 + x * 1000;
    const first = chart === "spectrum"
      ? h("span.hb-x", null, h("b", null, "X"), `: ${x.toFixed(1)} nm`)
      : h("span.hb-x", null, h("b", null, "X"), `: ${x.toFixed(1)} s`, h("span.hint", null, ` ${formatClock(t).slice(0, 8)}`));
    const pAt = () => seriesValueAt(this.s.pressure, t);

    if (chart === "spectrum") {
      const sp = this.s.spectrum;
      if (sp) {
        let i = 0;
        while (i < sp.x.length - 1 && sp.x[i] < x) i += 1;
        part(sp.source === "live" ? "--info" : COLOR_SIMULATED, "Wavelength", `${sp.x[i].toFixed(1)} nm`);
        part(sp.source === "live" ? "--info" : COLOR_SIMULATED, "Intensity", sp.y[i].toFixed(4));
      }
      if (this.s.lastPressureMbar != null) part(COLOR_PRESSURE, "OPG pressure (right axis)", `${formatSci(this.s.lastPressureMbar * f)} ${u}`);
    } else if (chart === "advanced") {
      const { a, b } = this.compared();
      const va = a ? seriesValueAt(a.series, t) : null;
      const vb = b ? seriesValueAt(b.series, t) : null;
      const A = va && a ? this.convertFrom(a.series)(va.v) : null;
      const B = vb && b ? this.convertFrom(b.series)(vb.v) : null;
      if (a && A != null) part(COLOR_A, a.name, `${formatSci(A)} ${u}`);
      if (b && B != null) part(COLOR_B, b.name, `${formatSci(B)} ${u}`);
      if (A != null && B != null) {
        const pct = pressureDeltaPercent(A, B);
        part("#e15759", "Δ(A−B)", `${formatSci(A - B, 3, true)} ${u}, Δ% = ${pct == null ? "n/a" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}`);
      }
      const gas = this.s.correlationGas;
      const g = seriesValueAt(this.s.gasPartial[gas], t);
      if (g) part(GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (gas)], `${gas} partial (right axis)`, `${formatSci(g.v * f)} ${u}`);
    } else if (chart === "trend") {
      const tracked = STUDIO_GASES.filter((gas) => this.s.trackedGases.has(gas));
      if (tracked.length) {
        for (const gas of tracked) {
          const r = seriesValueAt(this.s.gasRate[gas], t);
          if (r) part(GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (gas)], `${gas} RoR`, `${formatSci(r.v * f)} ${u}/s`);
        }
      } else {
        const r = seriesValueAt(this.s.ror, t);
        if (r) part(COLOR_ROR, "Rate of rise", `${formatSci(r.v * f)} ${u}/s`);
      }
      const p = pAt();
      if (p) part(COLOR_PRESSURE, "OPG pressure (right axis)", `${formatSci(p.v * f)} ${u}`);
    } else {
      for (const gas of STUDIO_GASES.filter((g) => this.s.trackedGases.has(g))) {
        const v = seriesValueAt(this.s.gasPartial[gas], t);
        if (v) part(GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (gas)], gas, `${formatSci(v.v * f)} ${u}`);
      }
      const p = pAt();
      if (p) part(COLOR_PRESSURE, "OPG pressure (right axis)", `${formatSci(p.v * f)} ${u}`);
    }
    replace(this.hoverBar, first, ...parts);
  }

  // -------------------------------------------------------------------------------------------
  // Update

  update() {
    const s = this.s;
    const vis = s.visibility();
    this.advancedCard.hidden = !vis.advanced;
    this.trendCard.hidden = !vis.trend;
    this.spectrumCard.hidden = !vis.spectrum;
    this.gasCard.hidden = !vis.gas;
    this.compareRows.hidden = s.analysisMode !== "Advanced Analysis";
    if (this.modeSelect.value !== s.analysisMode) this.modeSelect.value = s.analysisMode;
    setText(this.modeStatus, s.modeStatus);

    if (vis.advanced) this.updateAdvanced();
    if (vis.trend) setText(this.rorLine, s.gaugeRorText ? `Gauge-reported ${s.gaugeRorText.text.replace(/^RoR active; /, "")}` : "dP/dt is computed from consecutive spike-filtered OPG550 readings; the dashed line is the pressure on the right axis.");
    if (vis.spectrum) {
      const sp = s.spectrum;
      setText(this.spectrumDesc, SPECTRUM_MODE_DESCRIPTIONS[s.spectrumMode] ?? s.spectrumMode);
      setText(this.spectrumChip, !sp ? "no spectrum" : sp.source === "live" ? `live ${sp.command ?? ""}${sp.recordId != null ? ` #${sp.recordId}` : ""} · ${formatClock(sp.t).slice(0, 8)}` : "simulated");
      this.spectrumChip.className = `chip ${!sp ? "plain" : sp.source === "live" ? "ok" : "warn"}`;
    }
    for (const [name, c] of Object.entries(this.charts)) if (!(/** @type {any} */ (vis)[name] === false)) c.draw();

    this.updatePlasma();
    this.updateAcquisition();
    this.updateHealth();
    this.updateTelemetry();
  }

  updateAdvanced() {
    const { list, a, b } = this.compared();
    const key = list.map((x) => `${x.id}=${x.name}`).join("|");
    if (key !== this.keys.sources) {
      this.keys.sources = key;
      for (const [select, current] of [[this.selectA, this.s.compareA], [this.selectB, this.s.compareB]]) {
        replace(/** @type {HTMLSelectElement} */ (select), h("option", { value: "" }, "—"), ...list.map((x) => h("option", { value: x.id }, x.name)));
        /** @type {HTMLSelectElement} */ (select).value = /** @type {string} */ (current);
      }
    }
    const legendKey = `${a?.name}|${b?.name}|${this.s.correlationGas}`;
    if (legendKey !== this.keys.legend) {
      this.keys.legend = legendKey;
      const gas = this.s.correlationGas;
      replace(this.legendAB,
        a ? h("span", null, h("span.swatch", { style: { background: `var(${COLOR_A})` } }), `A: ${a.name}`) : null,
        b ? h("span", null, h("span.swatch", { style: { background: COLOR_B } }), `B: ${b.name}`) : null,
        h("span", null, h("span.swatch", { style: { background: GAS_COLORS[/** @type {keyof typeof GAS_COLORS} */ (gas)] } }), `${gas} partial pressure, right axis`));
    }
    const la = a ? lastValid(a.series) : null;
    const lb = b ? lastValid(b.series) : null;
    const u = this.unit();
    const summary = a && b && la && lb ? deltaSummary(this.convertFrom(a.series)(la.v), this.convertFrom(b.series)(lb.v), u) : null;
    setText(this.deltaLine, summary ? `${a?.name} − ${b?.name}:  ${summary.text}` : a && b ? "Δ: —" : "Δ: select two pressure sources");
  }

  updatePlasma() {
    const s = this.s;
    const p = s.plasma;
    const u = this.unit();
    const stateChip = p.state == null ? ["plain", "unknown"] : p.state === 0 ? ["plain", "off"] : p.state === 1 ? ["warn", "on, not ignited"] : ["ok", "ignited"];
    const key = `${p.text}|${p.state}`;
    if (key !== this.keys.plasma) {
      this.keys.plasma = key;
      replace(this.plasmaStatus, h(`span.chip.${stateChip[0]}`, null, `Plasma ${stateChip[1]}`), h("span.hint", null, p.text === "—" ? "not read yet" : p.text));
    }
    const tKey = `${u}|${p.minMbar}|${p.maxMbar}`;
    if (tKey !== this.keys.thresholds && document.activeElement !== this.minInput && document.activeElement !== this.maxInput) {
      this.keys.thresholds = tKey;
      this.minInput.value = formatSci(s.thresholdIn("minMbar", u), 2);
      this.maxInput.value = formatSci(s.thresholdIn("maxMbar", u), 2);
      setText(this.minUnit, u);
      setText(this.maxUnit, u);
    }
    const prompt = p.prompt;
    const promptKey = prompt ? `${prompt.action}|${prompt.t}|${u}` : "";
    if (promptKey !== this.keys.prompt) {
      this.keys.prompt = promptKey;
      if (!prompt) replace(this.plasmaPrompt);
      else {
        const limit = prompt.action === "off" ? p.maxMbar : p.minMbar;
        const text = prompt.action === "off"
          ? `Pressure ${formatSci(convertPressure(prompt.pressureMbar, "mbar", u), 2)} ${u} is above the max safe ${formatSci(convertPressure(limit, "mbar", u), 2)} ${u} while the plasma is on.`
          : `Pressure ${formatSci(convertPressure(prompt.pressureMbar, "mbar", u), 2)} ${u} is below the min ignite ${formatSci(convertPressure(limit, "mbar", u), 2)} ${u} and the plasma is off.`;
        replace(this.plasmaPrompt, h(`div.callout.${prompt.action === "off" ? "danger" : "warn"}.studio-prompt`, { role: "alert" },
          h("div", null, text),
          h("div.row", null,
            h(`button.button.small.${prompt.action === "off" ? "danger" : "primary"}`, { type: "button", onclick: () => this.plasma(prompt.action === "off" ? 0 : 1) }, prompt.action === "off" ? "Switch plasma off…" : "Switch plasma on…"),
            h("button.button.small", { type: "button", onclick: () => {
              s.notePlasmaAction();
              this.update();
            } }, "Dismiss"))));
      }
    }
  }

  updateAcquisition() {
    const s = this.s;
    const record = s.activeRecordCommand();
    const enable = ENABLE_FOR_RECORD[record];
    const label = ALGORITHM_LABELS[enable];
    const state = s.algorithmStates[record];
    const count = s.recordCounts[record];
    this.startButton.textContent = `Start ${label}…`;
    this.startButton.disabled = !this.has(enable);
    const live = s.spectrumMode === SpectrumMode.AUTO;
    const running = state && state.code >= 2 && state.code !== 255;
    const lines = [
      h("div", null, h("strong", null, `${label} state: `), state ? state.label : "not read yet", count != null ? ` · ${count} record${count === 1 ? "" : "s"}` : ""),
      !live ? h("div.hint", null, "Record reads pause while a simulated plot option is shown (CSC reads only for Live Data).") : null,
      live && this.d.opgAcquire === false ? h("div.hint", null, "Background reads are off.") : null,
      s.startedAlgorithm === enable && state && !running ? h("div.callout.warn", null, `${label} is not running on the gauge (${state.label}). Check that the plasma is ignited, then start it again.`) : null,
      live && state && !running && s.startedAlgorithm !== enable ? h("div.hint", null, `Start ${label} to capture records for this plot. Starting sends two confirmed writes: all algorithms off, then ${enable}.`) : null
    ];
    const key = lines.map((l) => l?.textContent ?? "").join("|");
    if (key !== this.keys.acq) {
      this.keys.acq = key;
      replace(this.acqStatus, ...lines);
    }
  }

  updateHealth() {
    const s = this.s;
    const u = this.unit();
    const p = s.pressure.last();
    const key = `${p?.t}|${u}|${s.moleculeText}|${s.rejectedSpikes}`;
    if (key === this.keys.health) return;
    this.keys.health = key;
    if (p) {
      replace(this.healthPressure, h("span.v", null, formatSci(convertPressure(p.v, "mbar", u), 3)), h("span.u", null, ` ${u}`));
      this.healthMeter.style.width = `${(vacuumScore(p.v) / 10).toFixed(1)}%`;
      setText(this.healthQuality, `Vacuum quality: ${vacuumQuality(p.v)}${s.rejectedSpikes ? ` · ${s.rejectedSpikes} spike reading${s.rejectedSpikes === 1 ? "" : "s"} rejected` : ""}`);
    } else {
      replace(this.healthPressure, h("span.v", null, "—"), h("span.u", null, ` ${u}`));
      this.healthMeter.style.width = "0%";
      setText(this.healthQuality, "Vacuum quality: —");
    }
    setText(this.moleculeLine, s.moleculeText);
  }

  updateTelemetry() {
    const s = this.s;
    const rows = TELEMETRY_COMMANDS.filter((c) => this.has(c)).map((c) => [c.replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase()), s.telemetry.get(c) ?? "—"]);
    const details = [["Firmware", s.identity.firmware || this.d.identity.firmware || "—"], ["Serial", s.identity.serial || this.d.identity.serial || "—"], ["Bootloader", s.identity.bootloader || "—"], ["Error status", s.errorText]];
    const key = JSON.stringify([rows, details]);
    if (key === this.keys.telemetry) return;
    this.keys.telemetry = key;
    replace(this.telemetryList, ...rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
    replace(this.detailsList, ...details.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  }

  // -------------------------------------------------------------------------------------------
  // Actions (every write goes through the app's confirmation)

  /** @param {0 | 1} value */
  async plasma(value) {
    const d = this.d;
    const s = this.s;
    const p = s.lastPressureMbar;
    const u = this.unit();
    /** @type {{ risk?: "caution" | "danger", notes?: string[] }} */
    const overrides = {};
    if (value === 1 && p != null && p > s.plasma.maxMbar) {
      overrides.risk = "danger";
      overrides.notes = [`The OPG550 reads ${formatSci(convertPressure(p, "mbar", u), 2)} ${u}, above the max safe pressure of ${formatSci(convertPressure(s.plasma.maxMbar, "mbar", u), 2)} ${u} set in Spectrum Studio.`];
    }
    const entry = await this.app.sendCommand(d, "plasma_enable", value, overrides);
    if (!entry) return;
    s.notePlasmaAction();
    if (!entry.error && this.has("plasma_state")) {
      await this.app.query(d, "plasma_state").catch(() => {});
      // Ignition takes a moment; read the state once more (a safe read).
      if (value === 1) setTimeout(() => this.app.query(d, "plasma_state").then(() => this.update()).catch(() => {}), 2500);
    }
    if (value === 1 && !entry.error) toast("Plasma switched on. Start an algorithm (SPEC, RoR or RGD) to capture spectra.", "ok", 6000);
    this.update();
  }

  async startAlgorithm() {
    const d = this.d;
    const s = this.s;
    const record = s.activeRecordCommand();
    const enable = ENABLE_FOR_RECORD[record];
    const label = ALGORITHM_LABELS[enable];
    /** @type {{ command: string, value: any, label?: string, display?: string }[]} */
    const items = [];
    if (this.has("all_algorithms_off")) items.push({ command: "all_algorithms_off", value: 0, label: "All algorithms off", display: "" });
    items.push({ command: enable, value: 1, label: `Start ${label}`, display: "1 (endless acquisition)" });
    const entries = await this.app.writeBatch(d, items, {
      title: `Start ${label} on ${d.label}`,
      risk: "caution",
      description: `Switches every OPG550 analysis algorithm off, then starts ${label} with endless acquisition. The gauge captures records while the plasma is ignited; the studio then reads them every 2 s.`,
      warning: "This changes the gauge's operating mode. It does not switch any relay or the plasma."
    });
    if (!entries) return;
    const failed = entries.find((/** @type {any} */ e) => e.entry.error);
    if (failed) toast(`${failed.command}: ${failed.entry.error}`, "warn", 7000);
    else s.noteAlgorithmStarted(enable);
    for (const c of [STATE_FOR_RECORD[record], COUNT_FOR_RECORD[record], "operating_mode"]) if (this.has(c)) await this.app.query(d, c).catch(() => {});
    this.update();
  }

  async stopAlgorithms() {
    const entry = await this.app.sendCommand(this.d, "all_algorithms_off", 0);
    if (!entry || entry.error) return;
    this.s.noteAlgorithmsStopped();
    for (const c of ["spec_state", "ror_state", "rgd_state", "operating_mode"]) if (this.has(c)) await this.app.query(this.d, c).catch(() => {});
    this.update();
  }

  // -------------------------------------------------------------------------------------------
  // Exports

  /** @param {string} suffix */
  fileName(suffix) {
    return `${this.app.fileStem()}_${this.d.label.replace(/[^\w.-]+/g, "_")}_${suffix}.csv`;
  }

  /** @param {string | null} csv @param {string} suffix @param {string} empty */
  save(csv, suffix, empty) {
    if (!csv) return toast(empty, "warn");
    download(this.fileName(suffix), csv, "text/csv");
  }

  exportOpg() {
    const kind = this.s.analysisMode === "Rate of Rise" ? "ror" : "rgd";
    this.save(opgCsv(this.s, kind), kind === "ror" ? "RoR" : "RGD", "No spectrum samples to export yet.");
  }

  exportTrend() {
    this.save(trendCsv(this.s, this.unit(), this.app.exportHeader(this.d)), "trend", "The trend chart has no samples to export yet.");
  }

  exportSpectrum() {
    this.save(spectrumCsv(this.s, this.app.exportHeader(this.d)), "spectrum", "No spectrum to export yet.");
  }

  exportGas() {
    this.save(gasCsv(this.s, this.app.exportHeader(this.d)), "tracked_gases", "No partial-pressure samples to export yet.");
  }

  exportAdvanced() {
    const sources = this.sources().map((x) => ({ name: x.name, series: x.series }));
    this.save(advancedCsv(this.s, sources, this.unit(), this.app.exportHeader(null)), "advanced", "The correlation chart has no series to export yet.");
  }
}

/** @param {HTMLElement} el @param {string} text */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
