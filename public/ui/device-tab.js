// @ts-check
/**
 * Device tab (WEB_PORT_PLAN.md section 8): everything about one gauge on one page.
 *
 *  - Live value with status chips, session statistics and where the reading sits in the
 *    gauge's measuring range.
 *  - Gauge information: identity, line settings and full scale, with a one-click identity read.
 *  - Readings: every read command with its last reply, a one-click read and a poll toggle.
 *  - Setpoints: the relay levels last read and each relay's state from the live pressure, with
 *    the setpoint editor one click away (ui/setpoints.js).
 *  - Trend.
 *  - Terminal: quick-command buttons, pinned favourites, a guided composer (command, read or
 *    write, a value picked from a list or typed by hand, the exact bytes before sending), a raw
 *    frame builder with history, and a filterable log.
 */
import { h, replace, formatClock, toast } from "./dom.js";
import { Trend } from "./trend.js";
import { toHex, printable, parseInput, text as bytesText } from "../core/bytes.js";
import { convertPressure, isPressureUnit, PRESSURE_UNITS } from "../core/units.js";
import { formatPressure } from "../core/codecs/common.js";
import { MIN_POLL_INTERVAL_MS } from "../core/constants.js";
import { summarizeTc600Status } from "../core/turbo/tc600.js";
import { FAMILY_LABELS } from "../core/registry/registry.js";
import { valueShape, commandGroup, GROUP_LABELS } from "../core/command-values.js";
import { cdgRawToMbar, gaugeRangeMbar, relayStep, zoneOf, formatSetpointValue } from "../core/setpoints.js";
import { knownBands, readSetpoints, setpointColor } from "./setpoints.js";
import { SpectrumStudio } from "./spectrum-studio.js";

const STATE_CHIPS = {
  starting: ["Starting", "info"],
  polling: ["Polling", "ok"],
  streaming: ["Streaming", "ok"],
  paused: ["Paused", "plain"],
  offline: ["Offline", "warn"],
  dead: ["Stopped — link lost", "bad"],
  idle: ["Idle", "plain"]
};
const WARNING_CLASS = { overrange: "warn", underrange: "warn", "sensor not ready": "warn", "zero adjust running": "info", "fs adjust running": "info", "extended status": "info" };
const MAX_LINES = 800;
const HISTORY_CAP = 30;
const IDENTITY_LABELS = [
  ["model_name", "Model name"], ["product_name", "Product"], ["serial_number", "Serial no."], ["part_number", "Part no."],
  ["software_version", "Firmware"], ["firmware", "Firmware"], ["bootloader_version", "Bootloader"], ["manufacturer", "Manufacturer"],
  ["manufacturer_name", "Manufacturer"], ["cdg_type", "Type word"], ["run_hours", "Operating hours"], ["operating_hours", "Operating hours"],
  ["op_hours_TMP", "Operating hours"]
];

const favStore = {
  /** @param {string} model */
  get(model) {
    try {
      return JSON.parse(localStorage.getItem(`gauge-communicator-favorites:${model}`) ?? "[]");
    } catch {
      return [];
    }
  },
  /** @param {string} model @param {any[]} list */
  set(model, list) {
    try {
      localStorage.setItem(`gauge-communicator-favorites:${model}`, JSON.stringify(list));
    } catch {}
  }
};

export class DeviceTab {
  /**
   * @param {any} app
   * @param {any} device
   */
  constructor(app, device) {
    this.app = app;
    this.device = device;
    this.renderedLog = 0;
    this.filter = "";
    /** @type {Record<number, boolean>} relay state per setpoint, tracked from the live pressure */
    this.relays = {};
    this.el = h("div.panel", { role: "tabpanel" });
    this.build();
  }

  get commands() {
    return /** @type {any[]} */ (this.device.codec.commands?.() ?? []);
  }

  build() {
    const d = this.device;
    this.layout = this.app.setpointLayout(d);
    this.header = h("div.device-header");
    this.valueCard = h("div.card.value-card");
    this.infoCard = h("div.card");
    this.readingsCard = h("div.card");
    this.setpointCard = this.layout ? h("div.card") : null;
    this.terminalCard = h("div.card.terminal-card");
    this.trend = new Trend({
      getSeries: () => this.trendSeries(),
      displayUnit: () => this.app.displayUnit(),
      title: "Trend"
    });
    const trendCard = h("div.card", null, this.trend.el);
    this.overview = h("div.device-overview", null,
      h("div.hero", null, this.valueCard, this.infoCard),
      trendCard,
      this.setpointCard ? h("div.split.wide-left", null, this.readingsCard, this.setpointCard) : this.readingsCard,
      this.terminalCard);
    /** @type {SpectrumStudio | null} created on first use, for OPG550s */
    this.studio = null;
    this.showView();
    this.renderHeader();
    this.renderInfo();
    this.renderReadings();
    this.renderSetpointSummary();
    this.renderTerminal();
    this.update();
  }

  destroy() {
    this.trend.destroy();
    this.studio?.destroy();
  }

  /** OPG550s have two views: the gauge overview and Spectrum Studio (CSC's inner tab). */
  showView() {
    const d = this.device;
    if (d.opg && d.view === "studio") {
      const first = !this.studio;
      if (!this.studio) this.studio = new SpectrumStudio(this.app, d);
      replace(this.el, this.header, this.studio.el);
      this.studio.update();
      if (first || this.lastView !== "studio") this.studio.shown();
    } else {
      replace(this.el, this.header, this.overview);
    }
    this.lastView = d.opg ? d.view ?? "overview" : "overview";
  }

  trendSeries() {
    const d = this.device;
    return [...d.series.values()]
      .filter((s) => isPressureUnit(s.unit) || s.id.endsWith(":pressure"))
      .map((series, i) => ({ series, color: i === 0 ? d.color : shade(d.color, i), label: `${d.label} ${series.id.split(":").pop()}` }));
  }

