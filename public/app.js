// @ts-check
/**
 * Gauge Serial Communicator — UI wiring. All device behaviour lives in public/core (framework
 * free, tested in Node); this module orchestrates ports, schedulers, devices, sessions, exports
 * and tabs.
 */
import { h, $, replace, toast, openDialog, closeDialog, download, SERIES_COLORS } from "./ui/dom.js";
import { DeviceTab } from "./ui/device-tab.js";
import { CombinedTab } from "./ui/combined.js";
import { SimulationTab, openSimulate, SIMULATABLE } from "./ui/simulate.js";
import { openAddGauge, defaultCommands, fullScalePicker, fullScaleFromMbar } from "./ui/add-gauge.js";
import { confirmSend, confirmBatch } from "./ui/confirm.js";
import { openSetpointEditor } from "./ui/setpoints.js";
import { detectSetpoints } from "./core/setpoints.js";
import { Registry } from "./core/registry/registry.js";
import { PortSession, describePort } from "./core/transport/port-session.js";
import { EmulatedPort } from "./core/transport/emulated-port.js";
import { PortScheduler } from "./core/scheduler/port-scheduler.js";
import { Series, SAMPLE_STATUS, statusFromWarnings } from "./core/store/buffers.js";
import { makeSession, parseSession } from "./core/store/session.js";
import { saveSession, listSessions, loadSession, deleteSession, requestPersistence, storageAvailable } from "./core/store/idb.js";
import { csvHeader, measurementCsv, trafficCsv, transcript } from "./core/store/export.js";
import { PRESSURE_UNITS } from "./core/units.js";
import { toHex } from "./core/bytes.js";
import { createSimulation } from "./core/sim/index.js";
import { createCdgEmulator } from "./core/sim/emulators/cdg.js";
import { createPxgEmulator } from "./core/sim/emulators/pxg.js";
import { createPpgEmulator } from "./core/sim/emulators/ppg.js";
import { createPfeifferAsciiEmulator } from "./core/sim/emulators/pfeiffer-ascii.js";
import { createP3V02Emulator } from "./core/sim/emulators/p3v02.js";
import { createTc600Codec } from "./core/turbo/tc600.js";

const TRAFFIC_CAP = 100000;
const LOG_CAP = 2000;
const AUTOSAVE_MS = 10000;
const store = {
  get: (/** @type {string} */ k, /** @type {any} */ fallback) => {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set: (/** @type {string} */ k, /** @type {any} */ v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  }
};

const state = {
  /** @type {Map<string, any>} */
  devices: new Map(),
  /** @type {Map<any, { key: string, session: any, scheduler: PortScheduler | null }>} */
  ports: new Map(),
  /** @type {{ t: number, dir: string, device: string, bytes: Uint8Array, note?: string }[]} */
  traffic: [],
  trafficSaved: 0,
  /** @type {any[]} */
  writes: [],
  /** @type {any[]} */
  gaps: [],
  sessionId: newId(),
  sessionName: `Session ${new Date().toLocaleString()}`,
  created: new Date().toISOString(),
  autosave: store.get("gauge-communicator-autosave", true),
  displayUnit: store.get("gauge-communicator-unit", "auto"),
  layout: { combined: "overlay", hidden: /** @type {string[]} */ ([]), colors: /** @type {Record<string, string>} */ ({}) },
  selectedTab: "welcome",
  dirty: false,
  structural: false,
  build: { version: "0.1.0", build: "dev" },
  /** @type {any} */
  simulation: null
};
/** @type {Registry} */
let registry;
/** @type {Map<string, any>} */
const panels = new Map();
let deviceCounter = 0;
let renderQueued = false;

const app = {
  get registry() {
    return registry;
  },
  state,
  displayUnit: () => state.displayUnit,
  markDirty: () => (state.dirty = true),
  grantedPorts,
  requestPort,
  sessionFor,
  renamePort,
  setPortExcluded,
  setPortRsMode,
  addRealDevice,
  addSimulatedDevice,
  removeDevice,
  renameDevice,
  setPolling,
  setCommands,
  setIntervalMs,
  sendCommand,
  sendRaw,
  query,
  writeBatch,
  openSetpoints,
  setpointLayout,
  openDictionary,
  exportDevice,
  changeFullScale,
  simulation
};

// ---------------------------------------------------------------------------------------------
// Boot

async function boot() {
  const supported = "serial" in navigator;
  if (!supported) {
    $("#unsupported").hidden = false;
    $("#unsupportedDemo").onclick = () => {
      $("#unsupported").hidden = true;
      startDemo();
    };
  }
  try {
    registry = await Registry.load(new URL("./specs/all.json", document.baseURI));
  } catch (error) {
    replace($("#panels"), h("div.panel", null, h("div.callout.danger", null, `Could not load device specs: ${/** @type {Error} */ (error).message}`)));
    return;
  }
  try {
    const info = await fetch(new URL("./build-info.json", document.baseURI)).then((r) => (r.ok ? r.json() : null));
    if (info) state.build = info;
  } catch {}
  $("#buildInfo").textContent = `v${state.build.version} · ${state.build.build}`;

  const unit = /** @type {HTMLSelectElement} */ ($("#unitSelect"));
  replace(unit, h("option", { value: "auto" }, "As reported"), ...PRESSURE_UNITS.map((u) => h("option", { value: u }, u)));
  unit.value = state.displayUnit;
  unit.onchange = () => {
    state.displayUnit = unit.value;
    store.set("gauge-communicator-unit", unit.value);
    queueRender();
  };
  const name = /** @type {HTMLInputElement} */ ($("#sessionName"));
  name.value = state.sessionName;
  name.onchange = () => {
    state.sessionName = name.value || state.sessionName;
    state.dirty = true;
  };
  const dot = $("#autosaveDot");
  dot.dataset.on = String(state.autosave);
  dot.style.cursor = "pointer";
  dot.onclick = () => {
    state.autosave = !state.autosave;
    dot.dataset.on = String(state.autosave);
    store.set("gauge-communicator-autosave", state.autosave);
    toast(state.autosave ? "Autosave on" : "Autosave off");
  };
  if (!(await storageAvailable())) {
    dot.dataset.on = "false";
    dot.title = "Browser storage is unavailable here (private window or blocked site data); export to keep your data.";
  }
  $("#themeToggle").onclick = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    store.set("gauge-communicator-theme", next);
    try {
      localStorage.setItem("gauge-communicator-theme", next);
    } catch {}
  };
  $("#addGaugeButton").onclick = () => {
    if (!("serial" in navigator)) return toast("This browser has no Web Serial. Use Chrome or Edge, or try the simulator.", "warn", 7000);
    openAddGauge(app);
  };
  $("#simulateButton").onclick = () => openSimulate(app);
  $("#turboButton").onclick = openTurbo;
  $("#demoButton").onclick = startDemo;
  $("#exportButton").onclick = openExport;
  $("#sessionsButton").onclick = openSessions;
  $("#helpButton").onclick = openHelp;
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const d = state.devices.get(state.selectedTab);
      openDictionary(d ?? [...state.devices.values()][0]);
    }
  });
  document.addEventListener("visibilitychange", renderBanner);
  if ("serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (/** @type {any} */ e) => onPortDisconnect(e.target ?? e.port));
    navigator.serial.addEventListener("connect", (/** @type {any} */ e) => onPortConnect(e.target ?? e.port));
  }
  setInterval(autosave, AUTOSAVE_MS);
  window.addEventListener("beforeunload", () => void autosave());
  requestPersistence();
  render();
  if (new URLSearchParams(location.search).has("demo")) startDemo();
}

