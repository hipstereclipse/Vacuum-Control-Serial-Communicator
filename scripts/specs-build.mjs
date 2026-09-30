// Converts the CSC device-spec YAML in specs-src/ (plus the web overlay) into validated JSON
// in public/specs/. The generated files are never edited by hand.
//
//   node scripts/specs-build.mjs          build
//   node scripts/specs-build.mjs --check  validate and fail if public/specs/ is stale
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const root = process.cwd();
const srcDir = path.join(root, "specs-src");
const outDir = path.join(root, "public", "specs");
const check = process.argv.includes("--check");

const TOP_LEVEL = new Set([
  "model", "manufacturer", "family", "protocol", "experimental", "transport", "commands",
  "device_id", "pressure_enc", "full_scale_mbar", "full_scale_options_mbar",
  // web overlay
  "source", "default_unit", "probe", "notes", "device_class"
]);
const TRANSPORT = new Set(["rs485_group_address", "default_baud", "parity", "data_bits", "stop_bits", "rs_modes", "default_address", "rs485_address_range"]);
const COMMAND = new Set([
  "read", "write", "unit", "description", "pid", "data_type", "mnemonic", "min_value", "max_value", "scale",
  "options", "experimental", "measurement", "flag_names", "query_param", "write_prefix", "request_data",
  // web additions
  "risk", "source", "value_hint", "write_value", "write_type"
]);
const PROTOCOLS = new Set(["cdg_serial", "inficon_binary", "pfeiffer_binary", "ppg_ascii", "pfeiffer_ascii", "inficon_ascii", "inficon_p3_v02"]);
const RISKS = new Set(["safe", "caution", "danger"]);
const DANGER = /reset|factory|zero|adjust|setpoint_\d_(low|high)|degas|emission|baud|address|motor|vent|pumping|heating|standby/i;

const errors = [];
const fail = (file, message) => errors.push(`${file}: ${message}`);

const overlay = YAML.parse(readFileSync(path.join(srcDir, "web-overlay.yaml"), "utf8"), { merge: true });
const defaults = overlay.defaults ?? {};

function loadDir(sub, deviceClass) {
  const dir = path.join(srcDir, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(dir, file), "utf8");
      // CSC's ppg550.yaml repeats `model:`; tolerate duplicates (last wins, as PyYAML does) but report them.
      const doc = YAML.parseDocument(text, { uniqueKeys: false, merge: true });
      const seen = new Set();
      for (const pair of doc.contents?.items ?? []) {
        const key = String(pair.key);
        if (seen.has(key)) console.warn(`  note: ${sub}/${file} repeats top-level key "${key}" (fix in CSC)`);
        seen.add(key);
      }
      return { file: `${sub}/${file}`, raw: doc.toJS(), deviceClass };
    });
}

function build({ file, raw, deviceClass }) {
  for (const key of Object.keys(raw)) if (!TOP_LEVEL.has(key)) fail(file, `unknown top-level field "${key}"`);
  for (const key of ["model", "family", "protocol", "transport", "commands"]) if (raw[key] == null) fail(file, `missing "${key}"`);
  if (!PROTOCOLS.has(raw.protocol)) fail(file, `unknown protocol "${raw.protocol}"`);
  for (const key of Object.keys(raw.transport ?? {})) if (!TRANSPORT.has(key)) fail(file, `unknown transport field "${key}"`);

  const extra = overlay.models?.[raw.model] ?? {};
  const spec = {
    ...raw,
    device_class: deviceClass,
    experimental: Boolean(raw.experimental),
    source: extra.source ?? defaults.source,
    default_unit: extra.default_unit ?? defaults.default_unit ?? "mbar",
    probe: extra.probe ?? null,
    notes: extra.notes ?? {},
    commands: {}
  };
  if (typeof spec.device_id === "string") spec.device_id = parseInt(spec.device_id, 16);

  for (const [name, cmd] of Object.entries(raw.commands ?? {})) {
    for (const key of Object.keys(cmd ?? {})) if (!COMMAND.has(key)) fail(file, `command "${name}": unknown field "${key}"`);
    if (typeof cmd.read !== "boolean" || typeof cmd.write !== "boolean") fail(file, `command "${name}": read and write must be booleans`);
    const override = extra.commands?.[name] ?? {};
    const risk = override.risk ?? cmd.risk ?? (!cmd.write ? "safe" : DANGER.test(name) ? "danger" : "caution");
    if (!RISKS.has(risk)) fail(file, `command "${name}": risk "${risk}"`);
    if (["inficon_binary", "pfeiffer_binary", "pfeiffer_ascii", "inficon_ascii"].includes(raw.protocol) && cmd.pid == null) {
      fail(file, `command "${name}": ${raw.protocol} commands need a pid`);
    }
    if (raw.protocol === "ppg_ascii" && !cmd.mnemonic) fail(file, `command "${name}": ppg_ascii commands need a mnemonic`);
    spec.commands[name] = { ...cmd, risk, source: override.source ?? cmd.source ?? spec.source };
  }
  return spec;
}

const specs = [...loadDir("gauges", "gauge"), ...loadDir("turbos", "turbo")].map(build);
const models = new Set();
for (const spec of specs) {
  if (models.has(spec.model.toUpperCase())) fail(spec.model, "duplicate model");
  models.add(spec.model.toUpperCase());
}
for (const model of Object.keys(overlay.models ?? {})) if (!models.has(model.toUpperCase())) fail("web-overlay.yaml", `overlay for unknown model "${model}"`);

if (errors.length) {
  console.error(`Spec validation failed:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}

const files = new Map();
for (const spec of specs) files.set(`${spec.model.toLowerCase()}.json`, `${JSON.stringify(spec, null, 2)}\n`);
const index = specs.map((s) => ({
  model: s.model,
  family: s.family,
  protocol: s.protocol,
  device_class: s.device_class,
  experimental: s.experimental,
  rs_modes: s.transport.rs_modes ?? ["RS232"],
  probe: s.probe,
  file: `${s.model.toLowerCase()}.json`
}));
files.set("index.json", `${JSON.stringify(index, null, 2)}\n`);
// One bundle so the page loads every spec in a single request.
files.set("all.json", `${JSON.stringify(Object.fromEntries(specs.map((s) => [s.model, s])))}\n`);

if (check) {
  const stale = [...files].filter(([name, content]) => {
    const target = path.join(outDir, name);
    return !existsSync(target) || readFileSync(target, "utf8") !== content;
  });
  if (stale.length) {
    console.error(`public/specs/ is stale (${stale.map(([n]) => n).join(", ")}). Run npm run specs:build.`);
    process.exit(1);
  }
  console.log(`Specs valid and up to date (${specs.length} models).`);
} else {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of files) writeFileSync(path.join(outDir, name), content, "utf8");
  console.log(`Built ${specs.length} specs into public/specs/.`);
}
