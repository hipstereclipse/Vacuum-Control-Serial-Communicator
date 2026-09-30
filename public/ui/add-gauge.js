// @ts-check
/**
 * Add Gauge dialog (WEB_PORT_PLAN.md sections 6 and 8): grant ports, scan granted ports with
 * read-only probes, multi-select results, then confirm model, line settings, RS485 address,
 * poll commands and — for every CDG — the full scale, before anything is added.
 */
import { h, replace, openDialog, closeDialog, toast } from "./dom.js";
import { scanPort, sweepAddresses } from "../core/scan/scanner.js";
import { Registry, FAMILY_LABELS } from "../core/registry/registry.js";
import { CDG_FULL_SCALE_OPTIONS_MBAR, DEFAULT_POLL_INTERVAL_MS } from "../core/constants.js";

const TORR_MBAR = 1.33322;
/** Full-scale options in the unit the head is calibrated in, from CSC's canonical mbar list. */
export const FS_TORR = [0.1, 0.25, 1, 2, 10, 20, 100, 200, 500, 1000].map((torr) => ({ value: torr, unit: "Torr", mbar: nearestOption(torr * TORR_MBAR) }));
export const FS_MBAR = [0.1, 0.25, 1, 2, 10, 20, 100, 200, 500, 1000, 1100].map((mbar) => ({ value: mbar, unit: "mbar", mbar }));

/** @param {number} mbar */
function nearestOption(mbar) {
  return CDG_FULL_SCALE_OPTIONS_MBAR.reduce((a, b) => (Math.abs(b - mbar) < Math.abs(a - mbar) ? b : a));
}

/** Full-scale choice from a scan hint in mbar (Torr-native heads take precedence when they match). @param {number | null | undefined} mbar */
export function fullScaleFromMbar(mbar) {
  if (!(Number(mbar) > 0)) return null;
  return FS_TORR.find((o) => Math.abs(o.mbar - Number(mbar)) / o.mbar < 0.01) ?? FS_MBAR.find((o) => Math.abs(o.mbar - Number(mbar)) / o.mbar < 0.01) ?? null;
}

/**
 * @param {any} app
 */
