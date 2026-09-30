import { runSuites } from "./run-tests.mjs";

await runSuites(["scheduler"]);
process.exit(process.exitCode ?? 0);
