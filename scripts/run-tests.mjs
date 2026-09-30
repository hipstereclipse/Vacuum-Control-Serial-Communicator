// Runs every *.test.mjs file in the given tests/ subdirectories, in name order.
// Usage: node scripts/run-tests.mjs codecs framers
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runRegistered } from "../tests/harness.mjs";

export async function runSuites(suites) {
  let failed = 0;
  let files = 0;
  for (const suite of suites) {
    const dir = path.resolve("tests", suite);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort()) {
      files += 1;
      process.stdout.write(`${suite}/${file}\n`);
      await import(pathToFileURL(path.join(dir, file)).href);
      failed += await runRegistered(file);
    }
  }
  if (files === 0) {
    console.error(`No test files found in: ${suites.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (failed) {
    console.error(`\n${failed} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll tests passed (${files} file(s)).`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSuites(process.argv.slice(2));
  // Emulator timers left behind by a failing test must not hang CI.
  process.exit(process.exitCode ?? 0);
}
