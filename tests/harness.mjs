// A minimal test harness: plain Node, no dependencies, same spirit as the VGC tool's
// test-controllers.mjs. Test files call test(name, fn); run-tests.mjs runs them in order.
import assert from "node:assert/strict";

const registered = [];

export function test(name, fn) {
  registered.push({ name, fn });
}

export { assert };

export async function runRegistered(label) {
  let failed = 0;
  for (const { name, fn } of registered.splice(0)) {
    try {
      await fn();
      process.stdout.write(`  ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`  FAIL ${name}\n       ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n       ")}\n`);
    }
  }
  return failed;
}

export const hex = (s) => Uint8Array.from(s.trim().split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16)));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
