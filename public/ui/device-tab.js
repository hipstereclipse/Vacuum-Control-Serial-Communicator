// @ts-check
/**
 * Device tab: value card with status chips, the per-device trend, poll controls, and the
 * protocol-aware terminal with a frame builder (WEB_PORT_PLAN.md section 8).
 */
import { h, replace, formatClock, toast } from "./dom.js";
import { Trend } from "./trend.js";
import { toHex, printable, parseInput, text as bytesText } from "../core/bytes.js";
import { convertPressure, isPressureUnit } from "../core/units.js";
import { formatPressure } from "../core/codecs/common.js";
import { MIN_POLL_INTERVAL_MS } from "../core/constants.js";
import { summarizeTc600Status } from "../core/turbo/tc600.js";

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

export class DeviceTab {
  /**
   * @param {any} app
   * @param {any} device
   */
  constructor(app, device) {
    this.app = app;
    this.device = device;
    this.renderedLog = 0;
    this.el = h("div.panel", { role: "tabpanel" });
    this.build();
  }

  build() {
    const d = this.device;
    this.header = h("div.row");
    this.valueCard = h("div.card");
    this.trend = new Trend({
      getSeries: () => this.trendSeries(),
      displayUnit: () => this.app.displayUnit(),
      title: "Trend"
    });
    this.pollCard = h("div.card");
    this.terminalCard = h("div.card");
    const trendCard = h("div.card", null, this.trend.el);
    replace(this.el, this.header, this.valueCard, trendCard, h("div.split", null, this.pollCard, this.terminalCard));
    this.renderHeader();
    this.renderPoll();
    this.renderTerminal();
    this.update();
  }

