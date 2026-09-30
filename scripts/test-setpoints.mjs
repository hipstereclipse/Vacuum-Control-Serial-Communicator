import { runSuites } from "./run-tests.mjs";

await runSuites(["setpoints"]);
process.exit(process.exitCode ?? 0);