// ---------------------------------------------------------------------------------------------
// Ports

/** @type {WeakMap<any, string>} */
const portKeys = new WeakMap();
let portCounter = 0;

/** @param {any} port */
function keyFor(port) {
  if (!portKeys.has(port)) portKeys.set(port, `p${++portCounter}`);
  return /** @type {string} */ (portKeys.get(port));
}

/** Stable identity for names and exclusions across reloads: USB IDs plus the index among identical adapters. @param {any} port @param {any[]} all */
function storageKey(port, all) {
  const info = port.getInfo?.() ?? {};
  const same = all.filter((p) => {
    const i = p.getInfo?.() ?? {};
    return i.usbVendorId === info.usbVendorId && i.usbProductId === info.usbProductId;
  });
  return `${info.usbVendorId ?? "x"}:${info.usbProductId ?? "x"}#${same.indexOf(port)}`;
}

async function grantedPorts() {
  if (!("serial" in navigator)) return [];
  const ports = await navigator.serial.getPorts();
  const meta = store.get("gauge-communicator-ports", {});
  return ports.map((/** @type {any} */ port) => {
    const skey = storageKey(port, ports);
    const m = meta[skey] ?? {};
    const record = state.ports.get(port);
    return {
      key: keyFor(port),
      port,
      storageKey: skey,
      label: m.name || describePort(port),
      usb: describePort(port),
      excluded: Boolean(m.excluded),
      rsMode: m.rsMode ?? "RS232",
      inUse: Boolean(record?.session?.isOpen),
      info: port.getInfo?.() ?? {}
    };
  });
}

async function requestPort() {
  try {
    await navigator.serial.requestPort();
  } catch (error) {
    if (/** @type {Error} */ (error).name !== "NotFoundError") toast(/** @type {Error} */ (error).message, "bad");
  }
}

/** @param {any} p @param {(m: any) => void} change */
function updatePortMeta(p, change) {
  const meta = store.get("gauge-communicator-ports", {});
  meta[p.storageKey] = meta[p.storageKey] ?? {};
  change(meta[p.storageKey]);
  store.set("gauge-communicator-ports", meta);
}
/** @param {any} p @param {string} name */
function renamePort(p, name) {
  updatePortMeta(p, (m) => (m.name = name));
  const record = state.ports.get(p.port);
  if (record) record.session.label = name;
}
/** @param {any} p @param {boolean} excluded */
function setPortExcluded(p, excluded) {
  updatePortMeta(p, (m) => (m.excluded = excluded));
}
/** @param {any} p @param {string} rsMode */
function setPortRsMode(p, rsMode) {
  updatePortMeta(p, (m) => (m.rsMode = rsMode));
}

/** One PortSession per physical port, shared by every device on an RS485 bus. @param {any} p */
function sessionFor(p) {
  let record = state.ports.get(p.port);
  if (!record) {
    const session = new PortSession(p.port, { label: p.label });
    session.on("traffic", (/** @type {any} */ e) => onTraffic(session, e));
    record = { key: p.key, session, scheduler: null };
    state.ports.set(p.port, record);
  }
  return record.session;
}

/** @param {any} session @param {{ dir: string, bytes: Uint8Array, t: number }} e */
function onTraffic(session, e) {
  const devices = [...state.devices.values()].filter((d) => d.session === session);
  const label = devices.length === 1 ? devices[0].label : session.label;
  state.traffic.push({ t: e.t, dir: e.dir, device: label, bytes: e.bytes });
  if (state.traffic.length > TRAFFIC_CAP) {
    const drop = state.traffic.length - TRAFFIC_CAP;
    state.traffic.splice(0, drop);
    state.trafficSaved = Math.max(0, state.trafficSaved - drop);
  }
  for (const d of devices) pushLog(d, { t: e.t, kind: e.dir, bytes: e.bytes, poll: true });
}

/** @param {any} port */
function onPortDisconnect(port) {
  const record = state.ports.get(port);
  if (!record) return;
  record.session.isOpen = false;
  record.session.emit("disconnect", null);
  toast(`${record.session.label} was unplugged. Its devices are offline; plug it back in to re-identify and resume.`, "warn", 8000);
  queueRender();
}

/** When a port returns, re-identify each device before polling resumes. @param {any} port */
async function onPortConnect(port) {
  const record = state.ports.get(port);
  if (!record) return;
  const devices = [...state.devices.values()].filter((d) => d.session === record.session);
  if (!devices.length) return;
  try {
    await record.session.open(devices[0].lineSettings);
    for (const d of devices) await verifyIdentity(d);
  } catch (error) {
    toast(`Could not reopen ${record.session.label}: ${/** @type {Error} */ (error).message}`, "bad");
  }
}

// ---------------------------------------------------------------------------------------------
// Devices

/**
 * @param {any} spec
 * @param {{ address: number, rsMode: "RS232" | "RS485", fullScaleMbar?: number }} options
 */
async function makeCodec(spec, options) {
  if (spec.model === "TC600") return createTc600Codec({ address: options.address || 1 });
  return registry.makeCodec(spec, options);
}

/** @param {any} config from the Add Gauge dialog */
async function addRealDevice(config) {
  const spec = registry.get(config.model);
  const ports = await grantedPorts();
  const p = ports.find((x) => x.key === config.portKey);
  if (!p) throw new Error("That port is no longer granted.");
  const session = sessionFor(p);
  const line = { ...Registry.lineSettings(spec), baudRate: Number(config.baudRate) };
  if (session.isOpen) {
    if (session.settings.baudRate !== line.baudRate) throw new Error(`${p.label} is already open at ${session.settings.baudRate} baud for other devices on this bus.`);
  } else {
    await session.open(line);
  }
  const codec = await makeCodec(spec, { address: Number(config.address), rsMode: config.rsMode, fullScaleMbar: config.fullScale?.mbar });
  const device = createDevice({
    spec,
    codec,
    session,
    portLabel: p.label,
    portInfo: p.info,
    line: { ...line, rsMode: config.rsMode },
    address: Number(config.address),
    fullScale: config.fullScale ? { value: config.fullScale.value, unit: config.fullScale.unit, mbar: config.fullScale.mbar, origin: config.fullScale.origin } : null,
    identity: config.identity,
    poll: { commands: config.commands, intervalMs: config.intervalMs },
    simulated: false
  });
  attach(device);
  toast(`${device.label} added.`);
  return device;
}

function simulation() {
  if (!state.simulation) {
    state.simulation = createSimulation({ scenario: "pumpdown_realistic", seed: Date.now() % 100000 });
    state.simulation.start();
    state.simulation.onStep?.(() => panels.get("simulation")?.update());
  }
  return state.simulation;
}

