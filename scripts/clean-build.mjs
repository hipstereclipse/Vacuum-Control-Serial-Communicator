import { rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.resolve(root, "dist");

if (path.dirname(output) !== root || path.basename(output) !== "dist") {
  throw new Error("Refusing to clean an unexpected build directory.");
}

await rm(output, { recursive: true, force: true });