  renderHeader() {
    const d = this.device;
    const pause = h("button.button.small", { type: "button", onclick: () => this.app.setPolling(d, d.status.state === "paused" || d.status.state === "dead" || d.status.state === "offline") }, "Pause");
    this.pauseButton = pause;
    let views = null;
    if (d.opg) {
      views = h("div.segmented.view-switch", { role: "group", "aria-label": "View" });
      for (const [id, label] of [["overview", "Gauge"], ["studio", "Spectrum Studio"]]) {
        views.append(h("button", { type: "button", "aria-pressed": String((d.view ?? "overview") === id), onclick: () => {
          d.view = id;
          for (const b of /** @type {HTMLElement} */ (views).querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.textContent === label));
          this.showView();
        } }, label));
      }
    }
    replace(this.header,
      h("span.swatch", { style: { background: d.color } }),
      h("h2", null, d.label),
      h("span.chip.plain", null, d.model),
      d.simulated ? h("span.chip.info", null, "simulated") : null,
      d.experimental ? h("span.chip.warn", null, "experimental") : null,
      h("span.line-info", null, `${d.portLabel} · ${d.line.rsMode}${d.line.rsMode === "RS485" ? ` address ${d.address}` : ""} · ${d.line.baudRate} baud`),
      views,
      h("div.grow"),
      pause,
      this.layout ? h("button.button.small.primary", { type: "button", onclick: () => this.app.openSetpoints(d) }, "Setpoints…") : null,
      h("button.button.small", { type: "button", title: "Command dictionary (Ctrl K)", onclick: () => this.app.openDictionary(d) }, "Commands"),
      h("button.button.small", { type: "button", onclick: () => this.app.exportDevice(d) }, "Export CSV"),
      h("button.button.small", { type: "button", onclick: () => {
        const name = prompt("Device name", d.label);
        if (name) this.app.renameDevice(d, name);
      } }, "Rename"),
      h("button.button.small", { type: "button", onclick: () => this.app.removeDevice(d) }, "Remove"));
  }

  /** Re-render the live parts; called on every reading, throttled by the app. */
  update() {
    const d = this.device;
    const paused = ["paused", "dead", "offline"].includes(d.status.state);
    if (this.pauseButton) this.pauseButton.textContent = paused ? "Resume" : "Pause";
    if (this.studio && d.view === "studio") return this.studio.update();
    this.updateReadings();
    this.updateSetpointSummary();
    this.updateInfo();
    if (d.turbo) return this.renderTurbo();
    const display = this.app.displayUnit();
    const last = d.last;
    let valueText = "—";
    let unitText = "";
    let reported = "";
    let unitForStats = last?.unit ?? "";
    if (last && Number.isFinite(last.value)) {
      if (display !== "auto" && isPressureUnit(last.unit) && isPressureUnit(display) && last.unit.toLowerCase() !== display.toLowerCase()) {
        const v = convertPressure(last.value, last.unit, display);
        [valueText, unitText] = splitUnit(formatPressure(v, display));
        reported = `reported as ${formatPressure(last.value, last.unit)}`;
        unitForStats = display;
      } else {
        [valueText, unitText] = isPressureUnit(last.unit) ? splitUnit(formatPressure(last.value, last.unit)) : [String(last.value), last.unit];
      }
    }
    const [stateLabel, stateClass] = STATE_CHIPS[/** @type {keyof typeof STATE_CHIPS} */ (d.status.state)] ?? [d.status.state, "plain"];
    const chips = [h(`span.chip.${stateClass}`, { title: d.status.message || "" }, stateLabel)];
    for (const w of last?.warnings ?? []) chips.push(h(`span.chip.${WARNING_CLASS[/** @type {keyof typeof WARNING_CLASS} */ (w)] ?? "warn"}`, null, w));
    if (d.statusWord) chips.push(h("span.chip.warn", { title: "Status word reported by the gauge instead of a pressure" }, d.statusWord));
    if (d.lastError && Date.now() - d.lastError.t < 15000) chips.push(h(`span.chip.${d.lastError.recoverable ? "warn" : "bad"}`, { title: d.lastError.message }, d.lastError.recoverable ? "recent error" : "error"));
    if (d.status.message && (d.status.state === "dead" || d.status.state === "offline")) chips.push(h("span.hint", null, d.status.message));
    const age = last ? Math.max(0, (Date.now() - last.t) / 1000) : null;

    // Session statistics of the primary series.
    const series = d.series.get(d.primaryCommand);
    const st = series?.length ? series.stats(-Infinity, Infinity) : null;
    const conv = (/** @type {number} */ v) => (series && isPressureUnit(series.unit) && isPressureUnit(unitForStats) ? convertPressure(v, series.unit, unitForStats) : v);
    const fmt = (/** @type {number} */ v) => (Number.isFinite(v) ? (isPressureUnit(unitForStats) ? formatPressure(conv(v), "", 3) : String(Number(conv(v).toPrecision(4)))) : "—");
    const stat = (/** @type {string} */ k, /** @type {string} */ v, title = "") => h("div.stat", { title }, h("span.k", null, k), h("span.v", null, v));

    // Where the reading sits in the gauge's range (log scale).
    let range = null;
    if (last && Number.isFinite(last.value) && isPressureUnit(last.unit) && last.value > 0) {
      const r = gaugeRangeMbar(d.model, d.fullScale?.mbar ?? d.codec.fullScaleMbar);
      const p = convertPressure(last.value, last.unit, "mbar");
      const f = Math.min(1, Math.max(0, (Math.log10(p) - Math.log10(r.min)) / (Math.log10(r.max) - Math.log10(r.min))));
      const u = isPressureUnit(display) ? display : last.unit;
      range = h("div", { title: "Where the reading sits in the gauge's measuring range (log scale)" },
        h("div.range-bar", null, h("span.needle", { style: { left: `${(f * 100).toFixed(1)}%` } })),
        h("div.range-labels", null, h("span", null, formatPressure(convertPressure(r.min, "mbar", u), u, 2)), h("span", null, "measuring range"), h("span", null, formatPressure(convertPressure(r.max, "mbar", u), u, 2))));
    }

    replace(this.valueCard,
      h("div.row", null, h("span.value-label", null, isPressureUnit(last?.unit) ? "Pressure" : d.primaryCommand), h("span.hint", null, d.primaryCommand), h("div.grow"), h("div.chips", null, chips)),
      h("div.value-main", { "aria-live": "off" }, valueText, h("span.unit", null, unitText)),
      h("div.value-sub", null, [reported, age != null ? `updated ${age < 10 ? age.toFixed(1) : Math.round(age)} s ago` : "waiting for the first reading"].filter(Boolean).join(" · ")),
      range,
      h("div.stat-row", null,
        stat("Session min", st ? fmt(st.min) : "—"),
        stat("Session max", st ? fmt(st.max) : "—"),
        stat("Rate", st && Number.isFinite(st.decadesPerMinute) ? `${st.decadesPerMinute >= 0 ? "+" : ""}${st.decadesPerMinute.toFixed(3)} dec/min` : "—", "Least-squares rate over the session, in decades per minute"),
        stat("Samples", series ? series.length.toLocaleString() : "0")));
  }

  renderTurbo() {
    const d = this.device;
    const summary = summarizeTc600Status(Object.fromEntries([...d.secondary.entries()].map(([k, v]) => [k, { success: true, value: v.value, formatted: v.formatted }])));
    const [stateLabel, stateClass] = STATE_CHIPS[/** @type {keyof typeof STATE_CHIPS} */ (d.status.state)] ?? [d.status.state, "plain"];
    const button = (/** @type {string} */ label, /** @type {string} */ command, /** @type {any} */ value) =>
      h("button.button", { type: "button", onclick: () => this.app.sendCommand(d, command, value) }, label);
    replace(this.valueCard,
      h("span.value-label", null, "Rotor speed"),
      h("div.turbo-gauge", null, summary.speedHz == null ? "—" : `${summary.speedHz}`, h("span.unit", { style: { fontSize: "18px" } }, " Hz")),
      h("div.meter", { style: { width: "min(420px, 100%)" } }, h("span", { style: { width: `${Math.round((summary.speedFraction ?? 0) * 100)}%` } })),
      h("div.chips", null,
        h(`span.chip.${stateClass}`, null, stateLabel),
        summary.pumpOn == null ? null : h(`span.chip.${summary.pumpOn ? "ok" : "plain"}`, null, summary.pumpOn ? "Pumping station on" : "Pumping station off"),
        summary.errorCode == null ? null : h(`span.chip.${summary.errorActive ? "bad" : "ok"}`, null, summary.errorActive ? `Error ${summary.errorCode}: ${summary.errorDescription}` : "No error"),
        summary.warningActive ? h("span.chip.warn", null, `Warning ${summary.warningCode}`) : null),
      h("div.row", null,
        button("Start pumping station", "pump_on", 1),
        button("Stop pumping station", "pump_on", 0),
        button("Acknowledge error", "error_ack", 1)),
      h("p.hint", null, "Every actuating turbo command is a danger command: it shows the exact bytes and needs a second deliberate click (CSC guide section 5)."));
  }

  // ----------------------------------------------------------------------------------------
  // Gauge information

  identityCommands() {
    const names = new Set(this.commands.filter((c) => c.read).map((c) => c.name));
    return IDENTITY_LABELS.filter(([name]) => names.has(name));
  }

  renderInfo() {
    const d = this.device;
    this.infoList = h("dl.info-list");
    const readButton = /** @type {HTMLButtonElement} */ (h("button.button.small", { type: "button", title: "Read every identity command once (safe reads)" }, "Read identity"));
    readButton.onclick = async () => {
      readButton.disabled = true;
      try {
        let failed = 0;
        for (const [name] of this.identityCommands()) {
          const entry = await this.app.query(d, name);
          if (entry.error) failed += 1;
        }
        if (failed) toast(`${failed} identity read(s) got no valid answer; see the terminal.`, "warn");
      } finally {
        readButton.disabled = false;
        this.updateInfo(true);
      }
    };
    replace(this.infoCard,
      h("h3.card-title", null, "Gauge information", h("div.grow"), this.identityCommands().length ? readButton : null),
      this.infoList);
    this.updateInfo(true);
  }

  /** @param {boolean} [force] */
  updateInfo(force = false) {
    const d = this.device;
    if (!this.infoList) return;
    const rows = [["Model", d.model + (d.spec.experimental ? " (experimental)" : "")]];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const [name, label] of this.identityCommands()) {
      const v = d.secondary.get(name)?.formatted ?? (name === "serial_number" ? d.identity.serial : /firmware|software_version/.test(name) ? d.identity.firmware : "");
      if (seen.has(label) && !v) continue;
      seen.add(label);
      rows.push([label, v || "—"]);
    }
    if (!this.identityCommands().some(([n]) => n === "serial_number") && d.identity.serial) rows.push(["Serial no.", d.identity.serial]);
    if (d.fullScale) rows.push(["Full scale", `${d.fullScale.value} ${d.fullScale.unit} (${d.fullScale.mbar} mbar) · ${d.fullScale.origin === "user" ? "confirmed" : "from scan"}`]);
    const r = isPressureUnit(d.spec.commands?.pressure?.unit) ? gaugeRangeMbar(d.model, d.fullScale?.mbar ?? d.codec.fullScaleMbar) : null;
    if (r && !d.turbo) rows.push(["Measuring range", `${formatPressure(r.min, "mbar", 2)} … ${formatPressure(r.max, "mbar", 2)}`]);
    rows.push(["Protocol", FAMILY_LABELS[/** @type {keyof typeof FAMILY_LABELS} */ (d.family)] ?? d.family]);
    rows.push(["Port", d.portLabel]);
    rows.push(["Line", `${d.line.rsMode}${d.line.rsMode === "RS485" ? ` · address ${d.address}` : ""} · ${d.line.baudRate} ${d.line.dataBits ?? 8}${String(d.line.parity ?? "none")[0].toUpperCase()}${d.line.stopBits ?? 1}`]);
    rows.push([d.streaming ? "Stream" : "Poll", `${d.streaming ? "record every" : "every"} ${d.poll.intervalMs} ms${d.cycleMs ? ` · cycle ${d.cycleMs} ms` : ""}`]);
    if (d.spec.source) rows.push(["Source", d.spec.source]);
    const key = rows.map((x) => x.join("=")).join("|");
    if (!force && key === this.infoKey) return;
    this.infoKey = key;
    replace(this.infoList, ...rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  }

  // ----------------------------------------------------------------------------------------
  // Readings and polling

  readCommands() {
    return this.commands.filter((c) => c.read && commandGroup(c.name) !== "setpoints");
  }

  renderReadings() {
    const d = this.device;
    /** @type {Map<string, { value: HTMLElement, when: HTMLElement }>} */
    this.readingCells = new Map();
    const reads = this.readCommands();
    const rows = reads.map((c) => {
      const cells = { value: h("td.value", null, "—"), when: h("td.when", null, "") };
      this.readingCells?.set(c.name, cells);
      const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: d.poll.commands.includes(c.name), "aria-label": `Poll ${c.name}` }));
      box.onchange = () => {
        const next = reads.map((x) => x.name).filter((name) => (name === c.name ? box.checked : d.poll.commands.includes(name)));
        this.app.setCommands(d, next);
      };
      const readBtn = h("button.button.tiny", { type: "button", onclick: () => this.app.sendCommand(d, c.name, undefined) }, "Read");
      return h(`tr${c.name === d.primaryCommand ? ".primary-row" : ""}`, null,
        d.streaming ? null : h("td", null, box),
        h("td", { title: c.description ?? "" }, h("div.cmd-name", null, c.name), c.description ? h("div.hint", null, c.description) : null),
        cells.value,
        cells.when,
        h("td", null, readBtn));
    });
    const interval = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: String(MIN_POLL_INTERVAL_MS), step: "10", value: String(d.poll.intervalMs), style: { width: "100px" } }));
    interval.onchange = () => this.app.setIntervalMs(d, Number(interval.value));
    replace(this.readingsCard,
      h("h3.card-title", null, "Readings", h("div.grow"),
        h("label.row", { style: { textTransform: "none", letterSpacing: "0", color: "var(--muted)", fontWeight: "400" } }, d.streaming ? "Record every" : "Poll every", interval, "ms")),
      d.streaming
        ? h("p.hint", { style: { marginTop: 0 } }, "This gauge streams continuously after one read request; the interval is the minimum spacing of recorded samples. Reads below are sent between frames and matched on the read echo.")
        : h("p.hint", { style: { marginTop: 0 } }, `Tick a reading to poll it with the primary one. Only reads are ever polled. ${lineTimeHint(d)}`),
      h("div.scroll", null, h("table.data.readings", null,
        h("thead", null, h("tr", null, d.streaming ? null : h("th", null, "Poll"), h("th", null, "Command"), h("th", null, "Last value"), h("th", null, "Updated"), h("th", null, ""))),
        h("tbody", null, rows))),
      d.fullScale && d.family === "cdg_serial"
        ? h("div.row", { style: { marginTop: "10px" } },
            h("span.hint", null, `Full scale ${d.fullScale.value} ${d.fullScale.unit} (${d.fullScale.origin === "user" ? "confirmed by you" : "from scan"}).`),
            h("button.button.small", { type: "button", onclick: () => this.app.changeFullScale(d) }, "Change full scale"))
        : null);
    this.updateReadings();
  }

  /** Called by the app after a full-scale change. */
  renderPoll() {
    this.renderReadings();
    this.updateInfo(true);
  }

  updateReadings() {
    const d = this.device;
    if (!this.readingCells) return;
    const display = this.app.displayUnit();
    for (const [name, cells] of this.readingCells) {
      const r = name === d.primaryCommand && d.last ? d.last : d.secondary.get(name);
      if (!r) continue;
      let text = r.formatted ?? (r.value != null ? String(r.value) : "—");
      if (display !== "auto" && isPressureUnit(r.unit) && isPressureUnit(display) && Number.isFinite(r.value)) text = formatPressure(convertPressure(r.value, r.unit, display), display);
      if (cells.value.textContent !== text) cells.value.textContent = text;
      const when = r.t ? formatClock(r.t).slice(0, 8) : "";
      if (cells.when.textContent !== when) cells.when.textContent = when;
    }
  }

  // ----------------------------------------------------------------------------------------
  // Setpoint summary

  renderSetpointSummary() {
    if (!this.setpointCard || !this.layout) return;
    const d = this.device;
    this.spRows = h("div.sp-summary");
    const readBtn = /** @type {HTMLButtonElement} */ (h("button.button.small", { type: "button" }, "Read"));
    readBtn.onclick = async () => {
      readBtn.disabled = true;
      try {
        const { errors } = await readSetpoints(this.app, d, /** @type {any} */ (this.layout));
        if (errors.length) toast(`Some setpoint reads failed: ${errors.slice(0, 2).join("; ")}`, "warn", 7000);
      } finally {
        readBtn.disabled = false;
        this.spKey = "";
        this.updateSetpointSummary();
      }
    };
    replace(this.setpointCard,
      h("h3.card-title", null, "Setpoints", h("div.grow"), readBtn, h("button.button.small.primary", { type: "button", onclick: () => this.app.openSetpoints(d) }, "Open editor…")),
      this.spRows,
      h("p.hint", { style: { marginBottom: 0 } }, this.layout.kind === "cdg"
        ? "Relay state is estimated here from the live pressure and the levels last read, with hysteresis. 🟠 V6: the gauge's own setpoint status bits are not decoded yet."
        : "Relay state is estimated from the live pressure and the levels last read, with hysteresis."));
    this.spKey = "";
    this.updateSetpointSummary();
  }

  updateSetpointSummary() {
    if (!this.spRows || !this.layout) return;
    const d = this.device;
    const bands = knownBands(d, this.layout);
    const unit = isPressureUnit(this.app.displayUnit()) ? this.app.displayUnit() : "mbar";
    const last = d.last;
    const p = last && Number.isFinite(last.value) && isPressureUnit(last.unit) ? convertPressure(last.value, last.unit, "mbar") : null;
    const rows = this.layout.channels.map((ch, i) => {
      const b = bands[i];
      if (b && p != null) this.relays[ch.index] = relayStep(this.relays[ch.index] ?? false, p, b);
      const on = this.relays[ch.index];
      const zone = b && p != null ? zoneOf(p, b) : null;
      const levels = !b
        ? "not read yet"
        : `${b.direction === "above" ? "on ≥" : "on ≤"} ${formatPressure(convertPressure(b.on, "mbar", unit), "", 3)} · off ${b.direction === "above" ? "≤" : "≥"} ${formatPressure(convertPressure(b.off, "mbar", unit), unit, 3)}${b.raw ? ` · raw ${b.raw.on}/${b.raw.off}` : ""}`;
      const state = !b ? ["", "—"] : !b.enabled ? ["", "disabled"] : p == null ? ["", "no reading"] : zone === "band" ? ["band", on ? "on · in band" : "off · in band"] : on ? ["on", "relay on"] : ["off", "relay off"];
      return { key: `${ch.index}:${levels}:${state[1]}`, el: h("div.sp-summary-row", null, h("span.swatch", { style: { background: setpointColor(ch.index) } }), h("div", null, h("strong", null, `SP${ch.index}`), h("div.levels", null, levels)), h(`span.relay.${state[0] || "off"}`, null, state[1])) };
    });
    const key = rows.map((r) => r.key).join("|");
    if (key === this.spKey) return;
    this.spKey = key;
    replace(this.spRows, ...rows.map((r) => r.el));
  }

  // ----------------------------------------------------------------------------------------
  // Terminal

  renderTerminal() {
    const d = this.device;
    this.log = h("div.terminal", { role: "log", "aria-label": `Terminal for ${d.label}` });
    const view = h("div.segmented", { role: "group", "aria-label": "Terminal view" });
    const current = () => d.terminalView ?? (d.binary ? "both" : "ascii");
    const syncView = () => {
      for (const b of view.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === current()));
    };
    for (const [v, label] of [["ascii", "ASCII"], ["both", "ASCII + hex"], ["hex", "Hex"]]) {
      view.append(h("button", { type: "button", dataset: { v }, onclick: () => {
        d.terminalView = v;
        syncView();
        this.redrawLog();
      } }, label));
    }
    syncView();
    const follow = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: true }));
    this.follow = follow;
    const pollTraffic = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: Boolean(d.showPollTraffic) }));
    pollTraffic.onchange = () => {
      d.showPollTraffic = pollTraffic.checked;
      this.redrawLog();
    };
    const search = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "Filter log…", "aria-label": "Filter terminal log" }));
    search.oninput = () => {
      this.filter = search.value.trim().toLowerCase();
      this.redrawLog();
    };
    const copy = h("button.button.small", { type: "button", title: "Copy the visible log as text", onclick: async () => {
      try {
        await navigator.clipboard.writeText(this.log.innerText);
        toast("Log copied.");
      } catch {
        toast("The browser blocked clipboard access.", "warn");
      }
    } }, "Copy");
    const clear = h("button.button.small", { type: "button", onclick: () => {
      d.log.length = 0;
      this.redrawLog();
    } }, "Clear");

    this.quickBar = h("div.quick-bar");
    this.renderQuickBar();
    replace(this.terminalCard,
      h("h3.card-title", { style: { marginBottom: 0 } }, "Terminal"),
      this.quickBar,
      h("div.term-toolbar", null, view, h("label.check", null, follow, "Follow"),
        h("label.check", { title: "Show every byte the scheduler sends and receives on this port" }, pollTraffic, "Polling traffic"),
        h("div.grow"), search, copy, clear),
      this.log,
      this.buildComposer());
    this.redrawLog();
  }

  renderQuickBar() {
    const d = this.device;
    const favorites = favStore.get(d.model);
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const c of this.commands) {
      const g = commandGroup(c.name);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)?.push(c);
    }
    const rows = [];
    if (favorites.length) {
      rows.push(h("div.quick-group", null, h("span.field-label", null, "★ Pinned"),
        ...favorites.map((/** @type {any} */ f, /** @type {number} */ i) => h("button.qbtn.fav", { type: "button", title: f.action === "write" ? `Write ${f.value} to ${f.command}` : `Read ${f.command}`, onclick: (/** @type {MouseEvent} */ e) => {
          if (/** @type {HTMLElement} */ (e.target).classList.contains("x")) {
            favorites.splice(i, 1);
            favStore.set(d.model, favorites);
            this.renderQuickBar();
            return;
          }
          this.sendAndShow(f.command, f.action === "write" ? f.value : undefined);
        } }, f.label, h("span.x", { title: "Unpin", "aria-label": "Unpin" }, "×")))));
    }
    for (const key of /** @type {(keyof typeof GROUP_LABELS)[]} */ (["readings", "identity", "setpoints", "configuration", "service"])) {
      const list = groups.get(key) ?? [];
      if (!list.length) continue;
      const reads = list.filter((c) => c.read);
      const buttons = [];
      if (key === "setpoints") {
        if (this.layout) buttons.push(h("button.qbtn.all", { type: "button", onclick: () => this.app.openSetpoints(d) }, "Setpoint editor…"));
        if (reads.length) buttons.push(h("button.qbtn", { type: "button", title: reads.map((c) => c.name).join(", "), onclick: () => this.readAll(reads) }, `Read all ${reads.length}`));
      } else {
        if (key === "identity" && reads.length > 1) buttons.push(h("button.qbtn.all", { type: "button", onclick: () => this.readAll(reads) }, "Read all"));
        for (const c of reads) buttons.push(h("button.qbtn", { type: "button", title: c.description || c.name, onclick: () => this.sendAndShow(c.name, undefined) }, label(c.name)));
        for (const c of list.filter((x) => x.write)) {
          buttons.push(h("button.qbtn.write", { type: "button", dataset: { risk: c.risk }, title: `Write ${c.name} (${c.risk}) — opens it in the composer`, onclick: () => this.loadComposer(c.name, "write") }, label(c.name)));
        }
      }
      rows.push(h("div.quick-group", null, h("span.field-label", null, GROUP_LABELS[key]), ...buttons));
    }
    replace(this.quickBar, ...rows);
  }

  /** @param {any[]} commands */
  async readAll(commands) {
    for (const c of commands) await this.app.query(this.device, c.name);
    this.updateInfo(true);
  }

  /**
   * Send through the app (risk gating included) and show the reply under the composer.
   * @param {string} command @param {any} value  undefined for a read
   */
  async sendAndShow(command, value) {
    try {
      const entry = await this.app.sendCommand(this.device, command, value);
      if (entry) this.showReply(command, entry);
    } catch (error) {
      toast(/** @type {Error} */ (error).message, "bad");
    }
  }

  /** @param {string} command @param {any} entry */
  showReply(command, entry) {
    if (!this.replyEl) return;
    this.replyEl.hidden = false;
    this.replyEl.className = `reply${entry.error ? " bad" : ""}`;
    replace(this.replyEl, h("span.k", null, `${command || "raw"} ←`), entry.error ? entry.error : entry.formatted ?? (entry.response?.length ? toHex(entry.response) : "(no reply)"));
  }

  /** @param {string} command @param {"read" | "write"} action @param {any} [value] */
  loadComposer(command, action, value) {
    if (!this.composer) return;
    this.composer.load(command, action, value);
  }

  buildComposer() {
    const d = this.device;
    const commands = this.commands;
    const byName = new Map(commands.map((c) => [c.name, c]));
    let mode = "command";
    let action = /** @type {"read" | "write"} */ ("read");
    /** @type {any} */
    let control = null;

    const modeSeg = h("div.segmented", { role: "group", "aria-label": "Composer mode" });
    for (const [v, text] of [["command", "Command"], ["raw", "Raw frame"]]) {
      modeSeg.append(h("button", { type: "button", dataset: { v }, onclick: () => {
        mode = v;
        refresh();
      } }, text));
    }

    // Command picker, grouped as on the quick bar.
    const cmdSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Command" }));
    /** @type {Map<string, any[]>} */
    const grouped = new Map();
    for (const c of commands) {
      const g = commandGroup(c.name);
      if (!grouped.has(g)) grouped.set(g, []);
      grouped.get(g)?.push(c);
    }
    for (const [g, list] of grouped) {
      cmdSelect.append(h("optgroup", { label: GROUP_LABELS[/** @type {keyof typeof GROUP_LABELS} */ (g)] }, list.map((c) => h("option", { value: c.name }, `${c.name}  ·  ${c.read && c.write ? "read / write" : c.write ? "write" : "read"}`))));
    }
    const cmdField = h("label.field.cmd-field", null, h("span.field-label", null, "Command"), cmdSelect);
    const actionSeg = h("div.segmented", { role: "group", "aria-label": "Read or write" });
    for (const [v, text] of [["read", "Read"], ["write", "Write"]]) {
      actionSeg.append(h("button", { type: "button", dataset: { v }, onclick: () => {
        action = /** @type {"read" | "write"} */ (v);
        rebuildValue();
        refresh();
      } }, text));
    }
    const actionField = h("div.field", null, h("span.field-label", null, "Action"), actionSeg);
    const valueHost = h("div.value-control");
    const valueField = h("div.field.value-field", null, h("span.field-label", null, "Value"), valueHost);

    // Raw frame builder.
    const format = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Input format" }, ["ascii", "escaped", "hex", "decimal", "base64"].map((f) => h("option", { value: f }, f === "ascii" ? "ASCII" : f === "escaped" ? "Escaped text" : f[0].toUpperCase() + f.slice(1)))));
    format.value = d.binary ? "hex" : "ascii";
    const ending = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Line ending" }, [["", "No ending"], ["\r", "CR"], ["\n", "LF"], ["\r\n", "CR LF"]].map(([v, l]) => h("option", { value: v }, l))));
    const raw = /** @type {HTMLInputElement} */ (h("input", { type: "text", spellcheck: "false", placeholder: d.binary ? "e.g. 03 00 3B 00 3B" : "e.g. @254PR3?\\" }));
    const formatField = h("label.field", null, h("span.field-label", null, "Format"), format);
    const endingField = h("label.field", null, h("span.field-label", null, "Ending"), ending);
    const rawField = h("label.field.raw-field", null, h("span.field-label", null, "Frame  (↑ ↓ history)"), raw);
    let rawHistoryIndex = -1;

    const pin = /** @type {HTMLButtonElement} */ (h("button.button", { type: "button", title: "Pin this command and value as a quick button" }, "★ Pin"));
    const send = /** @type {HTMLButtonElement} */ (h("button.button.primary", { type: "button" }, "Send"));
    const history = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Recent commands" }));
    const preview = h("div.byte-preview", { "aria-live": "polite" });
    const risk = h("div.row");
    this.replyEl = h("div.reply", { hidden: true });

    function rebuildValue() {
      const info = byName.get(cmdSelect.value);
      if (action === "write" && info?.write) {
        control = makeValueControl(valueShape(cmdSelect.value, d.spec.commands?.[cmdSelect.value], d.spec), d, refresh, doSend);
        replace(valueHost, control.el);
      } else {
        control = null;
        replace(valueHost, h("span.hint", null, info?.read ? "Reads need no value." : ""));
      }
    }

    const current = () => {
      if (mode === "command") {
        const info = byName.get(cmdSelect.value);
        const isWrite = action === "write" && Boolean(info?.write);
        const value = isWrite ? control?.get() : undefined;
        const bytes = d.codec.buildRequest(cmdSelect.value, isWrite ? value : undefined);
        return { bytes, command: cmdSelect.value, info, isWrite, value };
      }
      let bytes = parseInput(raw.value, /** @type {any} */ (format.value));
      if ((format.value === "ascii" || format.value === "escaped") && ending.value) bytes = Uint8Array.from([...bytes, ...Array.from(ending.value, (c) => c.charCodeAt(0))]);
      return { bytes, command: "", info: null, isWrite: true, value: undefined };
    };

    const refresh = () => {
      const isCommand = mode === "command";
      for (const b of modeSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === mode));
      const info = byName.get(cmdSelect.value);
      if (isCommand && info) {
        if (!info.write) action = "read";
        if (!info.read) action = "write";
      }
      for (const b of actionSeg.querySelectorAll("button")) {
        b.setAttribute("aria-pressed", String(b.dataset.v === action));
        /** @type {HTMLButtonElement} */ (b).disabled = b.dataset.v === "read" ? !info?.read : !info?.write;
      }
      cmdField.hidden = actionField.hidden = valueField.hidden = !isCommand;
      pin.hidden = !isCommand;
      formatField.hidden = rawField.hidden = isCommand;
      endingField.hidden = isCommand || !(format.value === "ascii" || format.value === "escaped");
      try {
        const c = current();
        const check = !isCommand && d.codec.validateFrame ? d.codec.validateFrame(c.bytes) : null;
        preview.className = `byte-preview${check && !check.ok ? " bad" : ""}`;
        preview.textContent = c.bytes.length ? `${toHex(c.bytes)}   ${printable(c.bytes)}${check ? `   — ${check.detail}` : ""}` : "—";
        const level = isCommand ? (c.isWrite ? info?.risk ?? "caution" : "safe") : "caution";
        replace(risk, h(`span.risk.${level}`, null, level),
          isCommand && info?.description ? h("span.hint", null, info.description) : null,
          isCommand && info?.unit ? h("span.hint", null, `· unit ${info.unit}`) : null,
          !isCommand ? h("span.hint", null, "A raw frame is not checked against the command table, so it is always confirmed.") : null,
          h("div.grow"), h("span.hint", null, h("span.kbd", null, "Enter"), " sends"));
        send.disabled = !c.bytes.length;
        send.textContent = isCommand ? (c.isWrite ? `Write ${c.command}` : `Read ${c.command}`) : "Send frame";
      } catch (error) {
        preview.className = "byte-preview bad";
        preview.textContent = /** @type {Error} */ (error).message;
        replace(risk, h("span.hint", null, "Fix the value to see the frame."));
        send.disabled = true;
      }
    };

    const drawHistory = () => {
      replace(history, h("option", { value: "" }, d.history.length ? `Recent (${d.history.length})…` : "No history yet"),
        ...d.history.map((/** @type {any} */ item, /** @type {number} */ i) => h("option", { value: String(i) }, item.mode === "raw" ? `raw: ${item.raw}` : `${item.action === "write" ? "write" : "read"} ${item.command}${item.action === "write" && item.value !== "" && item.value !== undefined ? ` = ${item.value}` : ""}`)));
      history.disabled = !d.history.length;
    };
    /** @param {any} item */
    const remember = (item) => {
      const key = JSON.stringify(item);
      d.history = [item, ...d.history.filter((/** @type {any} */ x) => JSON.stringify(x) !== key)].slice(0, HISTORY_CAP);
      drawHistory();
    };
    history.onchange = () => {
      const item = d.history[Number(history.value)];
      history.value = "";
      if (!item) return;
      if (item.mode === "raw") {
        mode = "raw";
        format.value = item.format;
        ending.value = item.ending;
        raw.value = item.raw;
        refresh();
        raw.focus();
      } else {
        load(item.command, item.action, item.value);
      }
    };

    async function doSend() {
      let c;
      try {
        c = current();
      } catch (error) {
        return toast(/** @type {Error} */ (error).message, "bad");
      }
      if (!c.bytes.length) return;
      try {
        if (mode === "command") {
          remember({ mode: "command", command: c.command, action: c.isWrite ? "write" : "read", value: c.isWrite ? c.value : undefined });
          const entry = await self.app.sendCommand(d, c.command, c.isWrite ? c.value : undefined);
          if (entry) self.showReply(c.command, entry);
        } else {
          remember({ mode: "raw", raw: raw.value, format: format.value, ending: ending.value });
          rawHistoryIndex = -1;
          const entry = await self.app.sendRaw(d, c.bytes);
          if (entry) self.showReply("", entry);
        }
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "bad");
      }
    }
    const self = this;

    /** @param {string} command @param {"read" | "write"} act @param {any} [value] */
    function load(command, act, value) {
      if (!byName.has(command)) return;
      mode = "command";
      cmdSelect.value = command;
      action = act;
      rebuildValue();
      if (value !== undefined && control) control.set(value);
      refresh();
      (control?.focus ?? (() => send.focus()))();
      self.terminalCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    cmdSelect.onchange = () => {
      const info = byName.get(cmdSelect.value);
      action = info?.read ? "read" : "write";
      rebuildValue();
      refresh();
    };
    for (const el of [format, ending]) el.addEventListener("change", refresh);
    raw.addEventListener("input", refresh);
    raw.addEventListener("keydown", (e) => {
      const rawItems = d.history.filter((/** @type {any} */ x) => x.mode === "raw");
      if (e.key === "Enter") {
        e.preventDefault();
        void doSend();
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && rawItems.length) {
        e.preventDefault();
        rawHistoryIndex = Math.max(-1, Math.min(rawItems.length - 1, rawHistoryIndex + (e.key === "ArrowUp" ? 1 : -1)));
        const item = rawItems[rawHistoryIndex];
        raw.value = item ? item.raw : "";
        if (item) {
          format.value = item.format;
          ending.value = item.ending;
        }
        refresh();
      }
    });
    cmdSelect.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void doSend();
      }
    });
    send.onclick = () => void doSend();
    pin.onclick = () => {
      let c;
      try {
        c = current();
      } catch (error) {
        return toast(/** @type {Error} */ (error).message, "warn");
      }
      const favorites = favStore.get(d.model);
      const item = { command: c.command, action: c.isWrite ? "write" : "read", value: c.isWrite ? c.value : undefined, label: c.isWrite ? `${label(c.command)} = ${c.value === "" ? "(execute)" : c.value}` : label(c.command) };
      if (favorites.some((/** @type {any} */ f) => f.command === item.command && f.action === item.action && f.value === item.value)) return toast("Already pinned.");
      favorites.push(item);
      favStore.set(d.model, favorites);
      this.renderQuickBar();
      toast(`Pinned ${item.label} for every ${d.model}.`);
    };

    this.composer = { load };
    cmdSelect.value = d.primaryCommand && byName.has(d.primaryCommand) ? d.primaryCommand : commands[0]?.name ?? "";
    action = byName.get(cmdSelect.value)?.read ? "read" : "write";
    rebuildValue();
    drawHistory();
    refresh();
    return h("div.composer", null,
      h("div.row", null, modeSeg, h("div.grow"), history),
      h("div.composer-row", null, cmdField, actionField, valueField, formatField, rawField, endingField),
      preview,
      h("div.row", null, risk, pin, send),
      this.replyEl);
  }

  redrawLog() {
    this.log.replaceChildren();
    this.renderedLog = 0;
    this.appendLog();
  }

  appendLog() {
    const d = this.device;
    const view = d.terminalView ?? (d.binary ? "both" : "ascii");
    const entries = d.log;
    if (this.renderedLog > entries.length) this.renderedLog = 0;
    const fragment = document.createDocumentFragment();
    for (let i = this.renderedLog; i < entries.length; i += 1) {
      const e = entries[i];
      if (e.poll && !d.showPollTraffic) continue;
      const body = e.bytes
        ? view === "hex"
          ? toHex(e.bytes)
          : view === "both"
            ? [printable(e.bytes), h("span.term-hex", null, `  ${toHex(e.bytes)}`)]
            : printable(e.bytes)
        : e.text;
      if (this.filter) {
        const hay = `${e.bytes ? `${printable(e.bytes)} ${toHex(e.bytes)}` : e.text} ${e.parsed ?? ""} ${e.error ?? ""}`.toLowerCase();
        if (!hay.includes(this.filter)) continue;
      }
      const copyBtn = e.bytes ? h("button.copy", { type: "button", title: "Copy these bytes as hex", onclick: () => navigator.clipboard?.writeText(toHex(e.bytes)).then(() => toast("Bytes copied."), () => {}) }, "copy") : null;
      fragment.append(h(`div.term-line.${e.kind === "err" ? "err" : e.kind === "note" ? "note" : e.kind}`, null, h("span.t", null, formatClock(e.t)), h("span.dir", null, e.kind === "tx" ? "→" : e.kind === "rx" ? "←" : "•"),
        h("span", null, body, e.parsed ? h("span.parsed", null, `   ${e.parsed}`) : null, e.error ? h("span.parsed.bad", null, `   ${e.error}`) : null, copyBtn)));
    }
    this.renderedLog = entries.length;
    if (fragment.childElementCount) this.log.querySelector(".term-empty")?.remove();
    this.log.append(fragment);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild?.remove();
    if (!this.log.childElementCount) this.log.append(h("div.term-empty", null, this.filter ? "No lines match the filter." : "Nothing sent yet. Use a quick button or the composer below; tick Polling traffic to watch the scheduler."));
    if (this.follow?.checked) this.log.scrollTop = this.log.scrollHeight;
  }
}