/** @param {{ model: string, fullScale: any, id?: string, label?: string, poll?: any, color?: string }} config */
async function addSimulatedDevice(config) {
  const spec = registry.get(config.model);
  const sim = simulation();
  const gauge = sim.gauge({ type: spec.model, fullScaleMbar: config.fullScale?.mbar });
  const emulator = emulatorFor(spec, gauge, config.fullScale?.mbar);
  const port = new EmulatedPort({ emulators: [emulator], label: `Simulated ${spec.model}` });
  const line = { ...Registry.lineSettings(spec), baudRate: emulator.baudRate };
  port.on("traffic", (/** @type {any} */ e) => onTraffic(port, e));
  await port.open(line);
  const codec = await makeCodec(spec, { address: emulator.address ?? spec.transport.default_address ?? 0, rsMode: "RS232", fullScaleMbar: config.fullScale?.mbar });
  const device = createDevice({
    id: config.id,
    label: config.label,
    color: config.color,
    spec,
    codec,
    session: port,
    portLabel: port.label,
    portInfo: {},
    line: { ...line, rsMode: "RS232" },
    address: emulator.address ?? 0,
    fullScale: config.fullScale ? { value: config.fullScale.value, unit: config.fullScale.unit, mbar: config.fullScale.mbar, origin: config.fullScale.origin ?? "user" } : null,
    identity: { serial: "SIM", firmware: "" },
    poll: config.poll ?? { commands: defaultCommands(spec), intervalMs: spec.protocol === "cdg_serial" ? 100 : 500 },
    simulated: true
  });
  device.simGauge = gauge;
  state.ports.set(port, { key: port.id, session: port, scheduler: null });
  attach(device);
  return device;
}

/** @param {any} spec @param {any} gauge @param {number | undefined} fullScaleMbar */
function emulatorFor(spec, gauge, fullScaleMbar) {
  const pressure = () => gauge.pressure();
  const model = spec.model;
  if (spec.protocol === "cdg_serial") {
    // The simulated gauge clamps at its range; a real head saturates past 1.024 × FS and flags it.
    const fs = fullScaleMbar ?? 13.332;
    const cdgPressure = () => (gauge.status() === "OR" ? fs * 1.1 : gauge.status() === "UR" ? -fs * 0.03 : gauge.pressure());
    return createCdgEmulator({ model, fullScaleMbar: fs, pressure: cdgPressure, streamIntervalMs: 50 });
  }
  if (model === "PCG550" || model === "PSG550") return createPxgEmulator({ model, pressure, baudRate: spec.transport.default_baud });
  if (model.startsWith("PPG")) return createPpgEmulator({ model, pressure, status: () => gauge.status() });
  if (model === "OPG550") return createP3V02Emulator({ product: "OPG550", pressure });
  if (model === "TC600") return createPfeifferAsciiEmulator({ model: "TC600", params: { 349: "TC 600" } });
  if (model === "BCG450") return createPfeifferAsciiEmulator({ model: "BCG450", pressure });
  throw new Error(`No emulator for ${model}. Simulated models: ${SIMULATABLE.join(", ")}`);
}

/** @param {any} o */
function createDevice(o) {
  const index = deviceCounter++;
  const sameModel = [...state.devices.values()].filter((d) => d.model === o.spec.model).length;
  const turbo = o.spec.model === "TC600";
  const primary = turbo ? "actual_speed_hz" : o.poll.commands.includes("pressure") || o.codec.supportsContinuousOutput() ? "pressure" : o.poll.commands[0];
  return {
    id: o.id ?? `dev-${Date.now().toString(36)}-${index}`,
    label: o.label ?? `${o.spec.model}${sameModel ? ` #${sameModel + 1}` : ""}${o.simulated ? " (sim)" : ""}`,
    model: o.spec.model,
    spec: o.spec,
    family: o.spec.protocol,
    experimental: Boolean(o.spec.experimental),
    codec: o.codec,
    session: o.session,
    portLabel: o.portLabel,
    portInfo: o.portInfo,
    line: o.line,
    lineSettings: { baudRate: o.line.baudRate, dataBits: o.line.dataBits, stopBits: o.line.stopBits, parity: o.line.parity },
    address: o.address,
    fullScale: o.fullScale,
    identity: { serial: "", firmware: "", ...(o.identity ?? {}) },
    poll: { commands: o.poll.commands.slice(), intervalMs: Number(o.poll.intervalMs) || 100 },
    color: o.color ?? SERIES_COLORS[index % SERIES_COLORS.length],
    simulated: o.simulated,
    turbo,
    binary: ["cdg_serial", "inficon_binary", "pfeiffer_binary", "inficon_p3_v02"].includes(o.spec.protocol),
    streaming: o.codec.supportsContinuousOutput(),
    primaryCommand: primary,
    /** @type {Map<string, Series>} */
    series: new Map(),
    /** @type {Map<string, any>} */
    secondary: new Map(),
    last: null,
    statusWord: "",
    lastError: null,
    status: { state: "starting", message: "" },
    /** @type {any[]} */
    log: [],
    /** @type {any[]} terminal composer history, newest first */
    history: [],
    cycleMs: 0,
    showPollTraffic: false
  };
}

/** Put a device on its port's scheduler and wire its events. @param {any} d */
function attach(d) {
  const record = [...state.ports.values()].find((r) => r.session === d.session);
  if (!record) throw new Error("Port record missing");
  if (!record.scheduler) {
    const scheduler = new PortScheduler(d.session);
    record.scheduler = scheduler;
    scheduler.on("reading", (/** @type {any} */ r) => onReading(r));
    scheduler.on("info", (/** @type {any} */ r) => onInfo(r));
    scheduler.on("error", (/** @type {any} */ e) => onError(e));
    scheduler.on("status", (/** @type {any} */ s) => onStatus(s));
    scheduler.on("terminal", (/** @type {any} */ t) => onTerminal(t));
    scheduler.on("gap", (/** @type {any} */ g) => onGap(g));
    scheduler.on("stats", (/** @type {any} */ s) => {
      const dev = state.devices.get(s.deviceId);
      if (dev) dev.cycleMs = s.cycleMs;
    });
    scheduler.start();
  }
  d.scheduler = record.scheduler;
  d.scheduler.addDevice({ id: d.id, label: d.label, codec: d.codec, commands: d.poll.commands, intervalMs: d.poll.intervalMs });
  state.devices.set(d.id, d);
  state.dirty = true;
  if (state.selectedTab === "welcome") state.selectedTab = d.id;
  render();
}

/** @param {any} d @param {any} entry */
function pushLog(d, entry) {
  d.log.push(entry);
  if (d.log.length > LOG_CAP) d.log.splice(0, d.log.length - LOG_CAP);
  panels.get(d.id)?.appendLog?.();
}

/** @param {any} d @param {string} command @param {string} unit */
function seriesFor(d, command, unit) {
  let s = d.series.get(command);
  if (!s) {
    s = new Series(`${d.id}:${command}`, { unit });
    d.series.set(command, s);
    state.dirty = true;
    queueRender(true);
  }
  return s;
}

