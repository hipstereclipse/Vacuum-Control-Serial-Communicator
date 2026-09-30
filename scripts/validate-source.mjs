// Source validation: required files exist, every client module parses as an ES module, the
// manifest is complete, and no client module reaches outside public/ or pulls from a CDN
// (the tool must work offline on isolated tool networks).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const required = [
  "app/layout.js",
  "app/page.js",
  "app/globals.css",
  "public/app.js",
  "public/manifest.webmanifest",
  "public/icon.svg",
  "public/specs/all.json",
  "specs-src/web-overlay.yaml",
  "Launch Gauge Communicator.cmd",
  "Launch Gauge Communicator.command",
  "LICENSE",
  "README.md"
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Missing required file: ${relative}`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const modules = walk(path.join(root, "public")).filter((f) => f.endsWith(".js"));
for (const file of modules) {
  const source = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file);
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    throw new Error(`${rel} does not parse:\n${error.stderr?.toString() ?? error.message}`);
  }
  const specifiers = [
    ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)
  ].map((m) => m[1]);
  for (const spec of specifiers) {
    if (/^https?:/.test(spec)) throw new Error(`${rel}: imports from the network (${spec}); bundle it locally instead.`);
    if (!spec.startsWith(".")) throw new Error(`${rel}: bare import "${spec}" cannot load in the browser without a bundler.`);
    const target = path.resolve(path.dirname(file), spec);
    if (!target.startsWith(path.join(root, "public"))) throw new Error(`${rel}: import "${spec}" leaves public/.`);
    if (!fs.existsSync(target)) throw new Error(`${rel}: import "${spec}" does not exist.`);
  }
  if (/\bfrom\s+["']node:|require\(/.test(source)) throw new Error(`${rel}: uses Node APIs, which the browser cannot load.`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "public/manifest.webmanifest"), "utf8"));
if (!manifest.name || !manifest.icons?.length) throw new Error("Manifest is incomplete.");

console.log(`Source validation passed (${modules.length} client modules).`);