export function openAddGauge(app) {
  /** @type {any[]} */
  let results = [];
  /** @type {any[]} */
  let configs = [];
  let scanning = false;
  const controller = { aborted: false, abort: new AbortController() };

  const portsBox = h("div");
  const scanBox = h("div");
  const resultsBox = h("div");
  const configBox = h("div");
  const statusLog = h("div.scan-status", { "aria-live": "polite" });
  const addButton = /** @type {HTMLButtonElement} */ (h("button.button.primary", { type: "button" }, "Add selected"));

  const status = (/** @type {string} */ line) => {
    statusLog.append(h("div", null, line));
    statusLog.scrollTop = statusLog.scrollHeight;
  };

  async function renderPorts() {
    const ports = await app.grantedPorts();
    const rows = ports.map((/** @type {any} */ p) => {
      const name = /** @type {HTMLInputElement} */ (h("input", { type: "text", value: p.label, "aria-label": "Port name", style: { width: "180px" } }));
      name.onchange = () => app.renamePort(p, name.value);
      const exclude = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: p.excluded }));
      exclude.onchange = () => app.setPortExcluded(p, exclude.checked);
      const rs = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "RS mode" }, h("option", null, "RS232"), h("option", null, "RS485")));
      rs.value = p.rsMode;
      rs.onchange = () => app.setPortRsMode(p, rs.value);
      return h("tr", null,
        h("td", null, name),
        h("td.hint", null, p.usb),
        h("td", null, rs),
        h("td", null, h("label.check", null, exclude, "exclude from scans")),
        h("td", null, p.inUse ? h("span.chip.info", null, "in use") : h("span.hint", null, "free")));
    });
    replace(portsBox,
      rows.length
        ? h("table.data", null, h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "USB"), h("th", null, "Mode"), h("th", null, ""), h("th", null, ""))), h("tbody", null, rows))
        : h("p.empty", null, "No ports granted yet. A page can only open ports you pick in the browser's port chooser, once per adapter."),
      h("div.row", { style: { marginTop: "8px" } },
        h("button.button", { type: "button", onclick: async () => {
          await app.requestPort();
          renderPorts();
        } }, "Grant a port…"),
        h("span.hint", null, "Windows COM names are hidden from web pages; name each adapter so you can tell identical ones apart.")));
  }

  function renderScan() {
    const mode = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Scan mode" }, h("option", { value: "quick" }, "Quick — documented factory rates"), h("option", { value: "thorough" }, "Thorough — every rate (~5 s per silent port)")));
    const scanButton = /** @type {HTMLButtonElement} */ (h("button.button.primary", { type: "button" }, "Scan granted ports"));
    const cancel = /** @type {HTMLButtonElement} */ (h("button.button", { type: "button", hidden: true }, "Cancel scan"));
    scanButton.onclick = async () => {
      if (scanning) return;
      scanning = true;
      scanButton.disabled = true;
      cancel.hidden = false;
      controller.abort = new AbortController();
      statusLog.replaceChildren();
      try {
        const ports = (await app.grantedPorts()).filter((/** @type {any} */ p) => !p.excluded && !p.inUse);
        if (!ports.length) status("No free, non-excluded granted ports to scan.");
        for (const p of ports) {
          if (controller.abort.signal.aborted) break;
          status(`${p.label}: opening…`);
          const session = app.sessionFor(p);
          const outcome = await scanPort(session, {
            mode: /** @type {any} */ (mode.value),
            rsMode: p.rsMode,
            registry: app.registry,
            signal: controller.abort.signal,
            onStatus: (/** @type {string} */ m) => status(`${p.label}: ${m}`)
          }).catch((/** @type {Error} */ e) => ({ results: [], verdict: e.message }));
          status(`${p.label}: ${outcome.verdict}`);
          for (const r of outcome.results) results.push({ ...r, portKey: p.key, portLabel: p.label, selected: true });
        }
      } finally {
        scanning = false;
        scanButton.disabled = false;
        cancel.hidden = true;
        renderResults();
      }
    };
    cancel.onclick = () => controller.abort.abort();

    const family = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Protocol family" }, h("option", { value: "inficon_binary" }, "PxG55x binary"), h("option", { value: "ppg_ascii" }, "PPG ASCII"), h("option", { value: "pfeiffer_ascii" }, "Pfeiffer ASCII")));
    const baud = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Baud" }, [57600, 38400, 19200, 9600].map((b) => h("option", { value: String(b) }, `${b}`))));
    const from = /** @type {HTMLInputElement} */ (h("input", { type: "number", value: "1", min: "0", max: "255", style: { width: "70px" } }));
    const to = /** @type {HTMLInputElement} */ (h("input", { type: "number", value: "16", min: "0", max: "255", style: { width: "70px" } }));
    const sweep = h("button.button", { type: "button", onclick: async () => {
      const ports = (await app.grantedPorts()).filter((/** @type {any} */ p) => p.rsMode === "RS485" && !p.inUse && !p.excluded);
      if (!ports.length) return toast("Mark a free granted port as RS485 first.", "warn");
      controller.abort = new AbortController();
      for (const p of ports) {
        status(`${p.label}: sweeping addresses ${from.value}–${to.value} at ${baud.value} baud (${family.value})`);
        const outcome = await sweepAddresses(app.sessionFor(p), {
          family: /** @type {any} */ (family.value), baudRate: Number(baud.value), from: Number(from.value), to: Number(to.value),
          registry: app.registry, signal: controller.abort.signal, onStatus: (/** @type {string} */ m) => status(`${p.label}: ${m}`)
        }).catch((/** @type {Error} */ e) => {
          status(`${p.label}: ${e.message}`);
          return { results: [] };
        });
        status(`${p.label}: ${outcome.results.length} device(s) answered`);
        for (const r of outcome.results) results.push({ ...r, portKey: p.key, portLabel: p.label, selected: true });
      }
      renderResults();
    } }, "Sweep RS485 addresses");

    replace(scanBox,
      h("div.row", null, mode, scanButton, cancel),
      h("details", null, h("summary", null, "RS485 address sweep (slow; only on ports marked RS485)"),
        h("div.row", { style: { marginTop: "8px" } }, family, baud, "from", from, "to", to, sweep),
        h("p.hint", null, "One read per address with a short timeout. Broadcast addresses are never used on a multi-drop bus. 🟠 The PxG55x RS485 address range and factory address still need checking in the manufacturer's protocol document (V2).")),
      statusLog);
  }

  function renderResults() {
    if (!results.length) {
      replace(resultsBox, h("p.empty", null, "Nothing found yet. Scan, or add a gauge manually."));
      return;
    }

    let lastClickIndex = -1;

    const rowMap = new Map();
    const rows = results.map((r, idx) => {
      const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: r.selected }));
      const row = h("tr", null,
        h("td", null, box),
        h("td", null, r.portLabel),
        h("td", null, h("strong", null, r.modelHint), r.model ? null : h("div.hint", null, "no matching model — choose one below")),
        h("td", null, `${r.baudRate} baud`, r.rsMode === "RS485" ? ` · addr ${r.address}` : ""),
        h("td.hint", null, r.description),
        h("td", null, r.family === "cdg_serial" ? (r.fullScaleConfident ? h("span.chip.ok", null, `FS≈${r.fullScaleMbar} mbar`) : h("span.chip.warn", null, "FS unknown")) : ""));

      rowMap.set(idx, { row, box });
      row.classList.toggle("selected", r.selected);

      row.onmousedown = (e) => {
        if (e.button !== 0) return;

        if (e.ctrlKey || e.metaKey) {
          // Ctrl/Cmd+click: toggle individual item
          r.selected = !r.selected;
          lastClickIndex = idx;
        } else if (e.shiftKey && lastClickIndex >= 0) {
          // Shift+click: select range
          const [start, end] = lastClickIndex < idx ? [lastClickIndex, idx] : [idx, lastClickIndex];
          for (let i = start; i <= end; i++) results[i].selected = true;
          lastClickIndex = idx;
        } else {
          // Regular click: select only this item (unless dragging)
          results.forEach((x, i) => x.selected = i === idx);
          lastClickIndex = idx;
        }

        updateAllRows();
      };

      row.onmouseover = (e) => {
        // Click and drag: select range from last click to current
        if (e.buttons === 1 && lastClickIndex >= 0 && lastClickIndex !== idx) {
          const [start, end] = lastClickIndex < idx ? [lastClickIndex, idx] : [idx, lastClickIndex];
          results.forEach((x, i) => x.selected = i >= start && i <= end);
          updateAllRows();
        }
      };

      box.onchange = () => {
        r.selected = box.checked;
        row.classList.toggle("selected", r.selected);
      };

      return row;
    });

    const updateAllRows = () => {
      rowMap.forEach(({ row, box }, idx) => {
        const isSelected = results[idx].selected;
        row.classList.toggle("selected", isSelected);
        box.checked = isSelected;
      });
    };

    replace(resultsBox,
      h("div.scroll", null, h("table.data", null, h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Port"), h("th", null, "Found"), h("th", null, "Line"), h("th", null, "Details"), h("th", null, ""))), h("tbody", null, rows))),
      h("div.row", { style: { marginTop: "8px" } }, h("button.button", { type: "button", onclick: () => {
        for (const r of results.filter((x) => x.selected)) configs.push(configFromResult(app, r));
        results = results.filter((x) => !x.selected);
        renderResults();
        renderConfigs();
      } }, "Use selected ↓")));
  }

  function renderConfigs() {
    replace(configBox,
      ...configs.map((c, i) => configEditor(app, c, () => {
        configs.splice(i, 1);
        renderConfigs();
      }, updateAddButton)),
      h("div.row", null, h("button.button", { type: "button", onclick: async () => {
        const ports = await app.grantedPorts();
        configs.push(configFromResult(app, { family: "cdg_serial", model: "CDG045D", portKey: ports[0]?.key ?? "", baudRate: 9600, rsMode: "RS232", address: 0 }));
        renderConfigs();
      } }, "Add a gauge manually")));
    updateAddButton();
  }

  function updateAddButton() {
    const blocking = configs.find((c) => problems(app, c).length);
    addButton.disabled = !configs.length || Boolean(blocking);
    addButton.title = blocking ? problems(app, blocking)[0] : "";
    addButton.textContent = configs.length > 1 ? `Add ${configs.length} gauges` : "Add gauge";
  }

  addButton.onclick = async () => {
    addButton.disabled = true;
    for (const c of configs.slice()) {
      try {
        await app.addRealDevice(c);
        configs.splice(configs.indexOf(c), 1);
      } catch (error) {
        toast(`${c.model}: ${/** @type {Error} */ (error).message}`, "bad", 8000);
      }
    }
    renderConfigs();
    if (!configs.length) closeDialog("addGaugeDialog");
  };

  openDialog("addGaugeDialog", {
    body: [
      h("div.steps", null,
        h("section.step", null, h("h3", null, h("span.num", null, "1"), "Grant ports"), portsBox),
        h("section.step", null, h("h3", null, h("span.num", null, "2"), "Scan"), scanBox,
          h("p.hint", null, "Scanning sends read requests only. It listens for a CDG left streaming, then tries PPG, Pfeiffer ASCII, CDG, PxG55x and P3 V02 in turn, stopping at the first verified identity.")),
        h("section.step", null, h("h3", null, h("span.num", null, "3"), "Results"), resultsBox),
        h("section.step", null, h("h3", null, h("span.num", null, "4"), "Confirm and add"), configBox),
        h("div.callout", null, "A gauge ordered with only a fieldbus interface (EtherCAT, Profibus, DeviceNet, Profinet) or only an analog output cannot be reached from this tool. RS485 needs an auto-direction USB-RS485 adapter."))
    ],
    actions: [h("button.button", { type: "button", onclick: () => closeDialog("addGaugeDialog") }, "Close"), addButton],
    onClose: () => controller.abort.abort()
  });
  renderPorts();
  renderScan();
  renderResults();
  renderConfigs();
}