/** @param {any} r */
function onReading(r) {
  const d = state.devices.get(r.deviceId);
  if (!d) return;
  const t = Date.now();
  seriesFor(d, r.command, r.unit).push(t, r.value, statusFromWarnings(r.warnings));
  const entry = { value: r.value, unit: r.unit, formatted: r.formatted, warnings: r.warnings, extra: r.extra, t };
  d.secondary.set(r.command, entry);
  if (r.command === d.primaryCommand) {
    d.last = entry;
    d.statusWord = "";
  }
  queueRender();
}

/** @param {any} r */
function onInfo(r) {
  const d = state.devices.get(r.deviceId);
  if (!d) return;
  if (r.status) {
    if (r.command === d.primaryCommand) d.statusWord = r.status;
  } else {
    d.secondary.set(r.command, { formatted: r.formatted, value: r.extra?.flags, t: Date.now() });
    if (/serial/.test(r.command)) d.identity.serial = r.formatted;
    if (/firmware|software_version/.test(r.command)) d.identity.firmware = r.formatted;
  }
  queueRender();
}

/** @param {any} e */
function onError(e) {
  const d = state.devices.get(e.deviceId);
  if (!d) return;
  d.lastError = { ...e, t: Date.now() };
  pushLog(d, { t: Date.now(), kind: e.recoverable ? "note" : "err", text: e.message });
  if (!e.recoverable) toast(`${d.label}: ${e.message}`, "bad", 9000);
  queueRender();
}

/** @param {any} s */
function onStatus(s) {
  const d = state.devices.get(s.deviceId);
  if (!d) return;
  d.status = { state: s.state, message: s.message };
  queueRender(true);
}

/** @param {any} t */
function onTerminal(t) {
  const d = state.devices.get(t.deviceId);
  if (!d) return;
  const now = Date.now();
  pushLog(d, { t: now, kind: "tx", bytes: t.request, text: "", parsed: t.command ? `(${t.command})` : "" });
  if (t.response?.length) pushLog(d, { t: now, kind: "rx", bytes: t.response, parsed: t.formatted ?? "", error: t.error });
  else pushLog(d, { t: now, kind: "err", text: t.error ?? "No response" });
}

/** @param {any} g */
function onGap(g) {
  const d = state.devices.get(g.deviceId);
  if (!d) return;
  state.gaps.push({ device: d.label, from: new Date(g.fromMs).toISOString(), to: new Date(g.toMs).toISOString() });
  for (const s of d.series.values()) s.push(g.fromMs, NaN, SAMPLE_STATUS.GAP);
  pushLog(d, { t: Date.now(), kind: "note", text: `Gap in polling: ${((g.toMs - g.fromMs) / 1000).toFixed(1)} s (hidden tab timers are throttled). Recorded in the export.` });
}

/** @param {any} d */
async function removeDevice(d) {
  if (!confirm(`Remove ${d.label}? Its readings stay in exports made before removal only.`)) return;
  const record = [...state.ports.values()].find((r) => r.session === d.session);
  d.scheduler.removeDevice(d.id);
  d.simGauge?.remove?.();
  state.devices.delete(d.id);
  if (record && record.scheduler && record.scheduler.devices.size === 0) {
    await record.scheduler.stop();
    record.scheduler.dispose();
    record.scheduler = null;
    await d.session.close();
    if (d.simulated) state.ports.delete(d.session);
  }
  panels.get(d.id)?.destroy();
  panels.delete(d.id);
  if (state.selectedTab === d.id) state.selectedTab = state.devices.size ? [...state.devices.keys()][0] : "welcome";
  state.dirty = true;
  render();
}

/** @param {any} d @param {string} name */
function renameDevice(d, name) {
  d.label = name;
  state.dirty = true;
  panels.get(d.id)?.renderHeader();
  render();
}

/** @param {any} d @param {boolean} enabled */
function setPolling(d, enabled) {
  d.scheduler.setPolling(d.id, enabled);
  queueRender();
}

/** @param {any} d @param {string[]} commands */
function setCommands(d, commands) {
  d.scheduler.setCommands(d.id, commands);
  d.poll.commands = d.scheduler.devices.get(d.id).commands.slice();
  if (!d.poll.commands.includes(d.primaryCommand) && d.poll.commands.length && !d.streaming && !d.turbo) d.primaryCommand = d.poll.commands[0];
  state.dirty = true;
}

/** @param {any} d @param {number} ms */
function setIntervalMs(d, ms) {
  d.scheduler.setInterval(d.id, ms);
  d.poll.intervalMs = d.scheduler.devices.get(d.id).intervalMs;
  state.dirty = true;
}

/** @param {any} d */
function changeFullScale(d) {
  const c = { fullScale: d.fullScale ? { ...d.fullScale } : null, fullScaleConfirmed: false };
  const body = h("div");
  const render2 = () => replace(body, fullScalePicker(c, render2));
  render2();
  openDialog("confirmDialog", {
    title: `Full scale for ${d.label}`,
    body: [body, h("p.hint", null, "Samples already recorded keep the full scale they were logged with; the export header records the change.")],
    actions: [
      h("button.button", { type: "button", onclick: () => closeDialog("confirmDialog") }, "Cancel"),
      h("button.button.primary", { type: "button", onclick: () => {
        if (!c.fullScale || !c.fullScaleConfirmed) return toast("Choose and confirm a full scale.", "warn");
        d.fullScale = { ...c.fullScale, origin: "user" };
        d.codec.setFullScale(c.fullScale.mbar);
        pushLog(d, { t: Date.now(), kind: "note", text: `Full scale changed to ${c.fullScale.value} ${c.fullScale.unit} (${c.fullScale.mbar} mbar).` });
        state.dirty = true;
        closeDialog("confirmDialog");
        panels.get(d.id)?.renderPoll();
        queueRender();
      } }, "Apply")
    ]
  });
}

/** @param {any} d @param {string} command @param {any} value  undefined for a read */
async function sendCommand(d, command, value) {
  const info = (d.codec.commands?.() ?? []).find((/** @type {any} */ c) => c.name === command);
  const isWrite = value !== undefined;
  if (command === "baud_rate" && isWrite && value !== "") return guidedBaudChange(d, Number(value));
  const bytes = d.codec.buildRequest(command, value);
  const risk = isWrite ? info?.risk ?? "caution" : "safe";
  const notes = [d.spec.notes?.[command], d.spec.notes?._all].filter(Boolean);
  const ok = await confirmSend({ risk, device: d.label, command, description: info?.description, value, bytes, notes, source: info?.source ?? d.spec.source });
  if (!ok) return null;
  if (isWrite) state.writes.push({ t: new Date().toISOString(), device: d.label, command, value, bytes: toHex(bytes), confirmed: risk !== "safe" });
  const entry = await d.scheduler.terminal(d.id, bytes, { command, isWrite });
  if (isWrite) state.writes[state.writes.length - 1].response = entry.error ?? entry.formatted ?? toHex(entry.response);
  if (entry.error) toast(`${command}: ${entry.error}`, "warn");
  else if (entry.formatted) toast(`${command}: ${entry.formatted}`);
  rememberReply(d, command, entry, isWrite);
  state.dirty = true;
  queueRender();
  return entry;
}