  destroy() {
    this.trend.destroy();
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
    replace(this.header,
      h("h2", { style: { margin: 0, fontSize: "18px" } }, d.label),
      h("span.chip.plain", null, d.model),
      d.simulated ? h("span.chip.info", null, "simulated") : null,
      d.experimental ? h("span.chip.warn", null, "experimental") : null,
      h("span.hint", null, `${d.portLabel} · ${d.line.rsMode}${d.line.rsMode === "RS485" ? ` address ${d.address}` : ""} · ${d.line.baudRate} baud`),
      h("div.grow"),
      pause,
      h("button.button.small", { type: "button", onclick: () => this.app.openDictionary(d) }, "Commands"),
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
    if (d.turbo) return this.renderTurbo();
    const display = this.app.displayUnit();
    const last = d.last;
    let valueText = "—";
    let unitText = "";
    let reported = "";
    if (last && Number.isFinite(last.value)) {
      if (display !== "auto" && isPressureUnit(last.unit) && isPressureUnit(display) && last.unit.toLowerCase() !== display.toLowerCase()) {
        const v = convertPressure(last.value, last.unit, display);
        [valueText, unitText] = splitUnit(formatPressure(v, display));
        reported = `reported as ${formatPressure(last.value, last.unit)}`;
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

    const meta = [];
    if (d.fullScale) meta.push(h("div", null, `FS ${d.fullScale.value} ${d.fullScale.unit} `, h("span.hint", null, d.fullScale.origin === "user" ? "(confirmed)" : "(from scan)")));
    if (d.identity.serial) meta.push(h("div", null, `SN ${d.identity.serial}`));
    if (d.identity.firmware) meta.push(h("div", null, `FW ${d.identity.firmware}`));
    if (d.cycleMs) meta.push(h("div", null, `cycle ${d.cycleMs} ms`));

    const secondary = [...d.secondary.entries()].filter(([cmd]) => cmd !== d.primaryCommand).map(([cmd, r]) => h("span", null, `${cmd}: `, h("b", null, r.formatted ?? "—")));
    replace(this.valueCard,
      h("div.value-card", null,
        h("div", null,
          h("div.value-main", { "aria-live": "off" }, valueText, h("span.unit", null, unitText)),
          h("div.value-sub", null, [d.primaryCommand, reported, age != null ? `${age < 10 ? age.toFixed(1) : Math.round(age)} s ago` : ""].filter(Boolean).join(" · ")),
          h("div.chips", null, chips),
          secondary.length ? h("div.secondary-readings", null, secondary) : null),
        h("div.value-meta", null, meta)));
  }

  renderTurbo() {
    const d = this.device;
    const summary = summarizeTc600Status(Object.fromEntries([...d.secondary.entries()].map(([k, v]) => [k, { success: true, value: v.value, formatted: v.formatted }])));
    const [stateLabel, stateClass] = STATE_CHIPS[/** @type {keyof typeof STATE_CHIPS} */ (d.status.state)] ?? [d.status.state, "plain"];
    const button = (/** @type {string} */ label, /** @type {string} */ command, /** @type {any} */ value) =>
      h("button.button", { type: "button", onclick: () => this.app.sendCommand(d, command, value) }, label);
    replace(this.valueCard,
      h("div.value-card", null,
        h("div", null,
          h("div.turbo-gauge", null, summary.speedHz == null ? "—" : `${summary.speedHz}`, h("span.unit", { style: { fontSize: "18px" } }, " Hz")),
          h("div.meter", { style: { marginTop: "10px", width: "min(420px, 100%)" } }, h("span", { style: { width: `${Math.round((summary.speedFraction ?? 0) * 100)}%` } })),
          h("div.chips", null,
            h(`span.chip.${stateClass}`, null, stateLabel),
            summary.pumpOn == null ? null : h(`span.chip.${summary.pumpOn ? "ok" : "plain"}`, null, summary.pumpOn ? "Pumping station on" : "Pumping station off"),
            summary.errorCode == null ? null : h(`span.chip.${summary.errorActive ? "bad" : "ok"}`, null, summary.errorActive ? `Error ${summary.errorCode}: ${summary.errorDescription}` : "No error"),
            summary.warningActive ? h("span.chip.warn", null, `Warning ${summary.warningCode}`) : null),
          h("div.row", { style: { marginTop: "12px" } },
            button("Start pumping station", "pump_on", 1),
            button("Stop pumping station", "pump_on", 0),
            button("Acknowledge error", "error_ack", 1)),
          h("p.hint", null, "Every actuating turbo command is a danger command: it shows the exact bytes and needs a second deliberate click (CSC guide section 5).")),
        h("div.value-meta", null, ...[...d.secondary.entries()].filter(([k]) => !["actual_speed_hz", "pump_on", "error_code"].includes(k)).map(([k, v]) => h("div", null, `${k}: ${v.formatted}`)))));
  }

  renderPoll() {
    const d = this.device;
    const commands = (d.codec.commands?.() ?? []).filter((/** @type {any} */ c) => c.read);
    const boxes = commands.map((/** @type {any} */ c) => {
      const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: d.poll.commands.includes(c.name) }));
      box.onchange = () => {
        const next = commands.map((/** @type {any} */ x) => x.name).filter((/** @type {string} */ name) => name === c.name ? box.checked : d.poll.commands.includes(name));
        this.app.setCommands(d, next);
      };
      return h("label.check", { title: c.description ?? "" }, box, c.name);
    });
    const interval = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: String(MIN_POLL_INTERVAL_MS), step: "10", value: String(d.poll.intervalMs), style: { width: "110px" } }));
    interval.onchange = () => this.app.setIntervalMs(d, Number(interval.value));
    replace(this.pollCard,
      h("h3.card-title", null, d.streaming ? "Stream" : "Poll"),
      d.streaming
        ? h("p.hint", null, "This gauge streams continuously after one read request. The interval below is the minimum spacing of recorded samples; the terminal still sends ad-hoc commands, matched on the read-command echo.")
        : h("div.poll-commands", null, boxes),
      h("div.row", { style: { marginTop: "10px" } },
        h("label.row", null, h("span.field-label", null, d.streaming ? "Record every" : "Every"), interval, "ms"),
        h("span.hint", null, d.streaming ? "" : `Only read commands are polled. ${lineTimeHint(d)}`)),
      d.fullScale && d.family === "cdg_serial"
        ? h("div.row", { style: { marginTop: "10px" } },
            h("span.hint", null, `Full scale ${d.fullScale.value} ${d.fullScale.unit} (${d.fullScale.origin === "user" ? "confirmed by you" : "from scan"}).`),
            h("button.button.small", { type: "button", onclick: () => this.app.changeFullScale(d) }, "Change full scale"))
        : null);
  }

  renderTerminal() {
    const d = this.device;
    this.log = h("div.terminal", { role: "log", "aria-label": `Terminal for ${d.label}` });
    const view = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Terminal view" }, h("option", { value: "ascii" }, "ASCII"), h("option", { value: "both" }, "ASCII + HEX"), h("option", { value: "hex" }, "HEX")));
    view.value = d.terminalView ?? (d.binary ? "both" : "ascii");
    view.onchange = () => {
      d.terminalView = view.value;
      this.redrawLog();
    };
    const follow = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: true }));
    this.follow = follow;
    const pollTraffic = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: Boolean(d.showPollTraffic) }));
    pollTraffic.onchange = () => {
      d.showPollTraffic = pollTraffic.checked;
      this.redrawLog();
    };
    const clear = h("button.button.small", { type: "button", onclick: () => {
      d.log.length = 0;
      this.redrawLog();
    } }, "Clear");

    replace(this.terminalCard,
      h("h3.card-title", null, "Terminal"),
      h("div.row", { style: { marginBottom: "8px" } }, view, h("label.check", null, follow, "Follow"), h("label.check", { title: "Show every byte the scheduler sends and receives on this port" }, pollTraffic, "Polling traffic"), h("div.grow"), clear),
      this.log,
      this.buildComposer());
    this.redrawLog();
  }

  buildComposer() {
    const d = this.device;
    const commands = d.codec.commands?.() ?? [];
    const mode = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Composer mode" }, h("option", { value: "command" }, "Command"), h("option", { value: "raw" }, "Raw")));
    const cmdSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Command" }, commands.map((/** @type {any} */ c) => h("option", { value: c.name }, `${c.name}${c.write ? (c.read ? " (read/write)" : " (write)") : ""}`))));
    const value = /** @type {HTMLInputElement} */ (h("input", { type: "text", placeholder: "value (writes only)", style: { width: "150px" } }));
    const format = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Input format" }, ["ascii", "escaped", "hex", "decimal", "base64"].map((f) => h("option", { value: f }, f === "ascii" ? "ASCII" : f === "escaped" ? "Escaped text" : f[0].toUpperCase() + f.slice(1)))));
    format.value = d.binary ? "hex" : "ascii";
    const ending = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Line ending" }, [["", "No ending"], ["\r", "CR"], ["\n", "LF"], ["\r\n", "CR LF"]].map(([v, l]) => h("option", { value: v }, l))));
    const raw = /** @type {HTMLInputElement} */ (h("input.grow", { type: "text", placeholder: d.binary ? "e.g. 03 00 3B 00 3B" : "e.g. @254PR3?\\" }));
    const preview = h("div.byte-preview", { "aria-live": "polite" });
    const risk = h("span");
    const send = /** @type {HTMLButtonElement} */ (h("button.button.primary", { type: "button" }, "Send"));

    const current = () => {
      if (mode.value === "command") {
        const info = commands.find((/** @type {any} */ c) => c.name === cmdSelect.value);
        const v = value.value.trim();
        const isWrite = Boolean(info?.write) && (v !== "" || !info?.read);
        const bytes = d.codec.buildRequest(cmdSelect.value, isWrite ? (v === "" ? "" : coerce(v)) : undefined);
        return { bytes, command: cmdSelect.value, info, isWrite, value: v };
      }
      let bytes = parseInput(raw.value, /** @type {any} */ (format.value));
      if ((format.value === "ascii" || format.value === "escaped") && ending.value) bytes = Uint8Array.from([...bytes, ...Array.from(ending.value, (c) => c.charCodeAt(0))]);
      return { bytes, command: "", info: null, isWrite: true, value: "" };
    };
    const refresh = () => {
      const isCommand = mode.value === "command";
      cmdSelect.hidden = !isCommand;
      const info = commands.find((/** @type {any} */ c) => c.name === cmdSelect.value);
      value.hidden = !isCommand || !info?.write;
      value.placeholder = info?.valueHint ? info.valueHint : info?.read ? "value to write (empty = read)" : "value";
      format.hidden = isCommand;
      raw.hidden = isCommand;
      ending.hidden = isCommand || !(format.value === "ascii" || format.value === "escaped");
      try {
        const c = current();
        const check = !isCommand && d.codec.validateFrame ? d.codec.validateFrame(c.bytes) : null;
        preview.className = `byte-preview${check && !check.ok ? " bad" : ""}`;
        preview.textContent = c.bytes.length ? `${toHex(c.bytes)}   ${printable(c.bytes)}${check ? `   — ${check.detail}` : ""}` : "—";
        const level = isCommand ? (c.isWrite ? info?.risk ?? "caution" : "safe") : "caution";
        replace(risk, h(`span.risk.${level}`, null, level), isCommand && info?.description ? h("span.hint", null, ` ${info.description}`) : null);
        send.disabled = !c.bytes.length;
      } catch (error) {
        preview.className = "byte-preview bad";
        preview.textContent = /** @type {Error} */ (error).message;
        send.disabled = true;
      }
    };
    for (const el of [mode, cmdSelect, format, ending]) el.addEventListener("change", refresh);
    for (const el of [value, raw]) el.addEventListener("input", refresh);
    send.onclick = async () => {
      try {
        const c = current();
        if (mode.value === "command") await this.app.sendCommand(d, c.command, c.isWrite ? (c.value === "" ? "" : coerce(c.value)) : undefined);
        else await this.app.sendRaw(d, c.bytes);
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "bad");
      }
    };
    refresh();
    return h("div.composer", null, h("div.row", null, mode, cmdSelect, value, format, ending, raw), preview, h("div.row", null, risk, h("div.grow"), send));
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
      const cls = e.kind === "err" ? "err" : e.kind === "note" ? "note" : e.kind;
      const body = e.bytes
        ? view === "hex"
          ? toHex(e.bytes)
          : view === "both"
            ? [printable(e.bytes), h("span.term-hex", null, `  ${toHex(e.bytes)}`)]
            : printable(e.bytes)
        : e.text;
      fragment.append(h(`div.term-line.${cls}`, null, h("span.t", null, formatClock(e.t)), h("span.dir", null, e.kind === "tx" ? "→" : e.kind === "rx" ? "←" : "•"),
        h("span", null, body, e.parsed ? h("span.parsed", null, `   ${e.parsed}`) : null, e.error ? h("span.parsed", { style: { color: "var(--red)" } }, `   ${e.error}`) : null)));
    }
    this.renderedLog = entries.length;
    this.log.append(fragment);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild?.remove();
    if (this.follow?.checked) this.log.scrollTop = this.log.scrollHeight;
  }
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