/** @param {any} app @param {any} r */
function configFromResult(app, r) {
  const model = r.model || guessModel(app, r.family);
  const spec = model ? app.registry.get(model) : null;
  const fs = r.family === "cdg_serial" && r.fullScaleConfident ? fullScaleFromMbar(r.fullScaleMbar) : null;
  return {
    model,
    portKey: r.portKey,
    baudRate: r.baudRate ?? spec?.transport?.default_baud ?? 9600,
    rsMode: r.rsMode ?? "RS232",
    address: r.address ?? spec?.transport?.default_address ?? 0,
    fullScale: fs ? { ...fs, origin: "scan" } : null,
    fullScaleConfirmed: false,
    commands: defaultCommands(spec),
    intervalMs: spec?.protocol === "cdg_serial" ? DEFAULT_POLL_INTERVAL_MS : 500,
    identity: { serial: r.serial ?? "", firmware: r.firmware ?? "" },
    scanned: Boolean(r.modelHint),
    streaming: Boolean(r.streaming)
  };
}

/** @param {any} app @param {string} family */
function guessModel(app, family) {
  const first = app.registry.list("gauge").find((/** @type {any} */ s) => s.protocol === family || (family === "pfeiffer_ascii" && s.protocol === "inficon_ascii"));
  return first?.model ?? "";
}