/**
 * A safe read with no toast, for panels that read several commands at once (identity, the
 * setpoint editor). Resolves with the terminal entry, including the parsed reply.
 * @param {any} d @param {string} command
 */
async function query(d, command) {
  const info = (d.codec.commands?.() ?? []).find((/** @type {any} */ c) => c.name === command);
  if (!info?.read) throw new Error(`${command} cannot be read.`);
  const entry = await d.scheduler.terminal(d.id, d.codec.buildRequest(command), { command });
  rememberReply(d, command, entry, false);
  queueRender();
  return entry;
}

/**
 * Keep the last reply to every read, so the gauge panel shows it next to the command, and
 * pick up identity fields as they arrive.
 * @param {any} d @param {string} command @param {any} entry @param {boolean} isWrite
 */
function rememberReply(d, command, entry, isWrite) {
  if (isWrite || entry.error || !command) return;
  const parsed = entry.parsed;
  d.secondary.set(command, { value: parsed?.value, unit: parsed?.unit, formatted: entry.formatted ?? parsed?.formatted, extra: parsed?.extra, t: Date.now() });
  if (/serial/.test(command) && entry.formatted) d.identity.serial = entry.formatted;
  if (/firmware|software_version/.test(command) && entry.formatted) d.identity.firmware = entry.formatted;
}

/**
 * Writes that belong together (the setpoint editor's Apply): one danger confirmation listing
 * every frame, then the writes one at a time in order. Resolves with one entry per item, or
 * null when the user cancels.
 * @param {any} d
 * @param {{ command: string, value: any, label?: string, display?: string }[]} items
 * @param {{ title: string, description?: string, notes?: string[] }} meta
 */
async function writeBatch(d, items, meta) {
  const built = items.map((item) => ({ ...item, bytes: d.codec.buildRequest(item.command, item.value) }));
  const notes = [...(meta.notes ?? []), ...new Set(items.map((i) => d.spec.notes?.[i.command]).filter(Boolean)), d.spec.notes?._all].filter(Boolean);
  const ok = await confirmBatch({
    title: meta.title,
    device: d.label,
    description: meta.description,
    items: built.map((b) => ({ command: b.command, label: b.label, value: b.display ?? b.value, bytes: b.bytes })),
    notes,
    source: d.spec.source
  });
  if (!ok) return null;
  const entries = [];
  for (const b of built) {
    const record = { t: new Date().toISOString(), device: d.label, command: b.command, value: b.value, bytes: toHex(b.bytes), confirmed: true, response: "" };
    state.writes.push(record);
    const entry = await d.scheduler.terminal(d.id, b.bytes, { command: b.command, isWrite: true });
    record.response = entry.error ?? entry.formatted ?? toHex(entry.response);
    entries.push({ ...b, entry });
  }
  state.dirty = true;
  queueRender();
  return entries;
}

/** @param {any} d */
function setpointLayout(d) {
  return d?.turbo ? null : detectSetpoints(d?.codec.commands?.() ?? []);
}

/** @param {any} d */
function openSetpoints(d) {
  if (!d) return toast("Add a device first.", "warn");
  if (!setpointLayout(d)) return toast(`${d.model} has no setpoint commands this tool knows.`, "warn");
  openSetpointEditor(app, d);
}

/** @param {any} d @param {Uint8Array} bytes */
async function sendRaw(d, bytes) {
  const check = d.codec.validateFrame?.(bytes);
  const notes = check && !check.ok ? [`This frame does not validate: ${check.detail}. The gauge will most likely ignore it.`] : [];
  const ok = await confirmSend({ risk: "caution", device: d.label, command: "raw frame", description: "A raw frame is not checked against the command table, so it could be a write.", bytes, notes });
  if (!ok) return null;
  state.writes.push({ t: new Date().toISOString(), device: d.label, command: "raw", bytes: toHex(bytes), confirmed: true });
  return d.scheduler.terminal(d.id, bytes, { isWrite: true });
}

/**
 * Baud-rate writes (PxG55x PID 227): warn, write, close, reopen at the new rate, verify
 * identity, and if verification fails reopen at the old rate and say which state the gauge is
 * most likely in (WEB_PORT_PLAN.md section 11).
 * @param {any} d @param {number} baud
 */
async function guidedBaudChange(d, baud) {
  if (![9600, 19200, 38400, 57600].includes(baud)) return toast("Choose 9600, 19200, 38400 or 57600.", "warn");
  const others = [...state.devices.values()].filter((x) => x.session === d.session && x !== d);
  if (others.length) return toast("Other devices share this bus; change the baud on each gauge only when it is alone on the port.", "warn", 8000);
  const bytes = d.codec.buildRequest("baud_rate", baud);
  const ok = await confirmSend({
    risk: "danger", device: d.label, command: "baud_rate", value: baud, bytes, source: d.spec.source,
    description: `The gauge will switch to ${baud} baud. The tool then closes the port, reopens it at ${baud}, and reads the product name to verify.`,
    notes: [d.spec.notes?.baud_rate, "🟠 The PID 227 value encoding is not yet confirmed against the manufacturer's protocol document (V1)."].filter(Boolean)
  });
  if (!ok) return;
  const old = d.lineSettings.baudRate;
  state.writes.push({ t: new Date().toISOString(), device: d.label, command: "baud_rate", value: baud, bytes: toHex(bytes), confirmed: true });
  d.scheduler.setPolling(d.id, false);
  await d.scheduler.terminal(d.id, bytes, { command: "baud_rate", isWrite: true });
  const verify = async (/** @type {number} */ rate) => {
    await d.session.reopen({ ...d.lineSettings, baudRate: rate });
    const entry = await d.scheduler.terminal(d.id, d.codec.buildRequest("product_name"), { command: "product_name" });
    return !entry.error;
  };
  if (await verify(baud)) {
    d.lineSettings.baudRate = baud;
    d.line.baudRate = baud;
    toast(`${d.label} now runs at ${baud} baud.`);
  } else if (await verify(old)) {
    toast(`${d.label} did not answer at ${baud}; it still answers at ${old} baud, so the write most likely did not take effect.`, "warn", 10000);
  } else {
    toast(`${d.label} answers at neither ${baud} nor ${old} baud. Run a thorough scan to find its rate.`, "bad", 12000);
  }
  d.scheduler.setPolling(d.id, true);
  state.dirty = true;
  queueRender(true);
}

/** Re-identify a device (restore or replug) before polling resumes: model plus serial number. @param {any} d */
async function verifyIdentity(d) {
  const command = ["serial_number", "product_name", "cdg_type", "software_version", "firmware"].find((c) => (d.codec.commands?.() ?? []).some((/** @type {any} */ x) => x.name === c && x.read));
  if (!command) {
    d.scheduler.setPolling(d.id, true);
    return true;
  }
  const entry = await d.scheduler.terminal(d.id, d.codec.buildRequest(command), { command });
  if (entry.error) {
    pushLog(d, { t: Date.now(), kind: "err", text: `Identity check failed (${command}): ${entry.error}. Polling stays paused.` });
    d.scheduler.setPolling(d.id, false);
    return false;
  }
  if (command === "serial_number" && d.identity.serial && entry.formatted && entry.formatted !== d.identity.serial) {
    pushLog(d, { t: Date.now(), kind: "err", text: `Serial number ${entry.formatted} does not match the session's ${d.identity.serial}. Polling stays paused.` });
    toast(`${d.label}: a different gauge answered on this port (serial ${entry.formatted}). Polling stays paused.`, "bad", 10000);
    d.scheduler.setPolling(d.id, false);
    return false;
  }
  pushLog(d, { t: Date.now(), kind: "note", text: `Identity verified (${command}: ${entry.formatted}). Polling resumed.` });
  d.scheduler.setPolling(d.id, true);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Rendering

/** @param {boolean} [structural] */
function queueRender(structural = false) {
  if (structural) state.structural = true;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (state.structural) {
      state.structural = false;
      render();
    } else {
      panels.get(state.selectedTab)?.update();
      renderDeviceList();
    }
  });
}

