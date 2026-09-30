// Browser smoke test (WEB_PORT_PLAN.md section 13): the built app loads, the demo session
// starts, simulated gauges poll through the real codecs and scheduler, the terminal sends a
// command, the combined tab draws, and an export produces a CSV. Headless Edge over the
// DevTools protocol, as in the VGC tool.
//
//   SMOKE_URL=http://127.0.0.1:4173/Vacuum-Control-Serial-Communicator/ npm run test:browser
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const candidates = [
  process.env.SMOKE_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const browserPath = candidates.find((p) => existsSync(p));
if (!browserPath) throw new Error("No Chromium browser found; set SMOKE_BROWSER.");
// Outside the repository so a dev server's file watcher never sees the profile.
const profile = path.resolve(process.env.SMOKE_PROFILE ?? path.join(os.tmpdir(), "gauge-communicator-smoke"));
const port = Number(process.env.SMOKE_DEBUG_PORT ?? 9333);
const pageUrl = process.env.SMOKE_URL ?? "http://127.0.0.1:4173/Vacuum-Control-Serial-Communicator/";
mkdirSync(profile, { recursive: true });

const browser = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-extensions", "--disable-sync", "--no-first-run",
  "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"
], { stdio: "ignore" });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await pause(250);
  }
  throw new Error("Timed out waiting for the headless browser.");
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  socket.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) events.push(m);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools WebSocket failed.")), { once: true });
  });
  return {
    ready,
    events,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    close: () => socket.close()
  };
}

const evaluate = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`Evaluation failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result?.value;
};

try {
  const page = await target();
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}demo=1` });

  let devices = 0;
  for (let i = 0; i < 80 && devices < 4; i += 1) {
    await pause(250);
    devices = await evaluate(cdp, `document.querySelectorAll("#deviceList .device-item").length`).catch(() => 0);
  }
  if (devices < 4) {
    const diag = await evaluate(cdp, `({ html: document.querySelector("#panels")?.innerText?.slice(0, 300), scripts: [...document.scripts].map(s => (s.type || "classic") + " " + (s.src || "inline")) })`);
    throw new Error(`Demo did not start: ${JSON.stringify(diag)}`);
  }
  await pause(4000);

  const result = await evaluate(cdp, `(async () => {
    const pauseIn = (ms) => new Promise((r) => setTimeout(r, ms));
    const items = [...document.querySelectorAll("#deviceList .device-item")];
    const values = [];
    for (const item of items) {
      item.click();
      await pauseIn(300);
      values.push({ name: item.querySelector(".name")?.textContent, value: document.querySelector(".value-main")?.textContent, chips: [...document.querySelectorAll(".value-card .chip")].map((c) => c.textContent) });
    }
    // Terminal: send a safe read (PCG550 product name) from the frame builder.
    items[1].click();
    await pauseIn(300);
    const composer = document.querySelector(".composer");
    const select = composer.querySelector('select[aria-label="Command"]');
    select.value = "product_name";
    select.dispatchEvent(new Event("change"));
    const preview = composer.querySelector(".byte-preview").textContent;
    composer.querySelector("button.button.primary").click();
    await pauseIn(800);
    const terminal = document.querySelector(".terminal").innerText;
    // Combined tab draws a canvas.
    [...document.querySelectorAll(".tab")].find((t) => t.textContent === "Combined").click();
    await pauseIn(700);
    const canvas = document.querySelector(".trend-canvas");
    const stats = document.querySelector(".trend-stats")?.innerText ?? "";
    // Spectrum Studio on the OPG550: the view switch, a drawn chart, the hover bar, and the
    // comparison sources in Advanced Analysis (no writes: plasma and algorithms stay off).
    items[3].click();
    await pauseIn(300);
    [...document.querySelectorAll(".view-switch button")].find((b) => b.textContent === "Spectrum Studio")?.click();
    await pauseIn(600);
    const studio = document.querySelector(".studio");
    const main = studio?.querySelector('select[aria-label="Main plot"]');
    if (main) {
      main.value = "Advanced Analysis";
      main.dispatchEvent(new Event("change"));
    }
    await pauseIn(700);
    const studioCanvas = [...(studio?.querySelectorAll(".xy-canvas") ?? [])].find((c) => c.offsetParent && c.width > 0);
    const compareOptions = studio?.querySelector('select[aria-label="Compare B"]')?.options.length ?? 0;
    const studioResult = { present: Boolean(studio), canvas: Boolean(studioCanvas), hoverBar: Boolean(studio?.querySelector(".studio-hoverbar .hb-x")), compareOptions, delta: studio?.querySelector(".studio-delta")?.textContent ?? "" };
    // Export: capture the CSV instead of downloading it.
    let captured = "";
    const original = URL.createObjectURL;
    URL.createObjectURL = (blob) => { blob.text().then((t) => (captured = t)); return original.call(URL, blob); };
    document.querySelector("#exportButton").click();
    await pauseIn(200);
    [...document.querySelectorAll("#exportDialog button")].find((b) => b.textContent.includes("Measurement CSV")).click();
    await pauseIn(500);
    URL.createObjectURL = original;
    // Units: switch to Torr (display only).
    const unit = document.querySelector("#unitSelect");
    unit.value = "Torr";
    unit.dispatchEvent(new Event("change"));
    items[0].click();
    await pauseIn(400);
    const torr = document.querySelector(".value-main")?.textContent;
    const reported = document.querySelector(".value-sub")?.textContent;
    return { studio: studioResult, values, preview, terminal: terminal.slice(-400), canvas: Boolean(canvas && canvas.width > 0), stats: stats.slice(0, 200), csvLines: captured.split("\\n").length, csvHead: captured.split("\\n").slice(0, 4).join(" | "), torr, reported, build: document.querySelector("#buildInfo").textContent };
  })()`);

  const errors = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !/favicon|manifest|DevTools/.test(e.params.entry.text)));
  const checks = {
    fourDevices: result.values.length === 4,
    studioDrawn: result.studio.present && result.studio.canvas && result.studio.hoverBar,
    studioSources: result.studio.compareOptions >= 4 && /Δ = /.test(result.studio.delta),
    everyGaugeHasAValue: result.values.every((v) => v.value && !v.value.startsWith("—")),
    cdgStreaming: result.values[0].chips.includes("Streaming"),
    pxgPolling: result.values[1].chips.includes("Polling"),
    frameBuilderPreview: /00 00 00 05 01 00 D0 00 00/.test(result.preview),
    terminalAnswered: /PCG550/.test(result.terminal),
    combinedCanvas: result.canvas,
    statsShown: /rate/.test(result.stats),
    csvExported: result.csvLines > 5 && /build/.test(result.csvHead),
    torrDisplay: /Torr/.test(result.torr ?? "") && /reported as/.test(result.reported ?? ""),
    noErrors: errors.length === 0
  };
  cdp.close();
  if (Object.values(checks).some((ok) => !ok)) {
    console.error(JSON.stringify({ checks, result, errors: errors.map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.entry?.text) }, null, 2));
    throw new Error("Browser smoke checks failed.");
  }
  console.log(`Browser smoke checks passed: ${JSON.stringify(checks)}`);
  console.log(JSON.stringify(result.values));
} finally {
  browser.kill();
}