/** @param {any} spec */
export function defaultCommands(spec) {
  if (!spec) return ["pressure"];
  if (spec.model === "TC600") return ["pump_on", "actual_speed_hz", "motor_current_A", "motor_power_W", "error_code"];
  const reads = Object.entries(spec.commands).filter(([, c]) => /** @type {any} */ (c).read).map(([name]) => name);
  return reads.includes("pressure") ? ["pressure"] : reads.slice(0, 1);
}

/** @param {any} app @param {any} c @returns {string[]} */
function problems(app, c) {
  const out = [];
  if (!c.model) out.push("Choose a model.");
  if (!c.portKey) out.push("Choose a granted port.");
  const spec = c.model && app.registry.has(c.model) ? app.registry.get(c.model) : null;
  if (spec?.protocol === "cdg_serial" && !(c.fullScale && c.fullScaleConfirmed)) out.push("Confirm the CDG full scale before logging.");
  if (c.rsMode === "RS485" && !(c.address >= 0 && c.address <= 255)) out.push("Enter the RS485 address.");
  if (spec && c.rsMode === "RS485" && !(spec.transport.rs_modes ?? ["RS232"]).includes("RS485")) out.push(`${spec.model} has no RS485 interface.`);
  return out;
}

/**
 * @param {any} app @param {any} c @param {() => void} onRemove @param {() => void} onChange
 */
