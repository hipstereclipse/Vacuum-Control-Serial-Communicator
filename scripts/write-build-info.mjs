// Writes public/build-info.json so the footer, every saved session and every export can name
// the exact code that produced them (WEB_PORT_PLAN.md section 14).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
let build = process.env.GITHUB_SHA?.slice(0, 7) ?? "";
if (!build) {
  try {
    build = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    build = "local";
  }
}
writeFileSync("public/build-info.json", `${JSON.stringify({ version, build, built: new Date().toISOString() }, null, 2)}\n`);
console.log(`Build info: ${version} (${build})`);
