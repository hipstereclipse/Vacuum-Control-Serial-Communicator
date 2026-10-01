# Vacuum Control Serial Communicator

A browser-only console for INFICON vacuum gauges. It talks to them through the Web Serial API: no Python, no installer, and no data leaving the computer. It is the browser edition of the desktop [CustomSerialCommunicator](https://github.com/hipstereclipse/CustomSerialCommunicator) (CSC). It is built and published the same way as the [VGC Serial Communication Tool](https://github.com/hipstereclipse/VGC-Serial-Communication-Tool).

**Live:** https://hipstereclipse.github.io/Vacuum-Control-Serial-Communicator/ (desktop Chrome or Edge)

The design, the sources behind every protocol figure and the open verification items are in [WEB_PORT_PLAN.md](WEB_PORT_PLAN.md).

## What it does

- **Connect** gauges over RS232 or RS485 (through a USB adapter). All gauges on one RS485 bus share one port, and the tool keeps exactly one transaction outstanding at a time.
- **Scan** granted ports with read-only probes. The scan listens for a CDG left streaming, then tries PPG, Pfeiffer ASCII, CDG, PxG55x and P3 V02 in turn and stops at the first verified identity. It also offers an optional RS485 address sweep.
- **Map models automatically.** For a CDG the tool infers the full scale from the type word, but it will not log until you confirm the full scale, with Torr-native and mbar-native heads listed side by side.
- **Poll** one or more read commands per device on a chosen interval. CDGs stream continuously and every frame is decoded.
- **Device tabs** put everything about one gauge on one page:
  - a live value with status chips (CDG warnings, PPG status words, PxG55x device errors), session min/max/rate, and where the reading sits in the gauge's measuring range;
  - a gauge information panel (identity, full scale, line settings, source document) with a one-click identity read;
  - a readings table listing every read command with its last reply, a one-click read and a poll toggle;
  - a trend.
- **Terminal.** Quick buttons send any read in one click, and pencil buttons load a write into the composer. In the composer you pick a command, choose Read or Write, and then pick a value from a list worked out from the spec (options, ranges, the accepted words in the description) or type your own. Pressures can be entered in any unit. The exact bytes and the risk class show before sending. You can pin a command and value as a quick button, reuse recent commands, recall earlier raw frames with ↑/↓, filter or copy the log, and switch between ASCII and hex views. The raw frame builder computes checksums and CRCs and flags a bad frame before it is sent.
- **Setpoint editor** (SKY CDG and PPG550/570). Each switch-on and switch-off level can be dragged on the plot, moved together by dragging the shaded hysteresis band, set with a slider, nudged with ± buttons, the arrow keys or the mouse wheel, or typed as a pressure (or, on a CDG, as the raw byte). The hysteresis can be typed as a percentage or picked from presets. An illustrative vacuum cycle (pump-down into a valley, a gas burst, a vent) shows where each relay switches, with relay-state lanes underneath showing it hold inside the band. It also shows the live pressure. Apply writes only what changed, after one danger confirmation, and then verifies by reading back.
- **Spectrum Studio** (OPG550). The OPG550's tab has a Gauge / Spectrum Studio switch. The studio offers four main plots:
  - *Raw Spectrum:* the spectrum, with signature lines for tracked gases.
  - *Rate of Rise:* dP/dt, or the rate of each tracked gas.
  - *Residual Gas Detection:* tracked-gas partial pressures.
  - *Advanced Analysis:* any two pressure sources in the session, with the band between them and a gas partial pressure on the right axis.

  One hover bar keeps the x value at the far left and shows Δ(A−B) and Δ% at the cursor. Every history covers the whole session. Plasma on or off and starting SPEC, RoR or RGD are confirmed writes; after that the studio reads the latest record every 2 s. Ignition thresholds are shown in the display unit but stored and evaluated in mbar. Auto plasma can be off, prompt you when the pressure crosses a threshold, or switch the plasma automatically as the desktop tool does. Automatic mode has to be armed through a danger confirmation, shows a red banner while armed, logs every automatic write, and is not restored after a reload. Exports: CSC's RGD and RoR CSV layout, plus one CSV per chart.
- **Layout:** the device list and the Add gauge / Simulate buttons stay fixed on the left; only the workspace on the right scrolls. Scan results and the Simulate dialog's model list support multi-select: click, Ctrl-click, Shift-click, drag, or the checkboxes.
- **Combined view** in overlay, stacked or grid layout, with visibility toggles, per-device colours and synchronised navigation.
- **Sessions** autosave to this browser's IndexedDB, and can be exported and imported as JSON.
- **Exports:** measurement CSV (per device, or merged on the union of timestamps), traffic CSV with exact bytes, a readable transcript, and session JSON. Every export header records the build, each device's model, address and full scale, and where the full scale came from.
- **Simulation and demo.** Simulated gauges answer real frames through protocol emulators, so the codecs, scheduler, scanner and UI run unchanged without hardware. Inputs are scenario, gas type, humidity, leak rate and base pressure.
- **TC600 turbo workspace.** Every actuating command is gated as a danger command.
- **Safety.** Every command has a risk class:
  - *safe:* sends immediately.
  - *caution:* shows the exact bytes first.
  - *danger:* explains what will happen, lists the preconditions and the source document, and needs a second click.

  Changing the display unit never writes to a gauge. The only automatic writes come from an OPG550's automatic plasma switching, and only after you arm it.

## Device support

| Family | Models | Status |
|---|---|---|
| SKY CDG, RS232C binary | CDG025D, CDG045D, CDG100D, CDG160D, CDG200D | First-class. Protocol from TIRA49E1 |
| PxG55x binary, RS232C and RS485C | PSG550, PCG550 | Implemented from the OEM protocol description (🟠 needs a bench check, see below) |
| PPG ASCII | PPG550, PPG570 | Ported one-to-one from CSC |
| Pfeiffer ASCII | BCG450, TC600 | Ported one-to-one from CSC |
| INFICON P3 V02 | OPG550 | Codec, identification and Spectrum Studio ported from CSC (🟠 record layouts and plasma limits need a bench check, V13 and V20) |
| Others CSC routes | BCG552, BPG, MAG, MPG, HPG400, PEG100, PSG500 | Experimental, as in CSC |

Out of scope: fieldbus variants (EtherCAT, Profibus, DeviceNet, Profinet), analog readout, Firefox and Safari (neither has Web Serial), and the VGC controllers, which the VGC tool covers.

### Corrections relative to CSC (to back-port)

- **PxG55x CRC:** the CRC is CRC-16 with reflected polynomial `0x8408`, initial value `0xFFFF`, sent low byte first. It validates all four example frames in the protocol description; CSC's MSB-first `0x1021` CRC validates none of them.
- **PxG55x pressure decode:** `Fixs32en20` is linear (raw ÷ 2²⁰). CSC evaluates 10^(raw ÷ 2²⁰), which overflows.
- **PxG55x frames:**
  - Requests carry device ID `0x00` and, in RS485 mode, the device address.
  - Responses are checked for Cmd and Ack, and error frames (PID `0xFFFF`) decode to readable errors.
  - PID 222 is a Real32 pressure, not a temperature.
- **PxG55x resolution:** `Fixs32en20` resolves 9.5×10⁻⁷ mbar, so PID 221 is coarse below about 10⁻⁴ mbar. Poll PID 222 (Real32) there.
- **CDG model inference:** a Torr-native full-scale word of 1000 (`0x03E8`) or 500 (`0x01F4`) was being read as the CDG160D or CDG045D model code.
- **CDG100D/160D/200D YAML:** an unquoted comma splits the `unit` description.
- **TC600 identification:** parameter 309 on a TC600 is the rotor speed, so CSC can never recognise one. The scan falls back to parameter 349, the electronics name (🟠 to verify).

## Using it

1. Open the live page in desktop Chrome or Edge, or run it locally (next section).
2. Click **Add gauge**, then **Grant a port…** and pick your USB serial adapter. The browser asks once per adapter.
3. Click **Scan granted ports**, select what was found, confirm the model, the interface and address, and for a CDG the full scale.
4. Click **Try demo** to explore everything with four simulated gauges, including an OPG550 for Spectrum Studio.

Press `Ctrl K` to open the command dictionary for the current device.

## Running locally

Web Serial needs a secure context, and `http://localhost` counts as one. Double-click **Launch Gauge Communicator.cmd** (Windows) or **Launch Gauge Communicator.command** (macOS/Linux). It installs dependencies on first run, builds the specs, starts the server and opens the browser. It needs Node.js 20.19+ or 22+.

| Command | Purpose |
|---|---|
| `npm run app` | Same as the launchers |
| `npm run dev` | Development server |
| `npm test` | Spec validation, source validation, and the framer, codec, scan, scheduler, simulation, store, setpoint and Spectrum Studio suites (Node, no browser, no hardware) |
| `npm run build:pages` | Static build for GitHub Pages (base path from `GITHUB_REPOSITORY`) |
| `npm run preview:pages` | Serve the Pages build at `http://127.0.0.1:4173/Vacuum-Control-Serial-Communicator/` |
| `npm run test:browser` | Headless Edge/Chrome smoke test of the demo against `SMOKE_URL` |
| `npm run specs:build` | Regenerate `public/specs/` from `specs-src/` |

## How it is built

```
public/core/            framework-free ES modules, tested in Node
  checks/               8-bit sum, Pfeiffer ASCII sum, CRC-16/0x8408
  framers/              sync+fixed length, length-prefixed, terminator
  codecs/               cdg-serial, inficon-binary, ppg-ascii, pfeiffer-ascii, inficon-p3v02
  registry/             loads the generated specs, instantiates codecs
  scan/                 probe plans and the scanner
  scheduler/            one PortScheduler per physical port
  transport/            PortSession (Web Serial) and EmulatedPort (simulation)
  store/                typed-array sample buffers, IndexedDB, session model, exports
  sim/                  simulation engine (ported from CSC) and protocol emulators
  turbo/                TC600 protocol
  opg/                  Spectrum Studio model (spike filter, gas history, plasma thresholds) and its CSV exports
public/ui/, public/app.js   plain-DOM UI
app/                    Vinext page shell (same stack and versions as the VGC tool)
specs-src/              device YAML synced from CSC, plus web-overlay.yaml (risk, source, notes)
scripts/                launcher, spec build, tests, Pages packaging
```

The YAML in `specs-src/` stays syncable with CSC's `device_specs/`. Web-only fields live in `web-overlay.yaml`. `scripts/specs-build.mjs` converts both to JSON, validates them, and makes CI fail on unknown fields or on stale generated files. The PSG550 and PCG550 files are the exception: they were rewritten from the protocol description and are marked as diverging.

### Verification still needed

Items marked 🟠 come from a document other than the INFICON primary document for that device. Before a model leaves experimental status, each must be checked against the manual and on the bench. They are listed in [WEB_PORT_PLAN.md, section 16](WEB_PORT_PLAN.md). The most important are:
- **V1–V5:** the PxG55x protocol against the INFICON "PxG55x Communication Protocol RS232C/RS485C" document.
- **V6–V8:** the CDG status byte, the setpoint write encoding and the stream rate, from TIRA49E1. The setpoint editor uses CSC's cube law, p = FS·(raw/255)³, until V7 is checked.
- **V14:** for the PPG550/570, whether the setpoint hysteresis register holds the absolute release pressure or an offset from the setpoint. The editor lets you pick either and defaults to the absolute pressure.
- **V15:** Web Serial behaviour in a soak test.
- **V20:** OPG550 plasma ignition limits and the meaning of the record request data; the simulated OPG550's ignition limit, record cadence and analog-output scaling are illustrative.

## Privacy and disclaimer

Serial traffic and sessions stay in the browser profile on this computer and are never uploaded. The page includes no analytics.

This is an independent utility, not an INFICON product. Verify behaviour against the official manual for your gauge and firmware. Commands can change gauge configuration and switch setpoint relays that may be wired into interlocks. Use at your own risk.

## License

Apache-2.0, matching the VGC tool.