/**
 * The value input for a write, shaped by what the command accepts: a drop-down with a
 * "Custom…" escape, a slider with a number box, a pressure with its own unit, or free text.
 * @param {import("../core/command-values.js").ValueShape} shape
 * @param {any} d
 * @param {() => void} onChange
 * @param {() => void} onEnter
 */
function makeValueControl(shape, d, onChange, onEnter) {
  const enter = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    }
  };
  if (shape.kind === "none") {
    return { el: h("span.hint", null, "No value needed: Send runs it."), get: () => "", set() {}, focus: null };
  }
  if (shape.kind === "choice") {
    const select = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Value" }, shape.choices.map((c) => h("option", { value: c.value }, c.label)), h("option", { value: "__custom" }, "Custom…")));
    const custom = /** @type {HTMLInputElement} */ (h("input", { type: "text", placeholder: shape.placeholder || "type a value", hidden: true, "aria-label": "Custom value" }));
    const sync = () => {
      custom.hidden = select.value !== "__custom";
      onChange();
    };
    select.onchange = sync;
    select.onkeydown = enter;
    custom.oninput = onChange;
    custom.onkeydown = enter;
    return {
      el: h("div.value-control", null, select, custom),
      get: () => coerce(select.value === "__custom" ? custom.value.trim() : select.value),
      set: (/** @type {any} */ v) => {
        const s = String(v);
        if (shape.choices.some((c) => c.value === s)) select.value = s;
        else {
          select.value = "__custom";
          custom.value = s;
        }
        custom.hidden = select.value !== "__custom";
      },
      focus: () => select.focus()
    };
  }
  if (shape.kind === "range") {
    const min = shape.min ?? 0;
    const max = shape.max ?? 100;
    const num = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: String(min), max: String(max), step: String(shape.step ?? 1), value: String(min), "aria-label": "Value" }));
    const slider = /** @type {HTMLInputElement} */ (h("input", { type: "range", min: String(min), max: String(max), step: String(shape.step ?? 1), value: String(min), "aria-label": "Value slider" }));
    const equiv = h("span.equiv");
    const cdgSetpoint = d.family === "cdg_serial" && max === 255;
    const show = () => {
      const v = Number(num.value);
      equiv.textContent = cdgSetpoint ? `≈ ${formatPressure(cdgRawToMbar(v, d.codec.fullScaleMbar ?? 1), "mbar", 3)}` : shape.unit ? shape.unit : "";
      num.classList.toggle("invalid", !(v >= min && v <= max));
    };
    slider.oninput = () => {
      num.value = slider.value;
      show();
      onChange();
    };
    num.oninput = () => {
      slider.value = num.value;
      show();
      onChange();
    };
    num.onkeydown = enter;
    show();
    return {
      el: h("div.value-control", null, num, slider, equiv),
      get: () => {
        const v = Number(num.value);
        if (!(v >= min && v <= max)) throw new Error(`Enter a value from ${min} to ${max}.`);
        return v;
      },
      set: (/** @type {any} */ v) => {
        num.value = slider.value = String(v);
        show();
      },
      focus: () => num.focus()
    };
  }
  if (shape.kind === "pressure") {
    const commandUnit = shape.unit ?? "mbar";
    const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", inputmode: "decimal", spellcheck: "false", placeholder: shape.placeholder, "aria-label": "Pressure value" }));
    const unit = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Value unit" }, PRESSURE_UNITS.map((u) => h("option", { value: u }, u))));
    unit.value = PRESSURE_UNITS.includes(commandUnit) ? commandUnit : "mbar";
    const equiv = h("span.equiv");
    const show = () => {
      const v = Number(input.value.trim());
      equiv.textContent = input.value.trim() && Number.isFinite(v) && unit.value !== commandUnit ? `sent as ${formatSetpointValue(convertPressure(v, unit.value, commandUnit))} ${commandUnit}` : "";
    };
    input.oninput = () => {
      show();
      onChange();
    };
    unit.onchange = () => {
      show();
      onChange();
    };
    input.onkeydown = enter;
    return {
      el: h("div.value-control", null, input, unit, equiv),
      get: () => {
        const t = input.value.trim();
        if (!t) return "";
        const v = Number(t.replace(",", "."));
        if (!Number.isFinite(v)) return t; // keywords such as CLEAR go through as typed
        return formatSetpointValue(convertPressure(v, unit.value, commandUnit));
      },
      set: (/** @type {any} */ v) => {
        input.value = String(v);
        unit.value = commandUnit;
        show();
      },
      focus: () => input.focus()
    };
  }
  const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", spellcheck: "false", placeholder: shape.placeholder, "aria-label": "Value" }));
  input.oninput = onChange;
  input.onkeydown = enter;
  return { el: h("div.value-control", null, input), get: () => coerce(input.value.trim()), set: (/** @type {any} */ v) => (input.value = String(v)), focus: () => input.focus() };
}

/** Readable button text for a command name. @param {string} name */
function label(name) {
  return name.replace(/_/g, " ").replace(/\bpct\b/, "%").replace(/\bhz\b/i, "Hz");
}

/** @param {string} v */
function coerce(v) {
  return /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(v) ? Number(v) : v;
}

/** @param {string} s */
function splitUnit(s) {
  const i = s.lastIndexOf(" ");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/** @param {string} hex @param {number} i */
function shade(hex, i) {
  const n = parseInt(hex.slice(1), 16);
  const f = 1 - 0.22 * i;
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** Wire time per transaction at 10 bits per byte, shown so the achievable rate is honest. @param {any} d */
function lineTimeHint(d) {
  if (d.family !== "inficon_binary") return "";
  const ms = (26 * 10 * 1000) / d.line.baudRate;
  return `A PxG55x read is 26 bytes round trip: ${ms.toFixed(1)} ms of line time at ${d.line.baudRate} baud, plus the gauge's response time.`;
}

export { bytesText };
