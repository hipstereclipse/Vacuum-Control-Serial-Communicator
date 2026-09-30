import { runSuites } from "./run-tests.mjs";

await runSuites(["sim"]);
process.exit(process.exitCode ?? 0);