function configEditor(app, c, onRemove, onChange) {
  const box = h("div.step");
  const render = () => {
    const spec = c.model && app.registry.has(c.model) ? app.registry.get(c.model) : null;
    const model = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Model" },
      ...groupedModels(app).map(([family, specs]) => h("optgroup", { label: family }, specs.map((/** @type {any} */ s) => h("option", { value: s.model }, `${s.model}${s.experimental ? " (experimental)" : ""}`))))));
    model.value = c.model;
    model.onchange = () => {
      c.model = model.value;
      const next = app.registry.get(c.model);
      c.baudRate = next.transport.default_baud;
      c.address = next.transport.default_address ?? 0;
      c.commands = defaultCommands(next);
      if (next.protocol !== "cdg_serial") c.fullScale = null;
      render();
      onChange();
    };
    const port = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Port" }));
    app.grantedPorts().then((/** @type {any[]} */ ports) => {
      replace(port, ...ports.map((p) => h("option", { value: p.key }, p.label)));
      if (!c.portKey && ports[0]) c.portKey = ports[0].key;
      port.value = c.portKey;
    });
    port.onchange = () => {
      c.portKey = port.value;
      onChange();
    };
    const baud = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Baud rate" }, [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => h("option", { value: String(b) }, String(b)))));
    baud.value = String(c.baudRate);
    baud.onchange = () => (c.baudRate = Number(baud.value));
    const rs = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "RS mode" }, ...(spec?.transport?.rs_modes ?? ["RS232", "RS485"]).map((/** @type {string} */ m) => h("option", null, m))));
    rs.value = c.rsMode;
    rs.onchange = () => {
      c.rsMode = rs.value;
      render();
      onChange();
    };
    const address = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: "0", max: "255", value: String(c.address), style: { width: "80px" } }));
    address.onchange = () => {
      c.address = Number(address.value);
      onChange();
    };
    const interval = /** @type {HTMLInputElement} */ (h("input", { type: "number", min: "10", step: "10", value: String(c.intervalMs), style: { width: "100px" } }));
    interval.onchange = () => (c.intervalMs = Number(interval.value));
    const reads = spec ? Object.entries(spec.commands).filter(([, x]) => /** @type {any} */ (x).read) : [];
    const commandBoxes = reads.map(([name, x]) => {
      const cb = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: c.commands.includes(name) }));
      cb.onchange = () => {
        c.commands = reads.map(([n]) => n).filter((n) => (n === name ? cb.checked : c.commands.includes(n)));
      };
      return h("label.check", { title: /** @type {any} */ (x).description ?? "" }, cb, name);
    });

    replace(box,
      h("div.row", null, h("strong", null, c.model || "New gauge"), spec?.experimental ? h("span.chip.warn", null, "experimental") : null,
        c.scanned ? h("span.chip.info", null, "from scan") : null, h("div.grow"), h("button.button.small", { type: "button", onclick: onRemove }, "Remove")),
      h("div.grid-2", null,
        h("label.field", null, h("span.field-label", null, "Model"), model),
        h("label.field", null, h("span.field-label", null, "Port"), port),
        h("label.field", null, h("span.field-label", null, "Baud"), baud),
        h("label.field", null, h("span.field-label", null, "Interface"), rs),
        c.rsMode === "RS485" ? h("label.field", null, h("span.field-label", null, "RS485 address"), address) : null,
        h("label.field", null, h("span.field-label", null, spec?.protocol === "cdg_serial" ? "Record every (ms)" : "Poll every (ms)"), interval)),
      spec ? h("div.hint", null, `${FAMILY_LABELS[/** @type {keyof typeof FAMILY_LABELS} */ (spec.protocol)] ?? spec.protocol} · source: ${spec.source}`) : null,
      spec?.protocol === "cdg_serial" ? fullScalePicker(c, () => {
        render();
        onChange();
      }) : null,
      spec && spec.protocol !== "cdg_serial" ? h("div.field", null, h("span.field-label", null, "Poll commands (reads only)"), h("div.poll-commands", null, commandBoxes)) : null,
      h("div.hint.problem", null, problems(app, c).join(" ")));
  };
  render();
  return box;
}

