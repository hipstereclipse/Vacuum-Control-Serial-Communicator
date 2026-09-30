# Vacuum Control Serial Communicator

A browser-only console for INFICON vacuum gauges. It talks to them through the Web Serial API: no Python, no installer, and no data leaving the computer. It is the browser edition of the desktop [CustomSerialCommunicator](https://github.com/hipstereclipse/CustomSerialCommunicator) (CSC). It is built and published the same way as the [VGC Serial Communication Tool](https://github.com/hipstereclipse/VGC-Serial-Communication-Tool).

**Live:** https://hipstereclipse.github.io/Vacuum-Control-Serial-Communicator/ (desktop Chrome or Edge)

The design, the sources behind every protocol figure and the open verification items are in [WEB_PORT_PLAN.md](WEB_PORT_PLAN.md).

## What it does

- **Connect** gauges over RS232 or RS485 (through a USB adapter). All gauges on one RS485 bus share one port, and the tool keeps exactly one transaction outstanding at a time.
- **Scan** granted ports with read-only probes. The scan listens for a CDG left streaming, then tries PPG, Pfeiffer ASCII, CDG, PxG55x and P3 V02 in turn and stops at the first verified identity. It also offers an optional RS485 address sweep.
- **Map models automatically.** For a CDG the tool infers the full scale from the type word, but it will not log until you confirm the full scale, with Torr-native and mbar-native heads listed side by side.
- **Poll** one or more read commands per device on a chosen interval. CDGs stream continuously and every frame is decoded.
- **Device tabs** show a value card with status chips (CDG warnings, PPG status words, PxG55x device errors), a trend, poll controls, and a protocol-aware terminal. The terminal has ASCII and hex views and a frame builder that computes checksums and CRCs and flags a bad frame before it is sent.
- **Combined view** in overlay, stacked or grid layout, with visibility toggles, per-device colours and synchronised navigation.
- **Sessions** autosave to this browser's IndexedDB, and can be exported and imported as JSON.
- **Exports:** measurement CSV (per device, or merged on the union of timestamps), traffic CSV with exact bytes, a readable transcript, and session JSON. Every export header records the build, each device's model, address and full scale, and where the full scale came from.
- **Simulation and demo.** Simulated gauges answer real frames through protocol emulators, so the codecs, scheduler, scanner and UI run unchanged without hardware. Inputs are scenario, gas type, humidity, leak rate and base pressure.
- **TC600 turbo workspace.** Every actuating command is gated as a danger command.
- **Safety.** Every command has a risk class:
  - *safe:* sends immediately.
  - *caution:* shows the exact bytes first.
  - *danger:* explains what will happen, lists the preconditions and the source document, and needs a second click.

  Changing the display unit never writes to a gauge, and the tool performs no automatic writes.

## Device support

| Family | Models | Status |
|---|---|---|
| SKY CDG, RS232C binary | CDG025D, CDG045D, CDG100D, CDG160D, CDG200D | First-class. Protocol from TIRA49E1 |
| PxG55x binary, RS232C and RS485C | PSG550, PCG550 | Implemented from the OEM protocol description (🟠 needs a bench check, see below) |
| PPG ASCII | PPG550, PPG570 | Ported one-to-one from CSC |
| Pfeiffer ASCII | BCG450, TC600 | Ported one-to-one from CSC |
| INFICON P3 V02 | OPG550 | Codec and identification ported. Spectrum Studio is not ported yet |
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
4. Click **Try demo** to explore everything with three simulated gauges.

Press `Ctrl K` to open the command dictionary for the current device.

## Running locally

Web Serial needs a secure context, and `http://localhost` counts as one. Double-click **Launch Gauge Communicator.cmd** (Windows) or **Launch Gauge Communicator.command** (macOS/Linux). It installs dependencies on first run, builds the specs, starts the server and opens the browser. It needs Node.js 20.19+ or 22+.

| Command | Purpose |
|---|---|
| `npm run app` | Same as the launchers |
| `npm run dev` | Development server |
| `npm test` | Spec validation, source validation, and the framer, codec, scan, scheduler, simulation and store suites (Node, no browser, no hardware) |
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
public/ui/, public/app.js   plain-DOM UI
app/                    Vinext page shell (same stack and versions as the VGC tool)
specs-src/              device YAML synced from CSC, plus web-overlay.yaml (risk, source, notes)
scripts/                launcher, spec build, tests, Pages packaging
```

The YAML in `specs-src/` stays syncable with CSC's `device_specs/`. Web-only fields live in `web-overlay.yaml`. `scripts/specs-build.mjs` converts both to JSON, validates them, and makes CI fail on unknown fields or on stale generated files. The PSG550 and PCG550 files are the exception: they were rewritten from the protocol description and are marked as diverging.

### Verification still needed

Items marked 🟠 come from a document other than the INFICON primary document for that device. Before a model leaves experimental status, each must be checked against the manual and on the bench. They are listed in [WEB_PORT_PLAN.md, section 16](WEB_PORT_PLAN.md). The most important are:
- **V1–V5:** the PxG55x protocol against the INFICON "PxG55x Communication Protocol RS232C/RS485C" document.
- **V6–V8:** the CDG status byte, the setpoint write encoding and the stream rate, from TIRA49E1.
- **V15:** Web Serial behaviour in a soak test.

## Privacy and disclaimer

Serial traffic and sessions stay in the browser profile on this computer and are never uploaded. The page includes no analytics.

This is an independent utility, not an INFICON product. Verify behaviour against the official manual for your gauge and firmware. Commands can change gauge configuration and switch setpoint relays that may be wired into interlocks. Use at your own risk.

## License

Apache-2.0, matching the VGC tool.
