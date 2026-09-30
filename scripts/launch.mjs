/**
 * Gauge Serial Communicator — local launcher.
 *
 * Double-click "Launch Gauge Communicator.cmd" (Windows) or run `node scripts/launch.mjs`
 * (macOS / Linux). This installs dependencies on first run, starts the local
 * development server, and opens the console in your default browser.
 *
 * The Web Serial API only works from a secure context, which includes
 * http://localhost — so the app must be served, not opened as a file:// page.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const vinextCli = path.join(root, "node_modules", "vinext", "dist", "cli.js");
const stripAnsi = (value) => value.replace(/\[[0-9;]*m/g, "");

function line(message = "") {
  process.stdout.write(`${message}\n`);
}

function runToCompletion(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: isWindows });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))
    );
  });
}

function openBrowser(url) {
  const [command, args] = isWindows
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    line(`Open your browser to ${url}`);
  }
}

async function main() {
  line("");
  line("  Gauge Serial Communicator");
  line("  -------------------------");

  if (!existsSync(vinextCli)) {
    line("  Installing dependencies (first run only — this can take a minute)...");
    line("");
    await runToCompletion(npmCommand, ["install"]);
    line("");
  }

  // Device specs are generated from specs-src/ and the footer shows the build.
  await runToCompletion(process.execPath, [path.join(root, "scripts", "specs-build.mjs")]);
  await runToCompletion(process.execPath, [path.join(root, "scripts", "write-build-info.mjs")]);

  line("  Starting the local server...");
  const server = spawn(process.execPath, [vinextCli, "dev"], {
    cwd: root,
    env: process.env
  });

  const fallbackUrl = "http://localhost:3000/";
  let opened = false;
  const openOnce = (url) => {
    if (opened) return;
    opened = true;
    setTimeout(() => {
      line("");
      line(`  Opening ${url} in your browser.`);
      line("  Use current Chrome or Microsoft Edge for Web Serial support.");
      line("  Keep this window open while you use the console; close it to stop the server.");
      line("");
      openBrowser(url);
    }, 700);
  };

  const scan = (chunk) => {
    const text = stripAnsi(chunk.toString());
    process.stdout.write(chunk);
    const match = text.match(/https?:\/\/localhost:\d+\/?/i);
    if (match) openOnce(match[0]);
  };
  server.stdout.on("data", scan);
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  // Fallback: if the server URL was not detected, open the default port anyway.
  setTimeout(() => openOnce(fallbackUrl), 8000);

  const shutdown = () => {
    try {
      server.kill();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  line("");
  line(`  Could not start the console: ${error.message}`);
  line("  Make sure Node.js 20.19+ (or 22+) is installed (https://nodejs.org/), then try again.");
  process.exitCode = 1;
});