function render() {
  renderDeviceList();
  renderTabs();
  renderPanel();
  renderBanner();
}

function renderBanner() {
  const region = $("#bannerRegion");
  const banners = [];
  if (document.hidden && state.devices.size) banners.push(h("div.banner", null, "This tab is hidden: browsers throttle timers in background tabs. Polling continues, but gaps may appear; every gap is recorded in the export."));
  const experimental = [...state.devices.values()].filter((d) => d.experimental);
  if (experimental.length) banners.push(h("div.banner", null, `Experimental model(s) in use: ${experimental.map((d) => d.model).join(", ")}. Treat readings as unverified until the model passes bench acceptance.`));
  replace(region, ...banners);
}

function renderDeviceList() {
  const list = $("#deviceList");
  if (!state.devices.size) {
    replace(list, h("p.empty", null, "No devices yet. Add a gauge, or try the demo."));
    return;
  }
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const d of state.devices.values()) {
    const key = `${d.portLabel} · ${d.line.rsMode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(d);
  }
  replace(list, ...[...groups.entries()].map(([port, devices]) => h("div.port-group", null,
    h("div.port-group-title", null, port),
    ...devices.map((d) => h("button.device-item", { type: "button", "aria-selected": String(state.selectedTab === d.id), onclick: () => selectTab(d.id) },
      h("span.swatch", { style: { background: d.color } }),
      h("span", null, h("div.name", null, d.label), h("div.sub", null, d.last ? d.last.formatted ?? "" : d.status.state)),
      h("span.chip.plain", { style: { fontSize: "11px" } }, d.status.state))))));
}

function renderTabs() {
  const tabs = [];
  for (const d of state.devices.values()) tabs.push({ id: d.id, label: d.label, color: d.color });
  if (state.devices.size) tabs.push({ id: "combined", label: "Combined" });
  if (state.simulation) tabs.push({ id: "simulation", label: "Simulation" });
  if (!tabs.some((t) => t.id === state.selectedTab)) state.selectedTab = tabs[0]?.id ?? "welcome";
  replace($("#tabs"), ...tabs.map((t) => h("button.tab", { type: "button", role: "tab", "aria-selected": String(t.id === state.selectedTab), onclick: () => selectTab(t.id) },
    t.color ? h("span.swatch", { style: { background: t.color } }) : null, t.label)));
}

/** @param {string} id */
function selectTab(id) {
  state.selectedTab = id;
  render();
}

function renderPanel() {
  const host = $("#panels");
  const id = state.selectedTab;
  let panel = panels.get(id);
  if (id === "combined") {
    panel?.destroy();
    panel = new CombinedTab(app);
    panels.set(id, panel);
  } else if (id === "simulation" && !panel) {
    panel = new SimulationTab(app);
    panels.set(id, panel);
  } else if (state.devices.has(id) && !panel) {
    panel = new DeviceTab(app, state.devices.get(id));
    panels.set(id, panel);
  }
  if (!panel) {
    replace(host, welcome());
    return;
  }
  if (host.firstElementChild !== panel.el) replace(host, panel.el);
  panel.update();
  if (panel.appendLog) panel.appendLog();
}

function welcome() {
  return h("div.panel", null, h("div.welcome", null,
    h("div.welcome-hero", null,
      h("h1", null, "Talk to your vacuum gauges from the browser"),
      h("p", null, "Add a SKY CDG, PSG55x, PCG55x or PPG550/570 over RS232 or RS485. Watch live values and trends, send commands from a guided terminal, tune setpoints visually, and export everything. There is no installer, and no data leaves this computer.")),
    h("div.cards", null,
      h("div.card", null, h("span.num", null, "01"), h("h3", null, "Add a gauge"), h("p.hint", null, "Grant a USB serial adapter, scan it with read-only probes, then confirm the model and, for a CDG, the full scale."), h("button.button.primary", { type: "button", onclick: () => $("#addGaugeButton").click() }, "Add gauge")),
      h("div.card", null, h("span.num", null, "02"), h("h3", null, "Try the demo"), h("p.hint", null, "A simulated CDG045D, PCG550 and PSG550 in a pump-down, running the real codecs and scheduler. Open the CDG's setpoint editor to see the hysteresis view."), h("button.button", { type: "button", onclick: startDemo }, "Try demo")),
      h("div.card", null, h("span.num", null, "03"), h("h3", null, "Restore a session"), h("p.hint", null, "Sessions autosave to this browser and can be exported as JSON."), h("button.button", { type: "button", onclick: openSessions }, "Sessions")))));
}

// ---------------------------------------------------------------------------------------------
// Demo, turbo, dictionary, help

async function startDemo() {
  if ([...state.devices.values()].some((d) => d.simulated)) {
    selectTab("combined");
    return;
  }
  const sim = simulation();
  sim.setInputs({ scenario: "pumpdown_realistic" });
  if (!state.devices.size) state.sessionName = "Demo — simulated pump-down";
  /** @type {HTMLInputElement} */ ($("#sessionName")).value = state.sessionName;
  await addSimulatedDevice({ model: "CDG045D", fullScale: { ...fullScaleFromMbar(13.332), origin: "user" } });
  await addSimulatedDevice({ model: "PCG550", fullScale: null });
  await addSimulatedDevice({ model: "PSG550", fullScale: null });
  selectTab("combined");
  toast("Demo running: three simulated gauges answering real frames.");
}

function openTurbo() {
  const turbo = [...state.devices.values()].find((d) => d.turbo);
  if (turbo) return selectTab(turbo.id);
  openDialog("confirmDialog", {
    title: "TC600 turbo workspace",
    body: [
      h("p", null, "Connect a Pfeiffer TC600 drive over RS485 (Pfeiffer ASCII protocol), or simulate one. Every actuating command is a danger command and needs an explicit, two-step confirmation."),
      h("div.callout.warn", null, "Starting or stopping a turbopump changes the vacuum system. Make sure the backing pump, venting and interlocks are in the state you expect.")
    ],
    actions: [
      h("button.button", { type: "button", onclick: () => closeDialog("confirmDialog") }, "Cancel"),
      h("button.button", { type: "button", onclick: async () => {
        closeDialog("confirmDialog");
        const d = await addSimulatedDevice({ model: "TC600", fullScale: null, poll: { commands: defaultCommands(registry.get("TC600")), intervalMs: 1000 } });
        selectTab(d.id);
      } }, "Simulate a TC600"),
      h("button.button.primary", { type: "button", onclick: () => {
        closeDialog("confirmDialog");
        openAddGauge(app);
      } }, "Connect a TC600")
    ]
  });
}

/** @param {any} d */
function openDictionary(d) {
  if (!d) return toast("Add a device first.", "warn");
  const commands = d.codec.commands?.() ?? [];
  const search = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "Search commands…", "aria-label": "Search commands", style: { width: "100%" } }));
  const tbody = h("tbody");
  const draw = () => {
    const q = search.value.toLowerCase();
    replace(tbody, ...commands.filter((/** @type {any} */ c) => !q || `${c.name} ${c.description} ${c.unit}`.toLowerCase().includes(q)).map((/** @type {any} */ c) => {
      const cmd = d.spec.commands?.[c.name] ?? {};
      const id = cmd.pid != null ? `PID ${cmd.pid}` : cmd.mnemonic ?? "";
      return h("tr", null,
        h("td", null, h("code", null, c.name), h("div.hint", null, id)),
        h("td", null, c.description, c.valueHint ? h("div.hint", null, c.valueHint) : null, c.experimental ? h("span.chip.warn", null, "experimental") : null),
        h("td", null, c.unit ?? ""),
        h("td", null, [c.read ? "read" : "", c.write ? "write" : ""].filter(Boolean).join(" / ")),
        h("td", null, h(`span.risk.${c.risk}`, null, c.risk)),
        h("td.hint", null, c.source ?? ""),
        h("td", null, c.read ? h("button.button.small", { type: "button", onclick: () => sendCommand(d, c.name, undefined) }, "Read") : null));
    }));
  };
  search.oninput = draw;
  draw();
  openDialog("dictionaryDialog", {
    title: `${d.label} — ${d.model}`,
    body: [search, h("div.scroll", { style: { maxHeight: "60vh" } }, h("table.data", null, h("thead", null, h("tr", null, h("th", null, "Command"), h("th", null, "Description"), h("th", null, "Unit"), h("th", null, "Access"), h("th", null, "Risk"), h("th", null, "Source"), h("th", null, ""))), tbody))]
  });
  setTimeout(() => search.focus(), 50);
}

function openHelp() {
  openDialog("helpDialog", {
    body: [
      h("h3", null, "Getting connected"),
      h("p", null, "Use desktop Chrome or Edge. Click Add gauge, grant your USB serial adapter in the browser's chooser (once per adapter), then Scan. The scan sends read requests only. For a CDG you must confirm the full scale: 10 Torr and 10 mbar heads differ by a factor of 1.333."),
      h("h3", null, "RS485"),
      h("p", null, "Mark the port as RS485, give every gauge on the bus its own address, and use an auto-direction USB-RS485 adapter. All gauges on one bus share one port, and the tool keeps exactly one transaction outstanding at a time. Echoing adapters are handled."),
      h("h3", null, "Safety"),
      h("p", null, "Every command carries a risk class. Safe reads send immediately; caution commands show the exact bytes; danger commands (adjustments, resets, setpoints, baud rate, turbo actuation) also explain what will happen and need a second click. Changing the display unit never writes to a gauge. Version 1 performs no automatic writes."),
      h("h3", null, "Data"),
      h("p", null, "Sessions autosave to this browser's IndexedDB. Export session JSON, a transcript, traffic CSV with exact bytes, and measurement CSV (per device or merged on the union of timestamps). Every export header records the app build, each device's model, address and full scale, and where the full scale came from."),
      h("h3", null, "Terminal"),
      h("p", null, "Quick buttons send any read with one click; the pencil buttons load a write into the composer. Pick a command, choose Read or Write, then pick a value from the list or type your own. The exact bytes are shown before anything is sent. Star a command and value to pin it as a quick button. In the raw field, the up and down arrows recall earlier frames."),
      h("h3", null, "Setpoints"),
      h("p", null, "For gauges with setpoint relays, the Setpoints button opens an editor. You can drag the switch-on and switch-off lines, drag the shaded band to move both, use the sliders or arrows, or type a pressure. The illustrative pump-down curve shows where each relay would switch and how it holds inside the hysteresis band. Apply sends every change after one confirmation, then reads the values back."),
      h("h3", null, "Keyboard"),
      h("p", null, h("code", null, "Ctrl K"), " opens the command dictionary for the current device. ", h("code", null, "Enter"), " in the terminal sends."),
      h("div.callout.warn", null, "Items marked 🟠 in the specs (for example the PxG55x CRC and Fixs32en20 decode) come from an OEM document used as a proxy, and still need a bench check against the manufacturer's protocol document.")
    ]
  });
}

// ---------------------------------------------------------------------------------------------
// Sessions and export

function deviceRecords() {
  return [...state.devices.values()].map((d) => ({
    id: d.id,
    label: d.label,
    model: d.model,
    family: d.family,
    experimental: d.experimental,
    simulated: d.simulated,
    port: { label: d.portLabel, usbVendorId: d.portInfo?.usbVendorId, usbProductId: d.portInfo?.usbProductId },
    line: { baudRate: d.line.baudRate, dataBits: d.line.dataBits, parity: d.line.parity, stopBits: d.line.stopBits, rsMode: d.line.rsMode },
    address: d.address,
    fullScale: d.fullScale,
    identity: d.identity,
    poll: d.poll,
    color: d.color
  }));
}

function sessionRecord() {
  return {
    id: state.sessionId,
    ...makeSession({ name: state.sessionName, created: state.created, devices: deviceRecords(), layout: state.layout, app: state.build }),
    writes: state.writes,
    gaps: state.gaps
  };
}

async function autosave() {
  if (!state.autosave || (!state.dirty && !state.devices.size)) return;
  const chunks = [];
  for (const d of state.devices.values()) {
    for (const s of d.series.values()) {
      const c = s.takeUnflushed();
      if (c.t.length) chunks.push({ seriesId: s.id, unit: s.unit, t: c.t, v: c.v, s: c.s });
    }
  }
  const traffic = state.traffic.slice(state.trafficSaved);
  state.trafficSaved = state.traffic.length;
  try {
    await saveSession(sessionRecord(), chunks, traffic);
    state.dirty = false;
  } catch (error) {
    console.warn("Autosave failed", error);
  }
}

async function openSessions() {
  const list = h("div");
  const draw = async () => {
    const sessions = await listSessions();
    replace(list, sessions.length
      ? h("table.data", null, h("tbody", null, sessions.map((s) => h("tr", null,
          h("td", null, h("strong", null, s.name), h("div.hint", null, `${new Date(s.saved).toLocaleString()} · ${(s.devices?.length ?? 0) + (s.simulated?.length ?? 0)} device(s)`)),
          h("td", null, h("button.button.small", { type: "button", onclick: () => restoreFromDb(s.id) }, "Restore")),
          h("td", null, h("button.button.small", { type: "button", onclick: async () => {
            if (!confirm(`Delete "${s.name}" and its samples from this browser?`)) return;
            await deleteSession(s.id);
            draw();
          } }, "Delete"))))))
      : h("p.empty", null, "No sessions saved in this browser yet."));
  };
  const input = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: ".json,application/json", hidden: true }));
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await restore(parseSession(await file.text()));
      closeDialog("sessionsDialog");
    } catch (error) {
      toast(`Import failed: ${/** @type {Error} */ (error).message}`, "bad", 8000);
    }
  };
  openDialog("sessionsDialog", {
    body: [list, h("p.hint", null, "Restoring a session re-creates simulated devices at once. Real devices are re-attached to a granted port with the same USB IDs, then re-identified (model plus serial number) before logging resumes.")],
    actions: [h("label.button", null, "Import session JSON", input), h("button.button", { type: "button", onclick: () => closeDialog("sessionsDialog") }, "Close")]
  });
  draw();
}

/** @param {string} id */
async function restoreFromDb(id) {
  const loaded = await loadSession(id);
  if (!loaded) return toast("Session not found.", "bad");
  const parsed = parseSession(loaded.record);
  await restore(parsed, loaded.samples, loaded.traffic, id);
  closeDialog("sessionsDialog");
}

/**
 * @param {ReturnType<typeof parseSession>} session
 * @param {any[]} [samples]
 * @param {any[]} [traffic]
 * @param {string} [id]
 */
async function restore(session, samples = [], traffic = [], id) {
  if (state.devices.size && !confirm("Replace the current session? Export it first if you need it.")) return;
  for (const d of [...state.devices.values()]) {
    const record = [...state.ports.values()].find((r) => r.session === d.session);
    d.scheduler.removeDevice(d.id);
    state.devices.delete(d.id);
    panels.get(d.id)?.destroy();
    panels.delete(d.id);
    if (record?.scheduler && record.scheduler.devices.size === 0) {
      await record.scheduler.stop();
      record.scheduler.dispose();
      record.scheduler = null;
      await d.session.close();
    }
  }
  state.sessionId = id ?? newId();
  state.sessionName = session.name;
  state.created = session.created;
  state.layout = session.layout;
  state.traffic = traffic.map((t) => ({ t: t.t, dir: t.dir, device: t.device, bytes: t.bytes instanceof Uint8Array ? t.bytes : Uint8Array.from(Object.values(t.bytes ?? {})), note: t.note }));
  state.trafficSaved = state.traffic.length;
  /** @type {HTMLInputElement} */ ($("#sessionName")).value = state.sessionName;
  const granted = await grantedPorts();
  const missing = [];
  for (const rec of session.devices) {
    try {
      let d;
      if (rec.simulated) {
        d = await addSimulatedDevice({ model: rec.model, fullScale: rec.fullScale, id: rec.id, label: rec.label, poll: rec.poll, color: rec.color });
      } else {
        const match = granted.find((p) => (rec.port?.usbVendorId == null || p.info.usbVendorId === rec.port.usbVendorId) && (rec.port?.usbProductId == null || p.info.usbProductId === rec.port.usbProductId) && !p.inUse)
          ?? granted.find((p) => p.label === rec.port?.label);
        if (!match) {
          missing.push(rec.label ?? rec.model);
          continue;
        }
        d = await addRealDevice({ model: rec.model, portKey: match.key, baudRate: rec.line.baudRate, rsMode: rec.line.rsMode, address: rec.address, fullScale: rec.fullScale, commands: rec.poll.commands, intervalMs: rec.poll.intervalMs, identity: rec.identity });
        d.id = d.id;
        d.label = rec.label ?? d.label;
        d.scheduler.setPolling(d.id, false);
        verifyIdentity(d);
      }
      for (const chunk of samples.filter((c) => c.seriesId?.startsWith(`${rec.id}:`))) {
        const command = chunk.seriesId.slice(rec.id.length + 1);
        const s = seriesFor(d, command, chunk.unit);
        s.load(chunk);
      }
    } catch (error) {
      toast(`${rec.model}: ${/** @type {Error} */ (error).message}`, "bad", 8000);
    }
  }
  if (missing.length) toast(`Grant the port for ${missing.join(", ")} and add it again; its history is kept in the saved session.`, "warn", 12000);
  state.dirty = true;
  render();
  toast(`Restored "${session.name}".`);
}

function exportContext() {
  const devices = [...state.devices.values()].map((d) => ({ label: d.label, model: d.model, simulated: d.simulated, address: d.address, fullScale: d.fullScale, identity: d.identity, line: d.line }));
  return { app: state.build, session: state.sessionName, devices, displayUnit: state.displayUnit };
}

function fileStem() {
  return `${state.sessionName.replace(/[^\w.-]+/g, "_").slice(0, 60)}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

function openExport() {
  const counts = [...state.devices.values()].reduce((n, d) => n + [...d.series.values()].reduce((m, s) => m + s.length, 0), 0);
  const option = (/** @type {string} */ title, /** @type {string} */ detail, /** @type {() => void} */ run) =>
    h("button.button", { type: "button", style: { justifyContent: "flex-start", textAlign: "left", width: "100%", display: "grid", minHeight: "54px" }, onclick: () => {
      run();
      closeDialog("exportDialog");
    } }, h("strong", null, title), h("span.hint", null, detail));
  openDialog("exportDialog", {
    body: [
      h("p.hint", null, `${state.devices.size} device(s), ${counts.toLocaleString()} samples, ${state.traffic.length.toLocaleString()} traffic events (the last ${TRAFFIC_CAP.toLocaleString()} are kept in memory).`),
      option("Measurement CSV (merged)", "All devices on the union of timestamps; empty cells where a device had no sample", () => {
        const series = [...state.devices.values()].flatMap((d) => [...d.series.entries()].map(([cmd, s]) => ({ label: cmd === d.primaryCommand ? d.label : `${d.label} ${cmd}`, series: s })));
        download(`${fileStem()}_measurements.csv`, measurementCsv({ series, displayUnit: state.displayUnit, header: csvHeader(exportContext()) }), "text/csv");
      }),
      option("Traffic CSV", "Direction, device, exact bytes in hex, printable text", () => download(`${fileStem()}_traffic.csv`, trafficCsv({ entries: state.traffic, header: csvHeader(exportContext()) }), "text/csv")),
      option("Transcript", "Readable, timestamped record of every exchange", () => download(`${fileStem()}_transcript.txt`, transcript({ entries: state.traffic, header: csvHeader(exportContext()) }))),
      option("Session JSON", "Devices, settings, layout, confirmed writes, recorded gaps — re-importable", () => download(`${fileStem()}_session.json`, JSON.stringify(sessionRecord(), null, 2), "application/json"))
    ]
  });
}

/** @param {any} d */
function exportDevice(d) {
  const series = [...d.series.entries()].map(([cmd, s]) => ({ label: cmd, series: s }));
  const ctx = exportContext();
  ctx.devices = ctx.devices.filter((x) => x.label === d.label);
  download(`${fileStem()}_${d.label.replace(/[^\w.-]+/g, "_")}.csv`, measurementCsv({ series, displayUnit: state.displayUnit, header: csvHeader(ctx) }), "text/csv");
}

function newId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

boot().catch((error) => {
  console.error(error);
  toast(`Start-up failed: ${error.message}`, "bad", 15000);
});