/** @param {any} app @returns {[string, any[]][]} */
function groupedModels(app) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const s of app.registry.list("gauge").concat(app.registry.list("turbo"))) {
    const label = FAMILY_LABELS[/** @type {keyof typeof FAMILY_LABELS} */ (s.protocol)] ?? s.protocol;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)?.push(s);
  }
  return [...groups.entries()];
}

/**
 * Full-scale confirmation with explicit units, Torr-native and mbar-native side by side. The
 * reading is only as good as this number: 10 Torr and 10 mbar differ by 1.333x (CSC guide 8.4).
 * @param {any} c @param {() => void} onChange
 */
export function fullScalePicker(c, onChange) {
  const name = `fs-${Math.random().toString(36).slice(2)}`;
  const option = (/** @type {any} */ o) => {
    const input = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name, checked: Boolean(c.fullScale && c.fullScale.unit === o.unit && c.fullScale.value === o.value) }));
    input.onchange = () => {
      c.fullScale = { ...o, origin: c.fullScale && c.fullScale.value === o.value && c.fullScale.unit === o.unit ? c.fullScale.origin : "user" };
      c.fullScaleConfirmed = false;
      onChange();
    };
    return h("label.check", null, input, `${o.value} ${o.unit}`);
  };
  const confirm = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: Boolean(c.fullScaleConfirmed), disabled: !c.fullScale }));
  confirm.onchange = () => {
    c.fullScaleConfirmed = confirm.checked;
    if (confirm.checked && c.fullScale && c.fullScale.origin !== "scan") c.fullScale.origin = "user";
    onChange();
  };
  return h("div.field", null,
    h("span.field-label", null, "Full scale — required for every CDG"),
    c.fullScale?.origin === "scan"
      ? h("div.callout", null, `The scan inferred ${c.fullScale.value} ${c.fullScale.unit} from the gauge's type word (within 5 %). Check it against the label on the gauge.`)
      : h("div.callout.warn", null, "The scan could not infer the full scale confidently. Read it from the gauge label or order code."),
    h("div.fs-options", null,
      h("fieldset", null, h("legend", null, "Torr-native heads"), FS_TORR.map(option)),
      h("fieldset", null, h("legend", null, "mbar-native heads"), FS_MBAR.map(option))),
    h("label.check", null, confirm, c.fullScale ? `I confirm this gauge's full scale is ${c.fullScale.value} ${c.fullScale.unit} (${c.fullScale.mbar} mbar).` : "Choose a full scale first."));
}
