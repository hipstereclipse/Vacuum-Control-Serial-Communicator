import { runSuites } from "./run-tests.mjs";

await runSuites(["store"]);
process.exit(process.exitCode ?? 0);
