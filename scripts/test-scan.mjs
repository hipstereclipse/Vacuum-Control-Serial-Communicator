import { runSuites } from "./run-tests.mjs";

await runSuites(["scan"]);
process.exit(process.exitCode ?? 0);
